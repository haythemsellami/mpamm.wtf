// The CEX taker walk, pinned per feed before the three copies became one
// helper (walkLevels). Each case is hand-computed from the book. The feeds
// differ in one deliberate way: when nothing fills, Bybit/Binance report the
// mid and Kraken reports 0.
import { describe, expect, it } from 'vitest';
import { BybitFeed, walkLevels } from '../bybit.js';
import { BinanceFeed } from '../binance.js';

// asks 10.0 x 2, 10.5 x 3, 11.0 x 1 · bids 9.5 x 1, 9.0 x 4 (inserted out of order)
const ASKS: Array<[number, number]> = [[10.5, 3], [10, 2], [11, 1]];
const BIDS: Array<[number, number]> = [[9, 4], [9.5, 1]];

function bybit(fresh = true): BybitFeed {
  const f = new BybitFeed([]) as any;
  f.asks = new Map(ASKS); f.bids = new Map(BIDS);
  f.bestAsk = 10; f.bestBid = 9.5;
  f.lastMsgTs = fresh ? Date.now() : 0;
  return f;
}
function binance(fresh = true): BinanceFeed {
  const f = new BinanceFeed(['BTCUSDT']) as any;
  f.books.set('BTCUSDT', { asks: new Map(ASKS), bids: new Map(BIDS), bestAsk: 10, bestBid: 9.5, last: 0, chgPct: 0 });
  f.lastMsgTs = fresh ? Date.now() : 0;
  return f;
}

describe('CEX book walk', () => {
  it('walks asks up and bids down, VWAP of what filled', () => {
    // buy 4: 2 @ 10 + 2 @ 10.5 = 41 → 10.25 · sell 3: 1 @ 9.5 + 2 @ 9 = 27.5 → 9.1666…
    for (const f of [bybit(), binance()] as any[]) {
      const walk = (side: 'buy' | 'sell', n: number) => (f instanceof BybitFeed ? f.walk(side, n) : f.walk('BTCUSDT', side, n));
      expect(walk('buy', 4)).toEqual({ price: 10.25, filledBase: 4, filledFull: true });
      expect(walk('sell', 3)).toEqual({ price: 27.5 / 3, filledBase: 3, filledFull: true });
      // past the book: 6 of 10 fill (2@10 + 3@10.5 + 1@11 = 62.5) and it says so
      expect(walk('buy', 10)).toEqual({ price: 62.5 / 6, filledBase: 6, filledFull: false });
      // nothing to fill: the mid, not 0
      expect(walk('buy', 0)).toEqual({ price: 9.75, filledBase: 0, filledFull: false });
    }
  });

  it('serves nothing from a stale book, or an unknown symbol', () => {
    expect(bybit(false).walk('buy', 1)).toEqual({ price: 0, filledBase: 0, filledFull: false });
    expect(binance(false).walk('BTCUSDT', 'buy', 1)).toEqual({ price: 0, filledBase: 0, filledFull: false });
    expect(binance().walk('ETHUSDT', 'buy', 1)).toEqual({ price: 0, filledBase: 0, filledFull: false });
  });
});

describe('walkLevels', () => {
  it('takes best-first levels until the size is filled', () => {
    expect(walkLevels([[10, 2], [10.5, 3]], 4, 0)).toEqual({ price: 10.25, filledBase: 4, filledFull: true });
    expect(walkLevels([[10, 2]], 3, 0)).toEqual({ price: 10, filledBase: 2, filledFull: false });
  });
  it('returns the fallback price when nothing fills', () => {
    expect(walkLevels([], 1, 9.75)).toEqual({ price: 9.75, filledBase: 0, filledFull: false });
    expect(walkLevels([[10, 2]], 0, 0)).toEqual({ price: 0, filledBase: 0, filledFull: false });
  });
});
