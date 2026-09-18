import type { QuoteScope } from '@shared';

/** Full demand explicitly includes every venue role. Scoped demand keeps
 * regular and baseline work separate without duplicating reference rows. */
export type QuotePlan = { sizes: readonly number[] } & (
  | { role: 'all'; markets?: undefined }
  | { role: 'venue' | 'baseline'; markets: ReadonlySet<string> }
);

/** Group equal size sets, avoiding a cross-product of every viewer's selections. */
export function planQuotes(scopes: readonly QuoteScope[], allSizes: readonly number[], full = false): QuotePlan[] {
  if (full) return [{ sizes: allSizes, role: 'all' }];
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
      if (!group) { group = { sizes, role: baseline ? 'baseline' : 'venue', markets: new Set() }; groups.set(key, group); }
      group.markets.add(market);
    }
  }
  return [...groups.values()];
}
