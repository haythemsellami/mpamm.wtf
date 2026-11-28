//! The Rust aggregations answer exactly as server/src/analytics.ts and
//! server/src/markout-curves.ts do: `golden.json` holds today's TypeScript
//! answers over a synthetic window built to reach every tie, cut, route and
//! rounding case (server/src/analytics-golden.ts; regenerate it with
//! `npm -w server run analytics:golden`).
//!
//! Strings, counts, order and every rounded number must match exactly. The
//! leaderboard's unrounded sums and percentiles may differ by 1e-12
//! relative: the port does the same float operations in the same order, so
//! today they match bit for bit, and the test reports any that don't.

use std::{collections::HashSet, sync::OnceLock};

use indexmap::IndexMap;
use mpamm_analytics::{compute_leaderboard, compute_markout_curves, curve_points, js, route_of, CurveRow, LbRow};
use mpamm_types::{Fill, Side};
use serde_json::Value;

fn golden() -> &'static Value {
    static G: OnceLock<Value> = OnceLock::new();
    G.get_or_init(|| serde_json::from_str(include_str!("golden.json")).expect("golden.json parses"))
}

fn fills() -> Vec<Fill> {
    serde_json::from_value(golden()["fills"].clone()).expect("golden fills are Fills")
}

fn curves() -> Vec<Option<Vec<Option<f64>>>> {
    serde_json::from_value(golden()["curves"].clone()).expect("golden curves")
}

fn now() -> f64 {
    golden()["now"].as_f64().unwrap()
}

fn days() -> u32 {
    golden()["days"].as_u64().unwrap() as u32
}

/// Integer fields: exact even where floats get the tolerance.
const COUNTS: [&str; 5] = ["swaps", "totalFills", "fills", "days", "blockNumber"];

#[derive(Default)]
struct Diff {
    errors: Vec<String>,
    /// Floats within the tolerance but not bit-identical.
    inexact: Vec<String>,
}

impl Diff {
    fn check(self, what: &str) {
        if !self.inexact.is_empty() {
            eprintln!(
                "{what}: {} float(s) within 1e-12 but not identical, e.g. {}",
                self.inexact.len(),
                self.inexact[0]
            );
        }
        let shown: Vec<&String> = self.errors.iter().take(20).collect();
        assert!(self.errors.is_empty(), "{what}: {} difference(s) from TypeScript:\n{shown:#?}", self.errors.len());
    }
}

fn compare(path: &str, got: &Value, want: &Value, exact: bool, d: &mut Diff) {
    match (got, want) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            if a == b {
                return;
            }
            let exact = exact || COUNTS.iter().any(|k| path.ends_with(&format!(".{k}")));
            if !exact && (a - b).abs() <= 1e-12 * a.abs().max(b.abs()) {
                d.inexact.push(format!("{path}: {a:?} vs {b:?}"));
            } else {
                d.errors.push(format!("{path}: got {a:?}, TypeScript {b:?}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let (ka, kb): (HashSet<&String>, HashSet<&String>) = (a.keys().collect(), b.keys().collect());
            if ka != kb {
                d.errors.push(format!("{path}: keys {:?} only here, {:?} only in TypeScript", &ka - &kb, &kb - &ka));
            }
            for (k, v) in a {
                if let Some(w) = b.get(k) {
                    compare(&format!("{path}.{k}"), v, w, exact, d);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                d.errors.push(format!("{path}: {} items, TypeScript {}", a.len(), b.len()));
            }
            for (i, (v, w)) in a.iter().zip(b).enumerate() {
                compare(&format!("{path}[{i}]"), v, w, exact, d);
            }
        }
        _ if got == want => {}
        _ => d.errors.push(format!("{path}: got {got}, TypeScript {want}")),
    }
}

/// The ids the leaderboard asked `full_fills` for, and the rows it got back
/// (the in-memory source's answer: every fill with one of the ids).
fn leaderboard_of(rows: &[LbRow], days: u32, all: &[Fill]) -> (Value, Vec<String>) {
    let mut asked = Vec::new();
    let lb = compute_leaderboard(rows, days, now(), |ids| {
        asked.extend_from_slice(ids);
        let want: HashSet<&String> = ids.iter().collect();
        all.iter().filter(|f| want.contains(&f.id)).cloned().collect()
    });
    (serde_json::to_value(lb).unwrap(), asked)
}

#[test]
fn leaderboard_matches_typescript() {
    let all = fills();
    let rows: Vec<LbRow> = all.iter().filter(|f| !f.px_approx).map(LbRow::from).collect();
    assert!(rows.len() > 2000 && rows.len() < all.len(), "the window has pxApprox fills to leave out");
    let (got, asked) = leaderboard_of(&rows, days(), &all);
    let want = &golden()["leaderboard"];

    let mut d = Diff::default();
    for k in ["days", "generatedAt", "totalFills", "groups"] {
        compare(k, &got[k], &want[k], false, &mut d);
    }
    // The feeds are input rows, copied: exact.
    for k in ["topSwaps", "outliers"] {
        compare(k, &got[k], &want[k], true, &mut d);
    }
    d.check("leaderboard");
    let unique: HashSet<&String> = asked.iter().collect();
    assert_eq!(unique.len(), asked.len(), "full_fills is asked for each id once");
}

#[test]
fn markout_curves_match_typescript() {
    let rows: Vec<CurveRow> = fills().iter().zip(curves()).map(|(f, c)| CurveRow::from_fill(f, c)).collect();
    let got = serde_json::to_value(compute_markout_curves(&rows, days(), now())).unwrap();
    let mut d = Diff::default();
    compare("markoutCurves", &got, &golden()["markoutCurves"], true, &mut d);
    d.check("markout curves");
}

#[test]
fn routes_match_typescript() {
    let all = fills();
    let rows: Vec<CurveRow> = all.iter().map(|f| CurveRow::from_fill(f, None)).collect();
    let mut by_tx: IndexMap<&str, Vec<&CurveRow>> = IndexMap::new();
    for r in &rows {
        by_tx.entry(r.tx_hash.as_str()).or_default().push(r);
    }
    let got: Vec<Value> = by_tx
        .iter()
        .filter(|(_, legs)| legs.len() > 1)
        .map(|(tx, legs)| serde_json::json!([tx, route_of(legs.iter().map(|r| r.leg()))]))
        .collect();
    let mut d = Diff::default();
    compare("routes", &Value::Array(got), &golden()["routes"], true, &mut d);
    d.check("routes");
}

#[test]
fn curve_points_match_typescript() {
    for (n, case) in golden()["curvePoints"].as_array().unwrap().iter().enumerate() {
        let side: Side = serde_json::from_value(case["side"].clone()).unwrap();
        let mids = case["mids"].as_array().unwrap();
        let mut asked = 0;
        let points = curve_points(case["ts"].as_f64().unwrap(), side, case["execPx"].as_f64().unwrap(), |t| {
            let [at, mid] = mids[asked].as_array().unwrap().as_slice() else { panic!("a mark is [t, mid]") };
            assert_eq!(t, at.as_f64().unwrap(), "case {n}: mark {asked} asked at another time");
            asked += 1;
            mid.as_f64()
        });
        assert_eq!(asked, mids.len(), "case {n}: every mark asked for");
        let mut d = Diff::default();
        compare(&format!("curvePoints[{n}]"), &serde_json::to_value(points).unwrap(), &case["points"], true, &mut d);
        d.check("curve points");
    }
}

#[test]
fn math_round_matches_typescript() {
    for pair in golden()["mathRound"].as_array().unwrap() {
        let (x, want) = (pair[0].as_f64().unwrap(), pair[1].as_f64().unwrap());
        assert_eq!(js::round(x), want, "Math.round({x:?})");
    }
}

#[test]
fn empty_windows_match_typescript() {
    let (got, asked) = leaderboard_of(&[], 1, &[]);
    assert!(asked.is_empty());
    let mut d = Diff::default();
    compare("empty.leaderboard", &got, &golden()["empty"]["leaderboard"], true, &mut d);
    let curves = serde_json::to_value(compute_markout_curves(&[], 1, now())).unwrap();
    compare("empty.markoutCurves", &curves, &golden()["empty"]["markoutCurves"], true, &mut d);
    d.check("empty windows");
}
