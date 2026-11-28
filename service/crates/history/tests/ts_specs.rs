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
