import type { QuoteScope } from '@shared';

export interface QuotePlan { markets?: ReadonlySet<string>; sizes: readonly number[]; baseline: boolean }

/** Group equal size sets, avoiding a cross-product of every viewer's selections. */
export function planQuotes(scopes: readonly QuoteScope[], allSizes: readonly number[], full = false): QuotePlan[] {
  if (full) return [{ sizes: allSizes, baseline: true }];
  const byMarket = new Map<string, { sizes: Set<number>; baselineSizes: Set<number> }>();
  for (const scope of scopes) {
    let entry = byMarket.get(scope.market);
    if (!entry) { entry = { sizes: new Set(), baselineSizes: new Set() }; byMarket.set(scope.market, entry); }
    entry.sizes.add(scope.sizeUsd);
    if (scope.baseline) entry.baselineSizes.add(scope.sizeUsd);
  }
  const groups = new Map<string, QuotePlan & { markets: Set<string> }>();
  for (const [market, entry] of byMarket) {
    for (const baseline of [false, true]) {
      const sizes = [...(baseline ? entry.baselineSizes : entry.sizes)].sort((a, b) => a - b);
      if (!sizes.length) continue;
      const key = `${Number(baseline)}:${sizes.join(',')}`;
      let group = groups.get(key);
      if (!group) { group = { sizes, baseline, markets: new Set() }; groups.set(key, group); }
      group.markets.add(market);
    }
  }
  return [...groups.values()];
}
