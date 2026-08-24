import { describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import { archiveRetryDelayMs, historyRunRolled, waitForArchiveBoundary } from '../datasource/live.js';

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
