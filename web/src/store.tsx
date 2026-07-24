import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MarketState, QuoteSnapshot, QuoteRow, Fill, DailyVolume, VenueMeta, LeaderboardResponse, GasResponse } from '@shared';
import { pairOf, cexForBase } from '@shared';
import { fetchMarkets, fetchFills, fetchLeaderboard, fetchGas, fetchQuoteHistory, connectStream } from './lib/api';
import type { Theme } from './theme';

/** Read the persisted theme, matching the pre-paint script in index.html.
 *  Default is bright (light); only an explicit 'dark' choice opts in. */
const initialTheme = (): Theme => {
  try { return localStorage.getItem('pamm-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
};
export type Tab = 'exec' | 'volume' | 'markouts' | 'leaderboard';
const N = 120; // canvas rolling window (≈60s @ 500ms)

export interface Series { bid: number[]; ask: number[]; }

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
  // brush-windowed (start/end = day indexes into d.volume; null = full
  // history), each with its own independent brush. The three date-windowed
  // charts own from→to ISO pairs (null = that bound open ⇒ full range).
  // Granularities re-bucket the two bar charts ('D'|'W'|'M').
  volStart: number | null; volEnd: number | null;
  burnStart: number | null; burnEnd: number | null;
  volGran: string; burnGran: string;
  cumFrom: string | null; cumTo: string | null;
  msFrom: string | null; msTo: string | null;
  brkFrom: string | null; brkTo: string | null;
  // leaderboard
  lbWin: string; lbGroup: string; lbHz: string; lbMk: string; lbWinners: boolean; lbTop: number;
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
  samples: Record<string, number[]>;
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

function rowFor(q: QuoteSnapshot | null, venueId: string, market: string, size: number): QuoteRow | undefined {
  return q?.rows.find((r) => r.venueId === venueId && r.market === market && r.sizeUsd === size);
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<UiState>({
    tab: 'exec', theme: initialTheme(), pair: 'MON/USDC', size: 100,
    venueToggles: {},
    mkProto: 'ALL', mkSide: 'ALL', mkSize: 'ANY', mkPaused: false,
    volStart: null, volEnd: null, burnStart: null, burnEnd: null,
    volGran: 'D', burnGran: 'D',
    cumFrom: null, cumTo: null, msFrom: null, msTo: null, brkFrom: null, brkTo: null,
    lbWin: '24H', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbMk: 'MAKER', lbWinners: true, lbTop: 25,
  });
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [state, setState] = useState<MarketState | null>(null);
  const [quotes, setQuotes] = useState<QuoteSnapshot | null>(null);
  const [volume, setVolume] = useState<DailyVolume[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [lb, setLb] = useState<LeaderboardResponse | null>(null);
  const [lbDay, setLbDay] = useState<LeaderboardResponse | null>(null);
  const [gas, setGas] = useState<GasResponse | null>(null);
  const [frame, setFrame] = useState(0);

  const seriesRef = useRef<Record<string, Series>>({});
  const samplesRef = useRef<Record<string, number[]>>({});
  const quotesRef = useRef<QuoteSnapshot | null>(null);
  // the venue ids the buffers are keyed by — read inside the (stable) stream
  // callback so we never close over a stale registry.
  const idsRef = useRef<string[]>([]);
  const selRef = useRef({ pair: ui.pair, size: ui.size });
  selRef.current = { pair: ui.pair, size: ui.size };
  // what the buffers currently CONTAIN ("pair|size"). pushSnapshot re-keys
  // synchronously on mismatch, so a WS tick arriving between a pair switch and
  // the reseed effect can never append new-pair prices onto old-pair samples
  // (the mixed-buffer scale flicker).
  const seedKeyRef = useRef('');
  const seedFetchRef = useRef(''); // key with a history fetch in flight (dedupe)
  const keyOf = () => `${selRef.current.pair}|${selRef.current.size}`;

  const pushSnapshot = (q: QuoteSnapshot) => {
    quotesRef.current = q;
    if (seedKeyRef.current !== keyOf()) reseed(); // sync re-key — mixed buffers impossible
    const { pair, size } = selRef.current;
    for (const id of idsRef.current) {
      const r = rowFor(q, id, pair, size);
      if (!r) continue;
      // push each side independently: a one-sided quote (thin/backstop other
      // side, px 0) contributes only its real line — never a 0 that would wreck
      // the canvas price scale, and never a phantom spread into the percentiles.
      const s = (seriesRef.current[id] ??= { bid: [], ask: [] });
      if (r.bidPx > 0) { s.bid.push(r.bidPx); if (s.bid.length > N) s.bid.shift(); }
      if (r.askPx > 0) { s.ask.push(r.askPx); if (s.ask.length > N) s.ask.shift(); }
      // only a real, full-size two-sided quote feeds the spread distribution —
      // a partial (size-exhausted, filledFull=false) or one-sided quote is not
      // executable at the requested notional, so it must not skew the stats.
      if (!r.oneSided && r.filledFull && r.bidPx > 0 && r.askPx > 0) {
        const smp = (samplesRef.current[id] ??= []);
        smp.push(r.spreadBps);
        if (smp.length > 600) smp.shift();
      }
    }
  };

  // reseed the canvas buffers for the current pair/size: clear + a flat pre-fill
  // from the current matrix as an instant fallback, then replace it with the
  // server's REAL last-60s quote history as soon as it arrives (so the chart
  // never fabricates a flat minute — user feedback).
  const reseed = () => {
    const q = quotesRef.current;
    const ids = idsRef.current;
    seedKeyRef.current = keyOf();
    // Mutate the buffers IN PLACE (keep the seriesRef/samplesRef object references
    // stable) so `d.series` — captured in the api memo — can never point at a stale
    // pre-reseed object. Clear every buffer, drop de-registered venues, then refill.
    const S = seriesRef.current, SM = samplesRef.current;
    for (const id of ids) { const s = (S[id] ??= { bid: [], ask: [] }); s.bid.length = 0; s.ask.length = 0; (SM[id] ??= []).length = 0; }
    for (const id of Object.keys(S)) if (!ids.includes(id)) delete S[id];
    for (const id of Object.keys(SM)) if (!ids.includes(id)) delete SM[id];
    if (q) {
      const { pair, size } = selRef.current;
      for (const id of ids) {
        const r = rowFor(q, id, pair, size);
        if (!r) continue;
        for (let i = 0; i < N; i++) {
          // flat pre-fill fallback (no jitter) — holds the scale correct until the
          // real history lands; real streaming quotes step it (no smoothing).
          if (r.bidPx > 0) S[id].bid.push(r.bidPx);
          if (r.askPx > 0) S[id].ask.push(r.askPx);
        }
      }
    }
    void seedFromHistory(seedKeyRef.current);
  };

  // replace the flat pre-fill with the server's retained real quote ticks for
  // this (pair, size). Stale-guarded: a slow response for a pair the user has
  // already left is discarded (seedKey moved on).
  const seedFromHistory = async (key: string) => {
    if (seedFetchRef.current === key) return; // already fetching this key
    seedFetchRef.current = key;
    try {
      const [pair, sizeS] = key.split('|');
      const hist = await fetchQuoteHistory(pair, Number(sizeS));
      if (seedKeyRef.current !== key || !hist.length) return;
      const ids = new Set(idsRef.current);
      const S = seriesRef.current, SM = samplesRef.current;
      for (const id of idsRef.current) { const s = (S[id] ??= { bid: [], ask: [] }); s.bid.length = 0; s.ask.length = 0; (SM[id] ??= []).length = 0; }
      for (const q of hist) {
        for (const r of q.rows) {
          if (!ids.has(r.venueId)) continue;
          const s = (S[r.venueId] ??= { bid: [], ask: [] });
          if (r.bidPx > 0) { s.bid.push(r.bidPx); if (s.bid.length > N) s.bid.shift(); }
          if (r.askPx > 0) { s.ask.push(r.askPx); if (s.ask.length > N) s.ask.shift(); }
          if (!r.oneSided && r.filledFull && r.bidPx > 0 && r.askPx > 0) {
            const smp = (SM[r.venueId] ??= []);
            smp.push(r.spreadBps);
            if (smp.length > 600) smp.shift();
          }
        }
      }
      // The canvas indexes left→right with "now" at the right edge, so a short
      // ring (young server) must be LEFT-padded to the window: hold the earliest
      // observed value flat into the unobserved past, real data ends at now.
      for (const id of idsRef.current) {
        const s = S[id];
        if (s.bid.length && s.bid.length < N) s.bid.unshift(...Array(N - s.bid.length).fill(s.bid[0]));
        if (s.ask.length && s.ask.length < N) s.ask.unshift(...Array(N - s.ask.length).fill(s.ask[0]));
      }
      setFrame((f) => f + 1);
    } catch { /* flat pre-fill stays — the stream still steps it live */ }
    finally { if (seedFetchRef.current === key) seedFetchRef.current = ''; }
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
    const loadSnapshot = async () => {
      try {
        // markets snapshot + the persisted historical fills window (the tape /
        // markouts / leaderboard operate on real history, not a live buffer).
        // The tape only needs a recent window — leaderboard/outlier stats come
        // pre-aggregated from /api/leaderboard over the FULL window instead
        // (fetching 30d of raw fills silently truncated at the 20k cap).
        const [m, hist] = await Promise.all([
          fetchMarkets(),
          fetchFills(1, 5000).catch(() => null),
        ]);
        if (!mounted.v) return;
        setState(m.state); setQuotes(m.quotes); setVolume(m.volume);
        snapshotLoaded.v = true;
        adoptVenues(m.state.venues ?? []);
        // /api/fills is newest-first; store oldest-first so the cap in
        // upsertFill drops the genuine oldest, not the newest (audit B4).
        // Fills broadcast while the snapshot was in flight are NOT in the
        // response — re-apply them on top instead of discarding.
        const base = hist && hist.length ? [...hist].reverse() : m.fills;
        setFills(pendingFills.current.reduce((acc, f) => upsertFill(acc, f), base));
        pendingFills.current = [];
        quotesRef.current = m.quotes;
        reseed();
        setFrame((f) => f + 1);
      } catch { /* retried on the next WS connect */ }
    };
    loadSnapshot();

    const dispose = connectStream((msg) => {
      if (msg.ch === 'state') { setState(msg.data); adoptVenues(msg.data.venues ?? []); }
      else if (msg.ch === 'quotes') { setQuotes(msg.data); pushSnapshot(msg.data); setFrame((f) => f + 1); }
      else if (msg.ch === 'volume') { if (snapshotLoaded.v) setVolume((prev) => mergeDay(prev, msg.data)); }
      else if (msg.ch === 'fill') {
        if (!snapshotLoaded.v) pendingFills.current.push(msg.data);
        setFills((prev) => upsertFill(prev, msg.data));
      }
    }, (s) => {
      setConn(s);
      // mount already fetched the snapshot; re-fetch only after a DROP (missed
      // WS deltas), not on the initial open racing that first fetch.
      if (s === 'reconnecting') wasDropped.v = true;
      if (s === 'live' && wasDropped.v) { wasDropped.v = false; loadSnapshot(); }
    });

    return () => { mounted.v = false; dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // server-side leaderboard aggregates: fetch on tab entry + window change, then
  // poll every 30s while the tab is open (fills stream live, aggregates don't).
  const lbDays = LB_WIN_DAYS[ui.lbWin] ?? 1;
  useEffect(() => {
    if (ui.tab !== 'leaderboard') return;
    let on = true;
    const load = () => { fetchLeaderboard(lbDays).then((d) => { if (on) setLb(d); }).catch(() => { /* retried on the next poll */ }); };
    load();
    const id = setInterval(load, 30_000);
    return () => { on = false; clearInterval(id); };
  }, [ui.tab, lbDays]);
  // the Markouts tab's OUTLIER_FEED reads the 24h aggregate.
  useEffect(() => {
    if (ui.tab !== 'markouts') return;
    let on = true;
    const load = () => { fetchLeaderboard(1).then((d) => { if (on) setLbDay(d); }).catch(() => { /* retried on the next poll */ }); };
    load();
    const id = setInterval(load, 30_000);
    return () => { on = false; clearInterval(id); };
  }, [ui.tab]);
  // QUOTE_UPDATE_BURN accrues slowly (keeper cadence) — poll every 60s while
  // the Volume tab is open.
  useEffect(() => {
    if (ui.tab !== 'volume') return;
    let on = true;
    const load = () => { fetchGas().then((d) => { if (on) setGas(d); }).catch(() => { /* retried on the next poll */ }); };
    load();
    const id = setInterval(load, 60_000);
    return () => { on = false; clearInterval(id); };
  }, [ui.tab]);

  // reseed when the selected pair/size changes
  useEffect(() => { reseed(); setFrame((f) => f + 1); /* eslint-disable-next-line */ }, [ui.pair, ui.size]);
  // reseed when the venue registry changes (ids added/removed) so the buffers are
  // re-keyed and pre-filled for the new set before the next stream tick.
  useEffect(() => { reseed(); setFrame((f) => f + 1); /* eslint-disable-next-line */ }, [venueIds(state).join(',')]);

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
    series: seriesRef.current, samples: samplesRef.current,
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
    resetLb: () => setUi((s) => ({ ...s, lbWin: '24H', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbMk: 'MAKER', lbWinners: true, lbTop: 25 })),
  }), [ui, conn, state, quotes, volume, fills, lb, lbDay, gas, frame, venues, displayVenues, baselines, reference, references, referenceFor, venuesById]);

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
