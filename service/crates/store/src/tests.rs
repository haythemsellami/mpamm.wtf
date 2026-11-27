use mpamm_types::{Fill, FillCategory, Side, TimeSource, VenueDaily, VenueGasDaily};

use super::*;

fn fill(id: &str, venue: &str, usd: f64, block: u64) -> Fill {
    Fill {
        id: id.into(),
        venue_id: venue.into(),
        market: "MON/USDC".into(),
        side: Side::Sell,
        category: FillCategory::Direct,
        usd,
        base_amount: usd * 30.0,
        exec_px: 1.0 / 30.0,
        px_approx: false,
        tx_hash: format!("0x{id}"),
        to: "0xabc…def".into(),
        router: Some("KyberSwap".into()),
        pool: "MON/USDC".into(),
        block_number: block,
        ts: 1_795_762_412_345.25,
        markouts_bps: vec![None; 5],
        time_source: Some(TimeSource::Proposal),
    }
}

// 2026-11-27 07:00:00 UTC and 2026-11-28 00:00:01 UTC.
const DAY1: u64 = 1_795_762_800;
const DAY2: u64 = 1_795_824_001;

fn block(n: u64, ts: u64, trades: Vec<Fill>) -> BlockCommit {
    BlockCommit { number: n, hash: format!("0x{n:064x}"), timestamp: ts, trades, gas: vec![], state: vec![] }
}

#[test]
fn commits_in_order_with_the_cursor() {
    let mut s = Store::memory().unwrap();
    assert_eq!(s.cursor(FINAL_CURSOR).unwrap(), None);
    s.commit_block(&block(100, DAY1, vec![])).unwrap();
    s.commit_block(&block(101, DAY1, vec![fill("a", "metric", 10.0, 101)])).unwrap();
    assert_eq!(s.cursor(FINAL_CURSOR).unwrap(), Some(Cursor { block: 101, hash: Some(format!("0x{:064x}", 101)) }));
    match s.commit_block(&block(103, DAY1, vec![])) {
        Err(StoreError::OutOfOrder { cursor: 101, got: 103 }) => {}
        other => panic!("{other:?}"),
    }
    assert!(matches!(s.commit_block(&block(101, DAY1, vec![])), Err(StoreError::OutOfOrder { .. })));
    // A rejected commit leaves nothing behind.
    assert_eq!(s.cursor(FINAL_CURSOR).unwrap().unwrap().block, 101);
}

#[test]
fn volume_grows_only_by_new_trades() {
    let mut s = Store::memory().unwrap();
    let c = s
        .commit_block(&block(
            1,
            DAY1,
            vec![fill("a", "metric", 10.0, 1), fill("b", "metric", 5.0, 1), fill("c", "poe", 2.0, 1)],
        ))
        .unwrap();
    assert_eq!(c.inserted.len(), 3);
    // The same trades again (a replay after a crash): no double count.
    let c = s.commit_block(&block(2, DAY1, vec![fill("a", "metric", 10.0, 1), fill("d", "metric", 1.0, 2)])).unwrap();
    assert_eq!((c.inserted, c.duplicates), (vec!["d".to_string()], 1));
    let days = s.volume_days("2026-11-27").unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].by_venue["metric"], VenueDaily { usd: 16.0, swaps: 3 });
    assert_eq!(days[0].by_venue["poe"], VenueDaily { usd: 2.0, swaps: 1 });
    assert!(days[0].partial, "today is partial");
    // The next block lands on the next UTC day by its block timestamp.
    s.commit_block(&block(3, DAY2, vec![fill("e", "metric", 4.0, 3)])).unwrap();
    let days = s.volume_days("2026-11-28").unwrap();
    assert_eq!(
        days.iter().map(|d| (d.utc_day.as_str(), d.partial)).collect::<Vec<_>>(),
        [("2026-11-27", false), ("2026-11-28", true)]
    );
}

#[test]
fn a_failed_commit_writes_nothing() {
    let mut s = Store::memory().unwrap();
    s.commit_block(&block(1, DAY1, vec![])).unwrap();
    // Make the next insert fail mid-transaction: a NaN usd violates nothing,
    // so drop the trades table instead to force an error after the cursor check.
    s.conn().execute_batch("ALTER TABLE trades RENAME TO trades_gone").unwrap();
    assert!(s.commit_block(&block(2, DAY1, vec![fill("x", "metric", 1.0, 2)])).is_err());
    s.conn().execute_batch("ALTER TABLE trades_gone RENAME TO trades").unwrap();
    assert_eq!(s.cursor(FINAL_CURSOR).unwrap().unwrap().block, 1, "cursor did not move");
    assert!(s.volume_days("2026-11-27").unwrap().is_empty(), "no volume from the failed block");
    s.commit_block(&block(2, DAY1, vec![fill("x", "metric", 1.0, 2)])).unwrap();
    assert_eq!(s.volume_days("2026-11-27").unwrap()[0].by_venue["metric"].swaps, 1);
}

#[test]
fn trades_round_trip() {
    let mut s = Store::memory().unwrap();
    let mut f = fill("a", "metric", 10.0, 7);
    f.markouts_bps = vec![Some(1.25), None, Some(-3.0), None, None];
    f.router = None;
    f.px_approx = true;
    f.category = FillCategory::CexDex;
    s.commit_block(&block(7, DAY1, vec![f.clone()])).unwrap();
    assert_eq!(s.trade("a").unwrap(), Some(f.clone()));
    let got = s.trades_between(f.ts - 1.0, f.ts + 1.0, 10).unwrap();
    assert_eq!(got, vec![f.clone()]);
    assert!(s.trades_between(f.ts + 1.0, f.ts + 2.0, 10).unwrap().is_empty());
    assert!(s.set_markouts("a", &[Some(1.25), Some(2.0), Some(-3.0), None, None]).unwrap());
    assert_eq!(s.trade("a").unwrap().unwrap().markouts_bps[1], Some(2.0));
    assert!(!s.set_markouts("nope", &[]).unwrap());
}

#[test]
fn gas_accrues_and_records_its_method() {
    let mut s = Store::memory().unwrap();
    s.set_gas("2026-11-26", "poe", VenueGasDaily { mon: 5.0, txs: 100 }, GasMethod::Estimate).unwrap();
    s.set_gas("2026-11-27", "poe", VenueGasDaily { mon: 1.0, txs: 10 }, GasMethod::Estimate).unwrap();
    let mut b = block(1, DAY1, vec![]);
    b.gas = vec![
        GasAccrual { venue_id: "poe".into(), mon: 0.5, txs: 3 },
        GasAccrual { venue_id: "metric".into(), mon: 0.25, txs: 1 },
    ];
    s.commit_block(&b).unwrap();
    let (days, methods) = s.gas_days("2026-11-27").unwrap();
    assert_eq!(days[1].by_venue["poe"], VenueGasDaily { mon: 1.5, txs: 13 });
    assert_eq!(days[1].by_venue["metric"], VenueGasDaily { mon: 0.25, txs: 1 });
    assert!(days[1].partial && !days[0].partial);
    assert_eq!(
        methods,
        vec![
            ("2026-11-26".into(), "poe".into(), GasMethod::Estimate),
            ("2026-11-27".into(), "poe".into(), GasMethod::Mixed)
        ]
    );
}

#[test]
fn state_revisions_meta_and_schema_guard() {
    let mut s = Store::memory().unwrap();
    let mut b = block(1, DAY1, vec![]);
    b.state = vec![("capricorn".into(), "pools".into(), "[1,2]".into())];
    s.commit_block(&b).unwrap();
    assert_eq!(s.venue_state("capricorn", "pools").unwrap().as_deref(), Some("[1,2]"));
    assert!(!s.revision_applied("hanji", "history", "xaut-1").unwrap());
    s.mark_revision("hanji", "history", "xaut-1", 1).unwrap();
    s.mark_revision("hanji", "history", "xaut-1", 2).unwrap();
    assert!(s.revision_applied("hanji", "history", "xaut-1").unwrap());
    assert_eq!(s.meta("schema_version").unwrap().as_deref(), Some(SCHEMA_VERSION));

    let dir = std::env::temp_dir().join(format!("mpamm-store-{}", std::process::id()));
    let path = dir.join("mpamm.db");
    {
        let s = Store::open(&path).unwrap();
        s.set_meta("schema_version", "999").unwrap();
    }
    assert!(matches!(Store::open(&path), Err(StoreError::Schema(_))), "a newer schema is refused, never wiped");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn file_store_reopens_and_readers_see_commits() {
    let dir = std::env::temp_dir().join(format!("mpamm-store-file-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("mpamm.db");
    {
        let mut s = Store::open(&path).unwrap();
        s.commit_block(&block(10, DAY1, vec![fill("a", "metric", 1.0, 10)])).unwrap();
        let r = Store::open_readonly(&path).unwrap();
        assert_eq!(r.cursor(FINAL_CURSOR).unwrap().unwrap().block, 10);
        s.commit_block(&block(11, DAY1, vec![])).unwrap();
        assert_eq!(r.cursor(FINAL_CURSOR).unwrap().unwrap().block, 11);
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.cursor(FINAL_CURSOR).unwrap().unwrap().block, 11);
    assert_eq!(s.trade("a").unwrap().unwrap().venue_id, "metric");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_writer_thread_commits_in_order() {
    let w = writer::Writer::spawn(Store::memory().unwrap());
    for n in 1..=50u64 {
        w.commit(block(n, DAY1, vec![fill(&format!("t{n}"), "metric", 1.0, n)])).await.unwrap();
    }
    let (cur, vol) = w
        .run(|s| Ok((s.cursor(FINAL_CURSOR)?.unwrap().block, s.volume_days("2026-11-27")?[0].by_venue["metric"])))
        .await
        .unwrap();
    assert_eq!(cur, 50);
    assert_eq!(vol, VenueDaily { usd: 50.0, swaps: 50 });
    assert!(matches!(w.commit(block(52, DAY1, vec![])).await, Err(StoreError::OutOfOrder { .. })));
}

#[test]
fn curves_and_aging_queries() {
    let mut s = Store::memory().unwrap();
    let mut done = fill("done", "metric", 1.0, 1);
    done.markouts_bps = vec![Some(1.0); 5];
    s.commit_block(&block(1, DAY1, vec![fill("a", "metric", 1.0, 1), done])).unwrap();
    assert!(s.set_curve("done", &[0.5; 14]).unwrap());
    let aging: Vec<String> = s.trades_aging(0.0).unwrap().into_iter().map(|f| f.id).collect();
    assert_eq!(aging, ["a"]);
    assert!(s.trades_aging(f64::MAX).unwrap().is_empty());
}
