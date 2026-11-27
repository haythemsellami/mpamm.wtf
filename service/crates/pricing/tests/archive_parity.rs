//! The Rust archives answer as server/src/history/cex.ts does for the same
//! inputs (`archive-golden.json`, written by `server/scripts/archive-golden.ts`):
//! every registered pair's mid from archives over two windows (one across
//! midnight) with outages and gaps past each staleness cap, a closed day's
//! asset price for a Binance and a Bybit asset, and the BBO-mid curve of a
//! recorded Bybit archive's head (`fixtures/bybit-MONUSDT-2026-11-26-head.zip`).
//!
//! The golden's inputs are written into a cache directory, and the archives
//! point at an address nothing listens on: anything not served from the cache
//! fails the test instead of reaching an exchange.

use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use mpamm_pricing::archives::{bybit, cache, Answer, ArchiveConfig, Archives, Interval, Points};
use mpamm_registry::Registry;
use mpamm_types::utc_day;
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("archive-golden.json")).unwrap()
}

/// A golden number: fractions are written as JavaScript's text (a JSON
/// number parser may be a unit in the last place off), integers as numbers.
fn opt(v: &Value) -> Option<f64> {
    match v {
        Value::String(s) => Some(s.parse().expect("a number's text")),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn num(v: &Value) -> f64 {
    opt(v).expect("a number")
}

fn same(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * a.abs().max(b.abs())
}

/// The golden's inputs as the Rust cache holds them.
fn cache_dir(g: &Value, tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mpamm-archive-parity-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for (sym, days) in g["bybit"].as_object().unwrap() {
        for (day, pts) in days.as_object().unwrap() {
            let mut p = Points::default();
            for row in pts.as_array().unwrap() {
                p.push(row[0].as_f64().unwrap(), opt(&row[1]).unwrap_or(f64::NAN));
            }
            cache::write(&cache::bybit_path(&dir, sym, day), &p).unwrap();
        }
    }
    let days: Vec<String> = ["2026-09-28", "2026-09-29", "2026-09-30"].map(String::from).to_vec();
    for (key, rows) in g["binance"].as_object().unwrap() {
        let (sym, iv) = key.split_once('|').unwrap();
        let interval = if iv == "1s" { Interval::S1 } else { Interval::M1 };
        let mut by_day: BTreeMap<String, Points> = days.iter().map(|d| (d.clone(), Points::default())).collect();
        for row in rows.as_array().unwrap() {
            let open = row[0].as_i64().unwrap();
            let p = by_day.entry(utc_day(open as f64)).or_default();
            p.push((open + interval.ms() - 1) as f64, num(&row[1]));
        }
        for (day, p) in by_day {
            cache::write(&cache::binance_path(&dir, sym, interval, &day), &p).unwrap();
        }
    }
    // Every other leg a pair reads, empty: never fetched.
    for sym in ["BTCUSDT", "ETHUSDT", "XAUTUSDT", "WBTCBTC", "USDCUSDT"] {
        for iv in [Interval::S1, Interval::M1] {
            for day in &days {
                let path = cache::binance_path(&dir, sym, iv, day);
                if !path.exists() {
                    cache::write(&path, &Points::default()).unwrap();
                }
            }
        }
    }
    dir
}

fn offline(dir: &std::path::Path) -> std::sync::Arc<Archives> {
    let mut cfg = ArchiveConfig::new(dir);
    cfg.bybit_url = "http://127.0.0.1:9".into();
    cfg.binance_url = "http://127.0.0.1:9".into();
    cfg.attempts = 1;
    cfg.pace = Duration::ZERO;
    Archives::new(Registry::get(), cfg)
}

#[tokio::test]
async fn pair_mids_from_archives_match_today() {
    let g = golden();
    let dir = cache_dir(&g, "pairs");
    let a = offline(&dir);
    let now = 1_790_640_000_000 + 5 * 86_400_000; // every day final
    let windows: Vec<(f64, f64)> =
        g["windows"].as_array().unwrap().iter().map(|w| (w[0].as_f64().unwrap(), w[1].as_f64().unwrap())).collect();
    let times: Vec<Vec<f64>> = g["times"]
        .as_array()
        .unwrap()
        .iter()
        .map(|ts| ts.as_array().unwrap().iter().map(|t| t.as_f64().unwrap()).collect())
        .collect();
    let (mut priced, mut nulls, mut pairs) = (0, 0, 0);
    for p in g["pairs"].as_array().unwrap() {
        let market = p["market"].as_str().unwrap();
        let w = p["window"].as_u64().unwrap() as usize;
        let (from, to) = windows[w];
        let answer = a.pair_mids(market, from, to, now).await.unwrap();
        let Some(want) = p["mids"].as_array() else {
            assert!(matches!(answer, Answer::Unsupported), "{market}: today has no archive for it");
            continue;
        };
        let Answer::Ready(s) = answer else { panic!("{market} window {w}: {answer:?}") };
        pairs += 1;
        for (t, want) in times[w].iter().zip(want) {
            match (s.at(*t), opt(want)) {
                (Some(got), Some(want)) => {
                    assert!(same(got, want), "{market} at {t}: {got} vs today's {want}");
                    priced += 1;
                }
                (None, None) => nulls += 1,
                (got, want) => panic!("{market} at {t}: {got:?} vs today's {want:?}"),
            }
        }
    }
    assert_eq!(pairs, 52);
    assert!(priced > 2_000 && nulls > 300, "the golden exercises both: {priced} priced, {nulls} null");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_closed_days_asset_prices_match_today() {
    let g = golden();
    let dir = cache_dir(&g, "days");
    let a = offline(&dir);
    let now = 1_790_640_000_000 + 5 * 86_400_000;
    for d in g["assetDays"].as_array().unwrap() {
        let (asset, day) = (d["asset"].as_str().unwrap(), d["day"].as_str().unwrap());
        let px = a.asset_usd_day(asset, day, now).await.unwrap().unwrap();
        for row in d["at"].as_array().unwrap() {
            let (t, want) = (num(&row[0]), num(&row[1]));
            assert!(same(px.at(t), want), "{asset} {day} at {t}: {} vs today's {want}", px.at(t));
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_recorded_archive_replays_to_todays_curve() {
    let g = golden();
    let zip = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/bybit-MONUSDT-2026-11-26-head.zip"))
        .unwrap();
    let day_start = 1_795_651_200_000; // 2026-11-26
    let p = bybit::replay_zip(&zip, "MONUSDT", "2026-11-26", day_start).unwrap();
    let want_ts: Vec<f64> = g["book"]["ts"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let want_px: Vec<Option<f64>> = g["book"]["px"].as_array().unwrap().iter().map(opt).collect();
    assert_eq!(p.ts, want_ts);
    let got: Vec<Option<f64>> = p.px.iter().map(|x| (!x.is_nan()).then_some(*x)).collect();
    assert_eq!(got, want_px, "bit for bit");
    assert!(p.len() > 100 && p.ts[0] >= day_start as f64);
    // And the first minute of the day's reference for MON in USDT terms.
    assert!((p.px[0] - 0.011).abs() < 0.001, "MON traded near $0.011 that day: {}", p.px[0]);
}
