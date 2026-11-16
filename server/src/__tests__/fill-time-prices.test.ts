// USD as of a past block, from the chain's own stable-quoted fills
// (fill-time-prices.ts). The 2026-11-12 gap was decoded four days late with
// the LIVE price: every MON- and ETH-quoted fill came out 10–12% low. These
// tests pin what replaces it for an old window, and that the live price is
// still what a window gets when it is the nearer observation.
import { describe, expect, it } from 'vitest';
import type { Fill } from '@shared';
import { FillTimePrices } from '../fill-time-prices.js';

const T = 1_794_500_000_000; // a block time during the gap
const fill = (market: string, execPx: number, ts = T, extra: Partial<Fill> = {}): Fill => ({
  id: `v-${market}-${execPx}-${ts}`, venueId: 'v', market, side: 'buy', category: 'DIRECT',
  usd: 1, baseAmount: 1, execPx, txHash: '0x', to: '', pool: '', blockNumber: 1, ts,
  markoutsBps: [null, null, null, null, null], ...extra,
} as Fill);

describe('FillTimePrices', () => {
  it('reads a stable-quoted fill as a USD print of its base asset', () => {
    const p = new FillTimePrices();
    p.observe([fill('MON/USDC', 0.0172), fill('cbBTC/USDC', 96_500), fill('ETH/AUSD', 3_210)]);
    const now = T + 4 * 86_400_000;
    expect(p.usdAt('MON', T + 60_000, now)).toBe(0.0172);
    expect(p.usdAt('BTC', T + 60_000, now)).toBe(96_500); // cbBTC and WBTC pairs are both the BTC asset
    expect(p.usdAt('ETH', T + 60_000, now)).toBe(3_210);
  });

  it('never learns a price from the fills it exists to price', () => {
    const p = new FillTimePrices();
    // cbBTC/MON's execPx is MON per BTC (≈5.6M), MON/ETH's is ETH per MON: neither is USD
    p.observe([fill('cbBTC/MON', 5_610_000), fill('MON/ETH', 0.0000054)]);
    expect(p.usdAt('BTC', T, T + 86_400_000)).toBeUndefined();
    expect(p.usdAt('MON', T, T + 86_400_000)).toBeUndefined();
  });

  it('ignores an approximate price, a non-positive one and an unregistered market', () => {
    const p = new FillTimePrices();
    p.observe([fill('MON/USDC', 0.5, T, { pxApprox: true }), fill('MON/USDC', 0), fill('MON/USDC', NaN), fill('DOGE/USDC', 0.3)]);
    expect(p.usdAt('MON', T, T + 86_400_000)).toBeUndefined();
  });

  it("takes the batch's median, so one mispriced swap cannot set the next window's price", () => {
    const p = new FillTimePrices();
    p.observe([fill('MON/USDC', 0.0171), fill('MON/USDC', 0.0173), fill('MON/USDC', 0.0172), fill('MON/USDC', 0.17)]);
    expect(p.usdAt('MON', T, T + 86_400_000)).toBeCloseTo(0.01725, 6);
  });

  it('reads only the newest prints of a long batch: the tape at boot spans hours', () => {
    const p = new FillTimePrices();
    // twelve hours of tape while MON fell from 0.0190 to 0.0172; the cursor is at T
    const tape = Array.from({ length: 144 }, (_, i) => fill('MON/USDC', 0.0190 - (0.0018 * i) / 143, T - (143 - i) * 300_000));
    p.observe(tape);
    // the last five minutes hold two prints: their median, not the half-day's (0.0181)
    expect(p.usdAt('MON', T + 60_000, T + 4 * 86_400_000)).toBeCloseTo(0.0172, 4);
  });

  it('moves forward only: a batch older than the print it holds changes nothing', () => {
    const p = new FillTimePrices();
    p.observe([fill('MON/USDC', 0.0172, T)]);
    p.observe([fill('MON/USDC', 0.0190, T - 3_600_000)]);
    expect(p.usdAt('MON', T, T + 86_400_000)).toBe(0.0172);
    p.observe([fill('MON/USDC', 0.0165, T + 300_000)]);
    expect(p.usdAt('MON', T + 300_000, T + 86_400_000)).toBe(0.0165);
  });

  it('answers only while the print is the nearer observation; otherwise the caller prices live', () => {
    const p = new FillTimePrices();
    p.observe([fill('ETH/USDC', 3_210, T)]);
    // window 10 min after the print, decoded 4 days later: the print is nearer
    expect(p.usdAt('ETH', T + 600_000, T + 4 * 86_400_000)).toBe(3_210);
    // window 6 h after the print, decoded 5 min after the window: live is nearer
    expect(p.usdAt('ETH', T + 6 * 3_600_000, T + 6 * 3_600_000 + 300_000)).toBeUndefined();
    // no print at all
    expect(p.usdAt('XAUt', T, T + 1)).toBeUndefined();
  });

  it('prices the 2026-11-16 rehearsal case: a cbBTC/MON fill worth its MON leg at the fill-time price', () => {
    // 1,200 MON paid for cbBTC while MON was $0.0172; four days later MON was $0.0153
    const p = new FillTimePrices();
    p.observe([fill('MON/USDC', 0.0172, T)]);
    const atFill = 1_200 * p.usdAt('MON', T + 30_000, T + 4 * 86_400_000)!;
    const live = 1_200 * 0.0153;
    expect(atFill).toBeCloseTo(20.64, 2);
    expect(live / atFill - 1).toBeCloseTo(-0.11, 2); // what decode-time pricing lost
  });
});
