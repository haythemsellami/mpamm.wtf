use async_trait::async_trait;
use mpamm_core::{ChainCx, DecodeCx, FinalBlock, VenueError};
use mpamm_pricing::Fees;
use mpamm_ring::WatchSet;
use mpamm_types::{Fill, VenueMeta};

use super::*;

/// A venue that answers after `delay`, quoting MON/USDC at the frame's mid.
struct Stub {
    id: &'static str,
    delay: Duration,
    fail: bool,
}

#[async_trait]
impl Venue for Stub {
    fn id(&self) -> &str {
        self.id
    }
    fn meta(&self) -> Vec<VenueMeta> {
        vec![]
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
    async fn quote(&self, cx: &QuoteCx<'_>, sizes: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        tokio::time::sleep(self.delay).await;
        if self.fail {
            return Err(VenueError::Chain("boom".into()));
        }
        let mid = cx.pricer.pair_mid("MON/USDC");
        Ok(sizes
            .iter()
            .flat_map(|s| {
                [("MON/USDC", *s), ("NOT/REGISTERED", *s)].map(|(m, size)| QuoteRow {
                    venue_id: self.id.into(),
                    market: m.into(),
                    size_usd: size,
                    bid_bps: -5.0,
                    ask_bps: 5.0,
                    bid_px: mid * 0.9995,
                    ask_px: mid * 1.0005,
                    spread_bps: 10.0,
                    filled_full: true,
                    one_sided: None,
                    fee_bps: 0.0,
                    cex_ask_bps: None,
                    cex_bid_bps: None,
                    ts: 0.0,
                })
            })
            .collect())
    }
}

fn engine(venues: Vec<Arc<dyn Venue>>) -> Arc<Engine> {
    let reg = Registry::get();
    Engine::new(
        venues,
        Rpc::new("none", "http://127.0.0.1:9", Duration::from_secs(1)),
        Prices::new(reg, Fees::default()),
        reg,
        Duration::from_millis(150),
    )
}

fn block(n: u64) -> BlockRef {
    BlockRef { number: n, id: [n as u8; 32], hash: [n as u8 + 1; 32] }
}

#[tokio::test(start_paused = true)]
async fn each_venue_publishes_alone_and_a_slow_one_is_late_only_for_itself() {
    let e = engine(vec![
        Arc::new(Stub { id: "fast", delay: Duration::from_millis(5), fail: false }),
        Arc::new(Stub { id: "slow", delay: Duration::from_millis(400), fail: false }),
        Arc::new(Stub { id: "broken", delay: Duration::from_millis(1), fail: true }),
    ]);
    let mut rx = e.published.subscribe();
    e.on_executed(block(10), 1_000_000_000);
    // A second block while "slow" is still busy: skipped for it alone.
    tokio::time::sleep(Duration::from_millis(50)).await;
    e.on_executed(block(11), 2_000_000_000);
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let mut got = Vec::new();
    while let Ok(q) = rx.try_recv() {
        got.push((q.venue.clone(), q.block, q.rows.len(), q.outcome));
    }
    assert!(got.contains(&("fast".into(), 10, 4, Outcome::Published)), "unregistered markets are dropped: {got:?}");
    assert!(got.contains(&("fast".into(), 11, 4, Outcome::Published)));
    // Every job is announced; a missed one carries no rows.
    assert!(got.contains(&("slow".into(), 10, 0, Outcome::Late)), "missed its deadline: {got:?}");
    assert!(got.contains(&("slow".into(), 11, 0, Outcome::Busy)));
    assert!(got.contains(&("broken".into(), 10, 0, Outcome::Failed)));
    assert!(!got.iter().any(|(v, _, n, _)| v == "slow" && *n > 0));
    let t = e.timings();
    assert_eq!((t["slow"].late, t["slow"].busy), (1, 1));
    assert_eq!((t["fast"].published, t["fast"].late), (2, 0));
    assert_eq!(t["broken"].failed, 2);
    assert!(t["broken"].last_error.as_deref().unwrap().contains("boom"));
    assert_eq!(e.board.read().newest_block, 11);
    assert_eq!(e.board.read().snapshot("MON/USDC", 100.0).len(), 1);
}

#[test]
fn cex_columns_are_realized_against_the_exchange_as_taker() {
    let row = |v: &str, bid: f64, ask: f64| QuoteRow {
        venue_id: v.into(),
        market: "MON/USDC".into(),
        size_usd: 1000.0,
        bid_bps: 0.0,
        ask_bps: 0.0,
        bid_px: bid,
        ask_px: ask,
        spread_bps: 0.0,
        filled_full: true,
        one_sided: None,
        fee_bps: 0.0,
        cex_ask_bps: None,
        cex_bid_bps: None,
        ts: 0.0,
    };
    let cex = vec![row("bybit", 0.0299, 0.0301)];
    let mut venue = vec![row("v", 0.0298, 0.0302), row("w", 0.0, 0.0300)];
    annotate_cex(&mut venue, &cex);
    assert!((venue[0].cex_ask_bps.unwrap() - (0.0302 / 0.0301 - 1.0) * 1e4).abs() < 1e-9);
    assert!((venue[0].cex_bid_bps.unwrap() - (0.0299 / 0.0298 - 1.0) * 1e4).abs() < 1e-9);
    assert_eq!(venue[1].cex_bid_bps, None, "a missing side stays unannotated");
    assert!(venue[1].cex_ask_bps.unwrap() < 0.0, "cheaper than the exchange");
}
