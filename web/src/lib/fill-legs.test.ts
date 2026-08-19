import { describe, expect, it } from 'vitest';
import { fillLegs, tokenDecimals } from './fill-legs';

describe('fillLegs', () => {
  it('renders the stored baseAmount and the quote leg derived from it', () => {
    // A real Hanji fill, checked against the raw on-chain log (log index 23):
    // 0xa434d5bbabeeefb16b3e20deb9a2014dc0a410dcb18013069111925ce4428ca8
    // (block 97379718): aggressive_shares 19710391 at 1e-8 is 0.19710391
    // cbBTC, aggressive_value 6504111526424 at 1e-12 is 6.504111526424 ETH.
    // The old usd-based math showed it as 413.8827 cbBTC in / 13.66k ETH
    // out — both legs scaled up by the dollar price of ETH.
    const legs = fillLegs({ market: 'cbBTC/ETH', side: 'sell', baseAmount: 0.19710391, execPx: 32.998389156379496 });
    // BOTH legs are the exact on-chain amounts, to the last digit.
    expect(legs.in.amt).toBe('0.19710391 cbBTC');
    expect(legs.out.amt).toBe('6.504111526424 ETH');
  });

  it('follows the taker direction: a BUY pays quote in and takes base out', () => {
    // A second real fill from the same book (log index 28):
    // 0x7e4b29d4f1fffb3942f6a62ab55f99cef6a0ecd24867a4044262e99a67cc7a5e
    // (block 97379790): shares 7285608 → 0.07285608 cbBTC, value 2405942196246
    // → 2.405942196246 ETH. Both render exactly as they traded.
    const sell = fillLegs({ market: 'cbBTC/ETH', side: 'sell', baseAmount: 0.07285608, execPx: 33.023217777376985 });
    const buy = fillLegs({ market: 'cbBTC/ETH', side: 'buy', baseAmount: 0.07285608, execPx: 33.023217777376985 });
    expect(sell.in.amt).toBe('0.07285608 cbBTC');
    expect(sell.out.amt).toBe('2.405942196246 ETH');
    expect(buy.in.amt).toBe('2.405942196246 ETH');
    expect(buy.out.amt).toBe('0.07285608 cbBTC');
  });

  it('rounds the derived quote leg to the token’s decimals, hiding float drift', () => {
    // baseAmount × execPx recovers 6.5041115264239995 for a leg that traded
    // 6.504111526424 on-chain — 9e-16 out. Rendering at ETH's decimals rounds
    // that away instead of printing the drift as if it were precision.
    expect(String(0.19710391 * 32.998389156379496)).toBe('6.5041115264239995');
    expect(fillLegs({ market: 'cbBTC/ETH', side: 'sell', baseAmount: 0.19710391, execPx: 32.998389156379496 }).out.amt)
      .toBe('6.504111526424 ETH');
  });

  it('leaves dollar-quoted pairs unchanged: their quote leg is the dollar amount', () => {
    // MON/USDC — the quote is a dollar, so baseAmount × execPx equals usd.
    const legs = fillLegs({ market: 'MON/USDC', side: 'sell', baseAmount: 259_980, execPx: 0.020425 });
    expect(legs.in.amt).toBe('259.98k MON');
    expect(legs.out.amt).toBe('5.31k USDC');
  });

  it('carries the full figure for a compacted cell, so nothing is hidden', () => {
    // The column reads "259.98k MON"; the tooltip is the whole number.
    const legs = fillLegs({ market: 'MON/USDC', side: 'sell', baseAmount: 259_980, execPx: 0.020425 });
    expect(legs.in.full).toBe('259980 MON');
    expect(legs.out.full).toBe('5310.0915 USDC'); // 259980 × 0.020425, at USDC's 6dp
  });
});

describe('tokenDecimals', () => {
  it('resolves every symbol a market can name', () => {
    expect(tokenDecimals('cbBTC')).toBe(8);
    expect(tokenDecimals('WBTC')).toBe(8);
    expect(tokenDecimals('BTC')).toBe(8); // asset symbol → its wrapper
    expect(tokenDecimals('ETH')).toBe(18);
    expect(tokenDecimals('MON')).toBe(18);
    expect(tokenDecimals('USDC')).toBe(6);
    expect(tokenDecimals('USDT0')).toBe(6);
    expect(tokenDecimals('AUSD')).toBe(6);
    expect(tokenDecimals('USD1')).toBe(18);
  });

  it('returns undefined for an unknown symbol rather than guessing', () => {
    expect(tokenDecimals('NOPE')).toBeUndefined();
  });
});
