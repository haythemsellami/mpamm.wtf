// Live readiness is independent of archive verification, but every worker that
// can persist deep-chain data remains gated until chain-id validation is armed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKETS, SIZES_USD, type Fill, type QuoteRow } from '@shared';
import type { VenueAdapter } from '../venues/adapter.js';
import { createQuoteOutageReporter, type MulticallOutcome } from '../venues/quote-health.js';

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
  vi.restoreAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

async function setup(opts: { reset?: string; withAdapter?: boolean; withQuotes?: boolean } = {}) {
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
    quote: vi.fn((_sizes: readonly number[]): QuoteRow[] => []),
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
  const quoteRows = (venueId: string, sizes: readonly number[], markets?: ReadonlySet<string>): QuoteRow[] =>
    [...(markets ?? MARKETS)].flatMap((market) => sizes.map((sizeUsd) => ({ venueId, market, sizeUsd,
      bidBps: -1, askBps: 1, bidPx: .9999, askPx: 1.0001, spreadBps: 2, feeBps: 0, filledFull: true, ts: Date.now() })));
  const adapters: VenueAdapter[] = opts.withQuotes ? ['venue', 'baseline'].map((role) => ({
    ...adapter,
    venues: () => [{ ...adapter.venues()[0], id: role, role: role as 'venue' | 'baseline' }],
    quote: vi.fn(async (_ctx, sizes, _block, markets) => quoteRows(role, sizes, markets)),
  })) : opts.withAdapter ? [adapter] : [];
  if (opts.withQuotes) references.quote.mockImplementation((sizes: readonly number[] = []) => quoteRows('bybit', sizes));
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
    scopedQuoteClient: () => ({}),
    headClient: { getBlockNumber: vi.fn(async () => 100n) },
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
  const poll = source.poll.bind(source);
  source.initHistory = vi.fn(async () => {});
  source.bootHead = 100n;
  source.poll = vi.fn(async () => {});
  source.scheduleTail = vi.fn();
  source.backgroundHistory = vi.fn(async () => {});
  source.gas = { start: vi.fn(), stop: vi.fn(), setWriter: vi.fn() };
  return { source, archiveProbe, adapter, adapters, headWatcher, poll };
}

describe('live startup archive gate', () => {
  it('uses the isolated head lane for adapter discovery while retaining the general RPC client for other calls', async () => {
    const { source, adapter } = await setup({ withAdapter: true });
    const { publicClient, headClient } = await import('../chain/rpc.js');
    try {
      expect(source.ctxFor(adapter).client.getBlockNumber).toBe(headClient.getBlockNumber);
      await expect(source.ctxFor(adapter).client.getBlockNumber()).resolves.toBe(100n);
      expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    } finally { source.store.close(); }
  });

  it.each([false, true])('keeps timeout/busy frames out of outage counters (already dark: %s)', async (alreadyDark) => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    const { QUOTE_DARK_CYCLES } = await import('../datasource/live.js');
    source.bootMs = Date.now() - 65_000;
    source.schedulePostQuoteMaintenance = vi.fn();
    source.manageQuoteDemand();
    source.watchQuotes({ market: 'MON/USDC', sizeUsd: 100, baseline: false });
    const healthy = adapters[0].quote!;
    const notes = vi.spyOn(source, 'noteOnce'), recoveries = vi.spyOn(source, 'note');
    const held = deferred<QuoteRow[]>();
    let block = 100n;
    vi.useFakeTimers();
    try {
      await poll(block++);
      if (alreadyDark) {
        adapters[0].quote = vi.fn(async () => []);
        for (let i = 0; i < QUOTE_DARK_CYCLES; i++) await poll(block++);
        expect(source.quoteDark.has('venue')).toBe(true);
      }
      const before = structuredClone(source.quoteEmptyRuns), dark = structuredClone(source.quoteDark);
      notes.mockClear(); recoveries.mockClear();
      adapters[0].quote = vi.fn(() => held.promise);
      const timed = poll(block++);
      await vi.advanceTimersByTimeAsync(250);
      await timed;
      for (let i = 0; i < QUOTE_DARK_CYCLES + 1; i++) await poll(block++);
      expect(adapters[0].quote).toHaveBeenCalledTimes(1);
      expect(source.getQuotes().frame.missingVenues).toContain('venue');
      expect(source.quoteEmptyRuns).toEqual(before);
      expect(source.quoteDark).toEqual(dark);
      expect(notes).not.toHaveBeenCalled(); expect(recoveries).not.toHaveBeenCalled();
      held.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.quoteEmptyRuns).toEqual(before);
      adapters[0].quote = healthy;
      await poll(block++);
      expect(source.quoteEmptyRuns.get('venue').runs).toBe(0);
      expect(source.quoteDark.has('venue')).toBe(false);
      expect(recoveries.mock.calls.filter(([code]) => code === 'venue.quote.recovered')).toHaveLength(alreadyDark ? 1 : 0);
      adapters[0].quote = vi.fn(async () => []);
      for (let i = 0; i < QUOTE_DARK_CYCLES; i++) await poll(block++);
      expect(source.quoteDark.has('venue')).toBe(true);
    } finally { held.resolve([]); vi.useRealTimers(); source.store.close(); }
  });

  it.each([false, true])('keeps a partially quoting venue healthy across concurrent demand (failure first: %s)', async (failureFirst) => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    source.manageQuoteDemand();
    source.watchQuotes({ market: 'MON/USDC', sizeUsd: 100, baseline: false });
    source.watchQuotes({ market: 'BTC/USDC', sizeUsd: 1000, baseline: false });
    const failed = deferred<MulticallOutcome[]>(), healthy = deferred<MulticallOutcome[]>();
    const original = adapters[0].quote!;
    const report = createQuoteOutageReporter('Venue');
    adapters[0].quote = vi.fn(async (ctx, sizes, block, markets) => {
      const result = await (markets!.has('MON/USDC') ? failed.promise : healthy.promise);
      return report(ctx, result) ? [] : original(ctx, sizes, block, markets);
    });
    const notes = vi.spyOn(source, 'noteOnce');
    try {
      const work = poll(100n);
      await vi.waitFor(() => expect(adapters[0].quote).toHaveBeenCalledTimes(2));
      const fail = () => failed.resolve([{ status: 'failure', error: new Error('unavailable') }]);
      const recover = () => healthy.resolve([{ status: 'success' }]);
      (failureFirst ? fail : recover)();
      await new Promise((resolve) => setImmediate(resolve));
      expect(notes).not.toHaveBeenCalled();
      (failureFirst ? recover : fail)();
      await work;
      expect(notes).not.toHaveBeenCalled();
      expect(source.getQuotes().rows.filter((row: QuoteRow) => row.venueId === 'venue').map((row: QuoteRow) => row.market)).toEqual(['BTC/USDC']);
    } finally { source.store.close(); }
  });

  it('retains an adapter slot when one demand plan rejects before its sibling settles', async () => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    source.manageQuoteDemand();
    source.watchQuotes({ market: 'MON/USDC', sizeUsd: 100, baseline: false });
    source.watchQuotes({ market: 'BTC/USDC', sizeUsd: 1000, baseline: false });
    const held = deferred<QuoteRow[]>();
    adapters[0].quote = vi.fn(async (_ctx, _sizes, _block, markets) => {
      if (markets!.has('MON/USDC')) throw new Error('unavailable');
      return held.promise;
    });
    vi.useFakeTimers();
    try {
      const first = poll(100n);
      await vi.advanceTimersByTimeAsync(250);
      await first;
      await poll(101n);
      expect(adapters[0].quote).toHaveBeenCalledTimes(2);
      held.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
    } finally { held.resolve([]); vi.useRealTimers(); source.store.close(); }
  });

  it('ages fills in yielding passes with identical buy/sell signs and persistence updates', async () => {
    const { source } = await setup();
    const now = Date.now();
    const fills: Fill[] = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i), venueId: 'test-venue', market: 'MON/USDC', side: i % 2 ? 'buy' : 'sell',
      category: 'DIRECT', usd: 100, baseAmount: 100, execPx: 1, blockNumber: 1, txHash: '0x1',
      to: 'direct', pool: 'pool', ts: now - 65_000, markoutsBps: [null, null, null, null, null],
    }));
    source.pending = new Set(fills);
    source.midHist.set('MON/USDC', Array.from({ length: 1201 }, (_, i) => ({ t: now - 120_000 + i * 100, mid: 2 })));
    let emitted = 0;
    source.on('message', (message: { ch: string }) => { if (message.ch === 'fill') emitted++; });
    try {
      const work = source.ageMarkouts();
      expect(source.ageMarkouts()).toBe(work);
      expect(emitted).toBeLessThanOrEqual(128);
      await work;
      expect(emitted).toBe(fills.length);
      expect(source.dirty.size).toBe(fills.length);
      expect(source.pending.size).toBe(0);
      for (const fill of fills) expect(fill.markoutsBps).toEqual(Array(5).fill(fill.side === 'buy' ? 10_000 : -10_000));
    } finally { source.store.close(); }
  });

  it('leaves elapsed unobservable and approximate markouts null and retains future horizons', async () => {
    const { source } = await setup();
    const now = Date.now();
    const fill = (id: string, ts: number, pxApprox = false) => ({ id, ts, pxApprox, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', execPx: 1, markoutsBps: [null, null, null, null, null] });
    const expired = fill('expired', now - 130_000), approx = fill('approx', now - 65_000, true), future = fill('future', now - 1000);
    source.pending = new Set([expired, approx, future]);
    source.midHist.set('MON/USDC', [{ t: now - 2000, mid: 2 }, { t: now, mid: 2 }]);
    try {
      await source.ageMarkouts();
      expect(expired.markoutsBps).toEqual([null, null, null, null, null]);
      expect(approx.markoutsBps).toEqual([null, null, null, null, null]);
      expect(future.markoutsBps).toEqual([10_000, null, null, null, null]);
      expect(source.pending).toEqual(new Set([future]));
    } finally { source.store.close(); }
  });

  it('full demand includes regular venues, baselines and reference rows without duplicating adapter calls', async () => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    source.manageQuoteDemand();
    const release = source.watchQuotes({ market: 'MON/USDC', sizeUsd: 1000, baseline: false });
    try {
      await poll(100n);
      expect(new Set(source.getQuotes().rows.map((row: QuoteRow) => row.venueId))).toEqual(new Set(['venue', 'bybit']));
      const snapshot = source.fullQuoteSnapshot();
      await poll(101n);
      const full = await snapshot;
      for (const venueId of ['venue', 'baseline', 'bybit']) {
        expect(full.rows.filter((row: QuoteRow) => row.venueId === venueId)).toHaveLength(MARKETS.length * SIZES_USD.length);
      }
      expect(adapters[0].quote).toHaveBeenCalledTimes(2);
      expect(adapters[1].quote).toHaveBeenCalledTimes(1);
    } finally { release(); source.store.close(); }
  });

  it('clears idle quotes and never serves a snapshot older than the history window', async () => {
    const { source, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    source.manageQuoteDemand();
    const release = source.watchQuotes();
    try {
      await poll(100n);
      expect(source.getQuotes().rows.length).toBeGreaterThan(0);
      const ts = source.getQuotes().ts;
      vi.spyOn(Date, 'now').mockReturnValue(ts + 60_001);
      expect(source.getQuotes().rows).toEqual([]);
      expect(source.quoteHistory('MON/USDC', 1000)).toEqual([]);
      vi.restoreAllMocks();
      release();
      await poll(101n);
      expect(source.getQuotes().rows).toEqual([]);
      expect(source.quotesFull).toBe(false);
    } finally { release(); source.store.close(); }
  });

  it('waits past an in-flight scoped frame when a fresh full snapshot is requested', async () => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    source.manageQuoteDemand();
    const first = source.fullQuoteSnapshot();
    await poll(100n);
    await first;
    const release = source.watchQuotes({ market: 'MON/USDC', sizeUsd: 1000, baseline: false });
    try {
      const partial = deferred<QuoteRow[]>();
      vi.mocked(adapters[0].quote!).mockImplementationOnce(() => partial.promise);
      const running = poll(101n);
      let completed = false;
      const fresh = source.fullQuoteSnapshot(true).then((snapshot: { block: number }) => { completed = true; return snapshot; });
      partial.resolve([]);
      await running;
      expect(completed).toBe(false);
      await poll(102n);
      expect((await fresh).block).toBe(102);
    } finally { release(); source.store.close(); }
  });

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

    await source.storeWriter.setMeta('backfill_done_test-venue', '1');
    await source.storeWriter.setMeta('mkfill_done_test-venue', '1');
    source.backgroundHistory.mockClear();
    await source.rediscover();
    expect(adapter.discover).toHaveBeenCalled();
    expect(source.backgroundHistory).toHaveBeenCalledOnce();

    // Once the per-venue marker records this exact entry, rediscovery becomes
    // a no-op again instead of repeatedly launching history work.
    await source.storeWriter.setMeta('backfill_reset_applied_test-venue', reset);
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
    await expect(source.persist(true)).rejects.toThrow('disk unavailable');
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
