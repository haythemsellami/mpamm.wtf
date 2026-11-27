//! `GET /api/health`: the service's live numbers, never on the stream.
//! Answers 503 when something needs a human: the ring can't be opened,
//! execution has gone quiet, or the pipeline has been held for 30 s.

use std::{sync::Arc, time::Instant};

use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use mpamm_pipeline::{Stats, StatsView};
use mpamm_ring::live::{now_ms, FollowStats, FollowView};
use serde::Serialize;

#[derive(Clone)]
pub struct Health {
    pub ring: Arc<FollowStats>,
    pub pipeline: Arc<Stats>,
    pub started: Instant,
    pub stall_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthBody {
    pub status: &'static str,
    pub uptime_s: u64,
    /// Newest block seen executing minus the last committed final block.
    pub lag_blocks: Option<u64>,
    pub ring: FollowView,
    pub pipeline: StatsView,
}

pub fn status(
    ring: &FollowView,
    pipeline: &StatsView,
    uptime_ms: u64,
    stall_ms: u64,
    now: u64,
) -> (&'static str, bool) {
    let since_commit = (pipeline.last_commit_unix_ms > 0).then(|| now.saturating_sub(pipeline.last_commit_unix_ms));
    if !ring.ring_open {
        return ("no_ring", false);
    }
    if ring.last_event_age_ms.is_some_and(|a| a > stall_ms) {
        return ("stalled", false);
    }
    if pipeline.held.is_some() && since_commit.is_none_or(|t| t > 30_000) && uptime_ms > 30_000 {
        return ("held", false);
    }
    if since_commit.is_none() {
        return ("starting", true);
    }
    if pipeline.held.is_some() {
        return ("holding", true);
    }
    ("ok", true)
}

async fn health(State(h): State<Health>) -> (StatusCode, Json<HealthBody>) {
    let ring = h.ring.view();
    let pipeline = h.pipeline.view();
    let uptime_ms = h.started.elapsed().as_millis() as u64;
    let (status, ok) = status(&ring, &pipeline, uptime_ms, h.stall_ms, now_ms());
    let lag = (pipeline.cursor > 0 && ring.newest_block > 0).then(|| ring.newest_block.saturating_sub(pipeline.cursor));
    let body = HealthBody { status, uptime_s: uptime_ms / 1000, lag_blocks: lag, ring, pipeline };
    (if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }, Json(body))
}

pub fn router(h: Health) -> Router {
    Router::new().route("/api/health", get(health)).with_state(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(open: bool, age: Option<u64>) -> FollowView {
        FollowView {
            ring_open: open,
            events: 1,
            gaps: 0,
            expired: 0,
            reopens: 0,
            stalls: 0,
            lag_events: 0,
            last_event_age_ms: age,
            newest_block: 10,
        }
    }

    fn pipe(last_commit: u64, held: Option<&str>) -> StatsView {
        StatsView {
            cursor: 9,
            last_commit_unix_ms: last_commit,
            from_ring: 1,
            from_rpc: 0,
            trades: 0,
            holds: 0,
            held: held.map(String::from),
        }
    }

    #[test]
    fn statuses() {
        let now = 1_000_000;
        assert_eq!(status(&ring(true, Some(5)), &pipe(now - 300, None), 60_000, 5_000, now), ("ok", true));
        assert_eq!(status(&ring(false, None), &pipe(0, None), 1_000, 5_000, now), ("no_ring", false));
        assert_eq!(status(&ring(true, Some(9_000)), &pipe(now - 300, None), 60_000, 5_000, now), ("stalled", false));
        assert_eq!(status(&ring(true, Some(5)), &pipe(0, None), 1_000, 5_000, now), ("starting", true));
        assert_eq!(status(&ring(true, Some(5)), &pipe(now - 2_000, Some("x")), 60_000, 5_000, now), ("holding", true));
        assert_eq!(status(&ring(true, Some(5)), &pipe(now - 40_000, Some("x")), 60_000, 5_000, now), ("held", false));
    }
}
