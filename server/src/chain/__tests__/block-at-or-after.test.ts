import { describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import { isAvailabilityFailure } from '../failover.js';
import { blockAtOrAfter } from '../rpc.js';

describe('blockAtOrAfter availability handling', () => {
  it('throws immediately instead of biasing the search on a 429', async () => {
    const calls: bigint[] = [];
    const throttled = new HttpRequestError({ url: 'http://x', status: 429 });
    await expect(blockAtOrAfter(50, 100n, async (bn) => {
      calls.push(bn);
      throw throttled;
    })).rejects.toBe(throttled);
    expect(calls).toEqual([50n]);
  });

  it('still searches above an answer-level missing block', async () => {
    let missed = false;
    const found = await blockAtOrAfter(50, 100n, async (bn) => {
      if (bn === 50n && !missed) {
        missed = true;
        throw new Error('block pruned');
      }
      return { timestamp: bn };
    });
    expect(found).toBe(51n);
  });

  it.each(['success', 'hole'] as const)('rejects a %s probe completed after failover', async (outcome) => {
    let unavailable = false;
    const result = blockAtOrAfter(50, 100n, async (bn) => {
      unavailable = true;
      if (outcome === 'hole') throw new Error('block pruned');
      return { timestamp: bn };
    }, () => unavailable);
    const error = await result.then(() => undefined, (e) => e);
    expect(isAvailabilityFailure(error)).toBe(true);
  });
});
