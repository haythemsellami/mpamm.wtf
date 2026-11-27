//! Contract reads for discovery, ABI-encoded with alloy: one call, or many
//! in one JSON-RPC batch (the node runs a batch in parallel).

use alloy_primitives::Address;
use alloy_sol_types::SolCall;
use mpamm_chain::Rpc;
use mpamm_core::VenueError;
use serde_json::json;

/// Which state a read sees.
#[derive(Debug, Clone, Copy)]
pub enum At {
    Latest,
    Number(u64),
    /// Pinned to a block hash (EIP-1898): every read of a quote job sees the
    /// same proposal, even before it is final.
    Hash([u8; 32]),
}

impl At {
    fn tag(self) -> serde_json::Value {
        match self {
            At::Latest => json!("latest"),
            At::Number(n) => json!(mpamm_chain::quantity(n)),
            At::Hash(h) => json!({ "blockHash": format!("0x{}", mpamm_ring::hex(&h)), "requireCanonical": false }),
        }
    }
}

/// Every read carries an explicit gas limit under 8.1M: the node runs such
/// calls in its 1,000-slot pool; a call without one can end up in the
/// 20-slot pool for heavy calls (docs/rebuild-spec.md → `eth_call` pools).
pub const CALL_GAS: u64 = 8_000_000;

fn request<C: SolCall>(to: Address, call: &C) -> serde_json::Value {
    json!({
        "to": to.to_string(),
        "data": format!("0x{}", mpamm_ring::hex(&call.abi_encode())),
        "gas": mpamm_chain::quantity(CALL_GAS),
    })
}

fn decode<C: SolCall>(v: &serde_json::Value) -> Result<C::Return, VenueError> {
    let hex =
        v.as_str().and_then(|s| s.strip_prefix("0x")).ok_or_else(|| VenueError::Chain("eth_call result".into()))?;
    let bytes = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| VenueError::Chain("eth_call hex".into()))?;
    C::abi_decode_returns(&bytes).map_err(|e| VenueError::Chain(format!("{}: {e}", C::SIGNATURE)))
}

/// The node's answer for a block whose state it can't read (yet).
const NOT_READABLE: &str = "Block requested not found";

/// A block announced as Proposed has its state readable a few ms after the
/// announcement (measured 3–5 ms, at most 9), so a read pinned to its hash
/// retries that error with these pauses (≈ 40 ms in all) before failing.
/// Any other block's "not found" is real and fails at once.
const PROPOSED_RETRY_MS: [u64; 6] = [2, 3, 5, 8, 10, 12];

fn not_readable(e: &str) -> bool {
    e.contains(NOT_READABLE)
}

pub async fn call<C: SolCall>(rpc: &Rpc, to: Address, call: &C, at: At) -> Result<C::Return, VenueError> {
    let params = json!([request(to, call), at.tag()]);
    let mut pauses = retry_pauses(at);
    let v = loop {
        match rpc.call("eth_call", params.clone()).await {
            Ok(v) => break v,
            Err(e) => {
                let e = e.to_string();
                match pauses.next().filter(|_| not_readable(&e)) {
                    Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
                    None => return Err(VenueError::Chain(format!("{} on {to}: {e}", C::SIGNATURE))),
                }
            }
        }
    };
    decode::<C>(&v)
}

fn retry_pauses(at: At) -> impl Iterator<Item = u64> {
    let n = if matches!(at, At::Hash(_)) { PROPOSED_RETRY_MS.len() } else { 0 };
    PROPOSED_RETRY_MS.into_iter().take(n)
}

/// Calls per JSON-RPC request when many are sent: the node answers several
/// smaller requests in parallel faster than one large one (on the node host,
/// 200 cheap calls: 8.2 ms as one batch, 4.5 ms as 8 concurrent batches of
/// 25, 8.9 ms as 20 of 10).
pub const BATCH: usize = 25;

/// Many calls of one kind, sent as concurrent batches of [`BATCH`]; each
/// result separately, in order.
pub async fn call_many<C: SolCall>(
    rpc: &Rpc,
    calls: &[(Address, C)],
    at: At,
) -> Result<Vec<Result<C::Return, VenueError>>, VenueError> {
    if calls.is_empty() {
        return Ok(Vec::new());
    }
    let params: Vec<(&str, serde_json::Value)> =
        calls.iter().map(|(to, c)| ("eth_call", json!([request(*to, c), at.tag()]))).collect();
    let parts = futures_util::future::join_all(params.chunks(BATCH).map(|chunk| batch_once::<C>(rpc, chunk, at))).await;
    let mut out = Vec::with_capacity(calls.len());
    for part in parts {
        out.extend(part?);
    }
    Ok(out)
}

/// One batch, retried while a just-proposed block's state isn't readable.
async fn batch_once<C: SolCall>(
    rpc: &Rpc,
    params: &[(&str, serde_json::Value)],
    at: At,
) -> Result<Vec<Result<C::Return, VenueError>>, VenueError> {
    let mut pauses = retry_pauses(at);
    let out = loop {
        let out = rpc.batch(params).await.map_err(|e| e.to_string());
        // One block's state is readable for every call or for none.
        let unreadable = match &out {
            Ok(items) => items.iter().any(|r| r.as_ref().is_err_and(|e| not_readable(&e.to_string()))),
            Err(e) => not_readable(e),
        };
        match pauses.next().filter(|_| unreadable) {
            Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
            None => break out.map_err(|e| VenueError::Chain(format!("{} batch: {e}", C::SIGNATURE)))?,
        }
    };
    Ok(out
        .into_iter()
        .map(|r| match r {
            Ok(v) => decode::<C>(&v),
            Err(e) => Err(VenueError::Chain(format!("{}: {e}", C::SIGNATURE))),
        })
        .collect())
}
