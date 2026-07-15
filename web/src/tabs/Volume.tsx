import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyVolume } from '@shared';
import { useDashboard } from '../store';
import { C, pill, venueColor } from '../theme';
import { fMillions } from '../lib/format';

/** MM-DD from a 'YYYY-MM-DD' UTC day. */
const mmdd = (utcDay: string): string => utcDay.slice(5);

interface SeriesDef {
  id: string;
  name: string;
  color: string;
  val: (d: DailyVolume) => number;
  /** real per-source swap count for this series (no USD proration). */
  swaps: (d: DailyVolume) => number;
  /** first UTC day the venue existed (VenueMeta.sinceUtc) — per-day tooltips
   *  omit it before this date instead of showing a misleading "$0 / 0.0%". */
  since?: string;
}

/** which chart the pointer is over + the hovered day index within THAT chart's window. */
type HoverState = { c: 'daily' | 'burn' | 'cum' | 'ms'; i: number } | null;

const RANGE_PRESETS = ['7D', '14D', '30D', 'ALL'] as const;
const RANGE_DAYS: Record<string, number> = { '7D': 7, '14D': 14, '30D': 30 };
const MIN_WIN = 3; // brush minimum window (days), per the design

export function VolumeTab() {
  const d = useDashboard();
  // transient hover — local (never persisted); brush window lives in the store
  // so it survives tab switches (design keeps it in global state too).
  const [hover, setHover] = useState<HoverState>(null);
  // legend toggles — venues hidden from a chart's stacks (per chart, keyed by
  // venue id). The tables keep EVERY venue as the toggle surface; totals stay
  // full-window so the table remains the reference while the chart filters.
  const [hiddenVol, setHiddenVol] = useState<ReadonlySet<string>>(new Set());
  const [hiddenBurn, setHiddenBurn] = useState<ReadonlySet<string>>(new Set());
  const toggleIn = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };
  const brushRef = useRef<HTMLDivElement | null>(null);
  // active drag's window-listener cleanup — run on unmount so a mid-drag tab
  // switch can't leak window listeners.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanup.current?.(); }, []);

  const allDays = d.volume;
  const nAll = allDays.length;

  /** Resolve the visible window (design volWin): the hand-drawn brush window
   *  wins when `custom` is allowed; else the RANGE preset (ALL/CUSTOM → full). */
  const winFor = (custom: boolean): [number, number] => {
    const n = nAll;
    if (n <= 1) return [0, Math.max(0, n - 1)];
    if (custom && d.volStart != null && d.volEnd != null && n >= MIN_WIN + 1) {
      const s = Math.max(0, Math.min(n - 1 - MIN_WIN, d.volStart));
      return [s, Math.max(s + MIN_WIN, Math.min(n - 1, d.volEnd))];
    }
    const rangeN = RANGE_DAYS[d.volRange];
    return rangeN ? [Math.max(0, n - rangeN), n - 1] : [0, n - 1];
  };
  const [wS, wE] = winFor(true);   // daily chart + brush follow presets AND the brush
  // ONE window below the KPI tiles: cumulative, market-share, the daily legend
  // and the venue breakdown all follow the same selected range (presets AND the
  // hand-drawn brush). Only the top tiles keep all-time/7d/today semantics.
  const [pS, pE] = winFor(true);

  const setWin = (s: number, e: number) => {
    d.set('volStart', s); d.set('volEnd', e); d.set('volRange', 'CUSTOM');
    setHover(null);
  };
  const pickRange = (r: string) => {
    d.set('volRange', r); d.set('volStart', null); d.set('volEnd', null);
    setHover(null);
  };

  // ── brush interactions (port of the design's brushDown): edge-grab resizes,
  // inside-grab pans, outside-click re-centers then pans from the NEW window.
  const brushDown = (e: React.MouseEvent) => {
    const el = brushRef.current;
    if (!el || nAll < MIN_WIN + 1) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const n = nAll;
    const [s0, e0] = winFor(true);
    const fr = (e.clientX - r.left) / r.width;
    const fs = s0 / (n - 1), fe = e0 / (n - 1);
    const grab = Math.max(0.02, 9 / r.width); // ~9px edge-handle tolerance
    let mode: 'move' | 'l' | 'r' = 'move';
    let ds = s0, de = e0;
    if (Math.abs(fr - fs) < grab) mode = 'l';
    else if (Math.abs(fr - fe) < grab) mode = 'r';
    else if (fr < fs || fr > fe) {
      // jump: re-center the window at the click, then pan from the NEW window
      // (not stale state — avoids a jump on the first move).
      const w = e0 - s0, half = Math.round(w / 2);
      const c = Math.round(fr * (n - 1));
      ds = Math.max(0, Math.min(n - 1 - w, c - half));
      de = ds + w;
      setWin(ds, de);
    }
    const drag = { mode, fr0: fr, s0: ds, e0: de };
    let cur: [number, number] = [ds, de];
    const mv = (ev: MouseEvent) => {
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const di = Math.round((f - drag.fr0) * (n - 1));
      let s = drag.s0, en = drag.e0;
      if (drag.mode === 'move') { const w = drag.e0 - drag.s0; s = Math.max(0, Math.min(n - 1 - w, drag.s0 + di)); en = s + w; }
      else if (drag.mode === 'l') { s = Math.max(0, Math.min(drag.e0 - MIN_WIN, drag.s0 + di)); }
      else { en = Math.max(drag.s0 + MIN_WIN, Math.min(n - 1, drag.e0 + di)); }
      if (s !== cur[0] || en !== cur[1]) { cur = [s, en]; setWin(s, en); }
    };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); dragCleanup.current = null; };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    dragCleanup.current = up;
  };

  const vm = useMemo(() => {
    const nd = nAll;
    // market-share in-chart labels: cream over the saturated bands in bright, the band color in dark.
    const msLabelColor = (bandColor: string) => (d.theme === 'light' ? 'rgb(252,251,248)' : bandColor);

    // propAMM venues from the registry — one series per role==='venue' venue.
    // Colors, names and ids all come from state.venues (nothing hardcoded).
    const series: SeriesDef[] = d.displayVenues.map((v) => ({
      id: v.id,
      name: v.name,
      color: venueColor(v, d.theme),
      val: (x) => x.byVenue[v.id]?.usd ?? 0,
      swaps: (x) => x.byVenue[v.id]?.swaps ?? 0,
      since: v.sinceUtc,
    }));
    // a venue belongs in a DAY-scoped row only from its first day of existence:
    // "$0" is honest for a live-but-quiet venue, misleading for one not deployed yet.
    const existsOn = (s: SeriesDef, x: DailyVolume) => !s.since || x.utcDay >= s.since;

    const f = (m: number) => fMillions(m);

    // first UTC day this venue recorded any notional (venue-agnostic; '—' if none).
    const firstActive = (s: SeriesDef): string => {
      for (const x of allDays) if (s.val(x) > 0) return x.utcDay;
      return '—';
    };
    // earliest first-active across shown venues — the "since" / total-row anchor.
    const earliestActive = (): string => {
      const fs = series.map(firstActive).filter((x) => x !== '—').sort();
      return fs[0] ?? '—';
    };

    const scopeNote = "USD-stable quote leg of each landed swap · today's bucket is partial";

    // empty-state: render placeholder zeros, no crash (also the pre-registry case
    // where displayVenues is still []).
    if (nd === 0 || series.length === 0) {
      return {
        volBars: [] as { op: number; segs: { h: string; color: string }[]; bg: string; onEnter: () => void }[],
        volMaxLabel: f(0), volMidLabel: f(0),
        volAxis: [] as { label: string; left: string }[],
        kAll: f(0), k7: f(0), k7chg: '▲ 0%', k7css: C.green,
        kSwaps: '0', kPeak: f(0), kPeakDay: '—',
        kToday: f(0), kTodayChg: '▲ 0%', kTodaycss: C.green,
        since: '—',
        legRows: series.map((s) => ({ id: s.id, name: s.name, color: s.color, vol: f(0), share: '0.0%', hidden: false })),
        legTotal: f(0), cumLine: '', cumArea: '', cumVenueLines: [] as { color: string; path: string }[], cumSigma: f(0),
        rangeLabel: 'ALL-TIME', rangeCaption: '',
        msBands: [] as { path: string; color: string }[],
        msTopName: '—', msTopPct: '0.0%', msTopColor: msLabelColor(C.faint2),
        msBotName: '—', msBotPct: '0.0%', msBotColor: msLabelColor(C.faint2),
        brk: [] as { name: string; color: string; vol: string; share: string; shareW: string; swaps: string; peakV: string; peakDay: string; first: string }[],
        brkTotalVol: f(0), brkTotalSwaps: '0',
        volScopeNote: scopeNote,
        ndPreset: 0,
        dailyTip: null as null | { left: string; date: string; total: string; rows: { name: string; color: string; val: string }[] },
        cumTip: null as null | { left: string; guide: string; date: string; cum: string; day: string; rows: { name: string; color: string; cum: string }[] },
        msTip: null as null | { left: string; guide: string; date: string; rows: { name: string; color: string; pct: string; val: string }[] },
        brushBars: [] as { h: string; color: string }[],
        brushLeft: '0', brushWidth: '100', brushStartLbl: '—', brushEndLbl: '—',
        hasBurn: false,
        burnBars: [] as { op: number; segs: { h: string; color: string }[]; bg: string; onEnter: () => void }[],
        burnMaxLabel: '0 MON', burnMidLabel: '0 MON',
        burnTip: null as null | { left: string; date: string; total: string; usd: string; rows: { name: string; color: string; val: string }[] },
        burnRows: [] as { id: string; name: string; color: string; burn: string; updates: string; hidden: boolean }[],
        burnTotal: '0 MON', burnUpdatesTotal: '0', burnColHdr: 'ALL-TIME BURN', burnPerM: '0',
      };
    }

    const dayTotal = (x: DailyVolume) => series.reduce((a, s) => a + s.val(x), 0);

    // ── windowed slices: daily chart follows the brush; cum/ms follow presets only.
    const wDays = allDays.slice(wS, wE + 1);
    const ndW = wDays.length;
    const pDays = allDays.slice(pS, pE + 1);
    const ndP = pDays.length;

    // chart-only subset: legend-hidden venues drop out of the stacks and the
    // y-scale renormalizes; every OTHER consumer (KPIs, cum/ms, breakdown)
    // stays full-series — the toggle is a lens, not a data filter.
    const volShown = series.filter((s) => !hiddenVol.has(s.id));
    const shownTotal = (x: DailyVolume) => volShown.reduce((a, s) => a + s.val(x), 0);
    const maxT = Math.max(...wDays.map(shownTotal)) || 1;
    const H = 150;
    const hv = hover;
    const hiW = hv && hv.c === 'daily' ? Math.min(hv.i, ndW - 1) : -1;
    const hiP = hv && hv.c !== 'daily' ? Math.min(hv.i, ndP - 1) : -1;
    const volBars = wDays.map((x, i) => ({
      op: x.partial ? 0.5 : 1,
      segs: volShown.map((s) => ({ h: (s.val(x) / maxT * H).toFixed(1), color: s.color })),
      // full-height accent wash behind the hovered day's stack
      bg: hiW === i ? 'var(--accent-dim)' : 'transparent',
      onEnter: () => setHover({ c: 'daily', i }),
    }));

    // ── KPI tiles stay FULL-history (all-time / trailing-7d / today semantics);
    // everything below them — legend, breakdown, all three charts — follows the
    // SELECTED window so the page reads as one coherent range.
    const allTot = allDays.reduce((a, x) => a + dayTotal(x), 0);
    const isFullWindow = wS === 0 && wE === nd - 1;
    const rangeLabel = isFullWindow ? 'ALL-TIME' : 'WINDOW';
    const rangeCaption = isFullWindow ? '' : `${mmdd(wDays[0].utcDay)} → ${mmdd(wDays[ndW - 1].utcDay)}`;
    const winEndDay = wDays[ndW - 1].utcDay;
    // window totals per venue — venues that didn't EXIST during any part of the
    // window are omitted (same honesty rule as the per-day tooltips).
    const winSeries = series.filter((s) => !s.since || s.since <= winEndDay);
    const totals = winSeries.map((s) => ({ id: s.id, name: s.name, color: s.color, tot: wDays.reduce((a, x) => a + s.val(x), 0) }));
    const winTot = totals.reduce((a, t) => a + t.tot, 0);
    const share = (x: number) => (winTot ? (x / winTot * 100) : 0).toFixed(1) + '%';

    const aTot = allDays.map(dayTotal);
    // real trailing 7-calendar-day windows anchored on the latest day present —
    // NOT the last 7 *recorded* rows, which skip dormant (zero-volume) days and
    // so silently stretch each "week" across a longer span.
    const anchor = allDays[nd - 1].utcDay;
    const dayAgo = (n: number) =>
      new Date(new Date(anchor + 'T00:00:00Z').getTime() - n * 86_400_000).toISOString().slice(0, 10);
    const c7 = dayAgo(7), c14 = dayAgo(14);
    const last7 = allDays.filter((x) => x.utcDay > c7 && x.utcDay <= anchor).reduce((a, x) => a + dayTotal(x), 0);
    const prev7 = allDays.filter((x) => x.utcDay > c14 && x.utcDay <= c7).reduce((a, x) => a + dayTotal(x), 0);
    // % vs the prior week; null when the prior week had no volume (base 0 → % undefined)
    const chg7 = prev7 > 0 ? (last7 - prev7) / prev7 * 100 : null;

    let peakV = -1, peakDay = '';
    allDays.forEach((x, i) => { if (aTot[i] > peakV) { peakV = aTot[i]; peakDay = mmdd(x.utcDay); } });

    const todayT = aTot[nd - 1], prevT = aTot[nd - 2];
    // % vs prev day; null when the base is 0/absent (▲ ∞%, matching chg7)
    const todayChg = prevT ? (todayT - prevT) / prevT * 100 : null;

    // KPI "total swaps" sums the real per-venue swap counts across shown venues
    // (no USD proration); seeded days that carry usd but swaps:0 add nothing here.
    const swaps = allDays.reduce((a, x) => a + series.reduce((b, s) => b + s.swaps(x), 0), 0);
    const since = earliestActive();

    // ── cumulative + market-share (preset window) ──────────────────────────────
    const pTot = pDays.map(dayTotal);
    const W = 1000, HC = 260;
    let cum = 0;
    const pts = pDays.map((_, i) => { cum += pTot[i]; return [ndP > 1 ? i / (ndP - 1) * W : 0, cum] as [number, number]; });
    const cy = (y: number) => (cum ? HC - y / cum * HC : HC); // zero window ⇒ flat at the BOTTOM
    const cumLine = 'M' + pts.map((p) => p[0].toFixed(1) + ',' + cy(p[1]).toFixed(1)).join(' L');
    const cumArea = cumLine + ' L' + W + ',' + HC + ' L0,' + HC + ' Z';
    // per-venue cumulative lines on the SAME y-scale as the total. Each line
    // starts at the venue's first day of existence in the window (honest
    // absence — no flat fabricated-zero segment before the venue was live).
    const cumVenue = series.map((s2) => {
      let c2 = 0;
      const vpts: [number, number][] = [];
      pDays.forEach((x, i) => {
        if (!existsOn(s2, x)) return;
        c2 += s2.val(x);
        vpts.push([ndP > 1 ? i / (ndP - 1) * W : 0, c2]);
      });
      return { name: s2.name, color: s2.color, cum: c2, pts: vpts };
    });
    const cumVenueLines = cumVenue.filter((v) => v.pts.length > 1 && v.cum > 0).map((v) => ({
      color: v.color,
      path: 'M' + v.pts.map((pt) => pt[0].toFixed(1) + ',' + cy(pt[1]).toFixed(1)).join(' L'),
    }));

    const xs = (i: number) => (ndP > 1 ? i / (ndP - 1) * W : 0);
    const bands = series.map(() => ({ top: [] as [number, number][], bot: [] as [number, number][] }));
    pDays.forEach((x, i) => {
      const t = pTot[i] || 1;
      let below = 0;
      for (let k = 0; k < series.length; k++) {
        const fr = series[k].val(x) / t;
        bands[k].bot.push([xs(i), HC * (1 - below)]);
        bands[k].top.push([xs(i), HC * (1 - below - fr)]);
        below += fr;
      }
    });
    const band = (top: [number, number][], bot: [number, number][]) =>
      'M' + top.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L')
      + ' L' + bot.slice().reverse().map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') + ' Z';
    const msBands = series.map((s, k) => ({ path: band(bands[k].top, bands[k].bot), color: s.color }));

    const lt = pTot[ndP - 1] || 1;
    const pPeak = (s: SeriesDef) => {
      let pv = -1, pd = '';
      wDays.forEach((x) => { const v = s.val(x); if (v > pv) { pv = v; pd = mmdd(x.utcDay); } });
      return { v: f(pv), day: pd };
    };
    // real per-source swap counts (no USD proration): each venue counts its own takes.
    const brkSwaps = winSeries.map((s) => wDays.reduce((a, x) => a + s.swaps(x), 0));
    const brkSwapTotal = brkSwaps.reduce((a, b) => a + b, 0);
    const brk = winSeries.map((s, k) => {
      const tot = totals[k].tot;
      const pk = pPeak(s);
      // first day IN THE WINDOW with any notional (the venue's true first-active
      // still anchors the all-time tile's "since" line).
      const firstInWin = wDays.find((x) => s.val(x) > 0)?.utcDay ?? '—';
      return {
        name: s.name, color: s.color, vol: f(tot), share: share(tot),
        shareW: (winTot ? tot / winTot * 100 : 0).toFixed(1),
        swaps: brkSwaps[k].toLocaleString(),
        peakV: pk.v, peakDay: pk.day,
        first: firstInWin,
      };
    });

    const axis = [0, Math.floor(ndW * 0.25), Math.floor(ndW * 0.5), Math.floor(ndW * 0.75), ndW - 1]
      .map((i) => ({ label: mmdd(wDays[i].utcDay), left: (ndW > 1 ? i / (ndW - 1) * 100 : 0).toFixed(1) + '%' }));

    // ── hover tooltips (design: clamp x so the tip never clips the panel) ──────
    const tipLeft = (i: number, n: number) => Math.max(9, Math.min(88, ((i + 0.5) / n) * 100)).toFixed(1);
    const guideLeft = (i: number, n: number) => (n > 1 ? (i / (n - 1)) * 100 : 0).toFixed(1);
    const dateOf = (x: DailyVolume) => x.utcDay + (x.partial ? ' (today, partial)' : '');
    let dailyTip = null, cumTip = null, msTip = null;
    if (hiW >= 0) {
      const x = wDays[hiW];
      dailyTip = {
        left: tipLeft(hiW, ndW), date: dateOf(x), total: f(shownTotal(x)),
        rows: volShown.filter((s) => existsOn(s, x)).map((s) => ({ name: s.name, color: s.color, val: f(s.val(x)) })),
      };
    } else if (hiP >= 0) {
      const x = pDays[hiP];
      if (hv!.c === 'cum') {
        let c2 = 0; for (let k = 0; k <= hiP; k++) c2 += pTot[k];
        const rows = series.filter((s2) => existsOn(s2, x)).map((s2) => {
          let cv = 0;
          for (let k = 0; k <= hiP; k++) if (existsOn(s2, pDays[k])) cv += s2.val(pDays[k]);
          return { name: s2.name, color: s2.color, cum: f(cv) };
        }).filter((r2) => r2.cum !== f(0));
        cumTip = { left: tipLeft(hiP, ndP), guide: guideLeft(hiP, ndP), date: dateOf(x), cum: f(c2), day: f(pTot[hiP]), rows };
      } else {
        const t = pTot[hiP] || 1;
        msTip = {
          left: tipLeft(hiP, ndP), guide: guideLeft(hiP, ndP), date: dateOf(x),
          rows: series.filter((s) => existsOn(s, x)).map((s) => ({ name: s.name, color: s.color, pct: (s.val(x) / t * 100).toFixed(1) + '%', val: f(s.val(x)) })),
        };
      }
    }

    // ── QUOTE_UPDATE_BURN (MON, not USD): the gas each venue's own keeper
    // spends keeping quotes fresh. Same window + x-domain as the daily chart
    // (reuses volAxis, no brush of its own). Venues appear only when the
    // server tracks a series for them — a venue that doesn't self-fund its
    // price updates (external oracle / taker-paid JIT) has no row, on purpose.
    const gasByDay = new Map((d.gas?.days ?? []).map((g) => [g.utcDay, g.byVenue]));
    const approx = new Set(d.gas?.approx ?? []);
    const gasVenueIds = new Set<string>();
    for (const g of d.gas?.days ?? []) for (const vid of Object.keys(g.byVenue)) gasVenueIds.add(vid);
    const burnSeries = series.filter((s) => gasVenueIds.has(s.id));
    const hasBurn = burnSeries.length > 0;
    const gVal = (utc: string, vid: string) => gasByDay.get(utc)?.[vid]?.mon ?? 0;
    const gTxs = (utc: string, vid: string) => gasByDay.get(utc)?.[vid]?.txs ?? 0;
    const fMON = (m: number) => (m >= 1000 ? (m / 1000).toFixed(1) + 'K' : Math.round(m).toLocaleString()) + ' MON';
    const burnShown = burnSeries.filter((s) => !hiddenBurn.has(s.id));
    const bTot = wDays.map((x) => burnShown.reduce((a, s) => a + gVal(x.utcDay, s.id), 0));
    const bMax = Math.max(...bTot, 0) || 1;
    const hiB = hv && hv.c === 'burn' ? Math.min(hv.i, ndW - 1) : -1;
    const burnBars = wDays.map((x, i) => ({
      op: x.partial ? 0.5 : 1,
      segs: burnShown.filter((s) => gVal(x.utcDay, s.id) > 0).map((s) => ({ h: (gVal(x.utcDay, s.id) / bMax * H).toFixed(1), color: s.color })),
      bg: hiB === i ? 'var(--accent-dim)' : 'transparent',
      onEnter: () => setHover({ c: 'burn', i }),
    }));
    let burnTip = null;
    if (hiB >= 0) {
      const x = wDays[hiB];
      const monUsd = d.state?.monUsd ?? 0;
      burnTip = {
        left: tipLeft(hiB, ndW), date: dateOf(x),
        rows: burnShown.filter((s) => gVal(x.utcDay, s.id) > 0)
          .map((s) => ({ name: s.name, color: s.color, val: (approx.has(s.id) ? '≈' : '') + gVal(x.utcDay, s.id).toFixed(1) + ' MON' })),
        total: Math.round(bTot[hiB]).toLocaleString() + ' MON',
        usd: monUsd > 0 ? '~$' + (bTot[hiB] * monUsd).toFixed(0) : '',
      };
    }
    const burnRows = burnSeries.map((s) => {
      const tot = wDays.reduce((a, x) => a + gVal(x.utcDay, s.id), 0);
      const ups = wDays.reduce((a, x) => a + gTxs(x.utcDay, s.id), 0);
      return { id: s.id, name: s.name, color: s.color, burn: (approx.has(s.id) ? '≈' : '') + fMON(tot), updates: ups.toLocaleString(), hidden: hiddenBurn.has(s.id) };
    });
    const burnTotal = burnSeries.reduce((a, s) => a + wDays.reduce((x, y) => x + gVal(y.utcDay, s.id), 0), 0);
    const burnUpdatesTotal = burnSeries.reduce((a, s) => a + wDays.reduce((x, y) => x + gTxs(y.utcDay, s.id), 0), 0);
    // burn per $1M of volume, over only the days that HAVE a gas series — the
    // burn history is deliberately shallow (~30d), so dividing by the window's
    // FULL volume would understate the ratio on wide windows.
    const volOnGasDays = wDays.reduce((a, x) => a + (gasByDay.has(x.utcDay) ? dayTotal(x) : 0), 0);
    const burnPerM = volOnGasDays > 0 ? (burnTotal / (volOnGasDays / 1e6)).toFixed(1) : '0';

    // ── brush / minimap: the FULL history as miniature total bars, window-tinted.
    const aMax = Math.max(...aTot) || 1;
    const brushBars = allDays.map((x, i) => ({
      h: Math.max(4, aTot[i] / aMax * 100).toFixed(1), // min height so quiet days stay visible
      color: i >= wS && i <= wE ? 'var(--accent)' : 'var(--faint2)',
    }));
    const brushLeft = (nd > 1 ? wS / (nd - 1) * 100 : 0).toFixed(2);
    const brushWidth = Math.max(1.5, nd > 1 ? (wE - wS) / (nd - 1) * 100 : 100).toFixed(2);
    const brushStartLbl = mmdd(allDays[wS].utcDay);
    const brushEndLbl = mmdd(allDays[wE].utcDay) + (allDays[wE].partial ? ' · now' : '');

    return {
      volBars, volMaxLabel: f(maxT), volMidLabel: f(maxT / 2), volAxis: axis,
      kAll: f(allTot), k7: f(last7),
      k7chg: chg7 == null ? (last7 > 0 ? '▲ ∞%' : '▲ 0%') : (chg7 >= 0 ? '▲ ' : '▼ ') + Math.abs(chg7).toFixed(0) + '%',
      k7css: chg7 == null ? (last7 > 0 ? C.green : C.faint2) : (chg7 >= 0 ? C.green : C.red),
      kSwaps: swaps.toLocaleString(), kPeak: f(peakV), kPeakDay: peakDay,
      kToday: f(todayT),
      kTodayChg: todayChg == null ? (todayT > 0 ? '▲ ∞%' : '▲ 0%') : (todayChg >= 0 ? '▲ ' : '▼ ') + Math.abs(todayChg).toFixed(0) + '%',
      kTodaycss: todayChg == null ? (todayT > 0 ? C.green : C.faint2) : (todayChg >= 0 ? C.green : C.red),
      since,
      legRows: totals.map((t) => ({ id: t.id, name: t.name, color: t.color, vol: f(t.tot), share: share(t.tot), hidden: hiddenVol.has(t.id) })),
      legTotal: f(winTot), cumLine, cumArea, cumVenueLines, cumSigma: f(cum || winTot),
      rangeLabel, rangeCaption,
      msBands,
      msTopName: series[series.length - 1].name,
      msTopPct: (series[series.length - 1].val(pDays[ndP - 1]) / lt * 100).toFixed(1) + '%',
      msTopColor: msLabelColor(series[series.length - 1].color),
      msBotName: series[0].name,
      msBotPct: (series[0].val(pDays[ndP - 1]) / lt * 100).toFixed(1) + '%',
      msBotColor: msLabelColor(series[0].color),
      brk, brkTotalVol: f(winTot), brkTotalSwaps: brkSwapTotal.toLocaleString(),
      volScopeNote: scopeNote,
      ndPreset: ndP,
      dailyTip, cumTip, msTip,
      brushBars, brushLeft, brushWidth, brushStartLbl, brushEndLbl,
      hasBurn, burnBars,
      burnMaxLabel: fMON(bMax), burnMidLabel: fMON(bMax / 2),
      burnTip, burnRows,
      burnTotal: fMON(burnTotal), burnUpdatesTotal: burnUpdatesTotal.toLocaleString(),
      burnColHdr: `${rangeLabel} BURN`, burnPerM,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.volume, d.gas, d.theme, d.displayVenues, wS, wE, pS, pE, hover, hiddenVol, hiddenBurn]);

  // svg charts: cursor-x → nearest day index (round(frac × (n−1))); only
  // re-render when the index or chart changes, not on every mousemove pixel.
  const svgHover = (chart: 'cum' | 'ms') => (e: React.MouseEvent) => {
    const n = vm.ndPreset;
    if (!n) return;
    const r = e.currentTarget.getBoundingClientRect();
    const fr = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const i = Math.round(fr * (n - 1));
    if (!hover || hover.c !== chart || hover.i !== i) setHover({ c: chart, i });
  };
  const leave = () => { if (hover) setHover(null); };

  // shared tooltip chrome (theme overlay bg, bordered, never intercepts the mouse)
  const tipBox: React.CSSProperties = {
    position: 'absolute', transform: 'translateX(-50%)', background: C.overlay,
    border: `1px solid ${C.line}`, padding: '8px 10px', zIndex: 10, pointerEvents: 'none',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 18px 14px' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em', color: C.text }}>PROPAMM VOLUME</div>
          <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 760 }}>
            All-time daily notional traded on tracked propAMM venues, split by venue. Volume is the USD-stable quote leg of each landed swap; buckets are UTC days and today's bucket is partial.
          </div>
        </div>
        {/* RANGE presets — quick windows for the charts; the brush sets CUSTOM (none lit). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: C.dim3 }}>
          <span style={{ color: C.faint2, letterSpacing: '.06em' }}>RANGE</span>
          <div style={{ display: 'flex', gap: 3 }}>
            {RANGE_PRESETS.map((r) => (
              <button key={r} type="button" aria-pressed={d.volRange === r} onClick={() => pickRange(r)} style={pill(d.volRange === r, true)}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 0, border: `1px solid ${C.line}`, margin: '0 18px 14px' }}>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>ALL-TIME VOLUME</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kAll}</div>
          <div style={{ fontSize: 10, color: C.faint2, marginTop: 6 }}>since {vm.since}</div>
        </div>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>7D VOLUME</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.k7}</div>
          <div style={{ fontSize: 10, marginTop: 6, color: vm.k7css }}>{vm.k7chg} <span style={{ color: C.faint2 }}>vs prior 7d</span></div>
        </div>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>INDEXED SWAPS</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kSwaps}</div>
          <div style={{ fontSize: 10, color: C.faint2, marginTop: 6 }} title="On-chain swaps decoded forward + reconciled from retained fills, across tracked venues. Seeded history may carry volume but no per-swap count, so it isn't included here.">tracked venues · indexed</div>
        </div>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>PEAK DAY</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kPeak}</div>
          <div style={{ fontSize: 10, color: C.faint2, marginTop: 6 }}>{vm.kPeakDay}</div>
        </div>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>TODAY (PARTIAL)</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kToday}</div>
          <div style={{ fontSize: 10, marginTop: 6, color: vm.kTodaycss }}>{vm.kTodayChg} <span style={{ color: C.faint2 }}>vs prev day</span></div>
        </div>
      </div>

      {/* DAILY_VOLUME */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
          <span style={{ color: C.purple }}>~</span> <span style={{ color: C.text, fontWeight: 600 }}>DAILY_VOLUME</span> <span style={{ color: C.faint }}>USD notional by venue · UTC days · {vm.volScopeNote}</span>
        </div>
        {/* flex row: the bars end where the summary column begins, so the newest
            (right-most) bars never render underneath it — no absolute overlay. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '16px 18px 8px' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <div style={{ position: 'absolute', top: -2, left: 0, fontSize: 8.5, color: C.faint2 }}>{vm.volMaxLabel}</div>
            <div style={{ position: 'absolute', top: 72, left: 0, fontSize: 8.5, color: C.faint2 }}>{vm.volMidLabel}</div>
            <div onMouseLeave={leave} style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 150, paddingLeft: 42, borderBottom: `1px solid ${C.line}` }}>
              {vm.volBars.map((b, i) => (
                // stretch + column-reverse: segments anchor at the bottom while the
                // container fills the plot height — the hover wash + hit-target span
                // the full column, not just the stack.
                <div key={i} onMouseEnter={b.onEnter}
                  style={{ display: 'flex', flexDirection: 'column-reverse', justifyContent: 'flex-start', alignSelf: 'stretch', flex: 1, gap: 1, opacity: b.op, background: b.bg }}>
                  {b.segs.map((s, j) => <div key={j} style={{ height: `${s.h}px`, background: s.color }} />)}
                </div>
              ))}
            </div>
            {vm.dailyTip && (
              <div style={{ ...tipBox, top: 12, left: `${vm.dailyTip.left}%`, minWidth: 168 }}>
                <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line2}` }}>{vm.dailyTip.date}</div>
                {vm.dailyTip.rows.map((r) => (
                  <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, padding: '4px 0 0' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                    <span style={{ color: C.text2 }}>{r.name}</span>
                    <span style={{ marginLeft: 'auto', color: C.text }}>{r.val}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', fontSize: 10.5, paddingTop: 5, marginTop: 5, borderTop: `1px solid ${C.line2}` }}>
                  <span style={{ color: C.dim }}>TOTAL</span><span style={{ marginLeft: 'auto', color: C.text, fontWeight: 600 }}>{vm.dailyTip.total}</span>
                </div>
              </div>
            )}
            <div style={{ position: 'relative', height: 14, marginTop: 4, marginLeft: 42 }}>
              {vm.volAxis.map((a, i) => (
                <div key={i} style={{ position: 'absolute', left: a.left, transform: 'translateX(-50%)', fontSize: 8.5, color: C.faint2 }}>{a.label}</div>
              ))}
            </div>
            {/* timeline brush: full history minimap — drag inside to pan, edges to resize, click outside to jump */}
            <div ref={brushRef} onMouseDown={brushDown}
              style={{ position: 'relative', height: 40, margin: '12px 2px 2px 42px', border: `1px solid ${C.line2}`, background: C.panel, cursor: 'grab', userSelect: 'none' }}>
              <div style={{ position: 'absolute', left: 3, right: 3, top: 3, bottom: 3, display: 'flex', alignItems: 'flex-end', gap: 1, pointerEvents: 'none' }}>
                {vm.brushBars.map((b, i) => <div key={i} style={{ flex: 1, height: `${b.h}%`, background: b.color, opacity: 0.55 }} />)}
              </div>
              <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${vm.brushLeft}%`, width: `${vm.brushWidth}%`, background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', pointerEvents: 'none' }}>
                <div style={{ position: 'absolute', left: -3, top: '50%', transform: 'translateY(-50%)', width: 5, height: 18, background: 'var(--accent)', borderRadius: 2 }} />
                <div style={{ position: 'absolute', right: -3, top: '50%', transform: 'translateY(-50%)', width: 5, height: 18, background: 'var(--accent)', borderRadius: 2 }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', margin: '4px 2px 0 42px', fontSize: 8.5, color: C.faint2 }}>
              <span>window: {vm.brushStartLbl} → {vm.brushEndLbl}</span>
              <span>drag to pan · edges to resize · click outside to jump</span>
            </div>
          </div>
          {/* summary table — a real column now (was an absolute overlay hiding the newest bars) */}
          <div style={{ flex: 'none', width: 248, background: C.overlay, border: `1px solid ${C.line}`, padding: '8px 10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 44px', gap: '3px 8px', fontSize: 8.5, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line}` }}>
              <div>VENUE</div><div style={{ textAlign: 'right' }}>{vm.rangeLabel}</div><div style={{ textAlign: 'right' }}>SHARE</div>
            </div>
            {vm.legRows.map((r) => (
              <button key={r.id} type="button" aria-pressed={!r.hidden}
                title={r.hidden ? 'show in chart' : 'hide from chart'}
                onClick={() => setHiddenVol((h) => toggleIn(h, r.id))}
                style={{ display: 'grid', gridTemplateColumns: '1fr 70px 44px', gap: '3px 8px', fontSize: 10.5, padding: '4px 0', alignItems: 'center', width: '100%', cursor: 'pointer', opacity: r.hidden ? 0.4 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: r.hidden ? 'transparent' : r.color, border: `1px solid ${r.color}`, flex: 'none' }} />
                  <span style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, textDecoration: r.hidden ? 'line-through' : 'none' }}>{r.name}</span>
                </div>
                <div style={{ textAlign: 'right', color: C.text }}>{r.vol}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{r.share}</div>
              </button>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 44px', gap: '3px 8px', fontSize: 10.5, paddingTop: 6, marginTop: 3, borderTop: `1px solid ${C.line}` }}>
              <div style={{ color: C.dim3 }}>TOTAL</div>
              <div style={{ textAlign: 'right', color: C.text, fontWeight: 600 }}>{vm.legTotal}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>100%</div>
            </div>
            <div style={{ fontSize: 8.5, color: C.faint2, marginTop: 5, textAlign: 'right' }}>click a venue to hide/show it in the chart</div>
          </div>
        </div>
      </div>

      {/* QUOTE_UPDATE_BURN — same window + x-domain as DAILY_VOLUME (no brush of
          its own; the one above is the page's single range control). Rendered
          only once the server has a burn series for at least one venue. */}
      {vm.hasBurn && (
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
          <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>~</span> <span style={{ color: C.text, fontWeight: 600 }}>QUOTE_UPDATE_BURN</span> <span style={{ color: C.faint }}>gas burned keeping quotes fresh · MON · UTC days · tracked venues</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '16px 18px 8px' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
              <div style={{ position: 'absolute', top: -2, left: 0, fontSize: 8.5, color: C.faint2 }}>{vm.burnMaxLabel}</div>
              <div style={{ position: 'absolute', top: 72, left: 0, fontSize: 8.5, color: C.faint2 }}>{vm.burnMidLabel}</div>
              <div onMouseLeave={leave} style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 150, paddingLeft: 42, borderBottom: `1px solid ${C.line}` }}>
                {vm.burnBars.map((b, i) => (
                  <div key={i} onMouseEnter={b.onEnter}
                    style={{ display: 'flex', flexDirection: 'column-reverse', justifyContent: 'flex-start', alignSelf: 'stretch', flex: 1, gap: 1, opacity: b.op, background: b.bg }}>
                    {b.segs.map((s, j) => <div key={j} style={{ height: `${s.h}px`, background: s.color }} />)}
                  </div>
                ))}
              </div>
              {vm.burnTip && (
                <div style={{ ...tipBox, top: 12, left: `${vm.burnTip.left}%`, minWidth: 180 }}>
                  <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line2}` }}>{vm.burnTip.date}</div>
                  {vm.burnTip.rows.map((r) => (
                    <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, padding: '4px 0 0' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                      <span style={{ color: C.text2 }}>{r.name}</span>
                      <span style={{ marginLeft: 'auto', color: C.text }}>{r.val}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 10.5, paddingTop: 5, marginTop: 5, borderTop: `1px solid ${C.line2}` }}>
                    <span style={{ color: C.dim }}>TOTAL</span>
                    <span style={{ marginLeft: 'auto', color: C.text, fontWeight: 600 }}>{vm.burnTip.total}</span>
                    {vm.burnTip.usd && <span style={{ color: C.faint, fontSize: 9, marginLeft: 6 }}>{vm.burnTip.usd}</span>}
                  </div>
                </div>
              )}
              <div style={{ position: 'relative', height: 14, marginTop: 4, marginLeft: 42 }}>
                {vm.volAxis.map((a, i) => (
                  <div key={i} style={{ position: 'absolute', left: a.left, transform: 'translateX(-50%)', fontSize: 8.5, color: C.faint2 }}>{a.label}</div>
                ))}
              </div>
            </div>
            {/* summary column — VENUE / window burn / update-tx counts */}
            <div style={{ flex: 'none', width: 272, background: C.overlay, border: `1px solid ${C.line}`, padding: '8px 10px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 66px', gap: '3px 8px', fontSize: 8.5, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line}` }}>
                <div>VENUE</div><div style={{ textAlign: 'right' }}>{vm.burnColHdr}</div><div style={{ textAlign: 'right' }}>UPDATES</div>
              </div>
              {vm.burnRows.map((r) => (
                <button key={r.id} type="button" aria-pressed={!r.hidden}
                  title={r.hidden ? 'show in chart' : 'hide from chart'}
                  onClick={() => setHiddenBurn((h) => toggleIn(h, r.id))}
                  style={{ display: 'grid', gridTemplateColumns: '1fr 84px 66px', gap: '3px 8px', fontSize: 10.5, padding: '4px 0', alignItems: 'center', width: '100%', cursor: 'pointer', opacity: r.hidden ? 0.4 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: r.hidden ? 'transparent' : r.color, border: `1px solid ${r.color}`, flex: 'none' }} />
                    <span style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, textDecoration: r.hidden ? 'line-through' : 'none' }}>{r.name}</span>
                  </div>
                  <div style={{ textAlign: 'right', color: C.text }}>{r.burn}</div>
                  <div style={{ textAlign: 'right', color: C.dim }}>{r.updates}</div>
                </button>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 66px', gap: '3px 8px', fontSize: 10.5, paddingTop: 6, marginTop: 3, borderTop: `1px solid ${C.line}` }}>
                <div style={{ color: C.dim3 }}>TOTAL</div>
                <div style={{ textAlign: 'right', color: C.text, fontWeight: 600 }}>{vm.burnTotal}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{vm.burnUpdatesTotal}</div>
              </div>
              <div style={{ fontSize: 9, color: C.faint2, marginTop: 5, textAlign: 'right' }}>burn per $1M volume: {vm.burnPerM} MON · click a venue to hide/show</div>
            </div>
          </div>
        </div>
      )}

      {/* CUMULATIVE + MARKET SHARE — follow the RANGE presets, not the custom brush (intentional) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, margin: '0 18px 14px' }}>
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>■</span> <span style={{ color: C.text, fontWeight: 600 }}>CUMULATIVE_VOLUME</span>
          </div>
          <div onMouseMove={svgHover('cum')} onMouseLeave={leave} style={{ position: 'relative', padding: '14px 14px 10px' }}>
            <svg viewBox="0 0 1000 260" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 230 }}>
              <defs>
                {/* SVG presentation attrs can't use var() — theme via style instead. */}
                <linearGradient id="cumg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.32" />
                  <stop offset="100%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={vm.cumArea} fill="url(#cumg)" />
              {/* per-venue cumulative lines (registry colors), under the total */}
              {vm.cumVenueLines.map((l, i) => (
                <path key={i} d={l.path} fill="none" stroke={l.color} strokeOpacity="0.9" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
              ))}
              <path d={vm.cumLine} fill="none" style={{ stroke: 'var(--accent2)', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
            </svg>
            {vm.cumTip && (
              <>
                <div style={{ position: 'absolute', top: 14, bottom: 20, left: `${vm.cumTip.guide}%`, width: 1, background: 'var(--accent)', opacity: 0.55, pointerEvents: 'none' }} />
                <div style={{ ...tipBox, top: 20, left: `${vm.cumTip.left}%`, minWidth: 150 }}>
                  <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line2}` }}>{vm.cumTip.date}</div>
                  <div style={{ display: 'flex', fontSize: 10.5, paddingTop: 5 }}><span style={{ color: C.dim }}>CUMULATIVE</span><span style={{ marginLeft: 'auto', color: C.text, fontWeight: 600 }}>{vm.cumTip.cum}</span></div>
                  <div style={{ display: 'flex', fontSize: 10.5, paddingTop: 4 }}><span style={{ color: C.dim }}>DAY VOL</span><span style={{ marginLeft: 'auto', color: C.text }}>{vm.cumTip.day}</span></div>
                  {vm.cumTip.rows.map((r) => (
                    <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, paddingTop: 4 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 2, background: r.color, flex: 'none' }} />
                      <span style={{ color: C.text2 }}>{r.name}</span>
                      <span style={{ marginLeft: 'auto', color: C.text }}>{r.cum}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div style={{ position: 'absolute', top: 14, right: 16, fontSize: 11, color: C.purpleL }}>Σ {vm.cumSigma}</div>
          </div>
        </div>
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>◆</span> <span style={{ color: C.text, fontWeight: 600 }}>MARKET_SHARE</span> <span style={{ color: C.faint }}>% of daily volume</span>
          </div>
          <div onMouseMove={svgHover('ms')} onMouseLeave={leave} style={{ position: 'relative', padding: '14px 14px 10px' }}>
            <svg viewBox="0 0 1000 260" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 230 }}>
              {vm.msBands.map((band, i) => <path key={i} d={band.path} fill={band.color} fillOpacity="0.82" />)}
            </svg>
            {vm.msTip && (
              <>
                <div style={{ position: 'absolute', top: 14, bottom: 14, left: `${vm.msTip.guide}%`, width: 1, background: C.panel, opacity: 0.8, pointerEvents: 'none' }} />
                <div style={{ ...tipBox, top: 20, left: `${vm.msTip.left}%`, minWidth: 172 }}>
                  <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line2}` }}>{vm.msTip.date}</div>
                  {vm.msTip.rows.map((r) => (
                    <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, padding: '4px 0 0' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                      <span style={{ color: C.text2 }}>{r.name}</span>
                      <span style={{ marginLeft: 'auto', color: C.text }}>{r.pct}</span>
                      <span style={{ color: C.dim, width: 52, textAlign: 'right' }}>{r.val}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div style={{ position: 'absolute', top: 18, right: 16, fontSize: 9, color: vm.msTopColor }}>{vm.msTopName} {vm.msTopPct}</div>
            <div style={{ position: 'absolute', bottom: 34, right: 16, fontSize: 9, color: vm.msBotColor }}>{vm.msBotName} {vm.msBotPct}</div>
          </div>
        </div>
      </div>

      {/* VENUE_BREAKDOWN */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
          <span style={{ color: C.purple }}>#</span> <span style={{ color: C.text, fontWeight: 600 }}>VENUE_BREAKDOWN</span>{vm.rangeCaption ? <span style={{ color: C.faint }}> {vm.rangeCaption}</span> : null}
        </div>
        <div style={{ padding: '6px 14px 12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.4fr 1fr 1.2fr 1fr', gap: 8, padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.05em', borderBottom: `1px solid ${C.line}` }}>
            <div>VENUE</div><div style={{ textAlign: 'right' }}>{vm.rangeLabel} VOL</div><div style={{ textAlign: 'right' }}>SHARE</div><div style={{ textAlign: 'right' }}>SWAPS</div><div style={{ textAlign: 'right' }}>PEAK DAY</div><div style={{ textAlign: 'right' }}>FIRST ACTIVE</div>
          </div>
          {vm.brk.map((r) => (
            <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.4fr 1fr 1.2fr 1fr', gap: 8, padding: '10px 6px', fontSize: 11.5, borderBottom: `1px solid ${C.line3}`, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                <span style={{ color: C.text2 }}>{r.name}</span>
              </div>
              <div style={{ textAlign: 'right', color: C.text }}>{r.vol}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 5, background: C.line2, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${r.shareW}%`, background: r.color }} />
                </div>
                <span style={{ color: C.dim, width: 40, textAlign: 'right' }}>{r.share}</span>
              </div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.swaps}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.peakV} <span style={{ color: C.faint2 }}>{r.peakDay}</span></div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.first}</div>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.4fr 1fr 1.2fr 1fr', gap: 8, padding: '10px 6px', fontSize: 11.5, alignItems: 'center' }}>
            <div style={{ color: C.dim3 }}>TOTAL</div>
            <div style={{ textAlign: 'right', color: C.text, fontWeight: 600 }}>{vm.brkTotalVol}</div>
            <div style={{ textAlign: 'right', color: C.dim }}>100%</div>
            <div style={{ textAlign: 'right', color: C.dim }}>{vm.brkTotalSwaps}</div>
            <div style={{ textAlign: 'right', color: C.faint2 }}>—</div>
            {/* an aggregate has no single first-active date */}
            <div style={{ textAlign: 'right', color: C.dim3 }}>—</div>
          </div>
        </div>
      </div>
    </div>
  );
}
