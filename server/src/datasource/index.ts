import { EventEmitter } from 'node:events';
import type {
  DataSourceMode, DepthSnapshot, MarketState, QuoteSnapshot, Fill, DailyVolume, StreamMessage,
  LeaderboardResponse, GasResponse,
} from '@shared';
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
  getQuotes(): QuoteSnapshot;
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
  /** QUOTE_UPDATE_BURN: per-venue quote-update gas per UTC day (Volume tab). */
  gasSeries(): GasResponse;
  /** BID_ASK_DEPTH: every venue's executable-spread curve for one market over
   *  the log-spaced notional grid. On demand (not streamed) — a pass costs
   *  several times a quote frame, so it only runs while somebody is looking. */
  depth(market: string): Promise<DepthSnapshot>;
  on(ev: 'message', cb: (m: StreamMessage) => void): this;
  off(ev: 'message', cb: (m: StreamMessage) => void): this;
}

/** Quote history is retained by wall time, not sample count: live quotes now
 *  arrive per block (~300ms) while the simulator still ticks at 500ms. */
const QUOTE_HISTORY_MS = 60_000;
const QUOTE_HISTORY_MAX = 400; // safety cap if timestamps regress or cadence changes

export abstract class BaseSource extends EventEmitter implements DataSource {
  abstract readonly mode: DataSourceMode;
  abstract start(): Promise<void>;
  abstract stop(): void | Promise<void>;
  abstract getState(): MarketState;
  abstract getQuotes(): QuoteSnapshot;
  abstract getFills(): Fill[];
  abstract getVolume(): DailyVolume[];

  /** Rolling wall-time ring of broadcast quote matrices — recorded at the
   *  emitMsg choke point so live + sim get it identically for free. */
  private quoteHist: QuoteSnapshot[] = [];

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

  /** Default: no curves. Live samples the adapters over the depth grid; sim
   *  evaluates its own quote model there. An empty `venues` renders as an empty
   *  panel, which is the honest output for a source that cannot produce one. */
  async depth(market: string): Promise<DepthSnapshot> {
    return { market, asOfBlock: this.getQuotes().block, refMid: 0, ts: Date.now(), venues: [] };
  }

  /** Default: filter the in-memory window. Live overrides with a DB query. */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : undefined;
    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
    const limit = Math.min(Math.floor(rawLimit), 50_000);
    let fills = this.getFills();
    if (sinceMs != null) fills = fills.filter((f) => f.ts >= sinceMs);
    return [...fills].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /** The retained ticks filtered to one (market, size) — oldest first, ready to
   *  replay into the chart buffer. Empty until the first poll after boot. */
  quoteHistory(market: string, size: number): QuoteSnapshot[] {
    const out: QuoteSnapshot[] = [];
    for (const q of this.quoteHist) {
      const rows = q.rows.filter((r) => r.market === market && r.sizeUsd === size);
      // Keep the frame even when every selected row is absent. Its block/time
      // is the evidence of a real quote cycle, and lets the chart draw a gap
      // instead of compressing the missing interval out of history.
      out.push({ ...q, rows });
    }
    return out;
  }

  protected emitMsg(m: StreamMessage): void {
    if (m.ch === 'quotes') {
      // live/sim both replace the matrix wholesale each poll (never mutate a
      // broadcast one), so retaining by reference is safe.
      this.quoteHist.push(m.data);
      const cutoff = m.data.ts - QUOTE_HISTORY_MS;
      while (this.quoteHist.length > 1 && this.quoteHist[0].ts < cutoff) this.quoteHist.shift();
      while (this.quoteHist.length > QUOTE_HISTORY_MAX) this.quoteHist.shift();
    }
    this.emit('message', m);
  }
}
