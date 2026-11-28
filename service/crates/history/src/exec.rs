//! Running a planned repair: a venue's blocks from the job's first day to
//! its `b0`, a UTC day at a time.
//!
//! - The venue is a module instance of the repair's own, discovered at the
//!   chain's current state, so the live pipeline's decode state is never
//!   touched and every market the venue ever had is known. Its durable state
//!   starts from what is committed; what a replay learns is never written.
//! - A day's logs come from the archive pool in `chunk`-block ranges; only
//!   blocks holding a log decode can use are read in full (a block holding
//!   only gas-event logs has no trade: no venue decodes those, see
//!   docs/rebuild-venues.md → Gas). Blocks are decoded strictly in order.
//! - Each block is priced as of its own time: the exchanges' archives where
//!   they answer, else the service's prices at that time (the chain's prints,
//!   then the live price).
//! - The day goes to the store in one transaction with the job's cursor
//!   (`replace_history_day` / `add_history_day`): a failure anywhere before
//!   that writes nothing of the day, and the job resumes there.

use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::{stream, StreamExt, TryStreamExt};
use mpamm_chain::{parse_quantity, Rpc};
use mpamm_core::{ChainCx, DecodeCx, FinalBlock, Pricer, Venue, VenueError, VenueState};
use mpamm_pipeline::attribution;
use mpamm_pricing::{archives::closed_day::ClosedDayPrices, Prices};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{hex, Addr, WatchSet, B32};
use mpamm_store::{
    history::{DayOutcome, DayRepair},
    writer::Writer,
};
use mpamm_types::{utc_day, Fill, TimeSource};
use parking_lot::Mutex;
use serde_json::Value;

use crate::{
    plan::{Kind, Planned},
    pool::ArchivePool,
};

/// Where a repair reports: notes for maintainers, and each written day
/// (the dashboard reloads volume; new trades get their markouts).
pub trait Sink: Send + Sync {
    fn note(&self, warn: bool, code: &str, venue: &str, msg: &str);
    fn written(&self, venue: &str, day: &str, outcome: &DayOutcome);
    /// A job finished (after its last day and its marker): what clients hold
    /// can be reloaded now, once.
    fn done(&self, _venue: &str) {}
}

/// Live numbers for the health endpoint.
#[derive(Debug, Default)]
pub struct Stats {
    pub jobs_done: AtomicU64,
    pub jobs_left: AtomicU64,
    pub days_written: AtomicU64,
    pub current: Mutex<Option<Progress>>,
    pub last_error: Mutex<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub venue: String,
    pub what: String,
    /// The day being read.
    pub day: String,
    /// The last block written, and the job's last block.
    pub cursor: Option<u64>,
    pub b0: u64,
}

/// Decoding a block failed for good (not a read error: those retry).
const NOT_READY_RETRIES: usize = 5;

/// Midnight of a `YYYY-MM-DD` day, in seconds (days-from-civil, Hinnant).
pub fn day_start_s(day: &str) -> Option<u64> {
    let mut it = day.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400).ok()
}

pub struct Executor {
    pub pool: Arc<ArchivePool>,
    pub writer: Writer,
    pub registry: &'static Registry,
    pub closed: Arc<ClosedDayPrices>,
    pub prices: Arc<Prices>,
    /// The local node, for the repair's own venue discovery.
    pub local: Rpc,
    /// Venue instances of the repair's own (never the live pipeline's).
    pub venues: Vec<Arc<dyn Venue>>,
    /// The committed venue state a replay starts from.
    pub committed: std::collections::HashMap<(String, String), String>,
    /// The trades table's first complete day.
    pub trades_from: String,
    pub sink: Arc<dyn Sink>,
    pub stats: Arc<Stats>,
    pub now_ms: fn() -> i64,
}

/// A block's watched logs, as the archive answered them.
type BlockLogs = BTreeMap<u64, Vec<Value>>;

fn log_key(l: &Value) -> Option<(u64, Addr, Option<B32>)> {
    let n = parse_quantity(&l["blockNumber"])?;
    let a = parse_address(l["address"].as_str()?)?;
    let t0 = l["topics"].as_array()?.first().and_then(mpamm_chain::parse_b32);
    Some((n, a, t0))
}

impl Executor {
    fn venue(&self, id: &str) -> Result<Arc<dyn Venue>, String> {
        self.venues.iter().find(|v| v.id() == id).cloned().ok_or_else(|| format!("no venue {id} in this build"))
    }

    async fn discover(&self, v: &Arc<dyn Venue>) -> Result<(), String> {
        v.discover(&ChainCx { rpc: &self.local, registry: self.registry }).await.map_err(|e| e.to_string())
    }

    /// The first block at or after `ts` (seconds) in `floor..=hi`; `hi + 1`
    /// when even `hi` is earlier. The search starts a little below the
    /// target, estimated from the chain's recent block rate, rather than at
    /// `floor`, which a node holding only recent history can't read; it steps
    /// back while still too late, then interpolates over block timestamps,
    /// falling back to halving.
    async fn first_block_at(&self, ts: u64, floor: u64, hi: u64) -> Result<u64, String> {
        let at =
            |n: u64| async move { Ok::<u64, String>(self.pool.timestamps(&[n]).await.map_err(|e| e.to_string())?[0]) };
        let mut hi_ts = at(hi).await?;
        if hi_ts < ts {
            return Ok(hi + 1);
        }
        let mut hi = hi;
        let probe = hi.saturating_sub(100).max(floor);
        let rate = if probe < hi {
            let p_ts = at(probe).await?;
            (hi_ts.saturating_sub(p_ts) as f64 / (hi - probe) as f64).max(1e-3)
        } else {
            1.0
        };
        let mut span = ((hi_ts - ts) as f64 / rate * 1.05).ceil() as u64 + 16;
        let (mut lo, mut lo_ts) = loop {
            let lo = hi.saturating_sub(span).max(floor);
            let lo_ts = at(lo).await?;
            if lo_ts < ts {
                break (lo, lo_ts);
            }
            if lo == floor {
                return Ok(floor);
            }
            (hi, hi_ts) = (lo, lo_ts);
            span = span / 2 + 16;
        };
        let mut halve = false;
        while hi - lo > 1 {
            let guess = if halve || hi_ts <= lo_ts {
                lo + (hi - lo) / 2
            } else {
                let g = lo as u128 + (ts - lo_ts) as u128 * (hi - lo) as u128 / (hi_ts - lo_ts) as u128;
                (g as u64).clamp(lo + 1, hi - 1)
            };
            let width = hi - lo;
            let t = at(guess).await?;
            if t < ts {
                (lo, lo_ts) = (guess, t);
            } else {
                (hi, hi_ts) = (guess, t);
            }
            // Interpolation that didn't halve the bracket halves next time.
            halve = (hi - lo) * 2 > width;
        }
        Ok(hi)
    }

    /// Runs one job to its end, or to the first failure (the job resumes at
    /// its cursor on the next attempt). Boxed as `Send` here, where the
    /// lifetimes are concrete: left to inference, a spawned caller hits the
    /// compiler's "Send is not general enough" limitation.
    pub fn run<'a>(&'a self, job: &'a Planned, b0: u64) -> futures_util::future::BoxFuture<'a, Result<(), String>> {
        Box::pin(self.run_job(job, b0))
    }

    async fn run_job(&self, job: &Planned, b0: u64) -> Result<(), String> {
        let now = (self.now_ms)();
        if let Kind::Fills { until } = &job.kind {
            return self.resum(job, until, now).await;
        }
        let venue = self.venue(&job.venue)?;
        self.discover(&venue).await?;
        let (vid, spec, kind) = (job.venue.clone(), job.spec.clone(), job.kind.as_str().to_string());
        let stored = self
            .writer
            .run(move |s| s.start_history_job(&vid, &spec, &kind, b0, now))
            .await
            .map_err(|e| e.to_string())?;
        let first_ts = day_start_s(&job.from).ok_or_else(|| format!("{}: bad day {}", job.what, job.from))?;
        let mut end = stored.b0;
        if let Some(until) = &job.until {
            let until_ts = day_start_s(until).ok_or_else(|| format!("{}: bad day {until}", job.what))?;
            end = end.min(self.first_block_at(until_ts, 1, stored.b0).await?.saturating_sub(1));
        }
        let mut start = match stored.cursor {
            Some(c) => c + 1,
            None => self.first_block_at(first_ts, 1, stored.b0).await?,
        };
        if start <= end && stored.cursor.is_none() {
            self.sink.note(
                false,
                "history.start",
                &job.venue,
                &format!("{}: from {} to block {end}", job.what, job.from),
            );
        }
        let mut state = VenueState::new(self.committed.clone());
        let mut day_lo = start.saturating_sub(1).max(1);
        while start <= end {
            let day = utc_day(self.pool.timestamps(&[start]).await.map_err(|e| e.to_string())?[0] as f64 * 1000.0);
            let next = day_start_s(&day).expect("utc_day is a day") + 86_400;
            let day_end = (self.first_block_at(next, day_lo, end).await? - 1).min(end);
            *self.stats.current.lock() = Some(Progress {
                venue: job.venue.clone(),
                what: job.what.clone(),
                day: day.clone(),
                cursor: start.checked_sub(1),
                b0: end,
            });
            let trades = self.decode_range(&venue, &mut state, start, day_end, &job.kind).await?;
            let repair = DayRepair {
                venue_id: job.venue.clone(),
                spec: job.spec.clone(),
                day: day.clone(),
                from: start,
                to: day_end,
                trades,
            };
            let trades_from = self.trades_from.clone();
            let add = matches!(job.kind, Kind::Markets(_));
            let outcome = self
                .writer
                .run(move |s| {
                    if add {
                        s.add_history_day(&repair, &trades_from)
                    } else {
                        s.replace_history_day(&repair, &trades_from)
                    }
                })
                .await
                .map_err(|e| format!("write {day}: {e}"))?;
            self.stats.days_written.fetch_add(1, Ordering::Relaxed);
            self.sink.written(&job.venue, &day, &outcome);
            day_lo = day_end;
            start = day_end + 1;
        }
        let (vid, spec, covers) = (job.venue.clone(), job.spec.clone(), job.covers.clone());
        let done = (self.now_ms)();
        self.writer.run(move |s| s.finish_history_job(&vid, &spec, &covers, done)).await.map_err(|e| e.to_string())?;
        self.sink.note(false, "history.done", &job.venue, &format!("{}: done through block {end}", job.what));
        self.sink.done(&job.venue);
        Ok(())
    }

    async fn resum(&self, job: &Planned, until: &str, now: i64) -> Result<(), String> {
        let mut days = Vec::new();
        let (mut t, end) = (day_start_s(&job.from).ok_or("bad from day")?, day_start_s(until).ok_or("bad until day")?);
        while t < end {
            days.push(utc_day(t as f64 * 1000.0));
            t += 86_400;
        }
        let (vid, spec) = (job.venue.clone(), job.spec.clone());
        let changed =
            self.writer.run(move |s| s.resum_history_days(&vid, &days, &spec, now)).await.map_err(|e| e.to_string())?;
        let moved: Vec<String> = changed
            .iter()
            .filter(|(_, b, a)| b != a)
            .map(|(d, b, a)| format!("{d} ${:.2}/{} → ${:.2}/{}", b.usd, b.swaps, a.usd, a.swaps))
            .collect();
        self.sink.note(
            false,
            "history.done",
            &job.venue,
            &format!(
                "{}: re-summed {} day(s) from stored trades{}",
                job.what,
                changed.len(),
                if moved.is_empty() { String::new() } else { format!("; {}", moved.join(", ")) }
            ),
        );
        for (d, before, after) in changed.iter().filter(|(_, b, a)| b != a) {
            self.sink.written(&job.venue, d, &DayOutcome { before: *before, after: *after, ..DayOutcome::default() });
        }
        self.sink.done(&job.venue);
        Ok(())
    }

    /// The venue's trades in `from..=to`, decoded in block order.
    async fn decode_range(
        &self,
        venue: &Arc<dyn Venue>,
        state: &mut VenueState,
        from: u64,
        to: u64,
        kind: &Kind,
    ) -> Result<Vec<Fill>, String> {
        let watch = venue.watch().map_err(|e| e.to_string())?;
        if watch.all_logs {
            return Err(format!("{} watches every log: a replay can't read that from an archive", venue.id()));
        }
        let addresses: Vec<String> = watch.logs.keys().map(|a| format!("0x{}", hex(a))).collect();
        if addresses.is_empty() {
            return Ok(Vec::new());
        }
        let logs = self.logs(&watch, &addresses, from, to).await?;
        let gas_only: HashSet<(Addr, B32)> =
            venue.gas_sources().ok().flatten().map(|g| g.logs.into_iter().collect()).unwrap_or_default();
        let wanted: Vec<u64> = logs
            .iter()
            .filter(|(_, ls)| {
                ls.iter().any(|l| match log_key(l) {
                    Some((_, a, Some(t))) => !gas_only.contains(&(a, t)),
                    _ => true,
                })
            })
            .map(|(n, _)| *n)
            .collect();
        let batch = self.pool.config().batch.max(1);
        // Futures that own what they use: a stream of ones borrowing `self`
        // isn't provably Send inside the spawned repair task.
        let pool = self.pool.clone();
        let batches: Vec<Vec<u64>> = wanted.chunks(batch).map(<[u64]>::to_vec).collect();
        let bodies: Vec<Vec<Value>> = stream::iter(batches)
            .map(move |c| {
                let pool = pool.clone();
                async move { pool.blocks(&c).await.map_err(|e| e.to_string()) }
            })
            .buffered(self.pool.config().concurrency.max(1))
            .try_collect()
            .await?;
        let entries = attribution::entries(&self.venues);
        let attributor = attribution::Attributor::default();
        let mut out = Vec::new();
        for (n, body) in wanted.iter().zip(bodies.into_iter().flatten()) {
            let block_logs = Value::Array(logs.get(n).cloned().unwrap_or_default());
            let block =
                FinalBlock::from_rpc(&body, &block_logs, &watch, "archive").map_err(|e| format!("block {n}: {e}"))?;
            let mut fills = self.decode_block(venue, state, &block).await?;
            for f in &mut fills {
                f.ts = block.time_ms();
                f.time_source = Some(TimeSource::Block);
            }
            attributor.attribute(&mut fills, &block, &entries);
            fills.retain(|f| {
                f.venue_id == venue.id()
                    && match kind {
                        Kind::Markets(m) => m.contains(&f.market),
                        _ => true,
                    }
            });
            out.extend(fills);
        }
        Ok(out)
    }

    /// Watched logs of `from..=to`, by block, read range by range.
    async fn logs(&self, watch: &WatchSet, addresses: &[String], from: u64, to: u64) -> Result<BlockLogs, String> {
        let chunk = self.pool.config().chunk.max(1);
        let ranges: Vec<(u64, u64)> =
            (from..=to).step_by(chunk as usize).map(|s| (s, (s + chunk - 1).min(to))).collect();
        let (pool, addresses) = (self.pool.clone(), Arc::new(addresses.to_vec()));
        let answers: Vec<Vec<Value>> = stream::iter(ranges)
            .map(move |(a, b)| {
                let (pool, addresses) = (pool.clone(), addresses.clone());
                async move { pool.logs(a, b, &addresses).await.map(|l| l.logs).map_err(|e| e.to_string()) }
            })
            .buffered(self.pool.config().concurrency.max(1))
            .try_collect()
            .await?;
        let mut by_block = BlockLogs::new();
        for l in answers.into_iter().flatten() {
            let (n, a, t0) = log_key(&l).ok_or("a malformed log")?;
            if watch.wants_log(&a, t0.as_ref()) {
                by_block.entry(n).or_default().push(l);
            }
        }
        Ok(by_block)
    }

    /// One block, priced as of its time; a venue not ready yet is
    /// rediscovered and asked again.
    async fn decode_block(
        &self,
        venue: &Arc<dyn Venue>,
        state: &mut VenueState,
        block: &FinalBlock,
    ) -> Result<Vec<Fill>, String> {
        let live = self.prices.at(block.time_ms());
        // Today has no exchange archive yet: its blocks are priced as the
        // live pipeline prices a late block (the service's prices at that
        // time). A closed day waits for its archive.
        let today = utc_day(block.time_ms()) == utc_day((self.now_ms)() as f64);
        let mut tries = 0;
        loop {
            let st: &VenueState = state;
            let run = |pricer: &dyn Pricer| {
                st.take_pending();
                venue.decode(&DecodeCx { registry: self.registry, pricer, state: st }, block)
            };
            let decoded = if today {
                run(&live)
            } else {
                self.closed
                    .decode(block.time_ms(), &live as &dyn Pricer, run, |_| {})
                    .await
                    .map_err(|e| format!("block {}: prices: {e}", block.number))?
            };
            match decoded {
                Ok(fills) => {
                    let writes = state.take_pending();
                    state.apply(&writes);
                    return Ok(fills);
                }
                Err(VenueError::NotReady(e)) if tries < NOT_READY_RETRIES => {
                    tries += 1;
                    state.take_pending();
                    tracing::info!(target: "history", "block {}: {e}; rediscovering {}", block.number, venue.id());
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    self.discover(venue).await?;
                }
                Err(e) => {
                    state.take_pending();
                    return Err(format!("block {}: {e}", block.number));
                }
            }
        }
    }
}
