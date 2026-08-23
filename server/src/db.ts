import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MARKOUT_HORIZONS, type DailyVolume, type Fill, type GasDay } from '@shared';

type Stmt = ReturnType<DatabaseSync['prepare']>;

/**
 * SQLite persistence (docs/architecture.md: data model). The DB is the source of truth for history:
 * daily-volume aggregates + the lastProcessedBlock cursor, and decoded fills
 * (the tape/markouts/leaderboard are expensive to re-derive — log decode + a
 * pair-CEX-mid join — so they're stored, not just held in a live window). The
 * current quote matrix stays in memory (replace-on-poll, cheap to refetch).
 *
 * Schema is venue-agnostic (long format): daily volume is one row per
 * (day, venue_id), and a fill carries a `venue_id` — so adding/removing a venue
 * never changes the table shape. A venue that leaves the registry is pruned
 * non-destructively on boot (`reconcileVenues`), keeping every OTHER venue's
 * history. `SCHEMA_VERSION` only gates a true STRUCTURAL change (columns / PK);
 * on such a bump we start fresh (Clober re-seeds from the subgraph, on-chain
 * venues rebuild forward) — a venue swap alone no longer resets anything.
 */
const SCHEMA_VERSION = '3';

/**
 * Version of the MARKOUT MODEL — what a fill's `markouts_bps` were marked
 * against. Bump when the benchmark itself changes meaning (not on schema
 * changes). On mismatch, persisted fills keep their volume/tape data and their
 * markouts are either REPLAYED from the persisted `mid_history` curve (when the
 * stored mids remain a valid mark under the new model — set
 * `REMARK_FROM_MID_HISTORY`) or reset to nulls (when the mid definition itself
 * changed, so the stored curve is old-model too). Either way old-model bps are
 * never mixed with new-model bps in the markout/leaderboard stats, and fills
 * young enough re-age naturally against the live mids.
 *
 *  'pair-mid-1' — markouts vs the PAIR-terms CEX mid (wrap basis + stable
 *                 cross), replacing raw USDT mids (~10bps different on USDC
 *                 pairs — old and new values are not comparable).
 */
const MARKOUT_MODEL_VERSION = 'pair-mid-1';
/**
 * Set true when bumping MARKOUT_MODEL_VERSION IF the persisted `mid_history`
 * rows (pair-terms mids recorded every ~PERSIST_MS) are still a valid mark
 * under the NEW model — e.g. the markout formula/horizons changed but the mid
 * didn't. Retained fills are then RECOMPUTED per horizon from the stored curve
 * (nearest sample within ±MID_REPLAY_TOL_MS; null when no sample is close
 * enough) instead of nulled. Leave false when the mid definition itself changes.
 */
const REMARK_FROM_MID_HISTORY = false; // 'pair-mid-1' changed the mid definition — no valid history predates it
/** how far a persisted mid sample may sit from a horizon's mark time and still
 *  be used in a replay (persist cadence is ~5s → one interval + slack). */
const MID_REPLAY_TOL_MS = 6_000;
const NULL_MARKOUTS_JSON = JSON.stringify(MARKOUT_HORIZONS.map(() => null));
const nullMarkouts = (): (number | null)[] => MARKOUT_HORIZONS.map(() => null);

/** one persisted point of a pair's CEX mid curve (pair terms). */
export interface MidPoint { ts: number; market: string; mid: number }

/**
 * Which rows a venue reset may delete. An omitted key leaves that table
 * untouched — used when the scan that would restore it is disabled, where
 * deleting would destroy history nothing puts back.
 *
 * `volume.fromDay` omitted = every day (a lifetime replay re-scans them all).
 * `fills` is keyed by whichever boundary the fills scan will actually resume
 * on: its exact block for a targeted replay, else the first ms of its window.
 */
export interface ResetDeletes {
  /** Exclusive upper bound shared by both tables — always the current UTC day.
   *  Today is owned by the LIVE TAIL: the volume backfill skips `day >= today`
   *  and the fills scan batches only `utcDay(f.ts) < today`, so nothing a
   *  replay does rebuilds it. Deleting it would drop what the tail already
   *  counted this morning, and the tail's cursor is long past re-emitting it. */
  beforeDay: string;
  volume?: { fromDay?: string };
  fills?: { fromBlock: bigint } | { fromDay: string };
}

export class VolumeStore {
  private db: DatabaseSync;
  private dayStmt: Stmt;
  private dayMetaStmt: Stmt;
  private metaStmt: Stmt;
  private fillStmt: Stmt;
  private midStmt: Stmt;
  private gasStmt: Stmt;

  constructor(path = 'data/mpamm.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);

    // meta first (holds the schema version + the indexer cursor)
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
    const ver = (this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined)?.value;
    if (ver !== SCHEMA_VERSION) {
      // start fresh on a schema change: drop the data tables and clear the cursor
      // so the indexer cold-starts (the venue registry defines the new shape).
      // daily_gas included: clearing meta clears the gas cursors, and additive
      // accrual over surviving rows would double-count on the re-scan.
      this.db.exec(`DROP TABLE IF EXISTS daily_volume; DROP TABLE IF EXISTS fills; DROP TABLE IF EXISTS day_meta; DROP TABLE IF EXISTS mid_history; DROP TABLE IF EXISTS daily_gas; DELETE FROM meta;`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_volume (
        utc_day  TEXT    NOT NULL,
        venue_id TEXT    NOT NULL,
        usd      REAL    NOT NULL DEFAULT 0,
        swaps    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (utc_day, venue_id)
      );
      CREATE INDEX IF NOT EXISTS daily_volume_venue_day ON daily_volume (venue_id, utc_day);
      CREATE TABLE IF NOT EXISTS day_meta (
        utc_day TEXT PRIMARY KEY,
        partial INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS fills (
        id           TEXT PRIMARY KEY,
        ts           INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
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
        pool         TEXT NOT NULL,
        markouts_bps TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fills_ts ON fills (ts);
      CREATE INDEX IF NOT EXISTS fills_venue_block ON fills (venue_id, block_number);
      CREATE INDEX IF NOT EXISTS fills_venue_ts ON fills (venue_id, ts);
      -- per-pair CEX mid curve (pair terms), sampled every ~PERSIST_MS: lets a
      -- future markout-model bump REPLAY retained fills' markouts instead of
      -- nulling them (see REMARK_FROM_MID_HISTORY). Same retention as fills.
      CREATE TABLE IF NOT EXISTS mid_history (
        market TEXT    NOT NULL,
        ts     INTEGER NOT NULL,
        mid    REAL    NOT NULL,
        PRIMARY KEY (market, ts)
      ) WITHOUT ROWID;
      -- QUOTE_UPDATE_BURN: per-venue quote-update gas per UTC day. mon is the
      -- MON actually charged (Monad charges gas_limit; receipts report
      -- gasUsed == limit, so gasUsed × effectiveGasPrice is exact). Additive
      -- accrual — rows only ever grow, committed atomically with the venue's
      -- gas cursor (applyGas) so a crash can never double-count.
      CREATE TABLE IF NOT EXISTS daily_gas (
        utc_day  TEXT    NOT NULL,
        venue_id TEXT    NOT NULL,
        mon      REAL    NOT NULL DEFAULT 0,
        txs      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (utc_day, venue_id)
      );
    `);
    // additive migration (PRAGMA-guarded, no reset): fills gained px_approx so a
    // persisted approximate-price fill keeps its exclusion flag across restarts —
    // without it, a pxApprox fill reloaded from the DB would silently enter the
    // markout/leaderboard stats the shared contract promises it stays out of.
    const fillCols = this.db.prepare(`PRAGMA table_info(fills)`).all() as Array<{ name: string }>;
    if (!fillCols.some((c) => c.name === 'px_approx')) {
      this.db.exec(`ALTER TABLE fills ADD COLUMN px_approx INTEGER NOT NULL DEFAULT 0`);
    }
    // additive migration: fills gained `router` (the attributed intermediary
    // brand — "Router - X" in the tape). NULL = direct/unattributed.
    if (!fillCols.some((c) => c.name === 'router')) {
      this.db.exec(`ALTER TABLE fills ADD COLUMN router TEXT`);
    }
    // Defense in depth: pxApprox fills must never expose persisted markouts. This
    // normalizes adapter-supplied/backfilled rows and cleans any rows written by a
    // prior build that aged approximate fills before the live guard existed.
    this.db.prepare(`UPDATE fills SET markouts_bps = ? WHERE px_approx != 0 AND markouts_bps != ?`).run(NULL_MARKOUTS_JSON, NULL_MARKOUTS_JSON);

    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SCHEMA_VERSION);

    // markout-model migration: retained fills marked under an older model keep
    // their volume/tape data, but their markouts are REPLAYED from the persisted
    // mid curve (when the curve is still a valid mark — REMARK_FROM_MID_HISTORY)
    // or nulled — old-model bps must never mix with new-model bps in the stats.
    const mkVer = (this.db.prepare(`SELECT value FROM meta WHERE key = 'markout_model_version'`).get() as { value: string } | undefined)?.value;
    if (mkVer !== MARKOUT_MODEL_VERSION) {
      if (REMARK_FROM_MID_HISTORY) {
        const { remarked, nulled } = this.remarkRetainedFills();
        console.log(`[mpamm] markout model → ${MARKOUT_MODEL_VERSION}: replayed ${remarked} fill(s) from mid_history, nulled ${nulled}`);
      } else {
        const info = this.db.prepare(`UPDATE fills SET markouts_bps = ? WHERE markouts_bps != ?`).run(NULL_MARKOUTS_JSON, NULL_MARKOUTS_JSON);
        if (Number(info.changes) > 0) console.log(`[mpamm] markout model → ${MARKOUT_MODEL_VERSION}: reset markouts on ${info.changes} retained fill(s)`);
      }
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('markout_model_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MARKOUT_MODEL_VERSION);
    }

    this.dayStmt = this.db.prepare(`
      INSERT INTO daily_volume (utc_day, venue_id, usd, swaps) VALUES (?, ?, ?, ?)
      ON CONFLICT(utc_day, venue_id) DO UPDATE SET usd = excluded.usd, swaps = excluded.swaps`);
    this.dayMetaStmt = this.db.prepare(`
      INSERT INTO day_meta (utc_day, partial) VALUES (?, ?)
      ON CONFLICT(utc_day) DO UPDATE SET partial = excluded.partial`);
    this.metaStmt = this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this.fillStmt = this.db.prepare(`
      INSERT INTO fills (id, ts, block_number, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label, pool, markouts_bps, router)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET markouts_bps = excluded.markouts_bps, px_approx = excluded.px_approx`);
    this.midStmt = this.db.prepare(`
      INSERT INTO mid_history (market, ts, mid) VALUES (?, ?, ?)
      ON CONFLICT(market, ts) DO UPDATE SET mid = excluded.mid`);
    this.gasStmt = this.db.prepare(`
      INSERT INTO daily_gas (utc_day, venue_id, mon, txs) VALUES (?, ?, ?, ?)
      ON CONFLICT(utc_day, venue_id) DO UPDATE SET mon = mon + excluded.mon, txs = txs + excluded.txs`);
  }

  private runDay(d: DailyVolume): void {
    this.dayMetaStmt.run(d.utcDay, d.partial ? 1 : 0);
    for (const [venueId, vd] of Object.entries(d.byVenue)) this.dayStmt.run(d.utcDay, venueId, vd.usd, vd.swaps);
  }
  private runFill(f: Fill): void {
    const markouts = f.pxApprox ? NULL_MARKOUTS_JSON : JSON.stringify(f.markoutsBps);
    this.fillStmt.run(f.id, f.ts, f.blockNumber, f.venueId, f.market, f.side, f.category,
      f.usd, f.baseAmount, f.execPx, f.pxApprox ? 1 : 0, f.txHash, f.to, f.pool, markouts, f.router ?? null);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void { this.metaStmt.run(key, value); }

  /** Remove every meta key starting with `prefix` (gas.ts coverage epoch).
   *  substr comparison, not LIKE — the prefixes contain `_`, which LIKE
   *  treats as a single-char wildcard. */
  deleteMetaPrefix(prefix: string): void {
    this.db.prepare(`DELETE FROM meta WHERE substr(key, 1, length(?)) = ?`).run(prefix, prefix);
  }

  /** Days in [fromDay, toDay] where the venue has counted burn (gas.ts
   *  bootstrap coverage evidence). */
  gasNonzeroDays(venueId: string, fromDay: string, toDay: string): Set<string> {
    const rows = this.db.prepare(
      `SELECT utc_day FROM daily_gas WHERE venue_id = ? AND utc_day >= ? AND utc_day <= ? AND (mon > 0 OR txs > 0)`,
    ).all(venueId, fromDay, toDay) as Array<{ utc_day: string }>;
    return new Set(rows.map((r) => r.utc_day));
  }

  upsert(d: DailyVolume): void { this.runDay(d); }
  upsertMany(days: DailyVolume[]): void { for (const d of days) this.runDay(d); }

  /**
   * Prune rows whose venue_id is no longer in the registry (a venue was removed)
   * — non-destructive: every REMAINING venue's history is kept, unlike a schema
   * reset. Called once on boot. Guarded against an empty keep-set so a
   * misconfigured registry can never wipe the whole table.
   */
  reconcileVenues(keepIds: string[]): { volume: number; fills: number } {
    if (!keepIds.length) return { volume: 0, fills: 0 };
    const q = keepIds.map(() => '?').join(',');
    const v = this.db.prepare(`DELETE FROM daily_volume WHERE venue_id NOT IN (${q})`).run(...keepIds);
    const f = this.db.prepare(`DELETE FROM fills WHERE venue_id NOT IN (${q})`).run(...keepIds);
    this.db.prepare(`DELETE FROM daily_gas WHERE venue_id NOT IN (${q})`).run(...keepIds);
    return { volume: Number(v.changes), fills: Number(f.changes) };
  }

  /**
   * Drop stored rows for ONE venue so a BACKFILL_RESET is a true replay.
   *
   * Without this a reset can only ever RAISE a venue's history: the backfill
   * writes only the days it decoded fills in (mergeBackfill iterates its
   * accumulator), so a day that used to have volume and now decodes to nothing
   * keeps its old number forever.
   *
   * The two tables are scoped SEPARATELY because their scans are. Deleting
   * wider than the scan restores is silent data loss, so an omitted key means
   * "leave this table alone" — which is the honest answer when the stage that
   * would refill it is switched off. See planVenueReset(), which is the only
   * thing that should build this.
   *
   * The matching scan flags/cursors are re-armed in the SAME transaction as
   * their rows. A crash must never leave history deleted behind a done-flag
   * that prevents the replay from putting it back. A disabled stage has no
   * delete key and keeps its rows, flag and cursor together.
   *
   * Gas is never touched: it accrues from its own sources and has resetGas().
   */
  resetVenueHistory(venueId: string, deletes: ResetDeletes, fromBlock?: bigint): { volume: number; fills: number } {
    this.db.exec('BEGIN');
    try {
      const beforeMs = Date.parse(`${deletes.beforeDay}T00:00:00Z`);
      if (!Number.isFinite(beforeMs) || new Date(beforeMs).toISOString().slice(0, 10) !== deletes.beforeDay) {
        throw new Error(`invalid reset upper day '${deletes.beforeDay}'`);
      }
      let volume = 0, fills = 0;
      if (deletes.volume) {
        const { fromDay } = deletes.volume;
        if (fromDay !== undefined) {
          const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
          if (!Number.isFinite(fromMs) || new Date(fromMs).toISOString().slice(0, 10) !== fromDay) {
            throw new Error(`invalid volume reset day '${fromDay}'`);
          }
        }
        volume = Number((fromDay === undefined
          ? this.db.prepare(`DELETE FROM daily_volume WHERE venue_id = ? AND utc_day < ?`).run(venueId, deletes.beforeDay)
          : this.db.prepare(`DELETE FROM daily_volume WHERE venue_id = ? AND utc_day >= ? AND utc_day < ?`).run(venueId, fromDay, deletes.beforeDay)).changes);
        this.metaStmt.run(`backfill_done_${venueId}`, '');
        this.metaStmt.run(`backfill_cursor_${venueId}`, fromBlock === undefined ? '' : String(fromBlock));
      }
      if (deletes.fills) {
        // fills carry both a block and a timestamp; the scan's resume point is
        // a BLOCK for a targeted replay and a DAY boundary otherwise, so each
        // is matched on its own terms rather than converted (which would need
        // an RPC round-trip to stay exact). The block bound is bound AS a
        // bigint — node:sqlite takes it natively, so there is no lossy
        // bigint→number narrowing to guard.
        let fillFromMs = 0;
        if ('fromDay' in deletes.fills) {
          fillFromMs = Date.parse(`${deletes.fills.fromDay}T00:00:00Z`);
          if (!Number.isFinite(fillFromMs) || new Date(fillFromMs).toISOString().slice(0, 10) !== deletes.fills.fromDay) {
            throw new Error(`invalid fills reset day '${deletes.fills.fromDay}'`);
          }
        }
        fills = Number(('fromBlock' in deletes.fills
          ? this.db.prepare(`DELETE FROM fills WHERE venue_id = ? AND block_number >= ? AND ts < ?`).run(venueId, deletes.fills.fromBlock, beforeMs)
          : this.db.prepare(`DELETE FROM fills WHERE venue_id = ? AND ts >= ? AND ts < ?`).run(venueId, fillFromMs, beforeMs)).changes);
        this.metaStmt.run(`mkfill_done_${venueId}`, '');
        this.metaStmt.run(`mkfill_cursor_${venueId}`, fromBlock === undefined ? '' : String(fromBlock));
        this.db.prepare(`DELETE FROM meta WHERE substr(key, 1, length(?)) = ?`)
          .run(`mkhist_cursor_${venueId}_`, `mkhist_cursor_${venueId}_`);
      }
      this.db.exec('COMMIT');
      return { volume, fills };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── quote-update gas (QUOTE_UPDATE_BURN) ──────────────────────────────────
  /**
   * Accrue gas increments AND advance the venue's cursor in ONE transaction —
   * the additive UPDATE is only safe because a crash can never separate the
   * rows from the cursor that says they were counted.
   */
  applyGas(rows: Array<{ utcDay: string; venueId: string; mon: number; txs: number }>, cursorKey: string, cursorVal: string): void {
    this.db.exec('BEGIN');
    try {
      for (const r of rows) this.gasStmt.run(r.utcDay, r.venueId, r.mon, r.txs);
      this.metaStmt.run(cursorKey, cursorVal);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Wipe one venue's gas series AND its scan metas in one transaction — the
   *  accrual is additive, so deepening a scan without clearing the rows it
   *  already wrote would double-count. Used by the venue-lifetime migration. */
  resetGas(venueId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM daily_gas WHERE venue_id = ?`).run(venueId);
      this.db.prepare(`DELETE FROM meta WHERE key IN (?, ?)`).run(`gas_cursor_${venueId}`, `gas_from_${venueId}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Partial variant of resetGas for destination ADDITIONS (gas.ts
   *  reconcileSourceChange): history before `fromDay` is provably identical
   *  under the old and new destination sets — the added contract didn't exist
   *  yet — so only rows >= fromDay are wiped, with the cursor (the caller
   *  re-seeds it at fromDay's first block). `gas_from` is kept: the series
   *  anchor doesn't move. */
  resetGasFrom(venueId: string, fromDay: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM daily_gas WHERE venue_id = ? AND utc_day >= ?`).run(venueId, fromDay);
      this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(`gas_cursor_${venueId}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Reconstruct GasDay[] (ascending). `today` marks the partial bucket. */
  gasDays(today: string): GasDay[] {
    const rows = this.db.prepare(`SELECT utc_day, venue_id, mon, txs FROM daily_gas ORDER BY utc_day ASC`).all() as Array<Record<string, any>>;
    const byDay = new Map<string, GasDay>();
    for (const r of rows) {
      let d = byDay.get(r.utc_day);
      if (!d) { d = { utcDay: r.utc_day, partial: r.utc_day === today, byVenue: {} }; byDay.set(r.utc_day, d); }
      d.byVenue[r.venue_id] = { mon: r.mon, txs: r.txs };
    }
    return [...byDay.values()].sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
  }

  /** Reconstruct DailyVolume[] from the long (day, venue) rows + partial flags. */
  all(): DailyVolume[] {
    const dayRows = this.db.prepare(`SELECT utc_day, venue_id, usd, swaps FROM daily_volume ORDER BY utc_day ASC`).all() as Array<Record<string, any>>;
    const metaRows = this.db.prepare(`SELECT utc_day, partial FROM day_meta`).all() as Array<Record<string, any>>;
    const partialByDay = new Map(metaRows.map((r) => [r.utc_day as string, !!r.partial]));
    const byDay = new Map<string, DailyVolume>();
    for (const r of dayRows) {
      let d = byDay.get(r.utc_day);
      if (!d) { d = { utcDay: r.utc_day, partial: partialByDay.get(r.utc_day) ?? false, byVenue: {} }; byDay.set(r.utc_day, d); }
      d.byVenue[r.venue_id] = { usd: r.usd, swaps: r.swaps };
    }
    // include a day that has only a partial flag (e.g. today before its first fill)
    for (const [day, partial] of partialByDay) if (!byDay.has(day)) byDay.set(day, { utcDay: day, partial, byVenue: {} });
    return [...byDay.values()].sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
  }

  // ── fills ─────────────────────────────────────────────────────────────────
  /**
   * Atomic snapshot write: daily volume + the cursor meta + aged/new fills, all
   * in ONE transaction. This is the hot persist path — writing them together
   * means a crash can never leave the volume ahead of the lastProcessedBlock
   * cursor, which a gap-fill on the next boot would otherwise re-count (fills
   * dedupe by their deterministic txHash:logIndex id).
   */
  persistSnapshot(days: DailyVolume[], meta: Record<string, string>, fills: Fill[], mids: MidPoint[] = []): void {
    this.db.exec('BEGIN');
    try {
      for (const d of days) this.runDay(d);
      for (const [k, v] of Object.entries(meta)) this.metaStmt.run(k, v);
      for (const f of fills) this.runFill(f);
      for (const m of mids) this.midStmt.run(m.market, m.ts, m.mid);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Insert/refresh fills (markouts mutate as a fill ages) in one transaction. */
  upsertFills(fills: Fill[]): void {
    if (!fills.length) return;
    this.db.exec('BEGIN');
    try {
      for (const f of fills) this.runFill(f);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Most recent fills, oldest-first (ready to use as an in-memory ring). */
  recentFills(limit: number): Fill[] {
    const rows = this.db.prepare(`SELECT * FROM fills ORDER BY ts DESC LIMIT ?`).all(limit) as Array<Record<string, any>>;
    return rows.map(rowToFill).reverse();
  }

  /** Fills since `sinceMs` (epoch ms), newest-first, capped at `limit`. */
  fillsSince(sinceMs: number, limit: number): Fill[] {
    const rows = this.db.prepare(`SELECT * FROM fills WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(sinceMs, limit) as Array<Record<string, any>>;
    return rows.map(rowToFill);
  }

  /** Light rows for the SERVER-SIDE leaderboard aggregation — the FULL window,
   *  no cap (capping is what silently truncated the 7D/30D views client-side).
   *  pxApprox rows are excluded here: the shared contract keeps them out of
   *  every markout/leaderboard stat, volume included. ts-ascending so the
   *  aggregation's cumulative-PnL sparklines accumulate in fill order. */
  lbFillsChunk(sinceMs: number, afterTs: number, afterId: string, limit: number, maxTs?: number): Array<{ id: string; ts: number; venueId: string; category: string; router?: string; pool: string; to: string; usd: number; markoutsBps: (number | null)[] }> {
    // KEYSET page (ts, id) so the aggregation streams the window in bounded
    // slices — materializing a full 30d window (10⁵–10⁶ rows) OOM'd the 512MB
    // production box. Horizons extracted in SQL (C-side): a per-row JSON.parse
    // in JS was a measurable slice of the pass. `maxTs` pins a later pass to an
    // earlier pass's snapshot upper bound (live fills keep landing in between).
    const rows = this.db.prepare(`
      SELECT id, ts, venue_id, category, router, pool, to_label, usd,
             json_extract(markouts_bps, '$[0]') AS m0, json_extract(markouts_bps, '$[1]') AS m1,
             json_extract(markouts_bps, '$[2]') AS m2, json_extract(markouts_bps, '$[3]') AS m3,
             json_extract(markouts_bps, '$[4]') AS m4
      FROM fills
      WHERE ts >= ? AND px_approx = 0 AND (ts > ? OR (ts = ? AND id > ?)) AND ts <= ?
      ORDER BY ts ASC, id ASC LIMIT ?
    `).all(sinceMs, afterTs, afterTs, afterId, maxTs ?? Number.MAX_SAFE_INTEGER, limit) as Array<Record<string, any>>;
    return rows.map((r) => ({
      id: r.id, ts: r.ts, venueId: r.venue_id, category: r.category,
      pool: r.pool, to: r.to_label, usd: r.usd, markoutsBps: [r.m0, r.m1, r.m2, r.m3, r.m4],
    }));
  }

  /** Full fills by id (order not preserved) — resolves the aggregation's
   *  top-swap/outlier selections. Chunked under SQLite's bound-param limit. */
  fillsByIds(ids: string[]): Fill[] {
    const out: Fill[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const q = part.map(() => '?').join(',');
      out.push(...(this.db.prepare(`SELECT * FROM fills WHERE id IN (${q})`).all(...part) as Array<Record<string, any>>).map(rowToFill));
    }
    return out;
  }

  /** Exact retained fill counts by UTC day and venue, with no API/query cap. */
  fillCountsByDayVenue(): Array<{ utcDay: string; venueId: string; swaps: number }> {
    const rows = this.db.prepare(`
      SELECT date(ts / 1000, 'unixepoch') AS utc_day, venue_id, COUNT(*) AS swaps
      FROM fills
      GROUP BY utc_day, venue_id
    `).all() as Array<Record<string, any>>;
    return rows.map((r) => ({ utcDay: r.utc_day, venueId: r.venue_id, swaps: Number(r.swaps) }));
  }

  // ── onboarding markout backfill (last ~30d per venue) ───────────────────────
  /** Insert fills only if ABSENT (ON CONFLICT DO NOTHING) — the onboarding fill
   *  scan re-decodes ranges the live tail may have already persisted, and must
   *  never clobber a live-marked fill's markouts. Returns rows actually added. */
  insertFillsIfAbsent(fills: Fill[]): number {
    if (!fills.length) return 0;
    const ins = this.db.prepare(`
      INSERT INTO fills (id, ts, block_number, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label, pool, markouts_bps, router)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`);
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const f of fills) {
        const markouts = f.pxApprox ? NULL_MARKOUTS_JSON : JSON.stringify(f.markoutsBps);
        const info = ins.run(f.id, f.ts, f.blockNumber, f.venueId, f.market, f.side, f.category,
          f.usd, f.baseAmount, f.execPx, f.pxApprox ? 1 : 0, f.txHash, f.to, f.pool, markouts, f.router ?? null);
        added += Number(info.changes);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return added;
  }

  /** One-time honesty relabel for retained fills: adapters that used to
   *  hardcode a category reset their stored claims (unevidenced DIRECT →
   *  UNKNOWN); the caller guards with a meta flag so it runs once. */
  relabelCategory(venueIds: string[], from: string, to: string): number {
    if (!venueIds.length) return 0;
    const q = venueIds.map(() => '?').join(',');
    const info = this.db.prepare(`UPDATE fills SET category = ? WHERE category = ? AND venue_id IN (${q})`).run(to, from, ...venueIds);
    return Number(info.changes);
  }

  /** One-time reclassification of retained fills by attributed brand — e.g.
   *  FastLane rows written as ROUTER before the MEV class existed. */
  relabelCategoryByRouter(router: string, from: string, to: string): number {
    const info = this.db.prepare(`UPDATE fills SET category = ? WHERE category = ? AND router = ?`).run(to, from, router);
    return Number(info.changes);
  }

  /** Markets where this VENUE still has unmarked fills (all-null markouts, real
   *  execPx) older than `beforeTs` — the remark job's work list. Venue-scoped so
   *  one venue's onboarding can never skip another's later-added history. */
  remarkCandidateMarkets(venueId: string, beforeTs: number): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT market FROM fills
      WHERE venue_id = ? AND px_approx = 0 AND markouts_bps = ? AND ts < ?
    `).all(venueId, NULL_MARKOUTS_JSON, beforeTs) as Array<{ market: string }>;
    return rows.map((r) => r.market);
  }

  /** Earliest unmarked fill for (venue, market) — initializes the day cursor. */
  earliestRemarkCandidate(venueId: string, market: string, beforeTs: number): number | null {
    const row = this.db.prepare(`
      SELECT MIN(ts) AS t FROM fills
      WHERE venue_id = ? AND market = ? AND px_approx = 0 AND markouts_bps = ? AND ts < ?
    `).get(venueId, market, NULL_MARKOUTS_JSON, beforeTs) as { t: number | null } | undefined;
    return row?.t ?? null;
  }

  /** Unmarked fills for (venue, market) in [fromTs, toTs) — ts is already the
   *  REAL block time (the onboarding scan resolves timestamps at decode). */
  fillsForRemark(venueId: string, market: string, fromTs: number, toTs: number): Array<{ id: string; ts: number; side: string; execPx: number }> {
    const rows = this.db.prepare(`
      SELECT id, ts, side, exec_px FROM fills
      WHERE venue_id = ? AND market = ? AND px_approx = 0 AND markouts_bps = ? AND ts >= ? AND ts < ?
      ORDER BY ts ASC
    `).all(venueId, market, NULL_MARKOUTS_JSON, fromTs, toTs) as Array<Record<string, any>>;
    return rows.map((r) => ({ id: r.id, ts: r.ts, side: r.side, execPx: r.exec_px }));
  }

  /** Apply computed historical markouts in one transaction. */
  applyRemarks(rows: Array<{ id: string; markoutsBps: (number | null)[] }>): void {
    if (!rows.length) return;
    const upd = this.db.prepare(`UPDATE fills SET markouts_bps = ? WHERE id = ?`);
    this.db.exec('BEGIN');
    try {
      for (const r of rows) upd.run(JSON.stringify(r.markoutsBps), r.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Drop fills older than `beforeMs` (retention). Returns rows removed. */
  pruneFills(beforeMs: number): number {
    const info = this.db.prepare(`DELETE FROM fills WHERE ts < ?`).run(beforeMs);
    return Number(info.changes);
  }

  /** Drop mid-history samples older than `beforeMs` (same retention as fills —
   *  the curve only exists to replay retained fills). Returns rows removed. */
  pruneMids(beforeMs: number): number {
    const info = this.db.prepare(`DELETE FROM mid_history WHERE ts < ?`).run(beforeMs);
    return Number(info.changes);
  }

  /** Nearest persisted mid for (market, t) within ±MID_REPLAY_TOL_MS, or null. */
  private midNearPersisted(market: string, t: number): number | null {
    const row = this.db.prepare(`
      SELECT mid FROM mid_history
      WHERE market = ? AND ts BETWEEN ? AND ?
      ORDER BY ABS(ts - ?) LIMIT 1
    `).get(market, t - MID_REPLAY_TOL_MS, t + MID_REPLAY_TOL_MS, t) as { mid: number } | undefined;
    return row ? row.mid : null;
  }

  /**
   * Recompute every retained fill's markouts from the persisted mid curve —
   * used by a markout-model bump whose stored mids remain valid
   * (REMARK_FROM_MID_HISTORY). A horizon with no sample within tolerance stays
   * null (excluded, never fabricated). Returns how many fills got ≥1 replayed
   * horizon vs none.
   */
  remarkRetainedFills(): { remarked: number; nulled: number } {
    const rows = this.db.prepare(`SELECT id, ts, market, side, exec_px, px_approx FROM fills`).all() as Array<Record<string, any>>;
    const upd = this.db.prepare(`UPDATE fills SET markouts_bps = ? WHERE id = ?`);
    let remarked = 0, nulled = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        // an approximate-price fill has no true execPx — replaying mid/execPx
        // would fabricate the very markouts the pxApprox contract excludes.
        if (r.px_approx) { upd.run(NULL_MARKOUTS_JSON, r.id); nulled++; continue; }
        const ss = r.side === 'buy' ? 1 : -1;
        const marks: (number | null)[] = MARKOUT_HORIZONS.map((h) => {
          const mid = this.midNearPersisted(r.market, r.ts + h * 1000);
          return mid == null || mid <= 0 || r.exec_px <= 0 ? null : ss * (mid / r.exec_px - 1) * 1e4;
        });
        upd.run(JSON.stringify(marks), r.id);
        if (marks.some((m) => m != null)) remarked++; else nulled++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { remarked, nulled };
  }

  close(): void { this.db.close(); }
}

function rowToFill(r: Record<string, any>): Fill {
  const pxApprox = !!r.px_approx;
  return {
    id: r.id, ts: r.ts, blockNumber: r.block_number, venueId: r.venue_id,
    market: r.market, side: r.side, category: r.category,
    usd: r.usd, baseAmount: r.base_amount, execPx: r.exec_px,
    // restore the approximate-price flag so a persisted pxApprox fill stays
    // excluded from markout/leaderboard stats across restarts (shared contract).
    ...(pxApprox ? { pxApprox: true } : {}),
    txHash: r.tx_hash, to: r.to_label, pool: r.pool,
    ...(r.router ? { router: r.router } : {}),
    markoutsBps: pxApprox ? nullMarkouts() : JSON.parse(r.markouts_bps),
  };
}
