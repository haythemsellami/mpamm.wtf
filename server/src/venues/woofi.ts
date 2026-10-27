import { parseAbi } from 'viem';
import type { Fill, Pair, QuoteRow, Side, TokenInfo, VenueMeta } from '@shared';
import { ASSETS, NATIVE_MON, PAIRS, TOKENS } from '@shared';
import { fromUnits, shortHex, toUnits } from '../util.js';
import type { AdapterContext, LogBundle, VenueAdapter } from './adapter.js';
import { createQuoteOutageReporter } from './quote-health.js';

/**
 * WOOFi sPMM — WOOFi's "synthetic proactive market maker" (WooPPV2) on Monad.
 *
 * One pool holds every listed token against a single quote token (USDC) and
 * has no curve: a swap is priced off the Wooracle, a per-token price / spread /
 * coeff state that WOOFi's own keeper pushes every ~9 seconds, widened by the
 * trade's notional (coeff × size) and capped per token on-chain (maxGamma,
 * maxNotionalSwap). Oracle-priced and team-funded, so it is a propAMM here;
 * the adapter never ports that math — it asks the pool:
 *
 *   pool.quoteToken() / wooracle()      → layout, re-read at every discovery
 *   pool.tokenInfos(t) / decimalInfo(t) → listing, fee rate, caps, decimals
 *   pool.query(from, to, amountIn)      → the executable, fee-inclusive quote
 *   pool.WooSwap(…)                     → the landed fill
 *
 * `query` runs the swap's own pricing path AND the reserve check: replayed at
 * block N−1 it reproduced 56 of 60 sampled fills to the wei, base→base
 * included; the other four moved ≤1.4bps on same-block oracle pushes.
 * `tryQuery` skips the reserve check, so it quotes sizes the pool cannot pay.
 *
 * BASE→BASE: WETH→WMON is ONE pool swap that routes through USDC internally
 * and emits ONE WooSwap, with `swapVol` = the USDC leg (gross of fee) and no
 * USDC transfer at all. Nothing double counts, and it maps to the registered
 * crypto/crypto pair (MON/ETH, BTC/ETH, …) like any other venue's cross.
 *
 * Only the implementation's bytecode is on-chain (monadscan has no verified
 * source); every selector here was resolved from it and every unit checked
 * against real fills and their ERC-20 transfers. The ABI is WooPPV2's, the
 * contract WOOFi deploys at this same address on its other chains.
 */

// sinceUtc = backfillFromUtc = the first WooSwap (block 39,163,952 · 2025-12-01
// 09:48 UTC), found by scanning the pool's full log history from its creation
// (block 38,315,208 · 2025-11-27). It sat unfunded until the first deposit
// that same morning, so nothing traded or needed quoting before then.
// color: deep green / sea green — the one hue family no live venue uses
// (Uniswap's olive is the default-off baseline band). Checked against every
// venue and reference color under normal, deutan, protan and tritan
// simulation: ΔE00 ≥ 8.3 in both themes, well above the existing palette's
// own closest pairs; contrast 7.3:1 light, 8.0:1 dark. Proposed for reviewer
// validation per docs/adapters.md.
const WOOFI_VENUE: VenueMeta = {
  id: 'woofi',
  name: 'WOOFi sPMM',
  color: { light: '#00613A', dark: '#57B791' },
  kind: 'amm',
  role: 'venue',
  sinceUtc: '2025-12-01',
};

/** WooPPV2 (TransparentUpgradeableProxy, "WOOFi: Woo PP V2" on monadscan). */
export const WOOPP = '0x5520385bfcf07ec87c4c53a7d8d65595dff69fa4' as const;

/** The implementation every ABI below was resolved and verified against — the
 *  only one the proxy has ever had (its sole `Upgraded` is in the creation
 *  block). Any other implementation is announced so the ABIs get re-checked. */
const VERIFIED_IMPLEMENTATION = '0x6aebc663dd6b8de86129e671baf68586fb0c8fcc';

/** WOOFi's WooRouterV2 — the canonical address it uses on every chain, and its
 *  `wooPool()` is this pool. Takers that enter through it are WOOFi's own
 *  periphery; most Monad flow arrives through aggregators and searchers. */
const WOO_ROUTER = '0x4c4af8dbc524681930a27b2f1af5bcc8062e6fb7' as const;

/**
 * Every Wooracle this pool has priced from, oldest first. Each push is a
 * log-less `postStateList` call from WOOFi's keeper, so the gas tracker can
 * only sample blocks for txs sent to these (see gasSources). A rotated-out
 * oracle stays listed: dropping a destination rescans the venue's whole gas
 * series instead of just adding the new one.
 *
 *  - 0x2a3755…: from the pool's initialize until block 76,272,194
 *    (2026-05-22 13:43 UTC); keeper 0x03ac0b1b…, last push 2026-05-07.
 *  - 0xf9b0c8…: since then; keeper 0x33b12dd7….
 *
 * The switch happened while the pool was dark: paused and drained on
 * 2026-05-07, unpaused under a new owner on 2026-07-16. No swap landed in
 * between, so the dashboard's zero days there are real.
 */
const KNOWN_WOORACLES: readonly `0x${string}`[] = [
  '0x2a375567f5e13f6bd74fda7627df3b1af6bfa5a6',
  '0xf9b0c8ee13ae2fc0665764ecbdb417685dea8081',
];

/** The pool's quote token — fixed at initialize (WooPPV2 has no setter), and
 *  the unit of `swapVol`. Discovery fails loud if the chain says otherwise. */
const QUOTE: TokenInfo = TOKENS.USDC;

/** `tokenInfos(t).feeRate` is in 1e-5: 10 = 1bp. It was 25 for most of the
 *  pool's life (15 for a stretch), and those fills carry swapFee = 2.5 /
 *  1.5bps of swapVol exactly; it has been 0 on every listed token since the
 *  pause of 2026-08-31. */
const FEE_RATE_PER_BP = 10;

const wooppAbi = parseAbi([
  'function quoteToken() view returns (address)',
  'function wooracle() view returns (address)',
  'function tokenInfos(address) view returns (uint192 reserve, uint16 feeRate, uint128 maxGamma, uint128 maxNotionalSwap, uint192 capBal)',
  'function decimalInfo(address) view returns (uint64 priceDec, uint64 quoteDec, uint64 baseDec)',
  'function query(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)',
  // topic0 0x0e8e403c… — keccak-matched against the live logs.
  'event WooSwap(address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo, uint256 swapVol, uint256 swapFee)',
  'event Upgraded(address indexed implementation)',
]);
const event = (name: string) => wooppAbi.find((x: any) => x.type === 'event' && x.name === name)!;

export interface WoofiMarket {
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

/** Every registered pair whose two ERC-20s could meet in the pool, keyed on
 *  the unordered token pair (first PAIRS match wins, i.e. the canonical one).
 *  The swap event names both tokens, so this — not discovery — is the whole
 *  decode table: a fill never depends on a discovery read having succeeded. */
export function woofiMarkets(): Map<string, WoofiMarket> {
  const out = new Map<string, WoofiMarket>();
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

const MARKETS_BY_TOKENS = woofiMarkets();

/** The registered market for a swap's two tokens, in either direction. */
export function woofiMarketFor(tokenA: string, tokenB: string): WoofiMarket | undefined {
  return MARKETS_BY_TOKENS.get(pairKey(tokenA, tokenB));
}

/**
 * One WooSwap log → a Fill, or null when it is not a priceable trade on a
 * registered pair (skipped locally, never thrown: one odd log must not wedge
 * the tail). Pure, so the unit math is locked by fixture tests.
 *
 * usd: a stable-quoted pair's stable leg as transferred, like every other
 * venue. A crypto/crypto swap has no stable leg; its notional is the pool's
 * own USDC valuation, `swapVol` — exact, and unlike a CEX-priced leg it does
 * not move when a history replay runs at a later price.
 */
export function decodeWoofiSwap(log: any, ts: number): Fill | null {
  const args = log?.args;
  const txHash = String(log?.transactionHash ?? '');
  const logIndex = Number(log?.logIndex);
  if (String(log?.address ?? '').toLowerCase() !== WOOPP
    || String(log?.eventName ?? '') !== 'WooSwap'
    || !args || !/^0x[0-9a-fA-F]{64}$/.test(txHash)
    || !Number.isSafeInteger(logIndex) || logIndex < 0) return null;

  let fromAmount: bigint, toAmount: bigint, swapVol: bigint, blockNumber: bigint;
  try {
    fromAmount = BigInt(args.fromAmount);
    toAmount = BigInt(args.toAmount);
    swapVol = BigInt(args.swapVol);
    blockNumber = BigInt(log.blockNumber);
  } catch {
    return null;
  }
  if (fromAmount <= 0n || toAmount <= 0n || blockNumber <= 0n
    || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const fromToken = String(args.fromToken ?? '').toLowerCase();
  const toToken = String(args.toToken ?? '').toLowerCase();
  const m = woofiMarketFor(fromToken, toToken);
  if (!m) return null;

  const sellsBase = fromToken === m.base.address.toLowerCase();
  const baseAmount = fromUnits(sellsBase ? fromAmount : toAmount, m.base.decimals);
  const quoteAmount = fromUnits(sellsBase ? toAmount : fromAmount, m.quote.decimals);
  const usd = m.quote.stable ? quoteAmount : fromUnits(swapVol, QUOTE.decimals);
  if (!(baseAmount > 0) || !(quoteAmount > 0) || !(usd > 0)) return null;

  const side: Side = sellsBase ? 'sell' : 'buy';
  return {
    id: `woofi-${txHash.toLowerCase()}-${logIndex}`,
    venueId: WOOFI_VENUE.id,
    market: m.market,
    side,
    // attribution is the core's job (tx.to vs entryPoints / the aggregator
    // registry) — never guess DIRECT here.
    category: 'UNKNOWN',
    usd,
    baseAmount,
    execPx: quoteAmount / baseAmount, // realized quote-per-base, fee-inclusive
    txHash,
    to: shortHex(String(args.to ?? '0x')),
    pool: `woofi ${WOOPP.slice(0, 10)}`,
    blockNumber: Number(blockNumber),
    ts,
    markoutsBps: [null, null, null, null, null],
  };
}

interface QuoteMarket extends WoofiMarket {
  /** the swap's fee in bps — a crypto/crypto swap pays the higher of its two
   *  tokens' rates, once, on the USDC leg */
  feeBps: number;
}

interface QuoteLeg {
  market: QuoteMarket;
  sizeUsd: number;
  side: Side;
  amountIn: bigint;
  mid: number;
}

export function createWoofiAdapter(): VenueAdapter {
  /** markets whose two tokens are both listed — merged, never shrunk. */
  const quotable = new Map<string, QuoteMarket>();
  /** the oracle the pool reads now; null until discovery has read it. */
  let currentOracle: `0x${string}` | null = null;
  // Every leg reverting is venue-wide (paused, oracle infeasible, ABI drift),
  // not a thin market — name it instead of vanishing (venues/quote-health.ts).
  const reportOutage = createQuoteOutageReporter(WOOFI_VENUE.name);

  const refresh = async (ctx: AdapterContext) => {
    const blockNumber = await ctx.client.getBlockNumber();
    const [quoteToken, oracle] = await Promise.all([
      ctx.client.readContract({ address: WOOPP, abi: wooppAbi, functionName: 'quoteToken', blockNumber }),
      ctx.client.readContract({ address: WOOPP, abi: wooppAbi, functionName: 'wooracle', blockNumber }),
    ]) as [string, string];
    // swapVol (the crypto/crypto notional) is denominated in this token.
    if (quoteToken.toLowerCase() !== QUOTE.address.toLowerCase()) {
      throw new Error(`WOOFi quote token is ${quoteToken}, not ${QUOTE.symbol} — swapVol units unverified`);
    }

    // The pool's token list is a mapping, not enumerable: probe every
    // registered ERC-20. A token is listed when it has a swap cap — with
    // maxNotionalSwap = 0 every swap of it reverts.
    const candidates = Object.entries(TOKENS).filter(([, t]) =>
      t.address !== NATIVE_MON && t.address.toLowerCase() !== QUOTE.address.toLowerCase());
    const res = await ctx.client.multicall({
      contracts: candidates.flatMap(([, t]) => [
        { address: WOOPP, abi: wooppAbi, functionName: 'tokenInfos' as const, args: [t.address] as const },
        { address: WOOPP, abi: wooppAbi, functionName: 'decimalInfo' as const, args: [t.address] as const },
      ]),
      allowFailure: true,
      blockNumber,
    });
    const listed = new Map<string, number>([[QUOTE.address.toLowerCase(), 0]]); // address → feeBps
    for (let i = 0; i < candidates.length; i++) {
      const [key, token] = candidates[i];
      const info = res[i * 2], dec = res[i * 2 + 1];
      if (info.status !== 'success') throw new Error(`WOOFi tokenInfos(${key}) read failed`);
      const [, feeRate, , maxNotionalSwap] = info.result as readonly [bigint, number, bigint, bigint, bigint];
      if (maxNotionalSwap <= 0n) continue;
      // decimals are where adapter bugs live: the pool's own scale must match
      // the registry's, or every fill of this token is mis-sized.
      const [, quoteDec, baseDec] = dec.status === 'success' ? dec.result as readonly [bigint, bigint, bigint] : [0n, 0n, 0n];
      if (baseDec !== 10n ** BigInt(token.decimals) || quoteDec !== 10n ** BigInt(QUOTE.decimals)) {
        throw new Error(`WOOFi ${key} decimals mismatch (pool base 1e${String(baseDec).length - 1}, registry ${token.decimals})`);
      }
      listed.set(token.address.toLowerCase(), Number(feeRate) / FEE_RATE_PER_BP);
    }

    let found = 0;
    for (const m of MARKETS_BY_TOKENS.values()) {
      const baseFee = listed.get(m.base.address.toLowerCase());
      const quoteFee = listed.get(m.quote.address.toLowerCase());
      if (baseFee === undefined || quoteFee === undefined) continue;
      quotable.set(m.market, { ...m, feeBps: Math.max(baseFee, quoteFee) });
      found++;
    }
    if (!found) throw new Error('WOOFi discovered no registered markets');

    const o = oracle.toLowerCase() as `0x${string}`;
    if (!KNOWN_WOORACLES.includes(o)) {
      ctx.note('venue.upgraded', `WOOFi sPMM: the pool now prices off Wooracle ${shortHex(o)} — its pushes are tracked, but add it to KNOWN_WOORACLES so a later rotation cannot drop its burn history`);
    }
    currentOracle = o;
    ctx.note('venue.discovery', `WOOFi sPMM: ${found} registered market(s) across ${listed.size - 1} listed base token(s) at block ${blockNumber}`);
  };

  return {
    venues: () => [WOOFI_VENUE],
    quoteMarkets: () => [...quotable.keys()],
    // the pool's first WooSwap — see WOOFI_VENUE.
    backfillFromUtc: '2025-12-01',

    discover: refresh,

    async quote(ctx: AdapterContext, sizesUsd: readonly number[], blockNumber: bigint, markets?: ReadonlySet<string>): Promise<QuoteRow[]> {
      const calls: Array<{ address: typeof WOOPP; abi: typeof wooppAbi; functionName: 'query'; args: readonly [`0x${string}`, `0x${string}`, bigint] }> = [];
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
            calls.push({ address: WOOPP, abi: wooppAbi, functionName: 'query', args: [input.address, output.address, amountIn] });
            legs.push({ market: m, sizeUsd, side, amountIn, mid });
          }
        }
      }
      if (!calls.length) return [];

      const results = await ctx.client.multicall({ contracts: calls, allowFailure: true, blockNumber });
      if (reportOutage(ctx, results)) return [];

      // A leg the pool cannot fill REVERTS — InsufficientToToken (short
      // reserve), CapExceeded (the input would push its inventory past
      // capBal), or the per-token notional/gamma caps ($50k notional on every
      // token live) — and never returns a partial amount. So a surviving leg
      // is the full size, and a size past the caps simply has no row.
      const rows = new Map<string, QuoteRow>();
      const ts = Date.now();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status !== 'success') continue;
        const leg = legs[i];
        const out = r.result as bigint;
        if (out <= 0n) continue;
        const m = leg.market;
        const inH = fromUnits(leg.amountIn, leg.side === 'sell' ? m.base.decimals : m.quote.decimals);
        const outH = fromUnits(out, leg.side === 'sell' ? m.quote.decimals : m.base.decimals);
        if (inH <= 0 || outH <= 0) continue;
        const key = `${m.market}|${leg.sizeUsd}`;
        let row = rows.get(key);
        if (!row) {
          row = { venueId: WOOFI_VENUE.id, market: m.market, sizeUsd: leg.sizeUsd, bidPx: 0, askPx: 0, bidBps: 0, askBps: 0, spreadBps: 0, filledFull: true, feeBps: m.feeBps, ts };
          rows.set(key, row);
        }
        if (leg.side === 'sell') {
          row.bidPx = outH / inH;
          row.bidBps = (row.bidPx / leg.mid - 1) * 1e4;
        } else {
          row.askPx = inH / outH;
          row.askBps = (row.askPx / leg.mid - 1) * 1e4;
        }
      }
      const out: QuoteRow[] = [];
      for (const row of rows.values()) {
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
      return [{ key: 'pool', address: WOOPP, events: [event('WooSwap'), event('Upgraded')], kind: 'fills' as const }];
    },

    entryPoints: () => [{ address: WOOPP }, { address: WOO_ROUTER, router: 'WOOFi' }],

    // QUOTE_UPDATE_BURN: WOOFi's keeper pays for every Wooracle push, and the
    // pushes emit no logs, so blocks mode — sampled, shown with ≈. At ~10k
    // pushes a day (one every ~29 blocks, measured 2026-10-27) the default
    // 1000-block stride lands on a push ~10 times a day: a day's figure
    // carries ~±30% sampling noise, a week's ~±12%.
    gasSources() {
      if (!currentOracle) throw new Error('WOOFi Wooracle not resolved yet'); // hold the gas cursor
      return [{ mode: 'blocks' as const, address: [...new Set([...KNOWN_WOORACLES, currentOracle])] }];
    },

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      let upgraded = false;
      for (const log of logs.pool ?? []) {
        if (log?.eventName === 'Upgraded') {
          const impl = String(log?.args?.implementation ?? '').toLowerCase();
          if (impl === VERIFIED_IMPLEMENTATION) continue;
          // An ABI change is the one thing a refresh cannot absorb: a changed
          // WooSwap would match nothing and read exactly like a quiet venue.
          const label = /^0x[0-9a-f]{40}$/.test(impl) ? shortHex(impl) : 'an unreadable implementation';
          ctx.note('venue.upgraded', `WOOFi sPMM: proxy upgraded to ${label} — re-verify quote/fill ABIs against the new implementation`);
          upgraded = true;
          continue;
        }
        let blockNumber: bigint;
        try {
          blockNumber = BigInt(log?.blockNumber);
        } catch {
          continue;
        }
        const fill = decodeWoofiSwap(log, tsOf(blockNumber));
        if (fill) out.push(fill);
      }
      // Re-check the layout the decode relies on (a quote-token change throws
      // here, which holds the cursor on this range).
      if (upgraded) await refresh(ctx);
      return out;
    },
  };
}
