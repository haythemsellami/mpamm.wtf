import { describe, expect, it, vi } from 'vitest';
import { planQuotes } from '../quote-demand.js';
import { QuoteRunner } from '../quote-runner.js';

describe('quote demand', () => {
  it('shares identical demand without adding unrelated market/size combinations', () => {
    const plan = planQuotes([
      { market: 'MON/USDC', sizeUsd: 100, baseline: false },
      { market: 'MON/USDC', sizeUsd: 100, baseline: false },
      { market: 'BTC/USDC', sizeUsd: 1000, baseline: true },
    ], [100, 1000, 10000, 100000]);
    expect(plan.map((p) => ({ ...p, markets: [...p.markets!] }))).toEqual([
      { markets: ['MON/USDC'], sizes: [100], baseline: false },
      { markets: ['BTC/USDC'], sizes: [1000], baseline: false },
      { markets: ['BTC/USDC'], sizes: [1000], baseline: true },
    ]);
    expect(planQuotes([], [100])).toEqual([]);
    expect(planQuotes([], [100], true)).toEqual([{ sizes: [100], baseline: true }]);
  });

  it('groups markets with identical size sets into one adapter call', () => {
    expect(planQuotes(['MON/USDC', 'ETH/USDC'].flatMap((market) => [100, 1000].map((sizeUsd) => ({ market, sizeUsd, baseline: false }))), [100, 1000])).toHaveLength(1);
  });
});

describe('quote deadlines', () => {
  it('cancels slow work, preserves its slot until settled, and never publishes the late result', async () => {
    vi.useFakeTimers();
    try {
      const runner = new QuoteRunner();
      let resolve!: (result: number[]) => void;
      let signal!: AbortSignal;
      const first = runner.run('slow', 200, (s) => { signal = s; return new Promise<number[]>((r) => { resolve = r; }); }, []);
      await vi.advanceTimersByTimeAsync(200);
      expect(await first).toEqual([]);
      expect(signal.aborted).toBe(true);
      const another = vi.fn(async () => [2]);
      expect(await runner.run('slow', 200, another, [])).toEqual([]);
      expect(another).not.toHaveBeenCalled();
      expect(await runner.run('fast', 200, another, [])).toEqual([2]);
      resolve([1]);
      await Promise.resolve(); await Promise.resolve();
      expect(await runner.run('slow', 200, another, [])).toEqual([2]);
    } finally { vi.useRealTimers(); }
  });
});
