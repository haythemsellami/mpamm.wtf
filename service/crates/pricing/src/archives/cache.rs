//! The archives' disk cache: one file per source and UTC day, holding only
//! the reduced points (`<ms>,<price>` lines; `NaN` = outage). A Bybit day is
//! ~2 MB of points against ~50 MB of book messages, so every market and
//! trade of that day shares one download. Bybit days keep today's file names
//! (`<SYMBOL>_<day>.bbo-mid.csv`), so a cache written by today's service can
//! be reused as is. Writes go to a `.part` file renamed into place: a crash
//! never leaves a truncated day.
//!
//! Only final days are written (a published Bybit day, a Binance day whose
//! last kline has closed); parsed days are also kept in memory, a few at a
//! time.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::Mutex;

use super::{binance::Interval, series::Points, ArchiveError};

pub fn bybit_path(dir: &Path, symbol: &str, day: &str) -> PathBuf {
    dir.join(format!("{symbol}_{day}.bbo-mid.csv"))
}

pub fn binance_path(dir: &Path, symbol: &str, interval: Interval, day: &str) -> PathBuf {
    dir.join(format!("binance_{symbol}_{}_{day}.csv", interval.as_str()))
}

fn io_err(path: &Path, e: std::io::Error) -> ArchiveError {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    ArchiveError::Io(format!("archive cache {name}: {e}"))
}

/// The cached points, `None` when the day isn't cached. A line that doesn't
/// parse fails the read (the file is the one written below, or a copy of
/// today's).
pub fn read(path: &Path) -> Result<Option<Points>, ArchiveError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(path, e)),
    };
    let mut p = Points::default();
    for row in text.lines() {
        let Some((t, px)) = row.split_once(',') else { continue };
        let t: f64 = t.parse().map_err(|_| io_err(path, std::io::Error::other(format!("bad row {row}"))))?;
        let px: f64 = if px == "NaN" {
            f64::NAN
        } else {
            px.parse().map_err(|_| io_err(path, std::io::Error::other(format!("bad row {row}"))))?
        };
        p.push(t, px);
    }
    Ok(Some(p))
}

pub fn write(path: &Path, p: &Points) -> Result<(), ArchiveError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| io_err(path, e))?;
    }
    let mut out = String::with_capacity(p.len() * 24);
    for (t, px) in p.ts.iter().zip(&p.px) {
        use std::fmt::Write;
        // Shortest round-trip text, as JavaScript writes numbers.
        let _ = writeln!(out, "{t},{px}");
    }
    let part = path.with_extension("csv.part");
    std::fs::write(&part, out).map_err(|e| io_err(path, e))?;
    std::fs::rename(&part, path).map_err(|e| io_err(path, e))
}

/// Recently parsed days by cache path: a sweep marks every market of a day,
/// and each reads the same legs.
pub struct Memo {
    days: Mutex<VecDeque<(PathBuf, Arc<Points>)>>,
    cap: usize,
}

impl Memo {
    pub fn new(cap: usize) -> Self {
        Self { days: Mutex::new(VecDeque::new()), cap }
    }

    pub fn get(&self, path: &Path) -> Option<Arc<Points>> {
        let mut days = self.days.lock();
        let i = days.iter().position(|(p, _)| p == path)?;
        let hit = days.remove(i)?;
        let pts = hit.1.clone();
        days.push_back(hit); // most recent last
        Some(pts)
    }

    pub fn put(&self, path: PathBuf, pts: Arc<Points>) -> Arc<Points> {
        let mut days = self.days.lock();
        days.retain(|(p, _)| p != &path);
        days.push_back((path, pts.clone()));
        while days.len() > self.cap {
            days.pop_front();
        }
        pts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_points_outages_included() {
        let dir = super::super::tests::temp_dir("cache-roundtrip");
        let path = bybit_path(&dir, "MONUSDT", "2026-09-29");
        assert_eq!(read(&path).unwrap(), None);
        let mut p = Points::default();
        p.push(1_790_640_001_000.0, 0.028505);
        p.push(1_790_640_002_000.0, f64::NAN);
        p.push(1_790_640_003_000.0, 1.25e308);
        write(&path, &p).unwrap();
        let back = read(&path).unwrap().unwrap();
        assert_eq!(back.ts, p.ts);
        assert_eq!(back.px[0], 0.028505);
        assert!(back.px[1].is_nan());
        assert_eq!(back.px[2], 1.25e308);
        // Today's service writes JavaScript's number text; it reads the same.
        std::fs::write(&path, "1790640001000,0.028505\n1790640002000,NaN\n1790640003000,1.25e+308\n").unwrap();
        let ts_written = read(&path).unwrap().unwrap();
        assert_eq!(ts_written.px[2], 1.25e308);
        assert!(!dir.join("MONUSDT_2026-09-29.bbo-mid.csv.part").exists());
        std::fs::write(&path, "1790640001000,zero\n").unwrap();
        assert!(read(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_memo_keeps_the_most_recent_days() {
        let m = Memo::new(2);
        let p = |n: f64| {
            let mut x = Points::default();
            x.push(n, n);
            Arc::new(x)
        };
        m.put("a".into(), p(1.0));
        m.put("b".into(), p(2.0));
        assert!(m.get(Path::new("a")).is_some(), "a is now the most recent");
        m.put("c".into(), p(3.0));
        assert!(m.get(Path::new("b")).is_none(), "b was the oldest");
        assert!(m.get(Path::new("a")).is_some() && m.get(Path::new("c")).is_some());
    }
}
