import { describe, expect, it } from 'vitest';
import type { QuoteSnapshot } from '@shared';
import { appendQuoteSnapshot, continuousQuoteRuns, type QuoteSeries } from './quote-series';

function snapshot(block: number, ts: number, venues: string[]): QuoteSnapshot {
  return {
    block,
    monUsd: 1,
    ts,
    rows: venues.map((venueId, i) => ({
      venueId,
      market: 'MON/USDC',
      sizeUsd: 100,
      bidBps: -1,
      askBps: 1,
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
  it('advances every venue on the same frame and records missing rows as gaps', () => {
    const series: Record<string, QuoteSeries> = {};
    appendQuoteSnapshot(series, ['a', 'b'], snapshot(10, 1_000, ['a']), 'MON/USDC', 100);

    expect(series.a.points).toEqual([{ block: 10, ts: 1_000, bid: 1, ask: 2 }]);
    expect(series.b.points).toEqual([{ block: 10, ts: 1_000, bid: null, ask: null }]);
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

    expect(series.a.points).toEqual([{ block: 11, ts: 2_201, bid: 1, ask: 2 }]);
  });

  it('splits paths at skipped blocks and missing sides', () => {
    const points = [
      { block: 10, ts: 1_000, bid: 1, ask: 2 },
      { block: 11, ts: 1_300, bid: 1.1, ask: 2.1 },
      { block: 13, ts: 1_900, bid: 1.2, ask: 2.2 },
      { block: 14, ts: 2_200, bid: null, ask: 2.3 },
      { block: 15, ts: 2_500, bid: 1.4, ask: 2.4 },
    ];

    expect(continuousQuoteRuns(points, 'both', 0).map((run) => run.map((p) => p.block)))
      .toEqual([[10, 11], [13], [15]]);
    expect(continuousQuoteRuns(points, 'ask', 0).map((run) => run.map((p) => p.block)))
      .toEqual([[10, 11], [13, 14, 15]]);
  });
});
