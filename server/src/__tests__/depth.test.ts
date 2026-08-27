import { describe, it, expect } from 'vitest';
import { DEPTH_SAMPLES, SIZES_USD, depthSizes, type QuoteRow } from '@shared';
import { buildDepthSnapshot } from '../depth.js';

const GRID = depthSizes();

function row(over: Partial<QuoteRow> & Pick<QuoteRow, 'venueId' | 'sizeUsd'>): QuoteRow {
  const bidBps = over.bidBps ?? -2;
  const askBps = over.askBps ?? 2;
  return {
    market: 'MON/USDC',
    bidBps, askBps,
    bidPx: over.bidPx ?? 0.02 * (1 + bidBps / 1e4),
    askPx: over.askPx ?? 0.02 * (1 + askBps / 1e4),
    spreadBps: askBps - bidBps,
    filledFull: true,
    feeBps: 0,
    ts: 1,
    ...over,
  };
}

/** A venue quoting every grid size, with a per-size bps shape. */
function fullCurve(venueId: string, bps: (size: number) => { bid: number; ask: number }, upTo = Infinity): QuoteRow[] {
  return GRID.filter((s) => s <= upTo).map((sizeUsd) => {
    const { bid, ask } = bps(sizeUsd);
    return row({ venueId, sizeUsd, bidBps: bid, askBps: ask });
  });
}

describe('depthSizes', () => {
  it('spans $100 → $1M ascending', () => {
    expect(GRID[0]).toBe(100);
    expect(GRID[GRID.length - 1]).toBe(1_000_000);
    expect(GRID).toEqual([...GRID].sort((a, b) => a - b));
    expect(new Set(GRID).size).toBe(GRID.length);
    expect(GRID.length).toBe(DEPTH_SAMPLES);
  });

  // This is what makes the curve RECONCILE with the QUOTE / ROLLING_STATS rows
  // rather than merely resemble them: at a SIZE pill both read the same quote.
  it('lands exactly on every SIZE pill', () => {
    for (const pill of SIZES_USD) expect(GRID).toContain(pill);
  });

  it('never emits a duplicate notional at a coarse sample count', () => {
    const coarse = depthSizes(3);
    expect(new Set(coarse).size).toBe(coarse.length);
  });
});

describe('buildDepthSnapshot', () => {
  it('carries the venue quotes through unchanged, skew and all', () => {
    // deliberately asymmetric: -1 bid / +4 ask. Nothing may recentre it.
    const rows = fullCurve('poe', () => ({ bid: -1, ask: 4 }));
    const snap = buildDepthSnapshot(rows, 'MON/USDC', GRID, 0.0192, 47_128_560, 1234);

    expect(snap.asOfBlock).toBe(47_128_560);
    expect(snap.refMid).toBe(0.0192);
    expect(snap.venues).toHaveLength(1);
    const c = snap.venues[0];
    expect(c.venueId).toBe('poe');
    expect(c.points).toHaveLength(GRID.length);
    expect(c.points.map((p) => p.notional)).toEqual(GRID);
    expect(c.points.every((p) => p.bidBps === -1 && p.askBps === 4)).toBe(true);
    expect(c.maxNotional).toBe(1_000_000);
  });

  it('ends the curve where the venue stops filling in full', () => {
    const rows = fullCurve('clober', () => ({ bid: -2, ask: 2 })).map((r) =>
      r.sizeUsd > 100_000 ? { ...r, filledFull: false } : r);
    const c = buildDepthSnapshot(rows, 'MON/USDC', GRID, 1, 1, 1).venues[0];

    expect(c.maxNotional).toBe(100_000);
    expect(c.points.some((p) => p.notional > 100_000)).toBe(false);
    // no extrapolation and no null/0-bps filler past the cap
    expect(c.points.every((p) => p.bidBps !== 0 && p.askBps !== 0)).toBe(true);
  });

  it('ends the curve where the venue stops quoting at all', () => {
    const rows = fullCurve('hanji', () => ({ bid: -2, ask: 2 }), 10_000);
    const c = buildDepthSnapshot(rows, 'MON/USDC', GRID, 1, 1, 1).venues[0];
    expect(c.maxNotional).toBe(10_000);
  });

  it('omits an absent side instead of reporting it as 0 bps', () => {
    // a one-sided book: a real ask, no executable bid (px 0, bps 0).
    const rows = GRID.map((sizeUsd) => row({
      venueId: 'onesided', sizeUsd, bidBps: 0, bidPx: 0, askBps: 3, oneSided: true,
    }));
    const c = buildDepthSnapshot(rows, 'MON/USDC', GRID, 1, 1, 1).venues[0];
    expect(c.points.every((p) => p.bidBps === undefined && p.askBps === 3)).toBe(true);
  });

  it('drops a venue with no executable side anywhere', () => {
    const rows = GRID.map((sizeUsd) => row({ venueId: 'dead', sizeUsd, bidPx: 0, askPx: 0 }));
    expect(buildDepthSnapshot(rows, 'MON/USDC', GRID, 1, 1, 1).venues).toHaveLength(0);
  });

  it('starts the curve where the venue starts quoting (a floor is not a cap)', () => {
    // no rows below $1k — a venue with a minimum order size, not an exhausted one.
    const rows = fullCurve('minsize', () => ({ bid: -2, ask: 2 })).filter((r) => r.sizeUsd >= 1000);
    const c = buildDepthSnapshot(rows, 'MON/USDC', GRID, 1, 1, 1).venues[0];
    expect(c.points[0].notional).toBe(1000);
    expect(c.maxNotional).toBe(1_000_000);
  });

  it('keeps markets separate', () => {
    const rows = [
      ...fullCurve('poe', () => ({ bid: -1, ask: 1 })),
      ...fullCurve('poe', () => ({ bid: -9, ask: 9 })).map((r) => ({ ...r, market: 'BTC/USDC' })),
    ];
    const mon = buildDepthSnapshot(rows, 'MON/USDC', GRID, 1, 1, 1).venues[0];
    const btc = buildDepthSnapshot(rows, 'BTC/USDC', GRID, 1, 1, 1).venues[0];
    expect(mon.points[0].askBps).toBe(1);
    expect(btc.points[0].askBps).toBe(9);
  });

  it('orders venues by first appearance, so the legend is stable', () => {
    const rows = [
      ...fullCurve('b', () => ({ bid: -1, ask: 1 })),
      ...fullCurve('a', () => ({ bid: -1, ask: 1 })),
    ];
    expect(buildDepthSnapshot(rows, 'MON/USDC', GRID, 1, 1, 1).venues.map((v) => v.venueId)).toEqual(['b', 'a']);
  });
});
