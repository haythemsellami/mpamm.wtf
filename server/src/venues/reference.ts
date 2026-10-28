import type { QuoteRow, VenueMeta, Pair } from '@shared';
import { PAIRS, TOKENS, ASSETS, assetOf, pairOf, cexForBase, wrapBasisFor } from '@shared';
import { config } from '../config.js';
import { BybitFeed } from '../bybit.js';
import { BinanceFeed } from '../binance.js';
import { KrakenFeed } from '../kraken.js';
import type { ReferenceRegistry } from './adapter.js';

// Published advanced-trader tiers; the name carries the fee assumption into
// every chip/legend. Kraken xStocks have their own schedule, not crypto fees.
const BYBIT_VENUE: VenueMeta = { id: 'bybit', name: 'Bybit (Supreme VIP)', color: { light: '#8A8375', dark: '#B9BCC6' }, kind: 'cex', role: 'reference', taker: true };
const BINANCE_VENUE: VenueMeta = { id: 'binance', name: 'Binance (VIP9)', color: { light: '#B58A1B', dark: '#F0B90B' }, kind: 'cex', role: 'reference', taker: true };
const KRAKEN_VENUE: VenueMeta = { id: 'kraken', name: 'Kraken Pro xStocks ($1B+)', color: { light: '#B34400', dark: '#FFD0AC' }, kind: 'cex', role: 'reference', taker: true };

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

  const rawMid = (base: string): number => {
    const a = assetOf(base);
    if (!a) return 0;
    return a.cex === 'kraken' ? kraken.mid(a.cexSymbol) : a.cex === 'binance' ? binance.mid(a.cexSymbol) : bybit.mid();
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
    metas: () => [BYBIT_VENUE, BINANCE_VENUE, KRAKEN_VENUE],
    refVenueIdForBase: (base) => cexForBase(base),
    assetUsd: (base) => rawMid(base), // Kraken is USD; crypto sizing keeps USDT≈$1
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
      if (!a) return 0;
      return a.cex === 'kraken' ? kraken.changePct(a.cexSymbol) : a.cex === 'binance' ? binance.changePct(a.cexSymbol) : bybit.changePct();
    },
    quote(sizesUsd, markets) {
      const rows: QuoteRow[] = [];
      const ts = Date.now();
      for (const pair of PAIRS) {
        if (markets && !markets.has(pair.symbol)) continue;
        const a = assetOf(pair.base);
        if (!a) continue;
        const mid = rawMid(pair.base), factor = pairFactor(pair);
        if (mid <= 0 || factor <= 0) continue;
        const pxMid = mid * factor;
        const feeBps = a.cex === 'kraken' ? config.krakenXstockTakerBps : a.cex === 'binance' ? config.binanceTakerBps : config.takerBps;
        const fee = feeBps / 1e4;
        for (const size of sizesUsd) {
          const base = size / mid;
          const walk = (side: 'buy' | 'sell') => a.cex === 'kraken' ? kraken.walk(a.cexSymbol, side, base)
            : a.cex === 'binance' ? binance.walk(a.cexSymbol, side, base) : bybit.walk(side, base);
          const buy = walk('buy'), sell = walk('sell');
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
