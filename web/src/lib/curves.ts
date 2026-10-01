import type { CurveFlow, CurveRoute, MarkoutCurveCell, MarkoutCurvesResponse } from '@shared';

/**
 * MARKOUT_CURVE view-model. The server ships TAKER-signed (venue, flow, route,
 * category) cells of Σ(usd × bps); any filter combination is a SUM of cells,
 * and the mean curve is that sum ÷ Σusd — exact, never an average of averages.
 * MAKER = negation, the Leaderboard's convention.
 */

export const FLOW_OPTS = ['ALL', 'QUIET', 'MOVING'] as const;
export const ROUTE_OPTS = ['ALL', 'SINGLE', 'SPLIT', 'TWO-SIDED'] as const;
const FLOW_OF: Record<string, CurveFlow | undefined> = { QUIET: 'quiet', MOVING: 'moving' };
const ROUTE_OF: Record<string, CurveRoute | undefined> = { SINGLE: 'single', SPLIT: 'split', 'TWO-SIDED': 'twoSided' };

/** Below this many fills a mean curve is noise; it stays in the table, flagged,
 *  but is not drawn. */
export const MIN_CURVE_FILLS = 20;

export interface CurveFilter { flow: string; route: string; entry: string }

export interface VenueCurve {
  venueId: string;
  fills: number;
  usd: number;
  /** MAKER-signed notional-weighted mean bps per offset; null when no fills. */
  maker: (number | null)[];
  /** the venue's flow mix over ALL its curve fills (independent of the filter). */
  quietShare: number;
  twoSidedShare: number;
  /** curve-covered notional ÷ every fill's notional in the window. */
  coverage: number;
}

export interface CurveView {
  offsets: number[];
  venues: VenueCurve[];
  pooled: VenueCurve | null;
  /** categories present in the window (ENTRY pill options). */
  categories: string[];
}

function matches(c: MarkoutCurveCell, f: CurveFilter): boolean {
  const flow = FLOW_OF[f.flow], route = ROUTE_OF[f.route];
  return (!flow || c.flow === flow) && (!route || c.route === route) && (f.entry === 'ALL' || c.category === f.entry);
}

function fold(venueId: string, all: MarkoutCurveCell[], picked: MarkoutCurveCell[], coverUsd: number, n: number): VenueCurve {
  const sum = new Array<number>(n).fill(0);
  let usd = 0, fills = 0;
  for (const c of picked) {
    usd += c.usd;
    fills += c.fills;
    for (let i = 0; i < n; i++) sum[i] += c.usdBps[i] ?? 0;
  }
  let allUsd = 0, quiet = 0, twoSided = 0;
  for (const c of all) {
    allUsd += c.usd;
    if (c.flow === 'quiet') quiet += c.usd;
    if (c.route === 'twoSided') twoSided += c.usd;
  }
  return {
    venueId, fills, usd,
    maker: sum.map((v) => (usd > 0 ? -v / usd : null)),
    quietShare: allUsd > 0 ? quiet / allUsd : 0,
    twoSidedShare: allUsd > 0 ? twoSided / allUsd : 0,
    coverage: coverUsd > 0 ? Math.min(1, allUsd / coverUsd) : 0,
  };
}

export function curveView(res: MarkoutCurvesResponse | null, filter: CurveFilter, venueIds: readonly string[]): CurveView {
  if (!res) return { offsets: [], venues: [], pooled: null, categories: [] };
  const n = res.offsetsS.length;
  const known = new Set(venueIds);
  const cells = res.cells.filter((c) => known.has(c.venueId));
  const byVenue = new Map<string, MarkoutCurveCell[]>();
  for (const c of cells) {
    let list = byVenue.get(c.venueId);
    if (!list) { list = []; byVenue.set(c.venueId, list); }
    list.push(c);
  }
  const venues = [...byVenue].map(([id, list]) => fold(id, list, list.filter((c) => matches(c, filter)), res.coverage[id]?.usd ?? 0, n))
    .filter((v) => v.fills > 0)
    .sort((a, b) => b.usd - a.usd);
  const coverAll = [...known].reduce((s, id) => s + (res.coverage[id]?.usd ?? 0), 0);
  const pooled = venues.length > 1 ? fold('ALL', cells, cells.filter((c) => matches(c, filter)), coverAll, n) : null;
  const categories = [...new Set(cells.map((c) => c.category))].sort();
  return { offsets: res.offsetsS, venues, pooled, categories };
}

/** "nice" y-axis ticks spanning [lo, hi] (always including 0). */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  const min = Math.min(lo, 0), max = Math.max(hi, 0);
  const span = max - min || 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
