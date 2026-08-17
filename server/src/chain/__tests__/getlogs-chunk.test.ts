// getLogsChunked's range negotiation. The tail attempts a wide span (sized for
// the devcore4 fleet's 1000-block cap) but the failover breaker can drop us onto
// an endpoint that refuses it — the public endpoint 413s past ~100. What must
// hold: no range is ever skipped, and a genuinely unreadable range still throws.
import { describe, expect, it } from 'vitest';
import { getLogsChunked } from '../rpc.js';

/** an endpoint that refuses any span wider than `cap` blocks, like a 413. */
function endpoint(cap: bigint) {
  const seen: Array<[bigint, bigint]> = [];
  const refused: bigint[] = [];
  const fetchLogs = async (a: { fromBlock: bigint; toBlock: bigint }) => {
    const span = a.toBlock - a.fromBlock + 1n;
    if (span > cap) { refused.push(span); throw new Error('block range too large'); }
    seen.push([a.fromBlock, a.toBlock]);
    return [`${a.fromBlock}-${a.toBlock}`];
  };
  return { fetchLogs, seen, refused };
}

/** every block in [from,to] is covered exactly once, in order, with no gaps. */
const covers = (seen: Array<[bigint, bigint]>, from: bigint, to: bigint) => {
  let next = from;
  for (const [a, b] of seen) { if (a !== next || b < a) return false; next = b + 1n; }
  return next === to + 1n;
};

describe('getLogsChunked', () => {
  it('uses the full span on an endpoint that allows it', async () => {
    const ep = endpoint(1000n);
    await getLogsChunked({ address: '0x0', fromBlock: 1n, toBlock: 2700n }, 900n, ep.fetchLogs);
    expect(ep.refused).toEqual([]);
    expect(ep.seen.map(([a, b]) => Number(b - a + 1n))).toEqual([900, 900, 900]);
    expect(covers(ep.seen, 1n, 2700n)).toBe(true);
  });

  it('narrows onto a stricter endpoint WITHOUT skipping the refused range', async () => {
    // the failover case: configured for 900, landed on the ~100-block endpoint.
    const ep = endpoint(100n);
    const logs = await getLogsChunked({ address: '0x0', fromBlock: 1n, toBlock: 500n }, 900n, ep.fetchLogs);
    expect(ep.refused.length).toBeGreaterThan(0);          // it did get refused
    expect(covers(ep.seen, 1n, 500n)).toBe(true);          // …and lost nothing
    expect(logs).toHaveLength(ep.seen.length);
    expect(Math.max(...ep.seen.map(([a, b]) => Number(b - a + 1n)))).toBeLessThanOrEqual(100);
  });

  it('keeps the narrowed span instead of re-probing every chunk', async () => {
    const ep = endpoint(100n);
    await getLogsChunked({ address: '0x0', fromBlock: 1n, toBlock: 1000n }, 900n, ep.fetchLogs);
    // one negotiation at the start, not one per chunk: 900→450→225→112→90 is 4
    // refusals, and nothing after that.
    expect(ep.refused.length).toBeLessThanOrEqual(4);
  });

  it('THROWS at the floor rather than returning a short read', async () => {
    // a range the endpoint cannot serve at any width is a held cursor, not
    // "no logs here" — that distinction is what stops silent undercounting.
    const dead = async () => { throw new Error('error getting block header from triedb and archive'); };
    await expect(getLogsChunked({ address: '0x0', fromBlock: 1n, toBlock: 500n }, 900n, dead))
      .rejects.toThrow(/triedb/);
  });

  it('never attempts a span below the floor even if asked to', async () => {
    const ep = endpoint(1000n);
    await getLogsChunked({ address: '0x0', fromBlock: 1n, toBlock: 200n }, 10n, ep.fetchLogs);
    // the LAST chunk is short because it is clamped to toBlock, which is not a
    // floor violation — every chunk before it must be the full floor width.
    const spans = ep.seen.map(([a, b]) => Number(b - a + 1n));
    expect(spans.slice(0, -1).every((n) => n === 90)).toBe(true);
    expect(spans.at(-1)).toBe(20);           // 1..90, 91..180, 181..200
    expect(covers(ep.seen, 1n, 200n)).toBe(true);
  });
});
