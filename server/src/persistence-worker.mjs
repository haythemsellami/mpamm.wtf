import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) throw new Error('snapshot worker requires a parent port');

const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA busy_timeout = 5000');

const dayStmt = db.prepare(`
  INSERT INTO daily_volume (utc_day, venue_id, usd, swaps) VALUES (?, ?, ?, ?)
  ON CONFLICT(utc_day, venue_id) DO UPDATE SET usd = excluded.usd, swaps = excluded.swaps`);
const dayMetaStmt = db.prepare(`
  INSERT INTO day_meta (utc_day, partial) VALUES (?, ?)
  ON CONFLICT(utc_day) DO UPDATE SET partial = excluded.partial`);
const metaStmt = db.prepare(`
  INSERT INTO meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const fillStmt = db.prepare(`
  INSERT INTO fills (id, ts, block_number, venue_id, market, side, category, usd, base_amount, exec_px, px_approx, tx_hash, to_label, pool, markouts_bps, router)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET markouts_bps = excluded.markouts_bps, px_approx = excluded.px_approx`);
const midStmt = db.prepare(`
  INSERT INTO mid_history (market, ts, mid) VALUES (?, ?, ?)
  ON CONFLICT(market, ts) DO UPDATE SET mid = excluded.mid`);

const runDay = (day) => {
  dayMetaStmt.run(day.utcDay, day.partial ? 1 : 0);
  for (const [venueId, volume] of Object.entries(day.byVenue)) {
    dayStmt.run(day.utcDay, venueId, volume.usd, volume.swaps);
  }
};

const runFill = (fill) => {
  const markouts = fill.pxApprox
    ? JSON.stringify(fill.markoutsBps.map(() => null))
    : JSON.stringify(fill.markoutsBps);
  fillStmt.run(
    fill.id, fill.ts, fill.blockNumber, fill.venueId, fill.market, fill.side, fill.category,
    fill.usd, fill.baseAmount, fill.execPx, fill.pxApprox ? 1 : 0, fill.txHash, fill.to,
    fill.pool, markouts, fill.router ?? null,
  );
};

parentPort.on('message', ({ id, snapshot, close }) => {
  if (close) {
    db.close();
    parentPort.postMessage({ id, ok: true });
    parentPort.close();
    return;
  }
  try {
    db.exec('BEGIN');
    for (const day of snapshot.days) runDay(day);
    for (const [key, value] of Object.entries(snapshot.meta)) metaStmt.run(key, value);
    for (const fill of snapshot.fills) runFill(fill);
    for (const mid of snapshot.mids) midStmt.run(mid.market, mid.ts, mid.mid);
    db.exec('COMMIT');
    parentPort.postMessage({ id, ok: true });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction never opened */ }
    parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
