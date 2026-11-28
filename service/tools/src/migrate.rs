//! `mpamm-tools migrate`: today's database into the new schema, losing
//! nothing (docs/rebuild-spec.md → Data migration and history).
//!
//! - fills → trades: ids, markouts and curves kept; times stay the second
//!   they were stamped with (`migrated`); the day bucket is the fill's day.
//! - daily_volume and day_meta are copied as they are (they hold history the
//!   31-day fills window no longer does); trades are imported without
//!   touching volume.
//! - daily_gas is copied, every row marked `estimate` (today's sampler).
//! - every meta key is kept under `v1:` (cursors, applied revision markers,
//!   re-read debts, adapter state); the fills tail cursor becomes the new
//!   commit cursor, so the service catches up from the block after it.
//!
//! Then it verifies: row counts, and every (day, venue) volume and gas
//! figure, against the source. The source is opened read-only.

use std::path::Path;

use mpamm_store::{GasMethod, Store, FINAL_CURSOR};
use mpamm_types::{utc_day, Fill, FillCategory, Side, TimeSource, VenueDaily, VenueGasDaily};
use rusqlite::{Connection, OpenFlags, OptionalExtension};

fn meta(v1: &Connection, key: &str) -> Result<Option<String>, String> {
    v1.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(|e| e.to_string())
}

pub fn migrate(from: &Path, to: &Path) -> Result<(), String> {
    let v1 = Connection::open_with_flags(from, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open {}: {e}", from.display()))?;
    match meta(&v1, "schema_version")?.as_deref() {
        Some("3") => {}
        other => return Err(format!("source schema {other:?}; this migration reads schema 3")),
    }
    let mut store = Store::open(to).map_err(|e| e.to_string())?;
    if store.cursor(FINAL_CURSOR).map_err(|e| e.to_string())?.is_some() {
        return Err(format!("{} already has a cursor: migrate into a new database", to.display()));
    }

    // Trades.
    let mut stmt = v1
        .prepare(
            "SELECT id, ts, block_number, venue_id, market, side, category, usd, base_amount, exec_px, px_approx,
                    tx_hash, to_label, pool, markouts_bps, router, curve_bps FROM fills",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let ts: i64 = r.get(1)?;
            let side: String = r.get(5)?;
            let cat: String = r.get(6)?;
            let mk: String = r.get(14)?;
            Ok((
                Fill {
                    id: r.get(0)?,
                    venue_id: r.get(3)?,
                    market: r.get(4)?,
                    side: if side == "sell" { Side::Sell } else { Side::Buy },
                    category: FillCategory::parse(&cat).unwrap_or(FillCategory::Unknown),
                    usd: r.get(7)?,
                    base_amount: r.get(8)?,
                    exec_px: r.get(9)?,
                    px_approx: r.get::<_, i64>(10)? != 0,
                    tx_hash: r.get(11)?,
                    to: r.get(12)?,
                    router: r.get(15)?,
                    pool: r.get(13)?,
                    block_number: r.get::<_, i64>(2)? as u64,
                    ts: ts as f64,
                    markouts_bps: serde_json::from_str(&mk).unwrap_or_default(),
                    time_source: Some(TimeSource::Migrated),
                },
                utc_day(ts as f64),
                r.get::<_, Option<String>>(16)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let categories_unknown = rows.iter().filter(|(f, _, _)| f.category == FillCategory::Unknown).count();
    let imported = store.import_trades(&rows).map_err(|e| e.to_string())?;
    eprintln!("trades: {} read, {imported} imported", rows.len());

    // Daily volume and partial days.
    let mut n_vol = 0;
    let mut stmt = v1.prepare("SELECT utc_day, venue_id, usd, swaps FROM daily_volume").map_err(|e| e.to_string())?;
    for r in stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, i64>(3)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (day, venue, usd, swaps) = r.map_err(|e| e.to_string())?;
        store.set_volume(&day, &venue, VenueDaily { usd, swaps: swaps as u64 }).map_err(|e| e.to_string())?;
        n_vol += 1;
    }
    let mut stmt = v1.prepare("SELECT utc_day, partial FROM day_meta").map_err(|e| e.to_string())?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(|e| e.to_string())? {
        let (day, partial) = r.map_err(|e| e.to_string())?;
        store.set_partial_day(&day, partial != 0).map_err(|e| e.to_string())?;
    }

    // Gas, as estimates.
    let mut n_gas = 0;
    let mut stmt = v1.prepare("SELECT utc_day, venue_id, mon, txs FROM daily_gas").map_err(|e| e.to_string())?;
    for r in stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, i64>(3)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (day, venue, mon, txs) = r.map_err(|e| e.to_string())?;
        store
            .set_gas(&day, &venue, VenueGasDaily { mon, txs: txs as u64 }, GasMethod::Estimate)
            .map_err(|e| e.to_string())?;
        n_gas += 1;
    }

    // Every meta key, kept; the tail cursor becomes the commit cursor.
    let mut stmt = v1.prepare("SELECT key, value FROM meta").map_err(|e| e.to_string())?;
    let mut n_meta = 0;
    for r in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())? {
        let (k, v) = r.map_err(|e| e.to_string())?;
        store.set_meta(&format!("v1:{k}"), &v).map_err(|e| e.to_string())?;
        n_meta += 1;
    }
    let cursor: u64 = meta(&v1, "lastProcessedBlock")?
        .ok_or("source has no lastProcessedBlock")?
        .parse()
        .map_err(|e| format!("lastProcessedBlock: {e}"))?;
    store.set_cursor(FINAL_CURSOR, cursor, None).map_err(|e| e.to_string())?;
    store.set_meta("migrated_from_v1_cursor", &cursor.to_string()).map_err(|e| e.to_string())?;
    eprintln!(
        "daily_volume {n_vol}, daily_gas {n_gas}, meta {n_meta}; cursor {cursor}; {categories_unknown} trades UNKNOWN"
    );

    verify(&v1, &store)
}

fn verify(v1: &Connection, store: &Store) -> Result<(), String> {
    let count = |c: &Connection, sql: &str| -> Result<i64, String> {
        c.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    let pairs = [
        ("SELECT COUNT(*) FROM fills", "SELECT COUNT(*) FROM trades"),
        ("SELECT COUNT(*) FROM daily_volume", "SELECT COUNT(*) FROM daily_volume"),
        ("SELECT COUNT(*) FROM daily_gas", "SELECT COUNT(*) FROM daily_gas"),
        (
            "SELECT COUNT(*) FROM fills WHERE curve_bps IS NOT NULL",
            "SELECT COUNT(*) FROM trades WHERE curve_bps IS NOT NULL",
        ),
        ("SELECT COUNT(*) FROM meta", "SELECT COUNT(*) FROM meta WHERE key LIKE 'v1:%'"),
    ];
    for (a, b) in pairs {
        let (x, y) = (count(v1, a)?, count(store.conn(), b)?);
        if x != y {
            return Err(format!("{a} = {x}, but {b} = {y}"));
        }
    }
    for (table, cols) in [("daily_volume", "usd, swaps"), ("daily_gas", "mon, txs")] {
        let sql = format!("SELECT utc_day, venue_id, {cols} FROM {table} ORDER BY utc_day, venue_id");
        let read = |c: &Connection| -> Result<Vec<(String, String, f64, i64)>, String> {
            let mut s = c.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        };
        if read(v1)? != read(store.conn())? {
            return Err(format!("{table} differs after migration"));
        }
    }
    // Every trade's money fields, row for row: (id, usd, base, px, markouts).
    type MoneyRow = (String, f64, f64, f64, String);
    let sql = "SELECT id, usd, base_amount, exec_px, markouts_bps FROM fills ORDER BY id";
    let new_sql = "SELECT id, usd, base_amount, exec_px, markouts_bps FROM trades ORDER BY id";
    let read = |c: &Connection, q: &str| -> Result<Vec<MoneyRow>, String> {
        let mut s = c.prepare(q).map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    };
    let (a, b) = (read(v1, sql)?, read(store.conn(), new_sql)?);
    for (x, y) in a.iter().zip(&b) {
        let mk = |s: &str| serde_json::from_str::<Vec<Option<f64>>>(s).unwrap_or_default();
        if x.0 != y.0 || x.1 != y.1 || x.2 != y.2 || x.3 != y.3 || mk(&x.4) != mk(&y.4) {
            return Err(format!("trade {} differs after migration", x.0));
        }
    }
    eprintln!("verified: {} trades field for field; daily volume and gas row for row", a.len());
    Ok(())
}
