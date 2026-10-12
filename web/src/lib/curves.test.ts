import { describe, expect, it } from 'vitest';
import { CURVE_OFFSETS_S, type MarkoutCurveCell, type MarkoutCurvesResponse } from '@shared';
import { curveView, niceTicks } from './curves';

const N = CURVE_OFFSETS_S.length;
const cell = (over: Partial<MarkoutCurveCell>): MarkoutCurveCell => ({
  venueId: 'a', flow: 'quiet', route: 'single', category: 'DIRECT', fills: 10, usd: 100,
  usdBps: new Array(N).fill(100), ...over,
});
const res = (cells: MarkoutCurveCell[]): MarkoutCurvesResponse => ({
  days: 1, generatedAt: 0, offsetsS: [...CURVE_OFFSETS_S], quietMoveBps: 1, cells,
  coverage: { a: { fills: 40, usd: 400 }, b: { fills: 10, usd: 100 } },
});
const ALL = { flow: 'ALL', route: 'ALL', entry: 'ALL' };

describe('curveView', () => {
  const data = res([
    cell({}),                                                                                   // taker +1
    cell({ flow: 'moving', route: 'twoSided', category: 'MEV', usd: 300, usdBps: new Array(N).fill(-900) }), // taker −3
    cell({ venueId: 'b', usd: 100, usdBps: new Array(N).fill(200) }),
    cell({ venueId: 'gone' }),
  ]);

  it('sums cells into a maker-signed notional-weighted mean (never an average of averages)', () => {
    const v = curveView(data, ALL, ['a', 'b']);
    const a = v.venues.find((x) => x.venueId === 'a')!;
    expect(a.usd).toBe(400);
    expect(a.fills).toBe(20);
    expect(a.maker[0]).toBeCloseTo(-(100 - 900) / 400); // +2 maker
    expect(a.quietShare).toBeCloseTo(0.25);
    expect(a.twoSidedShare).toBeCloseTo(0.75);
    expect(a.coverage).toBe(1);
    // unregistered venues are dropped; pooled spans the rest
    expect(v.venues.map((x) => x.venueId)).toEqual(['a', 'b']);
    expect(v.pooled!.usd).toBe(500);
    expect(v.pooled!.maker[0]).toBeCloseTo(-(100 - 900 + 200) / 500);
    expect(v.categories).toEqual(['DIRECT', 'MEV']);
  });

  it('filters by any combination while the flow mix stays the venue’s own', () => {
    const quiet = curveView(data, { ...ALL, flow: 'QUIET' }, ['a', 'b']).venues.find((x) => x.venueId === 'a')!;
    expect(quiet.maker[0]).toBeCloseTo(-1);
    expect(quiet.quietShare).toBeCloseTo(0.25);
    const mev = curveView(data, { flow: 'MOVING', route: 'TWO-SIDED', entry: 'MEV' }, ['a', 'b']);
    expect(mev.venues.map((x) => x.venueId)).toEqual(['a']);
    expect(mev.venues[0].maker[0]).toBeCloseTo(3);
    expect(mev.pooled).toBeNull();
  });

  it('is empty without a response', () => {
    expect(curveView(null, ALL, ['a'])).toEqual({ offsets: [], venues: [], pooled: null, categories: [] });
  });
});

describe('niceTicks', () => {
  it('always spans zero with round steps', () => {
    expect(niceTicks(0.4, 2.7)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0.1, 1.2)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25]);
    const t = niceTicks(-3.2, 1.1);
    expect(t[0]).toBeLessThanOrEqual(-3.2);
    expect(t).toContain(0);
    expect(t.at(-1)).toBeGreaterThanOrEqual(1.1);
  });
});
