// Closed-day pricing (closed-day-prices.ts): a history replay values a
// crypto-quoted fill at the asset's archived price on the fill's own day, not
// at the live price on the day of the replay. BTR's lifetime backfill, run on
// 2026-11-16 with MON at $0.015, booked October fills traded at $0.024–0.034
// 24.5% low. The decode case is BTR's own adapter on a recorded mainnet log.
import { readFileSync } from 'node:fs';
import { decodeEventLog } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { Fill } from '@shared';
import { ClosedDayPrices, type LivePrices } from '../closed-day-prices.js';
import type { DayPrices } from '../history/cex.js';
import type { UsdPricer } from '../pricer.js';
import type { AdapterContext } from '../venues/adapter.js';
import { createBtrAdapter } from '../venues/btr.js';
import { interpolateBlockTime, priceSlices, PRICE_SLICE_MS } from '../datasource/live.js';

const T = Date.parse('2026-10-14T09:30:00Z');
const flat = (px: number): DayPrices => ({ at: () => px });
/** the live reference on the day of the replay: MON has halved since October */
const live: LivePrices = { assetUsd: (k) => ({ MON: 0.015, BTC: 64_000, ETH: 1_800 }[k] ?? 0), pairMid: () => 0, settledUsd: (k) => ({ MON: 0.015, BTC: 64_000, ETH: 1_800 }[k] ?? 0) };
/** what an adapter does with the pricer: value a WMON quote leg */
const monLeg = (amount: number) => (pricer: UsdPricer) => pricer.usdForToken('WMON', amount);

describe('ClosedDayPrices', () => {
  it("values a leg at the asset's archived price for the day of the fill, not the live one", async () => {
    const load = vi.fn(async (asset: string, day: string) => (asset === 'MON' && day === '2026-10-14' ? flat(0.0244) : null));
    const prices = new ClosedDayPrices(load);
    expect(await prices.decode(T, live, monLeg(10_000))).toBeCloseTo(244, 9); // live would say 150
    expect(load.mock.calls).toEqual([['MON', '2026-10-14']]);
  });

  it('reads the price at the instant asked, and keys the day in UTC', async () => {
    const byDay: Record<string, DayPrices> = {
      '2026-10-14': { at: (t) => (t < T ? 0.0250 : 0.0240) },
      '2026-10-15': flat(0.0230),
    };
    const prices = new ClosedDayPrices(async (_a, day) => byDay[day] ?? null);
    expect(await prices.decode(T - 1, live, monLeg(1))).toBe(0.0250);
    expect(await prices.decode(T, live, monLeg(1))).toBe(0.0240);
    expect(await prices.decode(Date.parse('2026-10-14T23:59:59.999Z'), live, monLeg(1))).toBe(0.0240);
    expect(await prices.decode(Date.parse('2026-10-15T00:00:00Z'), live, monLeg(1))).toBe(0.0230);
  });

  it('fetches nothing for a decode that prices no asset: a stable-quoted venue never touches an archive', async () => {
    const load = vi.fn(async () => flat(1));
    const prices = new ClosedDayPrices(load);
    const decode = vi.fn((pricer: UsdPricer) => pricer.usdForToken('USDC', 168.286102));
    expect(await prices.decode(T, live, decode)).toBe(168.286102);
    expect(load).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('decodes again once the day is loaded, then once per window while it stays loaded', async () => {
    const load = vi.fn(async () => flat(0.0244));
    const prices = new ClosedDayPrices(load);
    const decode = vi.fn(monLeg(100));
    await prices.decode(T, live, decode);
    expect(decode).toHaveBeenCalledTimes(2); // the first pass only found out what to load
    await prices.decode(T + 300_000, live, decode);
    expect(decode).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never lets the first pass see the live price: a cold feed must not fail a fill the archive can price', async () => {
    const cold: LivePrices = { assetUsd: () => 0, pairMid: () => 0, settledUsd: () => 0 };
    const prices = new ClosedDayPrices(async () => flat(0.0244));
    // the adapters throw on a non-positive USD (btr.ts: "no USD price for either fill leg")
    const strict = (pricer: UsdPricer) => {
      const usd = pricer.usdForToken('WMON', 100);
      if (!(usd > 0)) throw new Error('no USD price');
      return usd;
    };
    expect(await prices.decode(T, cold, strict)).toBeCloseTo(2.44, 9);
  });

  it('loads an asset the second pass turns to: the base leg, when the quote has no archive', async () => {
    // SPYx (Kraken) has no archive and its feed is cold, so the adapter falls back to the base leg
    const load = vi.fn(async (asset: string) => (asset === 'ETH' ? flat(2_500) : null));
    const prices = new ClosedDayPrices(load);
    const fallback = (pricer: UsdPricer) => pricer.usdForToken('SPYX', 2) || pricer.usdForToken('WETH', 0.4);
    expect(await prices.decode(T, live, fallback)).toBe(1_000);
    expect(load.mock.calls.map(([asset]) => asset)).toEqual(['SPYx', 'ETH']);
  });

  it('keeps the live price for an asset no archive answers for, and says which', async () => {
    const prices = new ClosedDayPrices(async () => null);
    const onLive = vi.fn();
    expect(await prices.decode(T, live, monLeg(10_000), onLive)).toBe(150);
    expect(onLive.mock.calls).toEqual([['MON']]);
  });

  it('throws when the archive should answer and has not, and asks again on the retry', async () => {
    let published = false;
    const load = vi.fn(async () => {
      if (!published) throw new Error('bybit book archive MONUSDT 2026-10-14 is not published yet');
      return flat(0.0244);
    });
    const prices = new ClosedDayPrices(load);
    const onLive = vi.fn();
    await expect(prices.decode(T, live, monLeg(100), onLive)).rejects.toThrow(/not published yet/);
    expect(onLive).not.toHaveBeenCalled(); // held, never priced from today
    published = true;
    expect(await prices.decode(T, live, monLeg(100), onLive)).toBeCloseTo(2.44, 9);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('a BTR crypto-quoted fill decoded on a closed day (recorded Monad log)', () => {
  const FX = JSON.parse(readFileSync(new URL('../venues/__tests__/fixtures/btr-swapped.json', import.meta.url), 'utf8'));
  const adapter = createBtrAdapter();
  const abi = adapter.logSources()[0].events as any[];
  // 0.00479999 WBTC in, 0.00479561 cbBTC out on the retired pool: WBTC/cbBTC, quote leg cbBTC
  const raw = FX.logs[2];
  const log = { ...raw, blockNumber: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex), ...(decodeEventLog({ abi, data: raw.data, topics: raw.topics }) as any) };
  const ts = Number(raw.blockTimestamp) * 1000;
  const ctx = { note: () => {} } as unknown as AdapterContext;
  const decode = (pricer: UsdPricer) => adapter.decode({ ...ctx, pricer }, { pool: [log] }, () => ts, new Set()) as Fill[];

  it("books the quote leg at BTC's price that day, where the live pricer books it at today's", async () => {
    const prices = new ClosedDayPrices(async (asset) => (asset === 'BTC' ? flat(110_000) : null));
    const [fill] = await prices.decode(ts, live, decode);
    expect(fill.market).toBe('WBTC/cbBTC');
    expect(fill.usd).toBeCloseTo(0.00479561 * 110_000, 6); // $527.52, not $306.92 at $64k
    expect(fill.baseAmount).toBeCloseTo(0.00479999, 12);   // amounts are the chain's either way
  });
});

describe('priceSlices: a bundle is priced in short runs of chain time', () => {
  // 0.3s blocks from T: block n is at T + 300n ms
  const timeOf = (bn: bigint) => T + Number(bn) * 300;

  it('prices by the few seconds by default: swaps bunch up exactly when prices run', () => {
    expect(PRICE_SLICE_MS).toBe(5_000);
    // 0s, 3s and 6s: the third is more than 5s after the first
    expect(priceSlices([0n, 10n, 20n], timeOf)).toEqual([
      { from: 0n, to: 10n, atMs: T + 1_500 },
      { from: 20n, to: 20n, atMs: T + 6_000 },
    ]);
  });

  it('keeps a burst inside the span in one slice, priced at its midpoint', () => {
    expect(priceSlices([10n, 40n, 190n], timeOf, 60_000)).toEqual([{ from: 10n, to: 190n, atMs: T + 30_000 }]);
  });

  it("cuts when a block is more than the span after the slice's first, so no fill is priced further off than that", () => {
    const blocks = [0n, 800n, 806n, 1_000n, 1_001n, 1_500n];
    const slices = priceSlices(blocks, timeOf, 60_000);
    expect(slices.map((s) => [s.from, s.to])).toEqual([[0n, 0n], [800n, 1_000n], [1_001n, 1_001n], [1_500n, 1_500n]]);
    expect(slices[1].atMs).toBe(T + 900 * 300);
    for (const s of slices) expect(timeOf(s.to) - timeOf(s.from)).toBeLessThanOrEqual(60_000);
    // every block lands in exactly one slice
    expect(blocks.every((b) => slices.filter((s) => b >= s.from && b <= s.to).length === 1)).toBe(true);
  });

  it('is one slice per block when every block is its own instant, and none for no blocks', () => {
    expect(priceSlices([1n, 2n], (bn) => T + Number(bn) * 120_000)).toHaveLength(2);
    expect(priceSlices([], timeOf)).toEqual([]);
    expect(priceSlices([7n], timeOf)).toEqual([{ from: 7n, to: 7n, atMs: T + 2_100 }]);
  });
});

describe('interpolateBlockTime: the replay reads two block times a chunk and places the rest', () => {
  it('puts a block between the two ends in proportion, and reads the ends back exactly', () => {
    const timeOf = interpolateBlockTime(1_000n, T, 2_000n, T + 300_000);
    expect(timeOf(1_000n)).toBe(T);
    expect(timeOf(2_000n)).toBe(T + 300_000);
    expect(timeOf(1_250n)).toBe(T + 75_000);
    expect(timeOf(900n)).toBe(T - 30_000); // a log before the first block that resolved
  });

  it('is the one known time when there is no second end to measure against', () => {
    expect(interpolateBlockTime(5n, T, 5n, T)(9n)).toBe(T);
    expect(interpolateBlockTime(5n, T, 9n, T)(7n)).toBe(T); // two ends in one second
  });
});
