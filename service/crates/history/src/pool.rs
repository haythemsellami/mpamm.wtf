//! The archive pool: the hosted archive nodes, in order of preference, for
//! the history the local node no longer holds (it keeps blocks only from its
//! last state sync on).
//!
//! The limits come from probing the devcore archives (2026-11-28): one
//! `eth_getLogs` spans at most 1,000 blocks; batched `eth_getLogs` is refused
//! by the rate limiter while batched block reads are fine; the primary
//! refuses about 8 requests in flight; an overloaded node answers "error
//! getting block header from triedb and archive", the same text as a block it
//! really lacks. Under load every answer that came back was correct: errors
//! are loud. So a range is one request, a few are in flight, and every error
//! is retried on the next node and then after a pause. Nothing is skipped:
//! after `rounds` the read fails and the caller holds its cursor.
//!
//! A node that is reachable but frozen (dca-001 stood still for three days
//! from 2026-10-29) answers an empty log list for blocks past its head, so a
//! node serves a range only once its head has reached the range's end.

use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use mpamm_chain::{parse_quantity, quantity, Rpc, RpcError};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Blocks per `eth_getLogs` (the archives refuse more than 1,000).
    pub chunk: u64,
    /// Requests in flight across the pool.
    pub concurrency: usize,
    /// Passes over every node before a read fails.
    pub rounds: u32,
    /// Pause after a pass in which no node answered; doubles each pass.
    pub pause: Duration,
    /// Blocks per batched `eth_getBlockByNumber`.
    pub batch: usize,
    /// How long a node's head is trusted before it is asked again.
    pub head_ttl: Duration,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            chunk: 1000,
            concurrency: 4,
            rounds: 4,
            pause: Duration::from_secs(2),
            batch: 25,
            head_ttl: Duration::from_secs(10),
        }
    }
}

/// Every node failed for every pass: what each said last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolError(pub String);

impl std::fmt::Display for PoolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "archive pool: {}", self.0)
    }
}

impl std::error::Error for PoolError {}

struct Node {
    rpc: Rpc,
    head: Mutex<Option<(u64, Instant)>>,
    ok: AtomicU64,
    failed: AtomicU64,
    last_error: Mutex<Option<String>>,
}

/// One node's counters, for the health endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeStats {
    pub label: String,
    pub ok: u64,
    pub failed: u64,
    pub head: Option<u64>,
    pub last_error: Option<String>,
}

pub struct ArchivePool {
    nodes: Vec<Node>,
    permits: Semaphore,
    cfg: PoolConfig,
}

/// Logs of one range and the node that answered.
#[derive(Debug, Clone)]
pub struct Logs {
    pub logs: Vec<Value>,
    pub node: String,
}

impl ArchivePool {
    pub fn new(nodes: Vec<Rpc>, cfg: PoolConfig) -> Self {
        let nodes = nodes
            .into_iter()
            .map(|rpc| Node {
                rpc,
                head: Mutex::new(None),
                ok: AtomicU64::new(0),
                failed: AtomicU64::new(0),
                last_error: Mutex::new(None),
            })
            .collect();
        Self { nodes, permits: Semaphore::new(cfg.concurrency.max(1)), cfg }
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn config(&self) -> &PoolConfig {
        &self.cfg
    }

    pub fn stats(&self) -> Vec<NodeStats> {
        self.nodes
            .iter()
            .map(|n| NodeStats {
                label: n.rpc.label().to_string(),
                ok: n.ok.load(Ordering::Relaxed),
                failed: n.failed.load(Ordering::Relaxed),
                head: n.head.lock().map(|(h, _)| h),
                last_error: n.last_error.lock().clone(),
            })
            .collect()
    }

    /// The node's head, asked again once stale or short of `needed`.
    async fn head(&self, node: &Node, needed: u64) -> Result<u64, RpcError> {
        if let Some((h, at)) = *node.head.lock() {
            if h >= needed && at.elapsed() < self.cfg.head_ttl {
                return Ok(h);
            }
        }
        let h = node.rpc.block_number().await?;
        *node.head.lock() = Some((h, Instant::now()));
        Ok(h)
    }

    /// Tries every node in order, `rounds` times with growing pauses, until
    /// one answers `read` with `Ok`. A node whose head is short of `to` is
    /// passed over for this read.
    async fn first<T, F, Fut>(&self, what: &str, to: u64, mut read: F) -> Result<(T, String), PoolError>
    where
        F: FnMut(Rpc) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        if self.nodes.is_empty() {
            return Err(PoolError(format!("{what}: no archive node configured")));
        }
        let mut last: Vec<String> = Vec::new();
        for round in 0..self.cfg.rounds.max(1) {
            last.clear();
            for node in &self.nodes {
                let label = node.rpc.label().to_string();
                let outcome = {
                    let _permit = self.permits.acquire().await.expect("pool semaphore never closes");
                    match self.head(node, to).await {
                        Err(e) => Err(format!("head: {e}")),
                        Ok(h) if h < to => Err(format!("its head {h} is short of block {to}")),
                        Ok(_) => read(node.rpc.clone()).await,
                    }
                };
                match outcome {
                    Ok(v) => {
                        node.ok.fetch_add(1, Ordering::Relaxed);
                        return Ok((v, label));
                    }
                    Err(e) => {
                        node.failed.fetch_add(1, Ordering::Relaxed);
                        *node.last_error.lock() = Some(e.clone());
                        last.push(format!("{label}: {e}"));
                    }
                }
            }
            if round + 1 < self.cfg.rounds {
                tokio::time::sleep(self.cfg.pause * 2u32.pow(round)).await;
            }
        }
        Err(PoolError(format!("{what}: {}", last.join("; "))))
    }

    /// The logs of `from..=to` (at most `chunk` blocks) from these addresses,
    /// every log checked to lie in the range.
    pub async fn logs(&self, from: u64, to: u64, addresses: &[String]) -> Result<Logs, PoolError> {
        assert!(to >= from && to - from < self.cfg.chunk, "a range is at most `chunk` blocks");
        let filter = json!([{ "fromBlock": quantity(from), "toBlock": quantity(to), "address": addresses }]);
        let what = format!("eth_getLogs {from}..={to}");
        let (logs, node) = self
            .first(&what, to, |rpc| {
                let filter = filter.clone();
                async move {
                    let v = rpc.call("eth_getLogs", filter).await.map_err(|e| e.to_string())?;
                    let Value::Array(logs) = v else { return Err("the answer is not a list".into()) };
                    for l in &logs {
                        match parse_quantity(&l["blockNumber"]) {
                            Some(n) if (from..=to).contains(&n) => {}
                            other => return Err(format!("a log of block {other:?} outside the range")),
                        }
                    }
                    Ok(logs)
                }
            })
            .await?;
        Ok(Logs { logs, node })
    }

    /// Full blocks (with transactions), in the order asked, `batch` per
    /// request. Each batch comes whole from one node.
    pub async fn blocks(&self, numbers: &[u64]) -> Result<Vec<Value>, PoolError> {
        let mut out = Vec::with_capacity(numbers.len());
        for chunk in numbers.chunks(self.cfg.batch.max(1)) {
            let to = chunk.iter().copied().max().unwrap_or(0);
            let what = format!("{} block(s) up to {to}", chunk.len());
            let (blocks, _) = self
                .first(&what, to, |rpc| {
                    let calls: Vec<(&str, Value)> =
                        chunk.iter().map(|n| ("eth_getBlockByNumber", json!([quantity(*n), true]))).collect();
                    async move {
                        let answers = rpc.batch(&calls).await.map_err(|e| e.to_string())?;
                        let mut blocks = Vec::with_capacity(answers.len());
                        for (n, a) in chunk.iter().zip(answers) {
                            let b = a.map_err(|e| format!("block {n}: {e}"))?;
                            if parse_quantity(&b["number"]) != Some(*n) {
                                return Err(format!("asked for block {n}, got {:?}", parse_quantity(&b["number"])));
                            }
                            blocks.push(b);
                        }
                        Ok(blocks)
                    }
                })
                .await?;
            out.extend(blocks);
        }
        Ok(out)
    }

    /// Block timestamps (seconds), in the order asked, `batch` per request.
    pub async fn timestamps(&self, numbers: &[u64]) -> Result<Vec<u64>, PoolError> {
        let mut out = Vec::with_capacity(numbers.len());
        for chunk in numbers.chunks(self.cfg.batch.max(1)) {
            let to = chunk.iter().copied().max().unwrap_or(0);
            let what = format!("{} header(s) up to {to}", chunk.len());
            let (ts, _) = self
                .first(&what, to, |rpc| async move {
                    let headers = rpc.block_headers(chunk).await.map_err(|e| e.to_string())?;
                    let mut ts = Vec::with_capacity(headers.len());
                    for (n, h) in chunk.iter().zip(headers) {
                        match h.map_err(|e| format!("block {n}: {e}"))? {
                            Some(h) if h.number == *n => ts.push(h.timestamp),
                            Some(h) => return Err(format!("asked for block {n}, got {}", h.number)),
                            None => return Err(format!("no block {n}")),
                        }
                    }
                    Ok(ts)
                })
                .await?;
            out.extend(ts);
        }
        Ok(out)
    }
}
