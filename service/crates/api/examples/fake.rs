//! The API on FakeSource with synthetic live data: run today's web app
//! against the Rust service without a chain.
//!
//! ```bash
//! cargo run -p mpamm-api --example fake            # 127.0.0.1:8787
//! cargo run -p mpamm-api --example fake -- 8890    # another port
//! npm -w web run dev                               # proxies /api and /stream to 8787
//! ```
//!
//! Quotes every 300 ms for a handful of markets, state each second, depth
//! curves, a fill every second or so (with markouts and curves), 30 days of
//! volume and gas, and leaderboards and markout curves recomputed from the
//! fills with the service's own aggregations.

use std::collections::BTreeMap;
use std::time::Duration;

use mpamm_analytics::curves::{compute_markout_curves, CurveRow};
use mpamm_analytics::leaderboard::{compute_leaderboard, LbRow};
use mpamm_api::testing::{sample_state, venue, FakeSource};
use mpamm_api::ApiSource;
use mpamm_types::{
    utc_day, DailyVolume, DataSourceMode, DepthCurve, DepthPoint, DepthSnapshot, Fill, FillCategory, GasDay,
    GasResponse, QuoteRow, QuoteSnapshot, Side, StreamMessage, StreamState, ThemeColor, VenueDaily, VenueGasDaily,
    VenueKind, VenueMeta, VenueRole,
};

const TICK_MS: u64 = 300;
const DAY_MS: f64 = 86_400_000.0;

/// xorshift64*: enough randomness for a fake, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
    fn normal(&mut self) -> f64 {
        (self.next() + self.next() + self.next() + self.next() - 2.0) * 1.7
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() * items.len() as f64) as usize % items.len()]
    }
    fn hex(&mut self, n: usize) -> String {
        (0..n).map(|_| char::from_digit((self.next() * 16.0) as u32 % 16, 16).unwrap()).collect()
    }
}

/// A venue's quoting model: half-spread and impact per decade of size (bps),
/// fee, the largest size it fills, and the markets it quotes.
struct Model {
    id: &'static str,
    half: f64,
    impact: f64,
    fee: f64,
    cap: f64,
    markets: &'static [&'static str],
}

const MODELS: &[Model] = &[
    Model {
        id: "poe",
        half: 4.0,
        impact: 3.0,
        fee: 2.0,
        cap: 100_000.0,
        markets: &["MON/USDC", "BTC/USDC", "ETH/USDC"],
    },
    Model { id: "clober", half: 6.0, impact: 6.0, fee: 0.0, cap: 10_000.0, markets: &["MON/USDC", "MON/USDT0"] },
    Model {
        id: "metric",
        half: 3.0,
        impact: 4.0,
        fee: 1.5,
        cap: 100_000.0,
        markets: &["MON/USDC", "BTC/USDC", "XAUt/USDC"],
    },
    Model { id: "uniswap", half: 5.0, impact: 9.0, fee: 5.0, cap: 100_000.0, markets: &["MON/USDC", "ETH/USDC"] },
];
const MARKETS: &[&str] = &["MON/USDC", "BTC/USDC", "ETH/USDC", "MON/USDT0", "XAUt/USDC"];
const TRADERS: &[&str] = &["Relay", "KyberSwap", "0x", "0x12…34ab", "0x9f…01cd", "FastLane"];

fn reference_for(market: &str) -> &'static str {
    if market.starts_with("MON/") {
        "bybit"
    } else {
        "binance"
    }
}

fn mid(mids: &BTreeMap<&str, f64>, market: &str) -> f64 {
    mids[market.split('/').next().unwrap()]
}

fn colored(mut v: VenueMeta, light: &str, dark: &str) -> VenueMeta {
    v.color = ThemeColor { light: light.into(), dark: dark.into() };
    v
}

fn venues() -> Vec<VenueMeta> {
    let mut bybit = colored(venue("bybit", "Bybit", VenueKind::Cex, VenueRole::Reference), "#b45309", "#fbbf24");
    bybit.taker_bps = Some(10.0);
    let mut binance = colored(venue("binance", "Binance", VenueKind::Cex, VenueRole::Reference), "#a16207", "#facc15");
    binance.taker_bps = Some(10.0);
    let mut uniswap =
        colored(venue("uniswap", "Uniswap v4", VenueKind::Amm, VenueRole::Baseline), "#be185d", "#f472b6");
    uniswap.quote_note = Some("0.05% fee tier".into());
    vec![
        colored(venue("poe", "LFJ POE", VenueKind::Amm, VenueRole::Venue), "#1d4ed8", "#60a5fa"),
        colored(venue("clober", "Clober", VenueKind::Clob, VenueRole::Venue), "#047857", "#34d399"),
        colored(venue("metric", "Metric", VenueKind::Amm, VenueRole::Venue), "#7c3aed", "#c4b5fd"),
        uniswap,
        bybit,
        binance,
    ]
}

/// One venue's executable price at a size: (bid bps, ask bps), or None past its cap.
fn quote_bps(m: &Model, size: f64, skew: f64) -> Option<(f64, f64)> {
    (size <= m.cap).then(|| {
        let depth = m.half + m.impact * (size / 100.0).log10();
        (-(depth + m.fee) + skew, depth + m.fee + skew)
    })
}

fn quotes_frame(rng: &mut Rng, mids: &BTreeMap<&str, f64>, block: u64, now: f64, sizes: &[f64]) -> QuoteSnapshot {
    let mut rows = Vec::new();
    for market in MARKETS {
        let mid = mid(mids, market);
        for &size in sizes {
            let cex = 1.0 + 0.6 * (size / 100.0).log10();
            for m in MODELS.iter().filter(|m| m.markets.contains(market)) {
                let skew = rng.normal() * 0.8;
                let Some((bid, ask)) = quote_bps(m, size, skew) else { continue };
                let (bid, ask) = (bid - rng.next() * 1.5, ask + rng.next() * 1.5);
                rows.push(QuoteRow {
                    venue_id: m.id.into(),
                    market: market.to_string(),
                    size_usd: size,
                    bid_bps: bid,
                    ask_bps: ask,
                    bid_px: mid * (1.0 + bid / 1e4),
                    ask_px: mid * (1.0 + ask / 1e4),
                    spread_bps: ask - bid,
                    filled_full: true,
                    one_sided: None,
                    fee_bps: m.fee,
                    cex_ask_bps: Some(ask - cex - 10.0),
                    cex_bid_bps: Some(-bid - cex - 10.0),
                    ts: now - rng.range(0.0, 40.0),
                });
            }
            rows.push(QuoteRow {
                venue_id: reference_for(market).into(),
                market: market.to_string(),
                size_usd: size,
                bid_bps: -cex,
                ask_bps: cex,
                bid_px: mid * (1.0 - cex / 1e4),
                ask_px: mid * (1.0 + cex / 1e4),
                spread_bps: 2.0 * cex,
                filled_full: true,
                one_sided: None,
                fee_bps: 10.0,
                cex_ask_bps: None,
                cex_bid_bps: None,
                ts: now,
            });
        }
    }
    QuoteSnapshot {
        block_hash: Some(format!("0x{}", rng.hex(64))),
        revision: None,
        block,
        mon_usd: mids["MON"],
        ts: now,
        rows,
        frame: None,
    }
}

fn depth(rng: &mut Rng, market: &str, mid: f64, block: u64, now: f64) -> DepthSnapshot {
    let grid: Vec<f64> = (0..25).map(|i| (100.0 * 10f64.powf(4.0 * i as f64 / 24.0)).round()).collect();
    let venues = MODELS
        .iter()
        .filter(|m| m.markets.contains(&market) && m.id != "uniswap")
        .map(|m| {
            let skew = rng.normal() * 0.5;
            let points: Vec<DepthPoint> = grid
                .iter()
                .filter_map(|&n| {
                    quote_bps(m, n, skew).map(|(b, a)| DepthPoint { notional: n, bid_bps: Some(b), ask_bps: Some(a) })
                })
                .collect();
            let max_notional = points.last().map_or(0.0, |p| p.notional);
            DepthCurve { venue_id: m.id.into(), points, max_notional }
        })
        .collect();
    DepthSnapshot {
        block_hash: None,
        revision: None,
        missing_venues: None,
        market: market.into(),
        as_of_block: block,
        ref_mid: mid,
        ts: now,
        venues,
    }
}

/// A fill with every markout aged, and its markout curve.
fn fill(rng: &mut Rng, mids: &BTreeMap<&str, f64>, block: u64, ts: f64) -> (Fill, Vec<Option<f64>>) {
    let m = rng.pick(&MODELS[..3]);
    let market = *rng.pick(m.markets);
    let side = if rng.next() < 0.5 { Side::Buy } else { Side::Sell };
    let usd = (rng.range(3.0, 11.0)).exp();
    let px = mid(mids, market) * (1.0 + if side == Side::Buy { 1.0 } else { -1.0 } * m.half / 1e4);
    let edge = rng.normal() * 3.0 - 1.0;
    let markouts: Vec<Option<f64>> = (0..5).map(|i| Some(edge + rng.normal() * (1.0 + i as f64))).collect();
    let curve =
        mpamm_types::CURVE_OFFSETS_S.iter().map(|&o| Some(edge * (o as f64 + 5.0) / 20.0 + rng.normal())).collect();
    let to = *rng.pick(TRADERS);
    let tx = format!("0x{}", rng.hex(64));
    let f = Fill {
        id: format!("{}-{tx}-{}", m.id, (rng.next() * 50.0) as u32),
        venue_id: m.id.into(),
        market: market.into(),
        side,
        category: match to {
            "Relay" | "0x" => FillCategory::Agg,
            "KyberSwap" => FillCategory::Router,
            "FastLane" => FillCategory::Mev,
            _ => FillCategory::Direct,
        },
        usd,
        base_amount: usd / px,
        exec_px: px,
        px_approx: false,
        tx_hash: tx,
        to: to.into(),
        router: matches!(to, "Relay" | "KyberSwap" | "0x" | "FastLane").then(|| to.to_string()),
        pool: market.into(),
        block_number: block,
        ts,
        markouts_bps: markouts,
        time_source: None,
    };
    (f, curve)
}

fn book(volume: &mut Vec<DailyVolume>, f: &Fill) {
    let day = utc_day(f.ts);
    if volume.last().is_none_or(|d| d.utc_day != day) {
        if let Some(last) = volume.last_mut() {
            last.partial = false;
        }
        volume.push(DailyVolume { utc_day: day, by_venue: BTreeMap::new(), partial: true });
    }
    let v = volume.last_mut().unwrap().by_venue.entry(f.venue_id.clone()).or_default();
    v.usd += f.usd;
    v.swaps += 1;
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0
}

/// Recompute the aggregations from the fills, as the service would.
fn aggregate(source: &FakeSource, curves: &BTreeMap<String, Vec<Option<f64>>>, now: f64) {
    let mut fills = source.recent_fills();
    fills.sort_by(|a, b| a.ts.total_cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
    for days in [1u32, 7, 30] {
        let since = now - f64::from(days) * DAY_MS;
        let window: Vec<&Fill> = fills.iter().filter(|f| f.ts >= since && f.ts <= now).collect();
        let rows: Vec<LbRow> = window.iter().map(|f| LbRow::from(*f)).collect();
        let board = compute_leaderboard(&rows, days, now, |ids| {
            window.iter().filter(|f| ids.contains(&f.id)).map(|f| (*f).clone()).collect()
        });
        let curve_rows: Vec<CurveRow> =
            window.iter().map(|f| CurveRow::from_fill(f, curves.get(&f.id).cloned())).collect();
        let markout = compute_markout_curves(&curve_rows, days, now);
        source.with(|d| {
            d.leaderboards.insert(days, board);
            d.curves.insert(days, markout);
        });
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(8787);
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ now_ms() as u64);
    let mut mids: BTreeMap<&str, f64> = [("MON", 0.024), ("BTC", 95_000.0), ("ETH", 3_500.0), ("XAUt", 2_650.0)].into();
    let now = now_ms();
    let mut block: u64 = 40_000_000;

    let mut state = sample_state();
    state.source = DataSourceMode::Live;
    state.block = block;
    state.venues = venues();
    state.quote_markets =
        Some(MODELS.iter().map(|m| (m.id.to_string(), m.markets.iter().map(|s| s.to_string()).collect())).collect());
    let sizes = state.sizes_usd.clone();
    let source = FakeSource::new(state);

    // 30 days of closed history: volume, gas, and three days of fills.
    let mut volume = Vec::new();
    let mut gas = Vec::new();
    for back in (1..=30).rev() {
        let ts = now - back as f64 * DAY_MS;
        let by_venue = MODELS[..3]
            .iter()
            .map(|m| {
                (m.id.to_string(), VenueDaily { usd: rng.range(2e5, 2e6), swaps: rng.range(500.0, 5000.0) as u64 })
            })
            .collect();
        volume.push(DailyVolume { utc_day: utc_day(ts), by_venue, partial: false });
        let by_venue: BTreeMap<String, VenueGasDaily> = MODELS[..3]
            .iter()
            .map(|m| (m.id.to_string(), VenueGasDaily { mon: rng.range(50.0, 900.0), txs: rng.range(1e4, 9e4) as u64 }))
            .collect();
        gas.push(GasDay { utc_day: utc_day(ts), by_venue, partial: false });
    }
    let mut fills = Vec::new();
    let mut curves = BTreeMap::new();
    for i in 0..1500 {
        let ts = (now - 3.0 * DAY_MS + i as f64 * (3.0 * DAY_MS / 1500.0)).floor();
        let (f, curve) = fill(&mut rng, &mids, block - 1500 + i, ts);
        if ts >= now - (now % DAY_MS) {
            book(&mut volume, &f);
        }
        curves.insert(f.id.clone(), curve);
        fills.push(f);
    }
    if volume.last().is_none_or(|d| d.utc_day != utc_day(now)) {
        volume.push(DailyVolume { utc_day: utc_day(now), by_venue: BTreeMap::new(), partial: true });
    }
    gas.push(GasDay { utc_day: utc_day(now), by_venue: BTreeMap::new(), partial: true });
    let first = quotes_frame(&mut rng, &mids, block, now, &sizes);
    source.with(|d| {
        d.volume = volume;
        d.gas = GasResponse { days: gas, approx: vec!["clober".into()] };
        d.fills = fills;
        d.quotes = first;
    });
    aggregate(&source, &curves, now);

    let ticker = source.clone();
    tokio::spawn(async move {
        let source = ticker;
        let mut tick = tokio::time::interval(Duration::from_millis(TICK_MS));
        let mut n: u64 = 0;
        loop {
            tick.tick().await;
            n += 1;
            block += 1;
            let now = now_ms();
            for m in mids.values_mut() {
                *m *= 1.0 + rng.normal() * 0.0002;
            }
            let quotes = quotes_frame(&mut rng, &mids, block, now, &sizes);
            source.with(|d| {
                d.quotes = quotes.clone();
                d.history.push(quotes.clone());
                d.history.retain(|q| q.ts > now - 60_000.0);
                d.state.block = block;
                d.state.mon_usd = mids["MON"];
            });
            source.push(StreamMessage::Quotes(Box::new(quotes)));
            if n.is_multiple_of(3) {
                let state = StreamState::hello(&source.state());
                source.push(StreamMessage::State(Box::new(state)));
                for market in MARKETS {
                    let snapshot = depth(&mut rng, market, mid(&mids, market), block, now);
                    source.publish_depth(market, serde_json::to_string(&snapshot).unwrap());
                }
            }
            if rng.next() < 0.35 {
                let (f, curve) = fill(&mut rng, &mids, block, now.floor());
                curves.insert(f.id.clone(), curve);
                let today = source.with(|d| {
                    book(&mut d.volume, &f);
                    d.fills.push(f.clone());
                    if d.fills.len() > 5000 {
                        d.fills.remove(0);
                    }
                    d.volume.last().cloned().unwrap()
                });
                source.push(StreamMessage::Fill(Box::new(f)));
                source.push(StreamMessage::Volume(Box::new(today)));
            }
            if n.is_multiple_of(100) {
                aggregate(&source, &curves, now);
            }
        }
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!("fake mpamm API on http://127.0.0.1:{port} (stream ws://127.0.0.1:{port}/stream)");
    axum::serve(listener, mpamm_api::router(source)).await
}
