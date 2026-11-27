//! The service's source behind the real router, end to end without a ring:
//! a store on disk, commits and quote answers fed the way the pipeline and
//! the engine feed them, every route read over HTTP.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use mpamm_chain::Rpc;
use mpamm_pipeline::{Committed, Stats};
use mpamm_pricing::{Fees, Prices};
use mpamm_quotes::{depth::Depth, Engine, Outcome, VenueQuote};
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

fn none() -> Rpc {
    Rpc::new("none", "http://127.0.0.1:9", Duration::from_secs(1))
}

fn health(prices: &Arc<Prices>, engine: &Arc<Engine>, depth: &Arc<Depth>) -> crate::health::Health {
    crate::health::Health {
        ring: Arc::new(FollowStats::default()),
        pipeline: Arc::new(Stats::default()),
        prices: prices.clone(),
        quotes: engine.clone(),
        depth: depth.clone(),
        started: Instant::now(),
        stall_ms: 5_000,
    }
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
    let engine = Engine::new(venues.clone(), none(), prices.clone(), registry, Duration::from_millis(150));
    let depth =
        Depth::new(venues.clone(), none(), prices.clone(), registry, Duration::from_millis(150), Duration::ZERO);
    let health = health(&prices, &engine, &depth);
    let notes = crate::notes::NoteBuffer::new();
    notes.note(1.0, mpamm_types::NoteLevel::Warn, "feeds.warn", None, "kraken: book checksum mismatch");
    let source = ServiceSource::new(registry, venues, prices, depth, health, db.clone(), notes);
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
    assert_eq!(markets["state"]["notes"][0]["code"], "feeds.warn", "notes are served on REST");
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

/// A venue that quotes MON/USDC at the frame's mid, at every size, and
/// counts its calls.
struct DepthStub(std::sync::atomic::AtomicUsize);

#[async_trait]
impl Venue for DepthStub {
    fn id(&self) -> &str {
        "stub"
    }
    fn meta(&self) -> Vec<VenueMeta> {
        let mut m = mpamm_pricing::reference_venues(&Fees::default()).remove(0);
        m.id = "stub".into();
        vec![m]
    }
    async fn discover(&self, _: &mpamm_core::ChainCx<'_>) -> Result<(), mpamm_core::VenueError> {
        Ok(())
    }
    fn watch(&self) -> Result<mpamm_ring::WatchSet, mpamm_core::VenueError> {
        Ok(mpamm_ring::WatchSet::default())
    }
    fn decode(
        &self,
        _: &mpamm_core::DecodeCx<'_>,
        _: &mpamm_core::FinalBlock,
    ) -> Result<Vec<Fill>, mpamm_core::VenueError> {
        Ok(vec![])
    }
    fn markets(&self) -> Vec<String> {
        vec!["MON/USDC".into()]
    }
    async fn quote(
        &self,
        cx: &mpamm_core::QuoteCx<'_>,
        sizes: &[f64],
    ) -> Result<Vec<QuoteRow>, mpamm_core::VenueError> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mid = cx.pricer.pair_mid("MON/USDC");
        Ok(sizes
            .iter()
            .map(|&size| QuoteRow { size_usd: size, bid_px: mid * 0.9998, ask_px: mid * 1.0002, ..row("stub") })
            .collect())
    }
}

/// The next SSE event's text.
async fn event(sse: &mut Body) -> String {
    let f = tokio::time::timeout(Duration::from_secs(5), sse.frame()).await.expect("an event").unwrap().unwrap();
    String::from_utf8(f.into_data().unwrap().to_vec()).unwrap()
}

/// The JSON of a `data:` event.
fn data(event: &str) -> &str {
    event.strip_prefix("data: ").and_then(|e| e.strip_suffix("\n\n")).expect("a data event")
}

/// The source's depth behind the real router: nothing computed until a
/// viewer opens the SSE stream, a curve per executed block while it is
/// open, the same string on REST, and no work once it closes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn depth_curves_follow_a_viewer_through_the_router() {
    let dir = std::env::temp_dir().join(format!("mpamm-source-depth-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("mpamm.db");
    drop(Store::open(&db).unwrap());

    let registry = Registry::get();
    let prices = Prices::new(registry, Fees::default());
    let now = mpamm_pricing::feeds::now_ms();
    for (sym, mid) in [("MONUSDT", 0.03), ("USDCUSDT", 1.0)] {
        prices.feeds.bybit.touch(now);
        prices.feeds.bybit.update(sym, now, |s| {
            s.book.set(mpamm_pricing::Side::Sell, mid * 0.9999, 1e9);
            s.book.set(mpamm_pricing::Side::Buy, mid * 1.0001, 1e9);
            (s.best_bid, s.best_ask) = (mid * 0.9999, mid * 1.0001);
        });
    }
    let stub = Arc::new(DepthStub(Default::default()));
    let calls = || stub.0.load(std::sync::atomic::Ordering::SeqCst);
    let venues: Vec<Arc<dyn Venue>> = vec![stub.clone()];
    let engine = Engine::new(vec![], none(), prices.clone(), registry, Duration::from_millis(150));
    let depth =
        Depth::new(venues.clone(), none(), prices.clone(), registry, Duration::from_millis(150), Duration::ZERO);
    let health = health(&prices, &engine, &depth);
    let source = ServiceSource::new(
        registry,
        venues,
        prices.clone(),
        depth.clone(),
        health,
        db,
        crate::notes::NoteBuffer::new(),
    );
    let (committed, _) = broadcast::channel(16);
    source.start(&engine, committed.subscribe());
    let router = mpamm_api::router(source.clone());
    let block = |n: u64| mpamm_core::BlockRef { number: n, id: [n as u8; 32], hash: [n as u8; 32] };

    depth.on_executed(block(20));
    let (s, body) = get(&router, "/api/depth?market=MON%2FUSDC").await;
    assert_eq!((s, &body["error"]), (503, &Value::from("depth warming")), "REST never starts a computation");
    assert_eq!(get(&router, "/api/depth?market=NOPE").await.0, 400);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(calls(), 0);

    let req = Request::get("/api/depth/stream?market=MON%2FUSDC").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut sse = res.into_body();
    assert_eq!(event(&mut sse).await, "retry: 1000\n\n");
    // The viewer is the demand: the market is computed at the current block.
    let first = event(&mut sse).await;
    let snap: Value = serde_json::from_str(data(&first)).unwrap();
    assert_eq!((snap["market"].as_str(), snap["asOfBlock"].as_u64()), (Some("MON/USDC"), Some(20)));
    let curves: Vec<&str> = snap["venues"].as_array().unwrap().iter().map(|c| c["venueId"].as_str().unwrap()).collect();
    assert_eq!(curves, ["stub", "bybit"]);
    assert_eq!(snap["venues"][0]["points"].as_array().unwrap().len(), 25);
    assert_eq!(snap["missingVenues"], Value::Array(vec![]));
    assert_eq!(calls(), 1);

    let req = Request::get("/api/depth?market=MON%2FUSDC").body(Body::empty()).unwrap();
    let rest = router.clone().oneshot(req).await.unwrap().into_body().collect().await.unwrap().to_bytes();
    assert_eq!(rest, data(&first).as_bytes(), "REST serves the same serialized snapshot");
    let (_, health) = get(&router, "/api/health").await;
    assert_eq!(health["depth"]["markets"], serde_json::json!(["MON/USDC"]));

    depth.on_executed(block(21));
    let snap: Value = serde_json::from_str(data(&event(&mut sse).await)).unwrap();
    assert_eq!(snap["asOfBlock"], 21, "a curve per executed block while watched");

    drop(sse);
    for _ in 0..100 {
        if depth.demanded().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(depth.demanded().is_empty(), "closing the stream releases the demand");
    depth.on_executed(block(22));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(calls(), 2, "no viewer, no work");
    let (s, last) = get(&router, "/api/depth?market=MON%2FUSDC").await;
    assert_eq!((s, &last["asOfBlock"]), (200, &Value::from(21)), "the last curve stays readable");
    let _ = std::fs::remove_dir_all(&dir);
}
