import { parseAbi } from 'viem';
import type { Fill, QuoteRow, Side, VenueMeta } from '@shared';
import { TOKENS, assetForToken, baseTokenOf, pairFor } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';
import { createQuoteOutageNote, createQuoteOutageReporter } from './quote-health.js';

/**
 * Capricorn PAMM adapter — Capricorn's Proactive AMM on Monad, fully on-chain.
 *
 * A PAMM pool prices off an oracle rather than a curve: the pricing engine is
 * closed-source and the docs say so explicitly, directing integrators to
 * "EVM simulation and/or on-chain view helpers" for quotes. So this adapter
 * never models the math — it asks the pool, exactly like POE:
 *
 *   Factory.PoolCreated(token0, token1, feeBps, pool) → the pool set
 *   Pool.getTokens() / feeBps() / paused()            → layout + fee, read on-chain
 *   Pool.quoteExactIn(tokenIn, amountIn)              → executable, fee-inclusive out
 *   Pool.Swap(…, amount0, amount1, reserve0, reserve1) → the landed fill
 *
 * Prices reach the pool through PricingEngine → OracleRegistry, which reads a
 * PUSH/Pyth feed keyed by the pool's `oracleId` (staleness bounded on-chain by
 * maxPushPriceAge / pythValidTimePeriod). Nothing Capricorn-funded writes to
 * those contracts — see the gasSources note at the bottom for why this adapter
 * deliberately has none.
 *
 * Addresses + ABIs: KyberNetwork/kyberswap-dex-lib `pkg/liquidity-source/
 * capricorn-pamm` (Capricorn's own docs publish no mainnet addresses). Every
 * one re-verified on Monad mainnet, and the pool set re-derived from the
 * factory's full log history rather than trusted from the fixtures.
 *
 * No backfill source is keyless, so volume is seeded by the core's background
 * on-chain replay from `backfillFromUtc`.
 */

// sinceUtc = the factory's first (and so far only) PoolCreated block 65199911
// — verified by scanning the factory's ENTIRE history, deploy → head.
const CAPRICORN_VENUE: VenueMeta = {
  // `id` stays 'capricorn': it is the DB key for this venue's volume/fills/gas
  // history and the frontend lookup key, so only the display name moves.
  id: 'capricorn',
  name: 'Capricorn pAMM',
  // rose — the one hue region the venue palette leaves open. Distinct from
  // POE's orange (redder, much darker in light) and Hanji's magenta (bluer),
  // and separable from both by lightness under CVD simulation, which is what
  // survives when hue collapses. Proposed for reviewer validation per
  // docs/adapters.md.
  color: { light: '#BE123C', dark: '#FB7185' },
  kind: 'amm',
  role: 'venue',
  sinceUtc: '2026-04-01',
};

/** CapricornPammFactory on Monad. */
const FACTORY = '0x010cf4f9e3a79dd2fe11760d76a75df6c0656631' as const;

/**
 * The pools that exist today. NOT a trusted list: every field below is
 * re-read from the chain at discovery (`getTokens`/`feeBps`/`paused`), and the
 * factory's `PoolCreated` is tailed as a `'state'` source so a pool deployed
 * later is admitted mid-run without a redeploy (same shape as metric.ts).
 *
 * They are seeded rather than discovered-from-history because the factory
 * exposes no enumeration (`allPools`/`poolCount` both revert) and replaying
 * its logs from the 2026-04-01 deploy costs ~32k chunked getLogs calls — far
 * too slow for a boot path that re-runs every 10 minutes.
 *
 * A seed that stops resolving is a real regression and fails LOUD; a pool that
 * arrives later and misbehaves is merely skipped.
 */
const SEED_POOLS: `0x${string}`[] = [
  '0x63093325c05cd32b18034d3ea29199fb7098e4df', // USDC/WMON
  '0x91c483fbe8feef4dad525781e6d65d2e668b3a47', // AUSD/WMON
];

/** Probe notional for the discovery-time quotability gate (stable units). */
const QUOTE_PROBE_USD = 100;

/**
 * Per-side sanity band vs the pair reference — matching the Uniswap/Lunarbase
 * convention. `quoteExactIn` SATURATES rather than reverting: asked for more
 * than the pool holds it returns the remaining reserve, so a $100k bid on this
 * $2.1k pool quotes ~68000bps out. That is an exhausted reserve, not a
 * comparable execution, and publishing it as a filled quote would be a lie
 * about depth. Verified on-chain: $100 → 4,517 WMON (px 0.02213, a real quote),
 * $100,000 → 65,322 WMON ≡ the pool's ENTIRE reserve.
 */
const PER_SIDE_BAND_BPS = 2_000;

const pammPoolAbi = parseAbi([
  'function getTokens() view returns (address token0, address token1)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1)',
  'function factory() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function pricingEngine() view returns (address)',
  'function oracleId() view returns (bytes32)',
  'function paused() view returns (bool)',
  'function quoteExactIn(address tokenIn, uint256 amountIn) view returns (uint256 amountOut)',
  // Recovered from a real fill and keccak-matched against the live topic0
  // (0x829000a5…4557c4): Kyber's ABI carries only the read surface it needs,
  // so the event is NOT copied from it. Deltas are POOL-SIGNED (negative = the
  // pool paid out), which the reserve fields let us verify — see decode().
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint256 reserve0, uint256 reserve1)',
]);
const pammFactoryAbi = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, uint256 indexed feeBps, address pool)',
]);

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

interface CapPool {
  pool: `0x${string}`;
  market: string;        // 'MON/USDC'
  baseIsToken0: boolean;
  baseToken: string;     // TOKENS key of the base wrapper ('WMON'|'WBTC'|'WETH')
  baseDec: number;
  baseAddr: `0x${string}`;
  stableSym: string;
  stableDec: number;
  stableAddr: `0x${string}`;
  feeBps: number;        // read on-chain, never a docs number
}

/** Why a candidate pool was not admitted (null = admitted). Pure, so the
 *  admission rules are unit-tested without a chain. */
export type CapRejectReason = 'unresolved' | 'not-base-stable' | 'unregistered-pair' | 'unknown-base-token';

/**
 * STRUCTURAL admission: is this pool a market we can price and benchmark?
 * Capricorn pools are created by a factory, so the set is open-ended — only
 * registered base/stable pairs (@shared PAIRS) carry reference rows and
 * markouts, and everything else is dropped rather than surfaced as an
 * unbenchmarkable market.
 */
export function admitCapricornPool(
  pool: `0x${string}`,
  tokens: readonly [string, string] | null,
  feeBps: number | null,
): { ok: true; value: CapPool } | { ok: false; reason: CapRejectReason; detail?: string } {
  if (!tokens || feeBps === null) return { ok: false, reason: 'unresolved' };
  const token0 = String(tokens[0]).toLowerCase();
  const token1 = String(tokens[1]).toLowerCase();
  // exactly one side a tracked base asset, the other a registered stable
  const a0 = assetForToken(token0), a1 = assetForToken(token1);
  if (!!a0 === !!a1) return { ok: false, reason: 'not-base-stable' };
  const baseIsToken0 = !!a0;
  const base = (baseIsToken0 ? a0 : a1)!;
  const stableAddr = baseIsToken0 ? token1 : token0;
  const stable = Object.values(TOKENS).find((t) => t.stable && t.address.toLowerCase() === stableAddr);
  if (!stable) return { ok: false, reason: 'not-base-stable' };
  const pair = pairFor(base.key, stable.symbol);
  if (!pair) return { ok: false, reason: 'unregistered-pair', detail: `${base.symbol}/${stable.symbol}` };
  const baseTok = baseTokenOf(base.key);
  if (!baseTok) return { ok: false, reason: 'unknown-base-token', detail: base.key };
  return {
    ok: true,
    value: {
      pool,
      market: pair.symbol,
      baseIsToken0,
      baseToken: base.token,
      baseDec: baseTok.decimals,
      baseAddr: (baseIsToken0 ? token0 : token1) as `0x${string}`,
      stableSym: stable.symbol,
      stableDec: stable.decimals,
      stableAddr: stableAddr as `0x${string}`,
      feeBps,
    },
  };
}

/**
 * One `Swap` log → a normalized Fill, or null when the log is not a priceable
 * trade for this pool. Pure (no ctx, no chain) so the unit math is locked by
 * fixture tests — decimals and sign conventions are where adapter bugs live.
 */
export function decodeCapricornSwap(l: any, pool: CapPool | undefined, ts: number): Fill | null {
  if (!pool) return null;
  const a = l?.args;
  if (!a || a.amount0 === undefined || a.amount1 === undefined) return null;
  const amount0 = BigInt(a.amount0), amount1 = BigInt(a.amount1);
  // Deltas are POOL-SIGNED: the leg the pool RECEIVED is positive, the leg it
  // paid out is negative. So the taker sold the base exactly when the pool's
  // base leg went up.
  const baseDelta = pool.baseIsToken0 ? amount0 : amount1;
  const stableDelta = pool.baseIsToken0 ? amount1 : amount0;
  if (baseDelta === 0n || stableDelta === 0n) return null;
  // a real swap moves the legs in OPPOSITE directions; same-sign is not a trade
  // we can price (donation/skim shapes), so skip rather than invent a fill.
  if ((baseDelta > 0n) === (stableDelta > 0n)) return null;
  const baseAmount = fromUnits(baseDelta < 0n ? -baseDelta : baseDelta, pool.baseDec);
  const usd = fromUnits(stableDelta < 0n ? -stableDelta : stableDelta, pool.stableDec);
  if (baseAmount <= 0 || usd <= 0) return null;
  return {
    id: `capricorn-${String(l.transactionHash).toLowerCase()}-${l.logIndex}`,
    venueId: CAPRICORN_VENUE.id,
    // attribution is the core's job (tx.to): claiming DIRECT here would label
    // aggregator flow as direct — emit honest UNKNOWN.
    market: pool.market,
    side: (baseDelta > 0n ? 'sell' : 'buy') as Side, // pool gained base ⇒ taker sold
    category: 'UNKNOWN',
    usd,
    baseAmount,
    execPx: usd / baseAmount, // realized stable-per-base (real markouts, no pxApprox)
    txHash: l.transactionHash,
    to: shortHex(String(a.recipient ?? '0x')),
    pool: `cap ${pool.pool.slice(0, 8)}`,
    blockNumber: Number(l.blockNumber),
    ts,
    markoutsBps: [null, null, null, null, null],
  };
}

/**
 * Capricorn PAMM adapter — factory-tailed discovery + executable
 * `quoteExactIn` quotes + `Swap` fill decode. No backfill().
 */
export function createCapricornAdapter(): VenueAdapter {
  // every leg FAILING is a venue-wide cause (paused, oracle down, ABI drift),
  // not a per-pair gap — name it instead of vanishing (venues/quote-health.ts).
  const reportOutage = createQuoteOutageReporter(CAPRICORN_VENUE.name);
  // unpaused pools that will not price: raised from refresh(), which re-runs
  // every 10 minutes, so the clear condition is re-evaluated on the same pass.
  const noQuoteNote = createQuoteOutageNote();
  /** every pool address the factory has ever announced (seeds + tailed). */
  const candidates = new Set<string>(SEED_POOLS.map((p) => p.toLowerCase()));
  /** ADMITTED pools — structurally valid, so their fills are decodable. */
  let admittedPools: CapPool[] = [];
  /** QUOTABLE subset — admitted AND currently answering a priced quote. */
  let quotable: CapPool[] = [];
  /** MONOTONIC decode map, keyed on ADMISSION not quotability: an unquotable
   *  pool still trades, and dropping it here would silently stop decoding its
   *  fills (the Metric #61 failure — 141 swaps lost while its oracle was down). */
  const byAddr = new Map<string, CapPool>();
  let discovered = false;

  async function refresh(ctx: AdapterContext): Promise<void> {
    const list = [...candidates] as `0x${string}`[];

    // ── 1. layout + fee + pause, all read on-chain ────────────────────────
    const res = await ctx.client.multicall({
      contracts: list.flatMap((pool) => [
        { address: pool, abi: pammPoolAbi, functionName: 'getTokens' as const },
        { address: pool, abi: pammPoolAbi, functionName: 'feeBps' as const },
      ]),
      allowFailure: true,
    });

    const admitted: CapPool[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = res[i * 2], f = res[i * 2 + 1];
      const tokens = t.status === 'success' ? (t.result as readonly [string, string]) : null;
      const fee = f.status === 'success' ? Number(f.result as bigint) : null;
      const verdict = admitCapricornPool(list[i], tokens, fee);
      if (verdict.ok) { admitted.push(verdict.value); continue; }
      // A SEED that cannot be resolved is a regression we must not paper over
      // (bad RPC, or the pool changed shape) — fail closed so discovery retries
      // rather than silently shrinking the venue. A factory-announced pool that
      // misbehaves is simply not ours to vouch for: skip it, keep running.
      const isSeed = SEED_POOLS.some((s) => s.toLowerCase() === list[i].toLowerCase());
      if (isSeed && verdict.reason === 'unresolved') throw new Error(`${CAPRICORN_VENUE.name} read failed for seed pool ${list[i]}`);
      if (verdict.reason === 'unregistered-pair') {
        ctx.note('venue.market.unlisted', `Capricorn pAMM: pool ${shortHex(list[i])} (${verdict.detail}) is not a registered pair — skipped`);
      }
    }

    // ── 2. quotability gate: not paused AND the oracle actually prices it ──
    // A PAMM with no oracle price reverts rather than quoting wide, so the
    // pool's own quoteExactIn is the authoritative test — cheaper and more
    // honest than re-deriving the engine's staleness rules off-chain.
    const liveRes = await ctx.client.multicall({
      contracts: admitted.flatMap((p) => [
        { address: p.pool, abi: pammPoolAbi, functionName: 'paused' as const },
        {
          address: p.pool,
          abi: pammPoolAbi,
          functionName: 'quoteExactIn' as const,
          args: [p.stableAddr, toUnits(QUOTE_PROBE_USD, p.stableDec)] as const,
        },
      ]),
      allowFailure: true,
    });
    const live: CapPool[] = [];
    let paused = 0, noQuote = 0;
    for (let i = 0; i < admitted.length; i++) {
      const p = liveRes[i * 2], q = liveRes[i * 2 + 1];
      const isPaused = p.status === 'success' ? Boolean(p.result) : false;
      const prices = q.status === 'success' && (q.result as bigint) > 0n;
      if (isPaused) { paused++; continue; }
      if (!prices) { noQuote++; continue; }
      live.push(admitted[i]);
    }

    admittedPools = admitted;
    quotable = live;
    for (const p of admitted) byAddr.set(p.pool.toLowerCase(), p);
    discovered = true;

    const why = [paused ? `${paused} paused` : '', noQuote ? `${noQuote} not quoting` : ''].filter(Boolean);
    ctx.note('venue.discovery', `Capricorn pAMM: ${live.length}/${admitted.length} admitted pool(s) quotable${why.length ? ` (${why.join(', ')})` : ''}`);
    // Capital that trades but cannot be priced is a DEGRADATION, not lifecycle:
    // it gives the core's went-dark backstop the reason it cannot know.
    // Report WHAT WAS MEASURED, not an inferred root cause: `paused` is ruled
    // out above, but an unanswered quoteExactIn is equally a stale/absent
    // oracle feed, an engine-side revert or an ABI drift, and this gate cannot
    // tell them apart. Naming one of them would send a reader to the wrong
    // contract — the exact failure the Metric "unfunded" note made (#58).
    if (noQuote) {
      noQuoteNote.raise(ctx, `Capricorn pAMM: ${noQuote} unpaused pool(s) are not returning a quote — quoteExactIn is not answering, so they cannot be quoted (they can still trade, and their fills are still tailed)`);
    } else {
      // recomputed from scratch every pass, so this IS the clear condition.
      noQuoteNote.recovered(ctx, 'Capricorn pAMM: every unpaused pool is quoting again');
    }
  }

  return {
    venues: () => [CAPRICORN_VENUE],
    // seed daily volume by replaying Pool.Swap from the factory's first
    // PoolCreated (block 65199911 · 2026-04-01). Background — see live.ts.
    backfillFromUtc: '2026-04-01',

    discover: refresh,

    async quote(ctx: AdapterContext, sizesUsd: readonly number[], blockNumber: bigint, markets?: ReadonlySet<string>): Promise<QuoteRow[]> {
      const selectedPools = quotable.filter((p) => !markets || markets.has(p.market));
      if (!selectedPools.length) return [];
      type Leg = { pool: CapPool; size: number; side: Side; inRaw: bigint; mid: number };
      const legs: Leg[] = [];
      const calls: { address: `0x${string}`; abi: typeof pammPoolAbi; functionName: 'quoteExactIn'; args: readonly [`0x${string}`, bigint] }[] = [];

      for (const p of selectedPools) {
        // bps anchor = the pair-terms CEX mid (wrap basis + stable cross), NOT a
        // raw USDT price — venue quotes are in the pair's stable terms.
        const mid = ctx.pricer.pairMid(p.market);
        if (mid <= 0) continue;
        for (const size of sizesUsd) {
          // BUY base: spend the stable.
          legs.push({ pool: p, size, side: 'buy', inRaw: toUnits(size, p.stableDec), mid });
          calls.push({ address: p.pool, abi: pammPoolAbi, functionName: 'quoteExactIn', args: [p.stableAddr, toUnits(size, p.stableDec)] });
          // SELL base: spend base worth `size`.
          const sellIn = toUnits(ctx.pricer.tokenForUsd(p.baseToken, size), p.baseDec);
          legs.push({ pool: p, size, side: 'sell', inRaw: sellIn, mid });
          calls.push({ address: p.pool, abi: pammPoolAbi, functionName: 'quoteExactIn', args: [p.baseAddr, sellIn] });
        }
      }
      if (!calls.length) return [];

      const res = await ctx.client.multicall({ contracts: calls, allowFailure: true, blockNumber });
      if (reportOutage(ctx, res)) return [];

      const rowByKey = new Map<string, QuoteRow>();
      const ts = Date.now();
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const r = res[i];
        if (r.status !== 'success') continue;
        const out = r.result as bigint;
        if (out <= 0n || l.inRaw <= 0n) continue;
        const inH = fromUnits(l.inRaw, l.side === 'buy' ? l.pool.stableDec : l.pool.baseDec);
        const outH = fromUnits(out, l.side === 'buy' ? l.pool.baseDec : l.pool.stableDec);
        if (inH <= 0 || outH <= 0) continue;
        const px = l.side === 'buy' ? inH / outH : outH / inH; // stable per base (all-in)
        const bps = (px / l.mid - 1) * 1e4;
        // a saturated leg (the pool handed back its whole reserve) is not a
        // comparable execution — drop it rather than publish fake depth.
        if (!Number.isFinite(bps) || Math.abs(bps) > PER_SIDE_BAND_BPS) continue;

        const key = `${l.pool.market}|${l.size}`;
        let row = rowByKey.get(key);
        if (!row) {
          // a leg that survived the band consumed only part of the reserve, so
          // the returned amount really is the full requested notional.
          row = { venueId: CAPRICORN_VENUE.id, market: l.pool.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
          rowByKey.set(key, row);
        }
        // BEST price across every pool serving this market, per side — the
        // factory keys pools on (token0, token1, feeBps), so more than one fee
        // tier of the SAME pair is the designed shape, and a taker routes to
        // whichever is best. Last-write-wins would otherwise make the row
        // depend on multicall ordering. Cheapest ask / richest bid wins.
        if (l.side === 'buy') {
          if (row.askPx === 0 || px < row.askPx) { row.askBps = bps; row.askPx = px; }
        } else if (px > row.bidPx) { row.bidBps = bps; row.bidPx = px; }
        // one fee for a row assembled from two pools can only be the worse of
        // them — same convention as POE's multi-leg rows.
        row.feeBps = Math.max(row.feeBps, l.pool.feeBps);
      }
      const out: QuoteRow[] = [];
      for (const row of rowByKey.values()) {
        // one real leg + one exhausted leg is a genuine half-market: retain the
        // real side as one-sided, matching the Clober/Uniswap/Lunarbase convention.
        if (row.askPx > 0 && row.bidPx > 0) row.spreadBps = row.askBps - row.bidBps;
        else row.oneSided = true;
        if (row.askPx > 0 || row.bidPx > 0) out.push(row);
      }
      return out;
    },

    logSources() {
      if (!discovered) throw new Error('Capricorn discovery unavailable'); // hold the cursor until discovered
      // The factory source is ALWAYS tailed, even with no admitted pools: it is
      // how a pool deployed between discovery cycles reaches us. 'state' because
      // a missed PoolCreated makes that pool's later Swaps undecodable, so its
      // failure must hold the cursor like any other decode prerequisite.
      const sources = [{ key: 'poolCreated', address: FACTORY as `0x${string}`, events: [ev(pammFactoryAbi, 'PoolCreated')], kind: 'state' as const }];
      // ADMITTED, not quotable: an unpriceable pool still trades, and its fills
      // must keep being tailed.
      if (!admittedPools.length) return sources;
      return [{ key: 'swap', address: admittedPools.map((p) => p.pool), events: [ev(pammPoolAbi, 'Swap')], kind: 'fills' as const }, ...sources];
    },

    // taker entries owned by Capricorn: the pools themselves. Sampled flow is
    // 100% routed (KyberSwap + two unidentified intermediaries) and Capricorn's
    // own PAMM router has no PUBLISHED mainnet address — its docs still list it
    // as "TBD (Monad Testnet)" — so nothing is claimed here that could mislabel
    // third-party router flow as the venue's own periphery.
    entryPoints: () => admittedPools.map((p) => ({ address: p.pool })),

    // QUOTE_UPDATE_BURN: deliberately ABSENT. Capricorn does not self-fund its
    // quote freshness — the PricingEngine reads through to an OracleRegistry
    // backed by a Pyth feed (pythValidTimePeriod/maxPushPriceAge are the only
    // staleness knobs, and the pool holds just an oracleId). Verified on-chain:
    // ZERO transactions land on either the PricingEngine or the OracleRegistry,
    // so there is no Capricorn-funded update destination to key a tracker on.
    // Per docs/adapters.md, absence is the honest value here — not zero.

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      // A pool announced mid-range must be admitted BEFORE this range's Swaps
      // are decoded, or its first fills would be dropped as unknown addresses.
      const created = (logs.poolCreated ?? []).filter((l: any) => {
        const p = String(l?.args?.pool ?? '').toLowerCase();
        return /^0x[0-9a-f]{40}$/.test(p) && !candidates.has(p);
      });
      if (created.length) {
        for (const l of created) candidates.add(String(l.args.pool).toLowerCase());
        ctx.note('venue.discovery', `Capricorn pAMM: factory deployed ${created.length} new pool(s) — re-running discovery`);
        await refresh(ctx);
      }

      const out: Fill[] = [];
      for (const l of logs.swap ?? []) {
        // one malformed/irrelevant log must not wedge the indexer — decode
        // returns null and we skip it locally rather than throwing the range.
        const fill = decodeCapricornSwap(l, byAddr.get(String(l.address).toLowerCase()), tsOf(l.blockNumber));
        if (fill) out.push(fill);
      }
      return out;
    },
  };
}
