//! The trade pipeline (docs/rebuild-spec.md → When a block is final): final
//! blocks arrive from the tracker strictly in height order, as the ring's
//! copy or as a height to read over RPC. Each is decoded by every venue
//! module and committed with its cursor in one transaction, then the next.
//!
//! Fail-closed everywhere: a height that can't be read, a venue that isn't
//! ready or can't decode, or a commit that fails holds the pipeline on that
//! height and retries it. Nothing above a held height is ever committed.

pub mod fetch;

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use arc_swap::ArcSwap;
use mpamm_core::{DecodeCx, FinalBlock, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_ring::{Block, MissingReason, WatchSet};
use mpamm_store::{writer::Writer, BlockCommit, StoreError};
use mpamm_types::Fill;
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

pub use fetch::Fetcher;

/// What the tracker hands the pipeline, in height order.
#[derive(Debug)]
pub enum Input {
    Final(Box<Block>),
    Missing { number: u64, reason: MissingReason },
}

/// A committed block, for the stream and the markout clock.
#[derive(Debug, Clone)]
pub struct Committed {
    pub number: u64,
    pub time_ms: f64,
    /// Trades this commit inserted.
    pub trades: Arc<Vec<Fill>>,
}

/// Live numbers for the health endpoint.
#[derive(Debug, Default)]
pub struct Stats {
    pub cursor: AtomicU64,
    pub last_commit_unix_ms: AtomicU64,
    pub from_ring: AtomicU64,
    pub from_rpc: AtomicU64,
    pub trades: AtomicU64,
    pub holds: AtomicU64,
    /// Why the pipeline is held right now, if it is.
    pub held: Mutex<Option<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsView {
    pub cursor: u64,
    pub last_commit_unix_ms: u64,
    pub from_ring: u64,
    pub from_rpc: u64,
    pub trades: u64,
    pub holds: u64,
    pub held: Option<String>,
}

impl Stats {
    pub fn view(&self) -> StatsView {
        StatsView {
            cursor: self.cursor.load(Ordering::Relaxed),
            last_commit_unix_ms: self.last_commit_unix_ms.load(Ordering::Relaxed),
            from_ring: self.from_ring.load(Ordering::Relaxed),
            from_rpc: self.from_rpc.load(Ordering::Relaxed),
            trades: self.trades.load(Ordering::Relaxed),
            holds: self.holds.load(Ordering::Relaxed),
            held: self.held.lock().unwrap().clone(),
        }
    }
}

/// The watch set every venue declares, plus transaction headers (trade ids,
/// gas and attribution name transactions). Fails if any venue isn't ready.
pub fn watch_of(venues: &[Arc<dyn Venue>]) -> Result<WatchSet, VenueError> {
    let mut w = WatchSet { txn_headers: true, ..WatchSet::default() };
    for v in venues {
        w.merge(&v.watch()?);
    }
    Ok(w)
}

pub struct Pipeline {
    pub writer: Writer,
    pub venues: Vec<Arc<dyn Venue>>,
    pub fetcher: Fetcher,
    pub registry: &'static Registry,
    /// The set the reader copies with; the pipeline grows it as venues
    /// discover sources.
    pub watch: Arc<ArcSwap<WatchSet>>,
    pub stats: Arc<Stats>,
    pub committed: broadcast::Sender<Committed>,
    /// Backoff bounds for holds.
    pub retry_min: Duration,
    pub retry_max: Duration,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Pipeline {
    /// Processes inputs until the channel closes. Each height is finished
    /// (committed) before the next is looked at.
    pub async fn run(self, mut inputs: mpsc::UnboundedReceiver<Input>) {
        while let Some(input) = inputs.recv().await {
            self.process(input).await;
        }
    }

    async fn hold<T>(&self, what: &str, mut attempt: impl AsyncFnMut() -> Result<T, String>) -> T {
        let mut delay = self.retry_min;
        let mut since: Option<Instant> = None;
        loop {
            match attempt().await {
                Ok(v) => {
                    if let Some(t) = since {
                        tracing::info!(target: "pipeline", "{what}: recovered after {:.1}s", t.elapsed().as_secs_f64());
                        *self.stats.held.lock().unwrap() = None;
                    }
                    return v;
                }
                Err(e) => {
                    if since.is_none() {
                        since = Some(Instant::now());
                        self.stats.holds.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(target: "pipeline", "{what}: {e}; holding and retrying");
                    }
                    *self.stats.held.lock().unwrap() = Some(format!("{what}: {e}"));
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(self.retry_max);
                }
            }
        }
    }

    /// One height, start to commit.
    pub async fn process(&self, input: Input) {
        let block = match input {
            Input::Final(b) => match FinalBlock::from_ring(&b) {
                Some(fb) => fb,
                // A Final block always has its headers when the tracker
                // requires them; anything else is read over RPC.
                None => self.repair(b.start.number, MissingReason::Incomplete).await,
            },
            Input::Missing { number, reason } => self.repair(number, reason).await,
        };
        let number = block.number;
        let fills = self
            .hold(&format!("decode block {number}"), async || {
                let cx = DecodeCx { registry: self.registry };
                let mut all = Vec::new();
                for v in &self.venues {
                    all.extend(v.decode(&cx, &block).map_err(|e| format!("{}: {e}", v.id()))?);
                }
                Ok(all)
            })
            .await;
        let commit = BlockCommit {
            number,
            hash: format!("0x{}", mpamm_ring::hex(&block.hash)),
            timestamp: block.timestamp,
            trades: fills.clone(),
            gas: Vec::new(),
            state: Vec::new(),
        };
        let inserted = self
            .hold(&format!("commit block {number}"), async || match self.writer.commit(commit.clone()).await {
                Ok(c) => Ok(Some(c)),
                // Already stored (a resume replays from just below the cursor).
                Err(StoreError::OutOfOrder { cursor, got }) if got <= cursor => Ok(None),
                Err(e) => Err(e.to_string()),
            })
            .await;
        let Some(inserted) = inserted else { return };
        match block.origin {
            mpamm_core::Origin::Ring => self.stats.from_ring.fetch_add(1, Ordering::Relaxed),
            mpamm_core::Origin::Rpc(_) => self.stats.from_rpc.fetch_add(1, Ordering::Relaxed),
        };
        let trades: Vec<Fill> = fills.into_iter().filter(|f| inserted.inserted.contains(&f.id)).collect();
        self.stats.trades.fetch_add(trades.len() as u64, Ordering::Relaxed);
        self.stats.cursor.store(number, Ordering::Relaxed);
        self.stats.last_commit_unix_ms.store(now_ms(), Ordering::Relaxed);
        let _ = self.committed.send(Committed { number, time_ms: block.time_ms(), trades: Arc::new(trades) });
    }

    async fn repair(&self, number: u64, reason: MissingReason) -> FinalBlock {
        let watch = self.watch.load_full();
        self.hold(&format!("read block {number} over RPC ({reason:?})"), async || {
            self.fetcher.block(number, &watch).await.map_err(|e| e.to_string())
        })
        .await
    }
}

#[cfg(test)]
mod tests;
