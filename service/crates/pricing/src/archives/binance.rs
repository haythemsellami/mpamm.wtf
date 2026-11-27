//! Binance klines through the public data mirror (geo-unrestricted), ported
//! from server/src/history/cex.ts (`binanceKlineCloses`).
//!
//! 1-second klines are the base series for BTC, ETH and XAUt (a last trade,
//! but on a tick of ~0.001 bp). Cross (USDCUSDT) and wrap (WBTCBTC) legs move
//! about a bp an hour, so 1-minute klines are ample for them, and for a
//! closed day's asset price joined between closes. Every kline is stamped at
//! its close time with its close.

use std::time::Duration;

use serde_json::Value;

use super::{series::Points, ArchiveError, Http};

pub const DEFAULT_URL: &str = "https://data-api.binance.vision";
const PAGE: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Interval {
    S1,
    M1,
}

impl Interval {
    pub fn as_str(self) -> &'static str {
        match self {
            Interval::S1 => "1s",
            Interval::M1 => "1m",
        }
    }

    pub fn ms(self) -> i64 {
        match self {
            Interval::S1 => 1_000,
            Interval::M1 => 60_000,
        }
    }
}

/// One kline as the archive needs it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Kline {
    pub open_time: i64,
    pub close_time: i64,
    pub close: f64,
}

fn ms(v: &Value) -> Option<i64> {
    v.as_i64()
}

/// A `/api/v3/klines` body: `[[openTime, open, high, low, close, volume,
/// closeTime, …], …]`. Unlike today's `parseFloat`, a close that isn't a
/// number fails the page instead of becoming a NaN point (which would read
/// as an outage): a broken answer is retried, never stored.
pub fn parse_klines(body: &str) -> Result<Vec<Kline>, ArchiveError> {
    let bad = |why: String| ArchiveError::Corrupt(format!("binance klines: {why}"));
    let rows: Value = serde_json::from_str(body).map_err(|e| bad(format!("unparseable ({e})")))?;
    let rows = rows.as_array().ok_or_else(|| bad("not an array".into()))?;
    rows.iter()
        .map(|k| {
            let row = k.as_array().filter(|r| r.len() >= 7).ok_or_else(|| bad(format!("bad row {k}")))?;
            let close = row[4].as_str().and_then(|s| s.parse::<f64>().ok()).filter(|c| c.is_finite() && *c > 0.0);
            match (ms(&row[0]), ms(&row[6]), close) {
                (Some(open_time), Some(close_time), Some(close)) => Ok(Kline { open_time, close_time, close }),
                _ => Err(bad(format!("bad row {k}"))),
            }
        })
        .collect()
}

pub fn url(base: &str, symbol: &str, interval: Interval, start: i64, end: i64) -> String {
    format!(
        "{base}/api/v3/klines?symbol={symbol}&interval={}&startTime={start}&endTime={end}&limit={PAGE}",
        interval.as_str()
    )
}

/// Klines of one symbol opened in [from, to] (both ms; `to` inclusive, as
/// the API's `endTime`).
#[derive(Debug, Clone, Copy)]
pub struct Range<'a> {
    pub symbol: &'a str,
    pub interval: Interval,
    pub from: i64,
    pub to: i64,
}

/// Every kline in `r`, a page of 1000 at a time, `pace` apart. Closes are
/// returned stamped at their close times; a kline still open at `now_ms` is
/// left out (its close is not final).
pub async fn closes(
    http: &Http,
    base: &str,
    r: Range<'_>,
    now_ms: i64,
    pace: Duration,
) -> Result<Points, ArchiveError> {
    let Range { symbol, interval, from, to } = r;
    let mut out = Points::default();
    let mut start = from;
    while start < to {
        let body = http
            .get_text(&url(base, symbol, interval, start, to), &format!("binance {symbol} {}", interval.as_str()))
            .await?;
        let rows = parse_klines(&body)?;
        let Some(last) = rows.last() else { break };
        let last_open = last.open_time;
        for k in &rows {
            if k.close_time <= now_ms && (out.ts.last().is_none_or(|&t| (k.close_time as f64) > t)) {
                out.push(k.close_time as f64, k.close);
            }
        }
        if last_open <= start && rows.len() < PAGE {
            break;
        }
        start = last_open + interval.ms();
        if rows.len() < PAGE && start < to {
            break; // the exchange has nothing more in range
        }
        tokio::time::sleep(pace).await;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recorded_klines() {
        // Recorded from the data mirror: BTCUSDT 1s from 2026-11-26 12:00:00.
        let body = include_str!("../../tests/fixtures/binance-BTCUSDT-1s-2026-11-26T12.json");
        let k = parse_klines(body).unwrap();
        assert_eq!(k.len(), 5);
        assert_eq!(k[0], Kline { open_time: 1_795_694_400_000, close_time: 1_795_694_400_999, close: 60_698.26 });
        assert!(k.windows(2).all(|w| w[1].open_time == w[0].open_time + 1_000));
        let body = include_str!("../../tests/fixtures/binance-USDCUSDT-1m-2026-11-26T12.json");
        let k = parse_klines(body).unwrap();
        assert_eq!(k.len(), 4, "endTime is inclusive of the kline opening at it");
        assert_eq!(k[3], Kline { open_time: 1_795_694_580_000, close_time: 1_795_694_639_999, close: 1.00111 });
    }

    #[test]
    fn a_broken_page_fails_instead_of_becoming_an_outage() {
        assert!(parse_klines("[]").unwrap().is_empty());
        for bad in [
            "{}",
            "[[1,\"1\",\"1\",\"1\",\"x\",\"1\",2]]",
            "[[1,\"1\",\"1\",\"1\",\"0\",\"1\",2]]",
            "[[1,\"1\",\"1\",\"1\",1.5,\"1\",2]]",
            "[[\"1\",\"1\",\"1\",\"1\",\"1\",\"1\",2]]",
            "[[1,\"1\"]]",
            "not json",
        ] {
            assert!(parse_klines(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn urls_name_the_page() {
        assert_eq!(
            url(DEFAULT_URL, "BTCUSDT", Interval::S1, 10, 20),
            "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=10&endTime=20&limit=1000"
        );
    }
}
