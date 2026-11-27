//! JSON-RPC over HTTP: the local node, and hosted pools for history and
//! fallback.
//!
//! Hosted URLs carry API keys, so a URL never appears in an error, a log line
//! or a panic: errors name the client by its label ("local", "archive") and
//! carry reqwest's message with the URL stripped.

use std::{fmt, time::Duration};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    /// Connection, timeout or body read failure (URL removed).
    Transport(String),
    /// A non-2xx HTTP status.
    Http(u16),
    /// The node answered with a JSON-RPC error object.
    Rpc {
        code: i64,
        message: String,
        /// A revert's return data (`0x…`), when the node sent it: what names
        /// the reason (`Error(string)`, `Panic(uint256)`, or a custom error).
        data: Option<String>,
    },
    /// The answer did not have the expected shape.
    Decode(String),
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Transport(m) => write!(f, "transport: {m}"),
            RpcError::Http(s) => write!(f, "http status {s}"),
            RpcError::Rpc { code, message, data } => {
                write!(f, "rpc error {code}: {message}")?;
                match data.as_deref().and_then(revert_reason) {
                    Some(r) => write!(f, " ({r})"),
                    None => Ok(()),
                }
            }
            RpcError::Decode(m) => write!(f, "decode: {m}"),
        }
    }
}

impl std::error::Error for RpcError {}

fn transport(e: reqwest::Error) -> RpcError {
    RpcError::Transport(e.without_url().to_string())
}

/// One JSON-RPC endpoint.
#[derive(Clone)]
pub struct Rpc {
    label: String,
    url: String,
    http: reqwest::Client,
}

impl fmt::Debug for Rpc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Rpc").field("label", &self.label).finish_non_exhaustive()
    }
}

impl Rpc {
    pub fn new(label: impl Into<String>, url: impl Into<String>, timeout: Duration) -> Self {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_nodelay(true)
            .build()
            .expect("reqwest client");
        Self { label: label.into(), url: url.into(), http }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    async fn post(&self, body: &Value) -> Result<Value, RpcError> {
        let resp = self.http.post(&self.url).json(body).send().await.map_err(transport)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(RpcError::Http(status.as_u16()));
        }
        resp.json::<Value>().await.map_err(transport)
    }

    /// One call; `Ok(Value::Null)` is a valid answer (an unknown block, say).
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        response(self.post(&body).await?)
    }

    /// A typed call.
    pub async fn call_as<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T, RpcError> {
        let v = self.call(method, params).await?;
        serde_json::from_value(v).map_err(|e| RpcError::Decode(format!("{method}: {e}")))
    }

    /// A JSON-RPC batch: the node runs its calls in parallel. Each result is
    /// returned in the order of `calls`; the outer error is for the batch as a
    /// whole (transport, HTTP, a malformed answer).
    pub async fn batch(&self, calls: &[(&str, Value)]) -> Result<Vec<Result<Value, RpcError>>, RpcError> {
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let body: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, (m, p))| json!({ "jsonrpc": "2.0", "id": i, "method": m, "params": p }))
            .collect();
        let answer = self.post(&Value::Array(body)).await?;
        let Value::Array(items) = answer else {
            // A provider that rejects batches answers with one error object.
            return Err(match response(answer) {
                Err(e) => e,
                Ok(_) => RpcError::Decode("batch answer is not an array".into()),
            });
        };
        let mut out: Vec<Option<Result<Value, RpcError>>> = vec![None; calls.len()];
        for item in items {
            let Some(i) = item.get("id").and_then(Value::as_u64).map(|i| i as usize) else {
                continue;
            };
            if let Some(slot) = out.get_mut(i) {
                *slot = Some(response(item));
            }
        }
        Ok(out
            .into_iter()
            .map(|r| r.unwrap_or_else(|| Err(RpcError::Decode("batch answer lacks an id".into()))))
            .collect())
    }

    /// `eth_getBlockByNumber(n, false)`; `None` if the node doesn't have it.
    pub async fn block_header(&self, number: u64) -> Result<Option<BlockHeader>, RpcError> {
        let v = self.call("eth_getBlockByNumber", json!([quantity(number), false])).await?;
        BlockHeader::from_json(&v)
    }

    /// Headers for several blocks in one batch, in order.
    pub async fn block_headers(&self, numbers: &[u64]) -> Result<Vec<Result<Option<BlockHeader>, RpcError>>, RpcError> {
        let calls: Vec<(&str, Value)> =
            numbers.iter().map(|n| ("eth_getBlockByNumber", json!([quantity(*n), false]))).collect();
        Ok(self.batch(&calls).await?.into_iter().map(|r| r.and_then(|v| BlockHeader::from_json(&v))).collect())
    }

    /// `eth_blockNumber`.
    pub async fn block_number(&self) -> Result<u64, RpcError> {
        let v = self.call("eth_blockNumber", json!([])).await?;
        parse_quantity(&v).ok_or_else(|| RpcError::Decode("eth_blockNumber".into()))
    }
}

/// A revert's reason from its return data: the string of `Error(string)`,
/// the code of `Panic(uint256)`, or a custom error's selector (the venue
/// module that knows the ABI can name it). `None` for empty data.
pub fn revert_reason(data: &str) -> Option<String> {
    let hex = data.strip_prefix("0x").unwrap_or(data);
    let bytes: Vec<u8> =
        (0..hex.len() / 2).map(|i| u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()).collect::<Option<_>>()?;
    let (selector, args) = (bytes.get(..4)?, &bytes[4..]);
    let word = |i: usize| args.get(32 * i..32 * i + 32);
    let small =
        |w: &[u8]| w[..24].iter().all(|b| *b == 0).then(|| u64::from_be_bytes(w[24..].try_into().unwrap()) as usize);
    match selector {
        // Error(string): offset, length, bytes.
        [0x08, 0xc3, 0x79, 0xa0] => {
            let len = small(word(1)?)?;
            let text = args.get(64..64 + len)?;
            Some(format!("reverted: {}", String::from_utf8_lossy(text).chars().take(200).collect::<String>()))
        }
        // Panic(uint256).
        [0x4e, 0x48, 0x7b, 0x71] => Some(format!("panic 0x{:02x}", small(word(0)?)?)),
        s => Some(format!("custom error 0x{}", s.iter().map(|b| format!("{b:02x}")).collect::<String>())),
    }
}

fn response(item: Value) -> Result<Value, RpcError> {
    if let Some(err) = item.get("error") {
        return Err(RpcError::Rpc {
            code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: err.get("message").and_then(Value::as_str).unwrap_or("").chars().take(300).collect(),
            data: err.get("data").and_then(Value::as_str).map(|d| d.chars().take(2 + 2 * 512).collect()),
        });
    }
    match item {
        Value::Object(mut m) => Ok(m.remove("result").unwrap_or(Value::Null)),
        _ => Err(RpcError::Decode("answer is not an object".into())),
    }
}

/// `0x`-prefixed hex quantity.
pub fn quantity(n: u64) -> String {
    format!("{n:#x}")
}

pub fn parse_quantity(v: &Value) -> Option<u64> {
    let s = v.as_str()?.strip_prefix("0x")?;
    u64::from_str_radix(s, 16).ok()
}

pub fn parse_quantity_u128(v: &Value) -> Option<u128> {
    let s = v.as_str()?.strip_prefix("0x")?;
    u128::from_str_radix(s, 16).ok()
}

pub fn parse_b32(v: &Value) -> Option<[u8; 32]> {
    let s = v.as_str()?.strip_prefix("0x")?;
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

/// The fields of a block header the service uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockHeader {
    pub number: u64,
    pub hash: [u8; 32],
    pub parent_hash: [u8; 32],
    pub timestamp: u64,
    pub txn_count: u32,
    pub gas_used: u64,
    pub base_fee: u128,
}

impl BlockHeader {
    pub fn from_json(v: &Value) -> Result<Option<Self>, RpcError> {
        if v.is_null() {
            return Ok(None);
        }
        let bad = |field: &str| RpcError::Decode(format!("block header field {field}"));
        Ok(Some(Self {
            number: parse_quantity(&v["number"]).ok_or_else(|| bad("number"))?,
            hash: parse_b32(&v["hash"]).ok_or_else(|| bad("hash"))?,
            parent_hash: parse_b32(&v["parentHash"]).ok_or_else(|| bad("parentHash"))?,
            timestamp: parse_quantity(&v["timestamp"]).ok_or_else(|| bad("timestamp"))?,
            txn_count: v["transactions"].as_array().map(|a| a.len() as u32).ok_or_else(|| bad("transactions"))?,
            gas_used: parse_quantity(&v["gasUsed"]).ok_or_else(|| bad("gasUsed"))?,
            base_fee: parse_quantity_u128(&v["baseFeePerGas"]).unwrap_or(0),
        }))
    }
}

#[cfg(test)]
mod tests;
