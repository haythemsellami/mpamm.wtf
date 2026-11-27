// Builds a database in TODAY's format (schema 3, written by today's own
// VolumeStore) from a deployment's public API: recent fills, every day's
// volume and gas, and the fills cursor. A stand-in for a production snapshot
// when rehearsing the migration to the rebuild's store without touching
// production:  npx tsx scripts/v1-db-from-api.ts https://mpamm.wtf /tmp/v1.db
import { VolumeStore } from '../src/db.js';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: v1-db-from-api.ts <base-url> <out.db>');
const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};
const store = new VolumeStore(out);
const fills = await get('/api/fills?days=31&limit=50000');
const volume = await get('/api/volume');
const gas = await get('/api/gas');
const health = await get('/api/health');
store.upsertMany(volume.days ?? volume);
store.upsertFills(fills);
const gasRows = (gas.days as any[]).flatMap((d) => Object.entries(d.byVenue).map(([venueId, g]: [string, any]) => ({ utcDay: d.utcDay, venueId, mon: g.mon, txs: g.txs })));
store.applyGas(gasRows, 'gas_cursor_rehearsal', '0');
const cursor = health?.tail?.block ?? Math.max(...fills.map((f: any) => f.blockNumber));
store.setMeta('lastProcessedBlock', String(cursor));
console.log(`fills ${fills.length}, volume days ${(volume.days ?? volume).length}, gas rows ${gasRows.length}, cursor ${cursor}`);
