import { parseAbi } from 'viem';
import type { QuoteRow, Fill, Side, VenueMeta } from '@shared';
import { TOKENS, assetForToken, baseTokenOf, pairFor } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';

/**
 * Metric OMM adapter — an oracle-anchored bin AMM (propAMM), fully on-chain and
 * generic over base/quote (MON/USDC, BTC/USDC, ETH/USDC — every pool is a tracked
 * base asset vs a USD stable).
 *
 *   PriceProvider.getBidAndAskPrice()   → the fair bid/ask (Q64.64 "X64")
 *   Router.quoteSwap(pool, …, bid, ask) → realized deltas (eth_call, no state change)
 *   Pool.Swap(…, amount0Delta, amount1Delta, …) → the landed fill
 *
 * No backfill source is keyless, so its volume is seeded by the core's background
 * on-chain replay from `backfillFromUtc`. ABIs: @nradko/metric-omm-sdk-v0.
 * Verified live on Monad.
 */

// sinceUtc = the pools' on-chain deploy day (block 65042020) — same anchor as backfillFromUtc.
const METRIC_VENUE: VenueMeta = { id: 'metric', name: 'Metric', color: { light: '#0F9D8C', dark: '#0D9488' }, kind: 'amm', role: 'venue', sinceUtc: '2026-03-31' };

/** Shared MetricOmmSwapRouter on Monad (same for every pool). */
const ROUTER = '0xaF9ADa6b6eC7993CE146f6c0bF98f7211CDfD3e5' as const;

/** Metric OMM pools to track — base/stable only (verified on-chain: getImmutables
 *  resolves each pool's PriceProvider + token layout, so a stale entry fails loud). */
const KNOWN_POOLS: `0x${string}`[] = [
  '0xFA32f9ec28787d1F9C5BA5c39e54e59984FEF3f0', // WMON/USDC
  '0x2D82AC42334b394A9a8d8f097d61DC1c6B065Fd8', // WBTC/USDC
  '0x354D92279cA0190fF275095fE6A2a6989BAa66Fb', // WETH/USDC
];

/** Price-limit sentinels (Q64.64) so a quote walks the full binned liquidity for
 *  the size: no upper bound buying the base, no lower bound selling it. */
const PRICE_LIMIT_UP = (1n << 128n) - 1n;
const PRICE_LIMIT_DOWN = 1n;

const metricPoolAbi = parseAbi([
  'function getImmutables() view returns (address factory, address priceProvider, address token0, address token1, uint104 a, uint104 b, uint104 c, bool reportSwapToPriceProvider, uint256 maxDriftE8, uint256 maxDriftDecayPerSecondE8, int16 lowestBin, int16 highestBin, uint256 token0ScaleMultiplier, uint256 token1ScaleMultiplier)',
  'event Swap(address sender, address recipient, bool exactInput, int128 amount0Delta, int128 amount1Delta, int16 newTick, uint104 newPositionInBin)',
]);
const priceProviderAbi = parseAbi(['function getBidAndAskPrice() view returns (uint128, uint128)']);
// gas-burn derivation (see gasSources): each provider names the push oracle it
// reads and its own feed id; the oracle exposes how many feeds it serves.
const providerOracleAbi = parseAbi([
  'function offchainOracle() view returns (address)',
  'function offchainFeedId() view returns (bytes32)',
]);
const pushOracleAbi = parseAbi(['function getOracleCount() view returns (uint256)']);
const metricRouterAbi = parseAbi([
  'function quoteSwap(address pool, bool zeroForOne, int128 amountSpecified, uint128 priceLimitX64, uint128 bidPriceX64, uint128 askPriceX64) returns (int128 amount0Delta, int128 amount1Delta)',
]);

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

interface MetricPool {
  pool: `0x${string}`;
  priceProvider: `0x${string}`;
  market: string;        // 'BTC/USDC'
  baseIsToken0: boolean;
  baseToken: string;     // TOKENS key of the base wrapper ('WMON'|'WBTC'|'WETH')
  baseDec: number;
  stableSym: string;
  stableDec: number;
}

/**
 * Metric OMM adapter — on-chain discovery (getImmutables) + oracle-quote
 * (PriceProvider + Router.quoteSwap) + Pool.Swap fill decode. No backfill().
 */
export function createMetricAdapter(): VenueAdapter {
  let pools: MetricPool[] = [];
  let byAddr = new Map<string, MetricPool>();
  let discovered = false;
  let pushOracle: `0x${string}` | null = null; // resolved at discovery (gasSources)

  return {
    venues: () => [METRIC_VENUE],
    // seed daily volume by replaying Pool.Swap on-chain from the earliest pool's
    // deployment era (WMON/USDC block 65042020 · 2026-03-31). Background — see live.ts.
    backfillFromUtc: '2026-03-31',

    async discover(ctx: AdapterContext) {
      const res = await ctx.client.multicall({
        contracts: KNOWN_POOLS.map((p) => ({ address: p, abi: metricPoolAbi, functionName: 'getImmutables' as const })),
        allowFailure: true,
      });
      const found: MetricPool[] = [];
      for (let i = 0; i < KNOWN_POOLS.length; i++) {
        const r = res[i];
        // fail closed: a configured pool that won't resolve is a hard error (held cursor), not a silent skip.
        if (r.status !== 'success') throw new Error(`Metric getImmutables failed for ${KNOWN_POOLS[i]}`);
        const im = r.result as readonly unknown[];
        const priceProvider = im[1] as `0x${string}`;
        const token0 = String(im[2]).toLowerCase();
        const token1 = String(im[3]).toLowerCase();
        // keep base/stable pools: exactly one side a tracked base asset, the other a stable.
        const a0 = assetForToken(token0), a1 = assetForToken(token1);
        if (!!a0 === !!a1) continue; // both/neither base → skip (stable/stable, unknown/unknown)
        const baseIsToken0 = !!a0;
        const base = (baseIsToken0 ? a0 : a1)!;
        const stableAddr = baseIsToken0 ? token1 : token0;
        const stable = Object.values(TOKENS).find((t) => t.stable && t.address.toLowerCase() === stableAddr);
        if (!stable) continue;
        // REGISTERED pairs only (@shared PAIRS) — a pool for an unregistered combo
        // would emit a market with no reference rows / markout routing.
        const pair = pairFor(base.key, stable.symbol);
        if (!pair) { ctx.log(`Metric: pool ${KNOWN_POOLS[i].slice(0, 8)}… (${base.symbol}/${stable.symbol}) is not a registered pair — skipped`); continue; }
        const baseTok = baseTokenOf(base.key);
        if (!baseTok) continue;
        found.push({
          pool: KNOWN_POOLS[i], priceProvider, market: pair.symbol,
          baseIsToken0, baseToken: base.token, baseDec: baseTok.decimals,
          stableSym: stable.symbol, stableDec: stable.decimals,
        });
      }
      pools = found;
      byAddr = new Map(pools.map((p) => [p.pool.toLowerCase(), p]));
      discovered = true;
      ctx.log(`Metric: ${pools.length} base/stable pool(s)`);

      // Resolve the quote-freshness gas destination from the chain (never
      // hardcoded): every provider names its push oracle + feed id. All
      // providers must agree on ONE oracle; any failure leaves pushOracle
      // null and gasSources() throws — the gas cursor holds and retries at
      // the next discovery, quotes/fills are unaffected.
      pushOracle = null;
      if (pools.length) {
        const res = await ctx.client.multicall({
          contracts: pools.flatMap((p) => [
            { address: p.priceProvider, abi: providerOracleAbi, functionName: 'offchainOracle' as const },
            { address: p.priceProvider, abi: providerOracleAbi, functionName: 'offchainFeedId' as const },
          ]),
          allowFailure: true,
        });
        const oracles = new Set<string>();
        const feedIds = new Set<string>();
        for (let i = 0; i < pools.length; i++) {
          const o = res[i * 2], f = res[i * 2 + 1];
          if (o.status !== 'success' || f.status !== 'success') { oracles.clear(); break; }
          oracles.add(String(o.result).toLowerCase());
          feedIds.add(String(f.result).toLowerCase());
        }
        if (oracles.size === 1) {
          const oracle = [...oracles][0] as `0x${string}`;
          // exclusivity guard: we attribute the oracle's WHOLE burn to Metric,
          // which is only sound while it serves exactly Metric's feeds (true at
          // ship time: getOracleCount()==3 == our three pools). If the operator
          // onboards another tenant on Monad, say so loudly — the number then
          // overcounts until attribution is split per feed.
          try {
            const count = await ctx.client.readContract({ address: oracle, abi: pushOracleAbi, functionName: 'getOracleCount' });
            if (Number(count) !== feedIds.size) {
              ctx.log(`Metric: push oracle serves ${count} feed(s) but Metric uses ${feedIds.size} — burn attribution may overcount`);
            }
            pushOracle = oracle;
          } catch { /* count probe failed — keep pushOracle null, retry next discovery */ }
        }
      }
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      if (!pools.length) return [];

      // 1) each pool's oracle bid/ask (needed as quoteSwap args).
      const ppRes = await ctx.client.multicall({
        contracts: pools.map((p) => ({ address: p.priceProvider, abi: priceProviderAbi, functionName: 'getBidAndAskPrice' as const })),
        allowFailure: true,
      });

      // 2) quoteSwap for each pool × size × side (eth_call — no state change).
      type Leg = { pool: MetricPool; size: number; side: Side; reqIn: bigint; basePx: number };
      const legs: Leg[] = [];
      const calls: { address: `0x${string}`; abi: typeof metricRouterAbi; functionName: 'quoteSwap'; args: readonly [`0x${string}`, boolean, bigint, bigint, bigint, bigint] }[] = [];
      pools.forEach((p, i) => {
        const r = ppRes[i];
        if (r.status !== 'success') return;
        // bps anchor = the pair-terms CEX mid (wrap basis + stable cross applied),
        // NOT the raw USDT price — venue quotes are in the pair's stable terms.
        const basePx = ctx.pricer.pairMid(p.market);
        if (basePx <= 0) return;
        const [bid, ask] = r.result as readonly [bigint, bigint];
        const sellZeroForOne = p.baseIsToken0; // token0→token1 sells the base when base is token0
        for (const size of sizesUsd) {
          // BUY base: exact-in the stable, no upper price bound.
          const buyIn = toUnits(size, p.stableDec);
          legs.push({ pool: p, size, side: 'buy', reqIn: buyIn, basePx });
          calls.push({ address: ROUTER, abi: metricRouterAbi, functionName: 'quoteSwap', args: [p.pool, !sellZeroForOne, buyIn, PRICE_LIMIT_UP, bid, ask] });
          // SELL base: exact-in base worth `size`, no lower price bound.
          const sellIn = toUnits(ctx.pricer.tokenForUsd(p.baseToken, size), p.baseDec);
          legs.push({ pool: p, size, side: 'sell', reqIn: sellIn, basePx });
          calls.push({ address: ROUTER, abi: metricRouterAbi, functionName: 'quoteSwap', args: [p.pool, sellZeroForOne, sellIn, PRICE_LIMIT_DOWN, bid, ask] });
        }
      });
      if (!calls.length) return [];
      const qRes = await ctx.client.multicall({ contracts: calls, allowFailure: true });

      const rowByKey = new Map<string, QuoteRow>();
      const ts = Date.now();
      const abs = (x: bigint) => (x < 0n ? -x : x);
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const r = qRes[i];
        if (r.status !== 'success') continue;
        const [d0, d1] = r.result as readonly [bigint, bigint];
        const baseDelta = l.pool.baseIsToken0 ? d0 : d1;
        const stableDelta = l.pool.baseIsToken0 ? d1 : d0;
        const baseH = fromUnits(abs(baseDelta), l.pool.baseDec);
        const stH = fromUnits(abs(stableDelta), l.pool.stableDec);
        if (baseH <= 0 || stH <= 0) continue;
        const px = stH / baseH; // stable per base
        const bps = (px / l.basePx - 1) * 1e4;
        // filled full when the exact-input leg consumed (almost) the whole requested input.
        const usedIn = l.side === 'buy' ? abs(stableDelta) : abs(baseDelta);
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
      for (const row of rowByKey.values()) row.spreadBps = row.askBps - row.bidBps;
      return [...rowByKey.values()].filter((r) => r.askPx > 0 && r.bidPx > 0);
    },

    logSources() {
      if (!discovered) throw new Error('Metric discovery unavailable'); // hold the cursor until discovered
      if (!pools.length) return [];
      return [{ key: 'swap', address: pools.map((p) => p.pool), events: [ev(metricPoolAbi, 'Swap')], kind: 'fills' as const }];
    },

    // taker entries owned by Metric: today only the pools themselves — sampled
    // flow is dominated by FastLane auctions + searcher bots (global registry /
    // UNKNOWN). Add Metric's official router here if the team publishes one.
    entryPoints: () => pools.map((p) => ({ address: p.pool })),

    // QUOTE_UPDATE_BURN: Metric's quotes stay fresh via a dedicated push
    // oracle (providers' offchainOracle(), resolved at discovery) fed by a
    // rotating fleet of publisher EOAs — flat 150k limit, ~1.5 pushes/s, ONE
    // feed per tx, NO logs (verified: receipts carry zero logs), so 'blocks'
    // mode keyed on the destination, same pattern as Hanji's FastQuoter. The
    // steady heartbeat cadence (staleness refreshes between price moves) is
    // exactly what makes the sampled estimate sound.
    // PROVENANCE (reverse-engineered 2026-07-17, bytecode unverified):
    // selector extraction named the surface — getOracleData(bytes32) is the
    // providers' read, getOracleCount()==3 == exactly Metric's three feeds on
    // Monad (nobody else registered; re-checked at every discovery above).
    // The publisher EOAs pay the gas — we count it as Metric's freshness
    // burn, whole.
    gasSources() {
      if (!pushOracle) throw new Error('Metric push oracle not resolved yet'); // hold the gas cursor
      return [{ mode: 'blocks' as const, address: pushOracle }];
    },

    decode(_ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      const abs = (x: bigint) => (x < 0n ? -x : x);
      for (const l of logs.swap ?? []) {
        const p = byAddr.get(String(l.address).toLowerCase());
        if (!p) continue;
        const a = l.args;
        if (!a || a.amount0Delta === undefined || a.amount1Delta === undefined) continue;
        const d0 = BigInt(a.amount0Delta), d1 = BigInt(a.amount1Delta);
        const baseDelta = p.baseIsToken0 ? d0 : d1;
        const stableDelta = p.baseIsToken0 ? d1 : d0;
        const baseAmount = fromUnits(abs(baseDelta), p.baseDec);
        const usd = fromUnits(abs(stableDelta), p.stableDec);
        if (baseAmount <= 0 || usd <= 0) continue;
        const execPx = usd / baseAmount; // realized stable-per-base (real markouts, no pxApprox)
        // stable INTO the pool (positive delta) ⇒ the trader bought the base.
        const side: Side = stableDelta > 0n ? 'buy' : 'sell';
        out.push({
          id: `metric-${String(l.transactionHash).toLowerCase()}-${l.logIndex}`,
          venueId: METRIC_VENUE.id,
          // attribution is the core's job (tx.to): claiming DIRECT here would
          // label aggregator/searcher flow as direct — emit honest UNKNOWN.
          market: p.market, side, category: 'UNKNOWN',
          usd, baseAmount, execPx,
          txHash: l.transactionHash, to: shortHex(String(a.recipient ?? '0x')),
          pool: `metric ${p.pool.slice(0, 8)}`,
          blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
          markoutsBps: [null, null, null, null, null],
        });
      }
      return out;
    },
  };
}
