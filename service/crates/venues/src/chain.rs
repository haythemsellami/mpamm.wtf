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

fn request<C: SolCall>(to: Address, call: &C) -> serde_json::Value {
    json!({ "to": to.to_string(), "data": format!("0x{}", mpamm_ring::hex(&call.abi_encode())) })
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

pub async fn call<C: SolCall>(rpc: &Rpc, to: Address, call: &C, at: At) -> Result<C::Return, VenueError> {
    let v = rpc
        .call("eth_call", json!([request(to, call), at.tag()]))
        .await
        .map_err(|e| VenueError::Chain(format!("{} on {to}: {e}", C::SIGNATURE)))?;
    decode::<C>(&v)
}

/// Many calls of one kind in one batch; each result separately.
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
    let out = rpc.batch(&params).await.map_err(|e| VenueError::Chain(format!("{} batch: {e}", C::SIGNATURE)))?;
    Ok(out
        .into_iter()
        .map(|r| match r {
            Ok(v) => decode::<C>(&v),
            Err(e) => Err(VenueError::Chain(format!("{}: {e}", C::SIGNATURE))),
        })
        .collect())
}
