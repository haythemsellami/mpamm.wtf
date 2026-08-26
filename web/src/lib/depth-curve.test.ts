import { describe, it, expect } from 'vitest';
import { depthSizes, type DepthCurve, type DepthPoint } from '@shared';
import {
  DEPTH_AX_BPS, DEPTH_VIEW_H, DEPTH_VIEW_W, DEPTH_X_TICKS, DEPTH_Y_TICKS,
  depthLegPath, depthX, depthY,
} from './depth-curve';

const GRID = depthSizes();

function curve(points: DepthPoint[], venueId = 'v'): DepthCurve {
  return { venueId, points, maxNotional: points[points.length - 1]?.notional ?? 0 };
}

/** Every (x, y) pair in a path's `d` — the acceptance check is on these. */
function coords(d: string): Array<[number, number]> {
  return d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number)
    .reduce<Array<[number, number]>>((acc, n, i, all) => (i % 2 ? [...acc, [all[i - 1], n]] : acc), []);
}

describe('axes', () => {
  it('maps bps to x with 0 at the centre and ±18 at the frame', () => {
    expect(depthX(0)).toBe(DEPTH_VIEW_W / 2);
    expect(depthX(-DEPTH_AX_BPS)).toBe(0);
    expect(depthX(DEPTH_AX_BPS)).toBe(DEPTH_VIEW_W);
  });

  it('clamps rather than escaping the frame', () => {
    expect(depthX(-500)).toBe(0);
    expect(depthX(500)).toBe(DEPTH_VIEW_W);
  });

  it('maps notional to y logarithmically, smallest size at the bottom', () => {
    expect(depthY(100)).toBe(DEPTH_VIEW_H);
    expect(depthY(1_000_000)).toBe(0);
    expect(depthY(10_000)).toBeCloseTo(DEPTH_VIEW_H / 2, 9);
    // a decade is a constant distance — that is the whole point of the axis
    const decade = depthY(100) - depthY(1000);
    expect(depthY(1000) - depthY(10_000)).toBeCloseTo(decade, 9);
  });

  it('labels one y tick per decade of the plotted span', () => {
    expect(DEPTH_Y_TICKS).toEqual([100, 1000, 10_000, 100_000, 1_000_000]);
    expect(DEPTH_X_TICKS).toEqual([-16, -12, -8, -4, 0, 4, 8, 12, 16]);
  });
});

describe('depthLegPath', () => {
  const widening = (from: number, per: number) =>
    GRID.map((notional) => {
      const half = from + per * Math.log10(notional / 100);
      return { notional, bidBps: -half, askBps: half };
    });

  it('draws one point per sample when the whole leg is in frame', () => {
    const d = depthLegPath(curve(widening(1, 0.5)), 'ask');
    expect(d).not.toBeNull();
    expect(coords(d!)).toHaveLength(GRID.length);
  });

  it('never leaves the viewBox, at either extreme', () => {
    for (const side of ['bid', 'ask'] as const) {
      const d = depthLegPath(curve(widening(2, 8)), side)!;
      for (const [x, y] of coords(d)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(DEPTH_VIEW_W);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(DEPTH_VIEW_H);
      }
    }
  });

  it('terminates ON the frame edge, not with a vertical run along it', () => {
    const pts = coords(depthLegPath(curve(widening(2, 8)), 'ask')!);
    const last = pts[pts.length - 1];
    expect(last[0]).toBeCloseTo(DEPTH_VIEW_W, 6);
    // exactly ONE point sits on the edge: a clamp-in-place would stack several
    // and paint a false "quotes 18bps for two more decades" line.
    expect(pts.filter(([x]) => x >= DEPTH_VIEW_W - 1e-6)).toHaveLength(1);
    // and it lands between the last in-range sample and the one that overshot
    const prev = pts[pts.length - 2];
    expect(last[1]).toBeLessThan(prev[1]);
  });

  it('mirrors that on the bid side, at x = 0', () => {
    const pts = coords(depthLegPath(curve(widening(2, 8)), 'bid')!);
    expect(pts[pts.length - 1][0]).toBeCloseTo(0, 6);
    expect(pts.filter(([x]) => x <= 1e-6)).toHaveLength(1);
  });

  it('stops mid-plot when the venue stops quoting size', () => {
    const capped = widening(1, 0.5).filter((p) => p.notional <= 100_000);
    const pts = coords(depthLegPath(curve(capped), 'ask')!);
    const last = pts[pts.length - 1];
    expect(last[1]).toBeCloseTo(depthY(100_000), 1);
    expect(last[1]).toBeGreaterThan(0); // visibly short of the top of the plot
  });

  it('drops a leg with fewer than two in-frame points instead of drawing a dot', () => {
    expect(depthLegPath(curve([{ notional: 100, bidBps: -1, askBps: 1 }]), 'ask')).toBeNull();
    // first sample already outside ±18: nothing to interpolate from
    expect(depthLegPath(curve(widening(40, 1)), 'ask')).toBeNull();
  });

  it('drops a side the venue does not quote', () => {
    const askOnly = GRID.map((notional) => ({ notional, askBps: 2 }));
    expect(depthLegPath(curve(askOnly), 'bid')).toBeNull();
    expect(depthLegPath(curve(askOnly), 'ask')).not.toBeNull();
  });

  it('keeps the two legs independent, so a skewed venue stays skewed', () => {
    const skewed = GRID.map((notional) => ({ notional, bidBps: -1, askBps: 6 }));
    const bid = coords(depthLegPath(curve(skewed), 'bid')!);
    const ask = coords(depthLegPath(curve(skewed), 'ask')!);
    // not mirror images about the centre line
    expect(bid[0][0]).not.toBeCloseTo(DEPTH_VIEW_W - ask[0][0], 3);
    // path coords are rendered to 1dp, so compare at that resolution
    expect(bid[0][0]).toBeCloseTo(depthX(-1), 1);
    expect(ask[0][0]).toBeCloseTo(depthX(6), 1);
  });
});
