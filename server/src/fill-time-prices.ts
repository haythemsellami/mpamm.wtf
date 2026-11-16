// USD prices as of a past block, learned from the chain's own fills.
//
// A fill on a crypto-quoted pair (cbBTC/MON, MON/ETH …) has no stable leg, so
// its USD notional is the quote amount × that asset's USD price. The adapters
// take the price from ctx.pricer, which is the LIVE reference: right at the
// tip, where a fill is decoded a second or two after it traded, and wrong for
// a window decoded late. The 2026-11-12 gap, rehearsed four days on, came out
// 10–12% low on every MON- and ETH-quoted market (MON had fallen that much
// since), which was 4.4% of Hanji's volume for those days.
//
// The price that belongs to an old window is already in the tail's hands:
// every stable-quoted fill of an asset (MON/USDC …) is a USD print of it at
// its own block time, and they arrive in block order, a few per minute for
// MON. So the tail keeps the latest print per asset and prices an old window
// from it. No exchange is asked: the archives that could answer are published
// a day late (Bybit's book dumps, the only keyless MON history) or would put
// a CDN on the path of the cursor.
//
// A print is used only when it is the NEARER observation: closer in time to
// the window than "now" is. Otherwise the caller falls back to the live
// price, which is what a window at the tip gets anyway.
import { pairOf, type Fill } from '@shared';

interface Print { px: number; ts: number }

/** A batch's price for an asset is the median of its prints from the last
 *  this-much before its newest one. A tail window spans about that, so it
 *  contributes all of them; the tape read at boot spans hours, and only its
 *  newest prints are "the price at the cursor". */
const PRINT_SPAN_MS = 300_000;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class FillTimePrices {
  private last = new Map<string, Print>();

  /**
   * Learn from one batch of fills (a tail window, or the stored tape at boot).
   * Only a stable-quoted fill with an exact price is a print: an asset-quoted
   * one is what this exists to price, and `pxApprox` is not a price at all.
   * The MEDIAN of the batch's newest prints per asset (PRINT_SPAN_MS), so one
   * mispriced swap cannot set the price of every crypto-quoted fill in the
   * next window. A batch older than what is already held is ignored: prints
   * only ever move forward in time.
   */
  observe(fills: readonly Pick<Fill, 'market' | 'execPx' | 'ts' | 'pxApprox'>[]): void {
    const batch = new Map<string, Print[]>();
    for (const f of fills) {
      if (f.pxApprox || !(f.execPx > 0) || !Number.isFinite(f.execPx)) continue;
      const pair = pairOf(f.market);
      if (!pair || pair.quoteKind === 'asset') continue;
      const prints = batch.get(pair.base);
      if (prints) prints.push({ px: f.execPx, ts: f.ts });
      else batch.set(pair.base, [{ px: f.execPx, ts: f.ts }]);
    }
    for (const [asset, prints] of batch) {
      let newest = 0;
      for (const p of prints) if (p.ts > newest) newest = p.ts;
      const held = this.last.get(asset);
      if (held && held.ts > newest) continue;
      this.last.set(asset, { px: median(prints.filter((p) => p.ts >= newest - PRINT_SPAN_MS).map((p) => p.px)), ts: newest });
    }
  }

  /** The asset's USD price as of `atMs`, or undefined when there is no print
   *  or the live price (an observation at `nowMs`) is nearer to `atMs`. */
  usdAt(assetKey: string, atMs: number, nowMs: number): number | undefined {
    const p = this.last.get(assetKey);
    if (!p) return undefined;
    return Math.abs(atMs - p.ts) <= Math.abs(nowMs - atMs) ? p.px : undefined;
  }
}
