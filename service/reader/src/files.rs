//! The reader's files: daily `blocks-YYYY-MM-DD.jsonl` and
//! `summary-YYYY-MM-DD.jsonl` (UTC), a retention sweep, and two small files
//! rewritten atomically: `cursor.json` (where to resume) and `health.json`.

use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

pub struct Files {
    dir: PathBuf,
    keep_days: u32,
    day: NaiveDate,
    blocks: BufWriter<File>,
    summary: File,
}

fn open_append(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

impl Files {
    pub fn open(dir: &Path, keep_days: u32, now: DateTime<Utc>) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let day = now.date_naive();
        let (blocks, summary) = Self::open_day(dir, day)?;
        let mut files = Self { dir: dir.to_path_buf(), keep_days, day, blocks: BufWriter::new(blocks), summary };
        files.sweep();
        Ok(files)
    }

    fn open_day(dir: &Path, day: NaiveDate) -> Result<(File, File), String> {
        let b = dir.join(format!("blocks-{day}.jsonl"));
        let s = dir.join(format!("summary-{day}.jsonl"));
        let blocks = open_append(&b).map_err(|e| format!("open {}: {e}", b.display()))?;
        let summary = open_append(&s).map_err(|e| format!("open {}: {e}", s.display()))?;
        Ok((blocks, summary))
    }

    /// Switches to the new day's files at UTC midnight.
    pub fn roll(&mut self, now: DateTime<Utc>) {
        let day = now.date_naive();
        if day == self.day {
            return;
        }
        let _ = self.blocks.flush();
        match Self::open_day(&self.dir, day) {
            Ok((b, s)) => {
                self.blocks = BufWriter::new(b);
                self.summary = s;
                self.day = day;
                self.sweep();
            }
            Err(e) => eprintln!("mpamm-reader: {e}; still writing to {}", self.day),
        }
    }

    /// Deletes daily files older than `keep_days`.
    fn sweep(&mut self) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let oldest_kept = self.day - chrono::Days::new(u64::from(self.keep_days.max(1)) - 1);
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(day) = daily_file_day(&name) {
                if day < oldest_kept {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    pub fn block_line(&mut self, json: &str) {
        let _ = writeln!(self.blocks, "{json}");
    }

    pub fn summary_line(&mut self, json: &str) {
        let _ = writeln!(self.summary, "{json}");
    }

    pub fn flush(&mut self) {
        let _ = self.blocks.flush();
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

/// The day in `blocks-YYYY-MM-DD.jsonl` / `summary-YYYY-MM-DD.jsonl`.
fn daily_file_day(name: &str) -> Option<NaiveDate> {
    let rest = name.strip_prefix("blocks-").or_else(|| name.strip_prefix("summary-"))?;
    NaiveDate::parse_from_str(rest.strip_suffix(".jsonl")?, "%Y-%m-%d").ok()
}

/// Writes `contents` to `path` through a temporary file and a rename, so a
/// reader of `path` never sees half a file.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents)?;
    fs::rename(tmp, path)
}

/// Where to resume: the first height not yet written to `blocks-*.jsonl`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub next: u64,
}

pub fn read_cursor(path: &Path) -> Option<Cursor> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mpamm-reader-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn rolls_daily_and_keeps_n_days() {
        let dir = tmpdir("roll");
        let day1 = Utc.with_ymd_and_hms(2026, 11, 27, 23, 59, 0).unwrap();
        fs::create_dir_all(&dir).unwrap();
        // Old files from earlier runs: 2 days kept means 11-26 stays, 11-25 goes.
        for d in ["2026-11-25", "2026-11-26"] {
            fs::write(dir.join(format!("blocks-{d}.jsonl")), "x\n").unwrap();
            fs::write(dir.join(format!("summary-{d}.jsonl")), "x\n").unwrap();
        }
        fs::write(dir.join("blocks.jsonl"), "legacy\n").unwrap();
        let mut f = Files::open(&dir, 2, day1).unwrap();
        f.block_line("{\"n\":1}");
        f.roll(day1);
        f.roll(Utc.with_ymd_and_hms(2026, 11, 28, 0, 0, 1).unwrap());
        f.block_line("{\"n\":2}");
        f.summary_line("{\"s\":1}");
        f.flush();
        let mut names: Vec<String> =
            fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "blocks-2026-11-27.jsonl",
                "blocks-2026-11-28.jsonl",
                "blocks.jsonl",
                "summary-2026-11-27.jsonl",
                "summary-2026-11-28.jsonl"
            ]
        );
        assert_eq!(fs::read_to_string(dir.join("blocks-2026-11-27.jsonl")).unwrap(), "{\"n\":1}\n");
        assert_eq!(fs::read_to_string(dir.join("blocks-2026-11-28.jsonl")).unwrap(), "{\"n\":2}\n");
        assert_eq!(fs::read_to_string(dir.join("summary-2026-11-28.jsonl")).unwrap(), "{\"s\":1}\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_round_trips_atomically() {
        let dir = tmpdir("cursor");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cursor.json");
        assert_eq!(read_cursor(&p), None);
        write_atomic(&p, &serde_json::to_string(&Cursor { next: 42 }).unwrap()).unwrap();
        assert_eq!(read_cursor(&p), Some(Cursor { next: 42 }));
        assert!(!dir.join("cursor.tmp").exists());
        fs::write(&p, "{broken").unwrap();
        assert_eq!(read_cursor(&p), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recognises_daily_files_only() {
        assert_eq!(daily_file_day("blocks-2026-11-27.jsonl"), NaiveDate::from_ymd_opt(2026, 11, 27));
        assert_eq!(daily_file_day("summary-2026-01-02.jsonl"), NaiveDate::from_ymd_opt(2026, 1, 2));
        assert_eq!(daily_file_day("blocks.jsonl"), None);
        assert_eq!(daily_file_day("authors.json"), None);
        assert_eq!(daily_file_day("blocks-2026-13-01.jsonl"), None);
    }
}
