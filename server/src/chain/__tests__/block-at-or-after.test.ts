import { describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
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
});
