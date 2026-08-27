import { parseAbi } from 'viem';
import type { QuoteRow, Fill, Side, VenueMeta } from '@shared';
import { TOKENS, assetForToken, baseTokenOf, pairFor } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';
import { createQuoteOutageReporter } from './quote-health.js';

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

/** MetricOmmFactory — the permissionless deployer. Metric is a DEX whose pool
 *  architecture lets anyone run their own propAMM on it, so the pool set is
 *  open-ended: pools are discovered from the factory's PoolCreated event rather
 *  than listed here (verified on-chain: 7 pools created to date, of which the
 *  three seeds below are the funded ones). */
const FACTORY = '0xe22F9fc0f04486dE25ed6CF1800a4a47aFD82e0C' as const;

/** Seed pools — the funded, team-run pools that predate event discovery. They
 *  are the ONLY entries that fail loud: a seed that stops resolving is a real
 *  regression, while a permissionless pool that misbehaves is just skipped. */
const SEED_POOLS: `0x${string}`[] = [
  '0xFA32f9ec28787d1F9C5BA5c39e54e59984FEF3f0', // WMON/USDC
  '0x2D82AC42334b394A9a8d8f097d61DC1c6B065Fd8', // WBTC/USDC
  '0x354D92279cA0190fF275095fE6A2a6989BAa66Fb', // WETH/USDC
];

/** Boot does NOT scan the factory's history — it records the head and scans
 *  only forward from there. Three reasons this is safe and the alternative is
 *  not: pools older than boot are the SEED_POOLS (verified: the only other
 *  pools ever created hold nothing); pools created while we were DOWN arrive
 *  through `poolCreated` in logSources, which the core's fills tail gap-fills
 *  from its persisted cursor; and a lookback is ruinously slow — 200k blocks
 *  through the 90-block getLogs cap is ~2,200 sequential requests, measured at
 *  7m45s, which would block boot every restart. The forward scan below then
 *  costs ~17 requests per cycle. */

/** Price-limit sentinels (Q64.64) so a quote walks the full binned liquidity for
 *  the size: no upper bound buying the base, no lower bound selling it. */
const PRICE_LIMIT_UP = (1n << 128n) - 1n;
const PRICE_LIMIT_DOWN = 1n;

const metricPoolAbi = parseAbi([
  'function getImmutables() view returns (address factory, address priceProvider, address token0, address token1, uint104 a, uint104 b, uint104 c, bool reportSwapToPriceProvider, uint256 maxDriftE8, uint256 maxDriftDecayPerSecondE8, int16 lowestBin, int16 highestBin, uint256 token0ScaleMultiplier, uint256 token1ScaleMultiplier)',
  'event Swap(address sender, address recipient, bool exactInput, int128 amount0Delta, int128 amount1Delta, int16 newTick, uint104 newPositionInBin)',
]);
const priceProviderAbi = parseAbi(['function getBidAndAskPrice() view returns (uint128, uint128)']);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
/** Recovered from a real creation log (topic0 0xe1c304ac…): the indexed
 *  priceProvider is the one set AT CREATION and pools expose
 *  setPriceProvider(), so the live provider is always re-read from
 *  getImmutables — never taken from this event. */
const metricFactoryAbi = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, address indexed priceProvider, address pool, bytes32 salt)',
]);
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

/** Why a candidate pool was not admitted (null = admitted). Pure so the
 *  permissionless admission rules are unit-tested without a chain. */
export type RejectReason = 'unresolved' | 'not-base-stable' | 'unregistered-pair' | 'unknown-base-token';

/** STRUCTURAL admission: does this pool describe a market we can price and
 *  benchmark? Metric is permissionless, so anyone can deploy a pool for any
 *  token combo — only registered base/stable pairs (@shared PAIRS) can carry
 *  reference rows and markouts, and everything else is dropped rather than
 *  surfaced as an unbenchmarkable market. */
export function admitMetricPool(pool: `0x${string}`, im: readonly unknown[] | null): { ok: true; value: MetricPool } | { ok: false; reason: RejectReason; detail?: string } {
  if (!im) return { ok: false, reason: 'unresolved' };
  const priceProvider = im[1] as `0x${string}`;
  const token0 = String(im[2]).toLowerCase();
  const token1 = String(im[3]).toLowerCase();
  // exactly one side a tracked base asset, the other a stable
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
      pool, priceProvider, market: pair.symbol, baseIsToken0,
      baseToken: base.token, baseDec: baseTok.decimals,
      stableSym: stable.symbol, stableDec: stable.decimals,
    },
  };
}

/** Why a structurally-valid pool is not quotable right now. Three genuinely
 *  different situations that a bare boolean used to flatten into one, and the
 *  note then labelled all of them "unfunded":
 *   - unfunded   the curator's shell — no inventory, cannot trade. Common:
 *                permissionless deployment means empty pools exist.
 *   - no-price   FUNDED, but the PriceProvider will not answer. The pool can
 *                still TRADE — Metric's router takes bid/ask as call
 *                parameters — so this is capital we cannot price, not a dead
 *                market (observed 2026-08-14: ~$150k across three pools).
 *   - unreadable the TOKEN contract did not answer, so funding is unknown.
 *                Says nothing about the pool; reporting a read problem as the
 *                venue's fault is the mistake #63 fixed for Lunarbase. */
export type NotLiveReason = 'unfunded' | 'no-price' | 'unreadable';

/** LIVENESS: a structurally-valid pool is only QUOTED once it can actually be
 *  priced — both sides funded and the provider returning a two-sided price.
 *  Quoting an empty shell would put dead markets on the Execution tab.
 *  NOTE: fills are NOT gated on this (issue #61) — a pool we cannot price can
 *  still trade, and its Swaps are tailed off ADMISSION. */
export function metricPoolLiveness(
  bal0: bigint | null, bal1: bigint | null, bid: bigint | null, ask: bigint | null,
): 'live' | NotLiveReason {
  // These come from ONE allowFailure multicall, so a per-entry failure is
  // contract-level: a transport failure would have thrown the whole call before
  // we got here. A missing price therefore means the provider REFUSED (Metric's
  // revert since 2026-08-14), not that we could not reach it.
  if (bal0 === null || bal1 === null) return 'unreadable';  // the token contract itself did not answer
  if (bal0 <= 0n || bal1 <= 0n) return 'unfunded';          // one-sided or empty inventory
  if (bid === null || ask === null) return 'no-price';      // provider reverted
  if (bid <= 0n || ask <= 0n) return 'no-price';            // …or answered with nothing
  return 'live';
}

/** Boolean view of the above, for the quote gate. */
export function isMetricPoolLive(bal0: bigint | null, bal1: bigint | null, bid: bigint | null, ask: bigint | null): boolean {
  return metricPoolLiveness(bal0, bal1, bid, ask) === 'live';
}

/**
 * Metric OMM adapter — permissionless factory discovery + on-chain admission
 * (getImmutables) + oracle-quote (PriceProvider + Router.quoteSwap) + Pool.Swap
 * fill decode. No backfill().
 */
export function createMetricAdapter(): VenueAdapter {
  // every leg FAILING is a venue-wide cause (paused, ABI drift, dead RPC route),
  // not a per-pair gap — name it instead of vanishing (venues/quote-health.ts).
  const reportOutage = createQuoteOutageReporter(METRIC_VENUE.name);
  // THREE different questions, three different sets — conflating them is what
  // let real fills go uncounted (issue #61):
  //   admitted → structurally understood (getImmutables + registered pair):
  //              what we TAIL and what we can DECODE.
  //   live     → priceable RIGHT NOW (funded + readable bid/ask): what we QUOTE.
  // A pool whose oracle stops answering leaves `live` but keeps trading — the
  // router takes bid/ask as CALL PARAMETERS, so an aggregator with its own price
  // source swaps against it regardless of whether we can read one.
  let admittedPools: MetricPool[] = [];               // tailed + decodable
  let pools: MetricPool[] = [];                       // live: quoted
  let byAddr = new Map<string, MetricPool>();         // MONOTONIC decode map
  let discovered = false;
  /** every pool address the factory has told us about (seeds + discovered). */
  const candidates = new Set<string>(SEED_POOLS.map((p) => p.toLowerCase()));
  /** factory scan progress; null until the first discovery. */
  let scanCursor: bigint | null = null;
  /** every push oracle Metric's live providers read — sorted + deduped so the
   *  gas tracker's destination fingerprint is stable (see gasSources). */
  let pushOracles: `0x${string}`[] = [];

  /** Full discovery pass — also called from decode() when the factory
   *  announces a pool mid-range. */
  const refresh = async (ctx: AdapterContext) => {
      // ── 1. widen the candidate set from the factory ────────────────────────
      // Incremental: first pass covers a bounded lookback, later passes only
      // the new blocks. A scan failure is non-fatal — the seeds and everything
      // already discovered still resolve below, and the cursor is left alone
      // so the next cycle retries the same range.
      try {
        const head = await ctx.client.getBlockNumber();
        if (scanCursor === null) scanCursor = head + 1n;   // first pass: anchor, don't backscan
        const from = scanCursor;
        if (from <= head) {
          const logs = await ctx.getLogs({
            address: FACTORY, fromBlock: from, toBlock: head,
            events: [ev(metricFactoryAbi, 'PoolCreated')],
          }) as any[];
          let added = 0;
          for (const l of logs ?? []) {
            const p = String(l?.args?.pool ?? '').toLowerCase();
            if (/^0x[0-9a-f]{40}$/.test(p) && !candidates.has(p)) { candidates.add(p); added++; }
          }
          scanCursor = head + 1n;
          if (added) ctx.note('venue.discovery', `Metric: factory announced ${added} new pool(s)`);
        }
      } catch { /* scan failed — keep the cursor, retry next discovery */ }

      // ── 2. resolve + admit every candidate ─────────────────────────────────
      const list = [...candidates] as `0x${string}`[];
      const seeds = new Set(SEED_POOLS.map((p) => p.toLowerCase()));
      const imRes = await ctx.client.multicall({
        contracts: list.map((p) => ({ address: p, abi: metricPoolAbi, functionName: 'getImmutables' as const })),
        allowFailure: true,
      });
      const admitted: MetricPool[] = [];
      for (let i = 0; i < list.length; i++) {
        const r = imRes[i];
        const isSeed = seeds.has(list[i].toLowerCase());
        const verdict = admitMetricPool(list[i], r.status === 'success' ? (r.result as readonly unknown[]) : null);
        if (verdict.ok) { admitted.push(verdict.value); continue; }
        // A SEED that stops resolving is a real regression → fail closed (held
        // cursor). A permissionless pool is just not ours to vouch for: skip it
        // and keep the venue running.
        if (isSeed && verdict.reason === 'unresolved') throw new Error(`Metric getImmutables failed for seed pool ${list[i]}`);
        if (verdict.reason === 'unregistered-pair') {
          ctx.note('venue.market.unlisted', `Metric: pool ${shortHex(list[i])} (${verdict.detail}) is not a registered pair — skipped`);
        }
      }

      // ── 3. liveness gate: funded + two-sided quote ─────────────────────────
      const liveRes = await ctx.client.multicall({
        contracts: admitted.flatMap((p) => {
          const baseAddr = TOKENS[p.baseToken]?.address as `0x${string}`;
          const stableAddr = Object.values(TOKENS).find((t) => t.symbol === p.stableSym)?.address as `0x${string}`;
          return [
            { address: baseAddr, abi: erc20Abi, functionName: 'balanceOf' as const, args: [p.pool] as const },
            { address: stableAddr, abi: erc20Abi, functionName: 'balanceOf' as const, args: [p.pool] as const },
            { address: p.priceProvider, abi: priceProviderAbi, functionName: 'getBidAndAskPrice' as const },
          ];
        }),
        allowFailure: true,
      });
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

      admittedPools = admitted;
      pools = live;
      // The decode map is MONOTONIC and keyed on ADMISSION, not liveness. Keying
      // it on `live` protected only fills already fetched in the same cycle,
      // while the pool silently left logSources() and stopped producing fills to
      // decode at all — the loss the old comment warned about, one step earlier.
      for (const p of admitted) byAddr.set(p.pool.toLowerCase(), p);
      discovered = true;
      // Name each cause. "unfunded" for everything was wrong the moment a funded
      // pool lost its oracle: it sent whoever read it to check balances (#58).
      const why = [
        notLive.unfunded ? `${notLive.unfunded} unfunded` : '',
        notLive['no-price'] ? `${notLive['no-price']} funded but no oracle price` : '',
        notLive.unreadable ? `${notLive.unreadable} unreadable` : '',
      ].filter(Boolean);
      ctx.note('venue.discovery', `Metric: ${live.length} live base/stable pool(s)${why.length ? ` (+${why.join(', ')}; not quoted)` : ''}`);
      // Funded capital we cannot price is a DEGRADATION, not lifecycle, so it
      // belongs at warn rather than buried in the discovery line. It also gives
      // the core's went-dark backstop the reason it cannot know: without this
      // the venue is reported as "offline, or its adapter no longer matches the
      // contract" — a guess, when the adapter knows exactly what happened.
      if (notLive['no-price']) {
        ctx.note('venue.quote.unavailable', `Metric: ${notLive['no-price']} funded pool(s) have no oracle price — their PriceProvider is not answering, so they cannot be quoted (they can still trade, and their fills are still tailed)`);
      }

      // ── 4. gas destinations: EVERY oracle Metric's providers read ──────────
      // Metric is permissionless infra: curators plug in their own pricing, so
      // pools can read DIFFERENT push oracles. Requiring a single shared oracle
      // (the old rule) would silently stall burn tracking the day a second one
      // appears — gasSources() would throw forever and the series would flatline
      // while looking merely quiet. Collect them all instead; the tracker takes
      // an address array and its destination fingerprint handles the set change.
      const oracleFeeds = new Map<string, Set<string>>();
      if (pools.length) {
        const provRes = await ctx.client.multicall({
          contracts: pools.flatMap((p) => [
            { address: p.priceProvider, abi: providerOracleAbi, functionName: 'offchainOracle' as const },
            { address: p.priceProvider, abi: providerOracleAbi, functionName: 'offchainFeedId' as const },
          ]),
          allowFailure: true,
        });
        for (let i = 0; i < pools.length; i++) {
          const o = provRes[i * 2], f = provRes[i * 2 + 1];
          // one unreadable provider must not blank the others (that was the
          // old `oracles.clear(); break;` — a single failure killed all burn).
          if (o.status !== 'success' || f.status !== 'success') continue;
          const oracle = String(o.result).toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(oracle) || /^0x0{40}$/.test(oracle)) continue;
          const set = oracleFeeds.get(oracle) ?? new Set<string>();
          set.add(String(f.result).toLowerCase());
          oracleFeeds.set(oracle, set);
        }
      }
      pushOracles = [...oracleFeeds.keys()].sort() as `0x${string}`[];

      // Multi-tenancy note: we attribute an oracle's WHOLE burn to Metric. That
      // is right while it serves only Metric feeds. If it serves more, say so —
      // the number then includes another tenant's pushes.
      for (const [oracle, feeds] of oracleFeeds) {
        try {
          const count = await ctx.client.readContract({ address: oracle as `0x${string}`, abi: pushOracleAbi, functionName: 'getOracleCount' });
          if (Number(count) !== feeds.size) {
            ctx.note('venue.gas.suspect', `Metric: push oracle ${shortHex(oracle)} serves ${count} feed(s) but Metric uses ${feeds.size} — burn attribution may overcount`);
          }
        } catch { /* count is advisory only — never gates tracking */ }
      }
  };

  return {
    venues: () => [METRIC_VENUE],
    // seed daily volume by replaying Pool.Swap on-chain from the earliest pool's
    // deployment era (WMON/USDC block 65042020 · 2026-03-31). Background — see live.ts.
    backfillFromUtc: '2026-03-31',

    discover: refresh,

    async quote(ctx: AdapterContext, sizesUsd: readonly number[], blockNumber: bigint, markets?: ReadonlySet<string>): Promise<QuoteRow[]> {
      const selectedPools = pools.filter((p) => !markets || markets.has(p.market));
      if (!selectedPools.length) return [];

      // 1) each pool's oracle bid/ask (needed as quoteSwap args).
      const ppRes = await ctx.client.multicall({
        contracts: selectedPools.map((p) => ({ address: p.priceProvider, abi: priceProviderAbi, functionName: 'getBidAndAskPrice' as const })),
        allowFailure: true,
        blockNumber,
      });

      // 2) quoteSwap for each pool × size × side (eth_call — no state change).
      type Leg = { pool: MetricPool; size: number; side: Side; reqIn: bigint; basePx: number };
      const legs: Leg[] = [];
      const calls: { address: `0x${string}`; abi: typeof metricRouterAbi; functionName: 'quoteSwap'; args: readonly [`0x${string}`, boolean, bigint, bigint, bigint, bigint] }[] = [];
      selectedPools.forEach((p, i) => {
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
      const qRes = await ctx.client.multicall({ contracts: calls, allowFailure: true, blockNumber });
      if (reportOutage(ctx, qRes)) return [];

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
      // The factory source is ALWAYS tailed, even with no live pools: it is how
      // a permissionless deployment reaches us between discovery cycles. 'state'
      // because a missed PoolCreated makes that pool's later Swaps undecodable,
      // so its failure must hold the cursor like any other decode prerequisite.
      const sources = [{ key: 'poolCreated', address: FACTORY as `0x${string}`, events: [ev(metricFactoryAbi, 'PoolCreated')], kind: 'state' as const }];
      // ADMITTED, not live: an unquotable pool still trades (issue #61 — Metric
      // executed 141 swaps in the 6.7h after its oracle began reverting, none of
      // which we saw because this list had gone empty).
      if (!admittedPools.length) return sources;
      return [{ key: 'swap', address: admittedPools.map((p) => p.pool), events: [ev(metricPoolAbi, 'Swap')], kind: 'fills' as const }, ...sources];
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
      // Fail closed only when we know of NO oracle at all — with one or many,
      // count them all. Sorted + deduped at discovery so the tracker's
      // destination fingerprint is stable across passes.
      if (!pushOracles.length) throw new Error('Metric push oracle not resolved yet'); // hold the gas cursor
      return [{ mode: 'blocks' as const, address: [...pushOracles] }];
    },

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      // A pool announced mid-range must be admitted BEFORE this range's Swaps
      // are decoded, or its first fills would be dropped as unknown addresses.
      const created = (logs.poolCreated ?? []).filter((l: any) => {
        const p = String(l?.args?.pool ?? '').toLowerCase();
        return /^0x[0-9a-f]{40}$/.test(p) && !candidates.has(p);
      });
      if (created.length) {
        for (const l of created) candidates.add(String(l.args.pool).toLowerCase());
        ctx.note('venue.discovery', `Metric: factory deployed ${created.length} new pool(s) — re-running discovery`);
        await refresh(ctx);
      }
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
