//! Markouts after the fact, in the service: every few minutes the trades of
//! the last week still missing a mark the live history couldn't give (trades
//! repaired over RPC after an outage, trades from before a restart, horizons
//! in a feed outage) are marked from the exchanges' archives
//! (`mpamm_markouts::archive`). A trade is settled in the store once its
//! archive has answered, so each is asked for until then and never after.
//!
//! The writer thread also commits final blocks, so settling goes in small
//! batches: a sweep never holds a block's commit for long.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use mpamm_markouts::archive::{mark_from_archives, Verdict};
use mpamm_pricing::archives::Archives;
use mpamm_store::{writer::Writer, StoreError};
use mpamm_types::{utc_day, MARKOUT_HORIZONS_S};

/// Between sweeps.
pub const EVERY: Duration = Duration::from_secs(600);
/// How far back a sweep looks for trades to mark.
pub const LOOKBACK_MS: f64 = 7.0 * 86_400_000.0;
/// Live aging is done with a trade this long after it (its last horizon,
/// its curve, the settle delay).
pub const AFTER_MS: f64 = 5.0 * 60_000.0;
/// Trades read per sweep, and settled per writer job.
const READ: usize = 20_000;
const SETTLE_BATCH: usize = 500;

/// One trade's new markouts.
pub type Marked = (String, Vec<Option<f64>>);

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Sweep {
    pub read: usize,
    /// Settled this sweep (marked or not).
    pub settled: usize,
    /// Trades whose markouts changed.
    pub marked: usize,
    /// Left for a later sweep, by reason.
    pub later: BTreeMap<String, usize>,
}

/// One sweep at `now_ms`: what changed, for the stream, and a summary.
pub async fn sweep(archives: &Archives, writer: &Writer, now_ms: f64) -> Result<(Sweep, Vec<Marked>), StoreError> {
    let (from, to) = (now_ms - LOOKBACK_MS, now_ms - AFTER_MS);
    let trades = writer.run(move |st| st.trades_unmarked(from, to, READ)).await?;
    settle(archives, writer, &trades, now_ms).await
}

/// Marks these trades from the archives and settles those answered (a
/// history repair hands over the trades it inserted, at any age).
pub async fn settle(
    archives: &Archives,
    writer: &Writer,
    trades: &[mpamm_types::Fill],
    now_ms: f64,
) -> Result<(Sweep, Vec<Marked>), StoreError> {
    let mut report = Sweep { read: trades.len(), ..Sweep::default() };
    let mut settle: Vec<Marked> = Vec::new();
    for (id, v) in mark_from_archives(archives, trades, now_ms).await {
        match v {
            Verdict::Marked(m) => settle.push((id, m)),
            Verdict::Never(_) => settle.push((id, vec![None; MARKOUT_HORIZONS_S.len()])),
            Verdict::Later(why) => *report.later.entry(why).or_default() += 1,
        }
    }
    report.settled = settle.len();
    let mut changed = Vec::new();
    for chunk in settle.chunks(SETTLE_BATCH) {
        let chunk = chunk.to_vec();
        changed.extend(writer.run(move |st| st.settle_archive_marks(&chunk, now_ms as i64)).await?);
    }
    report.marked = changed.len();
    Ok((report, changed))
}

/// Sweeps every `EVERY` (the first after `first`), handing what changed to
/// `on_marked`, until the runtime stops.
pub async fn run(
    archives: Arc<Archives>,
    writer: Writer,
    first: Duration,
    now_ms: impl Fn() -> f64 + Send + 'static,
    on_marked: impl Fn(&[Marked]) + Send + 'static,
) {
    tokio::time::sleep(first).await;
    let mut every = tokio::time::interval(EVERY);
    loop {
        every.tick().await;
        let now = now_ms();
        // Days no sweep reads any more (the lookback, and the lead-in before it).
        let pruned = mpamm_pricing::archives::cache::prune(
            archives.cache_dir(),
            &utc_day(now - LOOKBACK_MS - 2.0 * 86_400_000.0),
        );
        if pruned > 0 {
            tracing::info!("markouts from archives: {pruned} cached day(s) pruned");
        }
        match sweep(&archives, &writer, now).await {
            Ok((report, changed)) => {
                if !changed.is_empty() {
                    on_marked(&changed);
                }
                log(&report);
            }
            Err(e) => tracing::warn!("markouts from archives: store: {e}"),
        }
    }
}

fn log(r: &Sweep) {
    if r.read == 0 {
        return;
    }
    let (pending, failed): (Vec<_>, Vec<_>) = r.later.iter().partition(|(why, _)| why.contains("not published yet"));
    tracing::info!(
        "markouts from archives: {} trade(s) read, {} settled, {} marked, {} waiting on an archive",
        r.read,
        r.settled,
        r.marked,
        pending.iter().map(|(_, n)| **n).sum::<usize>()
    );
    for (why, n) in failed {
        tracing::warn!("markouts from archives: {n} trade(s) held: {why}");
    }
}

#[cfg(test)]
mod tests {
    use mpamm_pricing::archives::{cache, ArchiveConfig, Points};
    use mpamm_registry::Registry;
    use mpamm_store::{BlockCommit, Store};
    use mpamm_types::{Fill, FillCategory, Side, TimeSource};

    use super::*;

    const D: f64 = 1_795_651_200_000.0; // 2026-11-26

    fn fill(id: &str, market: &str, ts: f64, markouts: Vec<Option<f64>>) -> Fill {
        Fill {
            id: id.into(),
            venue_id: "v".into(),
            market: market.into(),
            side: Side::Buy,
            category: FillCategory::Direct,
            usd: 10.0,
            base_amount: 1.0,
            exec_px: 0.011,
            px_approx: false,
            tx_hash: "0x".into(),
            to: "x".into(),
            router: None,
            pool: "p".into(),
            block_number: 1,
            ts,
            markouts_bps: markouts,
            time_source: Some(TimeSource::Block),
        }
    }

    #[tokio::test]
    async fn a_sweep_marks_settles_and_never_asks_twice() {
        let dir = std::env::temp_dir().join(format!("mpamm-marks-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pts = |px: f64| {
            let mut p = Points::default();
            let mut t = D + 1_000.0;
            while t < D + 86_400_000.0 {
                p.push(t, px);
                t += 60_000.0;
            }
            p
        };
        cache::write(&cache::bybit_path(&dir, "MONUSDT", "2026-11-26"), &pts(0.0111)).unwrap();
        let mut cfg = ArchiveConfig::new(&dir);
        cfg.bybit_url = "http://127.0.0.1:9".into();
        cfg.binance_url = "http://127.0.0.1:9".into();
        cfg.attempts = 1;
        let archives = Archives::new(Registry::get(), cfg);

        let writer = Writer::spawn(Store::memory().unwrap());
        let noon = D + 43_200_000.0;
        let trades = vec![
            fill("restart", "MON/USDT0", noon, vec![None; 5]),
            fill("partial", "MON/USDT0", noon + 1_000.0, vec![Some(-1.0), Some(-1.0), None, None, None]),
            fill("xstock", "wANTx/USDC", noon, vec![None; 5]),
            fill("btc", "BTC/USDC", noon, vec![None; 5]),
        ];
        let commit = BlockCommit {
            number: 1,
            hash: "0x01".into(),
            timestamp: (noon / 1000.0) as u64,
            trades,
            gas: vec![],
            state: vec![],
        };
        writer.commit(commit).await.unwrap();
        let now = D + 2.0 * 86_400_000.0;
        let (report, changed) = sweep(&archives, &writer, now).await.unwrap();
        assert_eq!((report.read, report.settled, report.marked), (4, 3, 2), "{report:?}");
        assert_eq!(report.later.len(), 1, "BTC's klines aren't reachable here: {report:?}");
        let up = (0.0111 / 0.011 - 1.0) * 1e4;
        let partial = &changed.iter().find(|(id, _)| id == "partial").unwrap().1;
        assert_eq!(partial[..2], [Some(-1.0), Some(-1.0)], "live marks kept");
        assert!((partial[4].unwrap() - up).abs() < 1e-9);
        let again = sweep(&archives, &writer, now).await.unwrap().0;
        assert_eq!((again.read, again.settled), (1, 0), "only the held trade is asked again");
        let stored = writer.run(|st| st.trade("restart")).await.unwrap().unwrap();
        assert!(stored.markouts_bps.iter().all(|m| m.is_some_and(|v| (v - up).abs() < 1e-9)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
