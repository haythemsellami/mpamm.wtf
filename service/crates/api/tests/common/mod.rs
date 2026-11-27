//! Shared by the REST and stream tests.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use bytes::Bytes;
use http_body_util::BodyExt;
use mpamm_api::testing::{sample_state, FakeSource};
use mpamm_api::{router_with, ApiConfig};
use mpamm_types::{
    Fill, FillCategory, MarketState, NoteLevel, QuoteRow, QuoteSnapshot, RealtimeHealth, Side, StateNote,
};
use serde_json::Value;
use tower::ServiceExt;

pub const NOW: u64 = 1_800_000_000_000;

/// A clock the test moves.
#[derive(Clone)]
pub struct TestClock(pub Arc<AtomicU64>);

impl TestClock {
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

pub struct Server {
    pub source: Arc<FakeSource>,
    pub router: axum::Router,
    pub clock: TestClock,
}

pub fn server_with(source: Arc<FakeSource>, edit: impl FnOnce(&mut ApiConfig)) -> Server {
    let clock = TestClock(Arc::new(AtomicU64::new(NOW)));
    let c = clock.0.clone();
    let mut config = ApiConfig { clock: Arc::new(move || c.load(Ordering::SeqCst) as f64), ..ApiConfig::default() };
    edit(&mut config);
    let router = router_with(source.clone(), config);
    Server { source, router, clock }
}

pub fn server(source: Arc<FakeSource>) -> Server {
    server_with(source, |_| {})
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("{e}: {:?}", String::from_utf8_lossy(&self.body)))
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|v| v.to_str().unwrap())
    }
}

/// One request through the router, the body as it goes on the wire (not
/// decompressed).
pub async fn get(router: &axum::Router, uri: &str, headers: &[(&str, &str)]) -> Reply {
    let mut req = Request::get(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = res.into_parts();
    Reply { status: parts.status, headers: parts.headers, body: body.collect().await.unwrap().to_bytes() }
}

pub async fn get_json(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let r = get(router, uri, &[]).await;
    (r.status, r.json())
}

/// A row as prod ships it: full-precision floats, the CEX-as-taker pair.
pub fn row(venue: &str, market: &str, size_usd: f64) -> QuoteRow {
    QuoteRow {
        venue_id: venue.into(),
        market: market.into(),
        size_usd,
        bid_bps: -25.113599704000844,
        ask_bps: 26.180428069468853,
        bid_px: 0.015558350990069999,
        ask_px: 0.015638356962646323,
        spread_bps: 51.29402777346969,
        filled_full: true,
        one_sided: None,
        fee_bps: 21.28521667311415,
        cex_ask_bps: Some(15.105414314744436),
        cex_bid_bps: Some(14.246109677127361),
        ts: 100.0,
    }
}

pub fn quotes(block: u64, rows: Vec<QuoteRow>) -> QuoteSnapshot {
    QuoteSnapshot {
        block_hash: Some(format!("0x{}", "ab".repeat(32))),
        revision: None,
        block,
        mon_usd: 0.024,
        ts: 100.0,
        rows,
        frame: None,
    }
}

/// 60 notes at the sanitizer's length cap: the worst case today's buffer
/// reaches, and what used to ride every state frame.
pub fn notes() -> Vec<StateNote> {
    (0..60)
        .map(|i| StateNote {
            ts: 1_700_000_000_000.0 + i as f64,
            level: NoteLevel::Warn,
            code: "quote.head.fallback".into(),
            venue: Some("poe".into()),
            msg: format!("{}…", "x".repeat(297)),
        })
        .collect()
}

pub fn realtime() -> RealtimeHealth {
    serde_json::from_value(serde_json::json!({
        "headBlock": 12345, "quoteBlock": 12344, "lagBlocks": 1, "frameMs": 210, "headToFrameMs": 190,
        "eventLoopLagMs": 3, "coveragePct60s": 99.2, "coalescedBlocks60s": 4, "headSource": "ws", "wsStatus": "connected"
    }))
    .unwrap()
}

/// Today's egress-test state: notes and quote pace on it.
pub fn busy_state() -> MarketState {
    MarketState { block: 12_345, notes: Some(notes()), realtime: Some(realtime()), ..sample_state() }
}

pub fn fill(id: &str, ts: f64) -> Fill {
    Fill {
        id: id.into(),
        venue_id: "poe".into(),
        market: "MON/USDC".into(),
        side: Side::Buy,
        category: FillCategory::Direct,
        usd: 100.0,
        base_amount: 4000.0,
        exec_px: 0.025,
        px_approx: false,
        tx_hash: "0x123".into(),
        to: "0x45…67".into(),
        router: None,
        pool: "MON/USDC".into(),
        block_number: 2,
        ts,
        markouts_bps: vec![Some(1.0), None, None, None, None],
        time_source: None,
    }
}

pub fn frame_telemetry() -> mpamm_types::QuoteFrameTelemetry {
    serde_json::from_value(serde_json::json!({
        "headSource": "ws", "headObservedAt": 80, "quoteStartedAt": 81, "quoteCompletedAt": 99, "emittedAt": 100,
        "durationMs": 18, "adapterMs": { "poe": 17.2, "clober": 4 }, "missingVenues": ["clober"], "coalescedBlocks": 0
    }))
    .unwrap()
}

pub async fn wait_for(mut done: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(done(), "timed out");
}
