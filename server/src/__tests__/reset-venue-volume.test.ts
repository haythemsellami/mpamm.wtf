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

/** Block AND day travel together, because the two delete predicates key on
 *  different ones and a fixture that conflated them could not tell them apart. */
const fill = (id: string, venueId: string, blockNumber: number, day: string): Fill => ({
  id, venueId, ts: Date.parse(`${day}T12:00:00Z`), blockNumber, market: 'MON/USDC', side: 'buy',
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
    fill('a', 'thogamm', 95_000_000, '2026-08-01'),   // before a 2026-08-15 window
    fill('b', 'thogamm', 97_000_000, '2026-08-20'),   // inside it
    fill('c', 'poe', 97_000_000, '2026-08-20'),
  ]);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const TODAY = '2026-08-23';   // all fixture rows are closed days before this

const venuesOn = (day: string) =>
  Object.keys(store.all().find((d) => d.utcDay === day)?.byVenue ?? {}).sort();

describe('resetVenueVolume', () => {
  it('lifetime: drops every day-row, and fills from the window day onward', () => {
    // 'a' sits before the window and is NOT deleted: the fills scan only covers
    // its rolling window, so anything older is never re-inserted.
    expect(store.resetVenueVolume('thogamm', { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-08-15' } }))
      .toEqual({ volume: 2, fills: 1 });
    expect(venuesOn('2026-08-11')).toEqual(['poe']);
    expect(venuesOn('2026-08-20')).toEqual([]);           // absent = 0 (@shared: DailyVolume)
    expect(store.recentFills(10).map((f) => f.id).sort()).toEqual(['a', 'c']);
  });

  it('leaves every other venue intact', () => {
    store.resetVenueVolume('thogamm', { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-01-01' } });
    const day = store.all().find((d) => d.utcDay === '2026-08-11')!;
    expect(day.byVenue.poe).toEqual({ usd: 10, swaps: 1 });
    expect(store.recentFills(10).map((f) => f.id)).toEqual(['c']);
  });

  it('is a no-op for a venue with nothing stored', () => {
    expect(store.resetVenueVolume('nobody', { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-01-01' } }))
      .toEqual({ volume: 0, fills: 0 });
    expect(venuesOn('2026-08-11')).toEqual(['poe', 'thogamm']);
  });

  it('is idempotent — a second reset finds nothing left', () => {
    const all = { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-01-01' } };
    store.resetVenueVolume('thogamm', all);
    expect(store.resetVenueVolume('thogamm', all)).toEqual({ volume: 0, fills: 0 });
  });

  /** An omitted key means the scan that would refill that table is switched
   *  off (BACKFILL=off / MARKOUT_BACKFILL=off), so deleting would destroy
   *  history nothing is coming back to rebuild. */
  it('touches only the tables it is asked to', () => {
    expect(store.resetVenueVolume('thogamm', { beforeDay: TODAY, volume: {} })).toEqual({ volume: 2, fills: 0 });
    expect(store.recentFills(10).map((f) => f.id).sort()).toEqual(['a', 'b', 'c']);

    expect(store.resetVenueVolume('thogamm', { beforeDay: TODAY, fills: { fromDay: '2026-01-01' } }))
      .toEqual({ volume: 0, fills: 2 });
  });

  it('deletes nothing at all for an empty scope', () => {
    expect(store.resetVenueVolume('thogamm', { beforeDay: TODAY })).toEqual({ volume: 0, fills: 0 });
    expect(venuesOn('2026-08-20')).toEqual(['thogamm']);
    expect(store.recentFills(10)).toHaveLength(3);
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
  const SCOPE = { beforeDay: TODAY, volume: { fromDay: '2026-08-15' }, fills: { fromBlock: 96_000_000n } };

  it('keeps day-rows before the window and drops the ones from it onward', () => {
    expect(store.resetVenueVolume('thogamm', SCOPE)).toEqual({ volume: 1, fills: 1 });
    expect(venuesOn('2026-08-11')).toEqual(['poe', 'thogamm']);   // pre-window: survives
    expect(venuesOn('2026-08-20')).toEqual([]);                   // in-window: cleared
  });

  it('keeps fills below the start block and drops the ones at or above it', () => {
    store.resetVenueVolume('thogamm', SCOPE);
    expect(store.recentFills(10).map((f) => f.id).sort()).toEqual(['a', 'c']);
  });

  it('a window past everything stored changes nothing', () => {
    expect(store.resetVenueVolume('thogamm', { beforeDay: TODAY, volume: { fromDay: '2026-12-01' }, fills: { fromBlock: 99_000_000n } }))
      .toEqual({ volume: 0, fills: 0 });
    expect(venuesOn('2026-08-11')).toEqual(['poe', 'thogamm']);
    expect(venuesOn('2026-08-20')).toEqual(['thogamm']);
  });

  it('a window before everything stored matches the lifetime delete', () => {
    expect(store.resetVenueVolume('thogamm', { beforeDay: TODAY, volume: { fromDay: '2026-01-01' }, fills: { fromBlock: 1n } }))
      .toEqual({ volume: 2, fills: 2 });
  });
});

/**
 * Today belongs to the live tail: the volume backfill skips `day >= today` and
 * the fills scan batches only `utcDay(f.ts) < today`, so a replay never
 * rebuilds it. Deleting it would drop what was already counted since midnight,
 * with the tail's cursor long past re-emitting it (Copilot review, PR #84).
 */
describe('resetVenueVolume — today is never deleted', () => {
  beforeEach(() => {
    store.upsertMany([{ utcDay: '2026-08-23', partial: true, byVenue: { thogamm: { usd: 500, swaps: 7 } } }]);
    store.upsertFills([fill('d', 'thogamm', 98_000_000, '2026-08-23')]);
  });

  it('keeps today\u2019s partial row and fills even on a lifetime reset', () => {
    expect(store.resetVenueVolume('thogamm', { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-01-01' } }))
      .toEqual({ volume: 2, fills: 2 });
    expect(venuesOn('2026-08-23')).toEqual(['thogamm']);
    expect(store.recentFills(10).map((f) => f.id).sort()).toEqual(['c', 'd']);
  });

  it('keeps it on a targeted reset whose block bound reaches into today', () => {
    store.resetVenueVolume('thogamm', { beforeDay: TODAY, volume: { fromDay: '2026-08-01' }, fills: { fromBlock: 1n } });
    expect(venuesOn('2026-08-23')).toEqual(['thogamm']);
    expect(store.recentFills(10).map((f) => f.id).sort()).toEqual(['c', 'd']);
  });
});
