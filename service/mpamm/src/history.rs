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
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

use mpamm_chain::Rpc;
use mpamm_history::{
    boot::{prepare, run_jobs},
    exec::{Executor, Sink, Stats},
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
    /// What the job running has changed so far, for one resync at its end.
    pub changed: parking_lot::Mutex<(bool, bool)>,
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
        let mut c = self.changed.lock();
        c.0 |= day != utc_day(now_ms()) && o.before != o.after;
        c.1 |= o.through_trades;
    }

    fn done(&self, _venue: &str) {
        let (closed_days, trades) = std::mem::take(&mut *self.changed.lock());
        if closed_days || trades {
            self.source.history_changed(closed_days, trades);
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
    let venues = mpamm_venues::all();
    let prepared = match prepare(&i.writer, &i.pool, &venues, &i.resets, &today, now_ms() as i64, &*i.sink).await {
        Ok(p) => p,
        Err(e) => {
            i.sink.note(true, "history.held", "service", &format!("repairs not planned: {e}"));
            return;
        }
    };
    let p = &prepared.plan;
    if !p.adopt.is_empty() {
        tracing::info!(target: "history", "{} repair(s) today's service already applied, adopted", p.adopt.len());
    }
    tracing::info!(
        target: "history",
        "b0 {b0}; trades stored from {}; {} repair(s) to run{}",
        prepared.trades_from,
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
        committed: prepared.committed.clone(),
        trades_from: prepared.trades_from.clone(),
        sink: i.sink.clone(),
        stats: i.stats.clone(),
        now_ms: || mpamm_ring::live::now_ms() as i64,
    };
    let _ = run_jobs(&exec, &p.jobs, b0, Some((RETRY_MIN, RETRY_MAX))).await;
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
