use std::net::SocketAddr;

use axum::{http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};

use super::*;

/// A fake node: answers `eth_getBlockByNumber` for blocks 1..=100, errors on
/// `boom`, and serves batches in reverse order (ids must re-pair them).
async fn node(req: Json<Value>) -> (StatusCode, Json<Value>) {
    fn one(call: &Value) -> Value {
        let id = call["id"].clone();
        match call["method"].as_str() {
            Some("eth_getBlockByNumber") => {
                let n = parse_quantity(&call["params"][0]).unwrap();
                if n == 0 || n > 100 {
                    return json!({ "jsonrpc": "2.0", "id": id, "result": null });
                }
                json!({ "jsonrpc": "2.0", "id": id, "result": {
                    "number": quantity(n),
                    "hash": format!("0x{:064x}", n),
                    "parentHash": format!("0x{:064x}", n - 1),
                    "timestamp": quantity(1_700_000_000 + n),
                    "transactions": vec!["0x00"; n as usize % 5],
                    "gasUsed": "0x5208",
                    "baseFeePerGas": "0x174876e800",
                }})
            }
            Some("eth_blockNumber") => json!({ "jsonrpc": "2.0", "id": id, "result": "0x64" }),
            _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "boom" } }),
        }
    }
    match req.0 {
        Value::Array(calls) => (StatusCode::OK, Json(Value::Array(calls.iter().rev().map(one).collect()))),
        call if call["method"] == "http500" => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))),
        call => (StatusCode::OK, Json(one(&call))),
    }
}

async fn serve() -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route("/", post(node)).route("/secret-key-123", post(node));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

fn client(addr: SocketAddr, path: &str) -> Rpc {
    Rpc::new("test", format!("http://{addr}{path}"), Duration::from_secs(2))
}

#[tokio::test]
async fn reads_a_block_header() {
    let rpc = client(serve().await, "/");
    let h = rpc.block_header(42).await.unwrap().unwrap();
    assert_eq!(h.number, 42);
    assert_eq!(h.hash[31], 42);
    assert_eq!(h.parent_hash[31], 41);
    assert_eq!(h.timestamp, 1_700_000_042);
    assert_eq!(h.txn_count, 2);
    assert_eq!(h.gas_used, 21_000);
    assert_eq!(h.base_fee, 100_000_000_000);
    assert_eq!(rpc.block_header(101).await.unwrap(), None);
    assert_eq!(rpc.block_number().await.unwrap(), 100);
}

#[tokio::test]
async fn batch_results_follow_call_order() {
    let rpc = client(serve().await, "/");
    let got = rpc.block_headers(&[3, 200, 7]).await.unwrap();
    assert_eq!(got[0].as_ref().unwrap().as_ref().unwrap().number, 3);
    assert_eq!(got[1], Ok(None));
    assert_eq!(got[2].as_ref().unwrap().as_ref().unwrap().number, 7);

    let mixed = rpc.batch(&[("eth_blockNumber", json!([])), ("nope", json!([]))]).await.unwrap();
    assert_eq!(mixed[0], Ok(json!("0x64")));
    assert_eq!(mixed[1], Err(RpcError::Rpc { code: -32601, message: "boom".into(), data: None }));
    assert!(rpc.batch(&[]).await.unwrap().is_empty());
}

#[tokio::test]
async fn errors_are_typed() {
    let rpc = client(serve().await, "/");
    assert_eq!(
        rpc.call("nope", json!([])).await,
        Err(RpcError::Rpc { code: -32601, message: "boom".into(), data: None })
    );
    assert_eq!(rpc.call("http500", json!([])).await, Err(RpcError::Http(500)));
    let typed: Result<u64, _> = rpc.call_as("eth_blockNumber", json!([])).await;
    assert!(matches!(typed, Err(RpcError::Decode(_))), "a hex string is not a u64: {typed:?}");
}

#[tokio::test]
async fn urls_never_appear_in_errors() {
    let addr = serve().await;
    // A path that stands in for an API key, on a port nothing listens on.
    let dead = Rpc::new("archive", "http://127.0.0.1:9/secret-key-123", Duration::from_millis(500));
    let err = dead.block_number().await.unwrap_err();
    let text = format!("{err} {err:?} {dead:?}");
    assert!(matches!(err, RpcError::Transport(_)));
    assert!(!text.contains("secret-key-123") && !text.contains("127.0.0.1"), "{text}");

    let live = client(addr, "/secret-key-123");
    let err = live.call("http500", json!([])).await.unwrap_err();
    assert!(!format!("{err} {err:?} {live:?}").contains("secret-key-123"));
}

#[test]
fn hex_helpers() {
    assert_eq!(quantity(0), "0x0");
    assert_eq!(quantity(255), "0xff");
    assert_eq!(parse_quantity(&json!("0x1f")), Some(31));
    assert_eq!(parse_quantity(&json!("1f")), None);
    assert_eq!(parse_quantity(&json!(31)), None);
    assert_eq!(parse_b32(&json!(format!("0x{}", "ab".repeat(32)))), Some([0xab; 32]));
    assert_eq!(parse_b32(&json!("0xab")), None);
    assert_eq!(BlockHeader::from_json(&Value::Null), Ok(None));
    assert!(BlockHeader::from_json(&json!({ "number": "0x1" })).is_err());
}

#[test]
fn a_revert_names_its_reason() {
    // Error("paused")
    let err = "0x08c379a0\
               0000000000000000000000000000000000000000000000000000000000000020\
               0000000000000000000000000000000000000000000000000000000000000006\
               7061757365640000000000000000000000000000000000000000000000000000";
    assert_eq!(revert_reason(err).as_deref(), Some("reverted: paused"));
    // Panic(0x11): arithmetic overflow.
    let panic = "0x4e487b710000000000000000000000000000000000000000000000000000000000000011";
    assert_eq!(revert_reason(panic).as_deref(), Some("panic 0x11"));
    assert_eq!(revert_reason("0xdeadbeef").as_deref(), Some("custom error 0xdeadbeef"));
    assert_eq!(revert_reason("0x"), None);
    assert_eq!(revert_reason("0x08c379a0"), None, "a truncated Error(string) is not guessed at");
    let e = RpcError::Rpc { code: 3, message: "execution reverted".into(), data: Some("0xdeadbeef".into()) };
    assert_eq!(e.to_string(), "rpc error 3: execution reverted (custom error 0xdeadbeef)");
}
