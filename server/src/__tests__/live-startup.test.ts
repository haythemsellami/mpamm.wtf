// Live readiness is independent of archive verification, but every worker that
// can persist deep-chain data remains gated until chain-id validation is armed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const paths: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

async function setup(opts: { reset?: string; withAdapter?: boolean } = {}) {
  const path = join(tmpdir(), `live-startup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', 'on');
  vi.stubEnv('MARKOUT_BACKFILL', 'on');
  vi.stubEnv('GAS_METRIC', 'on');
  if (opts.reset) vi.stubEnv('BACKFILL_RESET', opts.reset);
  vi.resetModules();

  const archiveProbe = deferred<{ ok: boolean; block: number; reason?: string; wrongChain?: boolean }>();
  const references = {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    assetUsd: vi.fn(() => 1),
    changePctFor: vi.fn(() => 0),
    midForPair: vi.fn(() => 1),
    quote: vi.fn(() => []),
    metas: vi.fn(() => []),
  };
  const adapter = {
    venues: () => [{
      id: 'test-venue',
      name: 'Test Venue',
      color: { light: '#000', dark: '#fff' },
      kind: 'amm' as const,
      role: 'venue' as const,
    }],
    discover: vi.fn(async () => {}),
    logSources: () => [],
    decode: vi.fn(async () => []),
  };
  const adapters = opts.withAdapter ? [adapter] : [];
  vi.doMock('../venues/registry.js', () => ({
    ADAPTERS: adapters,
    REFERENCES: references,
    venueMeta: () => [],
    venueIds: () => [],
    allVenueIds: () => adapters.map((a) => a.venues()[0].id),
    allAdapterVenueIds: () => new Set(adapters.map((a) => a.venues()[0].id)),
    validateRegistry: vi.fn(),
  }));
  vi.doMock('../chain/rpc.js', () => ({
    monad: { blockTime: 300 },
    publicClient: { getBlockNumber: vi.fn(async () => 100n) },
    quoteClient: {},
    archiveClient: {},
    getLogsChunked: vi.fn(),
    probeChain: vi.fn(async () => ({ ok: true, block: 100 })),
    probeArchiveChain: vi.fn(() => archiveProbe.promise),
    blockAtOrAfter: vi.fn(),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: () => ({ active: 'primary', degraded: false, down: false }),
    rpcGeneration: () => 0,
    archiveRpcStatus: () => ({ active: 'archive', degraded: false, down: false }),
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: true,
  }));
  const headWatcher = { start: vi.fn(), stop: vi.fn() };
  vi.doMock('../chain/heads.js', () => ({
    HotHeadWatcher: class {
      start(...args: unknown[]) { return headWatcher.start(...args); }
      stop(...args: unknown[]) { return headWatcher.stop(...args); }
    },
  }));

  const { LiveDataSource } = await import('../datasource/live.js');
  const source = new LiveDataSource() as any;
  source.initHistory = vi.fn(async () => {});
  source.bootHead = 100n;
  source.poll = vi.fn(async () => {});
  source.scheduleTail = vi.fn();
  source.backgroundHistory = vi.fn(async () => {});
  source.gas = { start: vi.fn(), stop: vi.fn() };
  return { source, archiveProbe, adapter, headWatcher };
}

describe('live startup archive gate', () => {
  it('warms hot loops while archive verification is still pending, then starts deep workers', async () => {
    const { source, archiveProbe, headWatcher } = await setup();
    const started = source.start();

    await vi.waitFor(() => {
      expect(source.poll).toHaveBeenCalledOnce();
      expect(source.poll).toHaveBeenCalledWith(100n, expect.objectContaining({ blockNumber: 100n, source: 'http', coalescedBlocks: 0 }));
      expect(headWatcher.start).toHaveBeenCalledOnce();
      expect(source.scheduleTail).toHaveBeenCalledOnce();
    });
    expect(source.backgroundHistory).not.toHaveBeenCalled();
    expect(source.gas.start).not.toHaveBeenCalled();

    archiveProbe.resolve({ ok: true, block: 100 });
    await started;
    expect(source.backgroundHistory).toHaveBeenCalledOnce();
    expect(source.gas.start).toHaveBeenCalledOnce();
    await source.stop();
  });

  it('never starts deep workers when the archive primary is on the wrong chain', async () => {
    const { source, archiveProbe, headWatcher } = await setup();
    const outcome = source.start().then((): Error | undefined => undefined, (error: unknown) => error as Error);

    await vi.waitFor(() => {
      expect(headWatcher.start).toHaveBeenCalledOnce();
      expect(source.scheduleTail).toHaveBeenCalledOnce();
    });
    archiveProbe.resolve({ ok: false, block: 0, wrongChain: true, reason: 'archive primary is on the wrong chain' });
    const error = await outcome;
    expect(error?.message).toMatch(/Archive RPC sanity check failed.*wrong chain/i);
    expect(source.backgroundHistory).not.toHaveBeenCalled();
    expect(source.gas.start).not.toHaveBeenCalled();
    await source.stop();
  });

  it('retries an unapplied reset even when every venue seed is already done', async () => {
    const reset = 'test-venue@2';
    const { source, archiveProbe, adapter } = await setup({ reset, withAdapter: true });
    const started = source.start();
    archiveProbe.resolve({ ok: true, block: 100 });
    await started;

    source.store.setMeta('backfill_done_test-venue', '1');
    source.store.setMeta('mkfill_done_test-venue', '1');
    source.backgroundHistory.mockClear();
    await source.rediscover();
    expect(adapter.discover).toHaveBeenCalled();
    expect(source.backgroundHistory).toHaveBeenCalledOnce();

    // Once the per-venue marker records this exact entry, rediscovery becomes
    // a no-op again instead of repeatedly launching history work.
    source.store.setMeta('backfill_reset_applied_test-venue', reset);
    source.backgroundHistory.mockClear();
    await source.rediscover();
    expect(source.backgroundHistory).not.toHaveBeenCalled();
    await source.stop();
  });

  it('quotes observed heads at their explicit block and coalesces overload to the newest head', async () => {
    const { source, archiveProbe, headWatcher } = await setup();
    const started = source.start();
    archiveProbe.resolve({ ok: true, block: 100 });
    await started;

    const first = deferred<void>();
    source.poll.mockClear();
    source.poll.mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const callbacks = headWatcher.start.mock.calls[0][0];

    callbacks.onBlock(101n, 'ws');
    await vi.waitFor(() => expect(source.poll).toHaveBeenCalledWith(101n, expect.objectContaining({ source: 'ws', coalescedBlocks: 0 })));
    callbacks.onBlock(102n, 'ws');
    callbacks.onBlock(103n, 'ws');
    first.resolve();

    await vi.waitFor(() => expect(source.poll).toHaveBeenCalledWith(103n, expect.objectContaining({ source: 'ws', coalescedBlocks: 1 })));
    expect(source.poll.mock.calls.map((args: unknown[]) => args[0])).toEqual([101n, 103n]);
    await source.stop();
  });

  it('counts a failed running frame when a newer pending head supersedes it', async () => {
    const { source, archiveProbe, headWatcher } = await setup();
    const started = source.start();
    archiveProbe.resolve({ ok: true, block: 100 });
    await started;

    const first = deferred<void>();
    source.poll.mockClear();
    source.poll.mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const callbacks = headWatcher.start.mock.calls[0][0];

    callbacks.onBlock(101n, 'ws');
    await vi.waitFor(() => expect(source.poll).toHaveBeenCalledWith(101n, expect.any(Object)));
    callbacks.onBlock(103n, 'ws');
    first.reject(new Error('frame failed'));

    await vi.waitFor(() => expect(source.poll).toHaveBeenCalledWith(103n, expect.objectContaining({ coalescedBlocks: 2 })));
    await source.stop();
  });

  it('persists only volume days changed since the prior snapshot', async () => {
    const { source } = await setup();
    const historical = { utcDay: '2026-01-01', partial: false, byVenue: { old: { usd: 1, swaps: 1 } } };
    const changed = { utcDay: '2026-08-25', partial: true, byVenue: { live: { usd: 2, swaps: 2 } } };
    source.days = [historical, changed];
    source.dirtyDays = new Set([changed.utcDay]);
    const persistSnapshot = vi.spyOn(source.store, 'persistSnapshot').mockImplementation(() => undefined);

    await source.persist();

    expect(persistSnapshot).toHaveBeenCalledWith([changed], expect.any(Object), [], expect.any(Array));
    expect(source.dirtyDays.size).toBe(0);
    source.store.close();
  });

  it('requeues dirty data when an asynchronous snapshot fails', async () => {
    const { source } = await setup();
    const changed = { utcDay: '2026-08-25', partial: true, byVenue: { live: { usd: 2, swaps: 2 } } };
    source.days = [changed];
    source.dirtyDays = new Set([changed.utcDay]);
    vi.spyOn(source.store, 'persistSnapshot').mockImplementation(() => { throw new Error('disk unavailable'); });

    await source.persist();

    expect(source.dirtyDays).toEqual(new Set([changed.utcDay]));
    expect(source.notes.list()).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'store.persist.failed' })]));
    source.store.close();
  });

  it('checkpoints only backfill days whose accumulated total changed', async () => {
    const { source } = await setup();
    const acc = new Map([['2026-08-20', { usd: 10, swaps: 2 }]]);
    const flushed = new Map([['2026-08-20', { usd: 10, swaps: 2 }]]);
    source.days = [];

    expect(source.mergeBackfill('test-venue', acc, flushed)).toEqual([]);
    acc.set('2026-08-20', { usd: 11, swaps: 3 });
    expect(source.mergeBackfill('test-venue', acc, flushed).map((d: { utcDay: string }) => d.utcDay))
      .toEqual(['2026-08-20']);
    source.store.close();
  });
});
