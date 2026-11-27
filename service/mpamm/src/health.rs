//! `GET /api/health`: the service's live numbers, never on the stream
//! (served by `mpamm-api` through the source). Answers 503 when something
//! needs a human: the ring can't be opened, execution has gone quiet, or the
//! pipeline has been held for 30 s.

use std::{sync::Arc, time::Instant};

use mpamm_pipeline::{Stats, StatsView};
use mpamm_pricing::Prices;
use mpamm_ring::live::{now_ms, FollowStats, FollowView};
use serde::Serialize;

#[derive(Clone)]
pub struct Health {
    pub ring: Arc<FollowStats>,
    pub pipeline: Arc<Stats>,
    pub prices: Arc<Prices>,
    pub quotes: Arc<mpamm_quotes::Engine>,
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
    pub feeds: FeedsView,
    /// Each venue's quote time over the last minute, and its misses.
    pub quotes: std::collections::BTreeMap<String, mpamm_quotes::VenueTiming>,
    /// What a monitor pages on, active now (empty when all is well).
    pub alerts: Vec<Alert>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Alert {
    /// `node_behind`, `ring_lag`, `unrepaired_gap`, `no_final_commit`, or
    /// `venue_outage` (with `venue`).
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    pub msg: String,
}

/// No execution event for this long: the node has stopped executing.
pub const NODE_QUIET_MS: u64 = 2_000;
/// Events the reader may trail the writer by before the ring's history
/// (2^21 descriptors) is at risk.
pub const RING_LAG_EVENTS: u64 = 500_000;
/// No final block committed for this long (blocks finalize every ~400 ms).
pub const NO_COMMIT_MS: u64 = 3_000;

/// The active alerts (docs/rebuild-plan.md → M14): pure, for the tests.
pub fn alerts(
    ring: &FollowView,
    pipeline: &StatsView,
    quotes: &std::collections::BTreeMap<String, mpamm_quotes::VenueTiming>,
    uptime_ms: u64,
    now: u64,
) -> Vec<Alert> {
    let mut out = Vec::new();
    let mut add = |code, venue: Option<String>, msg: String| out.push(Alert { code, venue, msg });
    if ring.ring_open && ring.last_event_age_ms.is_some_and(|a| a > NODE_QUIET_MS) {
        add("node_behind", None, format!("no execution event for {} ms", ring.last_event_age_ms.unwrap_or(0)));
    }
    if ring.lag_events > RING_LAG_EVENTS {
        add("ring_lag", None, format!("the reader trails the ring by {} events", ring.lag_events));
    }
    if let Some(h) = pipeline.held.as_deref().filter(|h| h.starts_with("read block")) {
        add("unrepaired_gap", None, h.to_string());
    }
    let since_commit = now.saturating_sub(pipeline.last_commit_unix_ms);
    if uptime_ms > 30_000 && (pipeline.last_commit_unix_ms == 0 || since_commit > NO_COMMIT_MS) {
        add("no_final_commit", None, format!("no final block committed for {} ms", since_commit));
    }
    for (venue, t) in quotes {
        if t.published == 0 && t.failed + t.late + t.busy > 0 {
            let why = t.last_error.clone().unwrap_or_else(|| format!("{} late, {} busy", t.late, t.busy));
            add("venue_outage", Some(venue.clone()), format!("no quote published in the last minute: {why}"));
        }
    }
    out
}

/// Each exchange's last message age, and how many registered pairs have a
/// reference right now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsView {
    pub bybit_age_ms: Option<u64>,
    pub binance_age_ms: Option<u64>,
    pub kraken_age_ms: Option<u64>,
    pub pairs_priced: usize,
    pub pairs: usize,
}

fn feeds_view(p: &Prices, now: u64) -> FeedsView {
    let age = |ms: u64| (ms > 0).then(|| now.saturating_sub(ms));
    let r = p.reference();
    FeedsView {
        bybit_age_ms: age(p.feeds.bybit.last_msg_ms()),
        binance_age_ms: age(p.feeds.binance.last_msg_ms()),
        kraken_age_ms: age(p.feeds.kraken.last_msg_ms()),
        pairs_priced: p.registry.pairs.iter().filter(|x| r.mid_for_pair(&x.symbol) > 0.0).count(),
        pairs: p.registry.pairs.len(),
    }
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

/// The body, and whether the service is healthy (false answers 503).
pub fn body(h: &Health) -> (HealthBody, bool) {
    let ring = h.ring.view();
    let pipeline = h.pipeline.view();
    let uptime_ms = h.started.elapsed().as_millis() as u64;
    let (status, ok) = status(&ring, &pipeline, uptime_ms, h.stall_ms, now_ms());
    let lag = (pipeline.cursor > 0 && ring.newest_block > 0).then(|| ring.newest_block.saturating_sub(pipeline.cursor));
    let feeds = feeds_view(&h.prices, now_ms());
    let quotes = h.quotes.timings().into_iter().collect();
    let alerts = alerts(&ring, &pipeline, &quotes, uptime_ms, now_ms());
    (HealthBody { status, uptime_s: uptime_ms / 1000, lag_blocks: lag, ring, pipeline, feeds, quotes, alerts }, ok)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use mpamm_quotes::VenueTiming;

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
    fn alerts_name_what_a_monitor_pages_on() {
        let now = 1_000_000;
        let quiet = BTreeMap::new();
        assert!(alerts(&ring(true, Some(50)), &pipe(now - 400, None), &quiet, 60_000, now).is_empty(), "all well");
        let codes = |a: Vec<Alert>| a.into_iter().map(|a| a.code).collect::<Vec<_>>();
        let mut r = ring(true, Some(5_000));
        r.lag_events = 600_000;
        let held = pipe(now - 10_000, Some("read block 9 over RPC (Unresolved): rpc error"));
        assert_eq!(
            codes(alerts(&r, &held, &quiet, 60_000, now)),
            ["node_behind", "ring_lag", "unrepaired_gap", "no_final_commit"]
        );
        assert!(alerts(&ring(true, Some(5)), &pipe(0, None), &quiet, 10_000, now).is_empty(), "booting: no commit yet");
        let mut q = BTreeMap::new();
        q.insert(
            "hanji".to_string(),
            VenueTiming { failed: 150, last_error: Some("boom".into()), ..VenueTiming::default() },
        );
        q.insert("poe".to_string(), VenueTiming { published: 150, failed: 3, ..VenueTiming::default() });
        let a = alerts(&ring(true, Some(5)), &pipe(now - 400, None), &q, 60_000, now);
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].code, a[0].venue.as_deref()), ("venue_outage", Some("hanji")));
        assert!(a[0].msg.contains("boom"));
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
