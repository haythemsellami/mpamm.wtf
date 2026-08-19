import { describe, expect, it } from 'vitest';
import { fillLegs } from './fill-legs';

describe('fillLegs', () => {
  it('renders the stored baseAmount and the quote leg derived from it', () => {
    // A real Hanji fill, checked against the raw on-chain log (log index 23):
    // 0xa434d5bbabeeefb16b3e20deb9a2014dc0a410dcb18013069111925ce4428ca8
    // (block 97379718): 0.19710391 cbBTC traded for 6.5041 ETH (~$13.66k).
    // The old usd-based math showed it as 413.8827 cbBTC in / 13.66k ETH
    // out — both legs scaled up by the dollar price of ETH.
    const legs = fillLegs({ market: 'cbBTC/ETH', side: 'sell', baseAmount: 0.19710391, execPx: 32.998389156379496 });
    expect(legs).toEqual({ inAmt: '0.1971 cbBTC', outAmt: '6.5041 ETH' });
  });

  it('follows the taker direction: a BUY pays quote in and takes base out', () => {
    // A second real fill from the same book (log index 28):
    // 0x7e4b29d4f1fffb3942f6a62ab55f99cef6a0ecd24867a4044262e99a67cc7a5e
    // (block 97379790): 0.07285608 cbBTC ↔ 2.4059 ETH.
    // The base leg reads 0.07286, not 0.0729, since fmtAmt moved to
    // significant digits — 4 of them below 0.1 rather than a flat 4dp, which
    // is strictly closer to the on-chain 0.07285608.
    const sell = fillLegs({ market: 'cbBTC/ETH', side: 'sell', baseAmount: 0.07285608, execPx: 33.023217777376985 });
    const buy = fillLegs({ market: 'cbBTC/ETH', side: 'buy', baseAmount: 0.07285608, execPx: 33.023217777376985 });
    expect(sell).toEqual({ inAmt: '0.07286 cbBTC', outAmt: '2.4059 ETH' });
    expect(buy).toEqual({ inAmt: '2.4059 ETH', outAmt: '0.07286 cbBTC' });
  });

  it('leaves dollar-quoted pairs unchanged: their quote leg is the dollar amount', () => {
    // MON/USDC — the quote is a dollar, so baseAmount × execPx equals usd.
    const legs = fillLegs({ market: 'MON/USDC', side: 'sell', baseAmount: 259_980, execPx: 0.020425 });
    expect(legs).toEqual({ inAmt: '259.98k MON', outAmt: '5.31k USDC' });
  });
});
