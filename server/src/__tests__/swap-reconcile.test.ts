// The boot swap-count reconcile (live.ts reconcileDaySwaps) and what it reports.
//
// The reconcile SETs each retained day's swap count from its fills, and never
// touches USD. A replay that booked fills onto the wrong day leaves both off;
// a silent rewrite fixes the count and erases the only sign that USD is still
// wrong (2026-09-21: 12 clober-vault fills booked a day early, counts quietly
// fixed 503→491 / 689→701 at the next boot, USD ±$1,268 off for three weeks).
import { describe, expect, it } from 'vitest';
import type { DailyVolume } from '@shared';
import { describeSwapChanges, reconcileDaySwaps, type SwapCountChange } from '../datasource/live.js';

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

describe('describeSwapChanges', () => {
  const c = (utcDay: string, from: number, to: number): SwapCountChange => ({ venueId: 'v', utcDay, from, to });

  it('lists days in order with the net — 0 is fills moved between days', () => {
    expect(describeSwapChanges([c('2026-09-19', 689, 701), c('2026-09-18', 503, 491)]))
      .toBe('2026-09-18 503→491, 2026-09-19 689→701 (net 0)');
    expect(describeSwapChanges([c('2026-09-18', 10, 13)])).toBe('2026-09-18 10→13 (net +3)');
    expect(describeSwapChanges([c('2026-09-18', 13, 10)])).toBe('2026-09-18 13→10 (net -3)');
  });

  it('caps the list so a long drift survives the note length cap', () => {
    const many = Array.from({ length: 9 }, (_, i) => c(`2026-09-${String(10 + i).padStart(2, '0')}`, 100, 101));
    const s = describeSwapChanges(many, 3);
    expect(s).toBe('2026-09-10 100→101, 2026-09-11 100→101, 2026-09-12 100→101, +6 more (net +9)');
  });
});
