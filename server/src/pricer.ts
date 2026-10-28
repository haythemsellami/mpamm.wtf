import { TOKENS, assetForToken } from '@shared';

/**
 * UsdPricer (docs/architecture.md: pair-terms reference) — shared by the poller (USD→token notional sizing) and
 * the stream (token→USD volume). Stables peg to $1; a base asset (MON/BTC/ETH)
 * is priced by its CEX via `assetUsd(assetKey)` (Bybit for MON, Binance for the
 * rest — routed through the reference registry). Fully asset-generic: it maps a
 * token → its base asset → USD price, so a new asset needs no pricer change.
 */
export class UsdPricer {
  constructor(
    private readonly assetUsd: (assetKey: string) => number,
    /** the CEX reference mid for a PAIR in the pair's own terms (wrap basis +
     *  stable cross applied) — the bps anchor adapters quote against. */
    private readonly pairMidFn?: (market: string) => number,
    /** USD for valuing a SETTLED fill (usdForToken only): the live price, or a
     *  closed market's last good one (ReferenceRegistry.settledUsd). Sizing
     *  never uses it. Unset = assetUsd. */
    private readonly settledUsd?: (assetKey: string) => number,
  ) {}

  /** pair-terms reference mid (0 when unavailable). Use for bps anchoring;
   *  use usdPerToken/tokenForUsd for USD notional sizing. */
  pairMid(market: string): number {
    return this.pairMidFn?.(market) ?? 0;
  }

  usdPerToken(symbol: string): number {
    const t = TOKENS[symbol];
    if (!t) return 0;
    if (t.stable) return 1;
    const asset = assetForToken(t.address); // WMON→MON, WBTC→BTC, WETH→ETH
    return asset ? this.assetUsd(asset.key) : 0;
  }

  /** token amount (human units) for a USD notional. */
  tokenForUsd(symbol: string, usd: number): number {
    const px = this.usdPerToken(symbol);
    return px > 0 ? usd / px : 0;
  }

  /** USD notional of a settled fill leg (see `settledUsd`). */
  usdForToken(symbol: string, amount: number): number {
    if (!this.settledUsd) return amount * this.usdPerToken(symbol);
    const t = TOKENS[symbol];
    if (!t) return 0;
    if (t.stable) return amount;
    const asset = assetForToken(t.address);
    return asset ? amount * this.settledUsd(asset.key) : 0;
  }
}
