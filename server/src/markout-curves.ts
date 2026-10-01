import {
  CURVE_OFFSETS_S, CURVE_QUIET_MOVE_BPS, curveFlow, curveMarkMs, pairOf,
  type CurveRoute, type FillCategory, type MarkoutCurveCell, type MarkoutCurvesResponse,
} from '@shared';

/**
 * Markout CURVES — the per-fill markout from 5s before to 15s after execution,
 * aggregated per venue (Solmaz, Heimbach & Milionis, arXiv 2609.38056: the
 * pre-fill leg is what separates a venue that reprices ahead of flow from one
 * that gets picked off; the fixed 0/5/10/30/60s horizons start at the fill and
 * can't show it).
 *
 * Why the curve is stored PER FILL (fills.curve_bps) rather than replayed: the
 * live reference is a 100ms in-memory ring that lives ~2 minutes, and the
 * persisted every-5s mid curve was retired after it filled the prod disk. So a
 * live fill's curve is captured while the ring still covers it, and closed
 * days are completed from the exchanges' second-precision archives
 * (history/cex.ts) — both against the same pair-terms reference.
 *
 * Curves never ride the fill stream: the WS frame is the egress budget, and no
 * consumer needs a per-fill curve. Only the aggregate ships, over REST.
 */

/** TAKER-signed curve points for one fill (same sign as Fill.markoutsBps). A
 *  point with no honest reference stays null — never a fabricated zero.
 *  Rounded to 0.01bp: far below any reference noise, and it keeps the stored
 *  JSON (one per retained fill) compact on a disk-constrained box. */
export function curvePoints(
  f: { ts: number; side: string; execPx: number },
  midAt: (t: number) => number | null | undefined,
): (number | null)[] {
  const ss = f.side === 'buy' ? 1 : -1;
  return CURVE_OFFSETS_S.map((h) => {
    const mid = midAt(curveMarkMs(f.ts, h));
    if (mid == null || !(mid > 0) || !(f.execPx > 0)) return null;
    return Math.round(ss * (mid / f.execPx - 1) * 1e6) / 100;
  });
}

export function curveComplete(curve: readonly (number | null)[] | null | undefined): curve is number[] {
  return !!curve && curve.length === CURVE_OFFSETS_S.length && curve.every((v) => v != null && Number.isFinite(v));
}

/** The light row the aggregation needs. pxApprox rows take part in the
 *  per-transaction route classification (they are real legs) but never in
 *  the curve stats themselves. */
export interface CurveRow {
  id: string;
  ts: number;
  venueId: string;
  market: string;
  category: FillCategory;
  side: string;
  pool: string;
  usd: number;
  txHash: string;
  pxApprox: boolean;
  curve: (number | null)[] | null;
}

/** Route class of one transaction's TRACKED legs. Several fills on one pool in
 *  one direction are one leg (a book sweeping several maker orders emits one
 *  log per order), so they stay `single`. */
export function routeOf(legs: readonly Pick<CurveRow, 'venueId' | 'pool' | 'market' | 'side'>[]): CurveRoute {
  const sides = new Map<string, Set<string>>();
  const pools = new Set<string>();
  for (const l of legs) {
    pools.add(`${l.venueId}|${l.pool}`);
    const base = pairOf(l.market)?.base ?? l.market;
    let s = sides.get(base);
    if (!s) { s = new Set(); sides.set(base, s); }
    s.add(l.side);
  }
  for (const s of sides.values()) if (s.size > 1) return 'twoSided';
  return pools.size > 1 ? 'split' : 'single';
}

export type CurvePager = () => CurveRow[];

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * One pass over the window (ts, id)-ascending in bounded pages. A transaction's
 * fills share its block's timestamp, so they arrive inside one equal-ts run:
 * buffering exactly that run groups every transaction without an index on
 * tx_hash (the disk can't spare one) and without holding the window.
 */
export async function computeMarkoutCurves(pager: CurvePager, days: number, now: number): Promise<MarkoutCurvesResponse> {
  const n = CURVE_OFFSETS_S.length;
  const cells = new Map<string, MarkoutCurveCell>();
  const coverage: Record<string, { fills: number; usd: number }> = {};
  let run: CurveRow[] = [];
  let runTs = Number.NaN;

  const flush = () => {
    const byTx = new Map<string, CurveRow[]>();
    for (const r of run) {
      let legs = byTx.get(r.txHash);
      if (!legs) { legs = []; byTx.set(r.txHash, legs); }
      legs.push(r);
    }
    for (const legs of byTx.values()) {
      const route = routeOf(legs);
      for (const r of legs) {
        if (r.pxApprox) continue;
        const cov = (coverage[r.venueId] ??= { fills: 0, usd: 0 });
        cov.fills++;
        cov.usd += r.usd;
        if (!curveComplete(r.curve)) continue;
        const flow = curveFlow(r.curve)!;
        const key = `${r.venueId}|${flow}|${route}|${r.category}`;
        let c = cells.get(key);
        if (!c) {
          c = { venueId: r.venueId, flow, route, category: r.category, fills: 0, usd: 0, usdBps: new Array<number>(n).fill(0) };
          cells.set(key, c);
        }
        c.fills++;
        c.usd += r.usd;
        for (let i = 0; i < n; i++) c.usdBps[i] += r.usd * r.curve[i];
      }
    }
    run = [];
  };

  for (;;) {
    const page = pager();
    if (!page.length) break;
    for (const r of page) {
      if (r.ts !== runTs) { flush(); runTs = r.ts; }
      run.push(r);
    }
    await yieldLoop();
  }
  flush();

  const round = (v: number, dp: number) => { const k = 10 ** dp; return Math.round(v * k) / k; };
  return {
    days,
    generatedAt: now,
    offsetsS: [...CURVE_OFFSETS_S],
    quietMoveBps: CURVE_QUIET_MOVE_BPS,
    cells: [...cells.values()].map((c) => ({ ...c, usd: round(c.usd, 2), usdBps: c.usdBps.map((v) => round(v, 1)) })),
    coverage: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, { fills: v.fills, usd: round(v.usd, 2) }])),
  };
}
