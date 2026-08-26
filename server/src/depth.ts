import type { DepthCurve, DepthPoint, DepthSnapshot, QuoteRow } from '@shared';

/**
 * BID_ASK_DEPTH — executable spread as a CURVE over trade size.
 *
 * The input is one ordinary quote matrix: the same `VenueAdapter.quote()` path
 * the Execution grid uses, just run over a log-spaced notional grid instead of
 * the four SIZE pills. That is the whole trick, and it is why the curve
 * reconciles with the QUOTE / ROLLING_STATS rows at the pill sizes — they are
 * literally the same quote, at the same notional, from the same block.
 *
 * Nothing here knows a venue, which is what keeps two properties honest:
 *  - a venue's own quoting SKEW survives. The two legs come from that venue's
 *    two independent walks, so they are not symmetric about zero, and nothing
 *    recentres or mirrors one onto the other.
 *  - fees stay where the venue puts them. The CEX reference carries its taker
 *    fee because `reference.quote()` already applies it; an on-chain venue that
 *    charges nothing is not "corrected" to look like one that does.
 *
 * A leg ends where the venue stops quoting size. Two adapter-reported facts end
 * it, neither inferred here:
 *   - no row at that notional (the quoter reverted, or the price left the
 *     adapter's comparable band), and
 *   - `filledFull === false` — liquidity exhausts before the notional, so the
 *     price is a PARTIAL fill and is not executable at the size that was asked
 *     for. Drawing it would claim depth the venue does not have.
 * Past that point there is no honest number, so none is emitted: no
 * extrapolation, no zero-bps filler row.
 */
export function buildDepthSnapshot(
  rows: readonly QuoteRow[],
  market: string,
  sizes: readonly number[],
  refMid: number,
  asOfBlock: number,
  ts: number,
): DepthSnapshot {
  // venue order follows first appearance in the matrix (registry order), so the
  // legend is stable frame to frame instead of reshuffling with the data.
  const byKey = new Map<string, QuoteRow>();
  const venueIds: string[] = [];
  const seenVenueIds = new Set<string>();
  for (const r of rows) {
    if (r.market !== market) continue;
    if (!byKey.has(`${r.venueId}|${r.sizeUsd}`)) byKey.set(`${r.venueId}|${r.sizeUsd}`, r);
    if (!seenVenueIds.has(r.venueId)) {
      seenVenueIds.add(r.venueId);
      venueIds.push(r.venueId);
    }
  }

  const ascending = [...sizes].sort((a, b) => a - b);
  const venues: DepthCurve[] = [];
  for (const venueId of venueIds) {
    const points: DepthPoint[] = [];
    for (const notional of ascending) {
      const r = byKey.get(`${venueId}|${notional}`);
      const point = r && r.filledFull ? sidesOf(r, notional) : undefined;
      if (!point) {
        // A gap BEFORE the curve starts is a floor, not a cap — a venue with a
        // minimum order size simply begins further up the axis. A gap after it
        // has started is the cap: truncate there rather than bridging a hole
        // whose contents nothing has measured.
        if (points.length) break;
        continue;
      }
      points.push(point);
    }
    if (!points.length) continue;
    venues.push({ venueId, points, maxNotional: points[points.length - 1].notional });
  }
  return { market, asOfBlock, refMid, ts, venues };
}

/** The executable sides of one row, or undefined when neither side is real.
 *  `px > 0` is the adapter's own "this side exists" signal (a one-sided book
 *  leaves the missing side at price 0 with bps 0 — see QuoteRow.oneSided). */
function sidesOf(r: QuoteRow, notional: number): DepthPoint | undefined {
  const hasBid = r.bidPx > 0 && Number.isFinite(r.bidBps);
  const hasAsk = r.askPx > 0 && Number.isFinite(r.askBps);
  if (!hasBid && !hasAsk) return undefined;
  return {
    notional,
    ...(hasBid ? { bidBps: r.bidBps } : {}),
    ...(hasAsk ? { askBps: r.askBps } : {}),
  };
}
