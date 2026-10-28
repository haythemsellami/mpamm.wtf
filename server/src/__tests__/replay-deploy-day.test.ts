// A venue's one-time volume replay stops at the last block before its run's
// day, and the tail decodes a new venue only from the deploy that added it.
// Crystal Vault's replay finished on its deploy day (2026-10-27), so the hours
// before the deploy were never decoded: 434 of 1,606 fills counted. These pin
// the fix on the REAL backfillAdapter: a finished replay queues an additive
// re-read of today before its done marker, hands today to a pending 'markets'
// revision, and holds while an older day's re-read is still pending. The
// re-read itself is inert here (runRereads stubbed). No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function setup(readDelayMs = 0) {
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
    getLogs: async () => {
      if (readDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, readDelayMs));
      return [];
    },
    getBlock: async () => ({ timestamp: CLOSED_TS }),
    getBlockNumber: async () => START,
  };
  const status = () => ({ active: 'archive', degraded: false, down: false });
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    publicClient: {},
    quoteClient: {},
    headClient: { getBlockNumber: vi.fn(async () => 100n) },
    archiveClient,
    getLogsChunked: vi.fn(),
    probeChain: vi.fn(),
    probeArchiveChain: vi.fn(),
    blockAtOrAfter: vi.fn(async () => START),
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
  // the re-read is the existing reset machinery; only its queueing is new
  source.runRereads = vi.fn(async () => {});
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
    logSources: () => [],
    decode: async () => [],
  } as unknown as VenueAdapter;
  const sources: LogSource[] = [{ key: 'fills', address: ADDRESS, events: [] }];
  return { live, ADAPTERS, source, adapter, sources, writes, notes };
}

describe('a finished volume replay re-reads its day', () => {
  it("queues the run's day for a re-read from midnight before marking itself done", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources, writes, notes } = await setup();

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    await vi.runAllTimersAsync();
    await run;

    expect(source.store.getMeta(live.rereadKey(VID))).toBe('2026-10-27');
    expect(source.rereads.get(VID)).toBe('2026-10-27');
    expect(source.runRereads).toHaveBeenCalled();
    expect(source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    // the other order loses the re-read to a crash between the two writes
    expect(writes.indexOf(live.rereadKey(VID))).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf(live.rereadKey(VID))).toBeLessThan(writes.indexOf(`backfill_done_${VID}`));
    expect(notes.find((n) => n.startsWith('backfill.done'))).toBe(`backfill.done: ${VID}: backfill complete — 0 day(s) seeded; re-reading 2026-10-27 from midnight for fills the tail missed`);
    source.store.close();
  });

  it('re-reads today for a venue whose history starts today: nothing to replay, the day still has a prefix', async () => {
    const now = Date.parse('2026-10-27T18:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources, writes } = await setup();

    // blockAtOrAfter(since) = START > end: the replay has no closed block to read
    await source.backfillAdapter(adapter, VID, VID, '2026-10-27', sources, now, START - 1n);

    expect(source.store.getMeta(live.rereadKey(VID))).toBe('2026-10-27');
    expect(source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    expect(writes.indexOf(live.rereadKey(VID))).toBeLessThan(writes.indexOf(`backfill_done_${VID}`));
    source.store.close();
  });

  it('queues nothing when the run crosses midnight: the next run extends past the day and re-reads the new one', async () => {
    const now = Date.parse('2026-10-27T23:59:59.900Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources } = await setup(200);

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    const rejected = expect(run).rejects.toThrow(/crossed UTC midnight/);
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    await rejected;

    expect(source.store.getMeta(live.rereadKey(VID))).toBeUndefined();
    expect(source.rereads.size).toBe(0);
    expect(source.store.getMeta(`backfill_done_${VID}`)).not.toBe('1');
    source.store.close();
  });

  it("hands today to the venue's pending 'markets' revision, so it never adds the hours the re-read counts", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, ADAPTERS, source, adapter, sources } = await setup();
    // Hanji declares one ('xaut-book'); the re-read decodes every market itself
    const hanji = ADAPTERS.find((a) => a.venues()[0]?.id === 'hanji')!;
    const markets = live.revisionTargets('hanji', hanji.historyRevisions).filter((t) => t.from === 'markets');
    expect(markets.length).toBeGreaterThan(0);

    const run = source.backfillAdapter(adapter, 'hanji', 'Hanji', '2026-10-01', sources, now, START);
    await vi.runAllTimersAsync();
    await run;

    for (const t of markets) expect(source.store.getMeta(live.marketsRevisionKeys(live.resetMarker(t)).owned)).toBe('2026-10-27');
    expect(source.store.getMeta(live.rereadKey('hanji'))).toBe('2026-10-27');
    source.store.close();
  });

  // Nothing changed the decode, so the re-read only adds what the tail missed:
  // a second decode re-prices cross-quoted fills (planReread's keep).
  it('queues the re-read as additive', async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources } = await setup();

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    await vi.runAllTimersAsync();
    await run;

    expect(source.store.getMeta(live.rereadKeepKey(VID))).toBe('2026-10-27');
    // a reset queued afterwards re-reads everything again: the replacing one wins
    await source.queueReread(VID, '2026-10-27');
    expect(source.store.getMeta(live.rereadKeepKey(VID))).toBe('');
    expect(source.store.getMeta(live.rereadKey(VID))).toBe('2026-10-27');
    source.store.close();
  });

  it("leaves a reset's replacing re-read of the same day replacing", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, source, adapter, sources } = await setup();
    await source.queueReread(VID, '2026-10-27');   // the reset's, queued first

    const run = source.backfillAdapter(adapter, VID, VID, '2026-10-01', sources, now, START);
    await vi.runAllTimersAsync();
    await run;

    expect(source.store.getMeta(live.rereadKey(VID))).toBe('2026-10-27');
    expect(source.store.getMeta(live.rereadKeepKey(VID))).toBe('');
    expect(source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    source.store.close();
  });

  // A carried re-read waits for both history stages (resetTargets). Queuing
  // today would overwrite its marker, and its day's fills would stay stale.
  it("holds completion, untouched, while an older day's re-read is pending", async () => {
    const now = Date.parse('2026-10-27T23:14:40Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { live, ADAPTERS, source, adapter, sources, writes } = await setup();
    source.store.setMeta(live.rereadKey('hanji'), '2026-10-26');
    const hanji = ADAPTERS.find((a) => a.venues()[0]?.id === 'hanji')!;
    const markets = live.revisionTargets('hanji', hanji.historyRevisions).filter((t) => t.from === 'markets');

    const run = source.backfillAdapter(adapter, 'hanji', 'Hanji', '2026-10-01', sources, now, START);
    const rejected = expect(run).rejects.toThrow('the re-read of 2026-10-26 is still pending; it runs as a reset once both history stages are on');
    await vi.runAllTimersAsync();
    await rejected;

    expect(source.store.getMeta(live.rereadKey('hanji'))).toBe('2026-10-26');
    expect(source.store.getMeta(live.rereadKeepKey('hanji'))).toBeUndefined();
    expect(source.store.getMeta('backfill_done_hanji')).not.toBe('1');
    for (const t of markets) expect(source.store.getMeta(live.marketsRevisionKeys(live.resetMarker(t)).owned)).toBeUndefined();
    expect(writes).not.toContain(live.rereadKey('hanji'));
    expect(source.rereads.size).toBe(0);
    source.store.close();
  });
});
