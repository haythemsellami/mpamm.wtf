//! The depth curves against today's: `depth-golden.json` holds today's
//! `depthSizes` at several sample counts and `buildDepthSnapshot` over a set
//! of quote matrices (floors, caps, partial fills, one-sided books, holes,
//! duplicate rows, other markets, venue order), written by
//! `server/scripts/depth-golden.ts`. Every value must match exactly.

use mpamm_quotes::depth::{build_snapshot, depth_sizes};
use mpamm_types::{DepthSnapshot, QuoteRow};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Grid {
    samples: usize,
    sizes: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    rows: Vec<Value>,
    market: String,
    sizes: Vec<f64>,
    ref_mid: f64,
    as_of_block: u64,
    ts: f64,
    snapshot: DepthSnapshot,
}

#[derive(Deserialize)]
struct Golden {
    grids: Vec<Grid>,
    cases: Vec<Case>,
}

fn golden() -> Golden {
    serde_json::from_str(include_str!("depth-golden.json")).expect("golden parses")
}

/// JSON has no infinity: the generator writes it as the string "Infinity".
fn row(mut v: Value) -> QuoteRow {
    let mut inf = Vec::new();
    for k in ["bidBps", "askBps"] {
        if v[k] == "Infinity" {
            v[k] = Value::from(0.0);
            inf.push(k);
        }
    }
    let mut r: QuoteRow = serde_json::from_value(v).expect("row parses");
    for k in inf {
        *(if k == "bidBps" { &mut r.bid_bps } else { &mut r.ask_bps }) = f64::INFINITY;
    }
    r
}

#[test]
fn the_grid_is_todays_at_every_sample_count() {
    for g in golden().grids {
        assert_eq!(depth_sizes(g.samples), g.sizes, "{} samples", g.samples);
    }
}

#[test]
fn every_curve_is_todays() {
    let cases = golden().cases;
    assert!(cases.len() >= 10);
    for c in cases {
        let rows: Vec<QuoteRow> = c.rows.into_iter().map(row).collect();
        let got = build_snapshot(&rows, &c.market, &c.sizes, c.ref_mid, c.as_of_block, c.ts);
        assert_eq!(got, c.snapshot, "{}", c.name);
    }
}
