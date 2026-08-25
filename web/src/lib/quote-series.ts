import type { QuoteSnapshot } from '@shared';

export interface QuotePoint {
  block: number;
  ts: number;
  bid: number | null;
  ask: number | null;
}

export interface QuoteSeries {
  points: QuotePoint[];
}

export const quoteFrameTime = (q: QuoteSnapshot): number => q.frame?.emittedAt ?? q.ts;

/** Append one real frame for every venue. Missing rows/sides become nulls so
 *  every series shares one time axis and the canvas can show the absence. */
export function appendQuoteSnapshot(
  series: Record<string, QuoteSeries>,
  venueIds: readonly string[],
  q: QuoteSnapshot,
  market: string,
  size: number,
  windowMs = 60_000,
  maxPoints = 400,
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
