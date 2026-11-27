import { CURVE_OFFSETS_S, type Fill, type FillCategory, type Side } from '@shared';
import { computeLeaderboard, type LbFill } from './analytics.js';
import { computeMarkoutCurves, curvePoints, routeOf, type CurveRow } from './markout-curves.js';

/**
 * Today's leaderboard and markout-curve answers over a synthetic window. The
 * Rust service's aggregations (service/crates/analytics) are tested against
 * them, so the two implementations cannot drift — down to tie order and
 * Math.round's half-toward-+∞.
 *
 * The window is built to reach every branch that decides an answer: volume
 * ties straddling the top-12 cut, PnL ties straddling the top-50 and outlier
 * cuts, null markouts, groups above and below the sparkline's 80 points,
 * pools shared by venues and markets, equal-timestamp runs whose transactions
 * interleave, sweeps, splits, two-sided legs across wrapper and crypto-quoted
 * markets, pxApprox legs that route but don't count, incomplete curves, and
 * a cell whose rounding lands on a negative half. `assertExercised` fails the
 * build of the file if a change to the generator stops reaching one.
 *
 * Only arithmetic and a 32-bit PRNG feed it (no Math.log/exp/pow), so the
 * window is the same on every machine.
 */

const NOW = 1_795_000_000_000;
const DAYS = 7;
const SLOTS = 600;
const PAGE = 500;

/** mulberry32: integer-only, identical everywhere. */
function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface VenueSpec { markets: string[]; pool: (m: string) => string; weight: number; pxApprox?: boolean }
const VENUES: Record<string, VenueSpec> = {
  metric: { markets: ['MON/USDC', 'MON/AUSD', 'ETH/USDC'], pool: (m) => `metric:${m}`, weight: 24 },
  // hanji and kuru label their MON/USDC books the same: one pool key, two venues.
  hanji: { markets: ['MON/USDC', 'BTC/USDC', 'XAUt/USDC', 'SPYx/USDC'], pool: (m) => m, weight: 20 },
  kuru: { markets: ['MON/USDC', 'MON/USDT0', 'cbBTC/USDC'], pool: (m) => m, weight: 14 },
  // a singleton contract: one pool label for every market.
  thog: { markets: ['MON/USDC', 'BTC/USDT0', 'ETH/USDT0'], pool: () => 'ThogAMM', weight: 14 },
  btr: { markets: ['MON/ETH', 'BTC/MON', 'cbBTC/MON'], pool: (m) => `btr:${m}`, weight: 10 },
  // FOO/USDC is unregistered: routeOf falls back to the market as its base.
  crystal: { markets: ['MON/USDC', 'FOO/USDC'], pool: (m) => `crystal:${m}`, weight: 8 },
  clober: { markets: ['MON/USDC', 'BTC/USDC'], pool: (m) => `clober:${m}`, weight: 0, pxApprox: true },
};
const PRICE: Record<string, number> = { MON: 0.03, BTC: 90_000, cbBTC: 90_000, ETH: 3_000, XAUt: 2_600, SPYx: 600, FOO: 1 };
const CATEGORIES: [FillCategory, number][] = [['DIRECT', 30], ['ROUTER', 25], ['AGG', 20], ['MEV', 10], ['CEX/DEX', 10], ['UNKNOWN', 5]];
const BIG_TO = ['Relay', 'KyberSwap', '0x', 'OKX', 'Bebop'];
const TIE_TO = Array.from({ length: 8 }, (_, i) => `tie-${i + 1}`);
const TIE_USD = 7777.77, TIE_FILLS = 25;
const WHALES = 70, WHALES_LAST_DAY = 3, WHALE_USD = 30_000, WHALE_BPS = 20;

const r2 = (v: number) => Math.round(v * 100) / 100;
const short = (v: number) => Number(v.toPrecision(6));
const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');

interface Leg { venue: string; market: string; side: Side; usd?: number; mks?: (number | null)[]; curve?: (number | null)[] | null }
interface TxPlan { legs: Leg[]; to?: string; category?: FillCategory }

function buildWindow() {
  const rnd = prng(0x5eed_a11);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const weighted = <T>(xs: readonly [T, number][]): T => {
    let x = rnd() * xs.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of xs) if ((x -= w) < 0) return v;
    return xs[xs.length - 1][0];
  };
  const side = (): Side => (rnd() < 0.5 ? 'buy' : 'sell');
  const flip = (s: Side): Side => (s === 'buy' ? 'sell' : 'buy');
  const usd = () => { const r = rnd(); return r2(10 + r * r * r * 30_000); };
  const mk = () => r2((rnd() + rnd() + rnd() - 1.5) * 8);
  const tailTo = Array.from({ length: 70 }, (_, i) => `0x${hex(i * 2654435761 >>> 16, 4)}…${hex(i * 40503 & 0xffff, 4)}`);
  const toLabel = () => (rnd() < 0.55 ? weighted(BIG_TO.map((t, i) => [t, [30, 20, 15, 10, 8][i]] as [string, number])) : pick(tailTo));
  const tracked = Object.entries(VENUES).filter(([, v]) => v.weight > 0);
  const venue = () => weighted(tracked.map(([id, v]) => [id, v.weight] as [string, number]));
  const combos = tracked.flatMap(([id, v]) => v.markets.map((market) => ({ venue: id, market })));
  const byBase = (base: string) => combos.filter((c) => c.market.split('/')[0].replace('cbBTC', 'BTC') === base);

  const normalTx = (): TxPlan => {
    const kind = weighted<string>([['single', 50], ['sweep', 10], ['split', 12], ['twoSided', 10], ['approx', 7], ['thog', 6], ['foo', 5]]);
    const v = venue(), s = side();
    switch (kind) {
      case 'single': return { legs: [{ venue: v, market: pick(VENUES[v].markets), side: s }] };
      case 'sweep': {
        const market = pick(VENUES[v].markets), n = 2 + Math.floor(rnd() * 3);
        return { legs: Array.from({ length: n }, () => ({ venue: v, market, side: s })) };
      }
      case 'split': return { legs: [pick(combos), pick(combos)].map((c) => ({ ...c, side: s })) };
      case 'twoSided': {
        const set = byBase(pick(['MON', 'MON', 'BTC']));
        return { legs: [{ ...pick(set), side: s }, { ...pick(set), side: flip(s) }] };
      }
      case 'approx': return { legs: [{ ...pick(byBase('MON')), side: s }, { venue: 'clober', market: pick(VENUES.clober.markets), side: side() }] };
      case 'thog': {
        const [a, b] = rnd() < 0.5 ? ['MON/USDC', 'BTC/USDT0'] : ['ETH/USDT0', 'MON/USDC'];
        return { legs: [{ venue: 'thog', market: a, side: s }, { venue: 'thog', market: b, side: s }] };
      }
      default: return { legs: [{ venue: 'crystal', market: 'FOO/USDC', side: s }, rnd() < 0.5
        ? { venue: 'crystal', market: 'FOO/USDC', side: flip(s) } : { venue: 'crystal', market: 'MON/USDC', side: s }] };
    }
  };

  const curveFor = (pxApprox: boolean): (number | null)[] | null => {
    const r = rnd();
    if (pxApprox) return r < 0.5 ? null : CURVE_OFFSETS_S.map(() => mk()); // must never count
    if (r < 0.1) return null;
    const level = mk(), drift = (rnd() - 0.5) * 6;
    const c: (number | null)[] = CURVE_OFFSETS_S.map((h) => r2(level + (drift * (h + 5)) / 20 + (rnd() - 0.5) * 0.4));
    if (r < 0.17) c[Math.floor(rnd() * c.length)] = null;
    else if (r < 0.2) c.pop(); // a curve from another offset model
    return c;
  };

  // The slots (block seconds), oldest first; duplicates merge into one run.
  const span = DAYS * 86_400 - 120;
  const slots = Array.from({ length: SLOTS }, () => NOW - DAYS * 86_400_000 + 60_000 + Math.floor(rnd() * span) * 1000)
    .sort((a, b) => a - b);
  const lastDay = slots.findIndex((t) => t >= NOW - 86_400_000);

  // Special transactions, planned onto slots up front.
  const special = new Map<number, TxPlan[]>();
  const plan = (slot: number, tx: TxPlan) => { const l = special.get(slot) ?? []; l.push(tx); special.set(slot, l); };
  const older = () => Math.floor(rnd() * lastDay), recent = () => lastDay + Math.floor(rnd() * (SLOTS - lastDay));
  for (let k = 0; k < WHALES; k++) {
    for (const sign of [1, -1]) {
      const v = venue();
      const bps = sign * WHALE_BPS;
      // T+0 all tie (the top-50 cut falls among them); T+10 the first 20 tie.
      const mks = [bps, mk(), k < 20 ? bps : mk(), mk(), mk()];
      plan(k < WHALES_LAST_DAY ? recent() : older(),
        { to: pick(BIG_TO), legs: [{ venue: v, market: pick(VENUES[v].markets), side: side(), usd: WHALE_USD, mks }] });
    }
  }
  for (const to of TIE_TO) {
    for (let k = 0; k < TIE_FILLS; k++) {
      const v = venue();
      plan(Math.floor(rnd() * SLOTS), { to, legs: [{ venue: v, market: pick(VENUES[v].markets), side: side(), usd: TIE_USD, mks: [mk(), mk(), mk(), mk(), mk()] }] });
    }
  }
  // 1.5 × −1.5 = −2.25 per offset: usdBps rounds a negative half (−22.5 → −22).
  plan(recent(), { to: 'edge-taker', category: 'DIRECT', legs: [{ venue: 'edge', market: 'MON/USDC', side: 'buy', usd: 1.5,
    mks: [1, 1, 1, 1, 1], curve: CURVE_OFFSETS_S.map(() => -1.5) }] });

  const fills: Fill[] = [];
  const curves = new Map<string, (number | null)[] | null>();
  let block = 40_000_000, txN = 0;
  slots.forEach((ts, slot) => {
    const txs: TxPlan[][] = [];
    const nBlocks = rnd() < 0.4 ? 2 : 1;
    for (let b = 0; b < nBlocks; b++) txs.push(Array.from({ length: 1 + Math.floor(rnd() * 2.2) }, normalTx));
    for (const tx of special.get(slot) ?? []) txs[Math.floor(rnd() * txs.length)].push(tx);
    for (const blockTxs of txs) {
      block += 1 + Math.floor(rnd() * 2);
      let logIndex = 0;
      for (const tx of blockTxs) {
        const txHash = `0x${hex(txN++, 5)}${hex(Math.floor(rnd() * 0xffff), 4)}`;
        const category = tx.category ?? weighted(CATEGORIES);
        const to = tx.to ?? toLabel();
        const router = category === 'ROUTER' || category === 'AGG' || category === 'MEV' ? to : undefined;
        const young = ts > NOW - 2 * 3_600_000;
        for (const leg of tx.legs) {
          const spec = VENUES[leg.venue] ?? { markets: [], pool: (m: string) => `${leg.venue}:${m}`, weight: 0 };
          const [base, quote] = leg.market.split('/');
          const execPx = short((PRICE[base] / (PRICE[quote] ?? 1)) * (1 + (rnd() - 0.5) * 0.002));
          const value = leg.usd ?? usd();
          const id = `${leg.venue}-${txHash}-${logIndex++}`;
          const mks = spec.pxApprox ? [null, null, null, null, null]
            : leg.mks ?? [0, 1, 2, 3, 4].map((i) => (rnd() < 0.08 || (young && i === 4 && rnd() < 0.5) ? null : mk()));
          const f: Fill = {
            id, venueId: leg.venue, market: leg.market, side: leg.side, category, usd: value,
            baseAmount: short(value / PRICE[base]), execPx, ...(spec.pxApprox ? { pxApprox: true } : {}),
            txHash, to, ...(router ? { router } : {}), pool: spec.pool(leg.market), blockNumber: block, ts, markoutsBps: mks,
          };
          fills.push(f);
          curves.set(id, leg.curve !== undefined ? leg.curve : curveFor(!!spec.pxApprox));
        }
      }
    }
  });
  // The window as both sources hand it over: (ts, id) ascending.
  fills.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { fills, curves: fills.map((f) => curves.get(f.id) ?? null) };
}

const lbRow = (f: Fill): LbFill => ({
  id: f.id, ts: f.ts, venueId: f.venueId, market: f.market, category: f.category, pool: f.pool, to: f.to, usd: f.usd,
  markoutsBps: f.markoutsBps,
});
const pages = <T>(rows: T[]) => { let i = 0; return () => rows.slice(i, (i += PAGE)); };

/** curvePoints over a deterministic reference, recording every mark it asked
 *  for and the mid it got, so the Rust side can replay the same lookups. */
function curvePointCases() {
  const ref = (execPx: number) => (t: number): number | null => {
    const s = Math.floor(t / 1000) % 7;
    if (s === 2) return null;
    if (s === 5) return 0; // not a usable mid
    return execPx * (1 + (s - 3) * 1.37e-4 + (t % 1000) * 1e-9);
  };
  const half = () => 0.9921875; // −1/128 → −7812.5 bp/100: Math.round's negative half
  const cases: { ts: number; side: Side; execPx: number; midAt: (t: number) => number | null }[] = [
    { ts: 1_795_000_123_000, side: 'buy', execPx: 0.031237, midAt: ref(0.031237) },
    { ts: 1_795_000_123_000, side: 'sell', execPx: 0.031237, midAt: ref(0.0312) },
    { ts: 1_795_000_456_789.25, side: 'buy', execPx: 91_234.5, midAt: ref(91_250) },
    { ts: 1_795_000_000_000, side: 'buy', execPx: 1, midAt: half },
    { ts: 1_795_000_000_000, side: 'sell', execPx: 1, midAt: () => 1.0078125 },
    { ts: 1_795_000_000_000, side: 'buy', execPx: 0, midAt: () => 1 },
  ];
  return cases.map(({ ts, side, execPx, midAt }) => {
    const mids: [number, number | null][] = [];
    const points = curvePoints({ ts, side, execPx }, (t) => { const m = midAt(t); mids.push([t, m]); return m; });
    return { ts, side, execPx, mids, points };
  });
}

const MATH_ROUND = [0.5, -0.5, 1.5, -1.5, 2.5, -2.5, -7812.5, 0.49999999999999994, -0.49999999999999994,
  4503599627370495.5, -4503599627370495.5, 1e300, -1e300, 123.456, -123.456, -22.5, 22.5, -0.75];

/** Throws when the window stops reaching a case the parity test is for. */
function assertExercised(lb: Awaited<ReturnType<typeof computeLeaderboard>>, curves: Awaited<ReturnType<typeof computeMarkoutCurves>>,
  fills: Fill[], routes: [string, string][]) {
  const need = (ok: boolean, what: string) => { if (!ok) throw new Error(`analytics golden no longer exercises ${what}`); };
  const toKeys = lb.groups.to['0'].map((r) => r.key);
  const ties = toKeys.filter((k) => k.startsWith('tie-'));
  need(ties.length > 0 && ties.length < TIE_TO.length, 'a volume tie straddling the top-12 cut');
  need(lb.topSwaps['0'].winners.length === 50 && lb.topSwaps['0'].winners.every((f) => f.usd === WHALE_USD), 'a PnL tie at the top-50 cut');
  need(lb.topSwaps['2'].winners.filter((f) => f.usd === WHALE_USD).length >= 20 && lb.topSwaps['2'].winners.some((f) => f.usd !== WHALE_USD), 'ties above sorted swaps');
  need(lb.outliers.length === 18 && lb.outliers.filter((f) => f.usd === WHALE_USD).length === 2 * WHALES_LAST_DAY, 'outlier ties above sorted outliers');
  const rows = Object.values(lb.groups).flatMap((byHz) => Object.values(byHz).flat());
  const stride = (n: number) => Math.max(1, Math.ceil(n / 80));
  need(rows.some((r) => r.swaps > 80 && r.swaps % stride(r.swaps) === 0) && rows.some((r) => r.swaps > 80 && r.swaps % stride(r.swaps) !== 0)
    && rows.some((r) => r.swaps <= 80), 'sparklines on and off the stride');
  const pools = lb.groups.pool['0'];
  need(pools.some((r) => !r.venueId && r.market) && pools.some((r) => r.venueId && !r.market) && pools.some((r) => r.venueId && r.market), 'pool metadata kept only when unique');
  need(['single', 'split', 'twoSided'].every((rt) => curves.cells.some((c) => c.route === rt)), 'every route');
  need(['quiet', 'moving'].every((fl) => curves.cells.some((c) => c.flow === fl)), 'both flows');
  need(curves.cells.some((c) => c.usdBps.some((v) => v === -2.2)), 'a negative-half rounding');
  need(routes.some(([tx]) => fills.some((f) => f.txHash === tx && f.pxApprox)), 'pxApprox legs in a routed transaction');
  need(fills.some((f, i) => i > 0 && f.ts === fills[i - 1].ts && f.txHash !== fills[i - 1].txHash), 'transactions sharing a run');
}

function assertPointsExercised(cases: ReturnType<typeof curvePointCases>) {
  const pts = cases.flatMap((c) => c.points);
  const mids = cases.flatMap((c) => c.mids.map(([, m]) => m));
  if (!(pts.some((p) => p == null) && mids.includes(null) && mids.includes(0) && pts.includes(-78.12)))
    throw new Error('analytics golden no longer exercises curvePoints\' null, zero-mid and negative-half cases');
}

export async function analyticsGolden() {
  const { fills, curves } = buildWindow();
  const want = (ids: string[]) => { const s = new Set(ids); return fills.filter((f) => s.has(f.id)); };
  const lbRows = fills.filter((f) => !f.pxApprox).map(lbRow);
  const curveRows: CurveRow[] = fills.map((f, i) => ({
    id: f.id, ts: f.ts, venueId: f.venueId, market: f.market, category: f.category, side: f.side, pool: f.pool,
    usd: f.usd, txHash: f.txHash, pxApprox: !!f.pxApprox, curve: curves[i],
  }));
  const leaderboard = await computeLeaderboard(() => pages(lbRows), DAYS, NOW, want);
  const markoutCurves = await computeMarkoutCurves(pages(curveRows), DAYS, NOW);

  const byTx = new Map<string, Fill[]>();
  for (const f of fills) { const l = byTx.get(f.txHash) ?? []; l.push(f); byTx.set(f.txHash, l); }
  const routes = [...byTx].filter(([, legs]) => legs.length > 1).map(([tx, legs]) => [tx, routeOf(legs)] as [string, string]);
  assertExercised(leaderboard, markoutCurves, fills, routes);
  const points = curvePointCases();
  assertPointsExercised(points);

  return {
    $comment: 'Generated by `npm -w server run analytics:golden` (server/src/analytics-golden.ts); do not edit.',
    now: NOW,
    days: DAYS,
    /** (ts, id) ascending; the leaderboard reads the non-pxApprox ones, the curves all of them with `curves[i]`. */
    fills,
    curves,
    leaderboard,
    markoutCurves,
    routes,
    curvePoints: points,
    mathRound: MATH_ROUND.map((x) => [x, Math.round(x)]),
    empty: {
      leaderboard: await computeLeaderboard(() => () => [], 1, NOW, want),
      markoutCurves: await computeMarkoutCurves(() => [], 1, NOW),
    },
  };
}
