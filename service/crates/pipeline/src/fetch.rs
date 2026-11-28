//! Reading a final block over RPC, for heights the ring lost and, in
//! fallback mode, every height. The local node serves recent heights; the
//! hosted hot node serves them while the local one is down; the hosted
//! archive serves what neither has (after a node reset, or deep history).
//! Both calls for one block go to the same client, and any failure discards
//! the whole answer: a partial or mixed answer never reaches a commit.

use mpamm_chain::{quantity, Rpc, RpcError};
use mpamm_core::FinalBlock;
use mpamm_ring::{hex, WatchSet};
use serde_json::{json, Value};

pub struct Fetcher {
    pub local: Rpc,
    /// The hosted hot node (fallback mode).
    pub hot: Option<Rpc>,
    pub archive: Option<Rpc>,
    /// Set in fallback mode: the local node is down, don't wait on it.
    pub skip_local: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Fetcher {
    /// The block from the first client that has it whole: local, hot, archive.
    pub async fn block(&self, number: u64, watch: &WatchSet) -> Result<FinalBlock, RpcError> {
        let mut errors = Vec::new();
        let skip = self.skip_local.load(std::sync::atomic::Ordering::Relaxed)
            && (self.hot.is_some() || self.archive.is_some());
        let local = (!skip).then_some(&self.local);
        for rpc in local.into_iter().chain(self.hot.iter()).chain(self.archive.iter()) {
            match fetch(rpc, number, watch).await {
                Ok(b) => return Ok(b),
                Err(e) => errors.push(format!("{}: {e}", rpc.label())),
            }
        }
        Err(RpcError::Transport(errors.join("; ")))
    }
}

/// The log filter for one block: watched addresses (none = no logs needed).
fn log_filter(hash: &str, watch: &WatchSet) -> Option<Value> {
    if watch.all_logs {
        return Some(json!({ "blockHash": hash }));
    }
    if watch.logs.is_empty() {
        return None;
    }
    let addresses: Vec<String> = watch.logs.keys().map(|a| format!("0x{}", hex(a))).collect();
    Some(json!({ "blockHash": hash, "address": addresses }))
}

async fn fetch(rpc: &Rpc, number: u64, watch: &WatchSet) -> Result<FinalBlock, RpcError> {
    let block = rpc.call("eth_getBlockByNumber", json!([quantity(number), true])).await?;
    if block.is_null() {
        return Err(RpcError::Decode(format!("{} has no block {number}", rpc.label())));
    }
    let hash = block["hash"].as_str().ok_or_else(|| RpcError::Decode("block hash".into()))?.to_string();
    let logs = match log_filter(&hash, watch) {
        Some(filter) => rpc.call("eth_getLogs", json!([filter])).await?,
        None => json!([]),
    };
    let b = FinalBlock::from_rpc(&block, &logs, watch, rpc.label())?;
    if b.number != number {
        return Err(RpcError::Decode(format!("asked for block {number}, got {}", b.number)));
    }
    Ok(b)
}
