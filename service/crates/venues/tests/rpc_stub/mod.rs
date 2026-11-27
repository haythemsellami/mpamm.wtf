//! A JSON-RPC node on a loopback port, for quote tests. `mpamm_chain::Rpc`
//! is a real HTTP client, so a venue's reads are stubbed on the wire: each
//! request (one call or a batch) is answered call by call by the test's
//! handler, and every call is recorded, so a test can check exactly what was
//! asked, in how many round trips, and at which block.

#![allow(dead_code)]

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{routing::post, Json, Router};
use mpamm_chain::Rpc;
use parking_lot::Mutex;
use serde_json::{json, Value};

/// One JSON-RPC call as the node saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    /// Which HTTP request carried it (a batch shares one).
    pub request: usize,
    pub method: String,
    pub params: Value,
}

impl Seen {
    /// An eth_call's calldata.
    pub fn data(&self) -> Vec<u8> {
        call_data(&self.params)
    }
}

/// A handler's answer: the `result`, or the JSON-RPC `error` object.
pub type Answer = Result<Value, Value>;

pub struct Stub {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Stub {
    /// Serves `handler(method, params)` until the test's runtime ends.
    pub async fn start(handler: impl Fn(&str, &Value) -> Answer + Send + Sync + 'static) -> Stub {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(AtomicUsize::new(0));
        let handler = Arc::new(handler);
        let log = seen.clone();
        let route = move |Json(body): Json<Value>| {
            let (handler, log, requests) = (handler.clone(), log.clone(), requests.clone());
            async move {
                let request = requests.fetch_add(1, Ordering::SeqCst);
                let answer = |call: &Value| {
                    let method = call["method"].as_str().unwrap_or_default().to_string();
                    let params = call["params"].clone();
                    let out = handler(&method, &params);
                    log.lock().push(Seen { request, method, params });
                    match out {
                        Ok(result) => json!({ "jsonrpc": "2.0", "id": call["id"], "result": result }),
                        Err(error) => json!({ "jsonrpc": "2.0", "id": call["id"], "error": error }),
                    }
                };
                Json(match &body {
                    Value::Array(calls) => Value::Array(calls.iter().map(answer).collect()),
                    call => answer(call),
                })
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, Router::new().route("/", post(route))).await.unwrap() });
        Stub { url, seen }
    }

    pub fn rpc(&self) -> Rpc {
        Rpc::new("stub", &self.url, Duration::from_secs(5))
    }

    /// Every call so far, in arrival order.
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().clone()
    }
}

/// An eth_call's calldata, from its params.
pub fn call_data(params: &Value) -> Vec<u8> {
    let hex = params[0]["data"].as_str().and_then(|s| s.strip_prefix("0x")).expect("eth_call data");
    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect()
}

/// `0x`-hex of raw bytes (an eth_call result).
pub fn hex(bytes: &[u8]) -> Value {
    Value::String(format!("0x{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

/// The node's answer to a call that reverted, carrying the revert payload.
pub fn reverted(data: &str) -> Answer {
    Err(json!({ "code": 3, "message": "execution reverted", "data": data }))
}

/// The block tag an EIP-1898 hash pin carries.
pub fn pinned_to(hash: [u8; 32]) -> Value {
    json!({ "blockHash": format!("0x{}", hash.iter().map(|b| format!("{b:02x}")).collect::<String>()), "requireCanonical": false })
}
