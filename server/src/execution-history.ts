import {
  MARKETS, SIZES_USD, QUOTE_CHART_WINDOW_MS, QUOTE_STATS_WINDOW_MS,
  type QuoteSnapshot, type QuoteStatsResponse, type QuoteStatsRow,
} from '@shared';

export const SPREAD_RETENTION_MS = 360_000;
const STATS_CACHE_MS = 1_000;
const scopeKey = (market: string, size: number) => `${market}|${size}`;
type SpreadFrame = { block: number; ts: number; values: Float64Array };

/** Full matrices age out with the chart. Only numeric column/spread pairs live
 * for six minutes: retaining six minutes of QuoteRow objects would multiply
 * the indexer's heap for data no browser needs. Column identities are shared
 * across frames and bounded by the registered venue/market/size universe. */
export class ExecutionHistory {
  private quotes: QuoteSnapshot[] = [];
  private spreads: SpreadFrame[] = [];
  private columns = new Map<string, Map<string, number>>();
  private columnCount = 0;
  private cache = new Map<string, QuoteStatsResponse>();
  private expiry?: ReturnType<typeof setTimeout>;
  private revision = 0;

  record(quote: QuoteSnapshot): void {
    const ts = quote.frame?.emittedAt ?? quote.ts;
    const revision = quote.revision ?? 0;
    if (!Number.isFinite(ts) || revision < this.revision) return;
    const last = this.spreads.at(-1);
    if (last && quote.block < last.block && revision === this.revision) return;
    if (last && (quote.block === last.block || revision > this.revision)) this.invalidate(quote.block, revision);
    this.revision = revision;
    const values: number[] = [];
    for (const row of quote.rows) {
      if (!MARKETS.includes(row.market) || !(SIZES_USD as readonly number[]).includes(row.sizeUsd)
        || !row.filledFull || row.oneSided || !(row.bidPx > 0) || !(row.askPx > 0)
        || !Number.isFinite(row.bidPx) || !Number.isFinite(row.askPx) || !Number.isFinite(row.spreadBps)) continue;
      const key = scopeKey(row.market, row.sizeUsd);
      let columns = this.columns.get(key);
      if (!columns) { columns = new Map(); this.columns.set(key, columns); }
      let column = columns.get(row.venueId);
      if (column === undefined) { column = this.columnCount++; columns.set(row.venueId, column); }
      values.push(column, row.spreadBps);
    }
    this.quotes.push(quote);
    this.spreads.push({ block: quote.block, ts, values: Float64Array.from(values) });
    this.prune();
    this.scheduleExpiry();
  }

  history(market: string, size: number): QuoteSnapshot[] {
    const now = Date.now();
    this.prune(now);
    return this.quotes.filter((q) => (q.frame?.emittedAt ?? q.ts) <= now).map((q) => ({
      ...q, rows: q.rows.filter((r) => r.market === market && r.sizeUsd === size),
    }));
  }

  stats(market: string, size: number): QuoteStatsResponse {
    const now = Date.now();
    this.prune(now);
    const key = scopeKey(market, size);
    const cached = this.cache.get(key);
    if (cached && cached.asOf <= now && Math.floor(now / STATS_CACHE_MS) === Math.floor(cached.asOf / STATS_CACHE_MS)) return cached;
    const columns = this.columns.get(key);
    const samples = new Map<number, number[]>();
    for (const column of columns?.values() ?? []) samples.set(column, []);
    if (columns) {
      for (const frame of this.spreads) {
        if (frame.ts <= now - QUOTE_STATS_WINDOW_MS || frame.ts > now) continue;
        for (let i = 0; i < frame.values.length; i += 2) samples.get(frame.values[i])?.push(frame.values[i + 1]);
      }
    }
    const rows: QuoteStatsRow[] = [];
    for (const [venueId, column] of columns ?? []) {
      const values = samples.get(column)!;
      const n = values.length;
      if (!n) continue;
      values.sort((a, b) => a - b);
      // Match the shared interpolated percentile convention, sorting once
      // for all five columns. Standard deviation uses the whole population.
      const percentile = (p: number) => {
        const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
        return values[lo] + (values[hi] - values[lo]) * (i - lo);
      };
      const avg = values.reduce((sum, value) => sum + value, 0) / n;
      const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / n);
      rows.push({ venueId, n, p5: percentile(.05), p25: percentile(.25), p50: percentile(.5),
        p75: percentile(.75), p95: percentile(.95), avg, sd });
    }
    const result = { market, sizeUsd: size, asOf: now, windowMs: QUOTE_STATS_WINDOW_MS, revision: this.revision, rows };
    // Invalid/never-collected selections cannot grow a cache through REST.
    if (columns) this.cache.set(key, result);
    return result;
  }

  invalidate(fromBlock: number, revision = this.revision): void {
    this.quotes = this.quotes.filter((q) => q.block < fromBlock);
    this.spreads = this.spreads.filter((q) => q.block < fromBlock);
    this.revision = revision;
    this.cache.clear();
  }

  clear(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.quotes = []; this.spreads = []; this.columns.clear(); this.cache.clear(); this.columnCount = 0; this.revision = 0;
  }

  private prune(now = Date.now()): void {
    this.quotes = this.quotes.filter((q) => (q.frame?.emittedAt ?? q.ts) > now - QUOTE_CHART_WINDOW_MS);
    this.spreads = this.spreads.filter((q) => q.ts > now - SPREAD_RETENTION_MS);
    for (const [key, cached] of this.cache) if (now - cached.asOf >= STATS_CACHE_MS) this.cache.delete(key);
    if (!this.spreads.length) { this.columns.clear(); this.columnCount = 0; this.cache.clear(); }
  }

  private scheduleExpiry(): void {
    if (this.expiry || !this.spreads.length) return;
    // Expiry must keep running through an upstream outage, even with no reads.
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      this.prune();
      this.scheduleExpiry();
    }, 1_000);
    this.expiry.unref();
  }
}
