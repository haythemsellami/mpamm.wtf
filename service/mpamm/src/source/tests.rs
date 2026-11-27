//! The service's source behind the real router, end to end without a ring:
//! a store on disk, commits and quote answers fed the way the pipeline and
//! the engine feed them, every route read over HTTP.

use std::{sync::Arc, time::Duration};

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use mpamm_chain::Rpc;
use mpamm_pipeline::{Committed, Stats};
use mpamm_pricing::{Fees, Prices};
use mpamm_quotes::{Engine, Outcome, VenueQuote};
use mpamm_ring::live::FollowStats;
use mpamm_store::{BlockCommit, GasAccrual};
use mpamm_types::{FillCategory, QuoteRow, Side, TimeSource};
use serde_json::Value;
use tower::ServiceExt;

use super::*;

fn fill(id: &str, ts: f64, usd: f64, block: u64) -> Fill {
    Fill {
        id: id.into(),
        venue_id: "poe".into(),
        market: "MON/USDC".into(),
        side: Side::Buy,
        category: FillCategory::Direct,
        usd,
        base_amount: usd * 90.0,
        exec_px: 1.0 / 90.0,
        px_approx: false,
        tx_hash: format!("0x{id}"),
        to: "0xabc…def".into(),
        router: None,
        pool: "MON/USDC".into(),
        block_number: block,
        ts,
        markouts_bps: vec![Some(1.0), None, None, None, None],
        time_source: Some(TimeSource::Proposal),
    }
}

fn row(venue: &str) -> QuoteRow {
    QuoteRow {
        venue_id: venue.into(),
        market: "MON/USDC".into(),
        size_usd: 1000.0,
        bid_bps: -2.0,
        ask_bps: 2.0,
        bid_px: 0.0111,
        ask_px: 0.0112,
        spread_bps: 4.0,
        filled_full: true,
        one_sided: None,
        fee_bps: 0.0,
        cex_ask_bps: None,
        cex_bid_bps: None,
        ts: 0.0,
    }
}

fn answer(venue: &str, block: u64, rows: Vec<QuoteRow>) -> Arc<VenueQuote> {
    let now = now_ms() as f64;
    Arc::new(VenueQuote {
        venue: venue.into(),
        block,
        block_ref: mpamm_core::BlockRef { number: block, id: [block as u8; 32], hash: [block as u8; 32] },
        proposal_ms: now - 50.0,
        started_ms: now - 10.0,
        done_ms: now,
        rows,
        outcome: Outcome::Published,
    })
}

async fn get(router: &axum::Router, uri: &str) -> (u16, Value) {
    let res = router.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn next(rx: &mut broadcast::Receiver<StreamMessage>, channel: &str) -> StreamMessage {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let m = rx.recv().await.unwrap();
            if m.channel() == channel && (channel != "state") {
                return m;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {channel} message"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_dashboard_reads_the_service_through_every_route() {
    let dir = std::env::temp_dir().join(format!("mpamm-source-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mpamm.db");
    let mut store = Store::open(&db).unwrap();
    let now = now_ms() as f64;
    let secs = (now / 1000.0) as u64;
    // A stored trade from before the start, with the block's gas.
    store
        .commit_block(&BlockCommit {
            number: 10,
            hash: format!("0x{:064x}", 10),
            timestamp: secs,
            trades: vec![fill("poe-0x0a-0", now - 60_000.0, 100.0, 10)],
            gas: vec![GasAccrual { venue_id: "poe".into(), mon: 1.5, txs: 3 }],
            state: vec![],
        })
        .unwrap();

    let registry = Registry::get();
    let prices = Prices::new(registry, Fees::default());
    let venues: Vec<Arc<dyn Venue>> = vec![Arc::new(mpamm_venues::poe::Poe::default())];
    let engine = Engine::new(
        venues.clone(),
        Rpc::new("none", "http://127.0.0.1:9", Duration::from_secs(1)),
        prices.clone(),
        registry,
        Duration::from_millis(150),
    );
    let health = crate::health::Health {
        ring: Arc::new(FollowStats::default()),
        pipeline: Arc::new(Stats::default()),
        prices: prices.clone(),
        quotes: engine.clone(),
        started: Instant::now(),
        stall_ms: 5_000,
    };
    let source = ServiceSource::new(registry, venues, prices, health, db.clone());
    let (committed, _) = broadcast::channel(16);
    let mut rx = source.messages();
    source.start(&engine, committed.subscribe());
    let router = mpamm_api::router(source.clone());
    for _ in 0..100 {
        if source.ready() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(source.ready());
    assert_eq!(source.recent_fills().len(), 1, "the tape starts from the store");

    // A commit: stored first, then announced (the pipeline's order).
    let t2 = fill("poe-0x0b-0", now - 1_000.0, 200.0, 11);
    store
        .commit_block(&BlockCommit {
            number: 11,
            hash: format!("0x{:064x}", 11),
            timestamp: secs,
            trades: vec![t2.clone()],
            gas: vec![],
            state: vec![],
        })
        .unwrap();
    committed.send(Committed { number: 11, time_ms: t2.ts, trades: Arc::new(vec![t2.clone()]) }).unwrap();
    match next(&mut rx, "fill").await {
        StreamMessage::Fill(f) => assert_eq!(f.id, t2.id),
        m => panic!("{m:?}"),
    }
    match next(&mut rx, "volume").await {
        StreamMessage::Volume(d) => assert_eq!((d.by_venue["poe"].swaps, d.by_venue["poe"].usd), (2, 300.0)),
        m => panic!("{m:?}"),
    }

    // A block's quote answers: the exchanges first, then every venue.
    engine.published.send(answer("bybit", 20, vec![row("bybit")])).unwrap();
    engine.published.send(answer("poe", 20, vec![row("poe")])).unwrap();
    match next(&mut rx, "quotes").await {
        StreamMessage::Quotes(q) => {
            assert_eq!(q.block, 20);
            assert_eq!(q.rows.iter().map(|r| r.venue_id.as_str()).collect::<Vec<_>>(), ["poe", "bybit"]);
        }
        m => panic!("{m:?}"),
    }

    // Markouts arriving for a trade on the tape are sent again.
    source.on_markouts(&[(t2.id.clone(), vec![Some(1.0), Some(2.0), None, None, None])]);
    match next(&mut rx, "fill").await {
        StreamMessage::Fill(f) => assert_eq!(f.markouts_bps[1], Some(2.0)),
        m => panic!("{m:?}"),
    }

    let (s, fills) = get(&router, "/api/fills?days=1").await;
    assert_eq!(s, 200);
    let ids: Vec<&str> = fills.as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["poe-0x0b-0", "poe-0x0a-0"], "newest first");

    let (s, markets) = get(&router, "/api/markets").await;
    assert_eq!(s, 200);
    let venues: Vec<&str> =
        markets["state"]["venues"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(venues, ["poe", "bybit", "binance", "kraken"]);
    assert_eq!(markets["state"]["source"], "live");
    assert_eq!(markets["quotes"]["block"], 20);
    assert_eq!(markets["fills"].as_array().unwrap().len(), 2);
    assert_eq!(markets["fills"][0]["markoutsBps"][1], 2.0, "the tape holds the aged markouts");

    let (s, quotes) = get(&router, "/api/quotes").await;
    assert_eq!((s, &quotes["block"]), (200, &Value::from(20)));
    let (s, hist) = get(&router, "/api/quotes/history?market=MON%2FUSDC&size=1000").await;
    assert_eq!(s, 200);
    assert_eq!(hist.as_array().map(Vec::len), Some(1));
    let (s, stats) = get(&router, "/api/quotes/stats?market=MON%2FUSDC&size=1000").await;
    assert_eq!(s, 200);
    assert_eq!(stats["rows"].as_array().unwrap().len(), 2, "poe and bybit spreads");

    let (s, volume) = get(&router, "/api/volume").await;
    assert_eq!(s, 200);
    assert_eq!(volume.as_array().unwrap().last().unwrap()["byVenue"]["poe"]["swaps"], 2);
    let (s, gas) = get(&router, "/api/gas").await;
    assert_eq!(s, 200);
    assert_eq!(gas["days"][0]["byVenue"]["poe"]["txs"], 3);
    assert_eq!(gas["approx"], Value::Array(vec![]), "exact gas");

    let (s, lb) = get(&router, "/api/leaderboard?days=1").await;
    assert_eq!(s, 200);
    assert_eq!(lb["totalFills"], 2);
    let (s, curves) = get(&router, "/api/markout-curves?days=7").await;
    assert_eq!(s, 200);
    assert_eq!(curves["days"], 7);

    // No ring here: the health says so, with 503 for a deploy's gate.
    let (s, health) = get(&router, "/api/health").await;
    assert_eq!(s, 503);
    assert_eq!(health["status"], "no_ring");
    assert!(health["stream"].is_object(), "the router adds the stream's counters");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_tail_shows_only_past_two_minutes_and_is_held_only_without_progress() {
    // Finality's ~3 blocks: live, no tail on the state.
    let t = tail_status(1_000, 1_003, 0, 1);
    assert_eq!((t.lag_blocks, t.lag_ms, t.held), (3, 1_200.0, false));
    assert!(t.lag_ms <= TAIL_LAG_SHOWN_MS);
    // Catching up after an outage: shown, not held while commits flow.
    let now = 10_000_000;
    let t = tail_status(1_000, 1_400, now - 1_000, now);
    assert!(t.lag_ms > TAIL_LAG_SHOWN_MS && !t.held);
    // Nothing committed for over two minutes while behind: held.
    let t = tail_status(1_000, 1_400, now - 130_000, now);
    assert!(t.held);
}
