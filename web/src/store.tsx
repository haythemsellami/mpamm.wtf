import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MarketState, StreamState, QuoteSnapshot, QuoteStatsResponse, Fill, DailyVolume, VenueMeta, LeaderboardResponse, GasResponse } from '@shared';
import { pairOf, cexForBase, QUOTE_CHART_WINDOW_MS, QUOTE_STATS_REFRESH_MS } from '@shared';
import { fetchMarkets, fetchFills, fetchLeaderboard, fetchGas, fetchQuoteHistory, fetchQuoteStats, connectDashboardStream } from './lib/api';
import { pathForTab, tabFromPath, urlForTab, type Tab } from './lib/tab-route';
import { appendQuoteSnapshot, quoteFrameTime, type QuoteSeries } from './lib/quote-series';
import type { Theme } from './theme';

export type { Tab } from './lib/tab-route';

/** Read the persisted theme, matching the pre-paint script in index.html.
 *  Default is bright (light); only an explicit 'dark' choice opts in. */
const initialTheme = (): Theme => {
  try { return localStorage.getItem('pamm-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
};
const QUOTE_WINDOW_MS = QUOTE_CHART_WINDOW_MS;
const QUOTE_SAMPLE_MAX = 4096; // emergency bound, well above a minute at block cadence

const initialTab = (): Tab => tabFromPath(window.location.pathname) ?? 'exec';

export type Series = QuoteSeries;

interface UiState {
  tab: Tab;
  theme: Theme;
  pair: string;
  size: number;
  // per-venue on/off, keyed by VenueMeta.id. Defaults all registry venues on so
  // the reference benchmark still renders when no propAMM venue has a quote.
  venueToggles: Record<string, boolean>;
  // markouts
  mkProto: string; mkSide: string; mkSize: string; mkPaused: boolean;
  // Volume tab windows — per chart, per the design. The two BAR charts are
  // brush-windowed (start/end = day indexes into d.volume; null = the default
  // trailing six-month window, derived per render so it tracks the newest
  // day), each with its own independent brush. The three date-windowed
  // charts own from→to ISO pairs (null = that bound open ⇒ full range).
  // Granularities re-bucket the two bar charts ('D'|'W'|'M').
  volStart: number | null; volEnd: number | null;
  burnStart: number | null; burnEnd: number | null;
  volGran: string; burnGran: string;
  cumFrom: string | null; cumTo: string | null;
  msFrom: string | null; msTo: string | null;
  brkFrom: string | null; brkTo: string | null;
  // leaderboard
  lbWin: string; lbGroup: string; lbHz: string; lbWinners: boolean; lbTop: number;
}

/** the leaderboard window pills → /api/leaderboard days. */
export const LB_WIN_DAYS: Record<string, number> = { '24H': 1, '7D': 7, '30D': 30 };

interface Dashboard extends UiState {
  conn: 'connecting' | 'live' | 'reconnecting';
  state: MarketState | null;
  quotes: QuoteSnapshot | null;
  volume: DailyVolume[];
  fills: Fill[];
  /** server-side aggregates for the CURRENT leaderboard window (lbWin). */
  lb: LeaderboardResponse | null;
  /** the 24h aggregate (outlier feed) — polled while the Markouts tab is open. */
  lbDay: LeaderboardResponse | null;
  /** QUOTE_UPDATE_BURN series — polled while the Volume tab is open. */
  gas: GasResponse | null;
  frame: number;
  // venue registry (from state.venues) + derived views. Everything venue-related
  // in the UI reads these; nothing about a venue is hardcoded client-side.
  venues: VenueMeta[];
  displayVenues: VenueMeta[];              // role === 'venue' (propAMM makers)
  baselines: VenueMeta[];                  // role === 'baseline' (quote-only comparisons, exec-page band)
  reference: VenueMeta | undefined;        // default CEX benchmark (first reference)
  references: VenueMeta[];                  // all CEX benchmarks (role === 'reference')
  /** the CEX benchmark for a market, routed by base asset (Bybit for MON, Binance for BTC/ETH). */
  referenceFor: (market: string) => VenueMeta | undefined;
  venuesById: Record<string, VenueMeta>;
  series: Record<string, Series>;
  quoteStats: QuoteStatsResponse | null;
  // setters
  set: <K extends keyof UiState>(k: K, v: UiState[K]) => void;
  toggleVenue: (id: string) => void;
  toggleTheme: () => void;
  resetLb: () => void;
}

const Ctx = createContext<Dashboard | null>(null);
export const useDashboard = (): Dashboard => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDashboard outside provider');
  return c;
};

/** venue ids carried by the current registry — drives the per-venue buffers. */
const venueIds = (state: MarketState | null): string[] => (state?.venues ?? []).map((v) => v.id);

/** The stream ships the venue registry ONLY on the hello frame (see StreamState
 *  — it is immutable and was costing 1.3KB on each of ~6 frames/s). Re-attach
 *  the copy we already hold so every consumer downstream still sees a complete
 *  MarketState. A frame that arrives before we have a registry at all is dropped
 *  rather than rendered: a venue-less state would blank every venue-keyed view. */
const mergeState = (prev: MarketState | null, next: StreamState): MarketState | null => {
  const venues = next.venues ?? prev?.venues;
  return venues ? { ...next, venues, quoteMarkets: next.quoteMarkets ?? prev?.quoteMarkets } : prev;
};

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<UiState>(() => ({
    // size: the opening notional for QUOTE + ROLLING_STATS ($1k, one of SIZES_USD).
    tab: initialTab(), theme: initialTheme(), pair: 'MON/USDC', size: 1000,
    venueToggles: {},
    mkProto: 'ALL', mkSide: 'ALL', mkSize: 'ANY', mkPaused: false,
    volStart: null, volEnd: null, burnStart: null, burnEnd: null,
    volGran: 'D', burnGran: 'D',
    cumFrom: null, cumTo: null, msFrom: null, msTo: null, brkFrom: null, brkTo: null,
    lbWin: '24H', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbWinners: true, lbTop: 25,
  }));
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [state, setState] = useState<MarketState | null>(null);
  const stateBlockRef = useRef(0);
  const [quotes, setQuotes] = useState<QuoteSnapshot | null>(null);
  const [quoteStats, setQuoteStats] = useState<QuoteStatsResponse | null>(null);
  const [volume, setVolume] = useState<DailyVolume[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [lb, setLb] = useState<LeaderboardResponse | null>(null);
  const [lbDay, setLbDay] = useState<LeaderboardResponse | null>(null);
  const [gas, setGas] = useState<GasResponse | null>(null);
  const [frame, setFrame] = useState(0);

  // The URL is the shareable form of tab state. Canonicalize direct loads,
  // restore the selected tab on browser navigation, and preserve any filters
  // another feature has placed in the query string or hash.
  useEffect(() => {
    const syncFromLocation = () => {
      const tab = tabFromPath(window.location.pathname) ?? 'exec';
      const path = pathForTab(tab);
      if (window.location.pathname !== path) {
        window.history.replaceState(window.history.state, '', urlForTab(tab, window.location.search, window.location.hash));
      }
      setUi((state) => state.tab === tab ? state : { ...state, tab });
    };

    syncFromLocation();
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  useEffect(() => {
    const path = pathForTab(ui.tab);
    if (window.location.pathname === path) return;
    window.history.pushState(window.history.state, '', urlForTab(ui.tab, window.location.search, window.location.hash));
  }, [ui.tab]);

  const seriesRef = useRef<Record<string, Series>>({});
  const quotesRef = useRef<QuoteSnapshot | null>(null);
  // the venue ids the buffers are keyed by — read inside the (stable) stream
  // callback so we never close over a stale registry.
  const idsRef = useRef<string[]>([]);
  const selRef = useRef({ tab: ui.tab, pair: ui.pair, size: ui.size });
  selRef.current = { tab: ui.tab, pair: ui.pair, size: ui.size };
  // what the buffers currently CONTAIN ("pair|size"). pushSnapshot re-keys
  // synchronously on mismatch, so a WS tick arriving between a pair switch and
  // the reseed effect can never append new-pair prices onto old-pair samples
  // (the mixed-buffer scale flicker).
  const seedKeyRef = useRef('');
  const seedFetchRef = useRef<{ key: string } | null>(null);
  const recentQuotesRef = useRef<QuoteSnapshot[]>([]);
  const keyOf = () => `${selRef.current.pair}|${selRef.current.size}`;
  const pushSnapshot = (q: QuoteSnapshot) => {
    const previous = recentQuotesRef.current.at(-1);
    if (previous && ((previous.revision ?? 0) !== (q.revision ?? 0)
      || (previous.block === q.block && previous.blockHash && q.blockHash && previous.blockHash !== q.blockHash))) {
      recentQuotesRef.current = [];
      seriesRef.current = {};
      seedFetchRef.current = null;
    }
    quotesRef.current = q;
    if (selRef.current.tab !== 'exec') return;
    if (seedKeyRef.current !== keyOf()) reseed(); // sync re-key — mixed buffers impossible
    const recent = recentQuotesRef.current;
    const duplicate = recent.at(-1)?.block === q.block;
    if (duplicate) recent[recent.length - 1] = q;
    else recent.push(q);
    const cutoff = quoteFrameTime(q) - QUOTE_WINDOW_MS;
    while (recent.length && quoteFrameTime(recent[0]) <= cutoff) recent.shift();
    if (recent.length > QUOTE_SAMPLE_MAX) recent.shift();
    const { pair, size } = selRef.current;
    appendQuoteSnapshot(seriesRef.current, idsRef.current, q, pair, size, QUOTE_WINDOW_MS, QUOTE_SAMPLE_MAX);
  };

  // Re-key the canvas buffers to the selected pair/size. Seed only the one real
  // current frame while history loads — fabricating a flat minute would hide
  // both a young server and missing blocks.
  const reseed = () => {
    if (selRef.current.tab !== 'exec') return;
    const q = quotesRef.current;
    const ids = idsRef.current;
    if (seedKeyRef.current !== keyOf()) recentQuotesRef.current = [];
    seedKeyRef.current = keyOf();
    // Mutate the buffers IN PLACE (keep the seriesRef object references
    // stable) so `d.series` — captured in the api memo — can never point at a stale
    // pre-reseed object. Clear every buffer, drop de-registered venues, then refill.
    const S = seriesRef.current;
    for (const id of ids) { const s = (S[id] ??= { points: [] }); s.points.length = 0; }
    for (const id of Object.keys(S)) if (!ids.includes(id)) delete S[id];
    if (q) {
      const { pair, size } = selRef.current;
      appendQuoteSnapshot(S, ids, q, pair, size, QUOTE_WINDOW_MS, QUOTE_SAMPLE_MAX);
    }
    void seedFromHistory(seedKeyRef.current);
  };

  // replace the flat pre-fill with the server's retained real quote ticks for
  // this (pair, size). Stale-guarded: a slow response for a pair the user has
  // already left is discarded (seedKey moved on).
  const seedFromHistory = async (key: string) => {
    if (selRef.current.tab !== 'exec') return;
    if (seedFetchRef.current?.key === key) return;
    const request = { key };
    seedFetchRef.current = request;
    try {
      const revision = quotesRef.current?.revision ?? 0;
      const [pair, sizeS] = key.split('|');
      const hist = await fetchQuoteHistory(pair, Number(sizeS));
      if (seedFetchRef.current !== request || selRef.current.tab !== 'exec' || seedKeyRef.current !== key || !hist.length
        || (quotesRef.current?.revision ?? 0) !== revision) return;
      const S = seriesRef.current;
      for (const id of idsRef.current) { const s = (S[id] ??= { points: [] }); s.points.length = 0; }
      // Live frames can arrive while REST is in flight. Prefer those frames
      // at the same block and retain every newer one when rebuilding buffers.
      // Server invalidation already removed replaced descendants. Older
      // revisions may still contain valid ancestors within the chart window.
      const merged = new Map(hist.map((q) => [q.block, q]));
      for (const q of recentQuotesRef.current) merged.set(q.block, q);
      for (const q of [...merged.values()].sort((a, b) => a.block - b.block)) {
        appendQuoteSnapshot(S, idsRef.current, q, pair, Number(sizeS), QUOTE_WINDOW_MS, QUOTE_SAMPLE_MAX);
      }
      setFrame((f) => f + 1);
    } catch { /* the current real frame stays — the stream continues live */ }
    finally { if (seedFetchRef.current === request) seedFetchRef.current = null; }
  };

  // adopt a fresh registry: re-key the per-venue buffers and default a toggle for
  // every registry venue to on the first time we see it. Called on the initial
  // snapshot and on every `state` stream message, so venues that
  // appear/disappear at runtime are handled without hardcoding.
  const adoptVenues = (venues: VenueMeta[]) => {
    idsRef.current = venues.map((v) => v.id);
    setUi((s) => {
      const next = { ...s.venueToggles };
      let changed = false;
      for (const v of venues) {
        // baselines (standard-DEX comparison band) default OFF — an opt-in
        // overlay, per the product decision; everything else defaults on.
        if (!(v.id in next)) { next[v.id] = v.role !== 'baseline'; changed = true; }
      }
      return changed ? { ...s, venueToggles: next } : s;
    });
  };

  const baselineOn = (state?.venues ?? []).some((v) => v.role === 'baseline' && ui.venueToggles[v.id]);

  // cold start + stream. The snapshot is (re)loaded both on mount and on every
  // WS (re)connect, so an initial fetch that races a backend restart is healed,
  // and a reconnect re-syncs history/fills (gap-fill replay — docs/architecture.md: history).
  useEffect(() => {
    const mounted = { v: true };
    const wasDropped = { v: false };
    // The WS streams volume DELTAS (today's bucket) every tick, and it usually
    // wins the race against the full REST snapshot. Merging a delta into the
    // initial empty array made the page render a one-day "history" ($X all-time,
    // "since today") until the snapshot landed. Gate deltas on the snapshot: the
    // snapshot carries today's bucket anyway, and the next tick re-syncs it.
    const snapshotLoaded = { v: false };
    const pendingFills: { current: Fill[] } = { current: [] };
    let snapshotRequest = 0;
    let resyncing = false;
    let snapshotRetry: ReturnType<typeof setTimeout> | undefined;
    const loadSnapshot = async () => {
      if (snapshotRetry) clearTimeout(snapshotRetry);
      snapshotRetry = undefined;
      const request = ++snapshotRequest;
      resyncing = true;
      let loaded = false;
      try {
        // markets snapshot + the persisted historical fills window (the tape /
        // markouts / leaderboard operate on real history, not a live buffer).
        // The tape only needs a recent window — leaderboard/outlier stats come
        // pre-aggregated from /api/leaderboard over the FULL window instead
        // (fetching 30d of raw fills silently truncated at the 20k cap).
        const [m, hist] = await Promise.all([
          fetchMarkets(ui.tab === 'volume'),
          ui.tab === 'markouts' ? fetchFills(1, 5000) : Promise.resolve(null),
        ]);
        if (!mounted.v || request !== snapshotRequest) return;
        stateBlockRef.current = Math.max(stateBlockRef.current, m.state.block);
        setState((previous) => previous && previous.block > m.state.block ? { ...m.state, ...previous, venues: m.state.venues } : m.state);
        if (!quotesRef.current) { setQuotes(m.quotes); quotesRef.current = m.quotes; }
        if (ui.tab === 'volume') setVolume(m.volume);
        snapshotLoaded.v = true;
        adoptVenues(m.state.venues ?? []);
        // /api/fills is newest-first; store oldest-first so the cap in
        // upsertFill drops the genuine oldest, not the newest (audit B4).
        // Fills broadcast while the snapshot was in flight are NOT in the
        // response — re-apply them on top instead of discarding.
        const buffered = pendingFills.current;
        if (ui.tab === 'markouts') setFills((previous) => buffered.reduce((acc, f) => upsertFill(acc, f),
          hist === null ? previous : [...hist].reverse()));
        if (ui.tab === 'exec') reseed();
        setFrame((f) => f + 1);
        loaded = true;
      } catch {
        // The socket can be live before persisted history is ready. Retry
        // independently of reconnects and keep buffering deltas until success.
        if (mounted.v && request === snapshotRequest) snapshotRetry = setTimeout(loadSnapshot, 1_000);
      }
      finally {
        if (loaded && request === snapshotRequest) { resyncing = false; pendingFills.current = []; }
      }
    };
    loadSnapshot();

    const topics: import('@shared').StreamTopic[] = [{ channel: 'state' }];
    if (ui.tab === 'exec') topics.push({ channel: 'quotes', market: ui.pair, sizeUsd: ui.size, baseline: baselineOn });
    if (ui.tab === 'markouts') topics.push({ channel: 'fill' });
    if (ui.tab === 'volume') topics.push({ channel: 'volume' });
    const dispose = connectDashboardStream(topics, (msg) => {
      if (msg.ch === 'state') {
        if (msg.data.block < stateBlockRef.current) return;
        stateBlockRef.current = msg.data.block;
        setState((prev) => mergeState(prev, msg.data));
        if (msg.data.venues) adoptVenues(msg.data.venues);
      }
      else if (msg.ch === 'quotes') {
        // Bootstrap carries the head with empty rows, not an observed quote.
        // The latest completed frame can legitimately be one block behind it.
        const current = quotesRef.current;
        if (current && (msg.data.revision ?? 0) < (current.revision ?? 0)) return;
        if (current && (current.frame || current.rows.length > 0) && msg.data.block < current.block
          && (msg.data.revision ?? 0) === (current.revision ?? 0)) return;
        setQuotes(msg.data); pushSnapshot(msg.data); setFrame((f) => f + 1);
      }
      else if (msg.ch === 'volume') { if (snapshotLoaded.v) setVolume((prev) => mergeDay(prev, msg.data)); }
      else if (msg.ch === 'fill') {
        if (resyncing) pendingFills.current = upsertFill(pendingFills.current, msg.data);
        setFills((prev) => upsertFill(prev, msg.data));
      }
    }, (s) => {
      setConn(s);
      // mount already fetched the snapshot; re-fetch only after a DROP (missed
      // WS deltas), not on the initial open racing that first fetch.
      if (s === 'reconnecting') { wasDropped.v = true; quotesRef.current = null; }
      if (s === 'live' && wasDropped.v) { wasDropped.v = false; loadSnapshot(); }
    });

    return () => { mounted.v = false; seedFetchRef.current = null; if (snapshotRetry) clearTimeout(snapshotRetry); dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.tab, ui.pair, ui.size, baselineOn]);

  // Five-minute statistics belong to the collector, so page visits never
  // reset the window. Poll only the visible selection; a slow response cannot
  // replace a newer selection, reconnect, or proposal revision.
  const quoteRevision = quotes?.revision ?? 0;
  useEffect(() => {
    setQuoteStats(null);
    if (ui.tab !== 'exec') return;
    let active = true;
    let loading = false;
    const load = async () => {
      if (document.hidden || loading) return;
      loading = true;
      try {
        const stats = await fetchQuoteStats(ui.pair, ui.size);
        if (active) setQuoteStats(stats.market === ui.pair && stats.sizeUsd === ui.size
          && stats.revision === (quotesRef.current?.revision ?? 0) ? stats : null);
      } catch { if (active) setQuoteStats(null); }
      finally { loading = false; }
    };
    void load();
    const id = setInterval(() => { void load(); }, QUOTE_STATS_REFRESH_MS);
    document.addEventListener('visibilitychange', load);
    return () => { active = false; clearInterval(id); document.removeEventListener('visibilitychange', load); };
  }, [ui.tab, ui.pair, ui.size, conn, quoteRevision]);

  // server-side leaderboard aggregates: fetch on tab entry + window change, then
  // poll every 30s while the tab is open (fills stream live, aggregates don't).
  const lbDays = LB_WIN_DAYS[ui.lbWin] ?? 1;
  useEffect(() => {
    if (ui.tab !== 'leaderboard') return;
    let on = true;
    const load = () => { if (document.hidden) return; fetchLeaderboard(lbDays).then((d) => { if (on) setLb(d); }).catch(() => { /* retried on the next poll */ }); };
    load();
    document.addEventListener('visibilitychange', load);
    const id = setInterval(load, 30_000);
    return () => { on = false; clearInterval(id); document.removeEventListener('visibilitychange', load); };
  }, [ui.tab, lbDays]);
  // the Markouts tab's OUTLIER_FEED reads the 24h aggregate.
  useEffect(() => {
    if (ui.tab !== 'markouts') return;
    let on = true;
    const load = () => { if (document.hidden) return; fetchLeaderboard(1).then((d) => { if (on) setLbDay(d); }).catch(() => { /* retried on the next poll */ }); };
    load();
    document.addEventListener('visibilitychange', load);
    const id = setInterval(load, 30_000);
    return () => { on = false; clearInterval(id); document.removeEventListener('visibilitychange', load); };
  }, [ui.tab]);
  // QUOTE_UPDATE_BURN accrues slowly (keeper cadence) — poll every 60s while
  // the Volume tab is open.
  useEffect(() => {
    if (ui.tab !== 'volume') return;
    let on = true;
    const load = () => { if (document.hidden) return; fetchGas().then((d) => { if (on) setGas(d); }).catch(() => { /* retried on the next poll */ }); };
    load();
    document.addEventListener('visibilitychange', load);
    const id = setInterval(load, 60_000);
    return () => { on = false; clearInterval(id); document.removeEventListener('visibilitychange', load); };
  }, [ui.tab]);

  // Chart buffers and their REST history are needed only on Execution. Entry
  // also re-keys them after pair/registry changes made on another page.
  useEffect(() => {
    if (ui.tab !== 'exec') return;
    reseed(); setFrame((f) => f + 1);
    /* eslint-disable-next-line */
  }, [ui.tab, ui.pair, ui.size, quoteRevision, venueIds(state).join(',')]);

  const venues = state?.venues ?? [];
  const { displayVenues, baselines, references, reference, venuesById } = useMemo(() => {
    const byId: Record<string, VenueMeta> = {};
    for (const v of venues) byId[v.id] = v;
    const refs = venues.filter((v) => v.role === 'reference');
    return {
      displayVenues: venues.filter((v) => v.role === 'venue'),
      baselines: venues.filter((v) => v.role === 'baseline'),
      references: refs,
      reference: refs[0],
      venuesById: byId,
    };
  }, [venues]);
  // the CEX benchmark for a market, routed by base asset (Bybit for MON, Binance for BTC/ETH).
  const referenceFor = useMemo(() => (market: string): VenueMeta | undefined => {
    const base = pairOf(market)?.base;
    return base ? venuesById[cexForBase(base)] : reference;
  }, [venuesById, reference]);

  const api = useMemo<Dashboard>(() => ({
    ...ui, conn, state, quotes, volume, fills, lb, lbDay, gas, frame,
    venues, displayVenues, baselines, reference, references, referenceFor, venuesById,
    series: seriesRef.current, quoteStats,
    set: (k, v) => setUi((s) => ({ ...s, [k]: v })),
    toggleVenue: (id) => setUi((s) => ({ ...s, venueToggles: { ...s.venueToggles, [id]: !s.venueToggles[id] } })),
    toggleTheme: () => {
      const theme: Theme = ui.theme === 'dark' ? 'light' : 'dark';
      // Side effects in the handler — NOT the state updater, which React may
      // defer or double-invoke. Set the html attr so the DOM re-skins instantly
      // via CSS vars, and persist the choice.
      try { localStorage.setItem('pamm-theme', theme); } catch { /* private mode */ }
      document.documentElement.dataset.theme = theme;
      setUi((s) => ({ ...s, theme }));
      // canvas colors come from JS getters (not var()), so force a repaint.
      setFrame((f) => f + 1);
    },
    resetLb: () => setUi((s) => ({ ...s, lbWin: '24H', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbWinners: true, lbTop: 25 })),
  }), [ui, conn, state, quotes, quoteStats, volume, fills, lb, lbDay, gas, frame, venues, displayVenues, baselines, reference, references, referenceFor, venuesById]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

function mergeDay(days: DailyVolume[], d: DailyVolume): DailyVolume[] {
  // the WS only ever carries TODAY's bucket — when a delta for a NEW day
  // arrives (first tick after UTC midnight), close every older partial flag,
  // or an overnight session renders yesterday dimmed as "(today, partial)".
  const closeOld = (x: DailyVolume) => (x.partial && x.utcDay < d.utcDay ? { ...x, partial: false } : x);
  const i = days.findIndex((x) => x.utcDay === d.utcDay);
  if (i === -1) return [...days.map(closeOld), d];
  const next = days.map(closeOld);
  next[i] = d;
  return next;
}

function upsertFill(fills: Fill[], f: Fill): Fill[] {
  const i = fills.findIndex((x) => x.id === f.id);
  if (i !== -1) {
    const next = fills.slice();
    next[i] = f;
    return next;
  }
  // the in-memory buffer only feeds the tape/outlier-merge — a recent window,
  // not the aggregation base (that's server-side now), so keep it bounded.
  const next = [...fills, f];
  if (next.length > 8000) next.shift();
  return next;
}
