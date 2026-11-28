//! What history repairs write (mpamm-history): one venue, one day (or the
//! part of it a repair covers) at a time, each in one transaction with the
//! repair's cursor, so a restart resumes at the first day not written and a
//! day is never half old, half new.
//!
//! The trades table is complete from its first full day on (`trades_from`:
//! the migration brought the last 31 days of trades, and every trade since is
//! kept). A day from then on is repaired through its trades, and its volume
//! re-summed from them, so trades and volume can't disagree. An older day has
//! only its volume row, which a repair sets from what it decoded. Gas is
//! never touched.

use std::collections::{BTreeMap, HashMap};

use mpamm_types::{utc_day, Fill, VenueDaily};
use rusqlite::{params, OptionalExtension, Transaction};

use crate::{side_str, time_source_str, Result, Store};

/// The meta key holding the trades table's first complete day.
pub const TRADES_FROM: &str = "history_trades_from";

/// A repair in progress (or not yet started).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub venue_id: String,
    /// The repair's definition; a changed definition is another job.
    pub spec: String,
    pub kind: String,
    /// The last block an earlier build committed when the job was planned:
    /// blocks after it were decoded by the build that runs the job.
    pub b0: u64,
    /// The last block written, once a day has been.
    pub cursor: Option<u64>,
    pub started_ms: i64,
}

/// One day's repair: the venue's trades over `from..=to` (blocks of `day`).
#[derive(Debug, Clone)]
pub struct DayRepair {
    pub venue_id: String,
    pub spec: String,
    pub day: String,
    pub from: u64,
    pub to: u64,
    pub trades: Vec<Fill>,
}

/// What a day's repair changed, for notes and the markout sweep.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DayOutcome {
    /// The venue's volume that day before and after.
    pub before: VenueDaily,
    pub after: VenueDaily,
    /// Trades stored that weren't before (they have no markouts yet).
    pub inserted: Vec<String>,
    /// Stored trades the repair no longer produced.
    pub removed: usize,
    /// Whether the day's trades were repaired (else only its volume row).
    pub through_trades: bool,
}

const JOBS: &str = r#"
CREATE TABLE IF NOT EXISTS history_jobs (
  venue_id   TEXT NOT NULL,
  spec       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  b0         INTEGER NOT NULL,
  cursor     INTEGER,
  started_ms INTEGER NOT NULL,
  PRIMARY KEY (venue_id, spec)
) WITHOUT ROWID;
"#;

pub(crate) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(JOBS)?;
    Ok(())
}

fn volume_of(tx: &Transaction<'_>, day: &str, venue: &str) -> Result<VenueDaily> {
    Ok(tx
        .query_row(
            "SELECT usd, swaps FROM daily_volume WHERE utc_day = ?1 AND venue_id = ?2",
            params![day, venue],
            |r| Ok(VenueDaily { usd: r.get(0)?, swaps: r.get::<_, i64>(1)? as u64 }),
        )
        .optional()?
        .unwrap_or_default())
}

fn set_volume(tx: &Transaction<'_>, day: &str, venue: &str, v: VenueDaily) -> Result<()> {
    if v.swaps == 0 {
        tx.execute("DELETE FROM daily_volume WHERE utc_day = ?1 AND venue_id = ?2", params![day, venue])?;
    } else {
        tx.execute(
            "INSERT INTO daily_volume (utc_day, venue_id, usd, swaps) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(utc_day, venue_id) DO UPDATE SET usd = excluded.usd, swaps = excluded.swaps",
            params![day, venue, v.usd, v.swaps as i64],
        )?;
    }
    Ok(())
}

/// The venue's day re-summed from its stored trades.
fn resum(tx: &Transaction<'_>, day: &str, venue: &str) -> Result<VenueDaily> {
    let (usd, swaps): (f64, i64) = tx.query_row(
        "SELECT COALESCE(SUM(usd), 0), COUNT(*) FROM trades WHERE utc_day = ?1 AND venue_id = ?2",
        params![day, venue],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let v = VenueDaily { usd, swaps: swaps as u64 };
    set_volume(tx, day, venue, v)?;
    Ok(v)
}

fn totals(trades: &[Fill]) -> VenueDaily {
    VenueDaily { usd: trades.iter().map(|t| t.usd).sum(), swaps: trades.len() as u64 }
}

fn advance(tx: &Transaction<'_>, venue: &str, spec: &str, cursor: u64) -> Result<()> {
    tx.execute(
        "UPDATE history_jobs SET cursor = ?3 WHERE venue_id = ?1 AND spec = ?2",
        params![venue, spec, cursor as i64],
    )?;
    Ok(())
}

/// What a stored trade keeps through a repair: its time (the proposal time
/// the live pipeline stamped beats a replay's block second), its markouts and
/// its curve.
type Kept = (f64, String, String, Option<String>);

fn insert_full(tx: &Transaction<'_>, t: &Fill, day: &str, kept: Option<&Kept>) -> Result<()> {
    let mut stmt = tx.prepare_cached(
        "INSERT INTO trades (id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx,
            tx_hash, to_label, router, pool, block_number, ts, time_source, utc_day, markouts_bps, curve_bps)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
    )?;
    let fresh = serde_json::to_string(&t.markouts_bps).expect("markouts serialize");
    let (ts, source, markouts, curve) = match kept {
        Some((ts, source, markouts, curve)) => (*ts, source.as_str(), markouts.as_str(), curve.clone()),
        None => (t.ts, time_source_str(t.time_source), fresh.as_str(), None),
    };
    stmt.execute(params![
        t.id,
        t.venue_id,
        t.market,
        side_str(t.side),
        t.category.as_str(),
        t.usd,
        t.base_amount,
        t.exec_px,
        t.px_approx as i64,
        t.tx_hash,
        t.to,
        t.router,
        t.pool,
        t.block_number as i64,
        ts,
        source,
        day,
        markouts,
        curve,
    ])?;
    Ok(())
}

impl Store {
    pub fn history_job(&self, venue: &str, spec: &str) -> Result<Option<Job>> {
        Ok(self
            .conn
            .query_row(
                "SELECT venue_id, spec, kind, b0, cursor, started_ms FROM history_jobs WHERE venue_id = ?1 AND spec = ?2",
                params![venue, spec],
                |r| {
                    Ok(Job {
                        venue_id: r.get(0)?,
                        spec: r.get(1)?,
                        kind: r.get(2)?,
                        b0: r.get::<_, i64>(3)? as u64,
                        cursor: r.get::<_, Option<i64>>(4)?.map(|c| c as u64),
                        started_ms: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// The job for this definition, recorded with `b0` the first time it is
    /// planned and kept as it was after that.
    pub fn start_history_job(&self, venue: &str, spec: &str, kind: &str, b0: u64, now_ms: i64) -> Result<Job> {
        self.conn.execute(
            "INSERT OR IGNORE INTO history_jobs (venue_id, spec, kind, b0, cursor, started_ms)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![venue, spec, kind, b0 as i64, now_ms],
        )?;
        Ok(self.history_job(venue, spec)?.expect("just recorded"))
    }

    /// Ends a job: its definition (and any it stands for) marked applied, the
    /// job gone, in one transaction.
    pub fn finish_history_job(&mut self, venue: &str, spec: &str, applied: &[String], now_ms: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM history_jobs WHERE venue_id = ?1 AND spec = ?2", params![venue, spec])?;
        for s in std::iter::once(spec).chain(applied.iter().map(String::as_str)) {
            tx.execute(
                "INSERT OR IGNORE INTO revisions (venue_id, kind, id, applied_ms) VALUES (?1, 'history', ?2, ?3)",
                params![venue, s, now_ms],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Every applied history definition: (venue, spec).
    pub fn history_marks(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT venue_id, id FROM revisions WHERE kind = 'history'")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Meta keys under a prefix (the migration's `v1:`), the prefix removed.
    pub fn meta_under(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM meta WHERE substr(key, 1, length(?1)) = ?1")?;
        let rows = stmt.query_map([prefix], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?;
        Ok(rows
            .collect::<std::result::Result<Vec<(String, String)>, _>>()?
            .into_iter()
            .map(|(k, v)| (k[prefix.len()..].to_string(), v))
            .collect())
    }

    pub fn history_applied(&self, venue: &str, spec: &str) -> Result<bool> {
        self.revision_applied(venue, "history", spec)
    }

    /// Marks a definition applied without running it (adopted from today's
    /// markers, refused, or covered by a lifetime replay).
    pub fn mark_history(&self, venue: &str, spec: &str, now_ms: i64) -> Result<()> {
        self.mark_revision(venue, "history", spec, now_ms)
    }

    /// The trades table's first complete day: recorded once, from the oldest
    /// stored trade (the migration's first day) or, on a database with none
    /// yet, `fallback` (the first committed block's day).
    pub fn trades_from(&self, fallback: &str) -> Result<String> {
        if let Some(d) = self.meta(TRADES_FROM)? {
            return Ok(d);
        }
        let oldest: Option<String> = self.conn.query_row("SELECT MIN(utc_day) FROM trades", [], |r| r.get(0))?;
        let day = oldest.unwrap_or_else(|| fallback.to_string());
        self.set_meta(TRADES_FROM, &day)?;
        Ok(day)
    }

    /// Whether the venue has any volume stored (a venue with none is new).
    pub fn has_volume(&self, venue: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM daily_volume WHERE venue_id = ?1 LIMIT 1", [venue], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Replaces a venue's day with a replay of `from..=to` (its blocks of
    /// `day`), and advances the job, in one transaction. From `trades_from`
    /// on, the stored trades in the range give way to the replay's (a trade
    /// that survives keeps its time and markouts) and the day is re-summed
    /// from the trades, live ones after the range included; before it, the
    /// day's volume is the replay's.
    pub fn replace_history_day(&mut self, r: &DayRepair, trades_from: &str) -> Result<DayOutcome> {
        let tx = self.conn.transaction()?;
        let before = volume_of(&tx, &r.day, &r.venue_id)?;
        let mut out = DayOutcome { before, ..DayOutcome::default() };
        if r.day.as_str() >= trades_from {
            out.through_trades = true;
            let mut kept: HashMap<String, Kept> = HashMap::new();
            {
                let mut stmt = tx.prepare_cached(
                    "SELECT id, ts, time_source, markouts_bps, curve_bps FROM trades
                     WHERE venue_id = ?1 AND block_number >= ?2 AND block_number <= ?3",
                )?;
                let rows = stmt.query_map(params![r.venue_id, r.from as i64, r.to as i64], |row| {
                    Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
                })?;
                for row in rows {
                    let (id, k) = row?;
                    kept.insert(id, k);
                }
            }
            tx.execute(
                "DELETE FROM trades WHERE venue_id = ?1 AND block_number >= ?2 AND block_number <= ?3",
                params![r.venue_id, r.from as i64, r.to as i64],
            )?;
            let mut produced = 0;
            for t in &r.trades {
                let k = kept.get(&t.id);
                if k.is_some() {
                    produced += 1;
                } else {
                    out.inserted.push(t.id.clone());
                }
                insert_full(&tx, t, &utc_day(t.ts), k)?;
            }
            out.removed = kept.len() - produced;
            // Every day the range touched (a trade's day is its block's).
            let mut days: Vec<String> = vec![r.day.clone()];
            days.extend(r.trades.iter().map(|t| utc_day(t.ts)));
            days.sort();
            days.dedup();
            for d in &days {
                let v = resum(&tx, d, &r.venue_id)?;
                if *d == r.day {
                    out.after = v;
                }
            }
        } else {
            out.after = totals(&r.trades);
            set_volume(&tx, &r.day, &r.venue_id, out.after)?;
        }
        advance(&tx, &r.venue_id, &r.spec, r.to)?;
        tx.commit()?;
        Ok(out)
    }

    /// Adds a newly listed market's day (`r.trades` hold only its trades)
    /// and advances the job, in one transaction. From `trades_from` on a
    /// trade is inserted only if absent and only what is inserted is added,
    /// so nothing stored is counted twice; before it, the day's volume grows
    /// by the replay's (those markets weren't counted then).
    pub fn add_history_day(&mut self, r: &DayRepair, trades_from: &str) -> Result<DayOutcome> {
        let tx = self.conn.transaction()?;
        let before = volume_of(&tx, &r.day, &r.venue_id)?;
        let mut out = DayOutcome { before, ..DayOutcome::default() };
        if r.day.as_str() >= trades_from {
            out.through_trades = true;
            let mut by_day: BTreeMap<String, Vec<Fill>> = BTreeMap::new();
            for t in &r.trades {
                by_day.entry(utc_day(t.ts)).or_default().push(t.clone());
            }
            for (day, trades) in &by_day {
                let c = crate::insert_trades(&tx, trades, day)?;
                out.inserted.extend(c.inserted);
            }
        } else {
            let add = totals(&r.trades);
            if add.swaps > 0 {
                set_volume(
                    &tx,
                    &r.day,
                    &r.venue_id,
                    VenueDaily { usd: before.usd + add.usd, swaps: before.swaps + add.swaps },
                )?;
            }
        }
        out.after = volume_of(&tx, &r.day, &r.venue_id)?;
        advance(&tx, &r.venue_id, &r.spec, r.to)?;
        tx.commit()?;
        Ok(out)
    }

    /// Re-sums a venue's days from its stored trades (a `Fills` revision),
    /// marking the definition applied in the same transaction. Returns each
    /// day's volume before and after.
    pub fn resum_history_days(
        &mut self,
        venue: &str,
        days: &[String],
        spec: &str,
        now_ms: i64,
    ) -> Result<Vec<(String, VenueDaily, VenueDaily)>> {
        let tx = self.conn.transaction()?;
        let mut out = Vec::new();
        for d in days {
            let before = volume_of(&tx, d, venue)?;
            let after = resum(&tx, d, venue)?;
            out.push((d.clone(), before, after));
        }
        tx.execute(
            "INSERT OR IGNORE INTO revisions (venue_id, kind, id, applied_ms) VALUES (?1, 'history', ?2, ?3)",
            params![venue, spec, now_ms],
        )?;
        tx.commit()?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests;
