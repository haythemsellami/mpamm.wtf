// A venue's one-time volume replay stops at the last block before its run's
// day, and the tail decodes a new venue only from the deploy that added it.
// Crystal Vault's replay finished on its deploy day (2026-10-27), so the hours
// before the deploy were never decoded: 434 of 1,606 fills counted. These pin
// the fix on the REAL backfillAdapter and re-read: a finished replay queues an
// ADDITIVE re-read of today (its own marker) before its done marker, hands
// today to a pending 'markets' revision, and holds while an older day's
// re-read is still pending. If the day closes first, the additive re-read
// reads it from the archive and still only adds, never a reset. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fill } from '@shared';
import type { VenueAdapter, LogSource } from '../venues/adapter.js';

const START = 4_000_000n;
const VID = 'deploy-day';
const ADDRESS = '0x00000000000000000000000000000000000000f2' as const;
const CLOSED_TS = BigInt(Math.floor(Date.parse('2026-10-26T12:00:00Z') / 1000));

const paths: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

const fill = (id: string, over: Partial<Fill> = {}): Fill => ({
  id, venueId: VID, market: 'MON/USDC', side: 'buy', category: 'ROUTER', usd: 100, baseAmount: 50, execPx: 2,
  txHash: `0x${id}`, to: 'x', pool: 'p', blockNumber: 5_000_010, ts: Date.parse('2026-10-26T12:00:00Z'),
  markoutsBps: [null, null, null, null, null], ...over,
});

interface Opts {
  readDelayMs?: number;
  /** what the archive's getLogs answers */
  logs?: () => unknown[];
  /** the adapter's decode */
  decode?: () => Fill[];
  blockAtOrAfter?: (sec: number) => bigint;
  /** a block's timestamp (seconds); a fixed closed-day noon by default */
  blockTs?: (bn: bigint) => bigint;
  /** the HOT pool; absent, any read of it throws */
  publicClient?: Record<string, unknown>;
}

async function setup(opts: Opts = {}) {
  const path = join(tmpdir(), `replay-deploy-day-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL_CHUNK', '1');
  vi.stubEnv('GETLOGS_CHUNK', '1');
  vi.stubEnv('GETLOGS_MIN_CHUNK', '1');
  vi.stubEnv('BACKFILL_MERGE_EVERY', '1');
  vi.stubEnv('BACKFILL_PACE_MS', '0');
  vi.resetModules();

  const archiveClient: any = {
    getLogs: vi.fn(async () => {
      if (opts.readDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.readDelayMs));
      return opts.logs?.() ?? [];
    }),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: opts.blockTs?.(blockNumber) ?? CLOSED_TS })),
    getBlockNumber: async () => START,
  };
  const status = () => ({ active: 'archive', degraded: false, down: false });
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    // no hot pool unless a case gives one: a closed day is read from the archive
    publicClient: opts.publicClient ?? {},
    quoteClient: {},
    headClient: { getBlockNumber: vi.fn(async () => 100n) },
    archiveClient,
    getLogsChunked: vi.fn(async (p: unknown, _o: unknown, fetch: (p: unknown) => Promise<unknown[]>) => fetch(p)),
    probeChain: vi.fn(),
    probeArchiveChain: vi.fn(),
    blockAtOrAfter: vi.fn(async (sec: number) => opts.blockAtOrAfter?.(sec) ?? START),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: status,
    rpcGeneration: () => 0,
    archiveRpcStatus: status,
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: true,
  }));

  const live = await import('../datasource/live.js');
  const { ADAPTERS } = await import('../venues/registry.js');
  const source = new live.LiveDataSource() as any;
  const writes: string[] = [];
  const failing = new Set<string>();
  const setMeta = source.storeWriter.setMeta.bind(source.storeWriter);
  source.storeWriter.setMeta = (key: string, value: string) => {
    writes.push(key);
    return failing.has(key) ? Promise.reject(new Error(`write of ${key} failed`)) : setMeta(key, value);
  };
  const notes: string[] = [];
  const note = source.note.bind(source);
  source.note = (code: string, msg: string, venue?: string) => { notes.push(`${code}: ${msg}`); return note(code, msg, venue); };

  const adapter = {
    venues: () => [{ id: VID, name: VID, color: { light: '#000', dark: '#fff' }, kind: 'amm' as const, role: 'venue' as const, sinceUtc: '2026-10-01' }],
    backfillFromUtc: '2026-10-01',
    discover: async () => {},
    logSources: () => [{ key: 'fills', address: ADDRESS, events: [] }],
    decode: async () => opts.decode?.() ?? [],
  } as unknown as VenueAdapter;
  const sources: LogSource[] = [{ key: 'fills', address: ADDRESS, events: [] }];
  return { live, ADAPTERS, source, adapter, sources, writes, failing, notes, archiveClient };
}

/** Run a re-read, playing the tail: each gate it queues runs at once. */
async function throughGates(source: any, run: Promise<void>): Promise<void> {
  let settled = false;
  run.then(() => { settled = true; }, () => { settled = true; });   // handled from the start
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const gate of source.tailGates.splice(0)) await gate();
  }
  await run;
}

/** A replay run with the queued re-read kept inert: only its queueing is pinned here. */
async function inertSetup(opts: Opts = {}) {
  const s = await setup(opts);
  s.source.runRereads = vi.fn(async () => {});
  return s;
}

describe('a finished volume replay re-reads its day, additively', () => {
  it("queues the run's day before marking itself done", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources, writes, notes } = await inertSetup();

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    await vi.runAllTimersAsync();
    await run;

    expect(source.store.getMeta(live.rereadAddKey(VID))).toBe('2026-10-27');
    expect(source.addRereads.get(VID)).toBe('2026-10-27');
    // never the replacing marker: that one turns into a reset at midnight
    expect(source.store.getMeta(live.rereadKey(VID))).toBeUndefined();
    expect(source.rereads.size).toBe(0);
    expect(source.runRereads).toHaveBeenCalled();
    expect(source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    // the other order loses the re-read to a crash between the two writes
    expect(writes.indexOf(live.rereadAddKey(VID))).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf(live.rereadAddKey(VID))).toBeLessThan(writes.indexOf(`backfill_done_${VID}`));
    expect(notes.find((n) => n.startsWith('backfill.done'))).toBe(`backfill.done: ${VID}: backfill complete — 0 day(s) seeded; re-reading 2026-10-27 from midnight for fills the tail missed`);
    source.store.close();
  });

  it('re-reads today for a venue whose history starts today: nothing to replay, the day still has a prefix', async () => {
    const now = Date.parse('2026-10-27T18:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources, writes } = await inertSetup();

    // blockAtOrAfter(since) = START > end: the replay has no closed block to read
    await source.backfillAdapter(adapter, VID, VID, '2026-10-27', sources, now, START - 1n);

    expect(source.store.getMeta(live.rereadAddKey(VID))).toBe('2026-10-27');
    expect(source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    expect(writes.indexOf(live.rereadAddKey(VID))).toBeLessThan(writes.indexOf(`backfill_done_${VID}`));
    source.store.close();
  });

  it('queues nothing when the run crosses midnight: the next run extends past the day and re-reads the new one', async () => {
    const now = Date.parse('2026-10-27T23:59:59.900Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources } = await inertSetup({ readDelayMs: 200 });

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    const rejected = expect(run).rejects.toThrow(/crossed UTC midnight/);
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    await rejected;

    expect(source.store.getMeta(live.rereadAddKey(VID))).toBeUndefined();
    expect(source.addRereads.size).toBe(0);
    expect(source.store.getMeta(`backfill_done_${VID}`)).not.toBe('1');
    source.store.close();
  });

  it("hands today to the venue's pending 'markets' revision, so it never adds the hours the re-read counts", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, ADAPTERS, source, adapter, sources } = await inertSetup();
    // Hanji declares one ('xaut-book'); the re-read decodes every market itself
    const hanji = ADAPTERS.find((a) => a.venues()[0]?.id === 'hanji')!;
    const markets = live.revisionTargets('hanji', hanji.historyRevisions).filter((t) => t.from === 'markets');
    expect(markets.length).toBeGreaterThan(0);

    const run = source.backfillAdapter(adapter, 'hanji', 'Hanji', '2026-10-01', sources, now, START);
    await vi.runAllTimersAsync();
    await run;

    for (const t of markets) expect(source.store.getMeta(live.marketsRevisionKeys(live.resetMarker(t)).owned)).toBe('2026-10-27');
    expect(source.store.getMeta(live.rereadAddKey('hanji'))).toBe('2026-10-27');
    source.store.close();
  });

  it("leaves a reset's replacing re-read of the same day to cover it", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources } = await inertSetup();
    await source.queueReread(VID, '2026-10-27');   // the reset's, queued first

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    await vi.runAllTimersAsync();
    await run;

    expect(source.store.getMeta(live.rereadKey(VID))).toBe('2026-10-27');
    expect(source.store.getMeta(live.rereadAddKey(VID))).toBeUndefined();
    expect(source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    source.store.close();
  });

  // A carried re-read waits for both history stages (resetTargets). Queuing
  // today would overwrite its marker, and its day's fills would stay stale.
  it("holds completion, untouched, while an older day's replacing re-read is pending", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, ADAPTERS, source, adapter, sources, writes } = await inertSetup();
    source.store.setMeta(live.rereadKey('hanji'), '2026-10-26');
    const hanji = ADAPTERS.find((a) => a.venues()[0]?.id === 'hanji')!;
    const markets = live.revisionTargets('hanji', hanji.historyRevisions).filter((t) => t.from === 'markets');

    const run = source.backfillAdapter(adapter, 'hanji', 'Hanji', '2026-10-01', sources, now, START);
    const rejected = expect(run).rejects.toThrow('the re-read of 2026-10-26 is still pending; it runs as a reset once both history stages are on');
    await vi.runAllTimersAsync();
    await rejected;

    expect(source.store.getMeta(live.rereadKey('hanji'))).toBe('2026-10-26');
    expect(source.store.getMeta(live.rereadAddKey('hanji'))).toBeUndefined();
    expect(source.store.getMeta('backfill_done_hanji')).not.toBe('1');
    for (const t of markets) expect(source.store.getMeta(live.marketsRevisionKeys(live.resetMarker(t)).owned)).toBeUndefined();
    expect(writes).not.toContain(live.rereadKey('hanji'));
    expect(source.rereads.size).toBe(0);
    source.store.close();
  });

  it("holds completion while an older day's additive re-read is pending: one marker per venue", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources } = await inertSetup();
    source.store.setMeta(live.rereadAddKey(VID), '2026-10-26');

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    const rejected = expect(run).rejects.toThrow('the re-read of 2026-10-26 is still pending; it re-reads that day first');
    await vi.runAllTimersAsync();
    await rejected;

    expect(source.store.getMeta(live.rereadAddKey(VID))).toBe('2026-10-26');
    expect(source.store.getMeta(`backfill_done_${VID}`)).not.toBe('1');
    source.store.close();
  });
});

describe('an additive re-read whose day closed first', () => {
  it('is never carried into a reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-28T00:05:00Z'));
    const { live, source } = await inertSetup();
    source.store.setMeta(live.rereadAddKey('hanji'), '2026-10-27');

    const targets = source.resetTargets('2026-10-28') as Array<{ vid: string; carried?: boolean }>;
    expect(targets.filter((t) => t.vid === 'hanji' && t.carried)).toEqual([]);
    source.store.close();
  });

  // The day is read whole from the ARCHIVE (publicClient has no methods here),
  // and the stored fill keeps its price though a second decode re-prices it.
  it('reads the closed day from the archive and only adds what the tail missed', async () => {
    const DAY_START = Date.parse('2026-10-26T00:00:00Z') / 1000;
    const { live, source, adapter, notes, archiveClient } = await setup({
      blockAtOrAfter: (sec) => (sec === DAY_START ? 5_000_000n : 5_000_100n),
      logs: () => [{ blockNumber: 5_000_010n }, { blockNumber: 5_000_020n }],
      decode: () => [fill('tail', { usd: 103 }), fill('prefix', { usd: 30, blockNumber: 5_000_020, ts: Date.parse('2026-10-26T01:00:00Z') })],
    });
    const stored = fill('tail', { usd: 100, markoutsBps: [1, 2, 3, 4, 5] });
    source.store.insertFillsIfAbsent([stored]);
    source.dayFor(stored.ts).byVenue[VID] = { usd: 100, swaps: 1 };
    source.lastBlock = 5_000_500n;
    source.store.setMeta(live.rereadAddKey(VID), '2026-10-26');
    source.addRereads.set(VID, '2026-10-26');
    // the markout sweep already walked the day: its cursor is past it
    source.store.setMeta(`mkhist_cursor_${VID}_MON/USDC`, '2026-10-27');
    const frames: unknown[] = [];
    source.emitMsg = (m: unknown) => { frames.push(m); };

    await throughGates(source, source.rereadToday(adapter, VID, VID, '2026-10-26', true));

    expect(archiveClient.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 5_000_000n, toBlock: 5_000_099n }));
    const kept = source.store.venueFillsInRange(VID, Date.parse('2026-10-26T00:00:00Z'), Date.parse('2026-10-27T00:00:00Z'), 5_000_099n);
    expect(kept.map((f: Fill) => [f.id, f.usd]).sort()).toEqual([['prefix', 30], ['tail', 100]]);
    expect(kept.find((f: Fill) => f.id === 'tail')!.markoutsBps).toEqual([1, 2, 3, 4, 5]);
    expect(source.dayFor(stored.ts).byVenue[VID]).toEqual({ usd: 130, swaps: 2 });
    expect(notes.find((n) => n.startsWith('backfill.reread'))).toBe(`backfill.reread: ${VID}: re-read 2026-10-26 (missing fills only) blocks 5000000→5000099 — 1→2 swaps, $100→$130; fills +1 −0`);
    // the inserted fill gets its archive markouts: the sweep walks the day again
    expect(source.store.getMeta(`mkhist_cursor_${VID}_MON/USDC`)).toBe('2026-10-26');
    // ...and the debt, the marker and the repaired day commit together
    expect(source.store.getMeta(live.rereadRemarkKey(VID))).toBe('');
    expect(source.store.getMeta(live.rereadAddKey(VID))).toBe('');
    expect(source.store.all().find((d: { utcDay: string }) => d.utcDay === '2026-10-26')?.byVenue[VID]).toEqual({ usd: 130, swaps: 2 });
    // an open Volume tab reloads the closed day it already shows
    expect(frames).toContainEqual({ ch: 'volume', resync: true });
    // the tail was flushed first: what the bucket counts is on disk with its cursor
    expect(source.store.getMeta('lastProcessedBlock')).toBe('5000500');
    source.store.close();
  });

  // The debt goes to disk BEFORE the fills: if it fails, nothing is inserted
  // and the re-read is held, so the retry inserts the fills and owes again.
  it('holds with nothing inserted when the rewind debt cannot be written', async () => {
    const DAY_START = Date.parse('2026-10-26T00:00:00Z') / 1000;
    const { live, source, adapter, failing } = await setup({
      blockAtOrAfter: (sec) => (sec === DAY_START ? 5_000_000n : 5_000_100n),
      logs: () => [{ blockNumber: 5_000_020n }],
      decode: () => [fill('prefix', { usd: 30, blockNumber: 5_000_020, ts: Date.parse('2026-10-26T01:00:00Z') })],
    });
    source.lastBlock = 5_000_500n;
    source.store.setMeta(live.rereadAddKey(VID), '2026-10-26');
    source.addRereads.set(VID, '2026-10-26');
    failing.add(live.rereadRemarkKey(VID));
    const range = [Date.parse('2026-10-26T00:00:00Z'), Date.parse('2026-10-27T00:00:00Z'), 5_000_099n] as const;

    await expect(throughGates(source, source.rereadToday(adapter, VID, VID, '2026-10-26', true))).rejects.toThrow(/reread_remark_deploy-day failed/);
    expect(source.store.venueFillsInRange(VID, ...range)).toEqual([]);
    expect(source.store.getMeta(live.rereadAddKey(VID))).toBe('2026-10-26');

    failing.clear();
    await throughGates(source, source.rereadToday(adapter, VID, VID, '2026-10-26', true));
    expect(source.store.venueFillsInRange(VID, ...range).map((f: Fill) => f.id)).toEqual(['prefix']);
    expect(source.store.getMeta(live.rereadAddKey(VID))).toBe('');
    source.store.close();
  });
});

describe("an additive re-read of today", () => {
  /** block 5,000,000 is 2026-10-27's first; one block a second */
  const T0 = BigInt(Date.parse('2026-10-27T00:00:00Z') / 1000);
  const blockTs = (bn: bigint) => T0 + (bn - 5_000_000n);

  // The markout sweep only walks closed days, so today owes no rewind, and
  // its marker clears with the tail's own snapshot: day, fills and cursor.
  it('owes no rewind and clears its marker with the next tail snapshot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-27T00:08:20Z'));
    const hot = {
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockTs(blockNumber) })),
      getLogs: vi.fn(async () => [{ blockNumber: 5_000_020n }]),
    };
    const { live, source, adapter } = await setup({
      blockTs,
      publicClient: hot,
      decode: () => [fill('prefix', { usd: 30, blockNumber: 5_000_020, ts: Date.parse('2026-10-27T00:00:20Z') })],
    });
    source.lastBlock = 5_000_500n;
    source.store.setMeta(live.rereadAddKey(VID), '2026-10-27');
    source.addRereads.set(VID, '2026-10-27');

    await throughGates(source, source.rereadToday(adapter, VID, VID, '2026-10-27', true));

    expect(hot.getLogs).toHaveBeenCalled();
    expect(source.store.getMeta(live.rereadRemarkKey(VID))).toBeUndefined();
    expect(source.snapshotMeta[live.rereadAddKey(VID)]).toBe('');
    expect(source.dirtyDays.has('2026-10-27')).toBe(true);
    expect(source.dayFor(Date.parse('2026-10-27T00:00:20Z')).byVenue[VID]).toEqual({ usd: 30, swaps: 1 });
    source.store.close();
  });
});

describe("a build's first boot hands an inherited additive re-read's day to its 'markets' revisions", () => {
  /** Hanji declares one ('xaut-book'); an additive re-read counts every market
   *  it inserts, so the revision must not add the same fills again */
  async function boot(addDay: string, now: string) {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(now));
    const s = await inertSetup();
    s.source.store.setMeta(s.live.rereadAddKey('hanji'), addDay);
    s.source.recordMarketsRevisionStarts(9_000_000n);
    const hanji = s.ADAPTERS.find((a) => a.venues()[0]?.id === 'hanji')!;
    const keys = s.live.revisionTargets('hanji', hanji.historyRevisions)
      .filter((t) => t.from === 'markets')
      .map((t) => s.live.marketsRevisionKeys(s.live.resetMarker(t)));
    expect(keys.length).toBeGreaterThan(0);
    return { ...s, keys };
  }

  it("today's: the revision stops at today's midnight, as for a replacing re-read", async () => {
    const { source, keys } = await boot('2026-10-28', '2026-10-28T09:00:00Z');
    for (const k of keys) {
      expect(source.store.getMeta(k.owned)).toBe('2026-10-28');
      expect(source.store.getMeta(k.skip)).toBeUndefined();
    }
    source.store.close();
  });

  it("a closed day's: that day alone is carved out, the days after it stay the revision's", async () => {
    const { source, keys } = await boot('2026-10-26', '2026-10-28T09:00:00Z');
    for (const k of keys) {
      expect(source.store.getMeta(k.skip)).toBe('2026-10-26');
      expect(source.store.getMeta(k.owned)).toBeUndefined();
    }
    source.store.close();
  });
});
