import { parseAbi } from 'viem';
import type { Fill, QuoteRow, Side, TokenInfo, VenueMeta } from '@shared';
import { NATIVE_MON, PAIRS, TOKENS } from '@shared';
import { fromUnits, shortHex, toUnits } from '../util.js';
import type { AdapterContext, LogBundle, VenueAdapter } from './adapter.js';
import { pairKey, tokenKeysForPair } from './pair-tokens.js';
import { createQuoteOutageReporter } from './quote-health.js';

/**
 * BTR pool v2 — an oracle-priced, multi-asset AMM (BTR's "AIMM") on Monad.
 *
 * One pool holds every listed asset in a single book. There is no curve to
 * port: a price is the pool's own mark for each leg (pushed on-chain by BTR's
 * keepers), widened by a size- and inventory-dependent spread, so it is a
 * propAMM here. Any pair of listed assets swaps in ONE call; a spoke-to-spoke
 * swap crosses the book's hub internally and still emits ONE `Swapped`. The
 * adapter never reimplements that maths — it asks the pool:
 *
 *   pool.getSwapQuote(tokenIn, tokenOut, amountIn) → the executable, fee-inclusive
 *                                                    exact-in quote (a view; the
 *                                                    result's `amountOut` is the
 *                                                    amount a swap pays)
 *   pool.getAsset(t) / getRiskFlags(t)              → listing, decimals, swap-enabled bit
 *   pool.Swapped(…)                                 → the landed fill
 *
 * `getSwapQuote` does not depend on msg.sender, so quoting works from any
 * address. Executing `swap_qe` is a different matter: while a leg carries the
 * SWAP_GATED risk flag, the pool only accepts senders on its swap gate
 * (`inSwapGate`). A quoted price is therefore executable THROUGH a gated
 * sender, not by any direct caller: on 2026-11-16 the gate held KyberSwap's
 * MetaAggregationRouterV2 and its executor, none of BTR's own executors, and
 * pool v2 had not swapped yet. Fills of gated swaps are ordinary `Swapped`
 * logs.
 *
 * TWO POOLS, one venue. Pool v2 (created 2026-11-13) replaced an earlier
 * proxy from the same deployer that emitted the same `Swapped`: 1,731 of them
 * between 2026-10-02 and 2026-11-10, the only ones on the chain before pool
 * v2 (topic-only scan from 2026-09-30). The layout is the same too — sampled
 * across that whole span, both halves of `amounts` equal the ERC-20 transfers
 * in the same tx, to the wei. That history is the venue's, so both addresses
 * sit in the ONE log source: no extra getLogs, and no promise to make about
 * the retired pool staying inert. Only pool v2 is quoted (the retired pool's
 * quotes revert).
 *
 * A quote the pool cannot honour (size past a coverage threshold, a halted or
 * disabled leg, a stale mark) REVERTS rather than returning a partial amount,
 * so a surviving leg is the full size and a size past the caps has no row.
 *
 * LiabilitySwapped (LP-share swaps) is a different event for a different
 * action and is not a trade of the pool's assets: it is deliberately not read.
 */

// sinceUtc = backfillFromUtc = the day the retired pool was deployed (block
// 109,610,388 · 2026-10-01 12:40 UTC). Its first Swapped landed the next day
// (block 109,894,457), and a topic-only scan from 2026-09-30 finds no other
// emitter of this event.
// color: navy / lavender-white — the one hue family no live venue uses (blues
// are sky/teal, violets are Thog/Hanji). ΔE00 against every venue and
// reference color under normal vision and Machado protan/deutan/tritan
// simulation: nearest in light is Hanji at 6.7 (protan; 24.4 normal), then
// ThogAMM at 11.9; nearest in dark is 11.0 (Bybit, and Lunarbase under
// protan). Both clear the palette's own closest pairs under the same
// simulations (3.2 light, 0.5 dark). Contrast 10.0:1 light, 15.9:1 dark.
const BTR_VENUE: VenueMeta = {
  id: 'btr',
  name: 'BTR',
  color: { light: '#1E3A8A', dark: '#E0E7FF' },
  kind: 'amm',
  role: 'venue',
  sinceUtc: '2026-10-01',
};

/** Pool v2 proxy (ERC-1967) on Monad mainnet — the only pool quoted. */
export const BTR_POOL = '0xbbbbbbbd7060b1ced79c381ead40d73fcb9ae0c6' as const;

/** The proxy pool v2 replaced: Swapped from block 109,894,457 to 120,916,325.
 *  Decode-only — its fills are the venue's history. */
export const BTR_RETIRED_POOL = '0xbbbbbbb04f5b762a4cdd1d89e341e2537e3267e4' as const;

const BTR_POOLS: ReadonlySet<string> = new Set([BTR_POOL, BTR_RETIRED_POOL]);

/**
 * Every implementation the two proxies have run, oldest first — APPEND-ONLY.
 * Two things hang off each entry:
 *  - the ABIs below were checked against it, so an `Upgraded` to any other
 *    one is announced for them to be re-checked;
 *  - it is a quote-update destination (see gasSources). Dropping one rescans
 *    the venue's whole gas series, so a replaced implementation stays listed.
 * Pool v2's only `Upgraded` is in its creation block; the retired proxy read
 * the same implementation from creation to its last swap.
 */
const IMPLEMENTATIONS: readonly `0x${string}`[] = [
  '0x154be75fff18c9dfdd15d7f902b64a7b93b2a638', // retired pool
  '0xf1dd174b3540f298809d51e06ffc9f7f05b161f5', // pool v2
];

/**
 * BTR's own executors: contracts the pools' deployer (0x0a37aec2…) created
 * through its vanity factory — each is both tx.to and the event's `sender`,
 * and one EOA (0xd1b33b54…) drives them all: 612 of the retired pool's 1,731
 * swaps, about 44% of its USD (the sampled ones are atomic arbitrage against
 * other venues). The first four fronted the retired pool; the last is the
 * only one that has swapped through pool v2 (from 2026-11-16), whose other
 * flow comes through aggregators the core's registry already names.
 *
 * Found by tallying tx.to over every Swapped, not from BTR's docs: a new
 * executor shows up as a `0xbbbbbbb…` tx.to the attributor leaves UNKNOWN.
 *
 * Listing one labels the fills the tail (or a re-read) decodes from then on.
 * It does not re-label history: the volume replay and the onboarding fill
 * scan never ask the core attributor, so every fill they store keeps the
 * adapter's UNKNOWN (all 1,143 did in a rehearsal of the scan, 2026-11-17).
 */
const BTR_EXECUTORS = [
  '0xbbbbbbb0d5cfe5bc7939ae0fce2cf21b95e806a7',
  '0xbbbbbbb0f219f537a64d41a907192ba41b5225be',
  '0xbbbbbbb1e1dabc155c79f4688cdb462a462f4040',
  '0xbbbbbbb0f8c5d06406a6ff39abe1d514e25ade2e', // 151 swaps, 2026-10-15 → 10-29
  '0xbbbbbbb2a9c5b6da52f2cc79f6a306ebcb37e5cf', // pool v2
] as const;

/** Pool risk-flag bit: the leg may be swapped at all. */
const SWAP_ENABLED_BIT = 16;

const poolAbi = parseAbi([
  'function getAsset(address tk) view returns ((uint128 reserves, uint128 liabilities, address anchor, uint96 minLiquidity, uint72 liquidityIndexWad, uint32 minDispersionPbps, uint16 curveId, uint16 minFeePbps, uint16 vegaBps, uint16 depositCapCode, uint8 decimals, uint8 deadSeedPow10, uint16 flags, uint16 maxLiabWeightBps, uint8 oracleBits, uint32 covBits, uint16 kneeBits))',
  'function getRiskFlags(address tk) view returns (uint16)',
  'function getSwapQuote(address tokenIn, address tokenOut, uint256 amountIn) view returns ((uint256 amountOut, uint256 amountIn, uint16 spreadPbps, uint256 protoFee, uint256 lpFee, int8 skewIn, int8 skewOut, uint256 markPrice, uint256 midPrice, uint256 covToll, address[] routeHops, uint256[] hopAmounts, uint256[] hopPrices))',
  // amounts = amountIn | amountOut << 128 (raw token units).
  'event Swapped(address indexed sender, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amounts, uint256 fees, uint256 prices, uint256 outBook, uint256 outState)',
  'event Upgraded(address indexed implementation)',
]);
const event = (name: string) => poolAbi.find((x: any) => x.type === 'event' && x.name === name)!;

export interface BtrMarket {
  market: string;
  baseKey: string;
  quoteKey: string;
  base: TokenInfo;
  quote: TokenInfo;
}

/** Every registered pair whose two ERC-20s could meet in a pool, keyed on the
 *  unordered token pair (first PAIRS match wins, i.e. the canonical one). The
 *  swap event names both tokens, so this — not discovery, and not a hand-kept
 *  list of what the pool lists — is the whole decode table: a fill depends on
 *  neither a discovery read nor an edit here the day BTR lists another
 *  registered token. The pool lists more than the registry tracks (mUSD, GHO,
 *  USDe, …); a pair that is not registered maps to nothing and is dropped. */
export function btrMarkets(): Map<string, BtrMarket> {
  const out = new Map<string, BtrMarket>();
  for (const pair of PAIRS) {
    const keys = tokenKeysForPair(pair);
    if (!keys) continue;
    const [baseKey, quoteKey] = keys;
    const base = TOKENS[baseKey], quote = TOKENS[quoteKey];
    if (!base || !quote || base.address === NATIVE_MON || quote.address === NATIVE_MON) continue;
    if (base.address.toLowerCase() === quote.address.toLowerCase()) continue;
    const key = pairKey(base.address, quote.address);
    if (!out.has(key)) out.set(key, { market: pair.symbol, baseKey, quoteKey, base, quote });
  }
  return out;
}

const MARKETS_BY_TOKENS = btrMarkets();

/** The registered market for a swap's two tokens, in either direction. */
export function btrMarketFor(tokenA: string, tokenB: string): BtrMarket | undefined {
  return MARKETS_BY_TOKENS.get(pairKey(tokenA, tokenB));
}

const MASK128 = (1n << 128n) - 1n;

/**
 * One `Swapped` log → a Fill, or null when it is not a priceable trade on a
 * registered pair (skipped locally, never thrown: one odd log must not wedge
 * the tail). Pure, so the unit math is locked by fixture tests.
 *
 * usd: a stable-quoted pair's stable leg as transferred, like every other
 * venue; a crypto-quoted pair is valued off the pricer's last good price of
 * its quote leg (the pool settles in the assets themselves, with no USD leg).
 */
export function decodeBtrSwap(
  log: any,
  ts: number,
  usdForToken: (tokenKey: string, amount: number) => number,
): Fill | null {
  const args = log?.args;
  const txHash = String(log?.transactionHash ?? '');
  const logIndex = Number(log?.logIndex);
  const pool = String(log?.address ?? '').toLowerCase();
  if (!BTR_POOLS.has(pool)
    || String(log?.eventName ?? '') !== 'Swapped'
    || !args || !/^0x[0-9a-fA-F]{64}$/.test(txHash)
    || !Number.isSafeInteger(logIndex) || logIndex < 0) return null;

  let amountIn: bigint, amountOut: bigint, blockNumber: bigint;
  try {
    const amounts = BigInt(args.amounts);
    amountIn = amounts & MASK128;
    amountOut = amounts >> 128n;
    blockNumber = BigInt(log.blockNumber);
  } catch {
    return null;
  }
  if (amountIn <= 0n || amountOut <= 0n || blockNumber <= 0n
    || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const tokenIn = String(args.tokenIn ?? '').toLowerCase();
  const tokenOut = String(args.tokenOut ?? '').toLowerCase();
  const m = btrMarketFor(tokenIn, tokenOut);
  if (!m) return null;

  const sellsBase = tokenIn === m.base.address.toLowerCase();
  const baseAmount = fromUnits(sellsBase ? amountIn : amountOut, m.base.decimals);
  const quoteAmount = fromUnits(sellsBase ? amountOut : amountIn, m.quote.decimals);
  if (!(baseAmount > 0) || !(quoteAmount > 0)) return null;

  let usd = usdForToken(m.quoteKey, quoteAmount);
  if (!(usd > 0)) usd = usdForToken(m.baseKey, baseAmount);
  if (!(usd > 0)) throw new Error(`BTR ${m.market}: no USD price for either fill leg`);

  const side: Side = sellsBase ? 'sell' : 'buy';
  return {
    id: `btr-${txHash.toLowerCase()}-${logIndex}`,
    venueId: BTR_VENUE.id,
    market: m.market,
    side,
    // attribution is the core's job (tx.to vs entryPoints / the aggregator
    // registry) — never guess DIRECT here.
    category: 'UNKNOWN',
    usd,
    baseAmount,
    execPx: quoteAmount / baseAmount, // realized quote-per-base, fee-inclusive
    txHash,
    to: shortHex(String(args.recipient ?? '0x')),
    pool: `btr ${pool.slice(0, 10)}`,
    blockNumber: Number(blockNumber),
    ts,
    markoutsBps: [null, null, null, null, null],
  };
}

interface QuoteLeg {
  market: BtrMarket;
  sizeUsd: number;
  side: Side;
  amountIn: bigint;
  mid: number;
}

export function createBtrAdapter(): VenueAdapter {
  /** markets whose two tokens are both swap-enabled pool assets — merged, never shrunk. */
  const quotable = new Map<string, BtrMarket>();
  // Every leg reverting is venue-wide (halted, feed gate, ABI drift), not a
  // thin market — name it instead of vanishing (venues/quote-health.ts).
  const reportOutage = createQuoteOutageReporter(BTR_VENUE.name);

  const refresh = async (ctx: AdapterContext) => {
    const blockNumber = await ctx.client.getBlockNumber();
    // The registry cannot enumerate the pool's assets, so probe every
    // registered ERC-20: a new listing is picked up with no edit here.
    const tokens = Object.values(TOKENS).filter((t) => t.address !== NATIVE_MON);
    const res = await ctx.client.multicall({
      contracts: tokens.flatMap((t) => [
        { address: BTR_POOL, abi: poolAbi, functionName: 'getAsset' as const, args: [t.address as `0x${string}`] as const },
        { address: BTR_POOL, abi: poolAbi, functionName: 'getRiskFlags' as const, args: [t.address as `0x${string}`] as const },
      ]),
      allowFailure: true,
      blockNumber,
    });
    const enabled = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const asset = res[i * 2], flags = res[i * 2 + 1];
      if (asset.status !== 'success' || flags.status !== 'success') throw new Error(`BTR getAsset/getRiskFlags(${t.symbol}) read failed`);
      const decimals = Number((asset.result as { decimals: number }).decimals);
      const riskFlags = Number(flags.result);
      // An asset the pool does not list reads back as a zeroed struct, not a
      // revert. Skip it: one delisting must not fail discovery for the venue.
      if (decimals === 0 && riskFlags === 0) continue;
      // decimals are where adapter bugs live: a listed asset's must match the registry's.
      if (decimals !== t.decimals) throw new Error(`BTR ${t.symbol} decimals mismatch (pool ${decimals}, registry ${t.decimals})`);
      if ((riskFlags & SWAP_ENABLED_BIT) !== 0) enabled.add(t.address.toLowerCase());
    }
    let found = 0;
    for (const m of MARKETS_BY_TOKENS.values()) {
      if (!enabled.has(m.base.address.toLowerCase()) || !enabled.has(m.quote.address.toLowerCase())) continue;
      quotable.set(m.market, m);
      found++;
    }
    if (!found) throw new Error('BTR discovered no registered markets');
    ctx.note('venue.discovery', `BTR: ${found} registered market(s) across ${enabled.size} swap-enabled asset(s) at block ${blockNumber}`);
  };

  return {
    venues: () => [BTR_VENUE],
    quoteMarkets: () => [...quotable.keys()],
    // the retired pool's deployment day — see BTR_VENUE.
    backfillFromUtc: '2026-10-01',
    // The lifetime backfill ran on 2026-11-16 and valued the crypto-quoted
    // fills (150 of them, the first on 10-13) at that day's prices: $19,663
    // booked where they were worth $26,017 at their own second. The replay
    // now prices a closed day as of its own blocks (closed-day-prices.ts), so
    // re-run it from the first affected day. Swap counts and stable-quoted
    // days come back unchanged.
    historyRevisions: [{ id: 'fill-time-usd', from: '2026-10-13' }],

    discover: refresh,

    async quote(ctx: AdapterContext, sizesUsd: readonly number[], blockNumber: bigint, markets?: ReadonlySet<string>): Promise<QuoteRow[]> {
      const calls: Array<{ address: typeof BTR_POOL; abi: typeof poolAbi; functionName: 'getSwapQuote'; args: readonly [`0x${string}`, `0x${string}`, bigint] }> = [];
      const legs: QuoteLeg[] = [];
      for (const m of quotable.values()) {
        if (markets && !markets.has(m.market)) continue;
        // bps anchor = the pair-terms CEX mid, not a raw USDT price.
        const mid = ctx.pricer.pairMid(m.market);
        if (mid <= 0 || ctx.pricer.usdPerToken(m.baseKey) <= 0 || ctx.pricer.usdPerToken(m.quoteKey) <= 0) continue;
        for (const sizeUsd of sizesUsd) {
          for (const side of ['sell', 'buy'] as const) {
            const [inKey, input, output] = side === 'sell' ? [m.baseKey, m.base, m.quote] : [m.quoteKey, m.quote, m.base];
            const amountIn = toUnits(ctx.pricer.tokenForUsd(inKey, sizeUsd), input.decimals);
            if (amountIn <= 0n) continue;
            calls.push({ address: BTR_POOL, abi: poolAbi, functionName: 'getSwapQuote', args: [input.address as `0x${string}`, output.address as `0x${string}`, amountIn] });
            legs.push({ market: m, sizeUsd, side, amountIn, mid });
          }
        }
      }
      if (!calls.length) return [];

      const results = await ctx.client.multicall({ contracts: calls, allowFailure: true, blockNumber });
      if (reportOutage(ctx, results)) return [];

      const rows = new Map<string, QuoteRow & { fees: number[] }>();
      const ts = Date.now();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status !== 'success') continue;
        const leg = legs[i];
        const q = r.result as { amountOut: bigint; protoFee: bigint; lpFee: bigint };
        if (q.amountOut <= 0n) continue;
        const m = leg.market;
        const inH = fromUnits(leg.amountIn, leg.side === 'sell' ? m.base.decimals : m.quote.decimals);
        const outH = fromUnits(q.amountOut, leg.side === 'sell' ? m.quote.decimals : m.base.decimals);
        if (inH <= 0 || outH <= 0) continue;
        const key = `${m.market}|${leg.sizeUsd}`;
        let row = rows.get(key);
        if (!row) {
          row = { venueId: BTR_VENUE.id, market: m.market, sizeUsd: leg.sizeUsd, bidPx: 0, askPx: 0, bidBps: 0, askBps: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts, fees: [] };
          rows.set(key, row);
        }
        // fee as the pool charges it: (protocol + LP fee) over the gross output, both in tokenOut units
        const gross = q.amountOut + q.protoFee + q.lpFee;
        if (gross > 0n) row.fees.push(Number((q.protoFee + q.lpFee) * 10_000_000n / gross) / 1000);
        if (leg.side === 'sell') {
          row.bidPx = outH / inH;
          row.bidBps = (row.bidPx / leg.mid - 1) * 1e4;
        } else {
          row.askPx = inH / outH;
          row.askBps = (row.askPx / leg.mid - 1) * 1e4;
        }
      }
      const out: QuoteRow[] = [];
      for (const { fees, ...row } of rows.values()) {
        if (fees.length) row.feeBps = fees.reduce((a, b) => a + b, 0) / fees.length;
        if (row.bidPx > 0 && row.askPx > 0) row.spreadBps = row.askBps - row.bidBps;
        else row.oneSided = true; // e.g. the pool holds too little of one side
        out.push(row);
      }
      return out;
    },

    logSources() {
      // One source, one getLogs, both pools: a proxy's Upgraded rides along
      // with the fills so an implementation change is seen in the range it
      // happens. Static, so there is no discovery to wait on.
      return [{ key: 'pool', address: [BTR_POOL, BTR_RETIRED_POOL], events: [event('Swapped'), event('Upgraded')], kind: 'fills' as const }];
    },

    // Takers call a pool directly (swap_qe), or enter through one of BTR's
    // own executors. An aggregator's router is attributed by the core, not
    // claimed here.
    entryPoints: () => [
      { address: BTR_POOL },
      { address: BTR_RETIRED_POOL },
      ...BTR_EXECUTORS.map((address) => ({ address, router: 'BTR' })),
    ],

    // QUOTE_UPDATE_BURN: BTR's keeper pays for every mark push. A pool keeps
    // its marks in its IMPLEMENTATION's own storage — getSwapQuote STATICCALLs
    // the implementation address, and the pushes (selector 0x013b6436, no
    // logs) are sent to that address, never to the proxy. So blocks mode on
    // every implementation — sampled, shown with ≈. At one push per ~10-14
    // blocks (20-28k a day, measured 2026-11-14..15; the retired pool ran one
    // per ~11) the default 1000-block stride lands on a push ~25 times a day:
    // a day's figure carries ~±20% sampling noise.
    gasSources: () => [{ mode: 'blocks' as const, address: [...IMPLEMENTATIONS] }],

    decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      for (const log of logs.pool ?? []) {
        if (log?.eventName === 'Upgraded') {
          const impl = String(log?.args?.implementation ?? '').toLowerCase();
          if (IMPLEMENTATIONS.includes(impl as `0x${string}`)) continue;
          // An ABI change is the one thing nothing here can absorb: a changed
          // Swapped would match nothing and read exactly like a quiet venue.
          // Announce it and keep decoding. The decode table is static, so
          // there is no discovery to redo, and a chain read that failed here
          // would hold the shared cursor for every venue.
          const label = /^0x[0-9a-f]{40}$/.test(impl) ? shortHex(impl) : 'an unreadable implementation';
          ctx.note('venue.upgraded', `BTR: proxy ${shortHex(String(log?.address ?? '').toLowerCase())} upgraded to ${label} — re-verify quote/fill ABIs against it and add it to IMPLEMENTATIONS (its mark pushes are untracked until then)`);
          continue;
        }
        let blockNumber: bigint;
        try {
          blockNumber = BigInt(log?.blockNumber);
        } catch {
          continue;
        }
        const fill = decodeBtrSwap(log, tsOf(blockNumber), (tokenKey, amount) => ctx.pricer.usdForToken(tokenKey, amount));
        if (fill) out.push(fill);
      }
      return out;
    },
  };
}
