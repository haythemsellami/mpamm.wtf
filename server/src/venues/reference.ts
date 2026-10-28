import type { CexId, QuoteRow, VenueMeta, Pair } from '@shared';
import { PAIRS, TOKENS, ASSETS, assetOf, pairOf, cexForBase, wrapBasisFor } from '@shared';
import { config } from '../config.js';
import { BybitFeed, type WalkResult } from '../bybit.js';
import { BinanceFeed } from '../binance.js';
import { KrakenFeed } from '../kraken.js';
import type { ReferenceRegistry } from './adapter.js';

// Published advanced-trader tiers; the name carries the fee assumption into
// every chip/legend. Kraken xStocks have their own schedule, not crypto fees.
const BYBIT_VENUE: VenueMeta = { id: 'bybit', name: 'Bybit (Supreme VIP)', color: { light: '#8A8375', dark: '#B9BCC6' }, kind: 'cex', role: 'reference', taker: true };
const BINANCE_VENUE: VenueMeta = { id: 'binance', name: 'Binance (VIP9)', color: { light: '#B58A1B', dark: '#F0B90B' }, kind: 'cex', role: 'reference', taker: true };
// color: bronze / peach, one orange family across themes. Validated against
// every venue + reference colour and the theme green/red, ΔE2000 in normal and
// Machado protan/deutan/tritan: nearest 9.5 light (Uniswap v4 and WOOFi,
// deutan) and 9.1 dark (Binance, tritan). Contrast 10.7 / 9.6 on the light
// surfaces, 13.9 / 14.1 on the dark. The first pick, #B34400, was ΔE 0.8 from
// Uniswap v4 under protanopia.
const KRAKEN_VENUE: VenueMeta = { id: 'kraken', name: 'Kraken Pro xStocks ($1B+)', color: { light: '#503714', dark: '#FFD0AC' }, kind: 'cex', role: 'reference', taker: true };

/** Pair-terms references: base book × base wrapper / quote asset / quote
 * wrapper. Crypto books are in USDT; Kraken xStocks are in USD. Crossing the
 * two requires the live USDT/USD book. Stable quotes use their own exchange's
 * cross; an unavailable required leg makes the reference unavailable.
 *
 * Walks consume the base book, then convert at cross-leg mids, consistently
 * with existing crypto benchmarks. These are synthetic comparisons, not the
 * cost of executing every leg of a cross-asset hedge. cbBTC retains the
 * explicit parity assumption because there is no traded cbBTC/BTC basis.
 */
export function createReferenceRegistry(): ReferenceRegistry {
  const stableQuoted = PAIRS.filter((p) => p.quoteKind !== 'asset');
  const crosses = (cex: 'bybit' | 'binance') => [...new Set(stableQuoted
    .filter((p) => cexForBase(p.base) === cex).map((p) => TOKENS[p.quote]?.usdtCross)
    .filter((s): s is string => !!s))];
  const wrapSymbols = [...new Set(PAIRS.flatMap((p) => [wrapBasisFor(p), p.quoteWrapBasisSymbol]).filter((s): s is string => !!s))];
  const symbols = (cex: 'binance' | 'kraken') => Object.values(ASSETS).filter((a) => a.cex === cex).map((a) => a.cexSymbol);
  const bybit = new BybitFeed(crosses('bybit'));
  const binance = new BinanceFeed([...new Set([...symbols('binance'), ...crosses('binance'), ...wrapSymbols])]);
  const kraken = new KrakenFeed([...new Set([...symbols('kraken'), 'USDT/USD',
    ...stableQuoted.filter((p) => cexForBase(p.base) === 'kraken').map((p) => TOKENS[p.quote]?.usdCross).filter((s): s is string => !!s)])]);

  /** One row per CEX: a base asset's book, walk, 24h change and taker fee are
   *  a lookup by its `cex`. Adding a CEX adds a row here instead of a branch
   *  at each call site, where a missed one silently fell through to Bybit's
   *  MON book. Bybit's feed is the MON book alone, so it ignores the symbol. */
  const feeds: Record<CexId, {
    mid(symbol: string): number;
    walk(symbol: string, side: 'buy' | 'sell', baseSize: number): WalkResult;
    changePct(symbol: string): number;
    feeBps(): number;
  }> = {
    bybit: { mid: () => bybit.mid(), walk: (_s, side, size) => bybit.walk(side, size), changePct: () => bybit.changePct(), feeBps: () => config.takerBps },
    binance: { mid: (s) => binance.mid(s), walk: (s, side, size) => binance.walk(s, side, size), changePct: (s) => binance.changePct(s), feeBps: () => config.binanceTakerBps },
    kraken: { mid: (s) => kraken.mid(s), walk: (s, side, size) => kraken.walk(s, side, size), changePct: (s) => kraken.changePct(s), feeBps: () => config.krakenXstockTakerBps },
  };

  const rawMid = (base: string): number => {
    const a = assetOf(base);
    return a ? feeds[a.cex].mid(a.cexSymbol) : 0;
  };
  const wrapFactor = (pair: Pair): number => {
    const sym = wrapBasisFor(pair);
    if (!sym) return 1;
    const m = binance.mid(sym);
    return m > 0 ? m : 1; // existing base-wrapper cold-start convention
  };
  const quoteLeg = (pair: Pair): number => {
    const usdBase = cexForBase(pair.base) === 'kraken';
    if (pair.quoteKind === 'asset') {
      let m = rawMid(pair.quote);
      const usdQuote = cexForBase(pair.quote) === 'kraken';
      if (usdBase !== usdQuote) {
        const usdtUsd = kraken.mid('USDT/USD');
        if (usdtUsd <= 0) return 0;
        m = usdBase ? m * usdtUsd : m / usdtUsd;
      }
      if (pair.quoteWrapBasisSymbol) {
        const wrap = binance.mid(pair.quoteWrapBasisSymbol);
        if (wrap <= 0) return 0;
        m *= wrap;
      }
      return m > 0 ? m : 0;
    }
    if (usdBase) {
      const sym = TOKENS[pair.quote]?.usdCross;
      return sym ? kraken.mid(sym) : 0;
    }
    const sym = TOKENS[pair.quote]?.usdtCross;
    if (!sym) return 1; // USDT0 parity; existing AUSD approximation for crypto
    const m = cexForBase(pair.base) === 'binance' ? binance.mid(sym) : bybit.crossMid(sym);
    return m > 0 ? m : 0;
  };
  const pairFactor = (pair: Pair): number => {
    const q = quoteLeg(pair);
    return q > 0 ? wrapFactor(pair) / q : 0;
  };

  return {
    async start() { await Promise.all([bybit.start(), binance.start(), kraken.start()]); },
    stop() { bybit.stop(); binance.stop(); kraken.stop(); },
    metas: () => [BYBIT_VENUE, BINANCE_VENUE, KRAKEN_VENUE].map((v) => ({ ...v, takerBps: feeds[v.id as CexId].feeBps() })),
    refVenueIdForBase: (base) => cexForBase(base),
    assetUsd: (base) => rawMid(base), // Kraken is USD; crypto sizing keeps USDT≈$1
    marketClosed(base) {
      const a = assetOf(base);
      return a?.cex === 'kraken' ? kraken.marketClosed(a.cexSymbol) : false;
    },
    settledUsd(base) {
      const a = assetOf(base);
      return a?.cex === 'kraken' ? kraken.settledMid(a.cexSymbol) : rawMid(base);
    },
    midForPair(market) {
      const pair = pairOf(market);
      if (!pair) return 0;
      const mid = rawMid(pair.base), factor = pairFactor(pair);
      return mid > 0 && factor > 0 ? mid * factor : 0;
    },
    changePctFor(base) {
      const a = assetOf(base);
      return a ? feeds[a.cex].changePct(a.cexSymbol) : 0;
    },
    quote(sizesUsd, markets) {
      const rows: QuoteRow[] = [];
      const ts = Date.now();
      // A base's walk depends on its book and the size alone, not on the
      // pair's quote side, and no feed can move during this synchronous call.
      // Walk once per base x size and convert per pair: an xStock with ~10
      // quote pairs was walked (and its book sorted) ~10 times per size.
      const walks = new Map<string, { buy: WalkResult; sell: WalkResult }>();
      for (const pair of PAIRS) {
        if (markets && !markets.has(pair.symbol)) continue;
        const a = assetOf(pair.base);
        if (!a) continue;
        const mid = rawMid(pair.base), factor = pairFactor(pair);
        if (mid <= 0 || factor <= 0) continue;
        const pxMid = mid * factor;
        const feed = feeds[a.cex];
        const feeBps = feed.feeBps();
        const fee = feeBps / 1e4;
        for (const size of sizesUsd) {
          const walkKey = `${a.key}|${size}`;
          let walked = walks.get(walkKey);
          if (!walked) {
            const base = size / mid;
            walked = { buy: feed.walk(a.cexSymbol, 'buy', base), sell: feed.walk(a.cexSymbol, 'sell', base) };
            walks.set(walkKey, walked);
          }
          const { buy, sell } = walked;
          const askPx = buy.price * factor * (1 + fee), bidPx = sell.price * factor * (1 - fee);
          rows.push({
            venueId: a.cex, market: pair.symbol, sizeUsd: size,
            askPx, bidPx, askBps: (askPx / pxMid - 1) * 1e4, bidBps: (bidPx / pxMid - 1) * 1e4,
            spreadBps: ((askPx - bidPx) / pxMid) * 1e4,
            filledFull: buy.filledFull && sell.filledFull, feeBps, ts,
          });
        }
      }
      return rows;
    },
  };
}
