// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fill, MarketsResponse, QuoteSnapshot } from '@shared';
import * as api from './lib/api';
import { DashboardProvider, useDashboard } from './store';

vi.mock('./lib/api', () => ({
  fetchMarkets: vi.fn(), fetchFills: vi.fn(), fetchLeaderboard: vi.fn(), fetchGas: vi.fn(),
  fetchQuoteHistory: vi.fn(), fetchQuoteStats: vi.fn(), connectDashboardStream: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let dashboard: ReturnType<typeof useDashboard>;
let message: Parameters<typeof api.connectDashboardStream>[1];
let status: Parameters<typeof api.connectDashboardStream>[2];
const fill = (id: string, usd = 100): Fill => ({ id, usd, ts: Date.now(), venueId: 'venue', market: 'MON/USDC', side: 'buy', category: 'DIRECT', baseAmount: 1000, execPx: .1, blockNumber: 1, txHash: '0x1', to: 'direct', pool: 'pool', markoutsBps: [1, null, null, null, null] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Probe() { dashboard = useDashboard(); return null; }
async function mount() { await act(async () => root.render(<DashboardProvider><Probe /></DashboardProvider>)); }
async function reconnect() { await act(async () => { status('reconnecting'); status('live'); }); }

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, '', '/markouts');
  const container = document.createElement('div'); document.body.replaceChildren(container);
  root = createRoot(container);
  const snapshot: MarketsResponse = {
    state: { chainId: 143, block: 1, monUsd: 1, monChangePct: 0, takerBps: 0, markets: ['MON/USDC'], sizesUsd: [1000], quoteCadenceMs: 300, source: 'sim', venues: [] },
    quotes: { block: 1, monUsd: 1, ts: Date.now(), rows: [] }, fills: [], volume: [],
  };
  vi.mocked(api.fetchMarkets).mockResolvedValue(snapshot);
  vi.mocked(api.fetchFills).mockResolvedValue([fill('old')]);
  vi.mocked(api.fetchLeaderboard).mockReturnValue(new Promise(() => {}));
  vi.mocked(api.fetchGas).mockResolvedValue({ days: [], approx: [] });
  vi.mocked(api.fetchQuoteHistory).mockResolvedValue([]);
  vi.mocked(api.fetchQuoteStats).mockImplementation(async (market, sizeUsd) => ({ market, sizeUsd, asOf: Date.now(), windowMs: 300_000, revision: 0, rows: [] }));
  vi.mocked(api.connectDashboardStream).mockImplementation((_topics, receive, change) => {
    message = receive; status = change;
    return () => {};
  });
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); });

describe('state and quote history demand', () => {
  it('rejects cached state older than either bootstrap or the latest streamed state', async () => {
    const bootstrap = await vi.mocked(api.fetchMarkets)(); bootstrap.state.block = 100;
    await mount();
    await act(async () => message({ ch: 'state', data: { ...bootstrap.state, block: 50, monUsd: 99 } }));
    expect(dashboard.state).toMatchObject({ block: 100, monUsd: 1 });
    await act(async () => message({ ch: 'state', data: { ...bootstrap.state, block: 101, monUsd: 2 } }));
    await act(async () => message({ ch: 'state', data: { ...bootstrap.state, block: 100, monUsd: 99 } }));
    expect(dashboard.state).toMatchObject({ block: 101, monUsd: 2 });
  });

  it.each(['markouts', 'volume'] as const)('retries cold %s history without requiring a stream reconnect', async (tab) => {
    vi.useFakeTimers(); window.history.replaceState(null, '', `/${tab}`);
    const snapshot = await vi.mocked(api.fetchMarkets)();
    snapshot.volume = [{ utcDay: '2026-09-16', byVenue: { venue: { usd: 123, swaps: 1 } }, partial: false }];
    vi.mocked(api.fetchMarkets).mockClear().mockRejectedValueOnce(new Error('503 warming')).mockResolvedValue(snapshot);
    await mount();
    await act(async () => { status('live'); message({ ch: 'fill', data: fill('during-startup') }); });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(api.fetchMarkets).toHaveBeenCalledTimes(2);
    if (tab === 'volume') expect(dashboard.volume).toEqual(snapshot.volume);
    else expect(dashboard.fills.map((f) => f.id)).toEqual(['old', 'during-startup']);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(api.fetchMarkets).toHaveBeenCalledTimes(2);
  });

  it('retains the last catalog on unchanged ticks, accepts changes and accepts an empty catalog', async () => {
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.quoteMarkets = { venue: ['MON/USDC'] };
    await mount();
    const { venues: _, quoteMarkets: __, ...tick } = bootstrap.state;
    await act(async () => message({ ch: 'state', data: { ...tick, block: 2 } }));
    expect(dashboard.state?.quoteMarkets).toEqual({ venue: ['MON/USDC'] });
    await act(async () => message({ ch: 'state', data: { ...tick, block: 3, quoteMarkets: { venue: ['BTC/USDC'] } } }));
    expect(dashboard.state?.quoteMarkets).toEqual({ venue: ['BTC/USDC'] });
    await act(async () => message({ ch: 'state', data: { ...tick, block: 4, quoteMarkets: {} } }));
    expect(dashboard.state?.quoteMarkets).toEqual({});
  });

  it.each(['markouts', 'volume', 'leaderboard'] as const)('fetches no quote history on %s, including selection and registry changes', async (tab) => {
    window.history.replaceState(null, '', `/${tab}`);
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    await mount();
    expect(api.fetchQuoteHistory).not.toHaveBeenCalled();
    await act(async () => { dashboard.set('pair', 'BTC/USDC'); dashboard.set('size', 100); });
    const venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }] as const;
    await act(async () => message({ ch: 'state', data: { ...bootstrap.state, venues: [...venues] } }));
    expect(api.fetchQuoteHistory).not.toHaveBeenCalled();
    expect(dashboard.series).toEqual({});
    await act(async () => dashboard.set('tab', 'exec'));
    expect(api.fetchQuoteHistory).toHaveBeenCalledWith('BTC/USDC', 100);
    vi.mocked(api.fetchQuoteHistory).mockClear();
    await act(async () => dashboard.set('tab', tab));
    await act(async () => dashboard.set('size', 1000));
    await reconnect();
    expect(api.fetchQuoteHistory).not.toHaveBeenCalled();
  });

  it('ignores history completing after leaving Execution and fetches it on return', async () => {
    window.history.replaceState(null, '', '/');
    const pending = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchQuoteHistory).mockReturnValue(pending.promise);
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    await mount();
    await act(async () => dashboard.set('tab', 'markouts'));
    const before = structuredClone(dashboard.series);
    await act(async () => pending.resolve([{ ...bootstrap.quotes, block: 2, rows: [{ venueId: 'venue', market: 'MON/USDC', sizeUsd: 1000,
      bidBps: -1, askBps: 1, bidPx: 1, askPx: 2, spreadBps: 2, filledFull: true, feeBps: 0, ts: Date.now() }] }]));
    expect(dashboard.series).toEqual(before);
    vi.mocked(api.fetchQuoteHistory).mockClear().mockResolvedValue([]);
    await act(async () => dashboard.set('tab', 'exec'));
    expect(api.fetchQuoteHistory).toHaveBeenCalled();
  });
});

describe('fill snapshot resynchronization', () => {
  it('accepts a completed quote behind the bootstrap head but still rejects older observed frames', async () => {
    window.history.replaceState(null, '', '/');
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.block = 100; bootstrap.quotes.block = 100;
    await mount();
    const frame = (block: number): QuoteSnapshot => ({ block, monUsd: 1, ts: Date.now(), rows: [], frame: {
      headSource: 'http', headObservedAt: 1, quoteStartedAt: 1, quoteCompletedAt: 2, emittedAt: 2,
      durationMs: 1, adapterMs: {}, missingVenues: [], coalescedBlocks: 0,
    } });
    await act(async () => message({ ch: 'quotes', data: frame(99) }));
    expect(dashboard.quotes?.block).toBe(99);
    await act(async () => message({ ch: 'quotes', data: frame(98) }));
    expect(dashboard.quotes?.block).toBe(99);
    await act(async () => message({ ch: 'quotes', data: frame(101) }));
    expect(dashboard.quotes?.block).toBe(101);
  });

  it('removes superseded proposal samples and rejects history that raced the replacement', async () => {
    window.history.replaceState(null, '', '/');
    const oldHistory = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchQuoteHistory).mockReturnValue(oldHistory.promise);
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    await mount();
    const frame = (revision: number, bidPx: number): QuoteSnapshot => ({ block: 101, monUsd: 1, ts: Date.now(), revision,
      rows: [{ venueId: 'venue', market: 'MON/USDC', sizeUsd: 1000, bidPx, askPx: bidPx + 1,
        bidBps: 0, askBps: 1, spreadBps: bidPx, filledFull: true, feeBps: 0, ts: Date.now() }] });
    await act(async () => message({ ch: 'quotes', data: frame(0, 1) }));
    await act(async () => message({ ch: 'quotes', data: frame(1, 2) }));
    await act(async () => oldHistory.resolve([frame(0, 1)]));
    expect(dashboard.series.venue.points.map((point) => point.bid)).toEqual([2]);
    expect(dashboard.quotes?.revision).toBe(1);
  });

  it('rejects older revisions at every height while accepting gaps and rollback revisions', async () => {
    window.history.replaceState(null, '', '/');
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    await mount();
    let ts = Date.now();
    const frame = (block: number, revision: number | undefined, bidPx: number): QuoteSnapshot => ({ block, revision, monUsd: 1, ts: ++ts,
      rows: [{ venueId: 'venue', market: 'MON/USDC', sizeUsd: 1000, bidPx, askPx: bidPx + 1,
        bidBps: 0, askBps: 1, spreadBps: bidPx, filledFull: true, feeBps: 0, ts }] });
    await act(async () => message({ ch: 'quotes', data: frame(110, 0, 1) }));
    await act(async () => message({ ch: 'quotes', data: frame(108, 1, 2) }));
    for (const revision of [undefined, 0]) for (const block of [107, 108, 111]) {
      await act(async () => message({ ch: 'quotes', data: frame(block, revision, 99) }));
      expect(dashboard.quotes).toMatchObject({ block: 108, revision: 1 });
      expect(dashboard.series.venue.points.map((point) => point.bid)).toEqual([2]);
    }
    await act(async () => message({ ch: 'quotes', data: frame(112, 1, 3) }));
    expect(dashboard.quotes).toMatchObject({ block: 112, revision: 1 });
    await reconnect();
    await act(async () => message({ ch: 'quotes', data: frame(113, 0, 4) }));
    expect(dashboard.quotes).toMatchObject({ block: 113, revision: 0 });
  });

  it('rejects an older revision even when bootstrap contains no completed quote', async () => {
    window.history.replaceState(null, '', '/');
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.quotes = { ...bootstrap.quotes, block: 100, revision: 1 };
    await mount();
    await act(async () => message({ ch: 'quotes', data: { ...bootstrap.quotes, block: 101, revision: 0 } }));
    expect(dashboard.quotes).toMatchObject({ block: 100, revision: 1 });
    await act(async () => message({ ch: 'quotes', data: { ...bootstrap.quotes, block: 99 } }));
    expect(dashboard.quotes).toMatchObject({ block: 99, revision: 1 });
  });

  it('retains fills arriving during the initial REST request', async () => {
    const initial = deferred<Fill[]>();
    vi.mocked(api.fetchFills).mockReturnValueOnce(initial.promise);
    await mount();
    await act(async () => message({ ch: 'fill', data: fill('live') }));
    await act(async () => initial.resolve([fill('old')]));
    expect(dashboard.fills.map((f) => f.id)).toEqual(['old', 'live']);
  });

  it('merges new fills and corrected markouts received during every reconnect request', async () => {
    await mount();
    for (const id of ['second', 'third']) {
      const snapshot = deferred<Fill[]>();
      vi.mocked(api.fetchFills).mockReturnValueOnce(snapshot.promise);
      await reconnect();
      await act(async () => {
        message({ ch: 'fill', data: { ...fill('old', 200), markoutsBps: [1, 2, 3, 4, 5] } });
        message({ ch: 'fill', data: fill(id) });
      });
      await act(async () => snapshot.resolve([fill('old')]));
      expect(dashboard.fills.map((f) => f.id)).toEqual(['old', id]);
      expect(dashboard.fills[0]).toMatchObject({ usd: 200, markoutsBps: [1, 2, 3, 4, 5] });
    }
  });

  it('ignores an older REST response when reconnect requests overlap', async () => {
    await mount();
    const older = deferred<Fill[]>(), newer = deferred<Fill[]>();
    vi.mocked(api.fetchFills).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await reconnect();
    await act(async () => message({ ch: 'fill', data: fill('between') }));
    await reconnect();
    await act(async () => message({ ch: 'fill', data: fill('latest') }));
    await act(async () => newer.resolve([fill('new-snapshot')]));
    await act(async () => older.resolve([fill('obsolete-snapshot')]));
    expect(dashboard.fills.map((f) => f.id)).toEqual(['new-snapshot', 'between', 'latest']);
  });

  it('preserves live fills on a failed history fetch and respects an empty successful snapshot', async () => {
    await mount();
    vi.mocked(api.fetchFills).mockRejectedValueOnce(new Error('unavailable'));
    await reconnect();
    expect(dashboard.fills.map((f) => f.id)).toEqual(['old']);
    vi.mocked(api.fetchFills).mockResolvedValueOnce([]);
    await reconnect();
    expect(dashboard.fills).toEqual([]);
  });
});

describe('shared rolling statistics', () => {
  const summary = (market = 'MON/USDC', sizeUsd = 1000, n = 1000, revision = 0) => ({ market, sizeUsd, asOf: Date.now(), windowMs: 300_000, revision,
    rows: [{ venueId: 'venue', n, p5: 1, p25: 2, p50: 3, p75: 4, p95: 5, avg: 3, sd: 1 }] });

  it('displays the collector window immediately and refetches it on page return and reconnect', async () => {
    window.history.replaceState(null, '', '/');
    vi.mocked(api.fetchQuoteStats).mockImplementation(async (market, sizeUsd) => summary(market, sizeUsd));
    await mount();
    expect(dashboard.quoteStats?.rows[0].n).toBe(1000);
    expect(dashboard.series).toEqual({}); // no locally collected samples were needed
    await act(async () => dashboard.set('tab', 'volume'));
    expect(dashboard.quoteStats).toBeNull();
    vi.mocked(api.fetchQuoteStats).mockClear();
    await act(async () => dashboard.set('size', 100));
    expect(api.fetchQuoteStats).not.toHaveBeenCalled();
    await act(async () => dashboard.set('tab', 'exec'));
    expect(api.fetchQuoteStats).toHaveBeenCalledWith('MON/USDC', 100);
    vi.mocked(api.fetchQuoteStats).mockClear();
    await reconnect();
    expect(api.fetchQuoteStats).toHaveBeenCalledWith('MON/USDC', 100);
  });

  it('rejects a slow result for a previous pair/size or a page that has been left', async () => {
    window.history.replaceState(null, '', '/');
    const old = deferred<ReturnType<typeof summary>>(), current = deferred<ReturnType<typeof summary>>();
    vi.mocked(api.fetchQuoteStats).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await mount();
    await act(async () => { dashboard.set('pair', 'BTC/USDC'); dashboard.set('size', 100); });
    await act(async () => current.resolve(summary('BTC/USDC', 100, 2000)));
    await act(async () => old.resolve(summary('MON/USDC', 1000)));
    expect(dashboard.quoteStats).toMatchObject({ market: 'BTC/USDC', sizeUsd: 100, rows: [{ n: 2000 }] });
    const leaving = deferred<ReturnType<typeof summary>>();
    vi.mocked(api.fetchQuoteStats).mockReturnValueOnce(leaving.promise);
    await act(async () => dashboard.set('size', 1000));
    await act(async () => dashboard.set('tab', 'volume'));
    await act(async () => leaving.resolve(summary('BTC/USDC', 1000)));
    expect(dashboard.quoteStats).toBeNull();
  });

  it('does not poll hidden pages, refreshes on visibility, and avoids overlapping requests', async () => {
    vi.useFakeTimers(); window.history.replaceState(null, '', '/');
    const descriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    const hidden = (value: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      hidden(false); await mount();
      vi.mocked(api.fetchQuoteStats).mockClear();
      await act(async () => hidden(true));
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(api.fetchQuoteStats).not.toHaveBeenCalled();
      const pending = deferred<ReturnType<typeof summary>>();
      vi.mocked(api.fetchQuoteStats).mockReturnValueOnce(pending.promise);
      await act(async () => hidden(false));
      expect(api.fetchQuoteStats).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(api.fetchQuoteStats).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(summary()));
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(api.fetchQuoteStats).toHaveBeenCalledTimes(2);
    } finally {
      if (descriptor) Object.defineProperty(document, 'hidden', descriptor);
      else Reflect.deleteProperty(document, 'hidden');
    }
  });

  it('clears failed aggregates and prevents an old proposal response surviving a replacement', async () => {
    window.history.replaceState(null, '', '/');
    vi.mocked(api.fetchQuoteStats).mockResolvedValueOnce(summary());
    await mount();
    expect(dashboard.quoteStats?.rows[0].n).toBe(1000);
    vi.mocked(api.fetchQuoteStats).mockRejectedValueOnce(new Error('offline'));
    await reconnect();
    expect(dashboard.quoteStats).toBeNull();
    const old = deferred<ReturnType<typeof summary>>();
    vi.mocked(api.fetchQuoteStats).mockReturnValueOnce(old.promise).mockResolvedValueOnce(summary('MON/USDC', 1000, 999, 1));
    await act(async () => status('reconnecting'));
    await act(async () => message({ ch: 'quotes', data: { block: 10, ts: Date.now(), monUsd: 1, rows: [], revision: 1 } }));
    await act(async () => old.resolve(summary()));
    expect(dashboard.quoteStats).toMatchObject({ revision: 1, rows: [{ n: 999 }] });
  });

  it('clears obsolete statistics when REST reports a replacement before the next quote frame', async () => {
    vi.useFakeTimers(); window.history.replaceState(null, '', '/');
    vi.mocked(api.fetchQuoteStats).mockResolvedValueOnce(summary()).mockResolvedValueOnce(summary('MON/USDC', 1000, 999, 1));
    await mount();
    expect(dashboard.quoteStats?.rows[0].n).toBe(1000);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(dashboard.quoteStats).toBeNull();
  });

  it('starts a fresh history request on a quick page return while the previous visit is still loading', async () => {
    window.history.replaceState(null, '', '/');
    const old = deferred<QuoteSnapshot[]>(), current = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchQuoteHistory).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    await mount();
    await act(async () => dashboard.set('tab', 'volume'));
    await act(async () => dashboard.set('tab', 'exec'));
    expect(api.fetchQuoteHistory).toHaveBeenCalledTimes(2);
    const quote = (block: number): QuoteSnapshot => ({ ...bootstrap.quotes, block });
    await act(async () => current.resolve([quote(2), quote(3)]));
    await act(async () => old.resolve([quote(1)]));
    expect(dashboard.series.venue.points.map((point) => point.block)).toEqual([2, 3]);
  });

  it.each(['resolve', 'reject'] as const)('reloads history on reconnect while the old same-selection request is pending (%s)', async (settlement) => {
    window.history.replaceState(null, '', '/');
    const old = deferred<QuoteSnapshot[]>(), current = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchQuoteHistory).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    const quote = (block: number): QuoteSnapshot => ({ ...bootstrap.quotes, block });
    await mount();
    await reconnect();
    expect(api.fetchQuoteHistory).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (settlement === 'reject') old.reject(new Error('dropped connection'));
      else old.resolve([quote(1)]);
    });
    await act(async () => current.resolve([quote(2), quote(3)]));
    expect(dashboard.series.venue.points.map((point) => point.block)).toEqual([2, 3]);
  });

  it('discards pre-reconnect live frames when the server replays a corrected history', async () => {
    window.history.replaceState(null, '', '/');
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    const quote = (block: number): QuoteSnapshot => ({ ...bootstrap.quotes, block });
    await mount();
    await act(async () => message({ ch: 'quotes', data: quote(10) }));
    vi.mocked(api.fetchQuoteHistory).mockResolvedValueOnce([quote(7), quote(8), quote(9)]);
    await reconnect();
    expect(dashboard.series.venue.points.map((point) => point.block)).toEqual([7, 8, 9]);
  });

  it.each([0, 2])('rejects a history response from revision %i when the stream is on revision 1', async (revision) => {
    window.history.replaceState(null, '', '/');
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    const quote = (block: number, revision: number): QuoteSnapshot => ({ ...bootstrap.quotes, block, revision });
    await mount();
    const pending = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchQuoteHistory).mockReturnValueOnce(pending.promise);
    await act(async () => message({ ch: 'quotes', data: quote(10, 1) }));
    await act(async () => pending.resolve([quote(9, revision), quote(10, revision), quote(11, revision)]));
    expect(dashboard.series.venue.points.map((point) => point.block)).toEqual([10]);
  });

  it('starts a new request when bootstrap advances the revision before the first stream frame', async () => {
    window.history.replaceState(null, '', '/');
    const snapshot = await vi.mocked(api.fetchMarkets)();
    snapshot.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    const bootstrap = deferred<MarketsResponse>(), old = deferred<QuoteSnapshot[]>(), current = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchMarkets).mockReturnValue(bootstrap.promise);
    vi.mocked(api.fetchQuoteHistory).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await mount();
    snapshot.quotes = { ...snapshot.quotes, block: 10, revision: 1 };
    await act(async () => bootstrap.resolve(snapshot));
    expect(api.fetchQuoteHistory).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve([{ ...snapshot.quotes, block: 8, revision: 0 }, { ...snapshot.quotes, block: 9 }]));
    await act(async () => old.resolve([{ ...snapshot.quotes, block: 11, revision: 0 }]));
    expect(dashboard.series.venue.points.map((point) => point.block)).toEqual([8, 9]);
  });

  it('reloads valid ancestors after a replacement and discards the previous revision request', async () => {
    window.history.replaceState(null, '', '/');
    const old = deferred<QuoteSnapshot[]>(), current = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchQuoteHistory).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    const quote = (block: number, revision = 0): QuoteSnapshot => ({ ...bootstrap.quotes, block, revision });
    await mount();
    await act(async () => message({ ch: 'quotes', data: quote(10) }));
    await act(async () => message({ ch: 'quotes', data: quote(9, 1) }));
    expect(api.fetchQuoteHistory).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve([quote(7), quote(8), quote(9, 1)]));
    await act(async () => old.resolve([quote(7), quote(8), quote(9), quote(10)]));
    expect(dashboard.series.venue.points.map((point) => point.block)).toEqual([7, 8, 9]);
    expect(dashboard.quotes?.revision).toBe(1);
  });

  it('merges chart history with live frames received during its fetch, including samples collected off-page', async () => {
    window.history.replaceState(null, '', '/');
    const bootstrap = await vi.mocked(api.fetchMarkets)();
    bootstrap.state.venues = [{ id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } }];
    await mount();
    await act(async () => dashboard.set('tab', 'volume'));
    const pending = deferred<QuoteSnapshot[]>();
    vi.mocked(api.fetchQuoteHistory).mockReturnValue(pending.promise);
    await act(async () => dashboard.set('tab', 'exec'));
    const quote = (block: number): QuoteSnapshot => ({ ...bootstrap.quotes, block, ts: Date.now(), rows: [{ venueId: 'venue', market: 'MON/USDC', sizeUsd: 1000,
      bidPx: block, askPx: block + 1, bidBps: 0, askBps: 1, spreadBps: 1, filledFull: true, feeBps: 0, ts: Date.now() }] });
    await act(async () => message({ ch: 'quotes', data: quote(5) }));
    await act(async () => pending.resolve([quote(2), quote(3), quote(4)]));
    expect(dashboard.series.venue.points.map((point) => point.block)).toEqual([2, 3, 4, 5]);
  });
});
