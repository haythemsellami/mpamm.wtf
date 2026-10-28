import WebSocket from 'ws';
import { config } from './config.js';

/**
 * Bybit V5 spot feed for MONUSDT (docs/architecture.md: pair-terms reference + CEX feeds).
 *
 * Maintains a snapshot+delta order book and the BBO, exposes:
 *  - mid()                  → (bestBid+bestAsk)/2, the fee-agnostic reference
 *  - monUsd()               → USD price of MON (USDT pegged $1)
 *  - walk(side, baseSize)   → realized price for trading `baseSize` MON as taker
 *
 * Public WS is not rate-limited; on reconnect we re-snapshot the book.
 */

export interface WalkResult {
  /** realized quote-per-base (USDT per MON), pre-fee. */
  price: number;
  /** base actually filled before the book exhausted. */
  filledBase: number;
  filledFull: boolean;
}

type Level = [price: number, size: number];

/** Take `baseSize` base units from price-ordered levels, best first: the
 *  VWAP of what filled, how much did, and whether all of it. `fallback` is
 *  the price when nothing fills (each feed's own choice). The one taker walk
 *  every CEX feed uses. */
export function walkLevels(levels: Iterable<readonly [price: number, size: number]>, baseSize: number, fallback: number): WalkResult {
  let remaining = baseSize, quote = 0, filled = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, size);
    quote += take * price; filled += take; remaining -= take;
  }
  return { price: filled > 0 ? quote / filled : fallback, filledBase: filled, filledFull: remaining <= 1e-9 && filled > 0 };
}

export class BybitFeed {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private bestBid = 0;
  private bestAsk = 0;
  private last = 0;
  private chgPct = 0;
  /** BBO mids of extra CROSS symbols (e.g. USDCUSDT) — tickers-only, no book. */
  private crossMids = new Map<string, { bid: number; ask: number; last: number }>();
  private ws?: WebSocket;
  private backoff = 500;
  private stopped = false;
  private watchdog?: ReturnType<typeof setInterval>;
  ready = false;
  lastMsgTs = 0;

  /** A book that stops TICKING is worse than one that disconnects: a half-open
   *  TCP connection keeps the last mids "fresh" forever and every downstream
   *  number (markout anchors, quote comparisons) silently drifts. Reads return
   *  0 (unavailable — pairs hide, markouts stay null) once no message has
   *  arrived for STALE_MS, and the watchdog force-terminates the socket so the
   *  normal reconnect + re-snapshot path runs. */
  private static readonly STALE_MS = 30_000;
  private fresh(): boolean { return Date.now() - this.lastMsgTs <= BybitFeed.STALE_MS; }

  /** `crossSymbols`: additional spot symbols to track at BBO/mid level (used to
   *  convert the USDT-quoted reference into a pair's stable terms, docs/architecture.md: pair-terms reference). */
  constructor(private readonly crossSymbols: string[] = []) {
    for (const s of crossSymbols) this.crossMids.set(s.toUpperCase(), { bid: 0, ask: 0, last: 0 });
  }

  async start(): Promise<void> {
    await this.snapshotRest().catch(() => undefined);
    this.lastMsgTs = Date.now(); // grace: don't declare stale before the first message
    this.connect();
    this.watchdog = setInterval(() => {
      if (!this.stopped && !this.fresh()) { this.lastMsgTs = Date.now(); this.ws?.terminate(); }
    }, 10_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  // ── public reads ─────────────────────────────────────────────────────────
  mid(): number {
    if (!this.fresh()) return 0; // frozen book = unavailable, never "current"
    if (this.bestBid && this.bestAsk) return (this.bestBid + this.bestAsk) / 2;
    return this.last || this.bestBid || this.bestAsk || 0;
  }
  monUsd(): number {
    return this.mid(); // USDT ≈ $1
  }
  changePct(): number {
    return this.chgPct;
  }
  /** BBO mid of a tracked cross symbol (0 until its ticker is warm). */
  crossMid(symbol: string): number {
    if (!this.fresh()) return 0; // frozen cross = unavailable (pair hides)
    const c = this.crossMids.get(symbol.toUpperCase());
    if (!c) return 0;
    if (c.bid && c.ask) return (c.bid + c.ask) / 2;
    return c.last || c.bid || c.ask || 0;
  }

  /** Walk the maintained book for `baseSize` MON. side='buy' consumes asks
   *  (taker buys MON), side='sell' consumes bids (taker sells MON). */
  walk(side: 'buy' | 'sell', baseSize: number): WalkResult {
    if (!this.fresh()) return { price: 0, filledBase: 0, filledFull: false }; // frozen book ⇒ no reference row
    const levels: Level[] = side === 'buy'
      ? [...this.asks.entries()].sort((a, b) => a[0] - b[0])
      : [...this.bids.entries()].sort((a, b) => b[0] - a[0]);
    return walkLevels(levels, baseSize, this.mid());
  }

  // ── REST cold-start ───────────────────────────────────────────────────────
  private async snapshotRest(): Promise<void> {
    const url = `${config.bybitRest}/v5/market/orderbook?category=spot&symbol=${config.bybitSymbol}&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json: any = await res.json();
    const d = json?.result;
    if (!d) return;
    this.applySnapshot(d.b ?? [], d.a ?? []);
    // seed last price
    try {
      const t = await fetch(`${config.bybitRest}/v5/market/tickers?category=spot&symbol=${config.bybitSymbol}`, { signal: AbortSignal.timeout(8000) });
      const tj: any = await t.json();
      const row = tj?.result?.list?.[0];
      if (row) {
        this.last = Number(row.lastPrice) || this.last;
        this.chgPct = (Number(row.price24hPcnt) || 0) * 100;
      }
    } catch { /* non-fatal */ }
    // seed the cross-symbol mids (WS tickers keep them fresh after this)
    await Promise.all(this.crossSymbols.map(async (s) => {
      try {
        const t = await fetch(`${config.bybitRest}/v5/market/tickers?category=spot&symbol=${s.toUpperCase()}`, { signal: AbortSignal.timeout(8000) });
        const tj: any = await t.json();
        const row = tj?.result?.list?.[0];
        if (row) this.crossMids.set(s.toUpperCase(), { bid: Number(row.bid1Price) || 0, ask: Number(row.ask1Price) || 0, last: Number(row.lastPrice) || 0 });
      } catch { /* non-fatal — stays 0 until WS warms it */ }
    }));
  }

  // ── WS ────────────────────────────────────────────────────────────────────
  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(config.bybitWs);
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 500;
      const args = [`orderbook.50.${config.bybitSymbol}`, `tickers.${config.bybitSymbol}`, ...this.crossSymbols.map((s) => `tickers.${s.toUpperCase()}`)];
      ws.send(JSON.stringify({ op: 'subscribe', args }));
      // 20s heartbeat keeps the public stream alive
      const hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 'ping' })); } catch { /* ignore */ } }, 20_000);
      ws.on('close', () => clearInterval(hb));
    });
    ws.on('message', (buf) => this.onMessage(buf.toString()));
    ws.on('error', () => ws.close());
    ws.on('close', () => {
      if (this.stopped) return;
      this.ready = false;
      this.backoff = Math.min(this.backoff * 2, 15_000);
      setTimeout(() => { this.snapshotRest().catch(() => undefined).finally(() => this.connect()); }, this.backoff);
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    this.lastMsgTs = Date.now();
    const topic: string | undefined = msg.topic;
    if (!topic) return;
    if (topic.startsWith('orderbook')) {
      const d = msg.data;
      if (msg.type === 'snapshot') this.applySnapshot(d.b ?? [], d.a ?? []);
      else this.applyDelta(d.b ?? [], d.a ?? []);
      this.recomputeBbo();
      this.ready = true;
    } else if (topic.startsWith('tickers')) {
      const d = msg.data ?? {};
      const sym = topic.slice('tickers.'.length).toUpperCase();
      if (sym && sym !== config.bybitSymbol.toUpperCase() && this.crossMids.has(sym)) {
        // a cross symbol (e.g. USDCUSDT) — track its BBO mid only
        const c = this.crossMids.get(sym)!;
        if (d.bid1Price) c.bid = Number(d.bid1Price);
        if (d.ask1Price) c.ask = Number(d.ask1Price);
        if (d.lastPrice) c.last = Number(d.lastPrice);
        return;
      }
      if (d.lastPrice) this.last = Number(d.lastPrice);
      if (d.price24hPcnt !== undefined) this.chgPct = Number(d.price24hPcnt) * 100;
      if (d.bid1Price) this.bestBid = Number(d.bid1Price);
      if (d.ask1Price) this.bestAsk = Number(d.ask1Price);
    }
  }

  private applySnapshot(b: string[][], a: string[][]): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of b) this.bids.set(Number(p), Number(s));
    for (const [p, s] of a) this.asks.set(Number(p), Number(s));
    this.recomputeBbo();
  }

  private applyDelta(b: string[][], a: string[][]): void {
    for (const [p, s] of b) {
      const price = Number(p), size = Number(s);
      if (size === 0) this.bids.delete(price); else this.bids.set(price, size);
    }
    for (const [p, s] of a) {
      const price = Number(p), size = Number(s);
      if (size === 0) this.asks.delete(price); else this.asks.set(price, size);
    }
  }

  private recomputeBbo(): void {
    let hb = 0;
    for (const p of this.bids.keys()) if (p > hb) hb = p;
    let la = Infinity;
    for (const p of this.asks.keys()) if (p < la) la = p;
    if (hb) this.bestBid = hb;
    if (Number.isFinite(la)) this.bestAsk = la;
  }
}
