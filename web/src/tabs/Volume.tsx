import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyVolume } from '@shared';
import { useDashboard } from '../store';
import { useViewport } from '../lib/viewport';
import { C, pill, venueColor } from '../theme';
import { fmtVolUsd } from '../lib/format';

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

/** which chart the pointer is over + the hovered point index within THAT chart's window. */
type HoverState = { c: 'daily' | 'burn' | 'cum' | 'ms'; i: number } | null;

const MIN_WIN = 3; // brush minimum window (days), per the design
const GRANS = ['D', 'W', 'M'] as const;

/** One rendered bar of a D/W/M-bucketed chart: the member days plus the span
 *  metadata the axis/tooltips need. 'D' produces single-day buckets so every
 *  consumer renders one uniform shape. Weeks are CALENDAR weeks (UTC Monday →
 *  Sunday inclusive) and months are calendar months.
 *
 *  The −4 is what makes a week a calendar week: `floor(ms / 7d)` alone anchors
 *  to the Unix epoch, and 1970-01-01 was a THURSDAY, so plain epoch weeks ran
 *  Thu→Wed. Shifting by 4 days moves the boundary onto Monday. Days are UTC
 *  throughout the dashboard, so these are UTC Mondays.
 *
 *  The first and last buckets of a window are naturally partial — history
 *  starts mid-week and the current week is unfinished. `iso0`/`isoEnd` track
 *  the days actually PRESENT (not the calendar edges), so the axis label and
 *  the tooltip span always state the real covered range rather than implying
 *  data we don't have. */
interface Bucket { iso0: string; isoEnd: string; partial: boolean; days: DailyVolume[] }
const bucketDays = (days: DailyVolume[], gran: string): Bucket[] => {
  const keyOf = (iso: string) => (gran === 'M' ? iso.slice(0, 7) : String(Math.floor((Date.parse(iso) / 86_400_000 - 4) / 7)));
  if (gran !== 'W' && gran !== 'M') return days.map((x) => ({ iso0: x.utcDay, isoEnd: x.utcDay, partial: !!x.partial, days: [x] }));
  const out: Bucket[] = [];
  let k0: string | null = null;
  for (const x of days) {
    const k = keyOf(x.utcDay);
    if (k !== k0) { k0 = k; out.push({ iso0: x.utcDay, isoEnd: x.utcDay, partial: !!x.partial, days: [x] }); }
    else { const b = out[out.length - 1]; b.days.push(x); b.isoEnd = x.utcDay; b.partial = b.partial || !!x.partial; }
  }
  return out;
};
/** x-axis label: the bucket's start date (design: month key for 'M'). */
const bucketLabel = (b: Bucket, gran: string) => (gran === 'M' ? b.iso0.slice(0, 7) : mmdd(b.iso0));
/** tooltip date line: single day, or the covered span for a multi-day bucket. */
const bucketDate = (b: Bucket) => b.iso0 === b.isoEnd
  ? b.iso0 + (b.partial ? ' (today, partial)' : '')
  : `${b.iso0} → ${b.isoEnd}${b.partial ? ' (partial)' : ''}`;
/** Summary-table column header: WHICH bucket the totals below it cover.
 *  The tables summarize the chart's LATEST bucket, so the header has to name
 *  it — "ALL-TIME" over one day's numbers was the bug this replaced. */
const bucketScope = (b: Bucket, gran: string) => {
  if (gran === 'M') return b.iso0.slice(0, 7);
  if (gran === 'W') {
    const d0 = new Date(b.iso0 + 'T00:00:00Z');
    const daysSinceMon = (d0.getUTCDay() + 6) % 7;
    d0.setUTCDate(d0.getUTCDate() - daysSinceMon);
    return `WK ${mmdd(d0.toISOString().slice(0, 10))}`;
  }
  return mmdd(b.iso0);
};
/** ≤5 axis ticks across a bucket array (deduped — short windows repeat indexes). */
const axisOf = (arr: Bucket[], gran: string): { label: string; left: string }[] => {
  const n = arr.length;
  if (n === 0) return [];
  if (n < 2) return [{ label: bucketLabel(arr[0], gran), left: '50%' }];
  const idx = [...new Set([0, Math.floor((n - 1) * 0.25), Math.floor((n - 1) * 0.5), Math.floor((n - 1) * 0.75), n - 1])];
  return idx.map((i) => ({ label: bucketLabel(arr[i], gran), left: (i / (n - 1) * 100).toFixed(1) + '%' }));
};

export function VolumeTab() {
  const d = useDashboard();
  // transient hover — local (never persisted); brush window lives in the store
  // so it survives tab switches (design keeps it in global state too).
  const { mobile } = useViewport();
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
  const burnBrushRef = useRef<HTMLDivElement | null>(null);
  // active drag's window-listener cleanup — run on unmount so a mid-drag tab
  // switch can't leak window listeners.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanup.current?.(); }, []);

  const allDays = d.volume;
  const nAll = allDays.length;

  /** DAILY window (design volWin): the hand-drawn brush window, else full
   *  history. Ranges are per-chart now — there is no page-level preset. */
  const winDaily = (): [number, number] => {
    const n = nAll;
    if (n <= 1) return [0, Math.max(0, n - 1)];
    if (d.volStart != null && d.volEnd != null && n >= MIN_WIN + 1) {
      const s = Math.max(0, Math.min(n - 1 - MIN_WIN, d.volStart));
      return [s, Math.max(s + MIN_WIN, Math.min(n - 1, d.volEnd))];
    }
    return [0, n - 1];
  };
  const [wS, wE] = winDaily();

  /** BURN chart's brush window — same shape as the daily brush but its own
   *  independent indexes (burnStart/burnEnd; null ⇒ full history). */
  const winBurn = (): [number, number] => {
    const n = nAll;
    if (n <= 1) return [0, Math.max(0, n - 1)];
    if (d.burnStart != null && d.burnEnd != null && n >= MIN_WIN + 1) {
      const s = Math.max(0, Math.min(n - 1 - MIN_WIN, d.burnStart));
      return [s, Math.max(s + MIN_WIN, Math.min(n - 1, d.burnEnd))];
    }
    return [0, n - 1];
  };
  const [bWS, bWE] = winBurn();

  /** every other chart's window: from→to ISO bounds over the full history
   *  (design isoWin). Null bound = open ⇒ that side of the full range; an
   *  inverted pair collapses to a single day rather than inverting. */
  const isoWin = (from: string | null, to: string | null): [number, number] => {
    let s = 0, e = nAll - 1;
    if (from) { const i = allDays.findIndex((x) => x.utcDay >= from); if (i >= 0) s = i; }
    if (to) { for (let i = nAll - 1; i >= 0; i--) { if (allDays[i].utcDay <= to) { e = i; break; } } }
    if (e < s) e = s;
    return [s, e];
  };
  const [cS, cE] = isoWin(d.cumFrom, d.cumTo);
  const [mS, mE] = isoWin(d.msFrom, d.msTo);
  const [kS, kE] = isoWin(d.brkFrom, d.brkTo);

  // per-chart from→to inputs (design dcSet): clearing a bound re-opens it to
  // the full range; the ↺ reset clears both.
  const dcSet = (k: 'cumFrom' | 'cumTo' | 'msFrom' | 'msTo' | 'brkFrom' | 'brkTo') =>
    (e: React.ChangeEvent<HTMLInputElement>) => { d.set(k, e.target.value || null); setHover(null); };
  const dcReset = (fk: 'cumFrom' | 'msFrom' | 'brkFrom', tk: 'cumTo' | 'msTo' | 'brkTo') =>
    () => { d.set(fk, null); d.set(tk, null); setHover(null); };

  // ── brush interactions (design brushDrag): edge-grab resizes, inside-grab
  // pans, outside-click re-centers then pans from the NEW window. Shared by
  // both bar-chart brushes — parameterized by (element, current window, apply
  // callback), so the daily and burn brushes are the same code with different
  // state. Redundant state writes during a drag are suppressed (apply only
  // when the indexes actually change).
  const brushDrag = (
    e: React.PointerEvent,
    el: HTMLDivElement | null,
    win: [number, number],
    apply: (s: number, en: number) => void,
  ) => {
    if (!el || nAll < MIN_WIN + 1) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const n = nAll;
    const [s0, e0] = win;
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
      apply(ds, de);
    }
    const drag = { mode, fr0: fr, s0: ds, e0: de };
    let cur: [number, number] = [ds, de];
    const mv = (ev: PointerEvent) => {
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const di = Math.round((f - drag.fr0) * (n - 1));
      let s = drag.s0, en = drag.e0;
      if (drag.mode === 'move') { const w = drag.e0 - drag.s0; s = Math.max(0, Math.min(n - 1 - w, drag.s0 + di)); en = s + w; }
      else if (drag.mode === 'l') { s = Math.max(0, Math.min(drag.e0 - MIN_WIN, drag.s0 + di)); }
      else { en = Math.max(drag.s0 + MIN_WIN, Math.min(n - 1, drag.e0 + di)); }
      if (s !== cur[0] || en !== cur[1]) { cur = [s, en]; apply(s, en); }
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragCleanup.current = null;
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    dragCleanup.current = up;
  };
  const brushDown = (e: React.PointerEvent) =>
    brushDrag(e, brushRef.current, winDaily(), (s, en) => { d.set('volStart', s); d.set('volEnd', en); setHover(null); });
  const burnBrushDown = (e: React.PointerEvent) =>
    brushDrag(e, burnBrushRef.current, winBurn(), (s, en) => { d.set('burnStart', s); d.set('burnEnd', en); setHover(null); });

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

    const f = (m: number) => fmtVolUsd(m);

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
        rangeLabel: '—', volScopeSpan: '', brkLabel: 'ALL-TIME',
        msBands: [] as { path: string; color: string }[],
        msTopName: '—', msTopPct: '0.0%', msTopColor: msLabelColor(C.faint2),
        msBotName: '—', msBotPct: '0.0%', msBotColor: msLabelColor(C.faint2),
        brk: [] as { name: string; color: string; vol: string; share: string; shareW: string; swaps: string; peakV: string; peakDay: string; first: string }[],
        brkTotalVol: f(0), brkTotalSwaps: '0',
        volScopeNote: scopeNote,
        ndCum: 0, ndMs: 0,
        dailyTip: null as null | { left: string; date: string; total: string; rows: { name: string; color: string; val: string }[] },
        cumTip: null as null | { left: string; guide: string; date: string; cum: string; day: string; rows: { name: string; color: string; cum: string }[] },
        msTip: null as null | { left: string; guide: string; date: string; rows: { name: string; color: string; pct: string; val: string }[] },
        brushBars: [] as { h: string; color: string }[],
        brushLeft: '0', brushWidth: '100', brushStartLbl: '—', brushEndLbl: '—',
        hasBurn: false,
        burnBars: [] as { op: number; segs: { h: string; color: string }[]; bg: string; onEnter: () => void }[],
        burnAxis: [] as { label: string; left: string }[],
        burnMaxLabel: '0 MON', burnMidLabel: '0 MON',
        burnTip: null as null | { left: string; date: string; total: string; usd: string; rows: { name: string; color: string; val: string }[] },
        burnRows: [] as { id: string; name: string; color: string; burn: string; updates: string; hidden: boolean }[],
        burnTotal: '0 MON', burnUpdatesTotal: '0', burnColHdr: 'BURN', burnPerM: '0', burnScopeSpan: '',
        burnBrushBars: [] as { h: string; color: string }[],
        burnBrushLeft: '0', burnBrushWidth: '100', burnBrushStartLbl: '—', burnBrushEndLbl: '—',
      };
    }

    const dayTotal = (x: DailyVolume) => series.reduce((a, s) => a + s.val(x), 0);
    /** a series' sum over one bucket's member days. */
    const bSum = (b: Bucket, fn: (x: DailyVolume) => number) => b.days.reduce((a, x) => a + fn(x), 0);

    // ── windowed slices: every chart owns its window. The daily chart follows
    // the brush (⇄ its date inputs); cum/ms/breakdown/burn each follow their
    // own from→to pair resolved in the component body.
    const wDays = allDays.slice(wS, wE + 1);
    const ndW = wDays.length;
    const cDays = allDays.slice(cS, cE + 1);
    const ncd = cDays.length;
    const mDays = allDays.slice(mS, mE + 1);
    const nmd = mDays.length;
    const kDays = allDays.slice(kS, kE + 1);

    // chart-only subset: legend-hidden venues drop out of the stacks and the
    // y-scale renormalizes; every OTHER consumer (KPIs, cum/ms, breakdown)
    // stays full-series — the toggle is a lens, not a data filter.
    const volShown = series.filter((s) => !hiddenVol.has(s.id));
    const shownTotal = (x: DailyVolume) => volShown.reduce((a, s) => a + s.val(x), 0);
    // D/W/M granularity re-buckets the WINDOWED days; bars/axis/tooltips all
    // render buckets from here on ('D' = one-day buckets, same shape).
    const dGran = d.volGran;
    const dB = bucketDays(wDays, dGran);
    const ndB = dB.length;
    const maxT = Math.max(...dB.map((b) => bSum(b, shownTotal))) || 1;
    const H = 150;
    const hv = hover;
    const hiW = hv && hv.c === 'daily' ? Math.min(hv.i, ndB - 1) : -1;
    const volBars = dB.map((b, i) => ({
      op: b.partial ? 0.5 : 1,
      segs: volShown.map((s) => ({ h: (bSum(b, s.val) / maxT * H).toFixed(1), color: s.color })),
      // full-height accent wash behind the hovered bucket's stack
      bg: hiW === i ? 'var(--accent-dim)' : 'transparent',
      onEnter: () => setHover({ c: 'daily', i }),
    }));

    // ── KPI tiles stay FULL-history (all-time / trailing-7d / today semantics);
    // everything below them — legend, breakdown, all three charts — follows the
    // SELECTED window so the page reads as one coherent range.
    const allTot = allDays.reduce((a, x) => a + dayTotal(x), 0);
    // The summary table covers the chart's LATEST bucket at the selected
    // granularity — D = the newest day, W = the newest week, M = the newest
    // month — so the D/W/M pills move the numbers, not just the bars. It used
    // to sum the whole window regardless, which read as "ALL-TIME" forever.
    // Latest IN THE WINDOW, so panning the brush to a past range summarizes
    // that range's last bucket rather than jumping back to today.
    const volScope = dB[ndB - 1];
    const winEndDay = volScope.isoEnd;
    // totals per venue — venues that didn't EXIST by the end of the bucket are
    // omitted (same honesty rule as the per-day tooltips). One that existed and
    // simply didn't trade still shows, at 0.
    const winSeries = series.filter((s) => !s.since || s.since <= winEndDay);
    const totals = winSeries.map((s) => ({ id: s.id, name: s.name, color: s.color, tot: bSum(volScope, s.val) }));
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

    // ── CUMULATIVE_VOLUME (own window): Σ and every line re-baseline to the
    // window start.
    const cTot = cDays.map(dayTotal);
    const W = 1000, HC = 260;
    let cum = 0;
    const pts = cDays.map((_, i) => { cum += cTot[i]; return [ncd > 1 ? i / (ncd - 1) * W : 0, cum] as [number, number]; });
    const cy = (y: number) => (cum ? HC - y / cum * HC : HC); // zero window ⇒ flat at the BOTTOM
    const cumLine = 'M' + pts.map((p) => p[0].toFixed(1) + ',' + cy(p[1]).toFixed(1)).join(' L');
    const cumArea = cumLine + ' L' + W + ',' + HC + ' L0,' + HC + ' Z';
    // per-venue cumulative lines on the SAME y-scale as the total. Each line
    // starts at the venue's first day of existence in the window (honest
    // absence — no flat fabricated-zero segment before the venue was live).
    const cumVenue = series.map((s2) => {
      let c2 = 0;
      const vpts: [number, number][] = [];
      cDays.forEach((x, i) => {
        if (!existsOn(s2, x)) return;
        c2 += s2.val(x);
        vpts.push([ncd > 1 ? i / (ncd - 1) * W : 0, c2]);
      });
      return { name: s2.name, color: s2.color, cum: c2, pts: vpts };
    });
    const cumVenueLines = cumVenue.filter((v) => v.pts.length > 1 && v.cum > 0).map((v) => ({
      color: v.color,
      path: 'M' + v.pts.map((pt) => pt[0].toFixed(1) + ',' + cy(pt[1]).toFixed(1)).join(' L'),
    }));

    // ── MARKET_SHARE (own window): bands + the top/bottom badges read from
    // THIS window's last day.
    const mTot = mDays.map(dayTotal);
    const xs = (i: number) => (nmd > 1 ? i / (nmd - 1) * W : 0);
    const bands = series.map(() => ({ top: [] as [number, number][], bot: [] as [number, number][] }));
    mDays.forEach((x, i) => {
      const t = mTot[i] || 1;
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
    const mLast = mDays[nmd - 1];
    const lt = mTot[nmd - 1] || 1;

    // ── VENUE_BREAKDOWN (own window): every column window-scoped.
    const brkEndDay = kDays[kDays.length - 1]?.utcDay ?? '';
    const brkSeries = series.filter((s) => !s.since || s.since <= brkEndDay);
    const brkTots = brkSeries.map((s) => kDays.reduce((a, x) => a + s.val(x), 0));
    const kTot = brkTots.reduce((a, b) => a + b, 0);
    const pPeak = (s: SeriesDef) => {
      let pv = -1, pd = '';
      kDays.forEach((x) => { const v = s.val(x); if (v > pv) { pv = v; pd = mmdd(x.utcDay); } });
      return { v: f(pv), day: pd };
    };
    // real per-source swap counts (no USD proration): each venue counts its own takes.
    const brkSwaps = brkSeries.map((s) => kDays.reduce((a, x) => a + s.swaps(x), 0));
    const brkSwapTotal = brkSwaps.reduce((a, b) => a + b, 0);
    const brk = brkSeries.map((s, k) => {
      const tot = brkTots[k];
      const pk = pPeak(s);
      // first day IN THE WINDOW with any notional (the venue's true first-active
      // still anchors the all-time tile's "since" line).
      const firstInWin = kDays.find((x) => s.val(x) > 0)?.utcDay ?? '—';
      return {
        name: s.name, color: s.color, vol: f(tot),
        share: (kTot ? tot / kTot * 100 : 0).toFixed(1) + '%',
        shareW: (kTot ? tot / kTot * 100 : 0).toFixed(1),
        swaps: brkSwaps[k].toLocaleString(),
        peakV: pk.v, peakDay: pk.day,
        first: firstInWin,
      };
    });
    const brkLabel = kS === 0 && kE === nd - 1 ? 'ALL-TIME' : 'WINDOW';

    const axis = axisOf(dB, dGran);

    // ── hover tooltips (design: clamp x so the tip never clips the panel) ──────
    const tipLeft = (i: number, n: number) => Math.max(9, Math.min(88, ((i + 0.5) / n) * 100)).toFixed(1);
    const guideLeft = (i: number, n: number) => (n > 1 ? (i / (n - 1)) * 100 : 0).toFixed(1);
    const dateOf = (x: DailyVolume) => x.utcDay + (x.partial ? ' (today, partial)' : '');
    // a venue belongs in a BUCKET's tooltip if it existed for any part of it.
    const existsInBucket = (s: SeriesDef, b: Bucket) => !s.since || b.isoEnd >= s.since;
    let dailyTip = null, cumTip = null, msTip = null;
    if (hiW >= 0) {
      const b = dB[hiW];
      dailyTip = {
        left: tipLeft(hiW, ndB), date: bucketDate(b), total: f(bSum(b, shownTotal)),
        rows: volShown.filter((s) => existsInBucket(s, b)).map((s) => ({ name: s.name, color: s.color, val: f(bSum(b, s.val)) })),
      };
    }
    const hiC = hv && hv.c === 'cum' ? Math.min(hv.i, ncd - 1) : -1;
    if (hiC >= 0) {
      const x = cDays[hiC];
      let c2 = 0; for (let k = 0; k <= hiC; k++) c2 += cTot[k];
      const rows = series.filter((s2) => existsOn(s2, x)).map((s2) => {
        let cv = 0;
        for (let k = 0; k <= hiC; k++) if (existsOn(s2, cDays[k])) cv += s2.val(cDays[k]);
        return { name: s2.name, color: s2.color, cum: f(cv) };
      }).filter((r2) => r2.cum !== f(0));
      cumTip = { left: tipLeft(hiC, ncd), guide: guideLeft(hiC, ncd), date: dateOf(x), cum: f(c2), day: f(cTot[hiC]), rows };
    }
    const hiM = hv && hv.c === 'ms' ? Math.min(hv.i, nmd - 1) : -1;
    if (hiM >= 0) {
      const x = mDays[hiM];
      const t = mTot[hiM] || 1;
      msTip = {
        left: tipLeft(hiM, nmd), guide: guideLeft(hiM, nmd), date: dateOf(x),
        rows: series.filter((s) => existsOn(s, x)).map((s) => ({ name: s.name, color: s.color, pct: (s.val(x) / t * 100).toFixed(1) + '%', val: f(s.val(x)) })),
      };
    }

    // ── QUOTE_UPDATE_BURN (MON, not USD): the gas each venue's own keeper
    // spends keeping quotes fresh. Owns its OWN from→to window + D/W/M
    // granularity + x-axis — fully independent of the daily chart. Venues
    // appear only when the server tracks a series for them — a venue that
    // doesn't self-fund its price updates (taker-paid JIT) has no row, on
    // purpose.
    const gasByDay = new Map((d.gas?.days ?? []).map((g) => [g.utcDay, g.byVenue]));
    const approx = new Set(d.gas?.approx ?? []);
    const gasVenueIds = new Set<string>();
    for (const g of d.gas?.days ?? []) for (const vid of Object.keys(g.byVenue)) gasVenueIds.add(vid);
    const burnSeries = series.filter((s) => gasVenueIds.has(s.id));
    const hasBurn = burnSeries.length > 0;
    const gVal = (utc: string, vid: string) => gasByDay.get(utc)?.[vid]?.mon ?? 0;
    const gTxs = (utc: string, vid: string) => gasByDay.get(utc)?.[vid]?.txs ?? 0;
    const fMON = (m: number) => (m >= 1000 ? (m / 1000).toFixed(1) + 'K' : Math.round(m).toLocaleString()) + ' MON';
    const bDaysW = allDays.slice(bWS, bWE + 1);
    const bB = bucketDays(bDaysW, d.burnGran);
    const nbB = bB.length;
    const burnShown = burnSeries.filter((s) => !hiddenBurn.has(s.id));
    const bGas = (b: Bucket, vid: string) => bSum(b, (x) => gVal(x.utcDay, vid));
    const bTot = bB.map((b) => burnShown.reduce((a, s) => a + bGas(b, s.id), 0));
    const bMax = Math.max(...bTot, 0) || 1;
    const hiB = hv && hv.c === 'burn' ? Math.min(hv.i, nbB - 1) : -1;
    const burnBars = bB.map((b, i) => ({
      op: b.partial ? 0.5 : 1,
      segs: burnShown.filter((s) => bGas(b, s.id) > 0).map((s) => ({ h: (bGas(b, s.id) / bMax * H).toFixed(1), color: s.color })),
      bg: hiB === i ? 'var(--accent-dim)' : 'transparent',
      onEnter: () => setHover({ c: 'burn', i }),
    }));
    const burnAxis = axisOf(bB, d.burnGran);
    let burnTip = null;
    if (hiB >= 0) {
      const b = bB[hiB];
      const monUsd = d.state?.monUsd ?? 0;
      burnTip = {
        left: tipLeft(hiB, nbB), date: bucketDate(b),
        rows: burnShown.filter((s) => bGas(b, s.id) > 0)
          .map((s) => ({ name: s.name, color: s.color, val: (approx.has(s.id) ? '≈' : '') + bGas(b, s.id).toFixed(1) + ' MON' })),
        total: Math.round(bTot[hiB]).toLocaleString() + ' MON',
        usd: monUsd > 0 ? '~$' + (bTot[hiB] * monUsd).toFixed(0) : '',
      };
    }
    // summary table: the chart's LATEST bucket at this chart's own granularity,
    // matching DAILY_VOLUME's table (it used to sum the whole burn window, so
    // the D/W/M pills moved the bars and left the numbers alone).
    const burnScope = bB[nbB - 1];
    const burnRows = burnSeries.map((s) => {
      const tot = bSum(burnScope, (x) => gVal(x.utcDay, s.id));
      const ups = bSum(burnScope, (x) => gTxs(x.utcDay, s.id));
      return { id: s.id, name: s.name, color: s.color, burn: (approx.has(s.id) ? '≈' : '') + fMON(tot), updates: ups.toLocaleString(), hidden: hiddenBurn.has(s.id) };
    });
    const burnTotal = burnSeries.reduce((a, s) => a + bSum(burnScope, (x) => gVal(x.utcDay, s.id)), 0);
    const burnUpdatesTotal = burnSeries.reduce((a, s) => a + bSum(burnScope, (x) => gTxs(x.utcDay, s.id)), 0);
    // burn per $1M of volume over the SAME bucket — the denominator MUST follow
    // the numerator's scope, or one day's burn gets divided by a whole window's
    // volume and the ratio reads an order of magnitude too low.
    const bVol = bSum(burnScope, dayTotal);
    const burnPerM = bVol > 0 ? (burnTotal / (bVol / 1e6)).toFixed(1) : '0';
    const burnColHdr = `${bucketScope(burnScope, d.burnGran)} BURN`;

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

    // burn brush minimap: full-history TOTAL daily MON burn across all burn
    // series (not just shown ones — the minimap is context, not a lens),
    // tinted by the burn window. Same construction as the daily brush.
    const bAllTot = allDays.map((x) => burnSeries.reduce((a, s) => a + gVal(x.utcDay, s.id), 0));
    const bAllMax = Math.max(...bAllTot, 0) || 1;
    const burnBrushBars = allDays.map((_, i) => ({
      h: Math.max(4, bAllTot[i] / bAllMax * 100).toFixed(1), // min height so quiet days stay visible
      color: i >= bWS && i <= bWE ? 'var(--accent)' : 'var(--faint2)',
    }));
    const burnBrushLeft = (nd > 1 ? bWS / (nd - 1) * 100 : 0).toFixed(2);
    const burnBrushWidth = Math.max(1.5, nd > 1 ? (bWE - bWS) / (nd - 1) * 100 : 100).toFixed(2);
    const burnBrushStartLbl = mmdd(allDays[bWS].utcDay);
    const burnBrushEndLbl = mmdd(allDays[bWE].utcDay) + (allDays[bWE].partial ? ' · now' : '');

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
      legTotal: f(winTot), cumLine, cumArea, cumVenueLines, cumSigma: f(cum),
      rangeLabel: bucketScope(volScope, dGran), volScopeSpan: bucketDate(volScope), brkLabel,
      msBands,
      msTopName: series[series.length - 1].name,
      msTopPct: (series[series.length - 1].val(mLast) / lt * 100).toFixed(1) + '%',
      msTopColor: msLabelColor(series[series.length - 1].color),
      msBotName: series[0].name,
      msBotPct: (series[0].val(mLast) / lt * 100).toFixed(1) + '%',
      msBotColor: msLabelColor(series[0].color),
      brk, brkTotalVol: f(kTot), brkTotalSwaps: brkSwapTotal.toLocaleString(),
      volScopeNote: scopeNote,
      ndCum: ncd, ndMs: nmd,
      dailyTip, cumTip, msTip,
      brushBars, brushLeft, brushWidth, brushStartLbl, brushEndLbl,
      hasBurn, burnBars, burnAxis,
      burnMaxLabel: fMON(bMax), burnMidLabel: fMON(bMax / 2),
      burnTip, burnRows,
      burnTotal: fMON(burnTotal), burnUpdatesTotal: burnUpdatesTotal.toLocaleString(),
      burnColHdr, burnPerM, burnScopeSpan: bucketDate(burnScope),
      burnBrushBars, burnBrushLeft, burnBrushWidth, burnBrushStartLbl, burnBrushEndLbl,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.volume, d.gas, d.theme, d.displayVenues, wS, wE, cS, cE, mS, mE, kS, kE, bWS, bWE, d.volGran, d.burnGran, hover, hiddenVol, hiddenBurn]);

  // svg charts: cursor-x → nearest day index (round(frac × (n−1))) using EACH
  // chart's own point count (their windows differ in length); only re-render
  // when the index or chart changes, not on every mousemove pixel.
  const svgHover = (chart: 'cum' | 'ms') => (e: React.MouseEvent) => {
    const n = chart === 'cum' ? vm.ndCum : vm.ndMs;
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

  // ── per-chart header controls (design: title left, controls right; gran
  // pills BEFORE the dates on the two bar charts) ────────────────────────────
  const panelHdr: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
    padding: '6px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em',
  };
  const dateStyle: React.CSSProperties = {
    background: 'transparent', border: '1px solid var(--pill-border)', color: C.text2,
    fontFamily: 'inherit', fontSize: 9.5, padding: '2px 5px', borderRadius: 4,
  };
  const volMinIso = nAll ? allDays[0].utcDay : '';
  const volMaxIso = nAll ? allDays[nAll - 1].utcDay : '';
  const dateRange = (from: string, to: string, onFrom: (e: React.ChangeEvent<HTMLInputElement>) => void, onTo: (e: React.ChangeEvent<HTMLInputElement>) => void, onReset: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, color: C.faint2 }}>
      <input type="date" value={from} min={volMinIso} max={volMaxIso} onChange={onFrom} style={dateStyle} />
      <span>→</span>
      <input type="date" value={to} min={volMinIso} max={volMaxIso} onChange={onTo} style={dateStyle} />
      <button type="button" className="reset-pill" title="Reset to full range" onClick={onReset}>↺</button>
    </div>
  );
  const granPills = (key: 'volGran' | 'burnGran') => (
    <div style={{ display: 'flex', gap: 3 }}>
      {GRANS.map((g) => (
        <button key={g} type="button" aria-pressed={d[key] === g} onClick={() => { d.set(key, g); setHover(null); }} style={pill(d[key] === g, true)}>{g}</button>
      ))}
    </div>
  );
  const isoAt = (i: number) => (nAll ? allDays[Math.max(0, Math.min(nAll - 1, i))].utcDay : '');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, padding: '18px 18px 14px' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em', color: C.text }}>PROPAMM VOLUME</div>
          <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 760 }}>
            All-time daily notional traded on tracked propAMM venues, split by venue. Volume is the USD-stable quote leg of each landed swap; buckets are UTC days and today's bucket is partial.
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(5,1fr)', gap: 0, border: `1px solid ${C.line}`, margin: '0 18px 14px' }}>
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
        <div style={panelHdr}>
          <div>
            <span style={{ color: C.purple }}>~</span> <span style={{ color: C.text, fontWeight: 600 }}>DAILY_VOLUME</span> <span style={{ color: C.faint }}>USD notional by venue · UTC buckets · {vm.volScopeNote}</span>
          </div>
          {granPills('volGran')}
        </div>
        {/* flex row: the bars end where the summary column begins, so the newest
            (right-most) bars never render underneath it — no absolute overlay. */}
        <div style={{ display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'flex-start', gap: 14, padding: mobile ? '16px 12px 8px' : '16px 18px 8px' }}>
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
            <div ref={brushRef} onPointerDown={brushDown}
              style={{ position: 'relative', height: 40, margin: '12px 2px 2px 42px', border: `1px solid ${C.line2}`, background: C.panel, cursor: 'grab', userSelect: 'none', touchAction: 'none' }}>
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
          <div style={{ flex: 'none', width: mobile ? 'auto' : 248, background: C.overlay, border: `1px solid ${C.line}`, padding: '8px 10px' }}>
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
                  <span title={r.name} style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, textDecoration: r.hidden ? 'line-through' : 'none' }}>{r.name}</span>
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
            <div style={{ fontSize: 8.5, color: C.faint2, marginTop: 5, textAlign: 'right' }}>{vm.volScopeSpan} · click a venue to hide/show</div>
          </div>
        </div>
      </div>

      {/* QUOTE_UPDATE_BURN — its OWN from→to window + D/W/M granularity + x-axis,
          independent of DAILY_VOLUME. Rendered only once the server has a burn
          series for at least one venue. */}
      {vm.hasBurn && (
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
          <div style={panelHdr}>
            <div>
              <span style={{ color: C.purple }}>~</span> <span style={{ color: C.text, fontWeight: 600 }}>QUOTE_UPDATE_BURN</span> <span style={{ color: C.faint }}>gas burned keeping quotes fresh · MON · tracked venues</span>
            </div>
            {granPills('burnGran')}
          </div>
          <div style={{ display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'flex-start', gap: 14, padding: mobile ? '16px 12px 8px' : '16px 18px 8px' }}>
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
                {vm.burnAxis.map((a, i) => (
                  <div key={i} style={{ position: 'absolute', left: a.left, transform: 'translateX(-50%)', fontSize: 8.5, color: C.faint2 }}>{a.label}</div>
                ))}
              </div>
              {/* burn timeline brush: full-history burn minimap, independent of the daily brush */}
              <div ref={burnBrushRef} onPointerDown={burnBrushDown}
                style={{ position: 'relative', height: 40, margin: '12px 2px 2px 42px', border: `1px solid ${C.line2}`, background: C.panel, cursor: 'grab', userSelect: 'none', touchAction: 'none' }}>
                <div style={{ position: 'absolute', left: 3, right: 3, top: 3, bottom: 3, display: 'flex', alignItems: 'flex-end', gap: 1, pointerEvents: 'none' }}>
                  {vm.burnBrushBars.map((b, i) => <div key={i} style={{ flex: 1, height: `${b.h}%`, background: b.color, opacity: 0.55 }} />)}
                </div>
                <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${vm.burnBrushLeft}%`, width: `${vm.burnBrushWidth}%`, background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', left: -3, top: '50%', transform: 'translateY(-50%)', width: 5, height: 18, background: 'var(--accent)', borderRadius: 2 }} />
                  <div style={{ position: 'absolute', right: -3, top: '50%', transform: 'translateY(-50%)', width: 5, height: 18, background: 'var(--accent)', borderRadius: 2 }} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', margin: '4px 2px 0 42px', fontSize: 8.5, color: C.faint2 }}>
                <span>window: {vm.burnBrushStartLbl} → {vm.burnBrushEndLbl}</span>
                <span>drag to pan · edges to resize · click outside to jump</span>
              </div>
            </div>
            {/* summary column — VENUE / window burn / update-tx counts */}
            <div style={{ flex: 'none', width: mobile ? 'auto' : 272, background: C.overlay, border: `1px solid ${C.line}`, padding: '8px 10px' }}>
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
                    <span title={r.name} style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, textDecoration: r.hidden ? 'line-through' : 'none' }}>{r.name}</span>
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
              <div style={{ fontSize: 9, color: C.faint2, marginTop: 5, textAlign: 'right' }}>burn per $1M volume: {vm.burnPerM} MON<br />{vm.burnScopeSpan} · click a venue to hide/show</div>
            </div>
          </div>
        </div>
      )}

      {/* CUMULATIVE + MARKET SHARE — follow the RANGE presets, not the custom brush (intentional) */}
      <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: 14, margin: '0 18px 14px' }}>
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <div style={panelHdr}>
            <div><span style={{ color: C.purple }}>■</span> <span style={{ color: C.text, fontWeight: 600 }}>CUMULATIVE_VOLUME</span></div>
            {dateRange(d.cumFrom ?? isoAt(0), d.cumTo ?? isoAt(nAll - 1), dcSet('cumFrom'), dcSet('cumTo'), dcReset('cumFrom', 'cumTo'))}
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
              {/* TOTAL in strong neutral ink — accent2 is nearly POE's orange in
                  the bright theme, so a venue color it must never be. */}
              <path d={vm.cumLine} fill="none" style={{ stroke: 'var(--text-strong)', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
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
            <div style={{ position: 'absolute', top: 14, right: 16, fontSize: 11, color: C.textStrong, fontWeight: 600 }}>Σ {vm.cumSigma}</div>
          </div>
        </div>
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <div style={panelHdr}>
            <div><span style={{ color: C.purple }}>◆</span> <span style={{ color: C.text, fontWeight: 600 }}>MARKET_SHARE</span> <span style={{ color: C.faint }}>% of daily volume</span></div>
            {dateRange(d.msFrom ?? isoAt(0), d.msTo ?? isoAt(nAll - 1), dcSet('msFrom'), dcSet('msTo'), dcReset('msFrom', 'msTo'))}
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
        <div style={panelHdr}>
          <div><span style={{ color: C.purple }}>#</span> <span style={{ color: C.text, fontWeight: 600 }}>VENUE_BREAKDOWN</span></div>
          {dateRange(d.brkFrom ?? isoAt(0), d.brkTo ?? isoAt(nAll - 1), dcSet('brkFrom'), dcSet('brkTo'), dcReset('brkFrom', 'brkTo'))}
        </div>
        <div style={{ padding: '6px 14px 12px', overflowX: 'auto' }}>
          <div style={{ minWidth: 640 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.4fr 1fr 1.2fr 1fr', gap: 8, padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.05em', borderBottom: `1px solid ${C.line}` }}>
            <div>VENUE</div><div style={{ textAlign: 'right' }}>{vm.brkLabel} VOL</div><div style={{ textAlign: 'right' }}>SHARE</div><div style={{ textAlign: 'right' }}>SWAPS</div><div style={{ textAlign: 'right' }}>PEAK DAY</div><div style={{ textAlign: 'right' }}>FIRST ACTIVE</div>
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
    </div>
  );
}
