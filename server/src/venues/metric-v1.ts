import { decodeErrorResult, parseAbi } from 'viem';
import type { Fill, QuoteRow, Side } from '@shared';
import { TOKENS } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { AdapterContext, LogBundle } from './adapter.js';
import type { VenueGeneration } from './generations.js';
import { createQuoteOutageLatch, createQuoteOutageReporter, type MulticallOutcome } from './quote-health.js';
import { METRIC_VENUE, admitMetricPool, metricFill, metricPoolLiveness, type MetricPool, type NotLiveReason } from './metric-shared.js';

/**
 * Metric v1 — the LIVE deployment (since 2026-09-15; first swap 2026-10-04,
 * after the v0 pools were drained on 2026-09-30). An oracle-anchored bin AMM
 * (propAMM), permissionless: anyone can run a pool on Metric's factory.
 *
 *   Factory.nextPoolIdx()/idxToPool(i)     → the full pool set (enumerable)
 *   Pool.getImmutables()                   → token layout (admission)
 *   SwapQuoter.quoteLiveExactInSingle(…)   → realized amounts (eth_call)
 *   Pool.Swap(…, amountDeltas, …)          → the landed fill (PACKED deltas)
 *
 * Addresses + ABIs: @metric.xyz/metric-omm-sdk-v1@0.6.7 (src/addresses.ts — one
 * CREATE2/CREATE3 deployment shared by every chain; docs.metric.xyz →
 * reference/supported-chains-and-deployments lists the same set), each one
 * checked on Monad for code and creation block on 2026-10-12.
 *
 * What changed from v0 (metric-v0.ts) and why it matters here:
 *  - The factory ENUMERATES its pools, so a pool announced once is re-found at
 *    every boot: no persisted pool list, unlike v0 (which lost a funded pool on
 *    the 2026-08-23 deploy for want of one).
 *  - Swap packs both token deltas into one word (Packed2Int128: token0 in the
 *    high int128, token1 in the low; positive = the pool gained it).
 *  - The live quote reads the oracle INSIDE the quoter, and the attributed
 *    oracles serve that read only when tx.origin == 0 (SDK quotePath.ts). An
 *    eth_call without `from` has a zero origin, which is how ctx.client calls;
 *    give the client an account and every leg reverts.
 */

export const V1_FACTORY = '0x2a53833cc95548cf52c7b159110e22d3a9018f32' as const;
/** v1 factory creation — no v1 pool (or its logs) can predate it. */
export const V1_FACTORY_BLOCK = 105_093_536n;
/** The PAUSE-AWARE quoter (SDK 0.6.4+, 2026-10-13), same ABI as the first one
 *  (0x803dd787…, which Metric's docs now call deprecated). The difference is
 *  what a paused pool returns: PoolPaused(pool, level) instead of whatever its
 *  oracle read hits first. On 2026-10-29, live BNB pools quoted identically
 *  through both at one block. */
export const V1_QUOTER = '0x3b9ea79f482094323d06064e637a7f4528560fcb' as const;
export const V1_DATA_PROVIDER = '0x83d66c5934b1525ee82e6e772c76c7acc778bbb7' as const;
/** MetricOmmSimpleRouter — Metric's own periphery (single/multi-hop swaps). */
export const V1_SIMPLE_ROUTER = '0x02201e6f13c41506c7bb635d7543f98826229ab7' as const;

const ZERO = '0x0000000000000000000000000000000000000000';
/** Price-limit sentinels (Q64.64) so a quote walks the full binned liquidity
 *  for the size: no upper bound buying token0, no lower bound selling it
 *  (the SDK's defaultPriceLimitX64). */
const PRICE_LIMIT_UP = (1n << 128n) - 1n;
const PRICE_LIMIT_DOWN = 0n;
/** logSources() swap-source key prefix: `swap@<snapshot>` (see decode). */
const SWAP_KEY_PREFIX = 'swap@';
const INT128_MASK = (1n << 128n) - 1n;
const INT128_SIGN = 1n << 127n;
const toInt128 = (v: bigint) => (v & INT128_SIGN ? v - (1n << 128n) : v);

/** Packed2Int128 → [token0 delta, token1 delta] (SDK utils/packedEvents.ts). */
export function unpackAmountDeltas(packed: bigint): readonly [bigint, bigint] {
  return [toInt128((packed >> 128n) & INT128_MASK), toInt128(packed & INT128_MASK)];
}

// getSellAndBuyPrices / getQuote / quoteLive* are non-view on-chain (they read
// the oracle through a revert/attribution path) but are eth_call-only here, so
// they are declared `view`: mutability is not part of the selector or the
// encoding, and it lets them ride a plain multicall.
export const metricV1PoolAbi = parseAbi([
  'function getImmutables() view returns ((address factory, address token0, address token1, uint256 token0ScaleMultiplier, uint256 token1ScaleMultiplier, uint256 initialScaledToken0PerShareE18, uint256 initialScaledToken1PerShareE18, uint256 minimalOperationalLiquidity, address immutablePriceProvider, int256 lowestBin, int256 highestBin, address extension1, address extension2, address extension3, address extension4, address extension5, address extension6, address extension7, uint256 beforeAddLiquidityOrder, uint256 afterAddLiquidityOrder, uint256 beforeRemoveLiquidityOrder, uint256 afterRemoveLiquidityOrder, uint256 beforeSwapOrder, uint256 afterSwapOrder))',
  'function getSellAndBuyPrices() view returns (uint128 sellPriceX64, uint128 buyPriceX64)',
  'event Swap(address indexed sender, address indexed recipient, uint256 details, uint256 amountDeltas, uint256 platformFees)',
]);
export const metricV1FactoryAbi = parseAbi([
  'function nextPoolIdx() view returns (uint256)',
  'function idxToPool(uint256) view returns (address)',
  'event PoolCreated(address indexed poolAddress, address indexed token0, address indexed token1, uint256 poolIdx, address factory, address admin, address priceProvider, address[] extensions, (uint256 beforeAddLiquidity, uint256 afterAddLiquidity, uint256 beforeRemoveLiquidity, uint256 afterRemoveLiquidity, uint256 beforeSwap, uint256 afterSwap) extensionOrders, uint256 priceProviderTimelock, uint256 initialScaledAmount0PerE18Shares, uint256 initialScaledAmount1PerE18Shares, uint256 minimalOperationalLiquidity, uint24 spreadProtocolFeeE6, uint24 protocolNotionalFeeE8, uint24 adminSpreadFeeE6, uint24 adminNotionalFeeE8, address adminFeeDestination, int24 curBinDistFromProvidedPriceE6, uint256[] nonNegativeBinDataArray, uint256[] negativeBinDataArray)',
]);
const dataProviderAbi = parseAbi(['function priceProvider(address pool) view returns (address)']);
const providerAbi = parseAbi(['function offchainOracle() view returns (address)']);
export const metricV1QuoterAbi = parseAbi([
  'function quoteLiveExactInSingle(address pool, address sender, bool zeroForOne, uint128 amountIn, uint128 priceLimitX64) view returns (uint256 amountIn, uint256 amountOut)',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** The custom errors a v1 quote leg reverts with (SDK abis/*.ts). The quoter
 *  re-raises a pool or extension failure as WrappedError(target, selector,
 *  reason), so the useful name is one or two layers down — and a custom error
 *  carries no Error(string), which is all quote-health's reason reader sees. */
const metricV1ErrorAbi = parseAbi([
  'error WrappedError(address target, bytes4 selector, bytes reason)',
  'error OracleStopLossTriggered(int16 binIdx, bool isToken0Metric, uint256 currentMetric, uint256 threshold)',
  'error PriceVelocityExceeded(uint256 actualDeltaSqE36, uint256 allowedDeltaSqE36)',
  'error PoolPaused()',
  // the quoter's own pre-check: raised before it touches the pool or its oracle
  'error PoolPaused(address pool, uint8 pauseLevel)',
  'error NotAllowedToSwap()',
  'error InsufficientLiquidity(uint256 requested, uint256 available)',
  'error PriceProviderFailed(bytes reason)',
]);

/** The innermost Metric error NAME in a failed leg's viem error chain (the
 *  revert bytes sit on ContractFunctionRevertedError.raw), its selector when
 *  unknown, or null when the leg failed without reverting (transport). */
export function metricV1RevertName(err: unknown): string | null {
  let raw: string | undefined;
  for (let e = err as any, depth = 0; e && depth < 6 && !raw; e = e.cause, depth++) {
    if (typeof e.raw === 'string' && e.raw.length >= 10) raw = e.raw;
  }
  for (let layer = 0; raw && layer < 4; layer++) {
    try {
      const decoded = decodeErrorResult({ abi: metricV1ErrorAbi, data: raw as `0x${string}` });
      if (decoded.errorName !== 'WrappedError') return decoded.errorName;
      raw = decoded.args[2];
    } catch { return `error ${raw.slice(0, 10)}`; }
  }
  return raw ? `error ${raw.slice(0, 10)}` : null;
}

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

type Immutables = { factory: string; token0: string; token1: string; immutablePriceProvider: string };

export function createMetricV1Generation(): VenueGeneration {
  // every leg FAILING is a venue-wide cause (paused, ABI drift, an oracle that
  // refuses the read), not a per-pair gap — name it (venues/quote-health.ts).
  const reportOutage = createQuoteOutageReporter(METRIC_VENUE.name);
  /** one latch per market × side: a pool can block ONE direction while the
   *  other trades — Metric's stop-loss extension refused every MON-out leg
   *  for ~2 minutes on 2026-10-12 (16:18:01 → 16:20:05 UTC) */
  const sideLatches = new Map<string, ReturnType<typeof createQuoteOutageLatch>>();
  // THREE different questions, three different sets — conflating them is what
  // let real fills go uncounted (issue #61):
  //   candidates → every pool the factory lists.
  //   admitted   → structurally understood (registered base/stable pair):
  //                what we TAIL and what we can DECODE.
  //   live       → priceable RIGHT NOW (funded + two-sided price): what we QUOTE.
  // A pool whose oracle stops answering leaves `live` but can keep trading, so
  // its swaps are tailed off admission, never off liveness.
  const candidates = new Set<string>();
  /** next factory index to read (indices are 1-based; 0 is unused). */
  let nextIdx = 1n;
  /** getImmutables answers, cached: they cannot change. */
  const immutables = new Map<string, Immutables>();
  let admittedPools: MetricPool[] = [];
  let pools: MetricPool[] = [];                       // live: quoted
  const byAddr = new Map<string, MetricPool>();       // MONOTONIC decode map
  /** candidates a SUCCESSFUL pass has decided (admitted or rejected). Distinct
   *  from `candidates`, which a failed pass may already have grown: an
   *  announcement is only "known" once its pool is settled here. */
  const settled = new Set<string>();
  let discovered = false;
  /** the no-price warning currently on the record (null = none) — this latch
   *  owns the dedupe, so its transition notes are `repeatable` (adapter.ts note) */
  let noPriceWarned: string | null = null;
  /** every oracle an admitted pool's provider reads — sorted + deduped so the
   *  gas tracker's destination fingerprint is stable (see gasSources). */
  let pushOracles: `0x${string}`[] = [];

  /** The swap source's key names the exact address set it was fetched with,
   *  so decode() can tell which pools a bundle's swap query actually covered
   *  (see the re-read check there). A new key only when admission changes —
   *  rare — and the last few are kept, since a long replay can decode with a
   *  snapshot taken before a later one. */
  const snapshotAddrs = new Map<string, ReadonlySet<string>>();
  let snapshotSig = '';
  let snapshotKey = '';
  let snapshotSeq = 0;
  const swapSnapshotKey = () => {
    const addrs = admittedPools.map((p) => p.pool.toLowerCase()).sort();
    const sig = addrs.join(',');
    if (sig !== snapshotSig) {
      snapshotSig = sig;
      snapshotKey = `${SWAP_KEY_PREFIX}${++snapshotSeq}`;
      snapshotAddrs.set(snapshotKey, new Set(addrs));
      for (const k of snapshotAddrs.keys()) { if (snapshotAddrs.size <= 32) break; snapshotAddrs.delete(k); }
    }
    return snapshotKey;
  };

  /** Full discovery pass — also called from decode() when the factory
   *  announces a pool mid-range. Everything is assigned at the end, so a
   *  failed pass (it throws) leaves the previous state in force. */
  const refresh = async (ctx: AdapterContext) => {
    // ── 1. enumerate: the factory is the authoritative pool list ─────────────
    const next = await ctx.client.readContract({ address: V1_FACTORY, abi: metricV1FactoryAbi, functionName: 'nextPoolIdx' });
    if (next > nextIdx) {
      const idxs: bigint[] = [];
      for (let i = nextIdx; i < next; i++) idxs.push(i);
      const res = await ctx.client.multicall({
        contracts: idxs.map((i) => ({ address: V1_FACTORY, abi: metricV1FactoryAbi, functionName: 'idxToPool' as const, args: [i] as const })),
        allowFailure: false,
      });
      const added = res.map((p) => String(p).toLowerCase()).filter((p) => p !== ZERO && !candidates.has(p));
      for (const p of added) candidates.add(p);
      nextIdx = next;
      if (added.length && discovered) ctx.note('venue.discovery', `Metric: factory lists ${added.length} new pool(s)`);
    }

    // ── 2. resolve: getImmutables once per pool ──────────────────────────────
    // Every candidate is a real pool (the factory deployed it), so an
    // unanswered read is the RPC, not the pool: throw rather than drop it —
    // a dropped pool's swaps would go untailed without a trace.
    const unresolved = [...candidates].filter((p) => !immutables.has(p)) as `0x${string}`[];
    if (unresolved.length) {
      const imRes = await ctx.client.multicall({
        contracts: unresolved.map((p) => ({ address: p, abi: metricV1PoolAbi, functionName: 'getImmutables' as const })),
        allowFailure: true,
      });
      for (let i = 0; i < unresolved.length; i++) {
        const r = imRes[i];
        if (r.status !== 'success') throw new Error(`Metric getImmutables failed for factory pool ${unresolved[i]}`);
        const im = r.result as unknown as Immutables;
        immutables.set(unresolved[i], { factory: String(im.factory).toLowerCase(), token0: im.token0, token1: im.token1, immutablePriceProvider: im.immutablePriceProvider });
      }
    }

    // ── 3. admit: registered base/stable pairs, bound to their CURRENT provider
    const structural: MetricPool[] = [];
    for (const p of candidates) {
      const im = immutables.get(p)!;
      if (im.factory !== V1_FACTORY) continue; // not ours (cannot happen for an idxToPool answer)
      const verdict = admitMetricPool(p as `0x${string}`, { token0: im.token0, token1: im.token1, priceProvider: im.immutablePriceProvider });
      if (verdict.ok) structural.push(verdict.value);
      else if (verdict.reason === 'unregistered-pair') {
        ctx.note('venue.market.unlisted', `Metric: pool ${shortHex(p)} (${verdict.detail}) is not a registered pair — skipped`);
      }
    }
    // A pool's provider can be swapped (timelocked), so read the live one; the
    // immutable slot is zero for a pool created without one. No fallback to
    // it: after a provider change it names the OBSOLETE provider, whose oracle
    // would join the (never-shrinking) gas destination set for good. A failed
    // read fails the pass — the previous state stays in force and it retries.
    const provRes = structural.length ? await ctx.client.multicall({
      contracts: structural.map((p) => ({ address: V1_DATA_PROVIDER, abi: dataProviderAbi, functionName: 'priceProvider' as const, args: [p.pool] as const })),
      allowFailure: true,
    }) : [];
    const admitted = structural.map((p, i) => {
      const r = provRes[i];
      if (r?.status !== 'success') throw new Error(`Metric priceProvider read failed for pool ${p.pool}`);
      return { ...p, priceProvider: String(r.result) as `0x${string}` };
    });

    // ── 4. liveness gate: funded + two-sided price ───────────────────────────
    const liveRes = admitted.length ? await ctx.client.multicall({
      contracts: admitted.flatMap((p) => {
        const baseAddr = TOKENS[p.baseToken]?.address as `0x${string}`;
        const stableAddr = Object.values(TOKENS).find((t) => t.symbol === p.stableSym)?.address as `0x${string}`;
        return [
          { address: baseAddr, abi: erc20Abi, functionName: 'balanceOf' as const, args: [p.pool] as const },
          { address: stableAddr, abi: erc20Abi, functionName: 'balanceOf' as const, args: [p.pool] as const },
          { address: p.pool, abi: metricV1PoolAbi, functionName: 'getSellAndBuyPrices' as const },
        ];
      }),
      allowFailure: true,
    }) : [];
    const live: MetricPool[] = [];
    const notLive: Record<NotLiveReason, number> = { unfunded: 0, 'no-price': 0, unreadable: 0 };
    for (let i = 0; i < admitted.length; i++) {
      const b0 = liveRes[i * 3], b1 = liveRes[i * 3 + 1], q = liveRes[i * 3 + 2];
      const bal0 = b0.status === 'success' ? (b0.result as bigint) : null;
      const bal1 = b1.status === 'success' ? (b1.result as bigint) : null;
      const px = q.status === 'success' ? (q.result as readonly [bigint, bigint]) : null;
      const verdict = metricPoolLiveness(bal0, bal1, px ? px[0] : null, px ? px[1] : null);
      if (verdict === 'live') live.push(admitted[i]); else notLive[verdict]++;
    }

    // ── 5. gas destinations: every oracle an ADMITTED pool's provider reads ──
    // Admitted, not live: the set must not shrink when a pool is drained — a
    // removed destination rebuilds the venue's whole gas history (gas.ts
    // classifyGasSourceChange), and admission only grows. A provider that is
    // not an oracle-reading kind simply contributes nothing.
    const uniqueProviders = [...new Set(admitted.map((p) => p.priceProvider.toLowerCase()))].filter((p) => p !== ZERO) as `0x${string}`[];
    const oracleRes = uniqueProviders.length ? await ctx.client.multicall({
      contracts: uniqueProviders.map((p) => ({ address: p, abi: providerAbi, functionName: 'offchainOracle' as const })),
      allowFailure: true,
    }) : [];
    const oracles = new Set<string>();
    for (const r of oracleRes) {
      if (r.status !== 'success') continue;
      const o = String(r.result).toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(o) && o !== ZERO) oracles.add(o);
    }

    admittedPools = admitted;
    pools = live;
    // The decode map is MONOTONIC and keyed on ADMISSION, not liveness, so a
    // pool leaving `live` can never strand fills already fetched for it.
    for (const p of admitted) byAddr.set(p.pool.toLowerCase(), p);
    // every candidate reached a verdict in this pass (any unanswered read threw above)
    for (const p of candidates) settled.add(p);
    // merged, never replaced: a provider read that fails on one pass must not
    // shrink the destination set (see step 5)
    pushOracles = [...new Set([...pushOracles, ...oracles])].sort() as `0x${string}`[];
    discovered = true;

    const why = [
      notLive.unfunded ? `${notLive.unfunded} unfunded` : '',
      notLive['no-price'] ? `${notLive['no-price']} funded but no oracle price` : '',
      notLive.unreadable ? `${notLive.unreadable} unreadable` : '',
    ].filter(Boolean);
    ctx.note('venue.discovery', `Metric: ${live.length} live base/stable pool(s)${why.length ? ` (+${why.join(', ')}; not quoted)` : ''}`);
    // Funded capital we cannot price is a DEGRADATION, not lifecycle — warn,
    // and announce the heal (an adapter can only append, never retract). Both
    // transitions are latched HERE and raised `repeatable`: the core's
    // window-wide dedupe would otherwise swallow the same outage returning
    // after a recovery while the first episode's note is still in the window.
    if (notLive['no-price']) {
      const msg = `Metric: ${notLive['no-price']} funded pool(s) have no oracle price — they cannot be quoted (their fills are still tailed)`;
      if (msg !== noPriceWarned) {
        noPriceWarned = msg;
        ctx.note('venue.quote.unavailable', msg, { repeatable: true });
      }
    } else if (noPriceWarned) {
      noPriceWarned = null;
      ctx.note('venue.quote.recovered', `Metric quoting again — oracle price back for funded pool(s)`, { repeatable: true });
    }
  };

  return {
    quoteMarkets: () => [...new Set([...byAddr.values()].map((p) => p.market))],
    discover: refresh,

    async quote(ctx: AdapterContext, sizesUsd: readonly number[], blockNumber: bigint, markets?: ReadonlySet<string>): Promise<QuoteRow[]> {
      const selectedPools = pools.filter((p) => !markets || markets.has(p.market));
      if (!selectedPools.length) return [];

      // quoteLiveExactInSingle for each pool × size × side (eth_call). The
      // quoter reads the pool's own oracle, so one multicall is the whole quote.
      type Leg = { pool: MetricPool; size: number; side: Side; reqIn: bigint; basePx: number };
      const legs: Leg[] = [];
      const calls: { address: `0x${string}`; abi: typeof metricV1QuoterAbi; functionName: 'quoteLiveExactInSingle'; args: readonly [`0x${string}`, `0x${string}`, boolean, bigint, bigint] }[] = [];
      for (const p of selectedPools) {
        // bps anchor = the pair-terms CEX mid (wrap basis + stable cross applied),
        // NOT the raw USDT price — venue quotes are in the pair's stable terms.
        const basePx = ctx.pricer.pairMid(p.market);
        if (basePx <= 0) continue;
        const sellZeroForOne = p.baseIsToken0; // token0 in ⇒ selling the base when base is token0
        for (const size of sizesUsd) {
          // BUY base: exact-in the stable, no price bound in that direction.
          const buyIn = toUnits(size, p.stableDec);
          const buyZeroForOne = !sellZeroForOne;
          legs.push({ pool: p, size, side: 'buy', reqIn: buyIn, basePx });
          calls.push({ address: V1_QUOTER, abi: metricV1QuoterAbi, functionName: 'quoteLiveExactInSingle', args: [p.pool, ZERO, buyZeroForOne, buyIn, buyZeroForOne ? PRICE_LIMIT_DOWN : PRICE_LIMIT_UP] });
          // SELL base: exact-in base worth `size`.
          const sellIn = toUnits(ctx.pricer.tokenForUsd(p.baseToken, size), p.baseDec);
          legs.push({ pool: p, size, side: 'sell', reqIn: sellIn, basePx });
          calls.push({ address: V1_QUOTER, abi: metricV1QuoterAbi, functionName: 'quoteLiveExactInSingle', args: [p.pool, ZERO, sellZeroForOne, sellIn, sellZeroForOne ? PRICE_LIMIT_DOWN : PRICE_LIMIT_UP] });
        }
      }
      if (!calls.length) return [];
      const qRes = await ctx.client.multicall({ contracts: calls, allowFailure: true, blockNumber });
      ctx.quoteSignal?.throwIfAborted();
      // Hand the health reporter the DECODED name: it reads Error(string)
      // reasons, and every v1 revert is a custom error it would call "call failed".
      const names = qRes.map((r) => (r.status === 'failure' ? metricV1RevertName(r.error) : null));
      const named: MulticallOutcome[] = qRes.map((r, i) => (r.status === 'failure' && names[i] ? { status: 'failure', error: { reason: names[i] } } : r));
      if (reportOutage(ctx, named)) return [];

      // A whole SIDE refusing (every size of one direction on one market) is a
      // venue state, not thin liquidity: say why, once, and announce the heal.
      // The other side is still published below as one-sided rows.
      const bySide = new Map<string, number[]>();
      legs.forEach((l, i) => { const k = `${l.pool.market}|${l.side}`; (bySide.get(k) ?? bySide.set(k, []).get(k)!).push(i); });
      for (const [k, idx] of bySide) {
        const [market, side] = k.split('|');
        let latch = sideLatches.get(k);
        if (!latch) sideLatches.set(k, (latch = createQuoteOutageLatch(`${METRIC_VENUE.name} ${market} ${side}s`)));
        if (idx.some((i) => qRes[i].status === 'success')) { latch(ctx, null); continue; }
        const reason = names[idx[0]] ?? 'call failed';
        latch(ctx, { reason, msg: `${METRIC_VENUE.name} ${market} ${side}s unavailable — every ${side} leg failed with "${reason}"${reason === 'OracleStopLossTriggered' ? ' (the pool\'s stop-loss extension is blocking that direction)' : ''}; quoting the other side only` });
      }

      const rowByKey = new Map<string, QuoteRow>();
      const ts = Date.now();
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const r = qRes[i];
        if (r.status !== 'success') continue;
        const [usedIn, out] = r.result as readonly [bigint, bigint];
        const baseRaw = l.side === 'buy' ? out : usedIn;
        const stableRaw = l.side === 'buy' ? usedIn : out;
        const baseH = fromUnits(baseRaw, l.pool.baseDec);
        const stH = fromUnits(stableRaw, l.pool.stableDec);
        if (baseH <= 0 || stH <= 0) continue;
        const px = stH / baseH; // stable per base
        const bps = (px / l.basePx - 1) * 1e4;
        // filled full when the exact-input leg consumed (almost) the whole
        // requested input — the quoter stops at the inventory's edge.
        const legFull = usedIn >= (l.reqIn * 999n) / 1000n;

        const key = `${l.pool.market}|${l.size}`;
        let row = rowByKey.get(key);
        if (!row) {
          row = { venueId: METRIC_VENUE.id, market: l.pool.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
          rowByKey.set(key, row);
        }
        if (l.side === 'buy') { row.askBps = bps; row.askPx = px; }
        else { row.bidBps = bps; row.bidPx = px; }
        row.filledFull &&= legFull;
      }
      // one real side + one refused side is a genuine half-market: keep the real
      // side as one-sided (the Capricorn/Lunarbase/Uniswap convention) rather
      // than dropping the venue off the grid while it still trades one way.
      const out: QuoteRow[] = [];
      for (const row of rowByKey.values()) {
        if (row.askPx > 0 && row.bidPx > 0) row.spreadBps = row.askBps - row.bidBps;
        else row.oneSided = true;
        if (row.askPx > 0 || row.bidPx > 0) out.push(row);
      }
      return out;
    },

    logSources() {
      if (!discovered) throw new Error('Metric v1 discovery unavailable'); // hold the cursor until discovered
      // The factory source is ALWAYS tailed, even with no admitted pool: it is
      // how a new deployment reaches us between discovery cycles. 'state'
      // because a missed PoolCreated would leave that pool's Swaps unfetched.
      const sources = [{ key: 'poolCreated', address: V1_FACTORY as `0x${string}`, events: [ev(metricV1FactoryAbi, 'PoolCreated')], kind: 'state' as const, fromBlock: V1_FACTORY_BLOCK }];
      if (!admittedPools.length) return sources;
      return [{ key: swapSnapshotKey(), address: admittedPools.map((p) => p.pool), events: [ev(metricV1PoolAbi, 'Swap')], kind: 'fills' as const, fromBlock: V1_FACTORY_BLOCK }, ...sources];
    },

    // taker entries owned by Metric: the pools themselves (DIRECT) and its own
    // SimpleRouter (periphery). Aggregators/searchers stay with the global registry.
    entryPoints: () => [...admittedPools.map((p) => ({ address: p.pool })), { address: V1_SIMPLE_ROUTER, router: 'Metric' }],

    // QUOTE_UPDATE_BURN: v1 providers read a push oracle (0x30a88bf8… on
    // 2026-10-12) fed by a rotating fleet of publisher EOAs — flat 260k limit,
    // one tx refreshes every feed it serves (4 on 2026-10-12, Metric reading 3).
    // Same 'blocks' mode as v0's oracle: the tracker takes one mode per venue,
    // and both generations' destinations share a single block walk. The
    // publishers pay the gas; we count it as Metric's freshness burn, whole.
    gasSources() {
      // Throw — never return a partial set — while unresolved: a set missing
      // this destination reads as a removal and rebuilds the lifetime series.
      if (!pushOracles.length) throw new Error('Metric v1 push oracle not resolved yet'); // hold the gas cursor
      return [{ mode: 'blocks' as const, address: [...pushOracles] }];
    },

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number): Promise<Fill[]> {
      const announced = (logs.poolCreated ?? [])
        .map((l: any) => String(l?.args?.poolAddress ?? '').toLowerCase())
        // against SETTLED, not candidates: a refresh that failed after
        // enumerating the pool leaves it a candidate but unadmitted, and
        // skipping its announcement then would let this range pass without
        // its swaps — the retry must re-run discovery until it is decided.
        .filter((p: string) => /^0x[0-9a-f]{40}$/.test(p) && !settled.has(p));
      if (announced.length) {
        ctx.note('venue.discovery', `Metric: factory deployed ${announced.length} new pool(s) — re-running discovery`);
        await refresh(ctx);
      }
      // The swap query for this range was built BEFORE it was fetched, so it
      // cannot contain a pool admitted since: one this range announced, or one
      // the 10-minute rediscovery admitted between that snapshot and now. Either
      // may have traded within the range, and those Swaps were never fetched.
      // Throw (the cursor holds); the retry re-snapshots logSources(), which now
      // carries every admitted pool, so the same range passes on the second try.
      const swapKeys = Object.keys(logs).filter((k) => k === 'swap' || k.startsWith(SWAP_KEY_PREFIX));
      // A bare 'swap' key is a hand-built bundle (tests, scripts) whose address
      // set is unknown; only snapshot-keyed bundles can be checked.
      if (!swapKeys.includes('swap')) {
        const fetched = new Set<string>(swapKeys.flatMap((k) => [...(snapshotAddrs.get(k) ?? [])]));
        const unread = admittedPools.map((p) => p.pool.toLowerCase()).filter((p) => !fetched.has(p));
        if (unread.length) {
          throw new Error(`pool(s) ${unread.map((p) => shortHex(p)).join(', ')} admitted after this range's swap query was built — re-reading the range with them included`);
        }
      }
      const out: Fill[] = [];
      for (const l of swapKeys.flatMap((k) => logs[k] ?? [])) {
        const p = byAddr.get(String(l.address).toLowerCase());
        const a = l.args;
        if (!p || !a || a.amountDeltas === undefined) continue;
        const [d0, d1] = unpackAmountDeltas(BigInt(a.amountDeltas));
        const f = metricFill(p, d0, d1, l, a.recipient, tsOf);
        if (f) out.push(f);
      }
      return out;
    },
  };
}
