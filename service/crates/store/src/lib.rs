//! SQLite store (docs/rebuild-spec.md → Store): every trade kept, daily
//! volume and gas, the commit cursor, applied revisions and venue state.
//!
//! The one rule everything relies on: a final block's trades, the volume
//! they add, its gas and the cursor are written in ONE transaction, in
//! strict block order. A crash leaves either all of a block or none of it,
//! and a restart resumes exactly at the cursor. Trades insert by id, and
//! volume grows only by trades actually inserted, so replaying a block that
//! is already stored can never double-count it.
//!
//! One writer (the pipeline, through `writer::Writer`); readers open their
//! own read-only connections, which WAL lets run beside the writer.

pub mod writer;

use std::{collections::BTreeMap, path::Path};

use mpamm_types::{utc_day, DailyVolume, Fill, FillCategory, GasDay, Side, TimeSource, VenueDaily, VenueGasDaily};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};

/// Bumped only for a structural change no additive migration can express.
pub const SCHEMA_VERSION: &str = "1";
/// The commit cursor's name in `cursors`.
pub const FINAL_CURSOR: &str = "final";

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    /// A block arrived out of order: commits must be strictly sequential.
    OutOfOrder {
        cursor: u64,
        got: u64,
    },
    /// The database was written by an incompatible schema.
    Schema(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "sqlite: {e}"),
            StoreError::OutOfOrder { cursor, got } => write!(f, "block {got} committed after cursor {cursor}"),
            StoreError::Schema(m) => write!(f, "schema: {m}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// A trade's markout curve: TAKER-signed bps at each offset.
pub type Curve = Vec<Option<f64>>;

/// How a day's gas figure was obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GasMethod {
    /// Every transaction costed from the ring or full blocks.
    Exact,
    /// Today's sampled estimate (migrated days before the cutover).
    Estimate,
    /// A day holding both (the cutover day).
    Mixed,
}

impl GasMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            GasMethod::Exact => "exact",
            GasMethod::Estimate => "estimate",
            GasMethod::Mixed => "mixed",
        }
    }

    fn parse(s: &str) -> GasMethod {
        match s {
            "exact" => GasMethod::Exact,
            "estimate" => GasMethod::Estimate,
            _ => GasMethod::Mixed,
        }
    }
}

/// A venue-day whose gas is an estimate or mixed: (day, venue, method).
pub type NotExact = (String, String, GasMethod);

/// Gas a venue spent in one block, for its day.
#[derive(Debug, Clone, PartialEq)]
pub struct GasAccrual {
    pub venue_id: String,
    pub mon: f64,
    pub txs: u64,
}

/// Everything one final block writes.
#[derive(Debug, Clone, Default)]
pub struct BlockCommit {
    pub number: u64,
    /// Ethereum block hash, `0x`-hex.
    pub hash: String,
    /// Block timestamp (seconds): the day bucket.
    pub timestamp: u64,
    pub trades: Vec<Fill>,
    pub gas: Vec<GasAccrual>,
    /// Durable venue state set while decoding this block (venue, key, value).
    pub state: Vec<(String, String, String)>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Committed {
    /// Ids inserted by this commit (a replayed block inserts none).
    pub inserted: Vec<String>,
    pub duplicates: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub block: u64,
    pub hash: Option<String>,
}

pub struct Store {
    conn: Connection,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  name  TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  hash  TEXT
);
-- Every trade, kept forever. ts: epoch ms (fractional when it is the
-- proposal time); utc_day: the block timestamp's day, the volume bucket.
CREATE TABLE IF NOT EXISTS trades (
  id           TEXT PRIMARY KEY,
  venue_id     TEXT NOT NULL,
  market       TEXT NOT NULL,
  side         TEXT NOT NULL,
  category     TEXT NOT NULL,
  usd          REAL NOT NULL,
  base_amount  REAL NOT NULL,
  exec_px      REAL NOT NULL,
  px_approx    INTEGER NOT NULL DEFAULT 0,
  tx_hash      TEXT NOT NULL,
  to_label     TEXT NOT NULL,
  router       TEXT,
  pool         TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  ts           REAL NOT NULL,
  time_source  TEXT NOT NULL,
  utc_day      TEXT NOT NULL,
  markouts_bps TEXT NOT NULL,
  curve_bps    TEXT
);
CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);
CREATE INDEX IF NOT EXISTS trades_venue_ts ON trades (venue_id, ts);
CREATE INDEX IF NOT EXISTS trades_venue_block ON trades (venue_id, block_number);
CREATE INDEX IF NOT EXISTS trades_day_venue ON trades (utc_day, venue_id);
CREATE TABLE IF NOT EXISTS daily_volume (
  utc_day  TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  usd      REAL NOT NULL DEFAULT 0,
  swaps    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day, venue_id)
) WITHOUT ROWID;
-- Days a migrated history marks partial (a venue's first or last day).
CREATE TABLE IF NOT EXISTS day_meta (
  utc_day TEXT PRIMARY KEY,
  partial INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_gas (
  utc_day  TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  mon      REAL NOT NULL DEFAULT 0,
  txs      INTEGER NOT NULL DEFAULT 0,
  method   TEXT NOT NULL,
  PRIMARY KEY (utc_day, venue_id)
) WITHOUT ROWID;
-- One-shot history and gas repairs, each applied once per database.
CREATE TABLE IF NOT EXISTS revisions (
  venue_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  applied_ms INTEGER NOT NULL,
  PRIMARY KEY (venue_id, kind, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS venue_state (
  venue_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (venue_id, key)
) WITHOUT ROWID;
-- Trades the exchanges' archives have answered for (markouts after the
-- fact), whatever marks they gave: never offered to them again.
CREATE TABLE IF NOT EXISTS archive_marks (
  id         TEXT PRIMARY KEY,
  settled_ms INTEGER NOT NULL
) WITHOUT ROWID;
"#;

fn side_str(s: Side) -> &'static str {
    match s {
        Side::Buy => "buy",
        Side::Sell => "sell",
    }
}

fn time_source_str(t: Option<TimeSource>) -> &'static str {
    match t {
        Some(TimeSource::Block) => "block",
        Some(TimeSource::Migrated) => "migrated",
        Some(TimeSource::Proposal) | None => "proposal",
    }
}

fn parse_time_source(s: &str) -> TimeSource {
    match s {
        "block" => TimeSource::Block,
        "migrated" => TimeSource::Migrated,
        _ => TimeSource::Proposal,
    }
}

impl Store {
    /// Opens (creating) the database for writing and applies the schema.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // Durable against a crash of the process; a power loss can drop the
        // last commits, and then the cursor drops with them.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "journal_size_limit", 64 * 1024 * 1024)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    /// A read-only connection (any number, beside the writer).
    pub fn open_readonly(path: &Path) -> Result<Self> {
        let conn =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self { conn })
    }

    /// An in-memory store, for tests.
    pub fn memory() -> Result<Self> {
        let store = Self { conn: Connection::open_in_memory()? };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        match self.meta("schema_version")? {
            Some(v) if v != SCHEMA_VERSION => {
                return Err(StoreError::Schema(format!("database has schema {v}, this build {SCHEMA_VERSION}")))
            }
            _ => {}
        }
        self.conn.execute_batch(SCHEMA)?;
        self.set_meta("schema_version", SCHEMA_VERSION)?;
        Ok(())
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn cursor(&self, name: &str) -> Result<Option<Cursor>> {
        Ok(self
            .conn
            .query_row("SELECT block, hash FROM cursors WHERE name = ?1", [name], |r| {
                Ok(Cursor { block: r.get::<_, i64>(0)? as u64, hash: r.get(1)? })
            })
            .optional()?)
    }

    /// Sets a cursor outside a block commit (migration, an operator reset).
    pub fn set_cursor(&self, name: &str, block: u64, hash: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO cursors (name, block, hash) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET block = excluded.block, hash = excluded.hash",
            params![name, block as i64, hash],
        )?;
        Ok(())
    }

    /// Writes one final block: its trades (by id), the volume they add, its
    /// gas, venue state and the cursor, in one transaction. Blocks must come
    /// in order: the first commit sets the cursor, each later one must be the
    /// cursor + 1.
    pub fn commit_block(&mut self, c: &BlockCommit) -> Result<Committed> {
        let tx = self.conn.transaction()?;
        let cursor: Option<i64> =
            tx.query_row("SELECT block FROM cursors WHERE name = ?1", [FINAL_CURSOR], |r| r.get(0)).optional()?;
        if let Some(cur) = cursor {
            if c.number as i64 != cur + 1 {
                return Err(StoreError::OutOfOrder { cursor: cur as u64, got: c.number });
            }
        }
        let day = utc_day(c.timestamp as f64 * 1000.0);
        let committed = insert_trades(&tx, &c.trades, &day)?;
        for g in &c.gas {
            add_gas(&tx, &day, &g.venue_id, g.mon, g.txs, GasMethod::Exact)?;
        }
        for (venue, key, value) in &c.state {
            tx.execute(
                "INSERT INTO venue_state (venue_id, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(venue_id, key) DO UPDATE SET value = excluded.value",
                params![venue, key, value],
            )?;
        }
        tx.execute(
            "INSERT INTO cursors (name, block, hash) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET block = excluded.block, hash = excluded.hash",
            params![FINAL_CURSOR, c.number as i64, c.hash],
        )?;
        tx.commit()?;
        Ok(committed)
    }

    /// Inserts trades outside the block pipeline (migration, history scans),
    /// adding to volume only what is new. `day_of` gives each trade's bucket.
    pub fn insert_trades(&mut self, trades: &[Fill], day_of: impl Fn(&Fill) -> String) -> Result<Committed> {
        let tx = self.conn.transaction()?;
        let mut all = Committed::default();
        for t in trades {
            let c = insert_trades(&tx, std::slice::from_ref(t), &day_of(t))?;
            all.inserted.extend(c.inserted);
            all.duplicates += c.duplicates;
        }
        tx.commit()?;
        Ok(all)
    }

    /// Imports trades as they are (migration): no volume is added, since a
    /// migrated history brings its own daily totals. Keeps an existing row.
    pub fn import_trades(&mut self, trades: &[(Fill, String, Option<String>)]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut n = 0;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO trades (id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx,
                    tx_hash, to_label, router, pool, block_number, ts, time_source, utc_day, markouts_bps, curve_bps)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            )?;
            for (t, day, curve) in trades {
                n += stmt.execute(params![
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
                    t.ts,
                    time_source_str(t.time_source),
                    day,
                    serde_json::to_string(&t.markouts_bps).expect("markouts serialize"),
                    curve,
                ])?;
            }
        }
        tx.commit()?;
        Ok(n)
    }

    /// Sets a day's volume for a venue (migration of closed days).
    pub fn set_volume(&self, day: &str, venue: &str, v: VenueDaily) -> Result<()> {
        self.conn.execute(
            "INSERT INTO daily_volume (utc_day, venue_id, usd, swaps) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(utc_day, venue_id) DO UPDATE SET usd = excluded.usd, swaps = excluded.swaps",
            params![day, venue, v.usd, v.swaps as i64],
        )?;
        Ok(())
    }

    /// Sets a day's gas for a venue with its method (migration).
    pub fn set_gas(&self, day: &str, venue: &str, g: VenueGasDaily, method: GasMethod) -> Result<()> {
        self.conn.execute(
            "INSERT INTO daily_gas (utc_day, venue_id, mon, txs, method) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(utc_day, venue_id) DO UPDATE SET mon = excluded.mon, txs = excluded.txs, method = excluded.method",
            params![day, venue, g.mon, g.txs as i64, method.as_str()],
        )?;
        Ok(())
    }

    pub fn set_partial_day(&self, day: &str, partial: bool) -> Result<()> {
        self.conn.execute(
            "INSERT INTO day_meta (utc_day, partial) VALUES (?1, ?2)
             ON CONFLICT(utc_day) DO UPDATE SET partial = excluded.partial",
            params![day, partial as i64],
        )?;
        Ok(())
    }

    /// Daily volume, oldest first. `today` is marked partial, as are days a
    /// migrated history flagged.
    pub fn volume_days(&self, today: &str) -> Result<Vec<DailyVolume>> {
        let mut days: BTreeMap<String, DailyVolume> = BTreeMap::new();
        let mut stmt = self.conn.prepare("SELECT utc_day, venue_id, usd, swaps FROM daily_volume ORDER BY utc_day")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, i64>(3)?))
        })?;
        for row in rows {
            let (day, venue, usd, swaps) = row?;
            days.entry(day.clone())
                .or_insert_with(|| DailyVolume { utc_day: day, by_venue: BTreeMap::new(), partial: false })
                .by_venue
                .insert(venue, VenueDaily { usd, swaps: swaps as u64 });
        }
        let mut partial = self.conn.prepare("SELECT utc_day FROM day_meta WHERE partial != 0")?;
        for day in partial.query_map([], |r| r.get::<_, String>(0))? {
            if let Some(d) = days.get_mut(&day?) {
                d.partial = true;
            }
        }
        if let Some(d) = days.get_mut(today) {
            d.partial = true;
        }
        Ok(days.into_values().collect())
    }

    /// Daily gas, oldest first, with the venue-days that are not exact.
    pub fn gas_days(&self, today: &str) -> Result<(Vec<GasDay>, Vec<NotExact>)> {
        let mut days: BTreeMap<String, GasDay> = BTreeMap::new();
        let mut methods = Vec::new();
        let mut stmt =
            self.conn.prepare("SELECT utc_day, venue_id, mon, txs, method FROM daily_gas ORDER BY utc_day")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (day, venue, mon, txs, method) = row?;
            let method = GasMethod::parse(&method);
            if method != GasMethod::Exact {
                methods.push((day.clone(), venue.clone(), method));
            }
            days.entry(day.clone())
                .or_insert_with(|| GasDay { utc_day: day.clone(), by_venue: BTreeMap::new(), partial: day == today })
                .by_venue
                .insert(venue, VenueGasDaily { mon, txs: txs as u64 });
        }
        Ok((days.into_values().collect(), methods))
    }

    /// Trades with `ts` in [from_ms, to_ms), newest first, at most `limit`.
    pub fn trades_between(&self, from_ms: f64, to_ms: f64, limit: usize) -> Result<Vec<Fill>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label,
                    router, pool, block_number, ts, time_source, markouts_bps
             FROM trades WHERE ts >= ?1 AND ts < ?2 ORDER BY ts DESC, id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms, limit as i64], row_to_fill)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Trades with `ts` in [from_ms, to_ms), each with its stored curve
    /// (TAKER-signed bps at each offset; `None` until taken).
    pub fn trades_with_curves(&self, from_ms: f64, to_ms: f64) -> Result<Vec<(Fill, Option<Curve>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label,
                    router, pool, block_number, ts, time_source, markouts_bps, curve_bps
             FROM trades WHERE ts >= ?1 AND ts < ?2 ORDER BY ts, id",
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms], |r| {
            let curve: Option<String> = r.get(17)?;
            Ok((row_to_fill(r)?, curve.and_then(|c| serde_json::from_str(&c).ok())))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn trade(&self, id: &str) -> Result<Option<Fill>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label,
                        router, pool, block_number, ts, time_source, markouts_bps FROM trades WHERE id = ?1",
                [id],
                row_to_fill,
            )
            .optional()?)
    }

    /// Writes a trade's markouts (as horizons age).
    pub fn set_markouts(&self, id: &str, markouts: &[Option<f64>]) -> Result<bool> {
        let json = serde_json::to_string(markouts).expect("markouts serialize");
        Ok(self.conn.execute("UPDATE trades SET markouts_bps = ?1 WHERE id = ?2", params![json, id])? == 1)
    }

    /// Writes a trade's complete markout curve (taken once).
    pub fn set_curve(&self, id: &str, curve: &[f64]) -> Result<bool> {
        let json = serde_json::to_string(curve).expect("curve serializes");
        Ok(self.conn.execute("UPDATE trades SET curve_bps = ?1 WHERE id = ?2", params![json, id])? == 1)
    }

    /// Trades from `since_ms` on whose markouts aren't all set: what a
    /// restart resumes aging.
    pub fn trades_aging(&self, since_ms: f64) -> Result<Vec<Fill>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label,
                    router, pool, block_number, ts, time_source, markouts_bps
             FROM trades WHERE ts >= ?1 AND px_approx = 0 AND (markouts_bps LIKE '%null%' OR curve_bps IS NULL)
             ORDER BY ts",
        )?;
        let rows = stmt.query_map(params![since_ms], row_to_fill)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Trades with `ts` in [from_ms, to_ms) still missing a markout that the
    /// archives haven't settled: what markouts after the fact work on, oldest
    /// first, at most `limit`.
    pub fn trades_unmarked(&self, from_ms: f64, to_ms: f64, limit: usize) -> Result<Vec<Fill>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label,
                    router, pool, block_number, ts, time_source, markouts_bps
             FROM trades t WHERE ts >= ?1 AND ts < ?2 AND px_approx = 0 AND markouts_bps LIKE '%null%'
               AND NOT EXISTS (SELECT 1 FROM archive_marks a WHERE a.id = t.id)
             ORDER BY ts, id LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms, limit as i64], row_to_fill)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Settles trades with the archives, in one transaction: each null
    /// markout takes the archive's value at its horizon (a mark the live
    /// history gave is never replaced), and the trade is not offered again.
    /// `archived` is (trade id, the archive's mark per horizon). Returns the
    /// markouts of every trade whose marks changed.
    pub fn settle_archive_marks(
        &mut self,
        archived: &[(String, Vec<Option<f64>>)],
        now_ms: i64,
    ) -> Result<Vec<(String, Vec<Option<f64>>)>> {
        let tx = self.conn.transaction()?;
        let mut changed = Vec::new();
        {
            let mut read = tx.prepare_cached("SELECT markouts_bps FROM trades WHERE id = ?1")?;
            let mut write = tx.prepare_cached("UPDATE trades SET markouts_bps = ?1 WHERE id = ?2")?;
            let mut settle = tx.prepare_cached(
                "INSERT INTO archive_marks (id, settled_ms) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET settled_ms = excluded.settled_ms",
            )?;
            for (id, archive) in archived {
                let current: Option<String> = read.query_row([id], |r| r.get(0)).optional()?;
                if let Some(current) = current {
                    let mut marks: Vec<Option<f64>> = serde_json::from_str(&current).unwrap_or_default();
                    marks.resize(marks.len().max(archive.len()), None);
                    let mut any = false;
                    for (m, a) in marks.iter_mut().zip(archive) {
                        if m.is_none() && a.is_some() {
                            *m = *a;
                            any = true;
                        }
                    }
                    if any {
                        write.execute(params![serde_json::to_string(&marks).expect("markouts serialize"), id])?;
                        changed.push((id.clone(), marks));
                    }
                }
                settle.execute(params![id, now_ms])?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn venue_state(&self, venue: &str, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM venue_state WHERE venue_id = ?1 AND key = ?2", params![venue, key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    /// Every venue's stored state, for the pipeline to start from.
    pub fn all_venue_state(&self) -> Result<std::collections::HashMap<(String, String), String>> {
        let mut stmt = self.conn.prepare("SELECT venue_id, key, value FROM venue_state")?;
        let rows =
            stmt.query_map([], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, String>(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn revision_applied(&self, venue: &str, kind: &str, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM revisions WHERE venue_id = ?1 AND kind = ?2 AND id = ?3",
                params![venue, kind, id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn mark_revision(&self, venue: &str, kind: &str, id: &str, now_ms: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO revisions (venue_id, kind, id, applied_ms) VALUES (?1, ?2, ?3, ?4)",
            params![venue, kind, id, now_ms],
        )?;
        Ok(())
    }
}

fn insert_trades(tx: &Transaction<'_>, trades: &[Fill], day: &str) -> Result<Committed> {
    let mut out = Committed::default();
    let mut added: BTreeMap<&str, (f64, u64)> = BTreeMap::new();
    let mut stmt = tx.prepare_cached(
        "INSERT OR IGNORE INTO trades (id, venue_id, market, side, category, usd, base_amount, exec_px, px_approx,
            tx_hash, to_label, router, pool, block_number, ts, time_source, utc_day, markouts_bps)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
    )?;
    for t in trades {
        let markouts = serde_json::to_string(&t.markouts_bps).expect("markouts serialize");
        let n = stmt.execute(params![
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
            t.ts,
            time_source_str(t.time_source),
            day,
            markouts,
        ])?;
        if n == 1 {
            out.inserted.push(t.id.clone());
            let e = added.entry(t.venue_id.as_str()).or_default();
            e.0 += t.usd;
            e.1 += 1;
        } else {
            out.duplicates += 1;
        }
    }
    for (venue, (usd, swaps)) in added {
        tx.execute(
            "INSERT INTO daily_volume (utc_day, venue_id, usd, swaps) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(utc_day, venue_id) DO UPDATE SET usd = usd + excluded.usd, swaps = swaps + excluded.swaps",
            params![day, venue, usd, swaps as i64],
        )?;
    }
    Ok(out)
}

fn add_gas(tx: &Transaction<'_>, day: &str, venue: &str, mon: f64, txs: u64, method: GasMethod) -> Result<()> {
    let existing: Option<String> = tx
        .query_row("SELECT method FROM daily_gas WHERE utc_day = ?1 AND venue_id = ?2", params![day, venue], |r| {
            r.get(0)
        })
        .optional()?;
    let method = match existing.map(|m| GasMethod::parse(&m)) {
        None => method,
        Some(m) if m == method => method,
        Some(_) => GasMethod::Mixed,
    };
    tx.execute(
        "INSERT INTO daily_gas (utc_day, venue_id, mon, txs, method) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(utc_day, venue_id) DO UPDATE SET mon = mon + excluded.mon, txs = txs + excluded.txs,
           method = excluded.method",
        params![day, venue, mon, txs as i64, method.as_str()],
    )?;
    Ok(())
}

fn row_to_fill(r: &rusqlite::Row<'_>) -> rusqlite::Result<Fill> {
    let side: String = r.get(3)?;
    let category: String = r.get(4)?;
    let markouts: String = r.get(16)?;
    let time_source: String = r.get(15)?;
    Ok(Fill {
        id: r.get(0)?,
        venue_id: r.get(1)?,
        market: r.get(2)?,
        side: if side == "sell" { Side::Sell } else { Side::Buy },
        category: FillCategory::parse(&category).unwrap_or(FillCategory::Unknown),
        usd: r.get(5)?,
        base_amount: r.get(6)?,
        exec_px: r.get(7)?,
        px_approx: r.get::<_, i64>(8)? != 0,
        tx_hash: r.get(9)?,
        to: r.get(10)?,
        router: r.get(11)?,
        pool: r.get(12)?,
        block_number: r.get::<_, i64>(13)? as u64,
        ts: r.get(14)?,
        time_source: Some(parse_time_source(&time_source)),
        markouts_bps: serde_json::from_str(&markouts).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests;
