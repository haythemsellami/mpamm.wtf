// VolumeStore.resetVenueVolume — the DELETE behind BACKFILL_RESET.
//
// backfill-reset.test.ts covers which keys a reset touches against a fake
// store; this one runs the real SQL, because the bug it exists to prevent is
// a row surviving a reset, and only the database can prove that.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fill } from '@shared';
import { VolumeStore } from '../db.js';

let dir: string;
let store: VolumeStore;

const fill = (id: string, venueId: string): Fill => ({
  id, venueId, ts: 1_785_000_000_000, blockNumber: 1, market: 'MON/USDC', side: 'buy',
  category: 'UNKNOWN', usd: 5, baseAmount: 1, execPx: 5, txHash: `0x${id}`, to: '0x',
  pool: 'p', markoutsBps: [null, null, null, null, null],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mpamm-store-'));
  store = new VolumeStore(join(dir, 'test.db'));
  store.upsertMany([
    { utcDay: '2026-08-11', partial: false, byVenue: { thogamm: { usd: 937_737.5, swaps: 1467 }, poe: { usd: 10, swaps: 1 } } },
    { utcDay: '2026-08-20', partial: false, byVenue: { thogamm: { usd: 881_760.99, swaps: 137 } } },
  ]);
  store.upsertFills([fill('a', 'thogamm'), fill('b', 'thogamm'), fill('c', 'poe')]);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const venuesOn = (day: string) =>
  Object.keys(store.all().find((d) => d.utcDay === day)?.byVenue ?? {}).sort();

describe('resetVenueVolume', () => {
  it('deletes the venue\'s day-rows and fills, and reports the counts', () => {
    expect(store.resetVenueVolume('thogamm')).toEqual({ volume: 2, fills: 2 });
    expect(venuesOn('2026-08-11')).toEqual(['poe']);
    expect(venuesOn('2026-08-20')).toEqual([]);          // absent = 0 (@shared: DailyVolume)
    expect(store.recentFills(10).map((f) => f.id)).toEqual(['c']);
  });

  it('leaves every other venue intact', () => {
    store.resetVenueVolume('thogamm');
    const day = store.all().find((d) => d.utcDay === '2026-08-11')!;
    expect(day.byVenue.poe).toEqual({ usd: 10, swaps: 1 });
  });

  it('is a no-op for a venue with nothing stored', () => {
    expect(store.resetVenueVolume('nobody')).toEqual({ volume: 0, fills: 0 });
    expect(venuesOn('2026-08-11')).toEqual(['poe', 'thogamm']);
  });

  it('is idempotent — a second reset finds nothing left', () => {
    store.resetVenueVolume('thogamm');
    expect(store.resetVenueVolume('thogamm')).toEqual({ volume: 0, fills: 0 });
  });
});
