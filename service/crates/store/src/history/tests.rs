use mpamm_types::{Fill, FillCategory, Side, TimeSource, VenueDaily, VenueGasDaily};

use super::*;
use crate::{BlockCommit, GasAccrual};

/// 2026-11-20 00:00:00 UTC, in ms.
const NOV20: f64 = 1_795_132_800_000.0;
const DAY_MS: f64 = 86_400_000.0;

fn fill(id: &str, venue: &str, usd: f64, block: u64, ts: f64) -> Fill {
    Fill {
        id: id.into(),
        venue_id: venue.into(),
        market: "MON/USDC".into(),
        side: Side::Buy,
        category: FillCategory::Direct,
        usd,
        base_amount: usd * 30.0,
        exec_px: 1.0 / 30.0,
        px_approx: false,
        tx_hash: format!("0x{id}"),
        to: "0xabc…def".into(),
        router: None,
        pool: "MON/USDC".into(),
        block_number: block,
        ts,
        markouts_bps: vec![None; 5],
        time_source: Some(TimeSource::Block),
    }
}

fn volume(s: &Store, d: &str, venue: &str) -> VenueDaily {
    s.volume_days(d)
        .unwrap()
        .into_iter()
        .find(|v| v.utc_day == d)
        .and_then(|v| v.by_venue.get(venue).copied())
        .unwrap_or_default()
}

/// Nov 20 holds three stored "hanji" trades (blocks 100–102) and a live one
/// after the repair's range (block 200), plus a POE trade and some gas.
fn seeded() -> Store {
    let mut s = Store::memory().unwrap();
    let t = NOV20 + 3_600_000.0;
    let mut a = fill("hanji-a", "hanji", 100.0, 100, t + 0.25);
    a.time_source = Some(TimeSource::Proposal);
    s.insert_trades(
        &[
            a,
            fill("hanji-b", "hanji", 50.0, 101, t),
            fill("hanji-c", "hanji", 7.0, 102, t),
            fill("hanji-live", "hanji", 1.0, 200, t + 9e6),
            fill("poe-x", "poe", 3.0, 101, t),
        ],
        |f| utc_day(f.ts),
    )
    .unwrap();
    s.set_markouts("hanji-a", &[Some(1.0), Some(2.0), None, None, None]).unwrap();
    s.set_curve("hanji-a", &[0.5, 0.6]).unwrap();
    s.commit_block(&BlockCommit {
        number: 300,
        hash: "0x01".into(),
        timestamp: (t / 1000.0) as u64,
        trades: vec![],
        gas: vec![GasAccrual { venue_id: "hanji".into(), mon: 2.0, txs: 4 }],
        state: vec![],
    })
    .unwrap();
    s
}

#[test]
fn a_job_keeps_its_first_b0_and_finishing_marks_it_applied() {
    let mut s = Store::memory().unwrap();
    let j = s.start_history_job("hanji", "hanji#x:2026-11-20", "replay", 500, 1).unwrap();
    assert_eq!((j.b0, j.cursor), (500, None));
    // Planned again by a later boot: the first b0 stands.
    assert_eq!(s.start_history_job("hanji", "hanji#x:2026-11-20", "replay", 900, 2).unwrap().b0, 500);
    assert!(!s.history_applied("hanji", "hanji#x:2026-11-20").unwrap());
    s.finish_history_job("hanji", "hanji#x:2026-11-20", &["hanji#y:2026-11-01".into()], 3).unwrap();
    assert!(s.history_job("hanji", "hanji#x:2026-11-20").unwrap().is_none());
    assert!(s.history_applied("hanji", "hanji#x:2026-11-20").unwrap());
    assert!(s.history_applied("hanji", "hanji#y:2026-11-01").unwrap(), "what it stood for too");
    s.mark_history("poe", "poe#z:lifetime", 4).unwrap();
    assert!(s.history_applied("poe", "poe#z:lifetime").unwrap());
    let mut marks = s.history_marks().unwrap();
    marks.sort();
    assert_eq!(marks.len(), 3);
    assert_eq!(marks[2], ("poe".to_string(), "poe#z:lifetime".to_string()));
    s.set_meta("v1:backfill_done_poe", "1").unwrap();
    s.set_meta("v10", "no").unwrap();
    assert_eq!(s.meta_under("v1:").unwrap(), vec![("backfill_done_poe".to_string(), "1".to_string())]);
}

#[test]
fn trades_from_is_the_oldest_trade_day_recorded_once() {
    let s = seeded();
    assert_eq!(s.trades_from("2030-01-01").unwrap(), "2026-11-20");
    let empty = Store::memory().unwrap();
    assert_eq!(empty.trades_from("2026-11-28").unwrap(), "2026-11-28");
    assert_eq!(empty.trades_from("2026-12-31").unwrap(), "2026-11-28", "recorded once");
}

#[test]
fn a_covered_day_is_replaced_through_its_trades() {
    let mut s = seeded();
    let d = utc_day(NOV20);
    s.start_history_job("hanji", "spec", "replay", 199, 0).unwrap();
    let t = NOV20 + 3_600_000.0;
    // The replay re-prices a, drops c, finds a new d; b is unchanged.
    let out = s
        .replace_history_day(
            &DayRepair {
                venue_id: "hanji".into(),
                spec: "spec".into(),
                day: d.clone(),
                from: 0,
                to: 199,
                trades: vec![
                    fill("hanji-a", "hanji", 110.0, 100, t),
                    fill("hanji-b", "hanji", 50.0, 101, t),
                    fill("hanji-d", "hanji", 20.0, 150, t),
                ],
            },
            "2026-11-01",
        )
        .unwrap();
    assert!(out.through_trades);
    assert_eq!(out.before, VenueDaily { usd: 158.0, swaps: 4 });
    assert_eq!(out.after, VenueDaily { usd: 181.0, swaps: 4 }, "a, b, d and the live trade");
    assert_eq!(out.inserted, vec!["hanji-d".to_string()]);
    assert_eq!(out.removed, 1);
    assert_eq!(volume(&s, &d, "hanji"), out.after);
    assert!(s.trade("hanji-c").unwrap().is_none());
    // a survives with the replay's numbers but its own time and markouts.
    let a = s.trade("hanji-a").unwrap().unwrap();
    assert_eq!((a.usd, a.ts, a.time_source), (110.0, t + 0.25, Some(TimeSource::Proposal)));
    assert_eq!(a.markouts_bps[..2], [Some(1.0), Some(2.0)]);
    let curves = s.trades_with_curves(NOV20, NOV20 + DAY_MS).unwrap();
    assert_eq!(curves.iter().find(|(f, _)| f.id == "hanji-a").unwrap().1, Some(vec![Some(0.5), Some(0.6)]));
    // Other venues, the live trade after the range, gas and the cursor stand.
    assert_eq!(volume(&s, &d, "poe"), VenueDaily { usd: 3.0, swaps: 1 });
    assert!(s.trade("hanji-live").unwrap().is_some());
    let (gas, _) = s.gas_days("2030-01-01").unwrap();
    assert_eq!(gas[0].by_venue["hanji"], VenueGasDaily { mon: 2.0, txs: 4 });
    assert_eq!(s.history_job("hanji", "spec").unwrap().unwrap().cursor, Some(199));
    assert_eq!(s.cursor(crate::FINAL_CURSOR).unwrap().unwrap().block, 300);
}

#[test]
fn an_older_day_gets_the_replays_volume_and_no_trades() {
    let mut s = seeded();
    s.set_volume("2026-09-01", "hanji", VenueDaily { usd: 999.0, swaps: 9 }).unwrap();
    s.start_history_job("hanji", "spec", "replay", 199, 0).unwrap();
    let t = NOV20 - 80.0 * DAY_MS;
    let r = |trades| DayRepair {
        venue_id: "hanji".into(),
        spec: "spec".into(),
        day: "2026-09-01".into(),
        from: 10,
        to: 20,
        trades,
    };
    let out = s.replace_history_day(&r(vec![fill("hanji-old", "hanji", 5.0, 10, t)]), "2026-11-01").unwrap();
    assert!(!out.through_trades);
    assert_eq!(out.after, VenueDaily { usd: 5.0, swaps: 1 });
    assert_eq!(volume(&s, "2026-09-01", "hanji"), out.after);
    assert!(s.trade("hanji-old").unwrap().is_none(), "no trades before trades_from");
    // A day the replay finds empty loses its row.
    s.replace_history_day(&r(vec![]), "2026-11-01").unwrap();
    assert_eq!(volume(&s, "2026-09-01", "hanji"), VenueDaily::default());
}

#[test]
fn a_listed_market_adds_only_what_is_new() {
    let mut s = seeded();
    let d = utc_day(NOV20);
    s.start_history_job("hanji", "m", "markets", 199, 0).unwrap();
    let t = NOV20 + 3_600_000.0;
    let r = DayRepair {
        venue_id: "hanji".into(),
        spec: "m".into(),
        day: d.clone(),
        from: 0,
        to: 199,
        // b is already stored (and counted); e is new.
        trades: vec![fill("hanji-b", "hanji", 50.0, 101, t), fill("hanji-e", "hanji", 4.0, 120, t)],
    };
    let out = s.add_history_day(&r, "2026-11-01").unwrap();
    assert_eq!(out.inserted, vec!["hanji-e".to_string()]);
    assert_eq!(out.after, VenueDaily { usd: 162.0, swaps: 5 });
    // Before trades_from the day only grows by the replay's totals.
    s.set_volume("2026-09-01", "hanji", VenueDaily { usd: 10.0, swaps: 1 }).unwrap();
    let old = DayRepair { day: "2026-09-01".into(), trades: vec![fill("hanji-f", "hanji", 4.0, 5, t)], ..r };
    let out = s.add_history_day(&old, "2026-11-01").unwrap();
    assert_eq!(out.after, VenueDaily { usd: 14.0, swaps: 2 });
    assert!(s.trade("hanji-f").unwrap().is_none());
}

#[test]
fn a_fills_revision_resums_from_stored_trades() {
    let mut s = seeded();
    let d = utc_day(NOV20);
    s.set_volume(&d, "hanji", VenueDaily { usd: 1.0, swaps: 1 }).unwrap();
    let out = s.resum_history_days("hanji", std::slice::from_ref(&d), "hanji#f:fills:a..b", 9).unwrap();
    assert_eq!(out[0].1, VenueDaily { usd: 1.0, swaps: 1 });
    assert_eq!(out[0].2, VenueDaily { usd: 158.0, swaps: 4 });
    assert_eq!(volume(&s, &d, "hanji"), VenueDaily { usd: 158.0, swaps: 4 });
    assert!(s.history_applied("hanji", "hanji#f:fills:a..b").unwrap());
    assert!(s.has_volume("hanji").unwrap() && !s.has_volume("btr").unwrap());
}
