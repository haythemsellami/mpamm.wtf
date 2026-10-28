import { beforeEach, describe, expect, it, vi } from 'vitest';
const mids = vi.hoisted(() => new Map<string, number>());
const walk = (symbol: string, side: string, size: number) => ({ price: mids.get(symbol)! * (side === 'buy' ? 1.001 : 0.999), filledBase: size, filledFull: true });
vi.mock('../../kraken.js', () => ({ KrakenFeed: class { mid(s: string) { return mids.get(s) ?? 0; } walk = walk; changePct() { return 3; } } }));
vi.mock('../../binance.js', () => ({ BinanceFeed: class { mid(s: string) { return mids.get(s) ?? 0; } walk = walk; changePct() { return 2; } } }));
vi.mock('../../bybit.js', () => ({ BybitFeed: class {
  mid() { return mids.get('MONUSDT') ?? 0; }
  crossMid(s: string) { return mids.get(s) ?? 0; }
  walk(side: string, size: number) { return walk('MONUSDT', side, size); }
  changePct() { return 1; }
} }));
import { createReferenceRegistry } from '../reference.js';
import { supportsHistoricalReference, pairMidSeries } from '../../history/cex.js';
import { config } from '../../config.js';

beforeEach(() => {
  mids.clear();
  for (const [s, p] of Object.entries({ 'SPYx/USD': 800, 'QQQx/USD': 700, 'USDC/USD': 1.002, 'USDT/USD': 0.998, 'AUSD/USD': 1.003, BTCUSDT: 100_000, MONUSDT: 0.03, WBTCBTC: 0.999, XAUTUSDT: 4000, USDCUSDT: 1.0002 })) mids.set(s, p);
});
describe('per-CEX routing', () => {
  it("routes each base to its own CEX's book, walk, change, fee and venue id", () => {
    const r = createReferenceRegistry();
    expect([r.assetUsd('MON'), r.assetUsd('BTC'), r.assetUsd('SPYx')]).toEqual([0.03, 100_000, 800]);
    expect([r.changePctFor('MON'), r.changePctFor('BTC'), r.changePctFor('SPYx')]).toEqual([1, 2, 3]);
    const rows = r.quote([100], new Set(['MON/USDC', 'BTC/USDC', 'SPYx/USDC']));
    expect(rows.map((row) => [row.market, row.venueId, row.feeBps])).toEqual([
      ['MON/USDC', 'bybit', config.takerBps],
      ['BTC/USDC', 'binance', config.binanceTakerBps],
      ['SPYx/USDC', 'kraken', config.krakenXstockTakerBps],
    ]);
    // each walked its own book: ask = book mid × 1.001 in pair terms, plus that CEX's fee
    expect(rows[0].askPx).toBeCloseTo(0.03 * 1.001 / 1.0002 * (1 + config.takerBps / 1e4), 12);
    expect(rows[1].askPx).toBeCloseTo(100_000 * 1.001 * 0.999 / 1.0002 * (1 + config.binanceTakerBps / 1e4), 6);
    expect(rows[2].askPx).toBeCloseTo(800 * 1.001 / 1.002 * (1 + config.krakenXstockTakerBps / 1e4), 9);
  });
});

describe('xStock pair terms', () => {
  it('converts actual token/USD books separately into USDC, USDT0 and AUSD', () => {
    const r = createReferenceRegistry();
    expect(r.assetUsd('SPYx')).toBe(800);
    expect(r.midForPair('SPYx/USDC')).toBeCloseTo(800 / 1.002, 10);
    expect(r.midForPair('SPYx/USDT0')).toBeCloseTo(800 / 0.998, 10);
    expect(r.midForPair('SPYx/AUSD')).toBeCloseTo(800 / 1.003, 10);
    expect(r.refVenueIdForBase('SPYx')).toBe('kraken');
  });
  it('converts USD/USDT across exchanges and applies WBTC basis to the quote leg', () => {
    const r = createReferenceRegistry();
    expect(r.midForPair('SPYx/BTC')).toBeCloseTo(800 / (100_000 * 0.998 * 0.999), 12);
    expect(r.midForPair('SPYx/cbBTC')).toBeCloseTo(800 / (100_000 * 0.998), 12);
    expect(r.midForPair('SPYx/MON')).toBeCloseTo(800 / (0.03 * 0.998), 8);
    expect(r.midForPair('QQQx/SPYx')).toBeCloseTo(700 / 800, 12);
    expect(r.midForPair('XAUt/BTC')).toBeCloseTo(4000 / (100_000 * 0.999), 12);
  });
  it('does not peg or borrow another feed when a required conversion is missing', () => {
    const r = createReferenceRegistry();
    mids.delete('USDT/USD'); expect(r.midForPair('SPYx/BTC')).toBe(0);
    expect(r.midForPair('QQQx/SPYx')).toBeGreaterThan(0);
    mids.delete('USDC/USD'); expect(r.midForPair('SPYx/USDC')).toBe(0);
    expect(r.quote([100], new Set(['SPYx/USDC']))).toEqual([]);
    mids.set('USDT/USD', 0.998); mids.delete('WBTCBTC');
    expect(r.midForPair('SPYx/BTC')).toBe(0);
  });
  it('sizes in token units, walks the token book, and adds the configured xStock fee', () => {
    const row = createReferenceRegistry().quote([800], new Set(['SPYx/USDC']))[0];
    expect(row.venueId).toBe('kraken'); expect(row.feeBps).toBe(config.krakenXstockTakerBps);
    expect(row.askPx).toBeCloseTo(800 * 1.001 / 1.002 * (1 + config.krakenXstockTakerBps / 1e4), 10);
    expect(row.bidPx).toBeCloseTo(800 * 0.999 / 1.002 * (1 - config.krakenXstockTakerBps / 1e4), 10);
  });
  it('distinguishes unsupported xStock archives from existing crypto histories', async () => {
    expect(supportsHistoricalReference('SPYx/USDC')).toBe(false);
    expect(supportsHistoricalReference('QQQx/SPYx')).toBe(false);
    expect(supportsHistoricalReference('BTC/USDC')).toBe(true);
    expect(await pairMidSeries('SPYx/USDC', 0, 1000)).toBeNull();
  });
});
