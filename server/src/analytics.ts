import {
  LEADERBOARD_HORIZON_IDX, LEADERBOARD_GROUPINGS,
  type Fill, type LeaderboardResponse, type LeaderboardGroupRow,
} from '@shared';

/**
 * Server-side leaderboard aggregation (docs/architecture.md: API).
 *
 * The tabs used to ship raw fills to the browser and aggregate there — which
 * silently truncated the 7D/30D windows at the fetch cap (~20k fills ≈ <2 days
 * at Metric's fill rate). This computes the SAME stats the client did (same
 * percentile fn, same filters, same ordering) over the FULL window, next to the
 * rows. Everything is TAKER-signed; the MAKER view is a pure sign flip the
 * client derives, so nothing is computed twice.
 *
 * Shape is dictated by the production box (512MB, 0.5 vCPU — a synchronous
 * full-window materialization both stalled the quote stream for ~15s AND
 * OOM-crashed the process, observed live):
 *  - rows arrive in bounded PAGES from a pass factory (keyset SQL pages for
 *    live, array slices for sim) — the full window is never materialized;
 *  - TWO passes: pass 1 accumulates scalars (volume/swaps/PnL) + bounded
 *    top-K candidates; pass 2 collects the percentile/sparkline arrays ONLY
 *    for the top-12 groups that pass 1 ranked;
 *  - the loop YIELDS to the event loop between pages so quote ticks and WS
 *    broadcasts keep flowing while it runs.
 */

/** The light row shape the aggregation needs — `Fill` satisfies it structurally,
 *  and the live source materializes exactly these columns from SQLite. */
export interface LbFill {
  id: string;
  ts: number;
  venueId: string;
  market: string;
  category: string;
  pool: string;
  to: string;
  usd: number;
  markoutsBps: (number | null)[];
}

/** sequential pager: each call returns the next page (ts/id-ascending); an
 *  empty page ends the pass. */
export type LbPager = () => LbFill[];
/** fresh pager per pass — computeLeaderboard streams the window TWICE. Both
 *  passes must serve the same window bounds; live fills landing in between are
 *  excluded by the caller pinning the pass upper bound to the request time. */
export type LbPassFactory = () => LbPager;

const TOP_GROUPS = 12;   // the UI renders the top 12 groups by volume
const TOP_SWAPS = 50;    // max TOP_SWAPS pill (TOP 10/25/50)
const OUTLIERS = 18;     // OUTLIER_FEED depth (Markouts tab)
const SPARK_POINTS = 80; // downsampled cumulative-PnL sparkline length

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** bounded top-K selector: retains ≤ 8·cap candidates between prunes, so
 *  selecting the top 50 of 10⁶ never holds 10⁶ entries. Stable-sort pruning
 *  keeps every true top-K member (it is within the top 8·cap at every prune). */
function topK<T>(cap: number, cmp: (a: T, b: T) => number): { push: (x: T) => void; take: () => T[] } {
  let buf: T[] = [];
  return {
    push(x: T) {
      buf.push(x);
      if (buf.length >= cap * 8) { buf.sort(cmp); buf = buf.slice(0, cap); }
    },
    take() { buf.sort(cmp); return buf.slice(0, cap); },
  };
}

interface Tally { vol: number; swaps: number; pnl: number }
interface PoolMeta { venueIds: Set<string>; markets: Set<string> }
/** pass-2 accumulator for one TOP group-cell. `mks` is an exact-size typed
 *  array (the count is known from pass 1) — plain number[] growth doubled the
 *  aggregation's footprint on the memory-tight production box. */
interface Cell { mks: Float64Array; filled: number; stride: number; cum: number; cnt: number; spark: number[] }

/** percentile read over an ALREADY-SORTED array — same linear interpolation as
 *  @shared's percentile(), but the cell sorts once for all five reads instead
 *  of five sort-copies. */
function pctOf(sorted: Float64Array, p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Aggregate one window. `makePass` yields a fresh pager per pass (rows already
 * pxApprox-excluded). `fullFills` resolves ids → full Fill rows for the
 * topSwaps/outlier feeds (a DB lookup for live, an in-memory filter for sim).
 */
export async function computeLeaderboard(
  makePass: LbPassFactory,
  days: number,
  now: number,
  fullFills: (ids: string[]) => Fill[],
): Promise<LeaderboardResponse> {
  const H = LEADERBOARD_HORIZON_IDX;
  const G = LEADERBOARD_GROUPINGS;
  const daySince = now - 86_400_000;
  const rowKeys: string[] = new Array(G.length);
  const keysOf = (f: LbFill) => {
    rowKeys[0] = f.venueId;                                        // protocol
    rowKeys[1] = f.pool;                                           // pool
    rowKeys[2] = f.to;                                             // to
    rowKeys[3] = f.category === 'DIRECT' ? 'direct' : f.category;  // category (client's key)
  };

  // ── pass 1: scalars per (grouping, horizon, key) + bounded candidate top-Ks ──
  const tallies: Map<string, Tally>[][] = G.map(() => H.map(() => new Map<string, Tally>()));
  // Pool keys stay byte-for-byte stable in SQLite. Track presentation metadata
  // beside each horizon instead of rewriting the key; a contract that serves
  // multiple markets (e.g. one router/pool) deliberately gets no single-market
  // label rather than a misleading first-seen one.
  const poolMeta: Map<string, PoolMeta>[] = H.map(() => new Map<string, PoolMeta>());
  const winners = H.map(() => topK<{ pnl: number; id: string }>(TOP_SWAPS, (a, b) => b.pnl - a.pnl));
  const losers = H.map(() => topK<{ pnl: number; id: string }>(TOP_SWAPS, (a, b) => a.pnl - b.pnl));
  const outs = topK<{ pnl: number; id: string }>(OUTLIERS, (a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  let totalFills = 0;

  let pager = makePass();
  for (let page = pager(); page.length; page = pager()) {
    for (const f of page) {
      totalFills++;
      keysOf(f);
      for (let h = 0; h < H.length; h++) {
        const mk = f.markoutsBps[H[h]];
        if (mk == null) continue; // no realized markout at this horizon — never coerced to 0
        const pnl = (mk / 1e4) * f.usd;
        if (pnl > 0) winners[h].push({ pnl, id: f.id });        // strict: pnl 0 is neither
        else if (pnl < 0) losers[h].push({ pnl, id: f.id });
        if (H[h] === 0 && f.ts >= daySince) outs.push({ pnl, id: f.id });
        let pm = poolMeta[h].get(f.pool);
        if (!pm) {
          pm = { venueIds: new Set<string>(), markets: new Set<string>() };
          poolMeta[h].set(f.pool, pm);
        }
        pm.venueIds.add(f.venueId);
        pm.markets.add(f.market);
        for (let g = 0; g < G.length; g++) {
          const m = tallies[g][h];
          let t = m.get(rowKeys[g]);
          if (!t) { t = { vol: 0, swaps: 0, pnl: 0 }; m.set(rowKeys[g], t); }
          t.vol += f.usd;
          t.swaps += 1;
          t.pnl += pnl;
        }
      }
    }
    await yieldLoop();
  }

  // rank: ordered top-12 keys by volume per (grouping, horizon)
  const topLists: string[][][] = tallies.map((byHz) => byHz.map((m) =>
    [...m].sort((a, b) => b[1].vol - a[1].vol).slice(0, TOP_GROUPS).map(([k]) => k)));

  // ── pass 2: percentile + sparkline arrays for the TOP groups only ──
  const cells: Map<string, Cell>[][] = G.map((_, g) => H.map((_, h) => {
    const m = new Map<string, Cell>();
    for (const k of topLists[g][h]) {
      const t = tallies[g][h].get(k)!;
      m.set(k, { mks: new Float64Array(t.swaps), filled: 0, stride: Math.max(1, Math.ceil(t.swaps / SPARK_POINTS)), cum: 0, cnt: 0, spark: [] });
    }
    return m;
  }));

  pager = makePass();
  for (let page = pager(); page.length; page = pager()) {
    for (const f of page) {
      keysOf(f);
      for (let h = 0; h < H.length; h++) {
        const mk = f.markoutsBps[H[h]];
        if (mk == null) continue;
        const pnl = (mk / 1e4) * f.usd;
        for (let g = 0; g < G.length; g++) {
          const c = cells[g][h].get(rowKeys[g]);
          if (!c) continue;
          // bounds guard: a fill re-marked BETWEEN the passes (remark job) can
          // make pass 2 see more values than pass 1 counted — drop the extras
          // rather than overflow; the next TTL recompute picks them up.
          if (c.filled < c.mks.length) c.mks[c.filled++] = mk;
          c.cum += pnl;
          if (++c.cnt % c.stride === 0) c.spark.push(c.cum); // downsampled cumulative PnL
        }
      }
    }
    await yieldLoop();
  }

  // build the group tables
  const groups = {} as LeaderboardResponse['groups'];
  for (let g = 0; g < G.length; g++) {
    const byHz: Record<string, LeaderboardGroupRow[]> = {};
    for (let h = 0; h < H.length; h++) {
      byHz[String(H[h])] = topLists[g][h].map((key) => {
        const t = tallies[g][h].get(key)!;
        const c = cells[g][h].get(key)!;
        if (c.cnt > 0 && c.cnt % c.stride !== 0) c.spark.push(c.cum); // spark always ends at the total
        const sorted = c.mks.subarray(0, c.filled).sort(); // one sort serves all five reads
        const pm = G[g] === 'pool' ? poolMeta[h].get(key) : undefined;
        return {
          key,
          ...(pm?.venueIds.size === 1 ? { venueId: pm.venueIds.values().next().value as string } : {}),
          ...(pm?.markets.size === 1 ? { market: pm.markets.values().next().value as string } : {}),
          vol: t.vol,
          swaps: t.swaps,
          p5: pctOf(sorted, 0.05), p25: pctOf(sorted, 0.25), p50: pctOf(sorted, 0.5),
          p75: pctOf(sorted, 0.75), p95: pctOf(sorted, 0.95),
          pnl: t.pnl,
          spark: c.spark,
        };
      });
      await yieldLoop(); // percentile sorts over big groups are the other heavy step
    }
    groups[G[g]] = byHz;
  }

  // top swaps per horizon (strict winners desc / losers asc — identical filters
  // + ordering to the client's old lbVals()) and the 24h outlier feed.
  const winSel = H.map((_, h) => winners[h].take());
  const losSel = H.map((_, h) => losers[h].take());
  const outSel = outs.take();
  const wantIds = new Set<string>();
  for (const sel of [...winSel, ...losSel, outSel]) for (const x of sel) wantIds.add(x.id);
  const byId = new Map<string, Fill>();
  for (const f of fullFills([...wantIds])) byId.set(f.id, f);
  const resolve = (sel: Array<{ id: string }>): Fill[] =>
    sel.map((x) => byId.get(x.id)).filter((f): f is Fill => f != null);

  const topSwaps: LeaderboardResponse['topSwaps'] = {};
  H.forEach((hz, h) => { topSwaps[String(hz)] = { winners: resolve(winSel[h]), losers: resolve(losSel[h]) }; });

  return {
    days,
    generatedAt: now,
    totalFills,
    groups,
    topSwaps,
    outliers: resolve(outSel),
  };
}
