//! History repairs in the service (mpamm-history): planned once per boot,
//! after the first block is known, then run one job at a time beside the
//! live pipeline.
//!
//! `b0` is the last block an earlier build committed: the boot cursor, or on
//! a database with none yet, the block before the first one committed. A job
//! keeps the `b0` it was first planned with across restarts.
//!
//! A job that fails (an archive down, prices not published, a venue that
//! can't decode) holds: it is retried at its cursor with a growing pause and
//! raises one `history.held` note per distinct cause. Jobs run in plan order;
//! nothing later starts while one holds, so a venue's repairs keep theirs.

use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

use mpamm_chain::Rpc;
use mpamm_history::{
    exec::{Executor, Sink, Stats},
    plan::{parse_resets, plan, Reset, Start, VenueHistory},
    ArchivePool,
};
use mpamm_pricing::{
    archives::{closed_day::ClosedDayPrices, Archives},
    Prices,
};
use mpamm_registry::Registry;
use mpamm_store::{history::DayOutcome, writer::Writer};
use mpamm_types::{utc_day, NoteLevel};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::{notes::NoteBuffer, source::ServiceSource};

/// First pause after a failed attempt, and the longest.
const RETRY_MIN: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(600);

/// What `/api/health` shows of the repairs.
#[derive(Clone)]
pub struct HistoryHealth {
    pub stats: Arc<Stats>,
    pub pool: Arc<ArchivePool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryView {
    pub jobs_left: u64,
    pub jobs_done: u64,
    pub days_written: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<CurrentView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub archive: Vec<NodeView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentView {
    pub venue: String,
    pub what: String,
    pub day: String,
    pub cursor: Option<u64>,
    pub b0: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub label: String,
    pub ok: u64,
    pub failed: u64,
    pub head: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl HistoryHealth {
    pub fn view(&self) -> HistoryView {
        let s = &self.stats;
        HistoryView {
            jobs_left: s.jobs_left.load(Ordering::Relaxed),
            jobs_done: s.jobs_done.load(Ordering::Relaxed),
            days_written: s.days_written.load(Ordering::Relaxed),
            current: s.current.lock().clone().map(|p| CurrentView {
                venue: p.venue,
                what: p.what,
                day: p.day,
                cursor: p.cursor,
                b0: p.b0,
            }),
            last_error: s.last_error.lock().clone(),
            archive: self
                .pool
                .stats()
                .into_iter()
                .map(|n| NodeView {
                    label: n.label,
                    ok: n.ok,
                    failed: n.failed,
                    head: n.head,
                    last_error: n.last_error,
                })
                .collect(),
        }
    }
}

/// The repairs' notes and written days, into the service.
pub struct ServiceSink {
    pub notes: Arc<NoteBuffer>,
    pub source: Arc<ServiceSource>,
    /// Trades a repair inserted, for their markouts.
    pub inserted: mpsc::UnboundedSender<Vec<String>>,
}

fn now_ms() -> f64 {
    mpamm_ring::live::now_ms() as f64
}

impl Sink for ServiceSink {
    fn note(&self, warn: bool, code: &str, venue: &str, msg: &str) {
        // Logged at info so the notes layer doesn't raise it a second time.
        tracing::info!(target: "history", "{venue}: {msg}");
        let level = if warn { NoteLevel::Warn } else { NoteLevel::Info };
        self.notes.note(now_ms(), level, code, Some(venue), msg);
    }

    fn written(&self, venue: &str, day: &str, o: &DayOutcome) {
        tracing::info!(
            target: "history",
            "{venue} {day}: ${:.2}/{} → ${:.2}/{}{}",
            o.before.usd,
            o.before.swaps,
            o.after.usd,
            o.after.swaps,
            if o.through_trades { format!(" ({} new, {} gone)", o.inserted.len(), o.removed) } else { String::new() }
        );
        self.source.volume_changed();
        if !o.inserted.is_empty() {
            let _ = self.inserted.send(o.inserted.clone());
        }
    }
}

pub struct Inputs {
    pub pool: Arc<ArchivePool>,
    pub writer: Writer,
    pub registry: &'static Registry,
    pub prices: Arc<Prices>,
    pub archives: Arc<Archives>,
    pub rpc_url: String,
    pub resets: String,
    /// The boot cursor, or `None` on a database with none yet.
    pub boot_cursor: Option<u64>,
    /// The first block committed this boot (for a database with no cursor).
    pub first_commit: tokio::sync::broadcast::Receiver<mpamm_pipeline::Committed>,
    pub stats: Arc<Stats>,
    pub sink: Arc<dyn Sink>,
}

/// Plans and runs this boot's repairs; returns when every job is done.
pub async fn run(mut i: Inputs) {
    let b0 = match i.boot_cursor {
        Some(c) => c,
        None => loop {
            match i.first_commit.recv().await {
                Ok(c) => break c.number.saturating_sub(1),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        },
    };
    let today = utc_day(now_ms());
    let w = i.writer.clone();
    let t = today.clone();
    let read =
        w.run(move |s| Ok((s.trades_from(&t)?, s.history_marks()?, s.meta_under("v1:")?, s.all_venue_state()?))).await;
    let (trades_from, marks, v1, committed) = match read {
        Ok(r) => r,
        Err(e) => {
            i.sink.note(true, "history.held", "service", &format!("repairs not planned: store: {e}"));
            return;
        }
    };
    let applied: HashSet<(String, String)> = marks.into_iter().collect();
    let v1: HashMap<String, String> = v1.into_iter().collect();

    // Operator replays: a block start replays its whole day.
    let (entries, bad) = parse_resets(&i.resets);
    for b in bad {
        i.sink.note(true, "history.invalid", "service", &b);
    }
    let mut resets = Vec::new();
    for e in entries {
        let from = match e.from {
            None => None,
            Some(Start::Day(d)) => Some(d),
            Some(Start::Block(n)) => match i.pool.timestamps(&[n]).await {
                Ok(ts) => Some(utc_day(ts[0] as f64 * 1000.0)),
                Err(err) => {
                    i.sink.note(
                        true,
                        "history.held",
                        &e.venue,
                        &format!("operator replay {:?}: block {n}: {err}", e.entry),
                    );
                    continue;
                }
            },
        };
        resets.push(Reset { entry: e.entry, venue: e.venue, from });
    }

    let venues = mpamm_venues::all();
    let histories: Vec<VenueHistory> = venues
        .iter()
        .map(|v| VenueHistory {
            id: v.id().to_string(),
            revisions: v.history_revisions(),
            from_utc: v.history_from_utc().map(str::to_string),
        })
        .collect();
    let p = plan(
        &histories,
        &resets,
        &today,
        &trades_from,
        |v, s| applied.contains(&(v.to_string(), s.to_string())),
        |k| v1.get(k).cloned(),
    );

    let now = now_ms() as i64;
    let marks: Vec<(String, String)> =
        p.adopt.iter().cloned().chain(p.refused.iter().map(|(v, s, _)| (v.clone(), s.clone()))).collect();
    if !marks.is_empty() {
        let m = marks.clone();
        if let Err(e) = w
            .run(move |s| {
                for (v, spec) in &m {
                    s.mark_history(v, spec, now)?;
                }
                Ok(())
            })
            .await
        {
            i.sink.note(true, "history.held", "service", &format!("marking adopted repairs: {e}"));
            return;
        }
    }
    if !p.adopt.is_empty() {
        tracing::info!(target: "history", "{} repair(s) today's service already applied, adopted", p.adopt.len());
    }
    for (v, _, why) in &p.refused {
        i.sink.note(false, "history.refused", v, why);
    }
    for why in &p.waiting {
        i.sink.note(false, "history.waiting", "service", why);
    }
    for why in &p.invalid {
        i.sink.note(true, "history.invalid", "service", why);
    }
    i.stats.jobs_left.store(p.jobs.len() as u64, Ordering::Relaxed);
    tracing::info!(
        target: "history",
        "b0 {b0}; trades stored from {trades_from}; {} repair(s) to run{}",
        p.jobs.len(),
        p.jobs.iter().map(|j| format!(" [{} {}]", j.venue, j.what)).collect::<String>()
    );
    if p.jobs.is_empty() {
        return;
    }
    if i.pool.is_empty() {
        i.sink.note(
            true,
            "history.held",
            "service",
            &format!("{} repair(s) wait for an archive RPC URL (MPAMM_ARCHIVE_RPC_URL)", p.jobs.len()),
        );
        return;
    }

    let exec = Executor {
        pool: i.pool.clone(),
        writer: i.writer.clone(),
        registry: i.registry,
        closed: Arc::new(ClosedDayPrices::new(i.registry, i.archives.clone())),
        prices: i.prices.clone(),
        local: Rpc::new("local", i.rpc_url.clone(), Duration::from_secs(10)),
        venues,
        committed,
        trades_from,
        sink: i.sink.clone(),
        stats: i.stats.clone(),
        now_ms: || mpamm_ring::live::now_ms() as i64,
    };
    for job in &p.jobs {
        let mut pause = RETRY_MIN;
        loop {
            match exec.run(job, b0).await {
                Ok(()) => break,
                Err(e) => {
                    *i.stats.last_error.lock() = Some(format!("{} {}: {e}", job.venue, job.what));
                    i.sink.note(true, "history.held", &job.venue, &format!("{}: {e}; retrying", job.what));
                    tokio::time::sleep(pause).await;
                    pause = (pause * 2).min(RETRY_MAX);
                }
            }
        }
        *i.stats.last_error.lock() = None;
        i.stats.jobs_done.fetch_add(1, Ordering::Relaxed);
        i.stats.jobs_left.fetch_sub(1, Ordering::Relaxed);
    }
    *i.stats.current.lock() = None;
}

/// Marks the trades repairs insert, from the exchanges' archives.
pub async fn mark_inserted(
    archives: Arc<Archives>,
    writer: Writer,
    mut rx: mpsc::UnboundedReceiver<Vec<String>>,
    source: Arc<ServiceSource>,
) {
    while let Some(ids) = rx.recv().await {
        let read = writer
            .run(move |s| {
                let mut out = Vec::new();
                for id in &ids {
                    if let Some(f) = s.trade(id)? {
                        out.push(f);
                    }
                }
                Ok(out)
            })
            .await;
        let trades = match read {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(target: "history", "markouts for repaired trades: store: {e}");
                continue;
            }
        };
        match crate::marks::settle(&archives, &writer, &trades, now_ms()).await {
            Ok((report, changed)) => {
                if !changed.is_empty() {
                    source.on_markouts(&changed);
                }
                tracing::info!(
                    target: "history",
                    "markouts for {} repaired trade(s): {} settled, {} marked",
                    report.read,
                    report.settled,
                    report.marked
                );
            }
            Err(e) => tracing::warn!(target: "history", "markouts for repaired trades: {e}"),
        }
    }
}
