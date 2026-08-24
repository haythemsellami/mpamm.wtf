import { describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import { approximateDuration, archiveRetryDelayMs, historyRunRolled, waitForArchiveBoundary } from '../datasource/live.js';

describe('archive-to-tail handoff boundary', () => {
  it('waits for the archive to pass the fixed hot-head target', async () => {
    const heads = [93n, 99n, 100n];
    const pauses: number[] = [];
    const waited = await waitForArchiveBoundary(
      100n,
      async () => heads.shift()!,
      () => false,
      async (ms) => { pauses.push(ms); },
    );
    expect(waited).toBe(true);
    expect(pauses).toEqual([1_000, 1_000]);
  });

  it('does not query while the archive breaker says unavailable', async () => {
    let unavailable = true;
    let reads = 0;
    const pauses: number[] = [];
    const waited = await waitForArchiveBoundary(
      100n,
      async () => { reads += 1; return 100n; },
      () => unavailable,
      async (ms) => { pauses.push(ms); unavailable = false; },
    );
    expect(waited).toBe(true);
    expect(reads).toBe(1);
    expect(pauses).toEqual([15_000]);
  });

  it('backs off a 429 without moving the fixed handoff boundary', async () => {
    let throttled = true;
    let reads = 0;
    const pauses: number[] = [];
    const waited = await waitForArchiveBoundary(
      100n,
      async () => {
        reads += 1;
        if (throttled) throw new HttpRequestError({ url: 'http://x', status: 429 });
        return 100n;
      },
      () => false,
      async (ms) => { pauses.push(ms); throttled = false; },
    );
    expect(waited).toBe(true);
    expect(reads).toBe(2);
    expect(pauses).toEqual([15_000]);
  });

  it('reports a serving archive only after sustained lag, then reports recovery', async () => {
    let now = 0;
    const heads = [10n, 10n, 10n, 100n];
    const held: unknown[] = [];
    const resumed: unknown[] = [];
    const waited = await waitForArchiveBoundary(
      100n,
      async () => heads.shift()!,
      () => false,
      async (ms) => { now += ms; },
      () => 0,
      {
        graceMs: 2_000,
        now: () => now,
        onHeld: (state) => { held.push(state); },
        onResumed: (state) => { resumed.push(state); },
      },
    );
    expect(waited).toBe(true);
    expect(held).toEqual([{ head: 10n, target: 100n, lag: 90n, waitedMs: 2_000 }]);
    expect(resumed).toEqual([{ head: 100n, target: 100n, lag: 0n, waitedMs: 3_000 }]);
  });

  it('does not raise sustained-lag telemetry for an ordinary short handoff', async () => {
    let now = 0;
    const heads = [93n, 99n, 100n];
    const held: unknown[] = [];
    const waited = await waitForArchiveBoundary(
      100n,
      async () => heads.shift()!,
      () => false,
      async (ms) => { now += ms; },
      () => 0,
      { graceMs: 30_000, now: () => now, onHeld: (state) => { held.push(state); } },
    );
    expect(waited).toBe(true);
    expect(now).toBe(2_000);
    expect(held).toEqual([]);
  });

  it('formats block-lag and wall-clock durations without noisy precision', () => {
    expect(approximateDuration(300)).toBe('~1s');
    expect(approximateDuration(300_000)).toBe('~5m');
    expect(approximateDuration(300_000_000)).toBe('~3.5d');
  });

  it('exponentially backs off a sustained throttle and caps the delay', () => {
    expect([1, 2, 3, 4, 5, 20].map(archiveRetryDelayMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 120_000, 120_000,
    ]);
  });

  it('expires the shared history clock exactly at UTC rollover', () => {
    expect(historyRunRolled('2026-08-24', Date.parse('2026-08-24T23:59:59.999Z'))).toBe(false);
    expect(historyRunRolled('2026-08-24', Date.parse('2026-08-25T00:00:00.000Z'))).toBe(true);
  });
});
