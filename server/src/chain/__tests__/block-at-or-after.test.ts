import { describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import { isAvailabilityFailure } from '../failover.js';
import { blockAtOrAfter } from '../rpc.js';

// Monad-like clock: ~0.3s blocks with whole-second timestamps, so runs of
// blocks share a second and "earliest" is stricter than "any match".
const tsOf = (bn: bigint) => (bn * 3n) / 10n;
/** The first block with tsOf >= target: what blockAtOrAfter must return. */
const firstAtOrAfter = (target: bigint) => (target * 10n + 2n) / 3n;
const healthy = () => false;

/** A chain whose blocks inside any hole fail with an answer-level JSON-RPC
 *  error (devcore's archive-hole message), not an availability failure. */
function chain(holes: Array<[bigint, bigint]> = []) {
  const calls: bigint[] = [];
  const getBlock = async (bn: bigint) => {
    calls.push(bn);
    if (holes.some(([a, b]) => bn >= a && bn <= b)) throw new Error('Internal error: error getting block header from triedb and archive');
    return { timestamp: tsOf(bn) };
  };
  return { calls, getBlock };
}

describe('blockAtOrAfter availability handling', () => {
  it('throws immediately instead of biasing the search on a 429', async () => {
    const calls: bigint[] = [];
    const throttled = new HttpRequestError({ url: 'http://x', status: 429 });
    await expect(blockAtOrAfter(50, 100n, async (bn) => {
      calls.push(bn);
      throw throttled;
    })).rejects.toBe(throttled);
    expect(calls).toHaveLength(1);
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

describe('blockAtOrAfter returns only a proven boundary', () => {
  it('finds the first block of a run sharing the target second', async () => {
    const { getBlock } = chain();
    const ans = await blockAtOrAfter(60, 1_000n, getBlock, healthy);
    expect(ans).toBe(firstAtOrAfter(60n));
    expect(tsOf(ans - 1n)).toBeLessThan(60n);
  });

  it('reads at most ~log2(hi) blocks on a clean chain at mainnet scale', async () => {
    const { calls, getBlock } = chain();
    await expect(blockAtOrAfter(29_000_000, 101_000_000n, getBlock, healthy)).resolves.toBe(firstAtOrAfter(29_000_000n));
    expect(calls.length).toBeLessThanOrEqual(27);
  });

  // The bug: a failed probe ABOVE the answer used to move the lower bound
  // past it, so every later probe read "late enough" and the search converged
  // on the hole's top edge (61 here), dropping blocks 20..60 from that day.
  it.each([[49n, 49n], [45n, 60n]])('routes around a hole %s..%s above the answer instead of converging on its edge', async (a, b) => {
    const { calls, getBlock } = chain([[a, b]]);
    await expect(blockAtOrAfter(6, 100n, getBlock, healthy)).resolves.toBe(firstAtOrAfter(6n));
    expect(calls).toContain(49n); // the first probe did land in the hole
  });

  it('routes around a devcore-sized hole on the probe path at mainnet scale', async () => {
    const hi = 101_000_000n, target = 29_000_000n, ans = firstAtOrAfter(target);
    const clean = chain();
    await blockAtOrAfter(Number(target), hi, clean.getBlock, healthy);
    // the clean search's last probe that is clearly above the answer: a hole
    // there sits on the path, and the old search would have converged above it
    const p = clean.calls.filter((bn) => bn > ans + 100n).at(-1)!;
    const holed = chain([[p - 31n, p + 31n]]);
    await expect(blockAtOrAfter(Number(target), hi, holed.getBlock, healthy)).resolves.toBe(ans);
    expect(holed.calls).toContain(p);
  });

  it('retries a block whose read failed once instead of skipping it', async () => {
    let missed = false;
    const found = await blockAtOrAfter(50, 100n, async (bn) => {
      if (bn === 50n && !missed) {
        missed = true;
        throw new Error('header not found');
      }
      return { timestamp: bn };
    }, healthy);
    expect(missed).toBe(true);
    expect(found).toBe(50n); // was 51: the transient miss on the answer itself made it late
  });

  it('still searches above a pruned prefix below the answer', async () => {
    const { getBlock } = chain([[0n, 39n]]);
    await expect(blockAtOrAfter(18, 100n, getBlock, healthy)).resolves.toBe(firstAtOrAfter(18n));
  });

  it('throws for a target older than the retained window instead of returning its first block', async () => {
    // the answer (20) is pruned along with everything below 70; the old search
    // returned 70, booking a pruned stretch as if the day began there
    const { getBlock } = chain([[0n, 69n]]);
    await expect(blockAtOrAfter(6, 100n, getBlock, healthy)).rejects.toThrow(/probe failures/);
  });

  it.each([['ans − 1', -1n], ['ans', 0n]])('throws when %s is unreadable: the boundary cannot be proven', async (_, offset) => {
    const ans = firstAtOrAfter(6n);
    const { getBlock } = chain([[ans + offset, ans + offset]]);
    await expect(blockAtOrAfter(6, 100n, getBlock, healthy)).rejects.toThrow(/cannot prove/);
  });

  it('throws on a run of answer-level errors instead of converging to hi', async () => {
    const { calls, getBlock } = chain([[0n, 100n]]);
    await expect(blockAtOrAfter(6, 100n, getBlock, healthy)).rejects.toThrow(/9 probe failures/);
    expect(calls).toHaveLength(9);
  });

  it('returns hi for a target past it, without needing hi itself', async () => {
    const { calls, getBlock } = chain([[100n, 100n]]);
    await expect(blockAtOrAfter(1_000, 100n, getBlock, healthy)).resolves.toBe(100n);
    expect(calls).not.toContain(100n);
  });

  it('returns block 0 when it already qualifies', async () => {
    const { getBlock } = chain();
    await expect(blockAtOrAfter(0, 100n, getBlock, healthy)).resolves.toBe(0n);
  });

  it('is exact or throws for every hole placement, and exact whenever the hole spares ans − 1 and ans', async () => {
    const hi = 240n;
    let exact = 0, threw = 0;
    for (let target = 0n; target <= 72n; target += 4n) {
      const ans = firstAtOrAfter(target);
      for (let len = 1n; len <= 24n; len++) {
        for (let a = 0n; a + len - 1n <= hi; a++) {
          const b = a + len - 1n;
          const { getBlock } = chain([[a, b]]);
          const spared = !(a <= ans - 1n && ans - 1n <= b) && !(a <= ans && ans <= b);
          const got = await blockAtOrAfter(Number(target), hi, getBlock, healthy).catch(() => undefined);
          if (got === undefined) {
            threw++;
            expect(spared, `target ${target}, hole ${a}..${b}`).toBe(false);
          } else {
            exact++;
            expect(got, `target ${target}, hole ${a}..${b}`).toBe(ans);
          }
        }
      }
    }
    expect(exact).toBeGreaterThan(threw);
  });
});
