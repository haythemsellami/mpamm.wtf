//! Every venue's repair definitions read exactly as today's markers, so a
//! database migrated from today's service adopts what it already applied
//! instead of applying it again. `ts-specs.json` is what today's code writes
//! (`revisionTargets` over `ADAPTERS`, with each `backfillFromUtc`); refresh
//! it with `npm -w server run history:specs` whenever a revision is added on
//! either side.

use std::collections::BTreeMap;

use mpamm_history::plan::revision_spec;
use serde_json::Value;

#[test]
fn every_revision_spec_and_first_day_matches_todays() {
    let ts: BTreeMap<String, Value> = serde_json::from_str(include_str!("ts-specs.json")).unwrap();
    let venues = mpamm_venues::all();
    assert_eq!(venues.len(), ts.len(), "the same venues on both sides");
    for v in &venues {
        let vid = v.id();
        let want = &ts[vid];
        assert_eq!(v.history_from_utc(), want["fromUtc"].as_str(), "{vid}: first day of history");
        let got: Vec<String> = v
            .history_revisions()
            .iter()
            .map(|r| format!("history_revision_{vid}_{}={}", r.id, revision_spec(vid, r).unwrap()))
            .collect();
        let want: Vec<String> =
            want["specs"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
        assert_eq!(got, want, "{vid}: revisions");
    }
}

/// A database migrated from today's service (every revision's marker and
/// every finished lifetime in `v1:`) runs nothing: all of it is adopted.
#[test]
fn a_migrated_database_adopts_every_repair_and_runs_none() {
    let ts: BTreeMap<String, Value> = serde_json::from_str(include_str!("ts-specs.json")).unwrap();
    let mut v1: BTreeMap<String, String> = BTreeMap::new();
    for (vid, v) in &ts {
        if v["fromUtc"].is_string() {
            v1.insert(format!("backfill_done_{vid}"), "1".into());
        }
        for s in v["specs"].as_array().unwrap() {
            let (k, spec) = s.as_str().unwrap().split_once('=').unwrap();
            v1.insert(k.to_string(), spec.to_string());
        }
    }
    let venues: Vec<mpamm_history::VenueHistory> = mpamm_venues::all()
        .iter()
        .map(|v| mpamm_history::VenueHistory {
            id: v.id().to_string(),
            revisions: v.history_revisions(),
            from_utc: v.history_from_utc().map(str::to_string),
        })
        .collect();
    let p = mpamm_history::plan(&venues, &[], "2026-11-28", "2026-10-27", |_, _| false, |k| v1.get(k).cloned());
    assert!(p.jobs.is_empty(), "{:?}", p.jobs);
    assert!(p.invalid.is_empty() && p.refused.is_empty(), "{p:?}");
    let revisions: usize = ts.values().map(|v| v["specs"].as_array().unwrap().len()).sum();
    let lifetimes = ts.values().filter(|v| v["fromUtc"].is_string()).count();
    assert_eq!(p.adopt.len(), revisions + lifetimes);
}
