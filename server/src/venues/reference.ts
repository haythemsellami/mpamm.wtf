import type { QuoteRow, VenueMeta, Pair } from '@shared';
import { PAIRS, TOKENS, ASSETS, assetOf, pairOf, cexForBase, wrapBasisFor } from '@shared';
import { config } from '../config.js';
import { BybitFeed } from '../bybit.js';
import { BinanceFeed } from '../binance.js';
import type { ReferenceRegistry } from './adapter.js';

/** The CEX benchmark venues (role: 'reference'). Their per-theme color is the
 *  single source of truth the frontend reads. Each name carries its FEE TIER —
 *  both benchmarks are advanced-trader tiers (each exchange's top published
 *  spot tier), not retail, and the display name should say so everywhere
 *  (chips, legend, captions) rather than imply retail fees. */
const BYBIT_VENUE: VenueMeta = { id: 'bybit', name: 'Bybit (Supreme VIP)', color: { light: '#8A8375', dark: '#B9BCC6' }, kind: 'cex', role: 'reference', taker: true };
const BINANCE_VENUE: VenueMeta = { id: 'binance', name: 'Binance (VIP9)', color: { light: '#B58A1B', dark: '#F0B90B' }, kind: 'cex', role: 'reference', taker: true };

/**
 * The CEX reference registry: Bybit (MON) + Binance (BTC/ETH, VIP9 taker),
 * routed per base asset via the @shared ASSETS registry.
 *
 * The reference for a pair is expressed IN THE PAIR'S OWN TERMS (docs/architecture.md: pair-terms reference) —
 * two unit conversions on top of the deep `<BASE>USDT` book, both from live CEX
 * crosses (never assumed):
 *
 *   refPx(pair) = baseUSDT px × wrapBasis(pair) ÷ quoteLeg(pair)
 *
 *  - wrapBasis: the on-chain asset may be a WRAPPED representation, resolved PER
 *    PAIR (wrapBasisFor): WBTC trades at a real basis to native (Binance WBTCBTC,
 *    ~−5bps live) — without it every venue shows a fake wrapped-discount "edge";
 *    cbBTC has NO CEX basis pair, so its pairs override to parity (UI caveat).
 *  - quoteLeg, stable-quoted pairs (default): on-chain quotes are in the pair's
 *    stable (USDC), the CEX book is USDT — USDC/USDT is a real market (~+10bps
 *    live), not 1.0000. The cross is taken on the SAME exchange as the base feed.
 *    A stable with no cross (USDT0 ≡ USDT exactly; AUSD unlisted) falls back to
 *    1 — and an unwarm cross also falls back to 1 rather than zeroing the
 *    reference.
 *  - quoteLeg, ASSET-quoted pairs (quoteKind 'asset', e.g. MON/ETH): the quote
 *    asset's own USDT mid from ITS exchange — a SYNTHETIC cross that may span
 *    two exchanges (Bybit MON ÷ Binance ETH). Unlike a stable cross, an unwarm
 *    asset leg makes the pair UNAVAILABLE (never a $1 fallback — that would be
 *    off by orders of magnitude, not bps).
 *
 * Taker walks stay on the deep base-asset USDT book; realized prices are
 * converted by the same factors at the leg MIDS (each leg's book is ~1bp wide,
 * so converting at mid adds <1bp — far smaller than the basis it removes).
 */
export function createReferenceRegistry(): ReferenceRegistry {
  // cross symbols per exchange: every stable cross needed by that exchange's
  // pairs, derived from the registries (nothing hardcoded here). Asset-quoted
  // pairs need no extra subscriptions — their quote leg is another asset's own
  // base feed, which is already maintained below.
  const stableQuoted = PAIRS.filter((p) => p.quoteKind !== 'asset');
  const bybitCrosses = [...new Set(stableQuoted
    .filter((p) => cexForBase(p.base) === 'bybit')
    .map((p) => TOKENS[p.quote]?.usdtCross)
    .filter((s): s is string => !!s))];
  const binanceCrosses = [...new Set(stableQuoted
    .filter((p) => cexForBase(p.base) === 'binance')
    .map((p) => TOKENS[p.quote]?.usdtCross)
    .filter((s): s is string => !!s))];
  // wrap symbols per PAIR (overrides included) — a parity-override pair ('')
  // simply contributes nothing.
  const wrapSymbols = [...new Set(PAIRS.map(wrapBasisFor).filter((s): s is string => !!s))];
  const baseSymbols = [...new Set(Object.values(ASSETS).filter((a) => a.cex === 'binance').map((a) => a.cexSymbol))];

  const bybit = new BybitFeed(bybitCrosses); // MONUSDT book + cross tickers
  // Binance: base books + stable crosses + wrap-basis symbols (mid-only use for
  // the latter two; the feed maintains small books for them, which is fine).
  const binance = new BinanceFeed([...baseSymbols, ...binanceCrosses, ...wrapSymbols]);

  /** raw USDT-terms mid of a base asset from its CEX. */
  const baseUsdtMid = (base: string): number => {
    const a = assetOf(base);
    if (!a) return 0;
    return a.cex === 'binance' ? binance.mid(a.cexSymbol) : bybit.mid();
  };
  /** wrapped/native factor for a PAIR (1 when parity/not-adjusted or not warm). */
  const wrapFactor = (pair: Pair): number => {
    const sym = wrapBasisFor(pair);
    if (!sym) return 1;
    const m = binance.mid(sym);
    return m > 0 ? m : 1;
  };
  /** the pair's quote leg in USDT terms:
   *   - stable quote → USDT cross factor (1 when ≡USDT, unlisted, or not warm);
   *   - asset quote  → the quote asset's own USDT mid (0 when unwarm — a $1
   *     fallback would be wrong by orders of magnitude, so 0 = unavailable). */
  const quoteLeg = (pair: Pair): number => {
    if (pair.quoteKind === 'asset') {
      const m = baseUsdtMid(pair.quote);
      return m > 0 ? m : 0;
    }
    const sym = TOKENS[pair.quote]?.usdtCross;
    if (!sym) return 1; // ≡ USDT by design (USDT0), not "unavailable"
    const m = cexForBase(pair.base) === 'binance' ? binance.mid(sym) : bybit.crossMid(sym);
    // unwarm cross ⇒ the pair is UNAVAILABLE (mid 0, quotes/markouts skip) —
    // falling back to 1 would anchor to raw USDT, the exact ~10bps error the
    // pair-terms construction exists to remove.
    return m > 0 ? m : 0;
  };
  /** full pair conversion: USDT terms → the pair's own (wrapped, quote) terms.
   *  0 = unavailable (asset quote leg not warm). */
  const pairFactor = (pair: Pair): number => {
    const q = quoteLeg(pair);
    return q > 0 ? wrapFactor(pair) / q : 0;
  };

  return {
    async start() { await bybit.start(); await binance.start(); },
    stop() { bybit.stop(); binance.stop(); },
    metas: () => [BYBIT_VENUE, BINANCE_VENUE],
    refVenueIdForBase: (base) => cexForBase(base),
    assetUsd: (base) => baseUsdtMid(base), // USDT ≈ $1 — sizing/header only
    midForPair(market) {
      const pair = pairOf(market);
      if (!pair) return 0;
      const mid = baseUsdtMid(pair.base);
      const factor = pairFactor(pair);
      return mid > 0 && factor > 0 ? mid * factor : 0;
    },
    changePctFor(base) {
      const a = assetOf(base);
      if (!a) return 0;
      return a.cex === 'binance' ? binance.changePct(a.cexSymbol) : bybit.changePct();
    },
    quote(sizesUsd, markets) {
      const rows: QuoteRow[] = [];
      const ts = Date.now();
      for (const pair of PAIRS) {
        if (markets && !markets.has(pair.symbol)) continue;
        const a = assetOf(pair.base);
        if (!a) continue;
        const usdtMid = baseUsdtMid(pair.base);
        if (usdtMid <= 0) continue; // feed not warm yet — no benchmark row
        const factor = pairFactor(pair);
        if (factor <= 0) continue; // asset quote leg not warm — no benchmark row
        const pxMid = usdtMid * factor; // the pair-terms mid (bps anchor)
        const isBinance = a.cex === 'binance';
        const feeBps = isBinance ? config.binanceTakerBps : config.takerBps;
        const fee = feeBps / 1e4;
        const venueId = isBinance ? BINANCE_VENUE.id : BYBIT_VENUE.id;
        for (const size of sizesUsd) {
          const base = size / usdtMid; // sizing in USDT≈USD terms
          const buy = isBinance ? binance.walk(a.cexSymbol, 'buy', base) : bybit.walk('buy', base);
          const sell = isBinance ? binance.walk(a.cexSymbol, 'sell', base) : bybit.walk('sell', base);
          // realized walk prices converted into the pair's terms by the same factor
          const askPx = buy.price * factor * (1 + fee);
          const bidPx = sell.price * factor * (1 - fee);
          rows.push({
            venueId, market: pair.symbol, sizeUsd: size,
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
