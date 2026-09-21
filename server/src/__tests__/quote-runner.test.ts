import { describe, expect, it, vi } from 'vitest';
import { QuoteRunner } from '../quote-runner.js';

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
