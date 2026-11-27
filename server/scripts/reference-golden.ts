// Writes today's pair-terms reference answers for a fixed set of exchange
// mids and books to service/crates/pricing/tests/reference-golden.json, which
// the Rust reference is tested against:  npx tsx scripts/reference-golden.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAIRS } from '@shared';
import { BybitFeed, walkLevels } from '../src/bybit.js';
import { BinanceFeed } from '../src/binance.js';
import { KrakenFeed } from '../src/kraken.js';
import { createReferenceRegistry } from '../src/venues/reference.js';

export const MIDS: Record<string, Record<string, number>> = {
  bybit: { MONUSDT: 0.03, USDCUSDT: 1.0002, USD1USDT: 0.999 },
  binance: { BTCUSDT: 90000, ETHUSDT: 3000, XAUTUSDT: 4000, WBTCBTC: 0.9995, USDCUSDT: 1.0001 },
  kraken: {
    'SPYx/USD': 700, 'QQQx/USD': 600, 'EWYx/USD': 80, 'NVDAx/USD': 180, 'TSLAx/USD': 400,
    'ANTx/USD': 50, 'SPCXx/USD': 120, 'MUx/USD': 110, 'SKHYx/USD': 230, 'SMHx/USD': 300,
    'USDC/USD': 0.9998, 'USDT/USD': 1.001, 'AUSD/USD': 0.999,
  },
};
/** Books: [bids high→low, asks low→high], [price, size]. */
export const BOOKS: Record<string, Record<string, [Array<[number, number]>, Array<[number, number]>]>> = {
  bybit: { MONUSDT: [[[0.0299, 1e6], [0.0298, 5e6]], [[0.0301, 1e6], [0.0302, 5e6]]] },
  binance: { BTCUSDT: [[[89990, 0.5], [89980, 2]], [[90010, 0.5], [90020, 2]]] },
  kraken: { 'SPYx/USD': [[[699.9, 10], [699.5, 50]], [[700.1, 10], [700.5, 50]]] },
};
const RATE = 1.25;

const mid = (cex: string) => (s: string) => MIDS[cex][s] ?? 0;
const walk = (cex: string) => (s: string, side: 'buy' | 'sell', base: number) => {
  const b = BOOKS[cex][s];
  return walkLevels(b ? (side === 'buy' ? b[1] : b[0]) : [], base, cex === 'kraken' ? 0 : mid(cex)(s));
};
BybitFeed.prototype.mid = function () { return mid('bybit')('MONUSDT'); };
BybitFeed.prototype.crossMid = function (s: string) { return mid('bybit')(s); };
BybitFeed.prototype.walk = function (side: 'buy' | 'sell', base: number) { return walk('bybit')('MONUSDT', side, base); };
BinanceFeed.prototype.mid = function (s: string) { return mid('binance')(s); };
BinanceFeed.prototype.walk = function (s: string, side: 'buy' | 'sell', base: number) { return walk('binance')(s, side, base); };
KrakenFeed.prototype.mid = function (s: string) { return mid('kraken')(s); };
KrakenFeed.prototype.walk = function (s: string, side: 'buy' | 'sell', base: number) { return walk('kraken')(s, side, base); };

const ref = createReferenceRegistry({ rate: (key: string) => (key.startsWith('W') && key.endsWith('X') ? RATE : 1) });
const sizes = [100, 1000, 10000, 100000];
const out = {
  mids: MIDS, books: BOOKS, rate: RATE, sizes,
  midForPair: PAIRS.map((p) => [p.symbol, ref.midForPair(p.symbol)]),
  rows: ref.quote(sizes).map((r) => [r.venueId, r.market, r.sizeUsd, r.bidPx, r.askPx, r.bidBps, r.askBps, r.spreadBps, r.filledFull, r.feeBps]),
};
const file = fileURLToPath(new URL('../../service/crates/pricing/tests/reference-golden.json', import.meta.url));
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(`pairs ${out.midForPair.length}, rows ${out.rows.length}, priced ${out.midForPair.filter(([, m]) => (m as number) > 0).length}`);
