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
    getBlock: vi.fn(async () => ({ timestamp: CLOSED_TS })),
    getBlockNumber: async () => START,
  };
  const status = () => ({ active: 'archive', degraded: false, down: false });
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    // no hot pool at all: a closed day must be read from the archive
    publicClient: {},
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
  const setMeta = source.storeWriter.setMeta.bind(source.storeWriter);
  source.storeWriter.setMeta = (key: string, value: string) => { writes.push(key); return setMeta(key, value); };
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
  return { live, ADAPTERS, source, adapter, sources, writes, notes, archiveClient };
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
    source.addRereads.set(VID, '2026-10-26');

    let settled = false;
    const run = source.rereadToday(adapter, VID, VID, '2026-10-26', true).finally(() => { settled = true; });
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const gate of source.tailGates.splice(0)) await gate();
    }
    await run;

    expect(archiveClient.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 5_000_000n, toBlock: 5_000_099n }));
    const kept = source.store.venueFillsInRange(VID, Date.parse('2026-10-26T00:00:00Z'), Date.parse('2026-10-27T00:00:00Z'), 5_000_099n);
    expect(kept.map((f: Fill) => [f.id, f.usd]).sort()).toEqual([['prefix', 30], ['tail', 100]]);
    expect(kept.find((f: Fill) => f.id === 'tail')!.markoutsBps).toEqual([1, 2, 3, 4, 5]);
    expect(source.dayFor(stored.ts).byVenue[VID]).toEqual({ usd: 130, swaps: 2 });
    expect(source.snapshotMeta[live.rereadAddKey(VID)]).toBe('');
    expect(notes.find((n) => n.startsWith('backfill.reread'))).toBe(`backfill.reread: ${VID}: re-read 2026-10-26 (missing fills only) blocks 5000000→5000099 — 1→2 swaps, $100→$130; fills +1 −0`);
    source.store.close();
  });
});
