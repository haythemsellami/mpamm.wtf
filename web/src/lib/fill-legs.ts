import type { Fill } from '@shared';
import { fmtAmt } from './format';

/**
 * The IN/OUT legs of a fill, in each token's own units.
 *
 * A fill stores `usd`, `baseAmount` and `execPx` (quote units per base unit).
 * The quote amount is not stored, but `baseAmount × execPx` recovers it
 * exactly — that ratio is where execPx came from. Never build the legs from
 * `usd`: that treats the quote token as worth $1, which is wrong for pairs
 * quoted in a crypto asset (cbBTC/ETH, MON/ETH, …). A real 0.197-cbBTC fill
 * once rendered as "413.8827 cbBTC" that way (see fill-legs.test.ts).
 *
 * Direction matches the SIDE column (the taker's view): a BUY pays the quote
 * leg in and takes the base out; a SELL is the reverse.
 *
 * Fills flagged `pxApprox` have no real execPx/baseAmount, but they cannot
 * reach the leaderboard: their markouts are null and the list drops those.
 */
export function fillLegs(f: Pick<Fill, 'market' | 'side' | 'baseAmount' | 'execPx'>): { inAmt: string; outAmt: string } {
  const [baseSym, quoteSym] = f.market.split('/');
  const base = `${fmtAmt(f.baseAmount)} ${baseSym}`;
  const quote = `${fmtAmt(f.baseAmount * f.execPx)} ${quoteSym}`;
  return f.side === 'buy' ? { inAmt: quote, outAmt: base } : { inAmt: base, outAmt: quote };
}
