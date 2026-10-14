// The boot swap-count reconcile (live.ts reconcileDaySwaps) and what it reports.
//
// The reconcile SETs each retained day's swap count from its fills, and never
// touches USD. A replay that booked fills onto the wrong day leaves both off;
// a silent rewrite fixes the count and erases the only sign that USD is still
// wrong (2026-09-21: 12 clober-vault fills booked a day early, counts quietly
// fixed 503→491 / 689→701 at the next boot, USD ±$1,268 off for three weeks).
import { describe, expect, it } from 'vitest';
import type { DailyVolume } from '@shared';
import { rebuildExcuse, reconcileDaySwaps, swapNet, swapNoteMsg, type SwapCountChange, type VenueRebuild } from '../datasource/live.js';
import { NOTE_MSG_MAX } from '../notes.js';

const TODAY = '2026-09-22';
const day = (utcDay: string, byVenue: DailyVolume['byVenue']): DailyVolume => ({ utcDay, partial: utcDay === TODAY, byVenue });

describe('reconcileDaySwaps', () => {
  it('reports a closed day whose non-zero count it changed — the misbucket pair', () => {
    const days = [
      day('2026-09-18', { 'clober-vault': { usd: 50_000, swaps: 503 } }),
      day('2026-09-19', { 'clober-vault': { usd: 70_000, swaps: 689 } }),
    ];
    const changes = reconcileDaySwaps(days, [
      { utcDay: '2026-09-18', venueId: 'clober-vault', swaps: 491 },
      { utcDay: '2026-09-19', venueId: 'clober-vault', swaps: 701 },
    ], TODAY);
    expect(changes).toEqual([
      { venueId: 'clober-vault', utcDay: '2026-09-18', from: 503, to: 491 },
      { venueId: 'clober-vault', utcDay: '2026-09-19', from: 689, to: 701 },
    ]);
    // the counts are still rewritten, and USD is left exactly as stored
    expect(days.map((d) => d.byVenue['clober-vault'])).toEqual([{ usd: 50_000, swaps: 491 }, { usd: 70_000, swaps: 701 }]);
  });

  it('fills in a stored 0 or a missing venue silently — that is the job, not evidence', () => {
    const days = [day('2026-09-18', { metric: { usd: 9_000, swaps: 0 } })];
    const changes = reconcileDaySwaps(days, [
      { utcDay: '2026-09-18', venueId: 'metric', swaps: 40 },
      { utcDay: '2026-09-18', venueId: 'poe', swaps: 7 },
    ], TODAY);
    expect(changes).toEqual([]);
    expect(days[0].byVenue).toEqual({ metric: { usd: 9_000, swaps: 40 }, poe: { usd: 0, swaps: 7 } });
  });

  it('never reports today, an unchanged count, or a day with no retained fills', () => {
    const days = [
      day('2026-09-10', { metric: { usd: 1, swaps: 12 } }),   // no fills retained: untouched
      day('2026-09-20', { metric: { usd: 1, swaps: 30 } }),   // matches its fills
      day(TODAY, { metric: { usd: 1, swaps: 5 } }),           // the tail's, mid-accrual
    ];
    const changes = reconcileDaySwaps(days, [
      { utcDay: '2026-09-20', venueId: 'metric', swaps: 30 },
      { utcDay: TODAY, venueId: 'metric', swaps: 9 },
    ], TODAY);
    expect(changes).toEqual([]);
    expect(days.map((d) => d.byVenue.metric.swaps)).toEqual([12, 30, 9]);
  });
});

describe('swapNet / swapNoteMsg', () => {
  const c = (utcDay: string, from: number, to: number): SwapCountChange => ({ venueId: 'v', utcDay, from, to });

  it('nets the changes — 0 is fills moved between days', () => {
    expect(swapNet([c('2026-09-19', 689, 701), c('2026-09-18', 503, 491)])).toBe('0');
    expect(swapNet([c('2026-09-18', 10, 13)])).toBe('+3');
    expect(swapNet([c('2026-09-18', 13, 10)])).toBe('-3');
  });

  it('lists every day, in order, when they fit', () => {
    expect(swapNoteMsg('h: ', [c('2026-09-19', 689, 701), c('2026-09-18', 503, 491)]))
      .toBe('h: 2026-09-18 503→491, 2026-09-19 689→701');
  });

  it('budgets the list against the whole message, cutting whole entries', () => {
    const many = Array.from({ length: 9 }, (_, i) => c(`2026-09-${String(10 + i).padStart(2, '0')}`, 100, 101));
    expect(swapNoteMsg('h: ', many, 60)).toBe('h: 2026-09-10 100→101, 2026-09-11 100→101, +7 more');
    // a head with no room for one entry still says how many there were
    expect(swapNoteMsg('x'.repeat(55), many, 60)).toBe(`${'x'.repeat(55)}+9 more`);
  });

  it('never needs scrubNote to cut it, whatever the head and counts', () => {
    // up to a month of 4-digit rewrites behind heads as long as the real ones get
    const month = Array.from({ length: 31 }, (_, i) => c(`2026-08-${String(1 + i).padStart(2, '0')}`, 9_999, 1_000));
    for (let head = 0; head <= 200; head += 10) {
      for (let n = 1; n <= month.length; n++) {
        const msg = swapNoteMsg('h'.repeat(head), month.slice(0, n));
        expect(msg.length).toBeLessThanOrEqual(NOTE_MSG_MAX);
        expect(msg).toMatch(/(9999→1000|\+\d+ more)$/);   // ends on a whole entry or the count
      }
    }
  });
});

describe('rebuildExcuse — only a day a pending stage still rebuilds is expected', () => {
  // three retained days, fills at blocks 100–199, 200–299, 300–399
  const spans = new Map([
    ['2026-09-18', { minBlock: 100, maxBlock: 199 }],
    ['2026-09-19', { minBlock: 200, maxBlock: 299 }],
    ['2026-09-20', { minBlock: 300, maxBlock: 399 }],
  ]);
  const DAYS = [...spans.keys()];
  const change = (utcDay: string): SwapCountChange => ({ venueId: 'v', utcDay, from: 10, to: 11 });
  /** the days `pending` excuses, each with its reasons */
  const excused = (pending: Partial<VenueRebuild>) => Object.fromEntries(DAYS
    .map((d) => [d, rebuildExcuse(change(d), spans, { resets: [], ...pending })] as const)
    .filter(([, why]) => why.length));

  it('excuses nothing when no stage is pending', () => {
    expect(excused({})).toEqual({});
  });

  it('a queued reset covers only the days from its start', () => {
    expect(Object.keys(excused({ resets: [{ from: 'lifetime' }] }))).toEqual(DAYS);
    expect(Object.keys(excused({ resets: [{ from: 'day', day: '2026-09-19' }] }))).toEqual(['2026-09-19', '2026-09-20']);
    // a reset starting today is today's re-read alone: no closed day is rebuilt
    expect(excused({ resets: [{ from: 'day', day: TODAY }] })).toEqual({});
    expect(Object.keys(excused({ resets: [{ from: 'block', block: 250n }] }))).toEqual(['2026-09-19', '2026-09-20']);
    // a block past the day's last fill cannot be placed on that day: warn
    expect(Object.keys(excused({ resets: [{ from: 'block', block: 300n }] }))).toEqual(['2026-09-20']);
  });

  it('an unfinished volume replay excuses the days it has not SET yet — never one it already re-SET', () => {
    // 09-18 was SET by this very replay: a mismatch there is the replay's own misbucket
    expect(excused({ volume: { cursor: 250n } })).toEqual({
      '2026-09-19': ['volume replay unfinished'], '2026-09-20': ['volume replay unfinished'],
    });
    expect(Object.keys(excused({ volume: {} }))).toEqual(DAYS);   // not started: every day is still to be SET
  });

  it('an unfinished fills onboarding excuses the day its cursor sits in and later days', () => {
    expect(Object.keys(excused({ fills: { cursor: 250n, fromDay: '2026-09-01' } }))).toEqual(['2026-09-19', '2026-09-20']);
    // no cursor yet: the scan restarts at its window start, and days before it are untouched
    expect(Object.keys(excused({ fills: { fromDay: '2026-09-19' } }))).toEqual(['2026-09-19', '2026-09-20']);
    // the window start is a floor even when the cursor lags behind it
    expect(Object.keys(excused({ fills: { cursor: 150n, fromDay: '2026-09-20' } }))).toEqual(['2026-09-20']);
  });

  it('names every stage that explains a day', () => {
    expect(excused({ resets: [{ from: 'lifetime' }], volume: { cursor: 350n } })['2026-09-20'])
      .toEqual(['reset queued', 'volume replay unfinished']);
  });
});
