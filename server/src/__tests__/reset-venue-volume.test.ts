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

const fill = (id: string, venueId: string, blockNumber = 1): Fill => ({
  id, venueId, ts: 1_785_000_000_000, blockNumber, market: 'MON/USDC', side: 'buy',
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
  store.upsertFills([
    fill('a', 'thogamm', 95_000_000),   // before a 2026-08-15 window
    fill('b', 'thogamm', 97_000_000),   // inside it
    fill('c', 'poe', 97_000_000),
  ]);
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

/**
 * A targeted replay only re-scans from its start, so anything deleted before
 * that is gone for good (Copilot review, PR #84). The two halves are scoped
 * differently on purpose: volume by DAY, because backfillOnchain re-scans the
 * whole day its cursor lands in; fills by BLOCK, because backfillRecentFills
 * resumes at the exact block and never day-aligns.
 */
describe('resetVenueVolume — targeted', () => {
  const FROM = { block: 96_000_000n, day: '2026-08-15' };

  it('keeps day-rows before the window and drops the ones from it onward', () => {
    expect(store.resetVenueVolume('thogamm', FROM)).toEqual({ volume: 1, fills: 1 });
    expect(venuesOn('2026-08-11')).toEqual(['poe', 'thogamm']);   // pre-window: survives
    expect(venuesOn('2026-08-20')).toEqual([]);                   // in-window: cleared
  });

  it('keeps fills below the start block and drops the ones at or above it', () => {
    store.resetVenueVolume('thogamm', FROM);
    expect(store.recentFills(10).map((f) => f.id).sort()).toEqual(['a', 'c']);
  });

  it('a window past everything stored changes nothing', () => {
    expect(store.resetVenueVolume('thogamm', { block: 99_000_000n, day: '2026-12-01' }))
      .toEqual({ volume: 0, fills: 0 });
    expect(venuesOn('2026-08-11')).toEqual(['poe', 'thogamm']);
    expect(venuesOn('2026-08-20')).toEqual(['thogamm']);
  });

  it('a window before everything stored matches the lifetime delete', () => {
    expect(store.resetVenueVolume('thogamm', { block: 1n, day: '2026-01-01' }))
      .toEqual({ volume: 2, fills: 2 });
  });
});
