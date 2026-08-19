import type { Fill } from '@shared';
import { ASSETS, TOKENS, baseTokenOf } from '@shared';
import { fmtAmt, fmtAmtFull } from './format';

/**
 * The on-chain decimals of a market-symbol leg ('cbBTC' → 8, 'MON' → 18).
 *
 * Resolved through the @shared registry rather than a local table so a new
 * token cannot silently format at the wrong precision: TOKENS carries the
 * wrappers by symbol, and a market symbol that names an ASSET instead ('BTC',
 * 'ETH') routes to that asset's wrapper. Verified to resolve every symbol in
 * MARKETS. `undefined` degrades to significant-digit formatting, never to a
 * wrong number of digits.
 */
export function tokenDecimals(sym: string): number | undefined {
  const t = Object.values(TOKENS).find((x) => x.symbol === sym);
  if (t) return t.decimals;
  const asset = ASSETS[sym];
  return asset ? baseTokenOf(asset.key)?.decimals : undefined;
}

/**
 * The IN/OUT legs of a fill, in each token's own units, with the exact figure
 * for a tooltip alongside the display string.
 *
 * A fill stores `usd`, `baseAmount` and `execPx` (quote units per base unit).
 * Never build the legs from `usd`: that treats the quote token as worth $1,
 * which is wrong for pairs quoted in a crypto asset (cbBTC/ETH, MON/ETH, …).
 * A real 0.197-cbBTC fill once rendered as "413.8827 cbBTC" that way.
 *
 * PRECISION. The base leg is a stored on-chain amount, so it is rendered at the
 * token's own decimals — 0.07285608 cbBTC is shown as traded, not rounded to
 * 0.07286. The quote leg is DERIVED (`baseAmount × execPx`) and therefore only
 * near-exact: on a real cbBTC/ETH fill it recovers 6.5041115264239995 against
 * an on-chain 6.504111526424, off by 9e-16. Rendering it at the quote token's
 * decimals rounds that error away rather than displaying it. Neither leg can be
 * better than `Fill`'s JSON numbers — an 18-decimal amount above ~15 digits is
 * already lossy before it reaches the client.
 *
 * Direction matches the SIDE column (the taker's view): a BUY pays the quote
 * leg in and takes the base out; a SELL is the reverse.
 *
 * Fills flagged `pxApprox` have no real execPx/baseAmount, but they cannot
 * reach the leaderboard: their markouts are null and the list drops those.
 */
export interface FillLeg { amt: string; full: string }

export function fillLegs(f: Pick<Fill, 'market' | 'side' | 'baseAmount' | 'execPx'>): { in: FillLeg; out: FillLeg } {
  const [baseSym, quoteSym] = f.market.split('/');
  const baseDec = tokenDecimals(baseSym), quoteDec = tokenDecimals(quoteSym);
  const quoteAmount = f.baseAmount * f.execPx;
  const base: FillLeg = {
    amt: `${fmtAmt(f.baseAmount, baseDec)} ${baseSym}`,
    full: `${fmtAmtFull(f.baseAmount, baseDec)} ${baseSym}`,
  };
  const quote: FillLeg = {
    amt: `${fmtAmt(quoteAmount, quoteDec)} ${quoteSym}`,
    full: `${fmtAmtFull(quoteAmount, quoteDec)} ${quoteSym}`,
  };
  return f.side === 'buy' ? { in: quote, out: base } : { in: base, out: quote };
}
