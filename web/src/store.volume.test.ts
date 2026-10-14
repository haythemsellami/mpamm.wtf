// mergeDay (store.tsx): how a `volume` frame lands in a tab's loaded days.
//
// Frames normally carry today. A 'fills' history revision also pushes each
// closed day it re-derived (live.ts applyFillsRevision), so a tab opened
// before the revision stops showing the misbooked rows without a reload.
import { describe, expect, it } from 'vitest';
import type { DailyVolume } from '@shared';
import { mergeDay } from './store';

const day = (utcDay: string, usd: number, partial = false): DailyVolume => ({ utcDay, partial, byVenue: { hanji: { usd, swaps: 1 } } });
const days = [day('2026-09-17', 3103244.65), day('2026-09-18', 3707652.56), day('2026-10-14', 10, true)];

describe('mergeDay', () => {
  it('replaces a re-derived closed day in place and leaves today partial', () => {
    const next = mergeDay(days, day('2026-09-17', 3086970.65));
    expect(next.map((d) => [d.utcDay, d.byVenue.hanji!.usd, d.partial])).toEqual([
      ['2026-09-17', 3086970.65, false], ['2026-09-18', 3707652.56, false], ['2026-10-14', 10, true],
    ]);
  });

  it('inserts a closed day the tab does not hold in date order, never after today', () => {
    expect(mergeDay(days, day('2026-09-19', 1855888.73)).map((d) => d.utcDay)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19', '2026-10-14']);
  });

  it('a new day after midnight still appends and closes yesterday', () => {
    const next = mergeDay(days, day('2026-10-15', 1, true));
    expect(next.map((d) => [d.utcDay, d.partial])).toEqual([
      ['2026-09-17', false], ['2026-09-18', false], ['2026-10-14', false], ['2026-10-15', true],
    ]);
  });
});
