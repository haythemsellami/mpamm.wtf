//! The quote engine (docs/rebuild-spec.md → Quote engine): when a proposed
//! block finishes executing, every venue quotes it, with every read pinned
//! to that block's hash, against a reference frozen at the job's start. Each
//! venue is published the moment it finishes; a venue gets a deadline per
//! block and at most one job in flight, so a slow venue is late only for
//! itself. The exchange benchmark rows are taken at the job's start.

pub mod frame;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use mpamm_chain::Rpc;
use mpamm_core::{BlockRef, QuoteCx, Venue};
use mpamm_pricing::Prices;
use mpamm_registry::Registry;
use mpamm_types::QuoteRow;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tokio::sync::broadcast;

pub use frame::FramePricer;

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// Each venue row's realized cost against the exchange-as-taker row at the
/// same market and size, positive = on-chain executes worse (today's
/// annotateCex).
pub fn annotate_cex(venue_rows: &mut [QuoteRow], cex_rows: &[QuoteRow]) {
    let cex: HashMap<(&str, u64), &QuoteRow> =
        cex_rows.iter().map(|b| ((b.market.as_str(), b.size_usd.to_bits()), b)).collect();
    for r in venue_rows {
        let Some(b) = cex.get(&(r.market.as_str(), r.size_usd.to_bits())) else { continue };
        if b.ask_px <= 0.0 || b.bid_px <= 0.0 {
            continue;
        }
        if r.ask_px > 0.0 {
            r.cex_ask_bps = Some((r.ask_px / b.ask_px - 1.0) * 1e4);
        }
        if r.bid_px > 0.0 {
            r.cex_bid_bps = Some((b.bid_px / r.bid_px - 1.0) * 1e4);
        }
    }
}

/// One venue's rows for one block, as published.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueQuote {
    pub venue: String,
    pub block: u64,
    #[serde(skip)]
    pub block_ref: BlockRef,
    pub proposal_ms: f64,
    pub started_ms: f64,
    pub done_ms: f64,
    pub rows: Vec<QuoteRow>,
    /// Every job is announced, a missed one with no rows, so a frame waiting
    /// on the venue need not wait out the deadline.
    pub outcome: Outcome,
}

/// How a venue's job for a block ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Published,
    /// Missed the deadline.
    Late,
    /// Still busy with an earlier block: skipped this one.
    Busy,
    Failed,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueTiming {
    pub p50_ms: Option<f64>,
    pub p90_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub published: usize,
    pub late: usize,
    pub busy: usize,
    pub failed: usize,
    pub last_error: Option<String>,
}

/// A venue's latest row for one market and size: the row, its block number
/// and id, and when it was published (ms).
pub type BoardEntry = (QuoteRow, u64, [u8; 32], f64);

/// The latest rows of every venue: (market, size bits) → venue → entry.
#[derive(Debug, Default)]
pub struct Board {
    pub rows: HashMap<(String, u64), HashMap<String, BoardEntry>>,
    pub newest_block: u64,
}

/// Per venue, the last minute of (when, ms, outcome).
type Timings = HashMap<String, VecDeque<(Instant, f64, Outcome)>>;

impl Board {
    fn put(&mut self, q: &VenueQuote) {
        self.newest_block = self.newest_block.max(q.block);
        for r in &q.rows {
            self.rows
                .entry((r.market.clone(), r.size_usd.to_bits()))
                .or_default()
                .insert(q.venue.clone(), (r.clone(), q.block, q.block_ref.id, q.done_ms));
        }
    }

    /// Every venue's latest rows for (market, size), with their block.
    pub fn snapshot(&self, market: &str, size: f64) -> Vec<(QuoteRow, u64)> {
        let mut v: Vec<(QuoteRow, u64)> = self
            .rows
            .get(&(market.to_string(), size.to_bits()))
            .map(|m| m.values().map(|(r, b, _, _)| (r.clone(), *b)).collect())
            .unwrap_or_default();
        v.sort_by(|a, b| a.0.venue_id.cmp(&b.0.venue_id));
        v
    }
}

pub struct Engine {
    pub venues: Vec<Arc<dyn Venue>>,
    pub rpc: Rpc,
    pub prices: Arc<Prices>,
    pub registry: &'static Registry,
    pub sizes: Vec<f64>,
    pub deadline: Duration,
    pub board: RwLock<Board>,
    pub published: broadcast::Sender<Arc<VenueQuote>>,
    in_flight: Mutex<HashSet<String>>,
    timings: Mutex<Timings>,
    last_error: Mutex<HashMap<String, String>>,
}

const TIMING_WINDOW: Duration = Duration::from_secs(60);

impl Engine {
    pub fn new(
        venues: Vec<Arc<dyn Venue>>,
        rpc: Rpc,
        prices: Arc<Prices>,
        registry: &'static Registry,
        deadline: Duration,
    ) -> Arc<Self> {
        let (published, _) = broadcast::channel(4096);
        Arc::new(Self {
            venues,
            rpc,
            prices,
            registry,
            sizes: registry.sizes_usd.clone(),
            deadline,
            board: RwLock::new(Board::default()),
            published,
            in_flight: Mutex::new(HashSet::new()),
            timings: Mutex::new(HashMap::new()),
            last_error: Mutex::new(HashMap::new()),
        })
    }

    fn record(&self, venue: &str, ms: f64, outcome: Outcome) {
        let mut t = self.timings.lock();
        let q = t.entry(venue.to_string()).or_default();
        let now = Instant::now();
        q.push_back((now, ms, outcome));
        while q.front().is_some_and(|(at, _, _)| now.duration_since(*at) > TIMING_WINDOW) {
            q.pop_front();
        }
    }

    fn publish(&self, q: VenueQuote) {
        if q.outcome == Outcome::Published {
            self.board.write().put(&q);
        }
        let _ = self.published.send(Arc::new(q));
    }

    /// Announces a job that published nothing.
    fn missed(&self, venue: String, block: BlockRef, proposal_ms: f64, started_ms: f64, outcome: Outcome) {
        self.publish(VenueQuote {
            venue,
            block: block.number,
            block_ref: block,
            proposal_ms,
            started_ms,
            done_ms: now_ms(),
            rows: Vec::new(),
            outcome,
        });
    }

    /// The ids of the venues quoted on every block (the exchanges' ids come
    /// with their rows).
    pub fn venue_ids(&self) -> Vec<String> {
        self.venues.iter().map(|v| v.id().to_string()).collect()
    }

    /// Starts the quote job for a block that just finished executing.
    pub fn on_executed(self: &Arc<Self>, block: BlockRef, proposal_ns: u128) {
        let started = now_ms();
        let proposal_ms = proposal_ns as f64 / 1e6;
        let frame = Arc::new(FramePricer::capture(&self.prices, self.registry));
        let cex_rows = Arc::new(self.prices.reference().quote(&self.sizes, None, &self.prices.fees, started));
        // The exchange benchmarks, one message per exchange.
        let mut by_cex: HashMap<String, Vec<QuoteRow>> = HashMap::new();
        for r in cex_rows.iter() {
            by_cex.entry(r.venue_id.clone()).or_default().push(r.clone());
        }
        for (venue, rows) in by_cex {
            self.publish(VenueQuote {
                venue,
                block: block.number,
                block_ref: block,
                proposal_ms,
                started_ms: started,
                done_ms: now_ms(),
                rows,
                outcome: Outcome::Published,
            });
        }
        for v in &self.venues {
            let id = v.id().to_string();
            if !self.in_flight.lock().insert(id.clone()) {
                self.record(&id, 0.0, Outcome::Busy);
                self.missed(id, block, proposal_ms, started, Outcome::Busy);
                continue;
            }
            let (me, v, frame, cex_rows) = (self.clone(), v.clone(), frame.clone(), cex_rows.clone());
            tokio::spawn(async move {
                let t0 = Instant::now();
                let cx = QuoteCx { rpc: &me.rpc, registry: me.registry, pricer: &*frame, block };
                let r = tokio::time::timeout(me.deadline, v.quote(&cx, &me.sizes)).await;
                // A dropped (timed-out) job is cancelled: the slot frees now.
                me.in_flight.lock().remove(&id);
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                match r {
                    Ok(Ok(mut rows)) => {
                        rows.retain(|row| me.registry.pair_of(&row.market).is_some());
                        annotate_cex(&mut rows, &cex_rows);
                        me.record(&id, ms, Outcome::Published);
                        me.publish(VenueQuote {
                            venue: id,
                            block: block.number,
                            block_ref: block,
                            proposal_ms,
                            started_ms: started,
                            done_ms: now_ms(),
                            rows,
                            outcome: Outcome::Published,
                        });
                    }
                    Ok(Err(e)) => {
                        me.record(&id, ms, Outcome::Failed);
                        me.last_error.lock().insert(id.clone(), e.to_string());
                        me.missed(id, block, proposal_ms, started, Outcome::Failed);
                    }
                    Err(_) => {
                        me.record(&id, ms, Outcome::Late);
                        me.missed(id, block, proposal_ms, started, Outcome::Late);
                    }
                }
            });
        }
    }

    /// Per-venue timings over the last minute, for the health endpoint.
    pub fn timings(&self) -> HashMap<String, VenueTiming> {
        let t = self.timings.lock();
        let errs = self.last_error.lock();
        t.iter()
            .map(|(venue, q)| {
                let mut ms: Vec<f64> =
                    q.iter().filter(|(_, _, o)| *o == Outcome::Published).map(|(_, m, _)| *m).collect();
                ms.sort_by(|a, b| a.total_cmp(b));
                let pct = |p: f64| {
                    (!ms.is_empty()).then(|| ms[((ms.len() as f64 * p).ceil() as usize).clamp(1, ms.len()) - 1])
                };
                let count = |o: Outcome| q.iter().filter(|(_, _, x)| *x == o).count();
                (
                    venue.clone(),
                    VenueTiming {
                        p50_ms: pct(0.5),
                        p90_ms: pct(0.9),
                        p99_ms: pct(0.99),
                        published: count(Outcome::Published),
                        late: count(Outcome::Late),
                        busy: count(Outcome::Busy),
                        failed: count(Outcome::Failed),
                        last_error: errs.get(venue).cloned(),
                    },
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;
