// Live readiness is independent of archive verification, but every worker that
// can persist deep-chain data remains gated until chain-id validation is armed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { CURVE_OFFSETS_S, MARKETS, SIZES_USD, type Fill, type QuoteRow, type StateNote } from '@shared';
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

async function setup(opts: { reset?: string; withAdapter?: boolean; withQuotes?: boolean; markoutBackfill?: 'on' | 'off'; backfill?: 'on' | 'off' } = {}) {
  const path = join(tmpdir(), `live-startup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', opts.backfill ?? 'on');
  vi.stubEnv('MARKOUT_BACKFILL', opts.markoutBackfill ?? 'on');
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

  it('keeps an adapter-explained outage off MISSING when the same reason returns after a recovery', async () => {
    // ThogAMM, 2026-09-30: "maker: stale" → healed → "maker: stale". The
    // adapter's second note was a verbatim repeat of the first, still in the
    // window, so ctx.note's dedupe dropped it. The backstop then found no
    // explanation for this outage, raised its own, and the frame listed the
    // venue MISSING while the reason sat one episode back in the window.
    const { createQuoteOutageReporter } = await import('../venues/quote-health.js');
    const { QUOTE_DARK_CYCLES } = await import('../datasource/live.js');
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.bootMs = Date.now() - 65_000;
    source.schedulePostQuoteMaintenance = vi.fn();
    const healthy = adapters[0].quote!;
    const report = createQuoteOutageReporter('Test Venue');
    const stale = { status: 'failure' as const, error: Object.assign(new Error('x'), { reason: 'maker: stale' }) };
    const fail = () => { adapters[0].quote = vi.fn(async (ctx) => { report(ctx, [stale]); return []; }); };
    const heal = () => { adapters[0].quote = vi.fn(async (ctx, sizes, block, markets) => { report(ctx, [{ status: 'success' }]); return healthy(ctx, sizes, block, markets); }); };
    const window = () => source.notes.list()
      .filter((n: StateNote) => n.venue === 'venue' && n.code.startsWith('venue.quote.'))
      .map((n: StateNote) => n.code.slice('venue.quote.'.length));
    let block = 300n;
    try {
      await poll(block++);
      fail();
      for (let i = 0; i <= QUOTE_DARK_CYCLES; i++) await poll(block++);
      heal();
      await poll(block++);
      fail();
      for (let i = 0; i <= QUOTE_DARK_CYCLES; i++) await poll(block++);
      expect(window()).toEqual(['unavailable', 'recovered', 'unavailable']);
      expect(source.quoteDark.has('venue')).toBe(false);
      expect(source.getQuotes().frame.missingVenues).not.toContain('venue');
    } finally { source.store.close(); }
  });

  it('drops a dark venue from MISSING once its adapter explains the outage late', async () => {
    // Clober can only name empty books once it has legs to price. If the
    // backstop marked it dark first, a later explanation must still win.
    const { createQuoteOutageLatch } = await import('../venues/quote-health.js');
    const { QUOTE_DARK_CYCLES } = await import('../datasource/live.js');
    const { source, adapters, poll } = await setup({ withQuotes: true });
    source.bootMs = Date.now() - 65_000;
    source.schedulePostQuoteMaintenance = vi.fn();
    const report = createQuoteOutageLatch('Test Venue');
    let canPrice = false;
    adapters[0].quote = vi.fn(async (ctx) => {
      report(ctx, canPrice ? { reason: 'books empty', msg: 'Test Venue quotes unavailable — books empty' } : undefined);
      return [];
    });
    const window = () => source.notes.list()
      .filter((n: StateNote) => n.venue === 'venue' && n.code.startsWith('venue.quote.')).map((n: StateNote) => n.msg);
    let block = 400n;
    try {
      for (let i = 0; i <= QUOTE_DARK_CYCLES; i++) await poll(block++);
      expect(source.quoteDark.has('venue')).toBe(true);
      expect(source.getQuotes().frame.missingVenues).toContain('venue');
      canPrice = true;
      await poll(block++);
      expect(source.quoteDark.has('venue')).toBe(false);
      expect(source.getQuotes().frame.missingVenues).not.toContain('venue');
      expect(window()).toEqual(['Test Venue quotes unavailable — books empty']);
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

  it('takes a markout curve once from the ring, persists it with the snapshot and never streams it', async () => {
    const { source } = await setup();
    const now = Date.now();
    const fill = (id: string, ts: number): Fill => ({
      id, ts, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'DIRECT', usd: 100, baseAmount: 100,
      execPx: 1, blockNumber: 1, txHash: '0x1', to: 'direct', pool: 'pool', markoutsBps: [null, null, null, null, null],
    });
    // covered: every point lands on a ring sample. gapped: a one-second feed gap swallows its −5s point.
    const covered = fill('covered', now - 35_000), late = fill('gapped', now - 18_000);
    source.pending = new Set([covered, late]);
    source.midHist.set('MON/USDC', Array.from({ length: 451 }, (_, i) => ({ t: now - 40_000 + i * 100, mid: 2 }))
      .filter((s) => s.t >= now - 40_000 && !(s.t > now - 23_000 && s.t < now - 22_000)));
    const frames: Fill[] = [];
    source.on('message', (m: { ch: string; data: Fill }) => { if (m.ch === 'fill') frames.push(m.data); });
    const persistSnapshot = vi.spyOn(source.store, 'persistSnapshot').mockImplementation(() => ({ unmatchedCurves: [] }));
    try {
      await source.ageMarkouts();
      await source.ageMarkouts(); // taken once: a second pass never re-derives it
      expect([...source.dirtyCurves.keys()]).toEqual(['covered']);
      expect(source.dirtyCurves.get('covered')).toEqual(Array(CURVE_OFFSETS_S.length).fill(10_000));
      expect(frames.every((f) => !('curveBps' in f))).toBe(true);
      await source.persist();
      expect(persistSnapshot.mock.calls[0][3]).toEqual([{ id: 'covered', curveBps: Array(CURVE_OFFSETS_S.length).fill(10_000) }]);
      expect(source.dirtyCurves.size).toBe(0);
    } finally { source.store.close(); }
  });

  it('still takes the curve of a fill that lands after its last horizon, never its legacy markouts', async () => {
    const { source } = await setup();
    source.knownVenueIds = new Set(['test-venue']);
    const now = Date.now();
    const fill = (id: string, ts: number): Fill => ({
      id, ts, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'DIRECT', usd: 100, baseAmount: 100,
      execPx: 1, blockNumber: 1, txHash: `0x${id}`, to: 'direct', pool: 'pool', markoutsBps: [null, null, null, null, null],
    });
    // a tail stall: both land with every 0–60s horizon elapsed. The ring still
    // reaches 'late's −5s point; 'stale' predates it and is never queued.
    const late = fill('late', now - 90_000), stale = fill('stale', now - 118_000);
    source.midHist.set('MON/USDC', Array.from({ length: 1_200 }, (_, i) => ({ t: now - 119_900 + i * 100, mid: 2 })));
    const frames: Fill[] = [];
    source.on('message', (m: { ch: string; data: Fill }) => { if (m.ch === 'fill') frames.push(m.data); });
    try {
      source.ingest(late);
      source.ingest(stale);
      expect([...source.pending]).toEqual([late]);
      await source.ageMarkouts();
      expect([...source.dirtyCurves.keys()]).toEqual(['late']);
      expect(source.dirtyCurves.get('late')).toEqual(Array(CURVE_OFFSETS_S.length).fill(10_000));
      // the legacy horizons stay as an unqueued late fill's: null, never re-emitted
      expect(late.markoutsBps).toEqual([null, null, null, null, null]);
      expect(frames.map((f) => f.id)).toEqual(['late', 'stale']);
      expect(source.pending.size).toBe(0);
    } finally { source.store.close(); }
  });

  it('a fill reset drops cached aggregates and keeps a pre-reset pass from caching its result', async () => {
    const { source } = await setup();
    const resolvers: Array<(r: unknown) => void> = [];
    const computeCurves = vi.fn(() => new Promise((r) => resolvers.push(r)));
    const compute = vi.fn(async () => ({ stale: false }));
    source.analyticsWorker = { computeCurves, compute, close: vi.fn(async () => {}) };
    try {
      await source.leaderboard(7);
      const before = source.markoutCurves(7);         // a pass over the pre-reset rows
      source.dropAggregates();                         // fills deleted meanwhile
      const after = source.markoutCurves(7);          // not handed the pre-reset pass
      expect(computeCurves).toHaveBeenCalledTimes(2);
      resolvers[0]({ stale: true }); resolvers[1]({ stale: false });
      expect(await before).toEqual({ stale: true });
      expect(await after).toEqual({ stale: false });
      expect(await source.markoutCurves(7)).toEqual({ stale: false }); // cached: the post-reset result
      expect(computeCurves).toHaveBeenCalledTimes(2);
      await source.leaderboard(7);
      expect(compute).toHaveBeenCalledTimes(2);        // leaderboard cache dropped too
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

  it('a capped boot prune that stops mid-day never lets swap reconciliation rewrite that expired day', async () => {
    const { source } = await setup();
    const { retentionCutoffMs, PRUNE_BATCH_ROWS } = await import('../db.js');
    const { config } = await import('../config.js');
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const cutoff = retentionCutoffMs(Date.now(), config.fillsRetentionDays);
    const expiredTs = cutoff - 12 * 3_600_000; // midday of the last expired day
    const retainedTs = cutoff + 36 * 3_600_000; // well inside retention
    const expiredCount = (config.pruneBootMaxBatches + 2) * PRUNE_BATCH_ROWS; // more than the boot cap drains
    const mk = (i: number, ts: number): Fill => ({
      id: `test-venue-0x${i.toString(16)}-0`, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'ROUTER',
      usd: 1, baseAmount: 1, execPx: 1, txHash: '0x1', to: 'x', pool: 'p', blockNumber: i, ts, markoutsBps: [null, null, null, null, null],
    });
    source.store.persistSnapshot([
      { utcDay: day(expiredTs), partial: false, byVenue: { 'test-venue': { usd: 1, swaps: expiredCount } } },
      { utcDay: day(retainedTs), partial: false, byVenue: { 'test-venue': { usd: 1, swaps: 0 } } },
    ], { 'mkfill_done_test-venue': '1' }, [
      ...Array.from({ length: expiredCount }, (_, i) => mk(i, expiredTs + i)),
      mk(expiredCount, retainedTs), mk(expiredCount + 1, retainedTs + 1), mk(expiredCount + 2, retainedTs + 2),
    ]);
    // the capped boot prune: stops with part of the expired day still on disk
    expect(source.store.pruneFillsBefore(cutoff, config.pruneBootMaxBatches).done).toBe(false);
    source.days = source.store.all();
    source.reconcileSwapCounts();
    const swaps = (d: string) => source.days.find((x: any) => x.utcDay === d)?.byVenue['test-venue']?.swaps;
    expect(swaps(day(expiredTs))).toBe(expiredCount); // persisted total kept, not the 2k remainder
    expect(swaps(day(retainedTs))).toBe(3);           // retained days still reconcile from fills
    source.store.close();
  });

  // Fills booked a day early: both counts and USD are off on two closed days.
  // The reconcile repairs only the counts, so the rewrite itself must be loud.
  // A day it cannot judge yet (fills incomplete, or a pending stage will re-SET
  // it) is left exactly as stored, so the evidence survives to a boot that can.
  // Day 1 holds fills at blocks 0–3, day 2 at 10–17; `drift` = the days
  // rewritten and warned, every other day must be untouched.
  const SETTLED = { 'mkfill_done_test-venue': '1', 'backfill_done_test-venue': '1' };
  it.each([
    { name: 'settled history', meta: SETTLED, drift: [0, 1] },
    { name: 'fills onboarding unfinished', meta: { 'backfill_done_test-venue': '1' }, drift: [] },
    { name: 'fills never onboarded, MARKOUT_BACKFILL off', meta: { 'backfill_done_test-venue': '1' }, markoutBackfill: 'off' as const, drift: [] },
    { name: 'a lifetime reset queued', meta: SETTLED, reset: () => 'test-venue', drift: [] },
    { name: 'a reset queued from the later day', meta: SETTLED, reset: (d: string[]) => `test-venue:${d[1]}`, drift: [0] },
    { name: 'a reset queued from today', meta: SETTLED, reset: (d: string[]) => `test-venue:${d[2]}`, drift: [0, 1] },
    { name: 'a volume replay checkpointed between the days', meta: { 'mkfill_done_test-venue': '1', 'backfill_cursor_test-venue': '10' }, drift: [0] },
    { name: 'a fills revision over the later day', meta: SETTLED, drift: [0],
      revision: (d: string[]) => ({ id: 'r', source: 'fills' as const, from: d[1], until: d[2] }) },
  ])('swap reconcile rewrites and reports only the closed days it can judge — $name', async ({ meta, reset, revision, markoutBackfill, drift: rewritten }) => {
    const drift: readonly number[] = rewritten;
    const DAY = 86_400_000;
    const now = Date.now();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const noon = (ms: number) => ms - (ms % DAY) + DAY / 2;
    const d1 = noon(now - 2 * DAY), d2 = noon(now - DAY);
    const days = [day(d1), day(d2), day(now)];
    const { source, adapter } = await setup({ withAdapter: true, reset: reset?.(days), markoutBackfill });
    // the volume replay is what re-SETs day rows for a chain reset
    Object.assign(adapter, { backfillFromUtc: '2026-01-01', historyRevisions: revision ? [revision(days)] : [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mk = (i: number, ts: number): Fill => ({
      id: `test-venue-0x${i.toString(16)}-0`, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'ROUTER',
      usd: 100, baseAmount: 1, execPx: 1, txHash: '0x1', to: 'x', pool: 'p', blockNumber: i, ts, markoutsBps: [null, null, null, null, null],
    });
    source.store.persistSnapshot([
      { utcDay: day(d1), partial: false, byVenue: { 'test-venue': { usd: 500, swaps: 5 } } },
      { utcDay: day(d2), partial: false, byVenue: { 'test-venue': { usd: 700, swaps: 7 } } },
    ], meta, [
      ...Array.from({ length: 4 }, (_, i) => mk(i, d1 + i)),
      ...Array.from({ length: 8 }, (_, i) => mk(10 + i, d2 + i)),
    ]);
    source.days = source.store.all();
    const swapNotes = () => source.notes.list().filter((n: StateNote) => n.code.startsWith('store.swaps.'));

    source.reconcileSwapCounts();
    const rewrites = [`${day(d1)} 5→4`, `${day(d2)} 7→8`];
    if (!drift.length) expect(swapNotes()).toEqual([]);
    else {
      expect(swapNotes()).toEqual([expect.objectContaining({ code: 'store.swaps.drift', level: 'warn', venue: 'test-venue' })]);
      const { msg } = swapNotes()[0];
      expect(msg).toContain(`${drift.length} closed day(s)`);
      expect(msg).toMatch(/USD was not: those days' USD may be misbucketed/);
      rewrites.forEach((r, i) => (drift.includes(i) ? expect(msg).toContain(r) : expect(msg).not.toContain(r)));
    }
    const row = (ms: number) => source.days.find((x: any) => x.utcDay === day(ms))?.byVenue['test-venue'];
    expect([row(d1), row(d2)]).toEqual([
      { usd: 500, swaps: drift.includes(0) ? 4 : 5 },   // counts fixed, USD not — or left as stored
      { usd: 700, swaps: drift.includes(1) ? 8 : 7 },
    ]);

    // the next boot sees consistent counts — which is exactly why this boot had to say it
    const raised = swapNotes().length;
    source.reconcileSwapCounts();
    expect(swapNotes()).toHaveLength(raised);
    source.store.close();
  });

  // A queued revision is not a repair until it applies: applyFillsRevision can
  // refuse one (window past retention) or hold it (totals not conserved). The
  // day it would have rebuilt was left as stored, so once the revision is
  // settled without rebuilding it, the next boot still has the evidence.
  it('a day held for a queued revision that is then refused is still reported', async () => {
    const { source, adapter } = await setup({ withAdapter: true });
    const { revisionTargets, resetMarker } = await import('../datasource/live.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const DAY = 86_400_000;
    const now = Date.now();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const d1 = now - 2 * DAY - ((now - 2 * DAY) % DAY) + DAY / 2;
    const revision = { id: 'r', source: 'fills' as const, from: day(d1), until: day(now) };
    Object.assign(adapter, { backfillFromUtc: '2026-01-01', historyRevisions: [revision] });
    const mk = (i: number): Fill => ({
      id: `test-venue-0x${i.toString(16)}-0`, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'ROUTER',
      usd: 100, baseAmount: 1, execPx: 1, txHash: '0x1', to: 'x', pool: 'p', blockNumber: i, ts: d1 + i, markoutsBps: [null, null, null, null, null],
    });
    source.store.persistSnapshot([{ utcDay: day(d1), partial: false, byVenue: { 'test-venue': { usd: 500, swaps: 5 } } }],
      SETTLED, [mk(0), mk(1), mk(2), mk(3)]);
    source.days = source.store.all();
    const swapNotes = () => source.notes.list().filter((n: StateNote) => n.code.startsWith('store.swaps.'));
    const swaps = () => source.days.find((x: any) => x.utcDay === day(d1))?.byVenue['test-venue']?.swaps;

    source.reconcileSwapCounts();
    expect(swaps()).toBe(5);              // left for the revision
    expect(swapNotes()).toEqual([]);

    // refused: stamped as settled, and nothing rebuilt
    const [target] = revisionTargets('test-venue', [revision]);
    source.store.persistSnapshot([], { [resetMarker(target)]: target.spec }, []);
    source.reconcileSwapCounts();
    expect(swaps()).toBe(4);
    expect(swapNotes()).toEqual([expect.objectContaining({ code: 'store.swaps.drift', level: 'warn' })]);
    expect(swapNotes()[0].msg).toContain(`${day(d1)} 5→4`);
    source.store.close();
  });

  // A 'markets' revision ADDS a newly listed market's history (live.ts
  // applyMarketsRevision): the blocks an older build decoded, below `b0`,
  // where this build's tail began. It must leave every other market's row
  // alone, count a fill the onboarding stored but never added, leave the days
  // a volume replay or reset re-SETs to them, and keep rows and fills
  // consistent for the boot reconcile.
  async function marketsRevisionScene(meta: Record<string, string>, opts: {
    b0?: number; replay?: string; setup?: { reset?: (d2: string) => string; backfill?: 'on' | 'off'; markoutBackfill?: 'on' | 'off' };
  } = {}) {
    vi.stubEnv('BACKFILL_PACE_MS', '0');
    vi.stubEnv('BACKFILL_CHUNK', '500');
    vi.stubEnv('BACKFILL_MERGE_EVERY', '1');
    const DAY = 86_400_000;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const now = Date.now();
    const d1 = Date.parse(`${day(now - 2 * DAY)}T00:00:00Z`), d2 = d1 + DAY;
    const { source, adapter } = await setup({
      withAdapter: true, reset: opts.setup?.reset?.(day(d2)), backfill: opts.setup?.backfill, markoutBackfill: opts.setup?.markoutBackfill,
    });
    const rpc = await import('../chain/rpc.js') as any;
    const live = await import('../datasource/live.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 1,000 blocks a UTC day, block 1,000 = d1's midnight
    const tsOfBlock = (b: number) => d1 + (b - 1_000) * (DAY / 1_000);
    const blockAt = (ms: number) => 1_000 + Math.ceil((ms - d1) / (DAY / 1_000));
    const closedEnd = BigInt(blockAt(d2 + DAY) - 1);
    source.deepEnd = closedEnd + 1n;
    source.bootHead = closedEnd + 10_000n;
    const logs = [
      { id: 'x1', market: 'XAUt/USDC', usd: 100, blockNumber: 1_200n },
      { id: 'm1', market: 'MON/USDC', usd: 999, blockNumber: 1_300n },
      { id: 'x2', market: 'XAUt/USDC', usd: 40, blockNumber: 2_100n },
      { id: 'm2', market: 'MON/USDC', usd: 500, blockNumber: 2_400n },
      { id: 'x3', market: 'XAUt/USDC', usd: 60, blockNumber: 2_700n },   // past b0: this build's tail counted it
    ];
    const toFill = (l: typeof logs[number], ts: number): Fill => ({
      id: `test-venue-${l.id}`, venueId: 'test-venue', market: l.market, side: 'buy', category: 'UNKNOWN', usd: l.usd, baseAmount: 1,
      execPx: l.usd, txHash: '0x1', to: 'x', pool: 'p', blockNumber: Number(l.blockNumber), ts, markoutsBps: [null, null, null, null, null],
    });
    rpc.archiveClient.getLogs = vi.fn(async ({ fromBlock, toBlock }: any) => logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock));
    rpc.archiveClient.getBlock = vi.fn(async ({ blockNumber }: any) => ({ timestamp: BigInt(Math.floor(tsOfBlock(Number(blockNumber)) / 1_000)) }));
    rpc.blockAtOrAfter.mockImplementation(async (sec: number, hi: bigint) => { const b = BigInt(blockAt(sec * 1_000)); return b > hi ? hi : b; });
    const revision = { id: 'm', source: 'markets' as const, from: day(d1), markets: ['XAUt/USDC'] };
    Object.assign(adapter, {
      backfillFromUtc: '2026-01-01',
      historyRevisions: [revision],
      logSources: () => [{ key: 'swaps', address: '0x0000000000000000000000000000000000000001', events: [], kind: 'fills' }],
      decode: vi.fn(async (_ctx: unknown, bundle: any, tsOf: (bn: bigint) => number) => bundle.swaps.map((l: any) => toFill(l, tsOf(l.blockNumber)))),
    });
    const [target] = live.revisionTargets('test-venue', [revision]);
    const marker = live.resetMarker(target);
    const keys = live.marketsRevisionKeys(marker);
    // what older builds stored: no XAUt in any row; the onboarding stored x1
    // (a fill, never a day), and this build's tail stored and counted x3
    source.store.persistSnapshot([
      { utcDay: day(d1), partial: false, byVenue: { 'test-venue': { usd: 999, swaps: 1 } } },
      { utcDay: day(d2), partial: false, byVenue: { 'test-venue': { usd: 560, swaps: 2 } } },
    ], {
      ...meta,
      [keys.b0]: String(opts.b0 ?? 2_500),
      ...(opts.replay ? { [keys.replay]: opts.replay } : {}),
    }, [toFill(logs[0], tsOfBlock(1_200)), toFill(logs[1], tsOfBlock(1_300)), toFill(logs[3], tsOfBlock(2_400)), toFill(logs[4], tsOfBlock(2_700))]);
    source.days = source.store.all();
    // no live tail runs here: a gate runs at once, as between two tail cycles
    source.inTail = vi.fn((fn: () => Promise<unknown>) => fn());
    const persist = vi.spyOn(source, 'persist');
    const emits = vi.spyOn(source, 'emitMsg');
    const storedRow = (ms: number) => source.store.all().find((x: any) => x.utcDay === day(ms))?.byVenue['test-venue'];
    const row = (ms: number) => source.days.find((x: any) => x.utcDay === day(ms))?.byVenue['test-venue'];
    const swapNotes = () => source.notes.list().filter((n: StateNote) => n.code.startsWith('store.swaps.'));
    const remarkCursor = 'mkhist_cursor_test-venue_XAUt/USDC';
    const resyncs = () => emits.mock.calls.filter(([m]: any) => m.ch === 'volume' && m.resync).length;
    const fillIds = () => source.store.fillsByIds(['test-venue-x1', 'test-venue-x2', 'test-venue-x3']).map((f: Fill) => f.id).sort();
    return { source, rpc, live, target, marker, keys, storedRow, row, swapNotes, d1, d2, now, closedEnd, day, persist, remarkCursor, resyncs, fillIds };
  }
  it("a 'markets' revision adds the listed market's older-build fills — a stored one too — and stamps", async () => {
    // a markout sweep already walked the market through d2
    const s = await marketsRevisionScene({ ...SETTLED, 'mkhist_cursor_test-venue_XAUt/USDC': '2099-01-01' });
    const { source, rpc, live, target, keys, d1, d2, now, closedEnd } = s;

    // the boot reconcile runs first: x1 is stored but not yet in d1's count,
    // and the revision is what adds it — rewritten here, it would count twice
    source.reconcileSwapCounts();
    expect(s.row(d1)).toEqual({ usd: 999, swaps: 1 });
    expect(s.swapNotes()).toEqual([]);

    // a sweep holds the remark lock: the cursor rewind must wait for it, or the
    // sweep would write its own later cursor over the rewind
    source.remarkRunning = true;
    const applied = source.applyBackfillReset(now, closedEnd);
    await vi.waitFor(() => expect(source.store.getMeta(keys.remark)).toBe('1'));   // inserted, rewind owed
    expect(source.store.getMeta(s.remarkCursor)).toBe('2099-01-01');               // ...and held back
    source.remarkRunning = false;
    await applied;

    // x1 → d1 (the onboarding had stored it, never counted it) and x2 → d2; x3
    // is past b0, MON untouched; x1's row is not duplicated
    expect([s.storedRow(d1), s.storedRow(d2)]).toEqual([{ usd: 1_099, swaps: 2 }, { usd: 600, swaps: 3 }]);
    expect(s.fillIds()).toEqual(['test-venue-x1', 'test-venue-x2', 'test-venue-x3']);
    // real timestamps only for the kept fills' blocks, which stop below b0
    expect(rpc.archiveClient.getBlock.mock.calls.map(([a]: any) => Number(a.blockNumber)).sort()).toEqual([1_200, 2_100]);
    // each flush took the tail gate and flushed the tail first
    expect(source.inTail).toHaveBeenCalled();
    expect(s.persist).toHaveBeenCalledWith(true);
    expect(source.store.getMeta(s.remarkCursor)).toBe(s.day(d1));
    expect(s.resyncs()).toBe(1);
    expect(live.resetAlreadyApplied(source.store, target)).toBe(true);
    expect(source.notes.list().some((n: StateNote) => n.code === 'backfill.reset' && n.msg.includes('added 2 XAUt/USDC fill(s), $140.00'))).toBe(true);
    // rows and fills agree, so the boot reconcile has nothing to rewrite
    source.reconcileSwapCounts();
    expect(source.notes.list().filter((n: StateNote) => n.code.startsWith('store.swaps.'))).toEqual([]);
    // applied once
    rpc.archiveClient.getLogs.mockClear();
    await source.applyBackfillReset(now, closedEnd);
    expect(rpc.archiveClient.getLogs).not.toHaveBeenCalled();
    source.store.close();
  });

  /** a later range failing after earlier batches committed: those days are
   *  final, so open Volume tabs still reload them and the markout cursor is
   *  still rewound — the retry, finding them already added, would do neither */
  it("a 'markets' revision that fails part-way still resyncs and rewinds what it committed, and its retry adds the rest once", async () => {
    const s = await marketsRevisionScene({ ...SETTLED, 'mkhist_cursor_test-venue_XAUt/USDC': '2099-01-01' });
    const { source, live, target, keys, d1, d2, now, closedEnd } = s;
    const adapter = (await import('../venues/registry.js')).ADAPTERS[0] as any;
    const decode = adapter.decode.getMockImplementation();
    adapter.decode.mockImplementation(async (ctx: unknown, bundle: any, tsOf: any) => {
      if (bundle.swaps.some((l: any) => l.blockNumber >= 2_000n)) throw new Error('price leg still warming');
      return decode(ctx, bundle, tsOf);
    });
    await expect(source.applyBackfillReset(now, closedEnd)).rejects.toThrow('price leg still warming');
    expect(s.storedRow(d1)).toEqual({ usd: 1_099, swaps: 2 });     // x1 committed
    expect(s.storedRow(d2)).toEqual({ usd: 560, swaps: 2 });       // nothing yet
    expect(s.resyncs()).toBe(1);
    // x1's row was the onboarding's: nothing inserted, so no rewind is owed yet
    expect(source.store.getMeta(keys.remark)).toBeUndefined();
    expect(source.store.getMeta(s.remarkCursor)).toBe('2099-01-01');

    adapter.decode.mockImplementation(decode);
    await source.applyBackfillReset(now, closedEnd);
    expect([s.storedRow(d1), s.storedRow(d2)]).toEqual([{ usd: 1_099, swaps: 2 }, { usd: 600, swaps: 3 }]);
    expect(live.resetAlreadyApplied(source.store, target)).toBe(true);
    // x2 was inserted: its markouts are walked from the revision's start
    expect(source.store.getMeta(s.remarkCursor)).toBe(s.day(d1));
    expect(source.store.getMeta(keys.remark)).toBe('');
    source.store.close();
  });

  /** a replay this build inherited unfinished re-SETs, with this build, the
   *  days from where it resumed: the revision adds what lies outside it. Done
   *  before the deploy day closed, the replay stops at that day's midnight —
   *  so the day's older-build hours are the revision's, or nobody's */
  it.each([
    { name: 'stops before the deploy day closed', end: '2000', d1Row: { usd: 999, swaps: 1 }, d2Row: { usd: 600, swaps: 3 } },
    { name: 'runs past its midnight', end: '3000', d1Row: { usd: 999, swaps: 1 }, d2Row: { usd: 560, swaps: 2 } },
  ])("a 'markets' revision waits for an inherited replay, then adds what it left — a replay that $name", async ({ end, d1Row, d2Row }) => {
    // the replay resumed on d1 (its cursor was in d1) when this build first booted
    const s = await marketsRevisionScene({ 'mkfill_done_test-venue': '1', 'backfill_cursor_test-venue': '1500' }, { replay: '1500' });
    const { source, rpc, live, target, d1, d2, now, closedEnd } = s;
    await source.applyBackfillReset(now, closedEnd);
    expect(rpc.archiveClient.getLogs).not.toHaveBeenCalled();       // nothing lies before the replay
    expect(live.resetAlreadyApplied(source.store, target)).toBe(false);

    // the replay finishes (its rows are this build's, XAUt included — not modelled here)
    source.store.persistSnapshot([], { 'backfill_done_test-venue': '1', 'backfill_cursor_test-venue': end }, []);
    await source.applyBackfillReset(now, closedEnd);
    expect([s.storedRow(d1), s.storedRow(d2)]).toEqual([d1Row, d2Row]);
    expect(live.resetAlreadyApplied(source.store, target)).toBe(true);
    source.store.close();
  });

  /** a fresh database: the replay has not run, and decodes the market with
   *  this build when it does — through the tail's first block, here */
  it("a 'markets' revision on a database whose replay never ran waits, then adds nothing the replay covered", async () => {
    const s = await marketsRevisionScene({}, { replay: 'start' });
    const { source, rpc, live, target, d1, d2, now, closedEnd } = s;
    await source.applyBackfillReset(now, closedEnd);
    expect(live.resetAlreadyApplied(source.store, target)).toBe(false);
    source.store.persistSnapshot([], { 'backfill_done_test-venue': '1', 'backfill_cursor_test-venue': '3000', 'mkfill_done_test-venue': '1' }, []);
    await source.applyBackfillReset(now, closedEnd);
    expect(rpc.archiveClient.getLogs).not.toHaveBeenCalled();
    expect(live.resetAlreadyApplied(source.store, target)).toBe(true);
    expect([s.storedRow(d1), s.storedRow(d2)]).toEqual([{ usd: 999, swaps: 1 }, { usd: 560, swaps: 2 }]);
    source.store.close();
  });

  /** a chain reset (or today re-read) of the venue hands its blocks to this
   *  build before the revision reaches them: the revision stops there */
  it("a 'markets' revision stops where a later reset of the venue begins", async () => {
    const s = await marketsRevisionScene(SETTLED);
    const { source, d1, d2, now, closedEnd } = s;
    await source.ownMarketsFrom('test-venue', s.day(d2));
    await source.ownMarketsFrom('test-venue', s.day(d2 + 86_400_000));   // a later day never widens it back
    await source.applyBackfillReset(now, closedEnd);
    expect([s.storedRow(d1), s.storedRow(d2)]).toEqual([{ usd: 1_099, swaps: 2 }, { usd: 560, swaps: 2 }]);
    source.store.close();
  });

  /** a boot with a history stage off defers the revision; the reconcile must
   *  hold its days all the same */
  it("the boot reconcile holds a deferred 'markets' revision's days", async () => {
    const s = await marketsRevisionScene(SETTLED, { setup: { markoutBackfill: 'off' } });
    s.source.reconcileSwapCounts();
    expect([s.row(s.d1), s.row(s.d2)]).toEqual([{ usd: 999, swaps: 1 }, { usd: 560, swaps: 2 }]);
    expect(s.swapNotes()).toEqual([]);
    s.source.store.close();
  });

  /** an operator reset hands its replayed days to this build only if it
   *  rebuilds volume; with BACKFILL off it keeps every closed row, and only
   *  today (its re-read) changes hands */
  it.each([
    { backfill: 'on' as const, owned: 'd2' },
    { backfill: 'off' as const, owned: 'today' },
  ])("an operator reset with BACKFILL=$backfill hands the 'markets' revision's blocks from $owned", async ({ backfill, owned }) => {
    const s = await marketsRevisionScene(SETTLED, { setup: { reset: (d2) => `test-venue:${d2}`, backfill } });
    await s.source.applyBackfillReset(s.now, s.closedEnd);
    expect(s.source.store.getMeta(s.keys.owned)).toBe(owned === 'd2' ? s.day(s.d2) : s.day(s.now));
    s.source.store.close();
  });

  /** b0 is recorded once, on the first boot that declares the revision —
   *  whatever stages are on — with the replay it inherits */
  it("records a 'markets' revision's first tail block and inherited replay once", async () => {
    const { source, adapter } = await setup({ withAdapter: true });
    const live = await import('../datasource/live.js');
    const revision = { id: 'm', source: 'markets' as const, from: '2026-10-01', markets: ['XAUt/USDC'] };
    Object.assign(adapter, { backfillFromUtc: '2026-01-01', historyRevisions: [revision] });
    const keys = live.marketsRevisionKeys(live.resetMarker(live.revisionTargets('test-venue', [revision])[0]));
    source.store.persistSnapshot([], { 'backfill_cursor_test-venue': '777' }, []);
    source.recordMarketsRevisionStarts(5_000n);
    source.recordMarketsRevisionStarts(9_000n);
    expect([source.store.getMeta(keys.b0), source.store.getMeta(keys.replay)]).toEqual(['5000', '777']);
    expect(source.store.getMeta(keys.owned)).toBeUndefined();
    // a today re-read a previous run left pending resumes from midnight with
    // this build: today is its — without moving an earlier claim
    const today = new Date().toISOString().slice(0, 10);
    source.store.persistSnapshot([], { 'reread_day_test-venue': today }, []);
    source.recordMarketsRevisionStarts(9_000n);
    expect(source.store.getMeta(keys.owned)).toBe(today);
    source.store.persistSnapshot([], { [keys.owned]: '2026-01-02' }, []);
    source.recordMarketsRevisionStarts(9_000n);
    expect(source.store.getMeta(keys.owned)).toBe('2026-01-02');
    source.store.close();
  });

  // The longest note this can raise: eight 4-digit rewrites behind the drift
  // sentence. The note as STORED must still carry its day count and net, and
  // end on a whole entry — scrubNote cuts anything past NOTE_MSG_MAX mid-word.
  it('a long swap note keeps its net and whole entries inside the note cap', async () => {
    const { NOTE_MSG_MAX } = await import('../notes.js');
    const { source, adapter } = await setup({ withAdapter: true });
    Object.assign(adapter, { backfillFromUtc: '2026-01-01' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const DAY = 86_400_000;
    const now = Date.now();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const noons = Array.from({ length: 8 }, (_, k) => now - (k + 2) * DAY - ((now - (k + 2) * DAY) % DAY) + DAY / 2);
    source.store.persistSnapshot(
      noons.map((ms) => ({ utcDay: day(ms), partial: false, byVenue: { 'test-venue': { usd: 1, swaps: 1_999 } } })),
      SETTLED,
      noons.flatMap((ms, k) => Array.from({ length: 1_000 }, (_, i): Fill => ({
        id: `test-venue-0x${(k * 1_000 + i).toString(16)}-0`, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'ROUTER',
        usd: 1, baseAmount: 1, execPx: 1, txHash: '0x1', to: 'x', pool: 'p', blockNumber: k * 1_000 + i, ts: ms + i,
        markoutsBps: [null, null, null, null, null],
      }))),
    );
    source.days = source.store.all();
    source.reconcileSwapCounts();

    const notes = source.notes.list().filter((n: StateNote) => n.code.startsWith('store.swaps.'));
    expect(notes.map((n: StateNote) => n.code)).toEqual(['store.swaps.drift']);
    const { msg } = notes[0];
    expect(msg.length).toBeLessThanOrEqual(NOTE_MSG_MAX);
    expect(msg).not.toMatch(/…$/);                                   // scrubNote never had to cut it
    expect(msg).toContain('8 closed day(s), net -7992');
    const listed = msg.match(/\d{4}-\d{2}-\d{2} 1999→1000/g) ?? [];
    const more = Number(msg.match(/\+(\d+) more$/)?.[1] ?? 0);
    expect(more).toBeGreaterThan(0);                                  // the budget, not the count, cut the list
    expect(listed[0]).toBe(`${day(noons[7])} 1999→1000`);              // oldest first
    expect(listed.length + more).toBe(8);                             // every day listed or counted
    source.store.close();
  });

  // A day left alone while fills onboarding runs keeps its evidence: the boot
  // after onboarding finishes compares it against whole fills, and warns.
  // Rewriting it from partial fills would have erased that for good, since
  // onboarding writes no day row.
  it('a mismatch held back during fills onboarding is reported once the fills are whole', async () => {
    const { source } = await setup({ withAdapter: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const DAY = 86_400_000;
    const now = Date.now();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const d1 = now - 2 * DAY - ((now - 2 * DAY) % DAY) + DAY / 2;
    const mk = (i: number): Fill => ({
      id: `test-venue-0x${i.toString(16)}-0`, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'ROUTER',
      usd: 100, baseAmount: 1, execPx: 1, txHash: '0x1', to: 'x', pool: 'p', blockNumber: i, ts: d1 + i, markoutsBps: [null, null, null, null, null],
    });
    // onboarding stopped at block 2: blocks 0–1 scanned, the rest of the day not yet
    source.store.persistSnapshot([{ utcDay: day(d1), partial: false, byVenue: { 'test-venue': { usd: 500, swaps: 5 } } }],
      { 'mkfill_cursor_test-venue': '2' }, [mk(0), mk(1)]);
    source.days = source.store.all();
    const swapNotes = () => source.notes.list().filter((n: StateNote) => n.code.startsWith('store.swaps.'));
    const swaps = () => source.days.find((x: any) => x.utcDay === day(d1))?.byVenue['test-venue']?.swaps;

    source.reconcileSwapCounts();
    expect(swaps()).toBe(5);              // not lowered to the 2 fills scanned so far
    expect(swapNotes()).toEqual([]);

    // onboarding finishes: the day's 4 fills are whole, and 5 was never right
    source.store.persistSnapshot([], { 'mkfill_done_test-venue': '1' }, [mk(2), mk(3)]);
    source.reconcileSwapCounts();
    expect(swaps()).toBe(4);
    expect(swapNotes()).toEqual([expect.objectContaining({ code: 'store.swaps.drift', level: 'warn' })]);
    expect(swapNotes()[0].msg).toContain(`${day(d1)} 5→4`);
    source.store.close();
  });

  it('drains a retention backlog on the WRITER in sweeps, then VACUUMs once there — never on the main thread', async () => {
    vi.useFakeTimers();
    const { source } = await setup();
    const mainPrune = vi.spyOn(source.store, 'pruneFillsBefore');
    const mainVacuum = vi.spyOn(source.store, 'vacuumIfRoom');
    const sweeps = [{ removed: 50_000, done: false }, { removed: 50_000, done: false }, { removed: 12, done: true }];
    const writer = {
      pruneFills: vi.fn(async () => sweeps.shift()!),
      vacuumIfRoom: vi.fn(async () => ({ plan: 'defer' as const, freeBytes: 0, liveBytes: 0, availBytes: 0, ms: 0 })),
    };
    source.storeWriter = writer;
    source.kickMaintenance();
    await vi.runAllTimersAsync();
    expect(writer.pruneFills).toHaveBeenCalledTimes(3);
    expect(writer.vacuumIfRoom).toHaveBeenCalledTimes(1);
    expect(mainPrune).not.toHaveBeenCalled();
    expect(mainVacuum).not.toHaveBeenCalled();
    // a second kick (e.g. the 10-min timer) sweeps again but never re-VACUUMs
    sweeps.push({ removed: 0, done: true });
    source.kickMaintenance();
    await vi.runAllTimersAsync();
    expect(writer.vacuumIfRoom).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    source.store.close();
  });

  it('a sweep blocked by a reader stops without VACUUM; the timer tick that drains it still VACUUMs', async () => {
    vi.useFakeTimers();
    const { source } = await setup();
    const sweeps: Array<{ removed: number; done: boolean; blocked?: true }> = [{ removed: 1_000, done: false, blocked: true }];
    const writer = {
      pruneFills: vi.fn(async () => sweeps.shift()!),
      vacuumIfRoom: vi.fn(async () => ({ plan: 'defer' as const, freeBytes: 0, liveBytes: 0, availBytes: 0, ms: 0 })),
    };
    source.storeWriter = writer;
    source.kickMaintenance(); // boot: pinned → stops at once, no retry spin
    await vi.runAllTimersAsync();
    expect(writer.pruneFills).toHaveBeenCalledTimes(1);
    expect(writer.vacuumIfRoom).not.toHaveBeenCalled();
    // the retention timer fires (the same entry point) with the reader gone
    source.pruneTimer = setInterval(() => source.kickMaintenance(), 60_000);
    sweeps.push({ removed: 500, done: true });
    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(source.pruneTimer);
    expect(writer.pruneFills).toHaveBeenCalledTimes(2);
    expect(writer.vacuumIfRoom).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    source.store.close();
  });

  it('persists only volume days changed since the prior snapshot', async () => {
    const { source } = await setup();
    const historical = { utcDay: '2026-01-01', partial: false, byVenue: { old: { usd: 1, swaps: 1 } } };
    const changed = { utcDay: '2026-08-25', partial: true, byVenue: { live: { usd: 2, swaps: 2 } } };
    source.days = [historical, changed];
    source.dirtyDays = new Set([changed.utcDay]);
    const persistSnapshot = vi.spyOn(source.store, 'persistSnapshot').mockImplementation(() => ({ unmatchedCurves: [] }));

    await source.persist();

    expect(persistSnapshot).toHaveBeenCalledWith([changed], expect.any(Object), [], []);
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

  describe('curve whose fill row is missing at commit', () => {
    const curve = Array(CURVE_OFFSETS_S.length).fill(7);
    const fill = (id: string, ts: number): Fill => ({
      id, ts, venueId: 'test-venue', market: 'MON/USDC', side: 'buy', category: 'DIRECT', usd: 100, baseAmount: 100,
      execPx: 1, blockNumber: 1, txHash: `0x${id}`, to: 'direct', pool: 'pool', markoutsBps: [null, null, null, null, null],
    });
    const stored = (source: any) => new Map(source.store.curveFillsChunk(0, -1, '', 100).map((r: { id: string; curve: unknown }) => [r.id, r.curve]));

    it('requeues it when an overlapping snapshot commits before the one inserting the fill rolls back', async () => {
      const { source } = await setup();
      source.knownVenueIds = new Set(['test-venue']);
      try {
        source.ingest(fill('f', Date.now() - 120_000));
        vi.spyOn(source.store, 'persistSnapshot').mockImplementationOnce(() => { throw new Error('disk busy'); });
        // A cuts the fill and fails (its requeue runs on a later microtask); B
        // is cut before that, so it carries only the curve and commits first.
        const a = source.persist();
        source.dirtyCurves.set('f', curve);
        const b = source.persist();
        await Promise.all([a, b]);
        expect(stored(source).has('f')).toBe(false);
        expect([...source.dirty].map((f: Fill) => f.id)).toEqual(['f']);
        expect(source.dirtyCurves.get('f')).toEqual(curve);
        // C re-inserts the fill and, after it in the same transaction, its curve
        await source.persist();
        expect(stored(source).get('f')).toEqual(curve);
        expect(source.dirtyCurves.size).toBe(0);
        expect(source.curveMisses.size).toBe(0);
      } finally { source.store.close(); }
    });

    it('drains work restored during the shutdown flush before it resolves', async () => {
      const { source } = await setup();
      source.knownVenueIds = new Set(['test-venue']);
      try {
        source.ingest(fill('f', Date.now() - 120_000));
        const persistSnapshot = vi.spyOn(source.store, 'persistSnapshot')
          .mockImplementationOnce(() => { throw new Error('disk busy'); });
        // A (the fill) is in flight and fails; stop()'s flush B carries only
        // the curve and commits the cursor first. Nothing ticks after B.
        const a = source.persist();
        source.dirtyCurves.set('f', curve);
        const b = source.persist(true);
        await Promise.all([a, b]);
        expect(stored(source).get('f')).toEqual(curve);
        expect(persistSnapshot).toHaveBeenCalledTimes(3);
        expect(source.dirty.size + source.dirtyCurves.size).toBe(0);
      } finally { source.store.close(); }
    });

    it('drops a curve whose fill a venue reset purged, without wedging later snapshots', async () => {
      const { source } = await setup();
      source.knownVenueIds = new Set(['test-venue']);
      const { purgeVenueFills } = await import('../datasource/live.js');
      try {
        source.ingest(fill('old', Date.now() - 3 * 86_400_000));
        await source.persist();
        source.dirtyCurves.set('old', curve);
        const today = new Date().toISOString().slice(0, 10);
        const deletes = { beforeDay: today, fills: { fromDay: '2000-01-01' } };
        expect(await source.storeWriter.resetVenueHistory('test-venue', deletes)).toEqual({ volume: 0, fills: 1 });
        purgeVenueFills(source, 'test-venue', deletes);

        await source.persist();
        expect(source.dirtyCurves.size).toBe(0);
        expect(source.curveMisses.size).toBe(0);
        source.ingest(fill('next', Date.now() - 120_000));
        source.dirtyCurves.set('next', curve);
        await expect(source.persist()).resolves.toBeUndefined();
        expect([...stored(source)]).toEqual([['next', curve]]);
        expect(source.notes.list().some((n: StateNote) => n.code === 'store.persist.failed')).toBe(false);
      } finally { source.store.close(); }
    });

    it('gives up after a bounded number of snapshots when the row never lands under an in-memory fill', async () => {
      const { source } = await setup();
      source.knownVenueIds = new Set(['test-venue']);
      const persistSnapshot = vi.spyOn(source.store, 'persistSnapshot');
      try {
        source.ingest(fill('pruned', Date.now() - 120_000));
        await source.persist();
        // retention deleted the row; the 400-fill ring still holds the fill
        source.store.pruneFillsBefore(Date.now(), 10);
        source.dirtyCurves.set('pruned', curve);
        for (let i = 0; i < 6; i++) await source.persist();
        const carried = persistSnapshot.mock.calls.filter((c: unknown[]) => (c[3] as unknown[] | undefined)?.length).length;
        expect(carried).toBe(1 + source.constructor.CURVE_MAX_RETRIES);
        expect(source.dirtyCurves.size).toBe(0);
        expect(source.curveMisses.size).toBe(0);
      } finally { source.store.close(); }
    });
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
