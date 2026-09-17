// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fill, MarketsResponse, QuoteSnapshot } from '@shared';
import * as api from './lib/api';
import { DashboardProvider, useDashboard } from './store';

vi.mock('./lib/api', () => ({
  fetchMarkets: vi.fn(), fetchFills: vi.fn(), fetchLeaderboard: vi.fn(), fetchGas: vi.fn(),
  fetchQuoteHistory: vi.fn(), connectDashboardStream: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let dashboard: ReturnType<typeof useDashboard>;
let message: Parameters<typeof api.connectDashboardStream>[1];
let status: Parameters<typeof api.connectDashboardStream>[2];
const fill = (id: string, usd = 100): Fill => ({ id, usd, ts: Date.now(), venueId: 'venue', market: 'MON/USDC', side: 'buy', category: 'DIRECT', baseAmount: 1000, execPx: .1, blockNumber: 1, txHash: '0x1', to: 'direct', pool: 'pool', markoutsBps: [1, null, null, null, null] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
  vi.mocked(api.connectDashboardStream).mockImplementation((_topics, receive, change) => {
    message = receive; status = change;
    return () => {};
  });
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });

describe('state and quote history demand', () => {
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
