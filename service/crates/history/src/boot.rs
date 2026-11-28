//! A boot's repairs, as the service and `mpamm-tools repair` run them: read
//! the store, resolve operator replays, plan, mark what is adopted or
//! refused, then run the jobs in order.

use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

use mpamm_core::Venue;
use mpamm_store::writer::Writer;
use mpamm_types::utc_day;

use crate::{
    exec::{Executor, Sink},
    plan::{parse_resets, plan, Plan, Planned, Reset, Start, VenueHistory},
    pool::ArchivePool,
};

pub struct Prepared {
    pub plan: Plan,
    /// The trades table's first complete day.
    pub trades_from: String,
    /// The committed venue state replays start from.
    pub committed: HashMap<(String, String), String>,
}

/// Plans the repairs of a database whose last earlier-build block is known,
/// and marks what today's service already applied (or what can never run).
pub async fn prepare(
    writer: &Writer,
    pool: &ArchivePool,
    venues: &[Arc<dyn Venue>],
    resets: &str,
    today: &str,
    now_ms: i64,
    sink: &dyn Sink,
) -> Result<Prepared, String> {
    let t = today.to_string();
    let (trades_from, marks, v1, committed) = writer
        .run(move |s| Ok((s.trades_from(&t)?, s.history_marks()?, s.meta_under("v1:")?, s.all_venue_state()?)))
        .await
        .map_err(|e| format!("store: {e}"))?;
    let applied: HashSet<(String, String)> = marks.into_iter().collect();
    let v1: HashMap<String, String> = v1.into_iter().collect();

    // Operator replays: a block start replays its whole day.
    let (entries, bad) = parse_resets(resets);
    for b in bad {
        sink.note(true, "history.invalid", "service", &b);
    }
    let mut parsed = Vec::new();
    for e in entries {
        let from = match e.from {
            None => None,
            Some(Start::Day(d)) => Some(d),
            Some(Start::Block(n)) => match pool.timestamps(&[n]).await {
                Ok(ts) => Some(utc_day(ts[0] as f64 * 1000.0)),
                Err(err) => {
                    sink.note(
                        true,
                        "history.held",
                        &e.venue,
                        &format!("operator replay {:?}: block {n}: {err}", e.entry),
                    );
                    continue;
                }
            },
        };
        parsed.push(Reset { entry: e.entry, venue: e.venue, from });
    }

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
        &parsed,
        today,
        &trades_from,
        |v, s| applied.contains(&(v.to_string(), s.to_string())),
        |k| v1.get(k).cloned(),
    );
    let marks: Vec<(String, String)> =
        p.adopt.iter().cloned().chain(p.refused.iter().map(|(v, s, _)| (v.clone(), s.clone()))).collect();
    if !marks.is_empty() {
        writer
            .run(move |s| {
                for (v, spec) in &marks {
                    s.mark_history(v, spec, now_ms)?;
                }
                Ok(())
            })
            .await
            .map_err(|e| format!("marking adopted repairs: {e}"))?;
    }
    for (v, _, why) in &p.refused {
        sink.note(false, "history.refused", v, why);
    }
    for why in &p.waiting {
        sink.note(false, "history.waiting", "service", why);
    }
    for why in &p.invalid {
        sink.note(true, "history.invalid", "service", why);
    }
    Ok(Prepared { plan: p, trades_from, committed })
}

/// Runs the jobs in order. With `retry` (first pause, longest) a failing job
/// holds and is retried at its cursor; without, the first failure ends the
/// run.
pub async fn run_jobs(
    exec: &Executor,
    jobs: &[Planned],
    b0: u64,
    retry: Option<(Duration, Duration)>,
) -> Result<(), String> {
    let stats = &exec.stats;
    stats.jobs_left.store(jobs.len() as u64, Ordering::Relaxed);
    for job in jobs {
        let mut pause = retry.map(|r| r.0).unwrap_or_default();
        loop {
            match exec.run(job, b0).await {
                Ok(()) => break,
                Err(e) => {
                    *stats.last_error.lock() = Some(format!("{} {}: {e}", job.venue, job.what));
                    let Some((_, max)) = retry else {
                        return Err(format!("{} {}: {e}", job.venue, job.what));
                    };
                    exec.sink.note(true, "history.held", &job.venue, &format!("{}: {e}; retrying", job.what));
                    tokio::time::sleep(pause).await;
                    pause = (pause * 2).min(max);
                }
            }
        }
        *stats.last_error.lock() = None;
        stats.jobs_done.fetch_add(1, Ordering::Relaxed);
        stats.jobs_left.fetch_sub(1, Ordering::Relaxed);
    }
    *stats.current.lock() = None;
    Ok(())
}
