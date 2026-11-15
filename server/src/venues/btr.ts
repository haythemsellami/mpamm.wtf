import { parseAbi } from 'viem';
import type { Fill, Pair, QuoteRow, Side, TokenInfo, VenueMeta } from '@shared';
import { ASSETS, NATIVE_MON, PAIRS, TOKENS } from '@shared';
import { fromUnits, shortHex, toUnits } from '../util.js';
import type { AdapterContext, LogBundle, VenueAdapter } from './adapter.js';
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
 * (`inSwapGate`). This dashboard never sends a swap, so the gate affects
 * nothing here; fills of gated swaps are still ordinary `Swapped` logs.
 *
 * A quote the pool cannot honour (size past a coverage threshold, a halted or
 * disabled leg, a stale mark) REVERTS rather than returning a partial amount,
 * so a surviving leg is the full size and a size past the caps has no row.
 *
 * LiabilitySwapped (LP-share swaps) is a different event for a different
 * action and is not a trade of the pool's assets: it is deliberately not read.
 */

// sinceUtc = backfillFromUtc = the pool v2 deployment day. Nothing swapped
// before it.
// color: navy / lavender-white — the one hue family no live venue uses (blues
// are sky/teal, violets are Thog/Hanji). Light navy vs the nearest venue
// ΔE ≥ 13 under normal, protan, deutan and tritan simulation; the pale dark
// variant is >15 from every dark venue color. Proposed for reviewer validation
// per docs/adapters.md.
const BTR_VENUE: VenueMeta = {
  id: 'btr',
  name: 'BTR',
  color: { light: '#1E3A8A', dark: '#E0E7FF' },
  kind: 'amm',
  role: 'venue',
  sinceUtc: '2026-11-13',
};

/** Pool v2 proxy (ERC-1967) on Monad mainnet. */
export const BTR_POOL = '0xbbbbbbbd7060b1ced79c381ead40d73fcb9ae0c6' as const;

/** The implementation the ABIs below were checked against. Any other one is
 *  announced so the quote/fill ABIs get re-checked. */
const VERIFIED_IMPLEMENTATION = '0xf1dd174b3540f298809d51e06ffc9f7f05b161f5';

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

/** Registry keys of the pool's assets that this dashboard tracks. The pool lists
 *  more (mUSD, GHO, USDe, …) but only registered pairs are ever emitted. */
const POOL_TOKEN_KEYS = ['USDC', 'USDT0', 'AUSD', 'WMON', 'WBTC', 'CBBTC', 'WETH', 'XAUT0'] as const;

export interface BtrMarket {
  market: string;
  baseKey: string;
  quoteKey: string;
  base: TokenInfo;
  quote: TokenInfo;
}

const pairKey = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join(':');

function tokenKeysForPair(pair: Pair): readonly [string, string] | undefined {
  // cbBTC is an alternative BTC wrapper, so its market symbol—not Pair.base—
  // selects the on-chain token. The same rule handles the WBTC/cbBTC cross.
  const baseKey = pair.symbol.startsWith('cbBTC/') ? 'CBBTC' : ASSETS[pair.base]?.token;
  const quoteKey = pair.symbol.endsWith('/cbBTC')
    ? 'CBBTC'
    : pair.quoteKind === 'asset'
      ? ASSETS[pair.quote]?.token
      : pair.quote;
  return baseKey && quoteKey ? [baseKey, quoteKey] : undefined;
}

/** Every registered pair whose two ERC-20s are both pool assets, keyed on the
 *  unordered token pair (first PAIRS match wins, i.e. the canonical one). The
 *  swap event names both tokens, so this — not discovery — is the whole decode
 *  table: a fill never depends on a discovery read having succeeded. */
export function btrMarkets(): Map<string, BtrMarket> {
  const listed = new Set(POOL_TOKEN_KEYS.map((k) => TOKENS[k].address.toLowerCase()));
  const out = new Map<string, BtrMarket>();
  for (const pair of PAIRS) {
    const keys = tokenKeysForPair(pair);
    if (!keys) continue;
    const [baseKey, quoteKey] = keys;
    const base = TOKENS[baseKey], quote = TOKENS[quoteKey];
    if (!base || !quote || base.address === NATIVE_MON || quote.address === NATIVE_MON) continue;
    if (base.address.toLowerCase() === quote.address.toLowerCase()) continue;
    if (!listed.has(base.address.toLowerCase()) || !listed.has(quote.address.toLowerCase())) continue;
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
  if (String(log?.address ?? '').toLowerCase() !== BTR_POOL
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
    pool: `btr ${BTR_POOL.slice(0, 10)}`,
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
    const tokens = POOL_TOKEN_KEYS.map((k) => TOKENS[k]);
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
      // decimals are where adapter bugs live: the pool's own must match the registry's.
      const decimals = Number((asset.result as { decimals: number }).decimals);
      if (decimals !== t.decimals) throw new Error(`BTR ${t.symbol} decimals mismatch (pool ${decimals}, registry ${t.decimals})`);
      if ((Number(flags.result) & SWAP_ENABLED_BIT) !== 0) enabled.add(t.address.toLowerCase());
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
    // the pool v2 deployment day — see BTR_VENUE.
    backfillFromUtc: '2026-11-13',

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
        const q = r.result as { amountOut: bigint; amountIn: bigint; protoFee: bigint; lpFee: bigint };
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
        // the quote reports the input it will actually take; less than asked = a partial fill
        if (q.amountIn < leg.amountIn) row.filledFull = false;
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
      // One source, one getLogs: the proxy's Upgraded rides along with the
      // fills so an implementation change is seen in the range it happens.
      // Static, so there is no discovery to wait on.
      return [{ key: 'pool', address: BTR_POOL, events: [event('Swapped'), event('Upgraded')], kind: 'fills' as const }];
    },

    // Takers call the pool directly (swap_qe); BTR has no router of its own, so
    // an aggregator's router is attributed by the core, not claimed here.
    entryPoints: () => [{ address: BTR_POOL }],

    // gasSources omitted on purpose: BTR's keepers push marks with log-less
    // calls to a separate oracle contract whose destination and cadence are
    // not a public interface, so the quote-update burn is not tracked here.

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      let upgraded = false;
      for (const log of logs.pool ?? []) {
        if (log?.eventName === 'Upgraded') {
          const impl = String(log?.args?.implementation ?? '').toLowerCase();
          if (impl === VERIFIED_IMPLEMENTATION) continue;
          // An ABI change is the one thing a refresh cannot absorb: a changed
          // Swapped would match nothing and read exactly like a quiet venue.
          const label = /^0x[0-9a-f]{40}$/.test(impl) ? shortHex(impl) : 'an unreadable implementation';
          ctx.note('venue.upgraded', `BTR: proxy upgraded to ${label} — re-verify quote/fill ABIs against the new implementation`);
          upgraded = true;
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
      if (upgraded) await refresh(ctx);
      return out;
    },
  };
}
