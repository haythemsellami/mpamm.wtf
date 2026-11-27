//! Markouts after the fact (docs/rebuild-plan.md → M7): the marks the live
//! history couldn't give, from the exchanges' archives once they publish
//! them. The port of today's remark sweep (server/src/datasource/live.ts →
//! `remarkVenue`, against `history/cex.ts`).
//!
//! Live aging marks a trade from the in-memory reference history as each
//! horizon passes. Some trades never get that: those repaired over RPC after
//! an outage (decoded after their horizons), those from before a restart (the
//! history starts at boot), and horizons that fell in a feed outage. Each of
//! their null horizons takes the archive's mark, at the same mark time
//! (`horizon_mark_ms`), against the same pair-terms mid; a mark the live
//! history gave is kept.
//!
//! A trade is settled once the archive covering its marks has answered (a
//! mark the archive has no price for either stays null), when no archive
//! ever will (Kraken's xStock books), or when its Bybit day is still
//! unpublished `PUBLISH_GRACE_MS` after it closed. Until then it is asked
//! again. Curves are not drawn from the archives, as today.

use std::collections::BTreeMap;

use mpamm_pricing::archives::{Answer, Archives, DAY_MS, PUBLISH_GRACE_MS};
use mpamm_types::{utc_day, Fill, MARKOUT_HORIZONS_S};

use crate::{horizon_mark_ms, markout_bps};

/// What the archives decided for one trade.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Settled: the archive's mark at each horizon the trade had none for
    /// (`None` where it has none either, and at every horizon the live
    /// history already marked).
    Marked(Vec<Option<f64>>),
    /// Settled: no archive will ever mark it.
    Never(&'static str),
    /// Ask again later: the archive isn't published yet, or a download
    /// failed.
    Later(String),
}

impl Verdict {
    pub fn settled(&self) -> bool {
        !matches!(self, Verdict::Later(_))
    }
}

/// A mark is asked of the archives only this long after its time, so every
/// exchange print up to it is in (Binance serves klines as they close).
pub const SETTLE_MS: f64 = 60_000.0;

fn last_mark_ms(f: &Fill) -> f64 {
    horizon_mark_ms(f, *MARKOUT_HORIZONS_S.last().unwrap())
}

/// The archive's marks for `f` from a pair's mids, at its null horizons only.
pub fn archive_marks(f: &Fill, mid_at: impl Fn(f64) -> Option<f64>) -> Vec<Option<f64>> {
    MARKOUT_HORIZONS_S
        .iter()
        .enumerate()
        .map(|(i, h)| match f.markouts_bps.get(i).copied().flatten() {
            Some(_) => None,
            None => mid_at(horizon_mark_ms(f, *h)).and_then(|m| markout_bps(f.side, f.exec_px, m)),
        })
        .collect()
}

/// Marks `trades` from the archives, market by market and day by day (one
/// market's unpublished or failing archive never holds another's), and says
/// what to do with each.
pub async fn mark_from_archives(archives: &Archives, trades: &[Fill], now_ms: f64) -> Vec<(String, Verdict)> {
    let registry = archives.registry;
    let mut out = Vec::with_capacity(trades.len());
    let mut groups: BTreeMap<(&str, String), Vec<&Fill>> = BTreeMap::new();
    for f in trades {
        if f.px_approx {
            out.push((f.id.clone(), Verdict::Never("approximate price")));
        } else if registry.pair_of(&f.market).is_none() {
            out.push((f.id.clone(), Verdict::Never("unregistered market")));
        } else if !mpamm_pricing::archives::supports(registry, &f.market) {
            out.push((f.id.clone(), Verdict::Never("no archive for this market")));
        } else if last_mark_ms(f) > now_ms - SETTLE_MS {
            out.push((f.id.clone(), Verdict::Later("horizons not past yet".into())));
        } else {
            groups.entry((f.market.as_str(), utc_day(f.ts))).or_default().push(f);
        }
    }
    for ((market, _), fills) in groups {
        let from = fills.iter().map(|f| horizon_mark_ms(f, 0)).fold(f64::INFINITY, f64::min);
        let to = fills.iter().map(|f| last_mark_ms(f)).fold(f64::NEG_INFINITY, f64::max) + 1.0;
        let verdict = |f: &Fill, series: Option<&mpamm_pricing::archives::PairMids>| -> Verdict {
            match series {
                Some(s) => Verdict::Marked(archive_marks(f, |t| s.at(t))),
                None => Verdict::Marked(vec![None; MARKOUT_HORIZONS_S.len()]),
            }
        };
        match archives.pair_mids(market, from, to, now_ms as i64).await {
            Ok(Answer::Ready(s)) => out.extend(fills.iter().map(|f| (f.id.clone(), verdict(f, Some(&s))))),
            Ok(Answer::Unsupported) => {
                out.extend(fills.iter().map(|f| (f.id.clone(), Verdict::Never("no archive for this market"))))
            }
            Ok(Answer::Pending(why)) => {
                // The last day the marks need; one still unpublished long
                // after it closed is not coming.
                let last_day_end = ((to - 1.0) / DAY_MS as f64).floor() * DAY_MS as f64 + DAY_MS as f64;
                let gave_up = now_ms - last_day_end > PUBLISH_GRACE_MS;
                out.extend(
                    fills
                        .iter()
                        .map(|f| (f.id.clone(), if gave_up { verdict(f, None) } else { Verdict::Later(why.clone()) })),
                );
            }
            Err(e) => out.extend(fills.iter().map(|f| (f.id.clone(), Verdict::Later(e.to_string())))),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mpamm_pricing::archives::{cache, ArchiveConfig, Points};
    use mpamm_registry::Registry;
    use mpamm_types::{FillCategory, Side, TimeSource};

    use super::*;

    const D: f64 = 1_795_651_200_000.0; // 2026-11-26
    const DAY: f64 = 86_400_000.0;

    fn fill(id: &str, market: &str, side: Side, ts: f64, exec_px: f64) -> Fill {
        Fill {
            id: id.into(),
            venue_id: "v".into(),
            market: market.into(),
            side,
            category: FillCategory::Direct,
            usd: 10.0,
            base_amount: 1.0,
            exec_px,
            px_approx: false,
            tx_hash: "0x".into(),
            to: "x".into(),
            router: None,
            pool: "p".into(),
            block_number: 1,
            ts,
            markouts_bps: vec![None; 5],
            time_source: Some(TimeSource::Block),
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mpamm-markouts-archive-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Archives that read `dir` and ask `host` for anything else (by default
    /// an address nothing listens on: a fetch fails instead of reaching an
    /// exchange).
    fn offline(dir: &std::path::Path, host: Option<&str>) -> std::sync::Arc<Archives> {
        let mut cfg = ArchiveConfig::new(dir);
        cfg.bybit_url = host.unwrap_or("http://127.0.0.1:9").into();
        cfg.binance_url = host.unwrap_or("http://127.0.0.1:9").into();
        cfg.attempts = 1;
        cfg.pace = Duration::ZERO;
        Archives::new(Registry::get(), cfg)
    }

    /// An archive host that has published nothing (404 to everything).
    async fn empty_host() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let _ =
                        s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn points(v: &[(f64, f64)]) -> Points {
        let mut p = Points::default();
        for &(t, px) in v {
            p.push(t, px);
        }
        p
    }

    /// MON's book on 2026-11-26: 0.0110 until noon, 0.0111 from noon (an
    /// outage from 18:00 to 18:10); USDC's cross flat at 1.0002.
    fn mon_day(dir: &std::path::Path) {
        let noon = D + DAY / 2.0;
        let mut mon = vec![(D + 1_000.0, 0.0110)];
        let mut t = D + 60_000.0;
        while t < D + DAY {
            let px = if t < noon { 0.0110 } else { 0.0111 };
            if (D + 18.0 * 3_600_000.0..D + 18.0 * 3_600_000.0 + 600_000.0).contains(&t) {
                if t == D + 18.0 * 3_600_000.0 {
                    mon.push((t, f64::NAN));
                }
            } else {
                mon.push((t, px));
            }
            t += 60_000.0;
        }
        cache::write(&cache::bybit_path(dir, "MONUSDT", "2026-11-26"), &points(&mon)).unwrap();
        // A quiet book: a heartbeat every 10 minutes, within the cross's cap.
        let usdc: Vec<(f64, f64)> = (0..144).map(|i| (D + 1_000.0 + f64::from(i) * 600_000.0, 1.0002)).collect();
        cache::write(&cache::bybit_path(dir, "USDCUSDT", "2026-11-26"), &points(&usdc)).unwrap();
        // The previous day's tails, for marks in the first minutes.
        cache::write(&cache::bybit_path(dir, "MONUSDT", "2026-11-25"), &points(&[(D - 30_000.0, 0.0109)])).unwrap();
        cache::write(&cache::bybit_path(dir, "USDCUSDT", "2026-11-25"), &points(&[(D - 600_000.0, 1.0002)])).unwrap();
    }

    #[tokio::test]
    async fn null_horizons_take_the_archives_marks_and_live_ones_stay() {
        let dir = temp_dir("marks");
        mon_day(&dir);
        let a = offline(&dir, None);
        let now = D + 2.0 * DAY;
        let before_noon = D + DAY / 2.0 - 20_000.0;
        let buy = fill("buy", "MON/USDC", Side::Buy, before_noon, 0.0110 / 1.0002);
        let mut sell = fill("sell", "MON/USDC", Side::Sell, before_noon, 0.0110 / 1.0002);
        sell.markouts_bps = vec![Some(0.25), None, None, None, None];
        let early = fill("early", "MON/USDC", Side::Buy, D + 500.0, 0.0109 / 1.0002);
        let outage = fill("outage", "MON/USDC", Side::Buy, D + 18.0 * 3_600_000.0 - 30_000.0, 0.0111 / 1.0002);
        let v = mark_from_archives(&a, &[buy, sell, early, outage], now).await;
        let get = |id: &str| v.iter().find(|(i, _)| i == id).unwrap().1.clone();
        let Verdict::Marked(m) = get("buy") else { panic!("{v:?}") };
        let up = (0.0111 / 0.0110 - 1.0) * 1e4;
        assert!(m[0].unwrap().abs() < 1e-9 && m[1].unwrap().abs() < 1e-9 && m[2].unwrap().abs() < 1e-9);
        assert!((m[3].unwrap() - up).abs() < 1e-6 && (m[4].unwrap() - up).abs() < 1e-6, "{m:?}: MON moved at noon");
        let Verdict::Marked(m) = get("sell") else { panic!() };
        assert_eq!(m[0], None, "the live mark stays; nothing to write there");
        assert!((m[4].unwrap() + up).abs() < 1e-6, "taker-signed");
        let Verdict::Marked(m) = get("early") else { panic!() };
        assert!(m[0].unwrap().abs() < 1e-9, "the previous day's last mid carries past midnight");
        let Verdict::Marked(m) = get("outage") else { panic!() };
        assert!(m[2].is_some() && m[3].is_none() && m[4].is_none(), "no mid through the outage: {m:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn what_no_archive_will_mark_settles_and_what_is_coming_waits() {
        let dir = temp_dir("verdicts");
        mon_day(&dir);
        let host = empty_host().await;
        let a = offline(&dir, Some(&host));
        let t = D + 3_600_000.0;
        let mut approx = fill("approx", "MON/USDC", Side::Buy, t, 0.011);
        approx.px_approx = true;
        let trades = [
            fill("xstock", "wANTx/USDC", Side::Buy, t, 85.0),
            fill("unknown", "NOPE/USDC", Side::Buy, t, 1.0),
            approx,
            fill("fresh", "MON/USDC", Side::Buy, D + DAY + 3_600_000.0, 0.011),
            fill("tomorrow", "MON/USDC", Side::Buy, D + DAY + 3_600_000.0, 0.011),
        ];
        let now = D + DAY + 3_600_000.0 + 61_000.0;
        let v = mark_from_archives(&a, &trades, now).await;
        let get = |id: &str| v.iter().find(|(i, _)| i == id).unwrap().1.clone();
        assert_eq!(get("xstock"), Verdict::Never("no archive for this market"));
        assert_eq!(get("unknown"), Verdict::Never("unregistered market"));
        assert_eq!(get("approx"), Verdict::Never("approximate price"));
        assert_eq!(get("fresh"), Verdict::Later("horizons not past yet".into()));
        assert!(get("xstock").settled() && !get("fresh").settled());
        let now = D + DAY + 7_200_000.0;
        let v = mark_from_archives(&a, &trades[3..], now).await;
        assert!(matches!(&v[0].1, Verdict::Later(why) if why.contains("2026-11-27 is not published")), "{v:?}");
        assert_eq!(v.len(), 2);
        // Still unpublished three days after it closed: given up, marks left null.
        let v = mark_from_archives(&a, &trades[3..], D + 6.0 * DAY).await;
        assert_eq!(v[0].1, Verdict::Marked(vec![None; 5]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_failed_download_is_asked_again() {
        let dir = temp_dir("failed");
        // BTC/USDC needs Binance klines, and nothing answers.
        let a = offline(&dir, None);
        let v =
            mark_from_archives(&a, &[fill("btc", "BTC/USDC", Side::Buy, D + 1_000.0, 60_000.0)], D + DAY * 3.0).await;
        assert!(matches!(&v[0].1, Verdict::Later(why) if why.contains("binance BTCUSDT 1s")), "{v:?}");
        // Unlike a 404, a failure is never given up on.
        let v =
            mark_from_archives(&a, &[fill("btc", "BTC/USDC", Side::Buy, D + 1_000.0, 60_000.0)], D + DAY * 30.0).await;
        assert!(!v[0].1.settled());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
