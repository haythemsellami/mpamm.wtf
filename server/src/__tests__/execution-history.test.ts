import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTE_CHART_WINDOW_MS, QUOTE_STATS_WINDOW_MS, type QuoteRow, type QuoteSnapshot } from '@shared';
import { ExecutionHistory, SPREAD_RETENTION_MS } from '../execution-history.js';

const start = 1_800_000_000_000;
const row = (spreadBps = 2, extra: Partial<QuoteRow> = {}): QuoteRow => ({ venueId: 'venue', market: 'MON/USDC', sizeUsd: 1000,
  bidPx: 1, askPx: 1.001, bidBps: 0, askBps: spreadBps, spreadBps, filledFull: true, feeBps: 0, ts: Date.now(), ...extra });
const frame = (block: number, rows = [row()], extra: Partial<QuoteSnapshot> = {}): QuoteSnapshot => ({ block, ts: Date.now(), monUsd: 1, rows, ...extra });
let history: ExecutionHistory;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); history = new ExecutionHistory(); });
afterEach(() => { history.clear(); vi.useRealTimers(); });
const stats = () => history.stats('MON/USDC', 1000);

describe('shared execution retention', () => {
  it('keeps only 60 seconds of chart frames but five minutes of observations for stats', () => {
    history.record(frame(1, [row(4)]));
    vi.setSystemTime(start + 240_000); history.record(frame(2, [row(8)]));
    vi.setSystemTime(start + 299_999); history.record(frame(3, [row(12)]));
    expect(history.history('MON/USDC', 1000).map((q) => q.block)).toEqual([2, 3]);
    expect(stats().rows[0]).toMatchObject({ n: 3, avg: 8 });
    vi.setSystemTime(start + QUOTE_STATS_WINDOW_MS);
    expect(stats().rows[0]).toMatchObject({ n: 2, avg: 10 });
    expect(history.history('MON/USDC', 1000).map((q) => q.block)).toEqual([3]);
  });

  it.each([100, 300, 900])('uses elapsed time rather than a sample count at %ims cadence', (cadence) => {
    const end = start + 600_000;
    for (let ts = start, block = 1; ts <= end; ts += cadence, block++) {
      vi.setSystemTime(ts); history.record(frame(block));
    }
    vi.setSystemTime(end);
    expect(stats().rows[0].n).toBe(Math.floor(600_000 / cadence) - Math.floor(300_000 / cadence));
    const chart = history.history('MON/USDC', 1000);
    expect(chart.every((q) => q.ts > end - QUOTE_CHART_WINDOW_MS && q.ts <= end)).toBe(true);
    expect(chart.length).toBe(Math.floor(600_000 / cadence) - Math.floor(540_000 / cadence));
    // The actual retained payload must plateau as uptime grows, not just the
    // public response. Only the numeric spread history survives past 60s.
    const retained = Reflect.get(history, 'spreads') as Array<{ ts: number; values: Float64Array }>;
    expect(retained.length).toBeLessThanOrEqual(Math.ceil(SPREAD_RETENTION_MS / cadence));
    expect(retained.every((q) => q.values instanceof Float64Array && q.values.byteLength === 16)).toBe(true);
  });

  it('expires memory during a total upstream outage with no readers, then cancels its timer', async () => {
    history.record(frame(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Reflect.get(history, 'quotes')).toEqual([]);
    expect(Reflect.get(history, 'spreads')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SPREAD_RETENTION_MS - 60_000);
    expect(Reflect.get(history, 'spreads')).toEqual([]);
    expect(Reflect.get(history, 'columns').size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(stats().rows).toEqual([]);
  });

  it('returns observed empty frames and skipped blocks without fabricating history', () => {
    history.record(frame(1));
    vi.setSystemTime(start + 300); history.record(frame(2, []));
    vi.setSystemTime(start + 1200); history.record(frame(5));
    expect(history.history('MON/USDC', 1000).map((q) => [q.block, q.rows.length])).toEqual([[1, 1], [2, 0], [5, 1]]);
    expect(stats().rows[0].n).toBe(2);
  });

  it('excludes future samples and gives frame emission timestamps precedence', () => {
    history.record(frame(1, [row()], { ts: start - 100_000, frame: { emittedAt: start } as QuoteSnapshot['frame'] }));
    history.record(frame(2, [row(99)], { ts: start + 10_000 }));
    expect(history.history('MON/USDC', 1000).map((q) => q.block)).toEqual([1]);
    expect(stats().rows[0]).toMatchObject({ n: 1, avg: 2 });
  });
});

describe('shared five-minute statistics', () => {
  it('matches independently calculated percentiles, mean and population deviation', () => {
    [-4, 0, 4, 8, 12].forEach((value, i) => history.record(frame(i + 1, [row(value)])));
    expect(stats().rows).toEqual([{ venueId: 'venue', n: 5, p5: -3.2, p25: 0, p50: 4, p75: 8, p95: 11.2, avg: 4, sd: Math.sqrt(32) }]);
  });

  it('isolates venues, markets and sizes and excludes non-executable or non-finite samples', () => {
    history.record(frame(1, [row(2), row(4, { venueId: 'other' }), row(6, { market: 'BTC/USDC' }), row(8, { sizeUsd: 100 }),
      row(99, { filledFull: false }), row(99, { oneSided: true }), row(99, { bidPx: 0 }), row(99, { askPx: NaN }),
      row(Infinity), row(NaN), row(99, { bidPx: Infinity }), row(99, { market: 'unknown' }), row(99, { sizeUsd: 123 })]));
    expect(stats().rows.map(({ venueId, n, avg }) => ({ venueId, n, avg }))).toEqual([
      { venueId: 'venue', n: 1, avg: 2 }, { venueId: 'other', n: 1, avg: 4 },
    ]);
    expect(history.stats('BTC/USDC', 1000).rows[0]).toMatchObject({ n: 1, avg: 6 });
    expect(history.stats('MON/USDC', 100).rows[0]).toMatchObject({ n: 1, avg: 8 });
    expect(history.stats('unknown', 123).rows).toEqual([]);
  });

  it('shares cached aggregates across readers without sharing or shipping their raw samples', () => {
    history.record(frame(1));
    const first = stats();
    for (let i = 0; i < 100; i++) expect(stats()).toBe(first);
    expect(Object.keys(first)).toEqual(['market', 'sizeUsd', 'asOf', 'windowMs', 'revision', 'rows']);
    vi.setSystemTime(start + 1000); history.record(frame(2, [row(4)]));
    expect(stats()).not.toBe(first);
    expect(stats().rows[0]).toMatchObject({ n: 2, avg: 3 });
    for (let i = 0; i < 1000; i++) history.stats(`unknown-${i}`, i);
    expect(Reflect.get(history, 'cache').size).toBe(1);
  });

  it('replaces same-block samples exactly once and rejects stale output', () => {
    history.record(frame(1, [row(100)]));
    expect(stats().rows[0].avg).toBe(100);
    history.record(frame(1, [row(2)]));
    history.record(frame(2, [row(4)]));
    history.record(frame(1, [row(999)]));
    expect(stats().rows[0]).toMatchObject({ n: 2, avg: 3 });
    expect(history.history('MON/USDC', 1000).map((q) => q.block)).toEqual([1, 2]);
  });

  it('invalidates replaced blocks in both windows and the cached aggregate, retaining valid ancestors', () => {
    history.record(frame(1, [row(2)])); history.record(frame(2, [row(100)])); history.record(frame(3, [row(200)]));
    expect(stats().rows[0].n).toBe(3);
    history.invalidate(2, 1);
    expect(stats()).toMatchObject({ revision: 1, rows: [{ n: 1, avg: 2 }] });
    history.record(frame(2, [row(4)], { revision: 1 }));
    history.record(frame(4, [row(999)], { revision: 0 }));
    vi.setSystemTime(start + 1000);
    expect(stats().rows[0]).toMatchObject({ n: 2, avg: 3 });
    expect(history.history('MON/USDC', 1000).map((q) => q.block)).toEqual([1, 2]);
  });
});
