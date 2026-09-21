// Day-stamping of one replay chunk (datasource/live.ts: stampChunkDays).
//
// The bug this covers: the on-chain replay stamped every fill in a chunk with
// ONE block time, so the one chunk per day that straddles UTC midnight put all
// of its fills on the earlier day — up to ~4 minutes of swaps — and a replayed
// day disagreed with the same day as the live tail counted it (68 Metric swaps
// at the 2026-09-18→19 boundary). What must hold: every fill on its own day,
// with only a handful of block reads for the chunk that straddles and no extra
// reads for the ones that do not.
import { describe, expect, it } from 'vitest';
import { stampChunkDays } from '../datasource/live.js';
import { utcDay } from '../util.js';
import { RpcReadUnavailableError } from '../chain/failover.js';

const MIDNIGHT = Date.parse('2026-09-19T00:00:00Z');
/** block n's time: 300ms blocks, arranged so block 1137 is the first one on 09-19. */
const timeOf = (bn: bigint) => MIDNIGHT + (Number(bn) - 1137) * 300;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i));

/** a fake archive: counts reads, and can refuse blocks (transient) or be down (availability). */
function archive(opts: { failing?: Set<number>; down?: boolean } = {}) {
  const reads: bigint[] = [];
  const tsOf = async (bn: bigint) => {
    reads.push(bn);
    if (opts.down) throw new RpcReadUnavailableError();
    if (opts.failing?.has(Number(bn))) throw new Error('block not found');
    return timeOf(bn);
  };
  return { reads, tsOf };
}

describe('stampChunkDays', () => {
  it('a chunk inside one day costs two reads and stamps every fill alike', async () => {
    const a = archive();
    const stamp = (await stampChunkDays(range(1000, 1100), a.tsOf))!;
    expect(a.reads).toEqual([1000n, 1100n]);
    expect(utcDay(stamp(1000n))).toBe('2026-09-18');
    expect(utcDay(stamp(1100n))).toBe('2026-09-18');
  });

  it('a single-block chunk costs one read', async () => {
    const a = archive();
    const stamp = (await stampChunkDays([1500n], a.tsOf))!;
    expect(a.reads).toEqual([1500n]);
    expect(utcDay(stamp(1500n))).toBe('2026-09-19');
  });

  it('a chunk straddling midnight puts every block on its own day, in O(log n) reads', async () => {
    const a = archive();
    const blocks = range(1000, 1199); // 137 blocks on 09-18, 63 on 09-19
    const stamp = (await stampChunkDays(blocks, a.tsOf))!;
    for (const bn of blocks) expect(utcDay(stamp(bn))).toBe(bn < 1137n ? '2026-09-18' : '2026-09-19');
    expect(a.reads.length).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(blocks.length)) + 1);
  });

  it('finds the boundary when it sits at either end of the chunk', async () => {
    // only the last log block is on the later day…
    let stamp = (await stampChunkDays(range(1100, 1137), archive().tsOf))!;
    expect(utcDay(stamp(1136n))).toBe('2026-09-18');
    expect(utcDay(stamp(1137n))).toBe('2026-09-19');
    // …and only the first is on the earlier day.
    stamp = (await stampChunkDays(range(1136, 1180), archive().tsOf))!;
    expect(utcDay(stamp(1136n))).toBe('2026-09-18');
    expect(utcDay(stamp(1137n))).toBe('2026-09-19');
  });

  it('sparse log blocks: fills stamp by the nearest resolved boundary, not by position', async () => {
    const blocks = [1010n, 1050n, 1136n, 1137n, 1190n]; // a quiet chunk, one log block either side of midnight
    const stamp = (await stampChunkDays(blocks, archive().tsOf))!;
    expect(blocks.map((bn) => utcDay(stamp(bn)))).toEqual(['2026-09-18', '2026-09-18', '2026-09-18', '2026-09-19', '2026-09-19']);
  });

  it('steps over blocks the archive momentarily cannot serve, at the anchor, the tail and a probe', async () => {
    const blocks = range(1000, 1199);
    // anchor 1000–1001 and tail 1199 refuse, and so does every block the first
    // bisect probe can land on: indices (2+198)>>1 = 100 → block 1100 and its
    // forward steps up to 1110. The probe must walk to 1111 and carry on.
    const failing = new Set([1000, 1001, 1199, ...Array.from({ length: 11 }, (_, i) => 1100 + i)]);
    const a = archive({ failing });
    const stamp = (await stampChunkDays(blocks, a.tsOf))!;
    for (const bn of blocks) expect(utcDay(stamp(bn))).toBe(bn < 1137n ? '2026-09-18' : '2026-09-19');
    // the refused probes were actually asked for, then stepped past
    expect(a.reads).toEqual(expect.arrayContaining([1100n, 1101n, 1111n]));
    expect(a.reads.filter((bn) => failing.has(Number(bn))).length).toBeGreaterThanOrEqual(13);
  });

  it('when nothing between anchor and tail resolves, the bracket stands and the middle stamps with the anchor', async () => {
    // the one-stamp behaviour this replaces, kept for exactly this degraded case
    const blocks = range(1130, 1145);
    const failing = new Set(range(1131, 1144).map(Number));
    const stamp = (await stampChunkDays(blocks, archive({ failing }).tsOf))!;
    expect(utcDay(stamp(1130n))).toBe('2026-09-18');
    expect(utcDay(stamp(1140n))).toBe('2026-09-18'); // truly 09-19, but unresolvable: anchor's day, as before
    expect(utcDay(stamp(1145n))).toBe('2026-09-19');
  });

  it('gives up (null) only when no block in the chunk resolves — the caller skips it loudly', async () => {
    const a = archive({ failing: new Set([1000, 1001, 1002]) });
    expect(await stampChunkDays(range(1000, 1002), a.tsOf)).toBeNull();
  });

  it('rethrows an availability failure untouched, so the chunk is held rather than stamped from a partial view', async () => {
    const a = archive({ down: true });
    await expect(stampChunkDays(range(1000, 1010), a.tsOf)).rejects.toBeInstanceOf(RpcReadUnavailableError);
  });
});
