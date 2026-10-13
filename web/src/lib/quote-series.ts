import { QUOTE_CHART_WINDOW_MS, type QuoteRow, type QuoteSnapshot } from '@shared';

export interface QuotePoint {
  block: number;
  ts: number;
  bid: number | null;
  ask: number | null;
  /** the pair-terms reference mid the frame's bps were anchored to — what
   *  off-scale detection measures distance from. */
  mid: number | null;
}

export interface QuoteSeries {
  points: QuotePoint[];
}

export const quoteFrameTime = (q: QuoteSnapshot): number => q.frame?.emittedAt ?? q.ts;

/** Every row's bps are `(px / mid - 1) × 1e4` against one pair-terms mid, so
 *  either executable side recovers it. */
function rowMid(row: QuoteRow): number | null {
  const mid = row.bidPx > 0 ? row.bidPx / (1 + row.bidBps / 1e4)
    : row.askPx > 0 ? row.askPx / (1 + row.askBps / 1e4) : 0;
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

/** Append one real frame for every venue. Missing rows/sides become nulls so
 *  every series shares one time axis and the canvas can show the absence. */
export function appendQuoteSnapshot(
  series: Record<string, QuoteSeries>,
  venueIds: readonly string[],
  q: QuoteSnapshot,
  market: string,
  size: number,
  windowMs = QUOTE_CHART_WINDOW_MS,
  maxPoints = 4096,
): void {
  const ts = quoteFrameTime(q);
  const rows = new Map(q.rows
    .filter((r) => r.market === market && r.sizeUsd === size)
    .map((r) => [r.venueId, r]));

  for (const venueId of venueIds) {
    const points = (series[venueId] ??= { points: [] }).points;
    const last = points[points.length - 1];
    if (last && q.block < last.block) continue; // stale REST/reconnect response
    const row = rows.get(venueId);
    const point: QuotePoint = {
      block: q.block,
      ts,
      bid: row && row.bidPx > 0 ? row.bidPx : null,
      ask: row && row.askPx > 0 ? row.askPx : null,
      mid: row ? rowMid(row) : null,
    };
    if (last?.block === q.block) points[points.length - 1] = point;
    else points.push(point);

    const cutoff = ts - windowMs;
    while (points.length > 1 && points[0].ts < cutoff) points.shift();
    while (points.length > maxPoints) points.shift();
  }
}

/** Contiguous runs for a side/ribbon. A missing venue row, missing side, or
 *  skipped block breaks the path instead of drawing across unavailable data. */
export function continuousQuoteRuns(
  points: readonly QuotePoint[],
  side: 'bid' | 'ask' | 'both',
  fromTs: number,
): QuotePoint[][] {
  const runs: QuotePoint[][] = [];
  let run: QuotePoint[] = [];
  let prior: QuotePoint | undefined;
  for (const point of points) {
    const valuePresent = side === 'both'
      ? point.bid !== null && point.ask !== null
      : point[side] !== null;
    const contiguous = prior !== undefined
      && point.block === prior.block + 1
      && point.ts >= prior.ts;
    if (point.ts < fromTs || !valuePresent) {
      if (run.length) runs.push(run);
      run = [];
      prior = point;
      continue;
    }
    if (run.length && !contiguous) {
      runs.push(run);
      run = [];
    }
    run.push(point);
    prior = point;
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * OFF-SCALE quotes. One backstop side (Capricorn's one-sided bid at −1529bps)
 * used to set the y-domain alone and flatten every competitive venue into a
 * few pixels. A side further from the mid than OFF_SCALE_FACTOR × the median
 * distance of everything drawn in the window is left out of the domain and
 * pinned to the plot edge instead — still drawn, still labelled, never hidden.
 *
 * 20× comes from replaying every adapter's quote() at 1,002 blocks over
 * 2026-10-05..12 against the historical CEX mid: ordinary sides sit below 5×
 * (p99 4.7×); POE's genuine skew episodes (−100..−150bps while the field is at
 * ±10) reach 10–15× and must stay on scale, which rules out 10×; backstops,
 * deep partial walks and Capricorn's ~300bps $100 side sit at 20–1000×. Above
 * 20× the only full two-sided sides pinned all week were 4 POE asks at
 * +440..+714bps.
 *
 * The floor never bound in that replay; it keeps a market where everything
 * quotes within a hair of the mid from pinning a perfectly ordinary 10bps
 * line. With fewer than two venues there is nothing to squash — the lone
 * venue IS the chart — so no limit applies.
 */
export const OFF_SCALE_FACTOR = 20;
export const OFF_SCALE_FLOOR_BPS = 50;

export const quoteDistanceBps = (px: number, mid: number | null): number | null =>
  mid !== null && mid > 0 ? Math.abs(px / mid - 1) * 1e4 : null;

export interface ChartLine {
  points: readonly QuotePoint[];
  /** the CEX benchmark: counts toward the median, not toward the venue minimum */
  reference?: boolean;
}

/** Distance (bps) beyond which a side is off-scale for this window, or null
 *  when every side belongs in the domain. */
export function offScaleLimitBps(lines: readonly ChartLine[], fromTs: number): number | null {
  const distances: number[] = [];
  let venues = 0;
  for (const line of lines) {
    let drawn = false;
    for (const point of line.points) {
      if (point.ts < fromTs) continue;
      for (const px of [point.bid, point.ask]) {
        const d = px === null ? null : quoteDistanceBps(px, point.mid);
        if (d === null) continue;
        distances.push(d);
        drawn = true;
      }
    }
    if (drawn && !line.reference) venues++;
  }
  if (venues < 2) return null;
  distances.sort((a, b) => a - b);
  const m = distances.length >> 1;
  const median = distances.length % 2 ? distances[m] : (distances[m - 1] + distances[m]) / 2;
  return Math.max(OFF_SCALE_FACTOR * median, OFF_SCALE_FLOOR_BPS);
}
