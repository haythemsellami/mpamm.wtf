//! Depth curves, the Execution tab's BID_ASK_DEPTH (ported from
//! server/src/depth.ts and server/src/depth/): each venue's executable spread
//! against the pair's reference mid across trade size, $100 → $1M.
//!
//! A pass is an ordinary quote job over a 25-point notional grid instead of
//! the four size pills: the venues' own `quote()`, every read pinned to one
//! block hash, against a reference frozen at the pass's start. The grid lands
//! on every pill, so at a pill the curve and the quote row are the same quote.
//!
//! As today:
//! - Demand-driven. A market is computed only while someone watches it: the
//!   first watcher starts it, the last one leaving stops it, and every viewer
//!   shares the one computation (`watch` receivers are the demand).
//! - Cadence. A pass follows each executed block; blocks arriving while one
//!   runs coalesce into the newest, and every demanded market shares a pass.
//!   An optional minimum interval between pass starts caps the rate (today's
//!   `DEPTH_MIN_INTERVAL_MS`; production runs 1 s pending a capacity check).
//! - The frame has a mid only for the markets the pass computes (today's
//!   depth frame). A venue skips a market it has no mid for, so the 25-size
//!   workload is built for those markets alone.
//! - A venue that misses the deadline or fails is missing from that pass's
//!   curves and listed in `missingVenues`; the other venues are published.
//! - A pass whose block was replaced while it ran publishes nothing.
//! - Each snapshot is serialized once; every viewer gets the same string.
//!
//! Unlike today's isolated worker, the venues are the quote engine's own
//! instances (one discovery, two independent callers of `quote()`); the only
//! state a venue keeps across quotes is log latches (Metric's outage notes).

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use mpamm_chain::Rpc;
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue};
use mpamm_pricing::Prices;
use mpamm_registry::Registry;
use mpamm_types::{DepthCurve, DepthPoint, DepthSnapshot, QuoteRow};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::{watch, Notify};

use crate::{now_ms, FramePricer};

/// The grid's span: the chart's axis is log10 over exactly these decades.
pub const DEPTH_MIN_USD: f64 = 100.0;
pub const DEPTH_DECADES: u32 = 4;
/// 4 decades × 6 steps + 1: lands exactly on every size pill ($100, $1k,
/// $10k, $100k), so the curve reconciles with the quote rows.
pub const DEPTH_SAMPLES: usize = 25;

/// The log-spaced notionals a pass quotes: ascending whole dollars, deduped
/// (a coarse grid can round two steps onto one dollar). Today's `depthSizes`.
pub fn depth_sizes(samples: usize) -> Vec<f64> {
    let n = samples.max(2);
    let mut out: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n {
        let exp = f64::from(DEPTH_DECADES) * i as f64 / (n - 1) as f64;
        let usd = (DEPTH_MIN_USD * 10f64.powf(exp)).round();
        if out.last() != Some(&usd) {
            out.push(usd);
        }
    }
    out
}

/// One market's curves from a quote matrix (today's `buildDepthSnapshot`).
///
/// Nothing here knows a venue: each leg is the venue's own walk, so its skew
/// survives, and fees stay where the venue puts them. Venues are in order of
/// first appearance in `rows` (registry order), so the legend is stable.
///
/// A curve ends where the venue stops quoting size, on facts the venue
/// reported: no row at that notional, or a partial fill (`filledFull` false).
/// A gap before the curve starts is a minimum order size, not the cap. Past
/// the cap nothing is emitted: no extrapolation, no 0-bps filler.
pub fn build_snapshot(
    rows: &[QuoteRow],
    market: &str,
    sizes: &[f64],
    ref_mid: f64,
    as_of_block: u64,
    ts: f64,
) -> DepthSnapshot {
    let mut by_key: HashMap<(&str, u64), &QuoteRow> = HashMap::new();
    let mut venue_ids: Vec<&str> = Vec::new();
    for r in rows.iter().filter(|r| r.market == market) {
        by_key.entry((r.venue_id.as_str(), r.size_usd.to_bits())).or_insert(r);
        if !venue_ids.contains(&r.venue_id.as_str()) {
            venue_ids.push(&r.venue_id);
        }
    }
    let mut ascending = sizes.to_vec();
    ascending.sort_by(f64::total_cmp);
    let venues = venue_ids
        .into_iter()
        .filter_map(|venue| {
            let mut points: Vec<DepthPoint> = Vec::new();
            for &notional in &ascending {
                let row = by_key.get(&(venue, notional.to_bits())).filter(|r| r.filled_full);
                match row.and_then(|r| sides_of(r, notional)) {
                    Some(p) => points.push(p),
                    None if !points.is_empty() => break,
                    None => {}
                }
            }
            let max_notional = points.last()?.notional;
            Some(DepthCurve { venue_id: venue.to_string(), points, max_notional })
        })
        .collect();
    DepthSnapshot {
        block_hash: None,
        revision: None,
        missing_venues: None,
        market: market.to_string(),
        as_of_block,
        ref_mid,
        ts,
        venues,
    }
}

/// A row's executable sides: a side exists when its price is positive (a
/// one-sided book leaves the other at 0) and its bps is a number. A missing
/// side is absent, never 0 bps, which would read as quoting at the mid.
fn sides_of(r: &QuoteRow, notional: f64) -> Option<DepthPoint> {
    let bid = (r.bid_px > 0.0 && r.bid_bps.is_finite()).then_some(r.bid_bps);
    let ask = (r.ask_px > 0.0 && r.ask_bps.is_finite()).then_some(r.ask_bps);
    (bid.is_some() || ask.is_some()).then_some(DepthPoint { notional, bid_bps: bid, ask_bps: ask })
}

/// One pass's result.
#[derive(Debug, Clone)]
pub struct Pass {
    /// One per requested market, in request order.
    pub snapshots: Vec<DepthSnapshot>,
    /// Start to the last venue's answer.
    pub ms: f64,
    /// Each venue that answered: its time, ms.
    pub venue_ms: Vec<(String, f64)>,
    /// Venues that missed the pass (late, failed), with the reason.
    pub missed: Vec<(String, String)>,
}

/// A venue that quotes a requested market: its markets and display ids.
struct Quoting {
    venue: Arc<dyn Venue>,
    markets: Vec<String>,
    ids: Vec<String>,
}

/// The newest executed block, and how often the tip was replaced or rolled
/// back (a pass straddling a replacement is dropped; `revision` lets clients
/// take a lower block after one).
#[derive(Debug, Default)]
struct Head {
    latest: Option<BlockRef>,
    revision: u64,
}

const STATS_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Default)]
struct Stats {
    /// (when, ms) of each published pass.
    passes: VecDeque<(Instant, f64)>,
    dropped: VecDeque<Instant>,
    missed: VecDeque<(Instant, String)>,
    last_error: BTreeMap<String, String>,
    last_block: Option<u64>,
}

impl Stats {
    fn trim(&mut self, now: Instant) {
        let old = |at: &Instant| now.duration_since(*at) > STATS_WINDOW;
        while self.passes.front().is_some_and(|(at, _)| old(at)) {
            self.passes.pop_front();
        }
        while self.dropped.front().is_some_and(old) {
            self.dropped.pop_front();
        }
        while self.missed.front().is_some_and(|(at, _)| old(at)) {
            self.missed.pop_front();
        }
    }
}

/// Depth on the health endpoint (maintainer telemetry: REST only).
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthView {
    /// Markets someone is watching now.
    pub markets: Vec<String>,
    /// Passes published over the last minute, and their duration.
    pub passes: usize,
    pub p50_ms: Option<f64>,
    pub p90_ms: Option<f64>,
    /// Passes dropped over the last minute: their block was replaced.
    pub dropped: usize,
    /// Venues that missed a pass over the last minute, with the count.
    pub missed: BTreeMap<String, usize>,
    pub last_error: BTreeMap<String, String>,
    pub last_block: Option<u64>,
}

pub struct Depth {
    venues: Vec<Arc<dyn Venue>>,
    rpc: Rpc,
    prices: Arc<Prices>,
    registry: &'static Registry,
    grid: Arc<[f64]>,
    deadline: Duration,
    /// Least time between two pass starts (zero: follow every block).
    min_interval: Duration,
    /// Per registered market, the latest snapshot (serialized); its
    /// receivers are the market's demand.
    channels: HashMap<String, watch::Sender<Option<Arc<str>>>>,
    head: Mutex<Head>,
    wake: Notify,
    stats: Mutex<Stats>,
}

impl Depth {
    /// `venues` in registry order (the curves' order); `deadline` per venue
    /// and pass (today's depth uses the quote deadline); `min_interval`
    /// between pass starts (zero follows every block).
    pub fn new(
        venues: Vec<Arc<dyn Venue>>,
        rpc: Rpc,
        prices: Arc<Prices>,
        registry: &'static Registry,
        deadline: Duration,
        min_interval: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            venues,
            rpc,
            prices,
            registry,
            grid: depth_sizes(DEPTH_SAMPLES).into(),
            deadline,
            min_interval,
            channels: registry.markets().map(|m| (m.to_string(), watch::channel(None).0)).collect(),
            head: Mutex::new(Head::default()),
            wake: Notify::new(),
            stats: Mutex::new(Stats::default()),
        })
    }

    pub fn grid(&self) -> &[f64] {
        &self.grid
    }

    /// The last snapshot of a market, if one was ever computed. A read
    /// only: it never starts a computation.
    pub fn latest(&self, market: &str) -> Option<Arc<str>> {
        self.channels.get(market).and_then(|tx| tx.borrow().clone())
    }

    /// Demand for a market: the receiver holds its latest snapshot and
    /// changes with each new one. The first receiver starts the market's
    /// passes; when the last is dropped they stop. An unregistered market
    /// gets a receiver that never changes.
    pub fn watch(&self, market: &str) -> watch::Receiver<Option<Arc<str>>> {
        let Some(tx) = self.channels.get(market) else { return watch::channel(None).1 };
        let rx = tx.subscribe();
        self.wake.notify_one();
        rx
    }

    /// Markets someone watches, in registry order.
    pub fn demanded(&self) -> Vec<String> {
        self.registry
            .markets()
            .filter(|m| self.channels.get(*m).is_some_and(|tx| tx.receiver_count() > 0))
            .map(str::to_string)
            .collect()
    }

    /// A block finished executing: the newest head. A second proposal at a
    /// height already seen, or one below it, replaces the tip.
    pub fn on_executed(&self, block: BlockRef) {
        {
            let mut h = self.head.lock();
            if let Some(prev) = h.latest {
                if prev.hash == block.hash {
                    return;
                }
                if block.number <= prev.number {
                    h.revision += 1;
                }
            }
            h.latest = Some(block);
        }
        self.wake.notify_one();
    }

    /// The scheduler: one pass at a time, at the newest head, for every
    /// demanded market not yet computed at that head. Runs for the life of
    /// the service.
    pub async fn run(self: Arc<Self>) {
        // market → the block hash it was last computed at.
        let mut served: HashMap<String, [u8; 32]> = HashMap::new();
        let mut started: Option<tokio::time::Instant> = None;
        loop {
            self.wake.notified().await;
            loop {
                // Blocks arriving while a pass waits out the interval coalesce too.
                if let Some(t) = started {
                    tokio::time::sleep_until(t + self.min_interval).await;
                }
                let Some((block, revision, markets)) = self.next_pass(&mut served) else { break };
                started = Some(tokio::time::Instant::now());
                let frame = Arc::new(FramePricer::capture(&self.prices, self.registry).only_markets(&markets));
                let wanted = |m: &str| markets.iter().any(|x| x == m);
                let reference = self.prices.reference().quote(&self.grid, Some(&wanted), &self.prices.fees, now_ms());
                let pass = self.pass(&markets, block, frame, reference).await;
                self.publish(pass, block, revision);
            }
        }
    }

    fn next_pass(&self, served: &mut HashMap<String, [u8; 32]>) -> Option<(BlockRef, u64, Vec<String>)> {
        let (block, revision) = {
            let h = self.head.lock();
            (h.latest?, h.revision)
        };
        let demanded = self.demanded();
        served.retain(|m, _| demanded.contains(m));
        let todo: Vec<String> = demanded.into_iter().filter(|m| served.get(m) != Some(&block.hash)).collect();
        if todo.is_empty() {
            return None;
        }
        for m in &todo {
            served.insert(m.clone(), block.hash);
        }
        Some((block, revision, todo))
    }

    fn publish(&self, pass: Pass, block: BlockRef, revision: u64) {
        let now = Instant::now();
        let mut stats = self.stats.lock();
        stats.trim(now);
        for (venue, why) in &pass.missed {
            stats.missed.push_back((now, venue.clone()));
            stats.last_error.insert(venue.clone(), why.clone());
        }
        if self.head.lock().revision != revision {
            stats.dropped.push_back(now);
            return;
        }
        stats.passes.push_back((now, pass.ms));
        stats.last_block = Some(block.number);
        drop(stats);
        for mut s in pass.snapshots {
            // Withdrawn while the pass ran: nobody to send it to (today's).
            let Some(tx) = self.channels.get(&s.market).filter(|tx| tx.receiver_count() > 0) else { continue };
            s.revision = (revision > 0).then_some(revision);
            match serde_json::to_string(&s) {
                Ok(json) => {
                    tx.send_replace(Some(json.into()));
                }
                Err(e) => tracing::warn!("depth snapshot for {} not serialized: {e}", s.market),
            }
        }
    }

    /// One pass at `block`: every venue covering a requested market quotes
    /// the grid (reads pinned to the block hash, a deadline each) against
    /// `frame`; `reference` is the exchanges' rows at the same grid. A
    /// venue's rows count only for its own ids and the requested markets.
    pub async fn pass(
        &self,
        markets: &[String],
        block: BlockRef,
        frame: Arc<FramePricer>,
        reference: Vec<QuoteRow>,
    ) -> Pass {
        let t0 = Instant::now();
        let wanted = |m: &str| markets.iter().any(|x| x == m);
        let quoting: Vec<Quoting> = self
            .venues
            .iter()
            .map(|v| Quoting {
                venue: v.clone(),
                markets: v.markets(),
                ids: v.meta().into_iter().map(|m| m.id).collect(),
            })
            .filter(|q| q.markets.iter().any(|m| wanted(m)))
            .collect();
        let mut jobs = tokio::task::JoinSet::new();
        for (i, q) in quoting.iter().enumerate() {
            let (v, rpc, registry, grid, frame, deadline) =
                (q.venue.clone(), self.rpc.clone(), self.registry, self.grid.clone(), frame.clone(), self.deadline);
            jobs.spawn(async move {
                let t = Instant::now();
                let cx = QuoteCx { rpc: &rpc, registry, pricer: &*frame, block };
                let r = tokio::time::timeout(deadline, v.quote(&cx, &grid)).await;
                (i, r, t.elapsed().as_secs_f64() * 1000.0)
            });
        }
        let mut answers: Vec<Option<Result<Vec<QuoteRow>, String>>> = vec![None; quoting.len()];
        let mut venue_ms = Vec::new();
        while let Some(done) = jobs.join_next().await {
            let Ok((i, r, ms)) = done else { continue };
            answers[i] = Some(match r {
                Ok(Ok(rows)) => {
                    venue_ms.push((quoting[i].venue.id().to_string(), ms));
                    Ok(rows)
                }
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err(format!("late (deadline {} ms)", self.deadline.as_millis())),
            });
        }
        // Whole milliseconds, as today's `Date.now()`.
        let ts = now_ms().floor();
        let mut rows: Vec<QuoteRow> = Vec::new();
        let mut missed = Vec::new();
        for (q, a) in quoting.iter().zip(answers) {
            match a.unwrap_or_else(|| Err("panicked".into())) {
                Ok(rs) => rows.extend(rs.into_iter().filter(|r| q.ids.contains(&r.venue_id) && wanted(&r.market))),
                Err(why) => missed.push((q.venue.id().to_string(), why)),
            }
        }
        rows.extend(reference);
        let block_hash = format!("0x{}", mpamm_ring::hex(&block.hash));
        let snapshots = markets
            .iter()
            .map(|market| {
                let mut s = build_snapshot(&rows, market, &self.grid, frame.pair_mid(market), block.number, ts);
                s.block_hash = Some(block_hash.clone());
                let present: Vec<&str> = s.venues.iter().map(|c| c.venue_id.as_str()).collect();
                let missing: Vec<String> = quoting
                    .iter()
                    .filter(|q| q.markets.contains(market))
                    .flat_map(|q| q.ids.iter())
                    .filter(|id| !present.contains(&id.as_str()))
                    .cloned()
                    .collect();
                s.missing_venues = Some(missing);
                s
            })
            .collect();
        Pass { snapshots, ms: t0.elapsed().as_secs_f64() * 1000.0, venue_ms, missed }
    }

    /// Depth for the health endpoint.
    pub fn view(&self) -> DepthView {
        let mut s = self.stats.lock();
        s.trim(Instant::now());
        let mut ms: Vec<f64> = s.passes.iter().map(|(_, m)| *m).collect();
        ms.sort_by(f64::total_cmp);
        let pct = |p: f64| (!ms.is_empty()).then(|| ms[((ms.len() as f64 * p).ceil() as usize).clamp(1, ms.len()) - 1]);
        let mut missed = BTreeMap::new();
        for (_, v) in &s.missed {
            *missed.entry(v.clone()).or_insert(0) += 1;
        }
        DepthView {
            markets: self.demanded(),
            passes: ms.len(),
            p50_ms: pct(0.5),
            p90_ms: pct(0.9),
            dropped: s.dropped.len(),
            missed,
            last_error: s.last_error.clone(),
            last_block: s.last_block,
        }
    }
}

#[cfg(test)]
mod tests;
