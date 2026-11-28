use super::*;

pub fn temp_dir(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "mpamm-archives-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn days_parse_and_span_windows() {
    assert_eq!(day_start("2026-09-29"), Some(1_790_640_000_000));
    assert_eq!(day_start("1970-01-01"), Some(0));
    assert_eq!(day_start("2024-02-29"), Some(1_709_164_800_000));
    assert_eq!(day_start("2026-02-30"), None);
    assert_eq!(day_start("nope"), None);
    let d = 1_790_640_000_000.0;
    let days: Vec<String> = days_of(d - 1.0, d + 86_400_000.0).into_iter().map(|x| x.0).collect();
    assert_eq!(days, ["2026-09-28", "2026-09-29"]);
    let days: Vec<String> = days_of(d, d + 86_400_001.0).into_iter().map(|x| x.0).collect();
    assert_eq!(days, ["2026-09-29", "2026-09-30"]);
}

#[test]
fn legs_follow_todays_sources_and_roles() {
    let r = Registry::get();
    let l = |m: &str| legs(r, m).map(|v| v.into_iter().map(|l| (l.cex, l.symbol, l.role)).collect::<Vec<_>>());
    let s = |x: &str| x.to_string();
    assert_eq!(
        l("MON/USDC"),
        Some(vec![(Cex::Bybit, s("MONUSDT"), Role::Base), (Cex::Bybit, s("USDCUSDT"), Role::Slow)])
    );
    assert_eq!(l("MON/USDT0"), Some(vec![(Cex::Bybit, s("MONUSDT"), Role::Base)]), "no cross: USDT0 is USDT");
    assert_eq!(
        l("BTC/USDC"),
        Some(vec![
            (Cex::Binance, s("BTCUSDT"), Role::Base),
            (Cex::Binance, s("WBTCBTC"), Role::Slow),
            (Cex::Binance, s("USDCUSDT"), Role::Slow)
        ])
    );
    assert_eq!(
        l("cbBTC/USDC"),
        Some(vec![(Cex::Binance, s("BTCUSDT"), Role::Base), (Cex::Binance, s("USDCUSDT"), Role::Slow)]),
        "cbBTC is parity: no wrap leg"
    );
    assert_eq!(
        l("MON/ETH"),
        Some(vec![(Cex::Bybit, s("MONUSDT"), Role::Base), (Cex::Binance, s("ETHUSDT"), Role::Base)])
    );
    assert_eq!(
        l("WBTC/cbBTC"),
        Some(vec![(Cex::Binance, s("BTCUSDT"), Role::Base), (Cex::Binance, s("WBTCBTC"), Role::Slow)]),
        "the quote asset's leg is the base's own"
    );
    assert_eq!(l("SPYx/USDC"), None);
    assert_eq!(l("wANTx/USDC"), None);
    assert_eq!(l("QQQx/MON"), None);
    assert_eq!(l("NOPE/USDC"), None);
    // A symbol never plays two roles (the reference reads it by symbol).
    let mut seen: Vec<(Cex, String, Role)> = Vec::new();
    for p in &r.pairs {
        for leg in legs(r, &p.symbol).unwrap_or_default() {
            if let Some(other) = seen.iter().find(|(c, s, _)| *c == leg.cex && *s == leg.symbol) {
                assert_eq!(other.2, leg.role, "{} {}", p.symbol, leg.symbol);
            }
            seen.push((leg.cex, leg.symbol, leg.role));
        }
    }
}

// ── The fetch path, against a local stand-in for the archive hosts ──────────

use std::collections::HashMap;

use parking_lot::Mutex as PlMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::bybit::tests::{msg, zip};

const D: i64 = 1_790_640_000_000; // 2026-09-29
const MIN: i64 = 60_000;

/// (symbol, interval) → [(open time, close)].
type KlineRows = HashMap<(String, String), Vec<(i64, f64)>>;

/// Serves `files` by path (404 otherwise), `klines` like the API (by symbol
/// and interval, filtered on open time, 1000 a page) and, once per path in
/// `flaky`, a 500 first. Every request is logged as "METHOD path?query".
#[derive(Default)]
struct Host {
    files: PlMutex<HashMap<String, Vec<u8>>>,
    klines: PlMutex<KlineRows>,
    flaky: PlMutex<Vec<String>>,
    log: PlMutex<Vec<String>>,
    /// Kline pages served gzipped.
    gzipped: std::sync::atomic::AtomicUsize,
}

impl Host {
    fn answer(&self, method: &str, target: &str) -> (u16, Vec<u8>) {
        self.log.lock().push(format!("{method} {target}"));
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        {
            let mut flaky = self.flaky.lock();
            if let Some(i) = flaky.iter().position(|p| p == path) {
                flaky.remove(i);
                return (500, Vec::new());
            }
        }
        if path == "/api/v3/klines" {
            let q: HashMap<&str, &str> = query.split('&').filter_map(|kv| kv.split_once('=')).collect();
            let (sym, iv) = (q["symbol"].to_string(), q["interval"].to_string());
            let (start, end): (i64, i64) = (q["startTime"].parse().unwrap(), q["endTime"].parse().unwrap());
            let step = if iv == "1s" { 1_000 } else { MIN };
            let rows: Vec<serde_json::Value> = self
                .klines
                .lock()
                .get(&(sym, iv))
                .map(|v| v.iter().filter(|(t, _)| *t >= start && *t <= end).take(1000).copied().collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .map(|(t, c)| {
                    serde_json::json!([t, "0", "0", "0", c.to_string(), "0", t + step - 1, "0", 1, "0", "0", "0"])
                })
                .collect();
            return (200, serde_json::to_vec(&rows).unwrap());
        }
        match self.files.lock().get(path) {
            Some(b) => (200, if method == "HEAD" { Vec::new() } else { b.clone() }),
            None => (404, Vec::new()),
        }
    }
}

async fn serve(host: Arc<Host>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let host = host.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let mut first = head.lines().next().unwrap_or("").split(' ');
                let (method, target) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
                let (status, mut body) = host.answer(&method, &target);
                // Kline pages are gzipped when asked, as the data mirror does.
                let mut encoding = "";
                if target.starts_with("/api/v3/klines") && head.to_ascii_lowercase().contains("accept-encoding: gzip") {
                    use std::io::Write;
                    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                    gz.write_all(&body).unwrap();
                    body = gz.finish().unwrap();
                    encoding = "Content-Encoding: gzip\r\n";
                    host.gzipped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\n{encoding}Connection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                if method != "HEAD" {
                    let _ = sock.write_all(&body).await;
                }
                let _ = sock.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

/// A day of `sym`'s book: the previous file's overlap, a snapshot a second
/// in, then a size-only delta every minute (so the base cap never trips).
fn book_day(host: &Host, sym: &str, start: i64, bid: &str, ask: &str) {
    let day = utc_day(start as f64);
    let mut lines = vec![
        msg(sym, start - 2_000, "snapshot", &[("0.5", "1")], &[("0.6", "1")], 1),
        msg(sym, start + 1_000, "snapshot", &[(bid, "1")], &[(ask, "1")], 2),
    ];
    let (mut u, mut t) = (3, MIN);
    while t < 86_400_000 {
        let size = (1 + (t / MIN) % 7).to_string();
        lines.push(msg(sym, start + t, "delta", &[(bid, &size)], &[], u));
        u += 1;
        t += MIN;
    }
    let path = format!("/orderbook/spot/{sym}/{day}_{sym}_ob200.data.zip");
    host.files.lock().insert(path, zip(&format!("{day}_{sym}_ob200.data"), &(lines.join("\n") + "\n"), None));
}

fn archives(base: &str, dir: &std::path::Path) -> Arc<Archives> {
    let mut cfg = ArchiveConfig::new(dir);
    cfg.bybit_url = base.into();
    cfg.binance_url = base.into();
    cfg.pace = Duration::ZERO;
    cfg.attempts = 2;
    cfg.backoff = Duration::from_millis(1);
    Archives::new(Registry::get(), cfg)
}

fn gets(host: &Host) -> Vec<String> {
    host.log.lock().iter().filter(|l| l.starts_with("GET")).cloned().collect()
}

#[tokio::test]
async fn a_bybit_pair_is_marked_from_book_archives_and_cached() {
    let host = Arc::new(Host::default());
    for start in [D - 86_400_000, D, D + 86_400_000] {
        book_day(&host, "MONUSDT", start, "0.02875", "0.02876");
        book_day(&host, "USDCUSDT", start, "1.0002", "1.0003");
    }
    let base = serve(host.clone()).await;
    let dir = temp_dir("bybit-pair");
    let a = archives(&base, &dir);
    let now = D + 3 * 86_400_000;
    let noon = (D + 43_200_000) as f64;
    let Answer::Ready(s) = a.pair_mids("MON/USDC", noon, noon + 60_001.0, now).await.unwrap() else { panic!() };
    // 0.028755 ÷ 1.00025: the half-tick BBO mids, as the live reference reads them.
    assert!((s.at(noon + 30_000.0).unwrap() - 0.028755 / 1.00025).abs() < 1e-15);
    assert_eq!(gets(&host).len(), 2, "one download per symbol-day the window touches");
    assert!(
        dir.join("MONUSDT_2026-09-29.bbo-mid.csv").exists() && dir.join("USDCUSDT_2026-09-29.bbo-mid.csv").exists()
    );
    // Across midnight: the previous day's files too.
    let midnight = D as f64;
    let Answer::Ready(s) = a.pair_mids("MON/USDC", midnight - 30_000.0, midnight + 30_000.0, now).await.unwrap() else {
        panic!()
    };
    assert!(s.at(midnight + 500.0).is_some(), "carried from the previous day's last mid");
    assert_eq!(gets(&host).len(), 4);
    let fresh = archives(&base, &dir);
    let Answer::Ready(_) = fresh.pair_mids("MON/USDC", noon, noon + 60_001.0, now).await.unwrap() else { panic!() };
    assert_eq!(gets(&host).len(), 4, "a new process reads the disk cache");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_unpublished_day_defers_before_any_download() {
    let host = Arc::new(Host::default());
    book_day(&host, "MONUSDT", D, "0.02875", "0.02876");
    let base = serve(host.clone()).await;
    let dir = temp_dir("bybit-pending");
    let a = archives(&base, &dir);
    let t = (D + 43_200_000) as f64;
    let answer = a.pair_mids("MON/USDC", t, t + 60_001.0, D + 86_400_000 + 600_000).await.unwrap();
    assert!(matches!(&answer, Answer::Pending(why) if why.contains("USDCUSDT 2026-09-29")), "{answer:?}");
    assert!(gets(&host).iter().all(|g| !g.contains("USDCUSDT")), "deferred before downloading");
    assert!(matches!(a.pair_mids("SPYx/USDC", t, t + 1.0, D).await.unwrap(), Answer::Unsupported));
    assert!(matches!(a.pair_mids("NOPE/USDC", t, t + 1.0, D).await.unwrap(), Answer::Unsupported));
    // A closed day's asset price: held while the archive may still come, then given up.
    let next = utc_day((D + 86_400_000) as f64);
    let e = a.asset_usd_day("MON", &next, D + 2 * 86_400_000).await.unwrap_err();
    assert_eq!(e, ArchiveError::NotPublished { symbol: "MONUSDT".into(), day: next.clone() });
    assert!(a.asset_usd_day("MON", &next, D + 6 * 86_400_000).await.unwrap().is_none());
    assert!(a.asset_usd_day("SPYx", &next, D).await.unwrap().is_none(), "no keyless xStock archive");
    let mon = a.asset_usd_day("MON", "2026-09-29", D + 2 * 86_400_000).await.unwrap().unwrap();
    assert!((mon.at(t) - 0.028755).abs() < 1e-15);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_binance_day_pages_klines_and_caches_once_final() {
    let host = Arc::new(Host::default());
    // A full day of ETH 1-minute klines drifting 2,400 → 2,543.9, and the
    // next day's first minute (not ours).
    let mut eth: Vec<(i64, f64)> = (0..1440).map(|i| (D + i * MIN, 2_400.0 + i as f64 * 0.1)).collect();
    eth.push((D + 1440 * MIN, 9_999.0));
    host.klines.lock().insert(("ETHUSDT".into(), "1m".into()), eth);
    host.flaky.lock().push("/api/v3/klines".into());
    let base = serve(host.clone()).await;
    let dir = temp_dir("binance-day");
    let a = archives(&base, &dir);
    let px = a.asset_usd_day("ETH", "2026-09-29", D + 2 * 86_400_000).await.unwrap().unwrap();
    assert!((px.at((D + 10 * MIN - 1) as f64) - 2_400.9).abs() < 1e-9, "minute 9's close at its close time");
    assert!((px.at((D + 10 * MIN + 30_000 - 1) as f64) - 2_400.95).abs() < 1e-9, "halfway to the next close");
    assert!((px.at((D + 86_400_000 - 1) as f64) - 2_543.9).abs() < 1e-9, "never the next day's close");
    assert_eq!(px.at(D as f64), 2_400.0, "before the first close: the first price");
    let g = gets(&host);
    assert_eq!(g.len(), 3, "1,440 rows as two slices of a page, and a 500 retried: {g:?}");
    let mut ranges: Vec<String> = g.iter().map(|r| r.split("startTime=").nth(1).unwrap().to_string()).collect();
    ranges.sort();
    ranges.dedup();
    assert_eq!(
        ranges,
        [
            format!("{D}&endTime={}&limit=1000", D + 1_000 * MIN - 1),
            format!("{}&endTime={}&limit=1000", D + 1_000 * MIN, D + 86_400_000 - 1)
        ]
    );
    assert!(dir.join("binance_ETHUSDT_1m_2026-09-29.csv").exists());
    let again = archives(&base, &dir);
    again.asset_usd_day("ETH", "2026-09-29", D + 2 * 86_400_000).await.unwrap().unwrap();
    assert_eq!(gets(&host).len(), 3, "served from the cache");
    // A day still in progress is fetched up to now, and cached nowhere.
    let now = D + 12 * 3_600_000;
    let today = a.binance_day("ETHUSDT", Interval::M1, "2026-09-29", now).await.unwrap();
    assert_eq!(*today.ts.last().unwrap(), (now - 1) as f64, "no kline still open at now");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_binance_pair_reads_1s_base_and_1m_legs() {
    let host = Arc::new(Host::default());
    let noon = D + 43_200_000;
    // BTC prints every second for 10 minutes around noon, then stops.
    let btc: Vec<(i64, f64)> = (-300..300).map(|i| (noon + i * 1_000, 60_000.0 + i as f64)).collect();
    let wbtc: Vec<(i64, f64)> = (0..1440).map(|i| (D + i * MIN, 0.9995)).collect();
    let usdc: Vec<(i64, f64)> = (0..1440).map(|i| (D + i * MIN, 1.0001)).collect();
    host.klines.lock().insert(("BTCUSDT".into(), "1s".into()), btc);
    host.klines.lock().insert(("WBTCBTC".into(), "1m".into()), wbtc);
    host.klines.lock().insert(("USDCUSDT".into(), "1m".into()), usdc);
    let base = serve(host.clone()).await;
    let dir = temp_dir("binance-pair");
    let a = archives(&base, &dir);
    let now = D + 2 * 86_400_000;
    let t = noon as f64;
    let Answer::Ready(s) = a.pair_mids("BTC/USDC", t, t + 60_001.0, now).await.unwrap() else { panic!() };
    // At noon the last close is the kline opened a second earlier.
    assert!((s.at(t).unwrap() - 59_999.0 * 0.9995 / 1.0001).abs() < 1e-9);
    assert!(s.at(t + 299_999.0 + 120_001.0).is_none(), "the base went silent: past its 2-minute cap");
    let Answer::Ready(cb) = a.pair_mids("cbBTC/USDC", t, t + 60_001.0, now).await.unwrap() else { panic!() };
    assert!((cb.at(t + 10_000.0).unwrap() - 60_009.0 / 1.0001).abs() < 1e-9, "cbBTC is at parity: no wrap leg");
    // A day in progress: only the klines the window needs, cached nowhere.
    let today_dir = temp_dir("binance-today");
    let today = archives(&base, &today_dir);
    host.log.lock().clear();
    let Answer::Ready(s2) = today.pair_mids("BTC/USDC", t, t + 60_001.0, noon + 10 * MIN).await.unwrap() else {
        panic!()
    };
    assert_eq!(s2.at(t + 30_000.0), s.at(t + 30_000.0));
    let g = gets(&host);
    assert_eq!(g.len(), 3, "a page per leg: {g:?}");
    assert!(g.iter().all(|r| !r.contains(&format!("startTime={D}&"))), "not from midnight: {g:?}");
    assert_eq!(std::fs::read_dir(&today_dir).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&today_dir);
}

#[tokio::test]
async fn slices_fetched_side_by_side_are_the_pages_fetched_in_turn() {
    let host = Arc::new(Host::default());
    // Two hours of 1-second klines with seconds missing (no trade) and a
    // 20-minute hole: pages and slices cover different open times.
    let rows: Vec<(i64, f64)> = (0..7_200)
        .filter(|i| i % 7 != 3 && !(2_000..3_200).contains(i))
        .map(|i| (D + i * 1_000, 60_000.0 + i as f64))
        .collect();
    host.klines.lock().insert(("BTCUSDT".into(), "1s".into()), rows.clone());
    let base = serve(host.clone()).await;
    let http = Http::new(1, Duration::ZERO);
    let r = binance::Range { symbol: "BTCUSDT", interval: Interval::S1, from: D, to: D + 7_200_000 - 1 };
    let now = D + 86_400_000;
    let one = binance::closes(&http, &base, r, now, Duration::ZERO).await.unwrap();
    let pages = gets(&host).len();
    let many = binance::closes_sliced(&http, &base, r, now, Duration::ZERO, 4).await.unwrap();
    assert_eq!(one, many);
    assert_eq!(one.len(), rows.len());
    assert_eq!(one.ts[0], (D + 999) as f64, "stamped at the close time");
    assert_eq!(gets(&host).len() - pages, 8, "one page per 1,000 seconds");
    let gzipped = host.gzipped.load(std::sync::atomic::Ordering::Relaxed);
    assert_eq!(gzipped, gets(&host).len(), "every page asked for, and inflated from, gzip");
}
