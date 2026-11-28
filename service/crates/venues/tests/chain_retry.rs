//! Reads pinned to a just-proposed block retry while the node can't read its
//! state yet; every other failure, and every other block, fails at once.

use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

use alloy_primitives::Address;
use alloy_sol_types::sol;
use axum::{routing::post, Json, Router};
use mpamm_chain::Rpc;
use mpamm_venues::chain::{call, call_many, At};
use serde_json::{json, Value};

sol! {
    function answer() view returns (uint256);
}

const NOT_FOUND: &str = "Block requested not found. Request might be querying historical state that is not available.";

/// A node whose first `unreadable` requests (a batch counts once) say the
/// block isn't readable, then every call answers 42.
async fn node(unreadable: u32, message: &'static str) -> (String, Arc<AtomicU32>) {
    let left = Arc::new(AtomicU32::new(unreadable));
    let seen = Arc::new(AtomicU32::new(0));
    let (l, s) = (left.clone(), seen.clone());
    let one = move |req: &Value, fail: bool| {
        if fail {
            json!({ "jsonrpc": "2.0", "id": req["id"], "error": { "code": -32602, "message": message } })
        } else {
            json!({ "jsonrpc": "2.0", "id": req["id"], "result": format!("0x{:064x}", 42) })
        }
    };
    let handler = move |Json(req): Json<Value>| {
        let (l, s) = (l.clone(), s.clone());
        async move {
            s.fetch_add(1, Ordering::SeqCst);
            // The tests send one request at a time.
            let fail = l.load(Ordering::SeqCst) > 0;
            if fail {
                l.fetch_sub(1, Ordering::SeqCst);
            }
            Json(match req.as_array() {
                Some(batch) => Value::Array(batch.iter().map(|r| one(r, fail)).collect()),
                None => one(&req, fail),
            })
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, Router::new().route("/", post(handler))).await.unwrap() });
    (format!("http://{addr}"), seen)
}

fn rpc(url: &str) -> Rpc {
    Rpc::new("test", url, Duration::from_secs(5))
}

#[tokio::test]
async fn a_just_proposed_block_is_read_once_its_state_is() {
    let (url, seen) = node(3, NOT_FOUND).await;
    let v = call(&rpc(&url), Address::ZERO, &answerCall {}, At::Hash([7; 32])).await.unwrap();
    assert_eq!(v, alloy_primitives::U256::from(42));
    assert_eq!(seen.load(Ordering::SeqCst), 4, "three unreadable answers, then the read");
}

#[tokio::test]
async fn a_batch_retries_as_one() {
    let (url, seen) = node(2, NOT_FOUND).await;
    let calls = vec![(Address::ZERO, answerCall {}), (Address::ZERO, answerCall {})];
    let out = call_many(&rpc(&url), &calls, At::Hash([7; 32])).await.unwrap();
    assert!(out.iter().all(|r| r.as_ref().is_ok_and(|v| *v == alloy_primitives::U256::from(42))));
    assert_eq!(seen.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn the_retry_is_bounded() {
    let (url, seen) = node(100, NOT_FOUND).await;
    let t = std::time::Instant::now();
    let e = call(&rpc(&url), Address::ZERO, &answerCall {}, At::Hash([7; 32])).await.unwrap_err();
    assert!(e.to_string().contains("Block requested not found"), "{e}");
    assert_eq!(seen.load(Ordering::SeqCst), 7, "the read and six retries");
    assert!(t.elapsed() < Duration::from_millis(500));
}

#[tokio::test]
async fn other_blocks_and_other_errors_fail_at_once() {
    let (url, seen) = node(1, NOT_FOUND).await;
    assert!(call(&rpc(&url), Address::ZERO, &answerCall {}, At::Number(5)).await.is_err());
    assert_eq!(seen.load(Ordering::SeqCst), 1, "a numbered block that isn't there is really not there");
    let (url, seen) = node(1, "execution reverted").await;
    assert!(call(&rpc(&url), Address::ZERO, &answerCall {}, At::Hash([7; 32])).await.is_err());
    assert_eq!(seen.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn many_calls_go_as_concurrent_batches_in_order() {
    let (url, seen) = node(0, NOT_FOUND).await;
    let calls: Vec<(Address, answerCall)> = (0..60).map(|_| (Address::ZERO, answerCall {})).collect();
    let out = call_many(&rpc(&url), &calls, At::Hash([7; 32])).await.unwrap();
    assert_eq!(out.len(), 60);
    assert!(out.iter().all(|r| r.as_ref().is_ok_and(|v| *v == alloy_primitives::U256::from(42))));
    assert_eq!(seen.load(Ordering::SeqCst), 3, "60 calls in batches of 25: three requests");
}
