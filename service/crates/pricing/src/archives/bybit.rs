//! Bybit's daily order-book archives reduced to a BBO-mid curve, ported from
//! server/src/history/cex.ts (`reduceBookMids`, `zipEntryReader`).
//!
//! Bybit's keyless data host publishes each spot symbol's `orderbook.200`
//! stream (a snapshot, then absolute-size deltas, every ~10 ms) as one zip per
//! UTC day, the next day (usually ~00:00–00:05 UTC, at times hours later).
//! The mid, not a trade print, on purpose: MONUSDT's tick is several bp, and
//! the last trade sits on whichever side the flow hit, flow correlated with
//! the trade being marked. It is the same quantity the live reference reads.
//!
//! The replay is strict: a line it can't parse, a malformed level or a gap in
//! the update id fails the whole day (a skipped delta would corrupt the book
//! until the next snapshot, and the archive has about two a day). The zip is
//! checked against its central directory before any of it is trusted.

use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read},
};

use serde_json::Value;

use super::{series::Points, ArchiveError};

pub const DEFAULT_URL: &str = "https://quote-saver.bycsi.com";
const DAY_MS: i64 = 86_400_000;

/// A carry-forward point is re-emitted at least this often while messages
/// arrive, so an unchanged mid on a ticking book never reads as stale. A book
/// that doesn't change at all publishes nothing (see the slow cap).
pub const BOOK_HEARTBEAT_MS: i64 = 5_000;

/// The day's archive under `base` (`YYYY-MM-DD`).
pub fn url(base: &str, symbol: &str, day: &str) -> String {
    format!("{base}/orderbook/spot/{symbol}/{day}_{symbol}_ob200.data.zip")
}

/// `^\d+(\.\d+)?$`: Bybit writes every price and size as a plain decimal
/// string, matched strictly (no sign, exponent, hex or empty text).
fn is_decimal(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.is_none_or(digits)
}

/// `^0+(\.0+)?$`.
fn is_zero_text(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    let zeros = |x: &str| !x.is_empty() && x.bytes().all(|b| b == b'0');
    zeros(int) && frac.is_none_or(zeros)
}

/// A JSON integer (ms timestamp, update id): a real number, never a string.
fn int(v: &Value) -> Option<i64> {
    const MAX_SAFE: i64 = (1 << 53) - 1;
    let n = v
        .as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64).map(|f| f as i64))?;
    (n.abs() <= MAX_SAFE).then_some(n)
}

/// `[[price, size], …]`: price > 0, size ≥ 0 (0 removes the level), both
/// decimal strings. The converted values are checked too: an overlong digit
/// string becomes infinity, and a nonzero size can underflow to 0 (a silent
/// delete unless it was written as 0).
fn levels(raw: Option<&Value>, bad: &dyn Fn(String) -> ArchiveError) -> Result<Vec<(f64, f64)>, ArchiveError> {
    let Some(arr) = raw.and_then(Value::as_array) else { return Err(bad("levels not an array".into())) };
    arr.iter()
        .map(|lv| {
            let pair = lv.as_array().filter(|a| a.len() >= 2);
            let (p, s) = match pair {
                Some(a) => (a[0].as_str(), a[1].as_str()),
                None => (None, None),
            };
            let (Some(p), Some(s)) = (p.filter(|p| is_decimal(p)), s.filter(|s| is_decimal(s))) else {
                return Err(bad(format!("bad level {lv}")));
            };
            let (pv, sv) = (p.parse::<f64>().unwrap_or(f64::NAN), s.parse::<f64>().unwrap_or(f64::NAN));
            if !(pv.is_finite() && pv > 0.0) || !sv.is_finite() || (sv == 0.0 && !is_zero_text(s)) {
                return Err(bad(format!("bad level {lv}")));
            }
            Ok((pv, sv))
        })
        .collect()
}

/// A price as an ordered map key: positive finite floats order as their bits.
fn key(p: f64) -> u64 {
    p.to_bits()
}

/// Replays one day's book messages to its BBO-mid curve over
/// [day_start, day_start + 1 day), stamped with Bybit's send time (`ts`, what
/// the live feed receives, not the engine's `cts`). Book order is file order
/// (= update-id order); `ts` only orders the emitted points, so a regressed
/// `ts` is applied but not emitted. A one-sided or crossed book is an outage:
/// one NaN point, and the next valid mid is emitted at once.
pub fn reduce_book_mids(
    lines: impl Iterator<Item = std::io::Result<String>>,
    symbol: &str,
    day_start: i64,
) -> Result<Points, ArchiveError> {
    let day_end = day_start + DAY_MS;
    let topic = format!("orderbook.200.{symbol}");
    let mut bids: BTreeMap<u64, f64> = BTreeMap::new();
    let mut asks: BTreeMap<u64, f64> = BTreeMap::new();
    let mut out = Points::default();
    let (mut last_mid, mut last_t) = (f64::NAN, i64::MIN);
    let (mut synced, mut last_u) = (false, 0i64);
    for line in lines {
        let line = line.map_err(|e| ArchiveError::Corrupt(format!("bybit book archive {symbol}: {e}")))?;
        if line.is_empty() {
            continue;
        }
        let head: String = line.chars().take(80).collect();
        let bad = |why: String| ArchiveError::Corrupt(format!("bybit book archive {symbol}: {why} in {head}"));
        // The whole message is validated before it touches the book: a
        // parseable but malformed record applied first would leak into every
        // later mid.
        let m: Value = serde_json::from_str(&line).map_err(|e| bad(format!("unparseable line ({e})")))?;
        let data = m.get("data").filter(|d| !d.is_null());
        if m.get("topic").and_then(Value::as_str) != Some(topic.as_str()) || data.is_none() {
            return Err(bad("unexpected message".into()));
        }
        let data = data.unwrap();
        let snapshot = match m.get("type").and_then(Value::as_str) {
            Some("snapshot") => true,
            Some("delta") => false,
            other => return Err(bad(format!("unknown type {}", other.unwrap_or("?")))),
        };
        let t = match m.get("ts").and_then(int) {
            Some(t) if t > 0 => t,
            _ => return Err(bad("bad ts".into())),
        };
        let b = levels(data.get("b"), &bad)?;
        let a = levels(data.get("a"), &bad)?;
        let Some(u) = data.get("u").and_then(int) else { return Err(bad("bad update id".into())) };
        if snapshot {
            bids.clear();
            asks.clear();
            synced = true;
        } else if !synced {
            continue; // deltas only mean something on top of a snapshot
        } else if u != last_u + 1 {
            return Err(bad(format!("update id gap {last_u} → {u}")));
        }
        last_u = u;
        for (p, s) in b {
            if s == 0.0 {
                bids.remove(&key(p));
            } else {
                bids.insert(key(p), s);
            }
        }
        for (p, s) in a {
            if s == 0.0 {
                asks.remove(&key(p));
            } else {
                asks.insert(key(p), s);
            }
        }
        // The file overlaps its neighbours by a few seconds: keep only its own
        // day, so concatenated days stay sorted.
        if !(t >= day_start && t < day_end) || t < last_t {
            continue;
        }
        let best = (bids.keys().next_back(), asks.keys().next());
        let mid = match best {
            // Never overflows: 0 < bb < ba, both finite.
            (Some(&bb), Some(&ba)) if bb < ba => {
                let (bb, ba) = (f64::from_bits(bb), f64::from_bits(ba));
                bb + (ba - bb) / 2.0
            }
            _ => {
                // One-sided or crossed: no honest mid. One NaN point, so the
                // last mid isn't carried through the outage.
                if !last_mid.is_nan() {
                    out.push(t as f64, f64::NAN);
                    (last_mid, last_t) = (f64::NAN, t);
                }
                continue;
            }
        };
        if mid != last_mid || t.saturating_sub(last_t) >= BOOK_HEARTBEAT_MS {
            out.push(t as f64, mid);
            (last_mid, last_t) = (mid, t);
        }
    }
    Ok(out)
}

/// CRC-32 and size of everything read through it.
struct Tap<R> {
    inner: R,
    crc: crc32fast::Hasher,
    size: u64,
}

impl<R: Read> Read for Tap<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.crc.update(&buf[..n]);
        self.size += n as u64;
        Ok(n)
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// The one entry of an archive zip: where its deflate data starts, and the
/// CRC-32 and size its central directory records. The archives set the
/// data-descriptor flag (local header sizes zeroed), so the directory at the
/// end of the body is the only place they live; a body cut short has none.
struct Entry {
    data_start: usize,
    crc: u32,
    size: u32,
}

fn entry(zip: &[u8], label: &str) -> Result<Entry, ArchiveError> {
    let bad = |why: &str| ArchiveError::Corrupt(format!("{label}: {why}"));
    if zip.len() < 30 || u32_at(zip, 0) != 0x0403_4b50 {
        return Err(bad("not a zip"));
    }
    let method = u16_at(zip, 8);
    if method != 8 {
        return Err(bad(&format!("zip method {method} unsupported")));
    }
    let data_start = 30 + usize::from(u16_at(zip, 26)) + usize::from(u16_at(zip, 28));
    // End of central directory: the last 22 bytes, or before a comment of up
    // to 64 KiB.
    let lowest = zip.len().saturating_sub(22 + 65_535);
    let eocd = (lowest..=zip.len().saturating_sub(22))
        .rev()
        .find(|&i| zip.len() >= i + 22 && u32_at(zip, i) == 0x0605_4b50)
        .ok_or_else(|| bad("zip directory missing (truncated body?)"))?;
    if u16_at(zip, eocd + 10) != 1 {
        return Err(bad("expected a single-entry zip"));
    }
    let cd = u32_at(zip, eocd + 16) as usize;
    if cd + 46 > eocd || u32_at(zip, cd) != 0x0201_4b50 {
        return Err(bad("zip directory unreadable"));
    }
    let (crc, size) = (u32_at(zip, cd + 16), u32_at(zip, cd + 24));
    if size == u32::MAX {
        return Err(bad("zip64 entry unsupported"));
    }
    if data_start > cd {
        return Err(bad("zip entry overlaps its directory"));
    }
    Ok(Entry { data_start, crc, size })
}

/// Replays a downloaded day's zip (`zip`, the whole body) to its BBO-mid
/// curve, streaming the inflated text line by line, and checks the entry's
/// CRC-32 and size against the central directory before returning anything.
/// A valid zip that replays to no in-day two-sided book is unusable (caching
/// it empty would defer every later read on it for ever).
pub fn replay_zip(zip: &[u8], symbol: &str, day: &str, day_start: i64) -> Result<Points, ArchiveError> {
    let label = format!("bybit book archive {symbol} {day}");
    let e = entry(zip, &label)?;
    let mut tap =
        Tap { inner: flate2::read::DeflateDecoder::new(&zip[e.data_start..]), crc: crc32fast::Hasher::new(), size: 0 };
    let pts = reduce_book_mids(BufReader::new(&mut tap).lines(), symbol, day_start)?;
    // Whatever reduce stopped short of still counts toward the CRC.
    std::io::copy(&mut tap, &mut std::io::sink()).map_err(|err| ArchiveError::Corrupt(format!("{label}: {err}")))?;
    if tap.crc.finalize() != e.crc || tap.size != u64::from(e.size) {
        return Err(ArchiveError::Corrupt(format!("{label}: zip CRC/size mismatch (corrupt download)")));
    }
    if pts.is_empty() {
        return Err(ArchiveError::Corrupt(format!("{label}: replayed to no in-day BBO — unusable archive")));
    }
    Ok(pts)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use super::*;

    pub const D: i64 = 1_790_640_000_000; // 2026-09-29

    /// A message in the archive's format; `u` counts up across messages.
    pub fn msg(sym: &str, ts: i64, kind: &str, b: &[(&str, &str)], a: &[(&str, &str)], u: i64) -> String {
        serde_json::json!({ "topic": format!("orderbook.200.{sym}"), "ts": ts, "type": kind,
            "data": { "s": sym, "b": b, "a": a, "u": u, "seq": u }, "cts": ts - 10 })
        .to_string()
    }

    /// A zip in the archive's exact layout: one deflated entry, data
    /// descriptor flag set (sizes zeroed locally, real ones in the descriptor
    /// and the central directory).
    pub fn zip(name: &str, body: &str, crc_override: Option<u32>) -> Vec<u8> {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(body.as_bytes()).unwrap();
        let def = enc.finish().unwrap();
        let crc = crc_override.unwrap_or_else(|| crc32fast::hash(body.as_bytes()));
        let n = name.as_bytes();
        let mut out = Vec::new();
        let le16 = |v: &mut Vec<u8>, x: u16| v.extend_from_slice(&x.to_le_bytes());
        let le32 = |v: &mut Vec<u8>, x: u32| v.extend_from_slice(&x.to_le_bytes());
        le32(&mut out, 0x0403_4b50);
        for x in [20u16, 0x0008, 8, 0, 0] {
            le16(&mut out, x);
        }
        for _ in 0..3 {
            le32(&mut out, 0);
        }
        le16(&mut out, n.len() as u16);
        le16(&mut out, 0);
        out.extend_from_slice(n);
        out.extend_from_slice(&def);
        le32(&mut out, 0x0807_4b50);
        le32(&mut out, crc);
        le32(&mut out, def.len() as u32);
        le32(&mut out, body.len() as u32);
        let cd_offset = out.len() as u32;
        le32(&mut out, 0x0201_4b50);
        for x in [20u16, 20, 0x0008, 8, 0, 0] {
            le16(&mut out, x);
        }
        le32(&mut out, crc);
        le32(&mut out, def.len() as u32);
        le32(&mut out, body.len() as u32);
        le16(&mut out, n.len() as u16);
        for _ in 0..4 {
            le16(&mut out, 0);
        }
        le32(&mut out, 0);
        le32(&mut out, 0);
        out.extend_from_slice(n);
        let cd_len = out.len() as u32 - cd_offset;
        le32(&mut out, 0x0605_4b50);
        for x in [0u16, 0, 1, 1] {
            le16(&mut out, x);
        }
        le32(&mut out, cd_len);
        le32(&mut out, cd_offset);
        le16(&mut out, 0);
        out
    }

    fn reduce(lines: &[String]) -> Result<Points, ArchiveError> {
        reduce_book_mids(lines.iter().map(|l| Ok(l.clone())), "MONUSDT", D)
    }

    fn rounded(p: &Points) -> Vec<String> {
        p.px.iter().map(|x| if x.is_nan() { "outage".into() } else { format!("{x:.6}") }).collect()
    }

    #[test]
    fn replays_snapshot_and_deltas_into_the_bbo_mid() {
        let l = [
            msg("MONUSDT", D - 1_000, "snapshot", &[("0.02840", "5")], &[("0.02842", "5")], 1), // previous day: dropped
            msg(
                "MONUSDT",
                D + 1_000,
                "snapshot",
                &[("0.02850", "10"), ("0.02849", "10")],
                &[("0.02851", "10"), ("0.02852", "10")],
                2,
            ),
            msg("MONUSDT", D + 2_000, "delta", &[("0.02850", "7")], &[], 3), // size only: same mid
            msg("MONUSDT", D + 3_000, "delta", &[], &[("0.02851", "0")], 4), // best ask gone
            msg("MONUSDT", D + 4_000, "delta", &[("0.02851", "3")], &[], 5), // bid improves
            msg("MONUSDT", D + 9_100, "delta", &[("0.02849", "1")], &[], 6), // quiet mid: heartbeat
            msg("MONUSDT", D + 86_400_500, "delta", &[("0.02860", "1")], &[], 7), // next day: dropped
        ];
        let p = reduce(&l).unwrap();
        assert_eq!(p.ts, vec![(D + 1_000) as f64, (D + 3_000) as f64, (D + 4_000) as f64, (D + 9_100) as f64]);
        assert_eq!(rounded(&p), ["0.028505", "0.028510", "0.028515", "0.028515"]);
    }

    #[test]
    fn rejects_malformed_records_before_they_touch_the_book() {
        let snap = msg("MONUSDT", D + 1_000, "snapshot", &[("0.0285", "1")], &[("0.0286", "1")], 1);
        let raw = |patch: serde_json::Value| {
            let mut m = serde_json::json!({ "topic": "orderbook.200.MONUSDT", "ts": D + 2_000, "type": "delta",
                "data": { "b": [], "a": [], "u": 2 } });
            for (k, v) in patch.as_object().unwrap() {
                m[k] = v.clone();
            }
            m.to_string()
        };
        let lv = |b: serde_json::Value| raw(serde_json::json!({ "data": { "b": b, "a": [], "u": 2 } }));
        let cases = [
            (raw(serde_json::json!({ "type": "update" })), "unknown type"),
            (raw(serde_json::json!({ "ts": "soon" })), "bad ts"),
            (raw(serde_json::json!({ "ts": null })), "bad ts"),
            (raw(serde_json::json!({ "ts": (D + 2_000).to_string() })), "bad ts"),
            (lv(serde_json::json!([["0.0287", "x"]])), "bad level"),
            (lv(serde_json::json!([["-1", "1"]])), "bad level"),
            (lv(serde_json::json!([["0.0287"]])), "bad level"),
            (raw(serde_json::json!({ "data": { "a": [], "u": 2 } })), "not an array"),
            (lv(serde_json::json!([["0.0285", ""]])), "bad level"),
            (lv(serde_json::json!([["0.0285", null]])), "bad level"),
            (lv(serde_json::json!([["0.0285", true]])), "bad level"),
            (lv(serde_json::json!([["0x1f", "1"]])), "bad level"),
            (lv(serde_json::json!([["1e-2", "1"]])), "bad level"),
            (lv(serde_json::json!([[0.0285, "1"]])), "bad level"),
            (lv(serde_json::json!([["9".repeat(400), "1"]])), "bad level"),
            (lv(serde_json::json!([["0.0285", "9".repeat(400)]])), "bad level"),
            (lv(serde_json::json!([["0.0285", format!("0.{}1", "0".repeat(400))]])), "bad level"),
            (lv(serde_json::json!([["0.000", "1"]])), "bad level"),
            (raw(serde_json::json!({ "data": { "b": [], "a": [], "u": null } })), "bad update id"),
            (raw(serde_json::json!({ "data": { "b": [], "a": [], "u": "2" } })), "bad update id"),
            (msg("USDCUSDT", D + 2_000, "delta", &[], &[], 2), "unexpected message"),
            ("{\"topic\":\"orderbook.200.MON".to_string(), "unparseable"),
        ];
        for (bad, why) in cases {
            let e = reduce(&[snap.clone(), bad.clone()]).unwrap_err().to_string();
            assert!(e.contains(why), "{bad}: {e}");
        }
    }

    #[test]
    fn a_gap_in_the_update_id_fails_and_each_snapshot_rebases() {
        let snap = |t: i64, u: i64| msg("MONUSDT", D + t, "snapshot", &[("0.0285", "1")], &[("0.0286", "1")], u);
        let delta = |t: i64, u: i64| msg("MONUSDT", D + t, "delta", &[("0.0285", "2")], &[], u);
        let e = reduce(&[snap(1_000, 10), delta(2_000, 11), delta(3_000, 13)]).unwrap_err().to_string();
        assert!(e.contains("update id gap 11 → 13"), "{e}");
        let p = reduce(&[snap(1_000, 10), delta(2_000, 11), snap(3_000, 500), delta(4_000, 501)]).unwrap();
        assert_eq!(p.ts, vec![(D + 1_000) as f64]);
    }

    #[test]
    fn a_regressed_ts_is_applied_but_not_emitted() {
        let p = reduce(&[
            msg("MONUSDT", D + 5_000, "snapshot", &[("0.0285", "1")], &[("0.0286", "1")], 1),
            msg("MONUSDT", D + 4_000, "delta", &[("0.02855", "1")], &[], 2),
            msg("MONUSDT", D + 6_000, "delta", &[("0.02840", "1")], &[], 3),
        ])
        .unwrap();
        assert_eq!(p.ts, vec![(D + 5_000) as f64, (D + 6_000) as f64]);
        assert_eq!(rounded(&p), ["0.028550", "0.028575"]);
    }

    #[test]
    fn a_one_sided_or_crossed_book_is_an_outage() {
        let p = reduce(&[
            msg("MONUSDT", D + 1_000, "snapshot", &[("0.02850", "1")], &[("0.02851", "1")], 1),
            msg("MONUSDT", D + 2_000, "delta", &[], &[("0.02851", "0")], 2),
            msg("MONUSDT", D + 3_000, "delta", &[("0.02849", "1")], &[], 3),
            msg("MONUSDT", D + 4_000, "delta", &[], &[("0.02851", "1")], 4),
            msg("MONUSDT", D + 5_000, "delta", &[("0.02852", "1")], &[], 5),
            msg("MONUSDT", D + 6_000, "delta", &[("0.02852", "0")], &[], 6),
        ])
        .unwrap();
        assert_eq!(p.ts, [1_000, 2_000, 4_000, 5_000, 6_000].map(|t| (D + t) as f64));
        assert_eq!(rounded(&p), ["0.028505", "outage", "0.028505", "outage", "0.028505"]);
    }

    #[test]
    fn the_mid_stays_finite_where_bid_plus_ask_would_overflow() {
        let big = |lead: &str| format!("{lead}{}", "0".repeat(309 - lead.len()));
        let (b, a) = (big("1"), big("15"));
        let p = reduce(&[msg("MONUSDT", D + 1_000, "snapshot", &[(&b, "1")], &[(&a, "1")], 1)]).unwrap();
        assert_eq!(p.px, vec![1.25e308]);
    }

    #[test]
    fn deltas_before_the_first_snapshot_are_ignored() {
        let p = reduce(&[
            msg("MONUSDT", D + 1_000, "delta", &[("0.0285", "1")], &[("0.0286", "1")], 1),
            msg("MONUSDT", D + 2_000, "snapshot", &[("0.0284", "1")], &[("0.0285", "1")], 2),
        ])
        .unwrap();
        assert_eq!(p.ts, vec![(D + 2_000) as f64]);
    }

    fn day_zip(lines: &[String], crc: Option<u32>) -> Vec<u8> {
        zip("2026-09-29_MONUSDT_ob200.data", &(lines.join("\n") + "\n"), crc)
    }

    #[test]
    fn the_zip_is_checked_against_its_directory() {
        let lines = [msg("MONUSDT", D + 3_000, "snapshot", &[("0.0285", "1")], &[("0.0286", "1")], 1)];
        let good = day_zip(&lines, None);
        let p = replay_zip(&good, "MONUSDT", "2026-09-29", D).unwrap();
        assert_eq!(p.px, vec![0.02855]);
        let name_len = usize::from(u16_at(&good, 26));
        let cut = &good[..30 + name_len + 4];
        assert!(replay_zip(cut, "MONUSDT", "2026-09-29", D).unwrap_err().to_string().contains("directory missing"));
        let tail_cut = &good[..good.len() - 30];
        assert!(replay_zip(tail_cut, "MONUSDT", "2026-09-29", D).unwrap_err().to_string().contains("directory"));
        let bad_crc = day_zip(&lines, Some(0xdead_beef));
        assert!(replay_zip(&bad_crc, "MONUSDT", "2026-09-29", D).unwrap_err().to_string().contains("CRC"));
        let no_snapshot =
            day_zip(&[msg("MONUSDT", D + 1_000, "delta", &[("0.0285", "1")], &[("0.0286", "1")], 1)], None);
        assert!(replay_zip(&no_snapshot, "MONUSDT", "2026-09-29", D)
            .unwrap_err()
            .to_string()
            .contains("unusable archive"));
        assert!(replay_zip(b"PK\x05\x06", "MONUSDT", "2026-09-29", D).unwrap_err().to_string().contains("not a zip"));
    }

    #[test]
    fn a_bad_line_stops_the_replay_and_still_reports_corruption_first() {
        // A line the replay rejects fails the day even inside a valid zip.
        let lines = [
            msg("MONUSDT", D + 1_000, "snapshot", &[("0.0285", "1")], &[("0.0286", "1")], 1),
            msg("MONUSDT", D + 2_000, "delta", &[("0.0285", "2")], &[], 3),
        ];
        let e = replay_zip(&day_zip(&lines, None), "MONUSDT", "2026-09-29", D).unwrap_err().to_string();
        assert!(e.contains("update id gap"), "{e}");
    }

    #[test]
    fn decimal_text_is_matched_strictly() {
        for ok in ["0", "12", "0.5", "00.000", "123.456"] {
            assert!(is_decimal(ok), "{ok}");
        }
        for bad in ["", ".5", "5.", "-1", "+1", "1e3", "0x1f", "1.2.3", " 1", "NaN"] {
            assert!(!is_decimal(bad), "{bad}");
        }
        assert!(is_zero_text("0") && is_zero_text("000.00") && !is_zero_text("0.01") && !is_zero_text(""));
    }
}
