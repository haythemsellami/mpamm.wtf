//! The trade pipeline (docs/rebuild-spec.md → When a block is final): final
//! blocks arrive from the tracker strictly in height order, as the ring's
//! copy or as a height to read over RPC. Each is decoded by every venue
//! module and committed with its cursor in one transaction, then the next.
//!
//! Fail-closed everywhere: a height that can't be read, a venue that isn't
//! ready or can't decode, or a commit that fails holds the pipeline on that
//! height and retries it. Nothing above a held height is ever committed.

pub mod attribution;
pub mod fetch;
pub mod gas;

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use arc_swap::ArcSwap;
use mpamm_core::{DecodeCx, FinalBlock, Venue, VenueError, VenueState};
use mpamm_pricing::Prices;
use mpamm_registry::Registry;
use mpamm_ring::{Block, MissingReason, WatchSet};
use mpamm_store::{writer::Writer, BlockCommit, GasAccrual, StoreError};
use mpamm_types::{Fill, TimeSource};
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
    /// Prices each block is decoded with, as of its own time.
    pub prices: Arc<Prices>,
    /// The set the reader copies with; the pipeline grows it as venues
    /// discover sources.
    pub watch: Arc<ArcSwap<WatchSet>>,
    /// Venue state: what is committed plus the block being decoded.
    pub state: Mutex<VenueState>,
    /// Blocks at or below this height may have been copied from the ring
    /// with a smaller watch set than the venues now declare: they are read
    /// over RPC with the current one instead.
    pub refetch_through: Arc<AtomicU64>,
    /// Asks for a rediscovery now: a venue that isn't ready to decode a block
    /// (a pool announced in it that discovery hasn't read yet) holds it.
    pub rediscover: Arc<tokio::sync::Notify>,
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

    /// One height, start to commit.
    pub async fn process(&self, input: Input) {
        let block = match input {
            Input::Final(b) if b.start.number <= self.refetch_through.load(Ordering::Relaxed) => {
                self.repair(b.start.number, MissingReason::Incomplete).await
            }
            Input::Final(b) => match FinalBlock::from_ring(&b) {
                Some(fb) => fb,
                // A Final block always has its headers when the tracker
                // requires them; anything else is read over RPC.
                None => self.repair(b.start.number, MissingReason::Incomplete).await,
            },
            Input::Missing { number, reason } => self.repair(number, reason).await,
        };
        let number = block.number;

        let mut block = block;
        let mut watch_used = self.watch.load_full();
        let mut hold = Hold::new(self, format!("decode block {number}"));
        let mut regrown = 0;
        let (fills, state, gas) = loop {
            match self.decode(&block) {
                // A venue can learn a new source while decoding (a pool its
                // factory announced in this very block). The watch set grows
                // now, not at the next rediscovery: this block is read again
                // with it (its copy lacks the new source's logs), and so is
                // every block the reader may already have copied.
                Ok(f) if regrown < 3 && self.grow_watch(number) => {
                    let _ = f;
                    regrown += 1;
                    watch_used = self.watch.load_full();
                    block = self.repair(number, MissingReason::Incomplete).await;
                }
                Ok(f) => break f,
                Err((e, not_ready)) => {
                    if not_ready {
                        self.rediscover.notify_one();
                    }
                    hold.failed(e).await;
                    // Discovery grew the watch set while the block was held:
                    // its copy may lack the new sources' logs, so read it again.
                    let now = self.watch.load_full();
                    if !Arc::ptr_eq(&now, &watch_used) {
                        watch_used = now;
                        block = self.repair(number, MissingReason::Incomplete).await;
                    }
                }
            }
        };
        hold.done();

        let commit = BlockCommit {
            number,
            hash: format!("0x{}", mpamm_ring::hex(&block.hash)),
            timestamp: block.timestamp,
            trades: fills.clone(),
            gas,
            state: state.clone(),
        };
        let mut hold = Hold::new(self, format!("commit block {number}"));
        let inserted = loop {
            match self.writer.commit(commit.clone()).await {
                Ok(c) => break Some(c),
                // Already stored (a resume replays from just below the cursor).
                Err(StoreError::OutOfOrder { cursor, got }) if got <= cursor => break None,
                Err(e) => hold.failed(e.to_string()).await,
            }
        };
        hold.done();
        let Some(inserted) = inserted else { return };
        self.state.lock().unwrap().apply(&state);

        match block.origin {
            mpamm_core::Origin::Ring => self.stats.from_ring.fetch_add(1, Ordering::Relaxed),
            mpamm_core::Origin::Rpc(_) => self.stats.from_rpc.fetch_add(1, Ordering::Relaxed),
        };
        let trades: Vec<Fill> = fills.into_iter().filter(|f| inserted.inserted.contains(&f.id)).collect();
        self.prices.observe(&trades);
        self.stats.trades.fetch_add(trades.len() as u64, Ordering::Relaxed);
        self.stats.cursor.store(number, Ordering::Relaxed);
        self.stats.last_commit_unix_ms.store(now_ms(), Ordering::Relaxed);
        let _ = self.committed.send(Committed { number, time_ms: block.time_ms(), trades: Arc::new(trades) });
    }

    /// Every venue's trades in the block (attributed), the state they set,
    /// and each venue's exact quote-update gas.
    /// Rebuilds the watch set from the venues; when it grew, publishes it and
    /// has every block up to well past `number` read over RPC with it (the
    /// reader runs a few blocks ahead of the pipeline).
    fn grow_watch(&self, number: u64) -> bool {
        let Ok(w) = watch_of(&self.venues) else { return false };
        if w == **self.watch.load() {
            return false;
        }
        tracing::info!(target: "pipeline", "watch set grew to {} log address(es) at block {number}", w.logs.len());
        self.watch.store(Arc::new(w));
        self.refetch_through.fetch_max(number + 64, Ordering::Relaxed);
        true
    }

    /// An error says whether a venue was only not ready (discovery pending).
    #[allow(clippy::type_complexity)]
    fn decode(
        &self,
        block: &FinalBlock,
    ) -> Result<(Vec<Fill>, Vec<(String, String, String)>, Vec<GasAccrual>), (String, bool)> {
        // Gas rules first: a venue whose gas destination isn't resolved yet
        // holds the block rather than undercount its gas.
        let rules = gas::GasRules::of(&self.venues)
            .map_err(|e| (format!("gas sources: {e}"), matches!(e, VenueError::NotReady(_))))?;
        let pricer = self.prices.at(block.time_ms());
        let state = self.state.lock().unwrap();
        let cx = DecodeCx { registry: self.registry, pricer: &pricer, state: &state };
        let mut all = Vec::new();
        for v in &self.venues {
            match v.decode(&cx, block) {
                Ok(f) => all.extend(f),
                Err(e) => {
                    // A failed attempt's writes are discarded with it.
                    state.take_pending();
                    return Err((format!("{}: {e}", v.id()), matches!(e, VenueError::NotReady(_))));
                }
            }
        }
        // Where every trade's time came from: the ring's proposal time, or
        // the block second when the block was read over RPC.
        let source = if block.proposal_ns.is_some() { TimeSource::Proposal } else { TimeSource::Block };
        for f in &mut all {
            f.ts = block.time_ms();
            f.time_source = Some(source);
        }
        static ATTRIBUTOR: std::sync::OnceLock<attribution::Attributor> = std::sync::OnceLock::new();
        ATTRIBUTOR.get_or_init(attribution::Attributor::default).attribute(
            &mut all,
            block,
            &attribution::entries(&self.venues),
        );
        Ok((all, state.take_pending(), rules.accrue(block)))
    }

    async fn repair(&self, number: u64, reason: MissingReason) -> FinalBlock {
        let watch = self.watch.load_full();
        let mut hold = Hold::new(self, format!("read block {number} over RPC ({reason:?})"));
        let block = loop {
            match self.fetcher.block(number, &watch).await {
                Ok(b) => break b,
                Err(e) => hold.failed(e.to_string()).await,
            }
        };
        hold.done();
        block
    }
}

/// A retried step: the first failure logs and counts a hold, each failure
/// backs off, success clears the held reason.
struct Hold<'a> {
    p: &'a Pipeline,
    what: String,
    delay: Duration,
    since: Option<Instant>,
}

impl<'a> Hold<'a> {
    fn new(p: &'a Pipeline, what: String) -> Self {
        Self { p, what, delay: p.retry_min, since: None }
    }

    async fn failed(&mut self, e: String) {
        if self.since.is_none() {
            self.since = Some(Instant::now());
            self.p.stats.holds.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(target: "pipeline", "{}: {e}; holding and retrying", self.what);
        }
        *self.p.stats.held.lock().unwrap() = Some(format!("{}: {e}", self.what));
        tokio::time::sleep(self.delay).await;
        self.delay = (self.delay * 2).min(self.p.retry_max);
    }

    fn done(self) {
        if let Some(t) = self.since {
            tracing::info!(target: "pipeline", "{}: recovered after {:.1}s", self.what, t.elapsed().as_secs_f64());
            *self.p.stats.held.lock().unwrap() = None;
        }
    }
}

#[cfg(test)]
mod tests;
