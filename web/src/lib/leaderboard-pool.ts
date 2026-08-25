import type { LeaderboardGroupRow, VenueMeta } from '@shared';

/** Friendly pool-group label layered over the stable aggregation key. The
 * server supplies venue/market only when they are unambiguous for the window;
 * multi-market contracts keep their raw pool key rather than claiming one pair. */
export function poolLeaderboardLabel(
  row: Pick<LeaderboardGroupRow, 'key' | 'venueId' | 'market'>,
  venuesById: Record<string, VenueMeta>,
): string {
  const venue = row.venueId ? venuesById[row.venueId]?.name : undefined;
  if (!venue) return row.key;

  // Adapter prefixes (`lob`, `poe`, `metric`, …) are useful storage/debug keys,
  // but the venue name already says what the pool is. Keep the short address as
  // the human disambiguator; non-address ids such as `book 59548856` stay whole.
  const address = row.key.match(/0x[0-9a-f]+/i)?.[0];
  const poolId = address ?? row.key;
  return [venue, row.market, poolId].filter((x): x is string => !!x).join(' · ');
}
