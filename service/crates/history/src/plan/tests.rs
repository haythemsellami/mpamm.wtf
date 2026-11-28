use std::collections::{HashMap, HashSet};

use mpamm_core::{HistoryRevision, RevisionSource};

use super::*;

const TODAY: &str = "2026-11-28";
const TRADES_FROM: &str = "2026-10-27";

fn rev(id: &'static str, from: Option<&'static str>, source: RevisionSource) -> HistoryRevision {
    HistoryRevision { id, from, source }
}

fn venue(id: &str, from_utc: Option<&str>, revisions: Vec<HistoryRevision>) -> VenueHistory {
    VenueHistory { id: id.into(), revisions, from_utc: from_utc.map(str::to_string) }
}

struct World {
    applied: HashSet<(String, String)>,
    v1: HashMap<String, String>,
}

impl World {
    fn new() -> Self {
        Self { applied: HashSet::new(), v1: HashMap::new() }
    }
    /// A venue whose lifetime today's service finished.
    fn backfilled(mut self, vid: &str) -> Self {
        self.v1.insert(format!("backfill_done_{vid}"), "1".into());
        self
    }
    fn plan(&self, venues: &[VenueHistory], resets: &[Reset]) -> Plan {
        plan(
            venues,
            resets,
            TODAY,
            TRADES_FROM,
            |v, s| self.applied.contains(&(v.to_string(), s.to_string())),
            |k| self.v1.get(k).cloned(),
        )
    }
}

const XSTOCKS: &[&str] = &["TSLAx/USDC", "SPYx/USDC", "SPYx/USDC"];

#[test]
fn specs_are_todays_marker_texts() {
    let r = rev("fill-time-usd", Some("2026-10-13"), RevisionSource::Replay);
    assert_eq!(revision_spec("btr", &r).unwrap(), "btr#fill-time-usd:2026-10-13");
    let r = rev("all", None, RevisionSource::Replay);
    assert_eq!(revision_spec("btr", &r).unwrap(), "btr#all:lifetime");
    let r = rev("replay-0921-midnight", Some("2026-09-17"), RevisionSource::Fills { until: "2026-09-20" });
    assert_eq!(revision_spec("hanji", &r).unwrap(), "hanji#replay-0921-midnight:fills:2026-09-17..2026-09-20");
    // Markets sorted and unique, as today sorts them.
    let r = rev("x", Some("2026-11-08"), RevisionSource::Markets(XSTOCKS));
    assert_eq!(revision_spec("hanji", &r).unwrap(), "hanji#x:markets:2026-11-08:SPYx/USDC,TSLAx/USDC");
    let r = rev("m", None, RevisionSource::Markets(XSTOCKS));
    assert!(revision_spec("hanji", &r).is_err());
}

#[test]
fn a_migrated_database_adopts_what_today_applied_and_runs_the_rest() {
    let mut w = World::new().backfilled("btr");
    w.v1.insert("history_revision_btr_fill-time-usd".into(), "btr#fill-time-usd:2026-10-13".into());
    // An applied definition that was edited since runs again.
    w.v1.insert("history_revision_btr_edited".into(), "btr#edited:2026-11-01".into());
    let v = venue(
        "btr",
        Some("2026-10-01"),
        vec![
            rev("fill-time-usd", Some("2026-10-13"), RevisionSource::Replay),
            rev("edited", Some("2026-11-02"), RevisionSource::Replay),
        ],
    );
    let p = w.plan(&[v], &[]);
    assert_eq!(
        p.adopt,
        vec![
            ("btr".to_string(), "btr#lifetime:2026-10-01".to_string()),
            ("btr".to_string(), "btr#fill-time-usd:2026-10-13".to_string())
        ]
    );
    assert_eq!(p.jobs.len(), 1);
    assert_eq!((p.jobs[0].spec.as_str(), p.jobs[0].from.as_str()), ("btr#edited:2026-11-02", "2026-11-02"));
}

#[test]
fn applied_definitions_are_not_planned_again() {
    let mut w = World::new().backfilled("btr");
    w.applied.insert(("btr".into(), "btr#a:2026-11-01".into()));
    let v = venue("btr", Some("2026-10-01"), vec![rev("a", Some("2026-11-01"), RevisionSource::Replay)]);
    assert_eq!(
        w.plan(&[v], &[]),
        Plan { adopt: vec![("btr".into(), "btr#lifetime:2026-10-01".into())], ..Plan::default() }
    );
}

#[test]
fn a_new_venues_lifetime_stands_for_its_revisions() {
    let w = World::new();
    let revs = vec![
        rev("a", Some("2026-11-01"), RevisionSource::Replay),
        rev("m", Some("2026-11-10"), RevisionSource::Markets(XSTOCKS)),
    ];
    let p = w.plan(&[venue("new", Some("2026-09-01"), revs.clone())], &[]);
    assert_eq!(p.jobs.len(), 1, "{p:?}");
    let j = &p.jobs[0];
    assert_eq!((j.kind.clone(), j.from.as_str(), j.what.as_str()), (Kind::Replay, "2026-09-01", "lifetime"));
    assert!(j.spec.starts_with("new#lifetime:2026-09-01@"));
    assert_eq!(
        j.covers,
        vec!["new#a:2026-11-01", "new#m:markets:2026-11-10:SPYx/USDC,TSLAx/USDC", "new#lifetime:2026-09-01"]
    );
    // A build bringing another revision names the job afresh: it starts over.
    let mut more = revs;
    more.push(rev("b", Some("2026-11-20"), RevisionSource::Replay));
    let again = w.plan(&[venue("new", Some("2026-09-01"), more)], &[]);
    assert_ne!(again.jobs[0].spec, j.spec);
    // A venue with no first day has no lifetime: its revisions run.
    let p = w.plan(&[venue("quote-only", None, vec![rev("a", Some("2026-11-01"), RevisionSource::Replay)])], &[]);
    assert_eq!(p.jobs[0].what, "revision a");
}

#[test]
fn a_markets_repair_stops_where_a_pending_replay_starts() {
    let w = World::new().backfilled("v");
    let v = venue(
        "v",
        Some("2026-01-01"),
        vec![
            rev("early", Some("2026-10-01"), RevisionSource::Markets(&["A/USDC"])),
            rev("replay", Some("2026-11-01"), RevisionSource::Replay),
            rev("late", Some("2026-11-15"), RevisionSource::Markets(&["B/USDC"])),
        ],
    );
    let p = w.plan(&[v], &[]);
    let by: HashMap<&str, &Planned> = p.jobs.iter().map(|j| (j.what.as_str(), j)).collect();
    assert_eq!(p.jobs.len(), 2, "{p:?}");
    assert_eq!(by["revision early"].until.as_deref(), Some("2026-11-01"));
    assert_eq!(by["revision replay"].covers, vec!["v#late:markets:2026-11-15:B/USDC"]);
    // With no replay pending, a markets repair runs to its end.
    let w2 = World::new().backfilled("v");
    let v = venue("v", Some("2026-01-01"), vec![rev("late", Some("2026-11-15"), RevisionSource::Markets(&["B/USDC"]))]);
    assert_eq!(w2.plan(&[v], &[]).jobs[0].until, None);
}

#[test]
fn fills_revisions_need_stored_trades_and_a_closed_until() {
    let w = World::new().backfilled("h");
    let v = venue(
        "h",
        Some("2026-01-01"),
        vec![
            rev("old", Some("2026-09-17"), RevisionSource::Fills { until: "2026-09-20" }),
            rev("open", Some("2026-11-27"), RevisionSource::Fills { until: "2026-11-30" }),
            rev("ok", Some("2026-11-01"), RevisionSource::Fills { until: "2026-11-03" }),
        ],
    );
    let p = w.plan(&[v], &[]);
    assert_eq!(p.refused.len(), 1);
    assert!(p.refused[0].2.contains("older than the stored trades"));
    assert_eq!(p.waiting.len(), 1);
    assert_eq!(p.jobs.len(), 1);
    assert_eq!(p.jobs[0].kind, Kind::Fills { until: "2026-11-03".into() });
}

#[test]
fn a_repair_starting_after_today_is_refused_and_marked() {
    let w = World::new().backfilled("v");
    let v = venue("v", Some("2026-01-01"), vec![rev("future", Some("2026-12-01"), RevisionSource::Replay)]);
    let p = w.plan(&[v], &[]);
    assert!(p.jobs.is_empty());
    assert_eq!(p.refused[0].1, "v#future:2026-12-01");
}

#[test]
fn malformed_and_duplicate_ids_are_invalid() {
    let w = World::new().backfilled("v");
    let v = venue(
        "v",
        Some("2026-01-01"),
        vec![
            rev("bad id", Some("2026-11-01"), RevisionSource::Replay),
            rev("twice", Some("2026-11-01"), RevisionSource::Replay),
            rev("twice", Some("2026-11-02"), RevisionSource::Replay),
        ],
    );
    let p = w.plan(&[v], &[]);
    assert!(p.jobs.is_empty());
    assert_eq!(p.invalid.len(), 3, "{:?}", p.invalid);
}

#[test]
fn operator_replays_parse_adopt_and_run() {
    let (ok, bad) = parse_resets(" metric:2026-10-12 , thogamm:105331612@2,poe, :x, poe:yesterday ");
    assert_eq!(
        ok,
        vec![
            ResetEntry {
                entry: "metric:2026-10-12".into(),
                venue: "metric".into(),
                from: Some(Start::Day("2026-10-12".into()))
            },
            ResetEntry {
                entry: "thogamm:105331612@2".into(),
                venue: "thogamm".into(),
                from: Some(Start::Block(105_331_612))
            },
            ResetEntry { entry: "poe".into(), venue: "poe".into(), from: None },
        ]
    );
    assert_eq!(bad.len(), 2);
    let mut w = World::new().backfilled("metric").backfilled("poe");
    w.v1.insert("backfill_reset_applied_metric".into(), "metric:2026-10-12".into());
    let venues = [venue("metric", Some("2026-03-30"), vec![]), venue("poe", Some("2026-05-09"), vec![])];
    let resets = [
        Reset { entry: "metric:2026-10-12".into(), venue: "metric".into(), from: Some("2026-10-12".into()) },
        Reset { entry: "poe".into(), venue: "poe".into(), from: None },
        Reset { entry: "gone:2026-11-01".into(), venue: "gone".into(), from: Some("2026-11-01".into()) },
    ];
    let p = w.plan(&venues, &resets);
    assert!(p.adopt.contains(&("metric".into(), "metric:2026-10-12".into())));
    assert_eq!(p.jobs.len(), 1);
    assert_eq!((p.jobs[0].spec.as_str(), p.jobs[0].from.as_str()), ("poe", "2026-05-09"));
    assert_eq!(p.invalid.len(), 1);
}

#[test]
fn days_are_recognised() {
    assert!(is_day("2026-11-28"));
    assert!(!is_day("2026-11-2") && !is_day("20261128xx") && !is_day("2026/11/28"));
}
