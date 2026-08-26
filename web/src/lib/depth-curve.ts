import { DEPTH_DECADES, DEPTH_MIN_USD, type DepthCurve } from '@shared';

/**
 * BID_ASK_DEPTH geometry: notional (log10, y) × signed spread in bps (x).
 *
 * The SVG is drawn in a fixed 1000×340 user space and stretched to the panel
 * with `preserveAspectRatio="none"`, so every number here is in that space, not
 * in pixels. Two consequences the panel depends on:
 *  - paths carry `vector-effect="non-scaling-stroke"`, or the horizontal
 *    stretch would thicken every line as the panel widens;
 *  - axis labels are HTML positioned in %, never SVG <text> — text under a
 *    non-uniform scale shears.
 */
export const DEPTH_VIEW_W = 1000;
export const DEPTH_VIEW_H = 340;
/** Half-range of the x axis in bps. Anything wider is off the frame. */
export const DEPTH_AX_BPS = 18;
/** x ticks, every 4 bps. 0 is the zero line and carries the accent-green token. */
export const DEPTH_X_TICKS = [-16, -12, -8, -4, 0, 4, 8, 12, 16] as const;
/** y ticks — one per decade of notional, $100 … $1M. */
export const DEPTH_Y_TICKS = Array.from({ length: DEPTH_DECADES + 1 }, (_, i) => DEPTH_MIN_USD * 10 ** i);

/** bps → x. Clamped, so a caller that forgets to clip still stays in frame. */
export function depthX(bps: number): number {
  const clamped = Math.max(-DEPTH_AX_BPS, Math.min(DEPTH_AX_BPS, bps));
  return DEPTH_VIEW_W / 2 + clamped / DEPTH_AX_BPS * (DEPTH_VIEW_W / 2);
}

/** notional → y. Bottom of the plot is the smallest size. */
export function depthY(notional: number): number {
  const decades = Math.log10(notional / DEPTH_MIN_USD);
  return DEPTH_VIEW_H - decades / DEPTH_DECADES * DEPTH_VIEW_H;
}

export type DepthSide = 'bid' | 'ask';

/**
 * One venue leg → an SVG path, or null when there is nothing honest to draw.
 *
 * Where a leg leaves the ±18bps frame, it is INTERPOLATED onto the frame edge
 * and stopped there. The two obvious alternatives are both lies: clamping the
 * point in place draws a false vertical run up the frame (reading as "the venue
 * quotes exactly 18bps for the next two decades"), and letting the path escape
 * the viewBox paints over the panel's neighbours. y is linear in log-notional
 * and x is linear in bps, so the crossing is a plain linear solve in that space
 * — it is exactly where the drawn segment meets the edge.
 *
 * A leg with fewer than two in-range points is dropped rather than rendered as
 * a dot: a single sample is not a curve, and a round-capped 1.6px dot on the
 * frame edge reads as a data point that means something.
 */
export function depthLegPath(curve: DepthCurve, side: DepthSide): string | null {
  const pts: Array<[number, number]> = []; // [notional, bps]
  let prev: [number, number] | undefined;
  for (const p of curve.points) {
    const bps = side === 'bid' ? p.bidBps : p.askBps;
    if (bps === undefined || !Number.isFinite(bps)) {
      // side not executable here. Before the leg starts that is a floor (the
      // venue quotes only one side at the smallest sizes); after it starts it
      // is the cap, and the leg ends there.
      if (prev) break;
      continue;
    }
    if (Math.abs(bps) > DEPTH_AX_BPS) {
      if (prev) {
        const edge = bps > 0 ? DEPTH_AX_BPS : -DEPTH_AX_BPS;
        const t = (edge - prev[1]) / (bps - prev[1]);
        // t === 0 means the previous sample already sat exactly on the edge —
        // appending the crossing there would duplicate that vertex.
        if (t > 0) {
          const from = Math.log10(prev[0] / DEPTH_MIN_USD);
          const decades = from + (Math.log10(p.notional / DEPTH_MIN_USD) - from) * t;
          pts.push([DEPTH_MIN_USD * 10 ** decades, edge]);
        }
      }
      break;
    }
    pts.push([p.notional, bps]);
    prev = [p.notional, bps];
  }
  if (pts.length < 2) return null;
  return 'M ' + pts.map(([n, bps]) => `${depthX(bps).toFixed(1)} ${depthY(n).toFixed(1)}`).join(' L ');
}
