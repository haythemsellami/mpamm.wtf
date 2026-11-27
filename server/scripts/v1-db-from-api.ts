// Builds a database in TODAY's format (schema 3, written by today's own
// VolumeStore) from a deployment's public API: recent fills, every day's
// volume and gas, and the fills cursor. A stand-in for a production snapshot
// when rehearsing the migration to the rebuild's store without touching
// production:  npx tsx scripts/v1-db-from-api.ts https://mpamm.wtf /tmp/v1.db
import type { DailyVolume, Fill, GasResponse } from '@shared';
import { VolumeStore } from '../src/db.js';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: v1-db-from-api.ts <base-url> <out.db>');
const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};
const store = new VolumeStore(out);
const fills = await get<Fill[]>('/api/fills?days=31&limit=50000');
const volumeBody = await get<DailyVolume[] | { days: DailyVolume[] }>('/api/volume');
const volume = Array.isArray(volumeBody) ? volumeBody : volumeBody.days;
const gas = await get<GasResponse>('/api/gas');
const health = await get<{ tail?: { block?: number } }>('/api/health');
store.upsertMany(volume);
store.upsertFills(fills);
const gasRows = gas.days.flatMap((d) => Object.entries(d.byVenue).map(([venueId, g]) => ({ utcDay: d.utcDay, venueId, mon: g.mon, txs: g.txs })));
store.applyGas(gasRows, 'gas_cursor_rehearsal', '0');
const cursor = health.tail?.block ?? Math.max(...fills.map((f) => f.blockNumber));
store.setMeta('lastProcessedBlock', String(cursor));
console.log(`fills ${fills.length}, volume days ${volume.length}, gas rows ${gasRows.length}, cursor ${cursor}`);
