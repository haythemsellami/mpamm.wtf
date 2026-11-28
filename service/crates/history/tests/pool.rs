//! The archive pool against fake nodes: failover, frozen nodes, loud
//! failure, the concurrency cap, and answers that don't fit the question.

use std::{
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{routing::post, Json, Router};
use mpamm_chain::Rpc;
use mpamm_history::{ArchivePool, PoolConfig};
use serde_json::{json, Value};

/// How a fake node answers.
#[derive(Clone, Copy)]
enum Mode {
    /// Every call answers.
    Good,
    /// Every call but `eth_blockNumber` is refused by its rate limiter.
    RateLimited,
    /// Answers, but its head is this block.
    HeadAt(u64),
    /// eth_getLogs answers a log of this block, whatever the range.
    LogOf(u64),
    /// eth_getBlockByNumber answers this block number, whatever was asked.
    BlockNumber(u64),
}

struct Fake {
    url: String,
    calls: Arc<AtomicU32>,
    peak: Arc<AtomicU64>,
}

const HEAD: u64 = 200_000;

fn log(n: u64) -> Value {
    json!({ "blockNumber": format!("0x{n:x}"), "blockHash": format!("0x{:064x}", n), "logIndex": "0x0" })
}

async fn fake(mode: Mode, delay_ms: u64) -> Fake {
    let calls = Arc::new(AtomicU32::new(0));
    let inflight = Arc::new(AtomicU64::new(0));
    let peak = Arc::new(AtomicU64::new(0));
    let (c, i, p) = (calls.clone(), inflight.clone(), peak.clone());
    let one = move |req: &Value| -> Value {
        let id = req["id"].clone();
        let method = req["method"].as_str().unwrap_or("");
        let err = |m: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": m } });
        let ok = |r: Value| json!({ "jsonrpc": "2.0", "id": id, "result": r });
        let head = match mode {
            Mode::HeadAt(h) => h,
            _ => HEAD,
        };
        match (method, mode) {
            ("eth_blockNumber", _) => ok(json!(format!("0x{head:x}"))),
            (_, Mode::RateLimited) => err("Internal error: error reading from db due to rate limit"),
            ("eth_getLogs", Mode::LogOf(n)) => ok(json!([log(n)])),
            ("eth_getLogs", _) => {
                let from =
                    u64::from_str_radix(req["params"][0]["fromBlock"].as_str().unwrap().trim_start_matches("0x"), 16)
                        .unwrap();
                ok(json!([log(from)]))
            }
            ("eth_getBlockByNumber", Mode::BlockNumber(n)) => ok(json!({ "number": format!("0x{n:x}") })),
            ("eth_getBlockByNumber", _) => ok(json!({ "number": req["params"][0] })),
            _ => err("unknown method"),
        }
    };
    let handler = move |Json(req): Json<Value>| {
        let (c, i, p) = (c.clone(), i.clone(), p.clone());
        async move {
            let is_head = req["method"] == "eth_blockNumber";
            if !is_head {
                c.fetch_add(1, Ordering::SeqCst);
            }
            let now = i.fetch_add(1, Ordering::SeqCst) + 1;
            p.fetch_max(now, Ordering::SeqCst);
            if !is_head {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            i.fetch_sub(1, Ordering::SeqCst);
            Json(match req.as_array() {
                Some(batch) => Value::Array(batch.iter().map(one).collect()),
                None => one(&req),
            })
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, Router::new().route("/", post(handler))).await.unwrap() });
    Fake { url: format!("http://{addr}"), calls, peak }
}

fn pool(nodes: &[(&str, &Fake)], cfg: PoolConfig) -> ArchivePool {
    ArchivePool::new(nodes.iter().map(|(l, f)| Rpc::new(*l, &f.url, Duration::from_secs(5))).collect(), cfg)
}

fn quick() -> PoolConfig {
    PoolConfig { rounds: 2, pause: Duration::from_millis(10), ..PoolConfig::default() }
}

#[tokio::test]
async fn an_overloaded_primary_hands_the_range_to_the_backup() {
    let (primary, backup) = (fake(Mode::RateLimited, 0).await, fake(Mode::Good, 0).await);
    let p = pool(&[("primary", &primary), ("backup", &backup)], quick());
    let got = p.logs(1000, 1999, &["0xabc".into()]).await.unwrap();
    assert_eq!(got.node, "backup");
    assert_eq!(got.logs.len(), 1);
    let stats = p.stats();
    assert_eq!((stats[0].failed, stats[1].ok), (1, 1));
    assert!(stats[0].last_error.as_deref().unwrap().contains("rate limit"));
}

#[tokio::test]
async fn a_frozen_node_never_serves_a_range_past_its_head() {
    let (frozen, backup) = (fake(Mode::HeadAt(1500), 0).await, fake(Mode::Good, 0).await);
    let p = pool(&[("primary", &frozen), ("backup", &backup)], quick());
    let got = p.logs(1000, 1999, &[]).await.unwrap();
    assert_eq!(got.node, "backup");
    assert_eq!(frozen.calls.load(Ordering::SeqCst), 0, "the frozen node was never asked for logs");
    // A range it does reach is its own.
    assert_eq!(p.logs(100, 1099, &[]).await.unwrap().node, "primary");
}

#[tokio::test]
async fn every_node_failing_is_an_error_naming_labels_never_urls() {
    let (a, b) = (fake(Mode::RateLimited, 0).await, fake(Mode::RateLimited, 0).await);
    let p = pool(&[("primary", &a), ("backup", &b)], quick());
    let e = p.logs(0, 999, &[]).await.unwrap_err().to_string();
    assert!(e.contains("primary:") && e.contains("backup:"), "{e}");
    assert!(!e.contains("127.0.0.1"), "a URL leaked: {e}");
    assert_eq!(a.calls.load(Ordering::SeqCst), 2, "two rounds");
    assert_eq!(b.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn an_empty_pool_fails_at_once() {
    let p = ArchivePool::new(Vec::new(), quick());
    assert!(p.is_empty());
    assert!(p.logs(0, 9, &[]).await.unwrap_err().0.contains("no archive node"));
}

#[tokio::test]
async fn a_log_outside_the_range_is_refused() {
    let (liar, backup) = (fake(Mode::LogOf(5000), 0).await, fake(Mode::Good, 0).await);
    let p = pool(&[("primary", &liar), ("backup", &backup)], quick());
    assert_eq!(p.logs(1000, 1999, &[]).await.unwrap().node, "backup");
    assert!(p.stats()[0].last_error.as_deref().unwrap().contains("outside the range"));
}

#[tokio::test]
#[should_panic(expected = "at most `chunk` blocks")]
async fn a_range_longer_than_a_chunk_is_a_bug() {
    let good = fake(Mode::Good, 0).await;
    let _ = pool(&[("primary", &good)], quick()).logs(0, 1000, &[]).await;
}

#[tokio::test]
async fn blocks_come_back_in_order_in_batches() {
    let good = fake(Mode::Good, 0).await;
    let p = pool(&[("primary", &good)], PoolConfig { batch: 2, ..quick() });
    let got = p.blocks(&[7, 3, 9, 11, 5]).await.unwrap();
    let numbers: Vec<&str> = got.iter().map(|b| b["number"].as_str().unwrap()).collect();
    assert_eq!(numbers, ["0x7", "0x3", "0x9", "0xb", "0x5"]);
    assert_eq!(good.calls.load(Ordering::SeqCst), 3, "batches of two");
}

#[tokio::test]
async fn a_batch_answering_the_wrong_block_is_read_from_the_backup() {
    let (liar, backup) = (fake(Mode::BlockNumber(1), 0).await, fake(Mode::Good, 0).await);
    let p = pool(&[("primary", &liar), ("backup", &backup)], quick());
    let got = p.blocks(&[42]).await.unwrap();
    assert_eq!(got[0]["number"], "0x2a");
    assert!(p.stats()[0].last_error.as_deref().unwrap().contains("asked for block 42"));
}

#[tokio::test]
async fn no_more_requests_are_in_flight_than_the_cap() {
    let slow = fake(Mode::Good, 40).await;
    let p = Arc::new(pool(&[("primary", &slow)], PoolConfig { concurrency: 3, ..quick() }));
    let reads = (0..12u64).map(|i| {
        let p = p.clone();
        tokio::spawn(async move { p.logs(i * 1000, i * 1000 + 999, &[]).await.unwrap() })
    });
    for r in reads {
        r.await.unwrap();
    }
    assert_eq!(slow.calls.load(Ordering::SeqCst), 12);
    assert!(slow.peak.load(Ordering::SeqCst) <= 3, "peak {}", slow.peak.load(Ordering::SeqCst));
}
