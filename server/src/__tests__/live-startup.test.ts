// Live readiness is independent of archive verification, but every worker that
// can persist deep-chain data remains gated until chain-id validation is armed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MARKETS, SIZES_USD, type Fill, type QuoteRow, type StateNote } from '@shared';
import type { VenueAdapter } from '../venues/adapter.js';

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
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
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
      identity() { return { generation: 0 }; }
      isCurrent() { return true; }
      rememberResolved() { return true; }
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
  it('serves empty REST snapshots without waiting for cold-start quote demand', async () => {
    vi.stubEnv('API_PORT', '0');
    const { source } = await setup({ withQuotes: true });
    const { startServer } = await import('../server.js');
    const server = startServer(source);
    await once(server, 'listening');
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const path of ['/api/markets', '/api/quotes']) {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(1_500) });
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect((path === '/api/markets' ? body.quotes : body).rows).toEqual([]);
      }
      expect(source.fullSnapshotPending).toBeUndefined();
      for (const path of ['/api/bootstrap?volume=1', '/api/fills']) {
        const response = await fetch(origin + path);
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('1');
      }
      source.historyReady = true;
      for (const path of ['/api/bootstrap?volume=1', '/api/fills']) expect((await fetch(origin + path)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      source.store.close();
    }
  });

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
      expect(source.quoteEmptyRuns.get('venue')).toEqual(before.get('venue'));
      expect(source.quoteDark).toEqual(dark);
      expect(notes).not.toHaveBeenCalled(); expect(recoveries).not.toHaveBeenCalled();
      held.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.quoteEmptyRuns.get('venue')).toEqual(before.get('venue'));
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

  it('announces recovery when a thrown quote succeeds again, then stays quiet', async () => {
    // The core's half of venue.quote.unavailable (poll's catch): a rejection is
    // noted once per distinct reason and the heal is announced — otherwise the
    // warning stands until the window rolls it off. Mirrors
    // createQuoteOutageReporter, including the re-arm + stay-quiet guards.
    // Asserted on the served window itself, since that is what a maintainer reads.
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.bootMs = Date.now() - 65_000;
    source.schedulePostQuoteMaintenance = vi.fn();
    const healthy = adapters[0].quote!;
    const fail = (why: string) => { adapters[0].quote = vi.fn(async () => { throw new Error(why); }); };
    const window = () => source.notes.list()
      .filter((n: StateNote) => n.venue === 'venue' && n.code.startsWith('venue.quote.'))
      .map((n: StateNote) => `${n.code.slice('venue.quote.'.length)}: ${n.msg}`);
    let block = 200n;
    try {
      await poll(block++);
      fail('rpc boom');
      await poll(block++);
      // Same failure again: the latch dedupes, no second note.
      await poll(block++);
      // A CHANGED reason is a new event and earns its own note.
      fail('different');
      await poll(block++);
      // Heal: exactly one recovery, quoting the prior reason, latch cleared.
      adapters[0].quote = healthy;
      await poll(block++);
      expect(source.quoteFailed.has('venue')).toBe(false);
      // A second healthy poll with nothing raised in between stays silent.
      await poll(block++);
      expect(window()).toEqual([
        expect.stringMatching(/^unavailable: .*quote failed: rpc boom$/),
        expect.stringMatching(/^unavailable: .*quote failed: different$/),
        expect.stringMatching(/^recovered: .*quoting again \(was "different"\)$/),
      ]);
      // The SAME failure as an earlier episode must be visible again after a
      // recovery: the window must never end on "quoting again" while down.
      fail('rpc boom');
      await poll(block++);
      expect(window().at(-1)).toMatch(/^unavailable: .*quote failed: rpc boom$/);
      expect(source.quoteFailed.get('venue')).toBe('rpc boom');
    } finally { source.store.close(); }
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

  it('collects every market, size and venue role once per block with zero viewers', async () => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    try {
      for (const block of [100n, 101n, 102n]) await poll(block);
      const full = source.getQuotes();
      for (const venueId of ['venue', 'baseline', 'bybit']) {
        expect(full.rows.filter((row: QuoteRow) => row.venueId === venueId)).toHaveLength(MARKETS.length * SIZES_USD.length);
      }
      for (const adapter of adapters) {
        expect(adapter.quote).toHaveBeenCalledTimes(3);
        for (const call of vi.mocked(adapter.quote!).mock.calls) {
          expect(call[1]).toEqual(SIZES_USD);
          expect(call[3]).toBeUndefined();
        }
      }
      expect(source.quoteHistory('MON/USDC', 1000).map((q: { block: number }) => q.block)).toEqual([100, 101, 102]);
      expect(source.quoteStats('BTC/USDC', 100).rows.every((row: { n: number }) => row.n === 3)).toBe(true);
    } finally { source.clearExecutionHistory(); source.store.close(); }
  });

  it('expires stalled quotes but resumes collection without requiring a viewer', async () => {
    const { source, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    try {
      await poll(100n);
      const ts = source.getQuotes().ts;
      vi.spyOn(Date, 'now').mockReturnValue(ts + 60_001);
      expect(source.getQuotes().rows).toEqual([]);
      expect(source.quoteHistory('MON/USDC', 1000)).toEqual([]);
      expect(source.quoteStats('MON/USDC', 1000).rows.length).toBeGreaterThan(0);
      await poll(101n);
      expect(source.getQuotes().rows.length).toBeGreaterThan(0);
      expect(source.quotesFull).toBe(true);
    } finally { source.clearExecutionHistory(); source.store.close(); }
  });

  it('shares concurrent complete-snapshot requests with the running collector', async () => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    try {
      await poll(100n);
      const held = deferred<QuoteRow[]>();
      vi.mocked(adapters[0].quote!).mockImplementationOnce(() => held.promise);
      const running = poll(101n);
      const a = source.fullQuoteSnapshot(true), b = source.fullQuoteSnapshot(true);
      expect(a).toBe(b);
      held.resolve([]);
      await running;
      expect((await a).block).toBe(101);
      for (const adapter of adapters) expect(adapter.quote).toHaveBeenCalledTimes(2);
    } finally { source.clearExecutionHistory(); source.store.close(); }
  });

  it.each(['recovery', 'timeout'] as const)('holds an incomplete full matrix through deadlines and busy slots until %s', async (mode) => {
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.schedulePostQuoteMaintenance = vi.fn();
    const held = deferred<QuoteRow[]>();
    const healthy = adapters[0].quote!;
    vi.useFakeTimers();
    try {
      await poll(100n);
      adapters[0].quote = vi.fn(() => held.promise);
      let complete = false;
      const snapshot = source.fullQuoteSnapshot(true).then((value: unknown) => { complete = true; return value; });
      const result = snapshot.then((value: unknown) => value, (error: Error) => error);
      const first = poll(101n); await vi.advanceTimersByTimeAsync(250); await first;
      expect(source.quoteSnapshotComplete()).toBe(false); expect(complete).toBe(false);
      await poll(102n);
      expect(source.quoteSnapshotComplete()).toBe(false); expect(complete).toBe(false);
      if (mode === 'timeout') {
        await vi.advanceTimersByTimeAsync(2_750);
        expect(await result).toMatchObject({ message: 'quote snapshot unavailable' });
      } else {
        held.resolve([]); await vi.advanceTimersByTimeAsync(0);
        adapters[0].quote = healthy;
        await poll(103n);
        expect(source.quoteSnapshotComplete()).toBe(true);
        expect(await result).toMatchObject({ block: 103 });
      }
    } finally { held.resolve([]); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); source.store.close(); }
  });

  it('warms hot loops while archive verification is still pending, then starts deep workers', async () => {
    const { source, archiveProbe, headWatcher } = await setup();
    const started = source.start();

    await vi.waitFor(() => {
      expect(source.poll).toHaveBeenCalledOnce();
      expect(source.poll).toHaveBeenCalledWith(100n, expect.objectContaining({ blockNumber: 100n, source: 'http', coalescedBlocks: 0 }));
      expect(headWatcher.start).toHaveBeenCalledOnce();
      expect(source.isReady()).toBe(true);
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

  it('retains the boot quote identity so the first matching watcher head does not requote', async () => {
    const { source, archiveProbe, headWatcher, poll } = await setup({ withQuotes: true });
    source.poll = vi.fn(poll);
    archiveProbe.resolve({ ok: true, block: 100 });
    await source.start();
    try {
      const hash = `0x${(100).toString(16).padStart(64, '0')}`;
      expect(source.quotedIdentity).toMatchObject({ hash, generation: 0 });
      const callbacks = headWatcher.start.mock.calls[0][0];
      callbacks.onBlock(100n, 'http', Date.now(), { generation: 0 });
      callbacks.onBlock(100n, 'ws', Date.now(), { hash, generation: 0 });
      expect(source.poll).toHaveBeenCalledOnce();
      callbacks.onBlock(101n, 'ws', Date.now(), { generation: 0 });
      await vi.waitFor(() => expect(source.quotedBlock).toBe(101n));
      expect(source.poll).toHaveBeenCalledTimes(2);
    } finally { await source.stop(); }
  });

  it('retries the boot head when its initial quote failed', async () => {
    const { source, archiveProbe, headWatcher } = await setup();
    source.poll.mockRejectedValueOnce(new Error('unavailable'));
    archiveProbe.resolve({ ok: true, block: 100 });
    await source.start();
    try {
      expect(source.quotedBlock).not.toBe(100n);
      headWatcher.start.mock.calls[0][0].onBlock(100n, 'http', Date.now(), { generation: 0 });
      await vi.waitFor(() => expect(source.quotedBlock).toBe(100n));
      expect(source.poll).toHaveBeenCalledTimes(2);
    } finally { await source.stop(); }
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

  it('recomputes a same-height replacement without a duplicate commitment tick', async () => {
    const { source, archiveProbe, headWatcher } = await setup();
    archiveProbe.resolve({ ok: true, block: 100 }); await source.start();
    const callbacks = headWatcher.start.mock.calls[0][0];
    const old = { hash: `0x${'a'.repeat(64)}`, generation: 0, revision: 0 };
    const next = { hash: `0x${'b'.repeat(64)}`, generation: 0, revision: 1 };
    source.poll.mockClear();
    callbacks.onBlock(101n, 'ws', Date.now(), old);
    await vi.waitFor(() => expect(source.quotedBlock).toBe(101n));
    callbacks.onReplaced(101n); callbacks.onBlock(101n, 'ws', Date.now(), next);
    await vi.waitFor(() => expect(source.poll).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(source.quoteRunning).toBe(false));
    callbacks.onBlock(101n, 'ws', Date.now(), next);
    expect(source.poll).toHaveBeenCalledTimes(2);
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
