use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use mpamm_core::{ChainCx, DecodeCx, FinalBlock, VenueError};
use mpamm_pricing::Fees;
use mpamm_ring::WatchSet;
use mpamm_types::{Fill, ThemeColor, VenueKind, VenueMeta, VenueRole};
use serde_json::Value;

use super::*;

/// A venue that quotes, after `delay`, every market of its own the frame
/// has a mid for (as real venues do), filling in full up to $100k; it
/// records what each call saw.
struct Stub {
    id: &'static str,
    markets: Vec<&'static str>,
    delay: Duration,
    fail: bool,
    calls: AtomicUsize,
    /// Per call: the block, and the markets it had a mid for.
    seen: parking_lot::Mutex<Vec<(u64, Vec<String>)>>,
}

impl Stub {
    fn new(id: &'static str, markets: &[&'static str], delay_ms: u64, fail: bool) -> Arc<Self> {
        Arc::new(Self {
            id,
            markets: markets.to_vec(),
            delay: Duration::from_millis(delay_ms),
            fail,
            calls: AtomicUsize::new(0),
            seen: parking_lot::Mutex::new(Vec::new()),
        })
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Venue for Stub {
    fn id(&self) -> &str {
        self.id
    }
    fn meta(&self) -> Vec<VenueMeta> {
        vec![VenueMeta {
            id: self.id.into(),
            name: self.id.into(),
            color: ThemeColor { light: "#000".into(), dark: "#fff".into() },
            kind: VenueKind::Amm,
            role: VenueRole::Venue,
            taker: None,
            taker_bps: None,
            since_utc: None,
            quote_note: None,
        }]
    }
    async fn discover(&self, _: &ChainCx<'_>) -> Result<(), VenueError> {
        Ok(())
    }
    fn watch(&self) -> Result<WatchSet, VenueError> {
        Ok(WatchSet::default())
    }
    fn decode(&self, _: &DecodeCx<'_>, _: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        Ok(vec![])
    }
    fn markets(&self) -> Vec<String> {
        self.markets.iter().map(|m| m.to_string()).collect()
    }
    async fn quote(&self, cx: &QuoteCx<'_>, sizes: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let priced: Vec<String> =
            self.markets.iter().filter(|m| cx.pricer.pair_mid(m) > 0.0).map(|m| m.to_string()).collect();
        self.seen.lock().push((cx.block.number, priced.clone()));
        tokio::time::sleep(self.delay).await;
        if self.fail {
            return Err(VenueError::Chain("boom".into()));
        }
        let mut rows = Vec::new();
        for m in &priced {
            let mid = cx.pricer.pair_mid(m);
            for &size in sizes {
                let bps = 1.0 + (size / 100.0).log10();
                rows.push(QuoteRow {
                    venue_id: self.id.into(),
                    market: m.clone(),
                    size_usd: size,
                    bid_bps: -bps,
                    ask_bps: bps,
                    bid_px: mid * (1.0 - bps / 1e4),
                    ask_px: mid * (1.0 + bps / 1e4),
                    spread_bps: 2.0 * bps,
                    filled_full: size <= 100_000.0,
                    one_sided: None,
                    fee_bps: 0.0,
                    cex_ask_bps: None,
                    cex_bid_bps: None,
                    ts: 0.0,
                });
            }
        }
        Ok(rows)
    }
}

const MON: &str = "MON/USDC";
const BTC: &str = "BTC/USDC";

/// Live-looking books for MON/USDC (Bybit) and BTC/USDC (Binance), a few
/// levels deep, so their reference rows are partial past the book.
fn prices() -> Arc<Prices> {
    let p = Prices::new(Registry::get(), Fees::default());
    let now = mpamm_pricing::feeds::now_ms();
    for (ex, sym, mid, size) in [
        (&p.feeds.bybit, "MONUSDT", 0.03, 2e6),
        (&p.feeds.bybit, "USDCUSDT", 1.0001, 1e7),
        (&p.feeds.binance, "BTCUSDT", 90_000.0, 1.0),
        (&p.feeds.binance, "USDCUSDT", 1.0001, 1e7),
    ] {
        ex.touch(now);
        ex.update(sym, now, |s| {
            for i in 1..=3 {
                let step = mid * 1e-4 * f64::from(i);
                s.book.set(mpamm_pricing::Side::Sell, mid - step, size);
                s.book.set(mpamm_pricing::Side::Buy, mid + step, size);
            }
            s.best_bid = mid - mid * 1e-4;
            s.best_ask = mid + mid * 1e-4;
        });
    }
    p
}

fn depth(venues: Vec<Arc<Stub>>, deadline_ms: u64) -> Arc<Depth> {
    depth_every(venues, deadline_ms, 0)
}

fn depth_every(venues: Vec<Arc<Stub>>, deadline_ms: u64, min_interval_ms: u64) -> Arc<Depth> {
    let d = Depth::new(
        venues.into_iter().map(|v| v as Arc<dyn Venue>).collect(),
        Rpc::new("none", "http://127.0.0.1:9", Duration::from_secs(1)),
        prices(),
        Registry::get(),
        Duration::from_millis(deadline_ms),
        Duration::from_millis(min_interval_ms),
    );
    tokio::spawn(d.clone().run());
    d
}

fn block(n: u64, h: u8) -> BlockRef {
    BlockRef { number: n, id: [h; 32], hash: [h; 32] }
}

fn json(rx: &watch::Receiver<Option<Arc<str>>>) -> Value {
    serde_json::from_str(rx.borrow().as_deref().expect("a snapshot")).unwrap()
}

/// The venue ids of a snapshot's curves, or of its missing list.
fn ids(v: &Value, key: &str) -> Vec<String> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap_or_else(|| x["venueId"].as_str().unwrap()).to_string())
        .collect()
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[test]
fn the_grid_spans_four_decades_and_lands_on_every_size_pill() {
    let g = depth_sizes(DEPTH_SAMPLES);
    assert_eq!((g.len(), g[0], g[24]), (25, 100.0, 1_000_000.0));
    for pill in &Registry::get().sizes_usd {
        assert!(g.contains(pill), "{pill}");
    }
    assert_eq!(depth_sizes(3), [100.0, 10_000.0, 1_000_000.0]);
}

#[test]
fn the_frame_prices_only_the_markets_it_was_asked_for() {
    let reg = Registry::get();
    let mids = HashMap::from([(MON.to_string(), 0.03), (BTC.to_string(), 90_000.0)]);
    let assets = HashMap::from([("MON".to_string(), 0.03), ("BTC".to_string(), 90_000.0)]);
    let f = FramePricer::fixed(reg, mids, assets).only_markets(&[MON.to_string()]);
    assert_eq!((f.pair_mid(MON), f.pair_mid(BTC)), (0.03, 0.0));
    assert_eq!(f.usd_per_token("WMON"), 0.03, "sizing keeps every asset");
}

#[tokio::test(start_paused = true)]
async fn a_market_is_computed_only_while_watched_and_viewers_share_it() {
    let a = Stub::new("a", &[MON, BTC], 5, false);
    let b = Stub::new("b", &[MON], 1, true);
    let d = depth(vec![a.clone(), b], 150);
    d.on_executed(block(10, 1));
    settle().await;
    assert_eq!(a.calls(), 0, "nobody watches: no work");
    assert!(d.latest(MON).is_none());

    let rx1 = d.watch(MON);
    settle().await;
    assert_eq!(a.calls(), 1, "the first viewer starts the market at the current block");
    assert_eq!(a.seen.lock()[0], (10, vec![MON.to_string()]), "the frame prices only MON/USDC");
    let s = json(&rx1);
    assert_eq!((s["market"].as_str(), s["asOfBlock"].as_u64()), (Some(MON), Some(10)));
    assert_eq!(s["blockHash"], format!("0x{}", "01".repeat(32)));
    assert!(s.get("revision").is_none());
    assert_eq!(ids(&s, "venues"), ["a", "bybit"], "venues first, the exchange after");
    assert_eq!(ids(&s, "missingVenues"), ["b"], "a failed venue is listed missing");
    let curve = &s["venues"][0];
    assert_eq!(curve["maxNotional"], 100_000.0, "the curve ends at the last full fill");
    assert_eq!(curve["points"].as_array().unwrap().len(), 19);
    assert!((s["refMid"].as_f64().unwrap() - 0.03 / 1.0001).abs() < 1e-12, "the pair-terms mid");

    let rx2 = d.watch(MON);
    settle().await;
    assert_eq!(a.calls(), 1, "a second viewer shares the computation");
    assert!(Arc::ptr_eq(rx1.borrow().as_ref().unwrap(), rx2.borrow().as_ref().unwrap()), "one string for all");

    let rx3 = d.watch(BTC);
    settle().await;
    assert_eq!(a.calls(), 2);
    assert_eq!(a.seen.lock()[1], (10, vec![BTC.to_string()]), "only the new market at a block already done");
    assert_eq!(ids(&json(&rx3), "venues"), ["a", "binance"]);
    assert_eq!(ids(&json(&rx3), "missingVenues"), Vec::<String>::new(), "b doesn't quote BTC/USDC");

    d.on_executed(block(11, 2));
    settle().await;
    assert_eq!(a.calls(), 3);
    assert_eq!(a.seen.lock()[2], (11, vec![MON.to_string(), BTC.to_string()]), "one pass for every market");
    assert_eq!(json(&rx2)["asOfBlock"], 11);
    assert_eq!(d.view().markets, [MON, BTC]);

    drop((rx1, rx2, rx3));
    d.on_executed(block(12, 3));
    settle().await;
    assert_eq!(a.calls(), 3, "the last viewer leaving stops the market");
    assert!(d.demanded().is_empty());
    assert!(d.latest(MON).is_some(), "the last snapshot stays readable");
    let v = d.view();
    assert_eq!((v.passes, v.missed["b"], v.last_block), (3, 2, Some(11)));
    assert!(v.last_error["b"].contains("boom"));
}

#[tokio::test(start_paused = true)]
async fn blocks_arriving_during_a_pass_coalesce_into_the_newest() {
    let a = Stub::new("a", &[MON], 100, false);
    let d = depth(vec![a.clone()], 1_000);
    let rx = d.watch(MON);
    d.on_executed(block(10, 1));
    tokio::time::sleep(Duration::from_millis(20)).await;
    d.on_executed(block(11, 2));
    tokio::time::sleep(Duration::from_millis(20)).await;
    d.on_executed(block(12, 3));
    settle().await;
    let blocks: Vec<u64> = a.seen.lock().iter().map(|(b, _)| *b).collect();
    assert_eq!(blocks, [10, 12], "one pass at a time, then the newest block");
    assert_eq!(json(&rx)["asOfBlock"], 12);
}

#[tokio::test(start_paused = true)]
async fn an_interval_caps_pass_starts_and_each_takes_the_newest_block() {
    let a = Stub::new("a", &[MON], 5, false);
    let d = depth_every(vec![a.clone()], 150, 1_000);
    let _rx = d.watch(MON);
    // A block every 100 ms for 2.5 s.
    for n in 10..35u8 {
        d.on_executed(block(u64::from(n), n));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let blocks: Vec<u64> = a.seen.lock().iter().map(|(b, _)| *b).collect();
    assert_eq!(blocks.len(), 4, "a pass a second, not one per block: {blocks:?}");
    assert_eq!((blocks[0], blocks[3]), (10, 34), "the first block, and the newest at the end");
    assert!(blocks[..3].windows(2).all(|w| w[1] - w[0] >= 9), "a second's blocks apart: {blocks:?}");
}

#[tokio::test(start_paused = true)]
async fn a_late_venue_is_missing_only_from_its_pass() {
    let fast = Stub::new("fast", &[MON], 5, false);
    let slow = Stub::new("slow", &[MON], 400, false);
    let d = depth(vec![fast, slow], 150);
    let rx = d.watch(MON);
    d.on_executed(block(10, 1));
    settle().await;
    let s = json(&rx);
    assert_eq!(ids(&s, "venues"), ["fast", "bybit"]);
    assert_eq!(ids(&s, "missingVenues"), ["slow"]);
    assert!(d.view().last_error["slow"].starts_with("late"));
}

#[tokio::test(start_paused = true)]
async fn a_pass_whose_block_is_replaced_publishes_nothing() {
    let a = Stub::new("a", &[MON], 100, false);
    let d = depth(vec![a.clone()], 1_000);
    let rx = d.watch(MON);
    d.on_executed(block(10, 1));
    tokio::time::sleep(Duration::from_millis(20)).await;
    // Another proposal at the same height replaces the tip mid-pass.
    d.on_executed(block(10, 9));
    settle().await;
    assert_eq!(a.calls(), 2);
    let s = json(&rx);
    assert_eq!(s["blockHash"], format!("0x{}", "09".repeat(32)), "only the replacement is published");
    assert_eq!(s["revision"], 1, "a client takes it over what it holds");
    assert_eq!(d.view().dropped, 1);
}
