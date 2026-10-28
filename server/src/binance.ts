import WebSocket from 'ws';
import { config } from './config.js';
import { walkLevels, type WalkResult } from './bybit.js';

/**
 * Binance spot feed — the CEX reference for non-MON assets (BTC/ETH). Multi-symbol
 * (BTCUSDT, ETHUSDT, …); mirrors the BybitFeed API but keyed by symbol:
 *  - mid(symbol) / assetUsd(symbol)  → BBO mid (USDT ≈ $1)
 *  - walk(symbol, side, baseSize)    → realized taker price for `baseSize` base
 *
 * Uses the partial-book depth stream (`@depth20@100ms`, a full snapshot each push
 * → just replace the book) + `@bookTicker` for the BBO. Public WS, no key needed.
 */

type Level = [price: number, size: number];
interface Book { bids: Map<number, number>; asks: Map<number, number>; bestBid: number; bestAsk: number; last: number; chgPct: number; }
const freshBook = (): Book => ({ bids: new Map(), asks: new Map(), bestBid: 0, bestAsk: 0, last: 0, chgPct: 0 });

export class BinanceFeed {
  private books = new Map<string, Book>(); // keyed by UPPERCASE symbol
  private ws?: WebSocket;
  private backoff = 500;
  private stopped = false;
  private watchdog?: ReturnType<typeof setInterval>;
  ready = false;
  lastMsgTs = 0;

  /** see BybitFeed: a frozen-but-connected book must read as UNAVAILABLE, not
   *  current. This feed had no liveness signal at all — a half-open socket
   *  froze BTC/ETH mids indefinitely with nothing to notice. */
  private static readonly STALE_MS = 30_000;
  private fresh(): boolean { return Date.now() - this.lastMsgTs <= BinanceFeed.STALE_MS; }

  constructor(private readonly symbols: string[]) {
    for (const s of symbols) this.books.set(s.toUpperCase(), freshBook());
  }

  async start(): Promise<void> {
    await Promise.all(this.symbols.map((s) => this.snapshotRest(s).catch(() => undefined)));
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

  has(symbol: string): boolean { return this.books.has(symbol.toUpperCase()); }
  mid(symbol: string): number {
    if (!this.fresh()) return 0; // frozen book = unavailable, never "current"
    const b = this.books.get(symbol.toUpperCase());
    if (!b) return 0;
    if (b.bestBid && b.bestAsk) return (b.bestBid + b.bestAsk) / 2;
    return b.last || b.bestBid || b.bestAsk || 0;
  }
  assetUsd(symbol: string): number { return this.mid(symbol); } // USDT ≈ $1
  changePct(symbol: string): number { return this.books.get(symbol.toUpperCase())?.chgPct ?? 0; }

  /** Walk the maintained book for `baseSize` base units. side='buy' consumes asks. */
  walk(symbol: string, side: 'buy' | 'sell', baseSize: number): WalkResult {
    if (!this.fresh()) return { price: 0, filledBase: 0, filledFull: false }; // frozen book ⇒ no reference row
    const b = this.books.get(symbol.toUpperCase());
    if (!b) return { price: 0, filledBase: 0, filledFull: false };
    const levels: Level[] = side === 'buy'
      ? [...b.asks.entries()].sort((x, y) => x[0] - y[0])
      : [...b.bids.entries()].sort((x, y) => y[0] - x[0]);
    return walkLevels(levels, baseSize, this.mid(symbol));
  }

  // ── REST cold-start ─────────────────────────────────────────────────────────
  private async snapshotRest(symbol: string): Promise<void> {
    const U = symbol.toUpperCase();
    const b = this.books.get(U);
    if (!b) return;
    const j: any = await (await fetch(`${config.binanceRest}/api/v3/depth?symbol=${U}&limit=20`, { signal: AbortSignal.timeout(8000) })).json();
    b.bids.clear(); b.asks.clear();
    for (const [p, s] of j?.bids ?? []) b.bids.set(Number(p), Number(s));
    for (const [p, s] of j?.asks ?? []) b.asks.set(Number(p), Number(s));
    this.recompute(b);
    try {
      const t: any = await (await fetch(`${config.binanceRest}/api/v3/ticker/24hr?symbol=${U}`, { signal: AbortSignal.timeout(8000) })).json();
      if (t) { b.last = Number(t.lastPrice) || b.last; b.chgPct = Number(t.priceChangePercent) || 0; }
    } catch { /* non-fatal */ }
  }

  // ── WS (combined stream) ──────────────────────────────────────────────────────
  private connect(): void {
    if (this.stopped) return;
    const streams = this.symbols.flatMap((s) => [`${s.toLowerCase()}@depth20@100ms`, `${s.toLowerCase()}@bookTicker`]).join('/');
    const ws = new WebSocket(`${config.binanceWs}/stream?streams=${streams}`);
    this.ws = ws;
    ws.on('open', () => { this.backoff = 500; });
    ws.on('message', (buf) => this.onMessage(buf.toString()));
    ws.on('error', () => ws.close());
    ws.on('close', () => {
      if (this.stopped) return;
      this.ready = false;
      this.backoff = Math.min(this.backoff * 2, 15_000);
      setTimeout(() => { Promise.all(this.symbols.map((s) => this.snapshotRest(s).catch(() => undefined))).finally(() => this.connect()); }, this.backoff);
    });
  }

  private onMessage(raw: string): void {
    this.lastMsgTs = Date.now();
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const stream: string | undefined = msg.stream;
    const data = msg.data;
    if (!stream || !data) return;
    const [symLower, kind] = stream.split('@');
    const b = this.books.get(symLower.toUpperCase());
    if (!b) return;
    if (kind?.startsWith('depth')) {
      b.bids.clear(); b.asks.clear();
      for (const [p, s] of data.bids ?? []) b.bids.set(Number(p), Number(s));
      for (const [p, s] of data.asks ?? []) b.asks.set(Number(p), Number(s));
      this.recompute(b);
      this.ready = true;
    } else if (kind === 'bookTicker') {
      if (data.b) b.bestBid = Number(data.b);
      if (data.a) b.bestAsk = Number(data.a);
    }
  }

  private recompute(b: Book): void {
    let hb = 0; for (const p of b.bids.keys()) if (p > hb) hb = p;
    let la = Infinity; for (const p of b.asks.keys()) if (p < la) la = p;
    if (hb) b.bestBid = hb;
    if (Number.isFinite(la)) b.bestAsk = la;
  }
}
