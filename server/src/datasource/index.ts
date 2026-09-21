import { EventEmitter } from 'node:events';
import type {
  DataSourceMode, DepthSnapshot, MarketState, QuoteSnapshot, Fill, DailyVolume, StreamMessage,
  LeaderboardResponse, GasResponse, QuoteStatsResponse,
} from '@shared';
import { QUOTE_CHART_WINDOW_MS } from '@shared';
import { ExecutionHistory } from '../execution-history.js';
import { computeLeaderboard } from '../analytics.js';

/**
 * A DataSource produces the entire dashboard data model and streams updates.
 * LiveDataSource builds it from Monad RPC + Bybit; SimDataSource simulates it.
 * The server and frontend are identical across both (single-service — docs/architecture.md: system shape).
 */
export interface DataSource {
  readonly mode: DataSourceMode;
  start(): Promise<void>;
  stop(): void | Promise<void>;
  getState(): MarketState;
  /** False until persisted history is available to dashboard snapshots. */
  isReady?(): boolean;
  getQuotes(): QuoteSnapshot;
  /** Wait for a complete collected matrix; never opens additional RPC work. */
  fullQuoteSnapshot?(fresh?: boolean): Promise<QuoteSnapshot>;
  /** Whether the current frame completed every requested adapter. */
  quoteSnapshotComplete?(): boolean;
  getFills(): Fill[];
  getVolume(): DailyVolume[];
  /** Historical fills query (DB-backed for live, in-memory for sim). */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[];
  /** Aggregated leaderboard/markout stats over the FULL window — computed here,
   *  next to the rows, because shipping raw fills truncated the wide windows.
   *  Async: the pass yields to the event loop (hundreds of thousands of rows
   *  at 30d must not stall the quote stream). */
  leaderboard(days: number): Promise<LeaderboardResponse>;
  /** The last ~60s of REAL quote ticks for one (market, size) — seeds the
   *  Execution chart so it never fabricates history (flat pre-fill). */
  quoteHistory(market: string, size: number): QuoteSnapshot[];
  quoteStats(market: string, size: number): QuoteStatsResponse;
  /** QUOTE_UPDATE_BURN: per-venue quote-update gas per UTC day (Volume tab). */
  gasSeries(): GasResponse;
  /** Last completed high-resolution depth snapshot, already serialized so an
   *  arbitrary number of viewers do not repeat JSON work on the main loop. */
  getDepth(market: string): DepthPublication | undefined;
  /** Demand-driven updates. The first watcher activates computation; the last
   *  disposer stops it. Multiple viewers never multiply adapter/RPC work. */
  watchDepth(market: string, cb: (publication: DepthPublication) => void): () => void;
  on(ev: 'message', cb: (m: StreamMessage) => void): this;
  off(ev: 'message', cb: (m: StreamMessage) => void): this;
}

export interface DepthPublication {
  /** Internal worker timings; the public stream forwards only `json`. */
  headObservedAt?: number;
  computeMs?: number;
  incompleteVenues?: string[];
  market: string;
  asOfBlock: number;
  ts: number;
  json: string;
}

/** Quote history is retained by wall time, not sample count: live quotes now
 *  arrive per block (~300ms) while the simulator still ticks at 500ms. */
export const QUOTE_HISTORY_MS = QUOTE_CHART_WINDOW_MS;

export abstract class BaseSource extends EventEmitter implements DataSource {
  abstract readonly mode: DataSourceMode;
  abstract start(): Promise<void>;
  abstract stop(): void | Promise<void>;
  abstract getState(): MarketState;
  abstract getQuotes(): QuoteSnapshot;
  abstract getFills(): Fill[];
  abstract getVolume(): DailyVolume[];

  private readonly executionHistory = new ExecutionHistory();

  private depthLatest = new Map<string, DepthPublication>();
  private depthWatchers = new Map<string, Set<(publication: DepthPublication) => void>>();

  /** Default: aggregate the in-memory fill window (sim). Live overrides with a
   *  keyset-paged SQLite scan + TTL cache. */
  leaderboard(days: number): Promise<LeaderboardResponse> {
    const now = Date.now();
    const since = now - days * 86_400_000;
    const rows = this.getFills()
      .filter((f) => !f.pxApprox && f.ts >= since && f.ts <= now)
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const makePass = () => {
      let i = 0;
      return () => rows.slice(i, (i += 5000));
    };
    return computeLeaderboard(makePass, days, now, (ids) => {
      const want = new Set(ids);
      return this.getFills().filter((f) => want.has(f.id));
    });
  }

  /** Default: no gas series. Live reads daily_gas; sim synthesizes one. */
  gasSeries(): GasResponse { return { days: [], approx: [] }; }

  getDepth(market: string): DepthPublication | undefined { return this.depthLatest.get(market); }

  watchDepth(market: string, cb: (publication: DepthPublication) => void): () => void {
    let watchers = this.depthWatchers.get(market);
    const first = !watchers?.size;
    if (!watchers) { watchers = new Set(); this.depthWatchers.set(market, watchers); }
    watchers.add(cb);
    const current = this.depthLatest.get(market);
    if (current) cb(current);
    if (first) this.onDepthDemand(market, true);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const active = this.depthWatchers.get(market);
      active?.delete(cb);
      if (active?.size) return;
      this.depthWatchers.delete(market);
      this.onDepthDemand(market, false);
    };
  }

  /** Source-specific demand hook: live forwards it to the isolated worker; sim
   *  computes locally because its curve is arithmetic-only. */
  protected onDepthDemand(_market: string, _active: boolean): void {}

  protected publishDepth(snapshot: DepthSnapshot, json = JSON.stringify(snapshot)): void {
    this.publishDepthPublication({ market: snapshot.market, asOfBlock: snapshot.asOfBlock, ts: snapshot.ts, json });
  }

  /** Worker results arrive pre-serialized. Keeping that string intact is what
   *  makes main-process fanout independent of curve size and viewer count. */
  protected publishDepthPublication(publication: DepthPublication): void {
    this.depthLatest.set(publication.market, publication);
    for (const cb of this.depthWatchers.get(publication.market) ?? []) cb(publication);
  }

  protected depthDemandedMarkets(): string[] { return [...this.depthWatchers.keys()]; }

  /** Default: filter the in-memory window. Live overrides with a DB query. */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : undefined;
    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
    const limit = Math.min(Math.floor(rawLimit), 50_000);
    let fills = this.getFills();
    if (sinceMs != null) fills = fills.filter((f) => f.ts >= sinceMs);
    return [...fills].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /** Collection is continuous; history and aggregates are shared by all readers. */
  quoteHistory(market: string, size: number): QuoteSnapshot[] {
    return this.executionHistory.history(market, size);
  }

  quoteStats(market: string, size: number): QuoteStatsResponse {
    return this.executionHistory.stats(market, size);
  }

  protected invalidateQuoteHistory(fromBlock: number, revision?: number): void {
    this.executionHistory.invalidate(fromBlock, revision);
  }

  protected clearExecutionHistory(): void { this.executionHistory.clear(); }

  protected emitMsg(m: StreamMessage): void {
    if (m.ch === 'quotes') this.executionHistory.record(m.data);
    this.emit('message', m);
  }
}
