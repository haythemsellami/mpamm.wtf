import { describe, expect, it } from 'vitest';
import type { QuoteSnapshot } from '@shared';
import { appendQuoteSnapshot, continuousQuoteRuns, offScaleLimitBps, type QuotePoint, type QuoteSeries } from './quote-series';

function snapshot(block: number, ts: number, venues: string[]): QuoteSnapshot {
  return {
    block,
    monUsd: 1,
    ts,
    rows: venues.map((venueId, i) => ({
      venueId,
      market: 'MON/USDC',
      sizeUsd: 100,
      bidBps: (1 + i - 1.5) / 1.5 * 1e4,
      askBps: (2 + i - 1.5) / 1.5 * 1e4,
      bidPx: 1 + i,
      askPx: 2 + i,
      spreadBps: 2,
      filledFull: true,
      feeBps: 0,
      ts,
    })),
  };
}

describe('quote chart series', () => {
  it('retains the full minute when frames arrive faster than the former 400-point cap', () => {
    const series: Record<string, QuoteSeries> = {};
    for (let block = 0; block <= 1200; block++) {
      appendQuoteSnapshot(series, ['a'], snapshot(block, block * 100, ['a']), 'MON/USDC', 100);
    }
    expect(series.a.points).toHaveLength(601);
    expect(series.a.points[0].ts).toBe(60_000);
    expect(series.a.points.at(-1)?.ts).toBe(120_000);
  });

  it('advances every venue on the same frame and records missing rows as gaps', () => {
    const series: Record<string, QuoteSeries> = {};
    appendQuoteSnapshot(series, ['a', 'b'], snapshot(10, 1_000, ['a']), 'MON/USDC', 100);

    expect(series.a.points).toEqual([{ block: 10, ts: 1_000, bid: 1, ask: 2, mid: expect.closeTo(1.5, 12) }]);
    expect(series.b.points).toEqual([{ block: 10, ts: 1_000, bid: null, ask: null, mid: null }]);
  });

  it('uses emission telemetry, replaces duplicate blocks, and prunes by wall time', () => {
    const series: Record<string, QuoteSeries> = {};
    const first = snapshot(10, 1_000, ['a']);
    first.frame = {
      headSource: 'ws', headObservedAt: 900, quoteStartedAt: 950, quoteCompletedAt: 1_100, emittedAt: 1_100,
      durationMs: 150, adapterMs: {}, missingVenues: [], coalescedBlocks: 0,
    };
    appendQuoteSnapshot(series, ['a'], first, 'MON/USDC', 100, 1_000);
    appendQuoteSnapshot(series, ['a'], snapshot(10, 1_200, []), 'MON/USDC', 100, 1_000);
    appendQuoteSnapshot(series, ['a'], snapshot(11, 2_201, ['a']), 'MON/USDC', 100, 1_000);

    expect(series.a.points).toEqual([{ block: 11, ts: 2_201, bid: 1, ask: 2, mid: expect.closeTo(1.5, 12) }]);
  });

  it('splits paths at skipped blocks and missing sides', () => {
    const points = [
      { block: 10, ts: 1_000, bid: 1, ask: 2, mid: 1.5 },
      { block: 11, ts: 1_300, bid: 1.1, ask: 2.1, mid: 1.6 },
      { block: 13, ts: 1_900, bid: 1.2, ask: 2.2, mid: 1.7 },
      { block: 14, ts: 2_200, bid: null, ask: 2.3, mid: 1.8 },
      { block: 15, ts: 2_500, bid: 1.4, ask: 2.4, mid: 1.9 },
    ];

    expect(continuousQuoteRuns(points, 'both', 0).map((run) => run.map((p) => p.block)))
      .toEqual([[10, 11], [13], [15]]);
    expect(continuousQuoteRuns(points, 'ask', 0).map((run) => run.map((p) => p.block)))
      .toEqual([[10, 11], [13, 14, 15]]);
  });
});

describe('off-scale limit', () => {
  // one frame per line: a quote at ±bps around a mid of 1
  const line = (bidBps: number | null, askBps: number | null, reference = false, ts = 1_000) => ({
    reference,
    points: [{
      block: 1, ts, mid: 1,
      bid: bidBps === null ? null : 1 + bidBps / 1e4,
      ask: askBps === null ? null : 1 + askBps / 1e4,
    }] satisfies QuotePoint[],
  });

  it('pins a backstop side 20× beyond the field (the Capricorn −1529bps case)', () => {
    const limit = offScaleLimitBps([
      line(-5, 6), line(-8, 4), line(-10, 12), line(-1529.2, null), line(-10, 10, true),
    ], 0);
    // sides 4,5,6,8,10,10,10,12,1529 → median 10bps
    expect(limit).toBeCloseTo(200, 6);
    expect(1529.2).toBeGreaterThan(limit!);
  });

  it('keeps a genuine 15× skew on scale', () => {
    const limit = offScaleLimitBps([line(-150, 10), line(-8, 8), line(-10, 9), line(-10, 10, true)], 0)!;
    expect(150).toBeLessThan(limit);
  });

  it('never pins anything within the floor of a hair-tight market', () => {
    expect(offScaleLimitBps([line(-0.5, 0.5), line(-0.4, 0.6), line(-12, 12)], 0)).toBe(50);
  });

  it('applies no limit to a lone venue against the CEX line', () => {
    expect(offScaleLimitBps([line(-56, 8), line(-2, 2, true)], 0)).toBeNull();
  });

  it('only measures the visible window, and skips frames without a mid', () => {
    const stale = line(-5000, 5000, false, 10);
    const noMid = { points: [{ block: 1, ts: 1_000, bid: 0.5, ask: 1.5, mid: null }] };
    expect(offScaleLimitBps([stale, noMid, line(-5, 5)], 100)).toBeNull();
    expect(offScaleLimitBps([stale, line(-5, 5), line(-6, 6)], 100)).toBeCloseTo(110, 6);
  });
});
