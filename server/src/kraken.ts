import WebSocket from 'ws';
import { crc32 } from 'node:zlib';
import { config } from './config.js';
import type { WalkResult } from './bybit.js';

// Kraken v2 book quantities/prices are JSON numbers. Preserve their decimal
// lexemes: converting through Number drops trailing zeroes required by CRC32.
// https://docs.kraken.com/exchange/guides/websockets/book-checksum-v2
interface Level { price: string; qty: string }
interface Book { bids: Map<number, Level>; asks: Map<number, Level>; snapshot: boolean }
const freshBook = (): Book => ({ bids: new Map(), asks: new Map(), snapshot: false });
const EMPTY: WalkResult = { price: 0, filledBase: 0, filledFull: false };
const DEPTH = 25;

function checksumDigits(value: string): string {
  const [mantissa, exponent] = value.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  const places = whole.length + Number(exponent ?? 0);
  const plain = places <= 0 ? '0'.repeat(-places) + digits
    : places >= digits.length ? digits + '0'.repeat(places - digits.length) : digits;
  return plain.replace(/^0+/, '');
}
function levels(side: Map<number, Level>, ascending: boolean): Level[] {
  return [...side.entries()].sort((a, b) => ascending ? a[0] - b[0] : b[0] - a[0]).map(([, l]) => l);
}

/** USD books for the actual xStocks, plus USD stablecoin crosses. Instrument
 * status gates executable markets (including 24/5 closures). Heartbeats keep
 * an unchanged book alive; disconnects/checksum errors require fresh snapshots.
 * No REST ticker/last-trade substitution for a missing order book. */
export class KrakenFeed {
  private books = new Map<string, Book>();
  private statuses = new Map<string, string>();
  private changes = new Map<string, number>();
  private engineOnline = false;
  private ws?: WebSocket;
  private watchdog?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private backoff = 500;
  private lastMsgTs = 0;

  constructor(private readonly symbols: string[]) {}
  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMsgTs > 30_000) { this.reset(); this.ws?.terminate(); }
    }, 10_000);
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.watchdog); clearTimeout(this.reconnect);
    this.reset(); this.ws?.close();
  }
  private reset(): void {
    this.books.clear(); this.statuses.clear(); this.changes.clear(); this.engineOnline = false;
  }
  private book(symbol: string): Book | undefined {
    if (!this.engineOnline || Date.now() - this.lastMsgTs > 30_000 || this.statuses.get(symbol) !== 'online') return;
    const b = this.books.get(symbol);
    if (b?.snapshot && b.bids.size && b.asks.size) return b;
  }
  mid(symbol: string): number {
    const b = this.book(symbol);
    if (!b) return 0;
    return (Math.max(...b.bids.keys()) + Math.min(...b.asks.keys())) / 2;
  }
  changePct(symbol: string): number { return this.book(symbol) ? this.changes.get(symbol) ?? 0 : 0; }
  walk(symbol: string, side: 'buy' | 'sell', baseSize: number): WalkResult {
    const b = this.book(symbol);
    if (!b || !(baseSize > 0)) return { ...EMPTY };
    let remaining = baseSize, quote = 0, filled = 0;
    for (const l of levels(side === 'buy' ? b.asks : b.bids, side === 'buy')) {
      const take = Math.min(remaining, Number(l.qty));
      quote += take * Number(l.price); filled += take; remaining -= take;
      if (remaining <= 0) break;
    }
    return { price: filled > 0 ? quote / filled : 0, filledBase: filled, filledFull: remaining <= 1e-9 && filled > 0 };
  }
  private connect(): void {
    if (this.stopped) return;
    this.reset(); this.lastMsgTs = Date.now();
    const ws = new WebSocket(config.krakenWs);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'instrument', include_tokenized_assets: true } }));
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: this.symbols, depth: DEPTH } }));
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: this.symbols } }));
    });
    ws.on('message', (buf) => {
      try { this.onMessage(buf.toString()); this.backoff = 500; }
      catch (e) {
        console.warn(`[kraken] ${e instanceof Error ? e.message : 'invalid feed message'}; reconnecting for fresh books`);
        this.reset(); ws.terminate();
      }
    });
    ws.on('error', () => { this.reset(); ws.terminate(); });
    ws.on('close', () => {
      this.reset();
      if (this.stopped) return;
      this.reconnect = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    });
  }
  private onMessage(raw: string): void {
    const msg = JSON.parse(raw, (key: string, value: unknown, ctx?: { source?: string }) =>
      (key === 'price' || key === 'qty') && typeof value === 'number' ? ctx?.source ?? String(value) : value);
    this.lastMsgTs = Date.now();
    if (msg.success === false) throw new Error(`subscription failed: ${String(msg.error)}`);
    if (msg.channel === 'status') { this.engineOnline = msg.data?.[0]?.system === 'online'; return; }
    if (msg.channel === 'instrument') {
      for (const p of msg.data?.pairs ?? []) if (this.symbols.includes(p.symbol) && typeof p.status === 'string') this.statuses.set(p.symbol, p.status);
      return;
    }
    if (msg.channel === 'ticker') {
      for (const t of msg.data ?? []) if (Number.isFinite(t.change_pct)) this.changes.set(t.symbol, t.change_pct);
      return;
    }
    if (msg.channel !== 'book') return;
    for (const d of msg.data ?? []) {
      if (!this.symbols.includes(d.symbol)) continue;
      const b = msg.type === 'snapshot' ? freshBook() : this.books.get(d.symbol);
      if (!b) throw new Error(`book update before snapshot for ${d.symbol}`);
      for (const side of ['asks', 'bids'] as const) {
        for (const l of d[side] ?? []) {
          const price = Number(l.price), qty = Number(l.qty);
          if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 0) throw new Error(`invalid level for ${d.symbol}`);
          if (qty === 0) b[side].delete(price);
          else b[side].set(price, { price: String(l.price), qty: String(l.qty) });
        }
        const ordered = levels(b[side], side === 'asks');
        for (const l of ordered.slice(DEPTH)) b[side].delete(Number(l.price));
      }
      const crcInput = [...levels(b.asks, true).slice(0, 10), ...levels(b.bids, false).slice(0, 10)]
        .map((l) => checksumDigits(l.price) + checksumDigits(l.qty)).join('');
      if (d.checksum === undefined || crc32(crcInput) !== d.checksum) {
        this.books.delete(d.symbol);
        throw new Error(`book checksum mismatch for ${d.symbol}`);
      }
      if (b.asks.size && b.bids.size && Math.max(...b.bids.keys()) >= Math.min(...b.asks.keys())) throw new Error(`crossed book for ${d.symbol}`);
      b.snapshot = true; this.books.set(d.symbol, b);
    }
  }
}
