// USD prices for decoding a CLOSED day, from the exchanges' archives.
//
// A fill on a crypto-quoted pair (cbBTC/MON, MON/ETH …) has no stable leg, so
// its USD notional is the quote amount × that asset's USD price, and the
// adapters take the price from ctx.pricer. At the tip that is the live
// reference, a second or two after the trade. A history replay decodes days,
// weeks or months after the trade, and the live reference is then the price on
// the day of the replay: BTR's lifetime backfill ran on 2026-11-16 and booked
// its 150 crypto-quoted fills of 10-13..11-08 at $19,663, where they were
// worth $26,017 at their own second (MON had gone from $0.024–0.034 to $0.015).
//
// fill-time-prices.ts solves this for the tail with the chain's own prints,
// because the tail cannot wait on an exchange. A replay can: it runs in the
// background, on closed days, and is held and resumed like every other deep
// job. So it asks the archives the markout series is built from
// (history/cex.ts: assetUsdDay), which answer at any depth, where a print
// exists only for the days still in the fills table.
//
// Prices are loaded per asset and UTC day, and only for assets a decode
// actually asks about: a venue with no crypto-quoted market never fetches
// anything. The pricer handed to an adapter is synchronous, so the first
// decode of a window that needs an unloaded asset-day is thrown away, the day
// is loaded, and the window is decoded again. decode() is re-run on the same
// logs by every held tail window and every resumed replay, so it is safe to
// call twice (docs/adapters.md: deterministic ids, merge-only state).
import { UsdPricer } from './pricer.js';
import { assetUsdDay, type DayPrices } from './history/cex.js';
import { utcDay } from './util.js';

/** The live reference, for what the archives cannot answer. */
export interface LivePrices {
  assetUsd(assetKey: string): number;
  pairMid(market: string): number;
  settledUsd(assetKey: string): number;
}

/** Asset-days kept parsed. A replay walks forward a day at a time over a
 *  handful of assets; a day is 1,440 kline closes, or a MON book curve of
 *  ~35k points (~0.5 MB), so this bounds the heap at a few MB. */
const DAYS_KEPT = 12;

/** More passes than there are priced assets means a load left a day unloaded. */
const MAX_PASSES = 8;

export class ClosedDayPrices {
  /** `asset|day` → that day's prices, or null when no archive answers for it. */
  private days = new Map<string, DayPrices | null>();

  constructor(private readonly loadDay: (assetKey: string, day: string) => Promise<DayPrices | null> = (assetKey, day) => assetUsdDay(assetKey, day)) {}

  /** The asset's USD price at `atMs`. Null: no archive answers for that
   *  asset-day. Undefined: the day is not loaded yet (see `load`). */
  peek(assetKey: string, atMs: number): number | null | undefined {
    const day = this.days.get(`${assetKey}|${utcDay(atMs)}`);
    return day === undefined ? undefined : day === null ? null : day.at(atMs);
  }

  /** Fetch the asset's prices for the day of `atMs`. Throws when the archive
   *  should answer and has not (assetUsdDay): nothing is cached, so the
   *  caller's retry asks again. */
  async load(assetKey: string, atMs: number): Promise<void> {
    const key = `${assetKey}|${utcDay(atMs)}`;
    if (this.days.has(key)) return;
    const day = await this.loadDay(assetKey, utcDay(atMs));
    this.days.set(key, day);
    while (this.days.size > DAYS_KEPT) this.days.delete(this.days.keys().next().value!);
  }

  /**
   * Run `decode` with a pricer whose asset prices are those of `atMs`, and
   * return what it returned. `decode` may run more than once (see the header)
   * and must return the same thing for the same pricer.
   *
   * An asset no archive answers for keeps the live price, as before this
   * existed, and is reported through `onLive` so the caller can say so. Pair
   * mids stay live: decode does not price with them.
   *
   * Throws what `load` throws. The caller holds its cursor on that, exactly as
   * for a log range it could not read.
   */
  async decode<T>(atMs: number, live: LivePrices, decode: (pricer: UsdPricer) => T | Promise<T>, onLive?: (assetKey: string) => void): Promise<T> {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const unloaded = new Set<string>();
      const fromLive = new Set<string>();
      const usd = (fallback: (assetKey: string) => number) => (assetKey: string): number => {
        const px = this.peek(assetKey, atMs);
        // any positive number: this pass's result is discarded. Not the live
        // price, which may be zero while a feed warms and would make the
        // adapter throw for a fill the archive can price.
        if (px === undefined) { unloaded.add(assetKey); return 1; }
        if (px === null) { fromLive.add(assetKey); return fallback(assetKey); }
        return px;
      };
      const out = await decode(new UsdPricer(usd(live.assetUsd), live.pairMid, usd(live.settledUsd)));
      if (!unloaded.size) {
        for (const assetKey of fromLive) onLive?.(assetKey);
        return out;
      }
      for (const assetKey of unloaded) await this.load(assetKey, atMs);
    }
    throw new Error('closed-day prices: decode kept asking for unloaded prices');
  }
}
