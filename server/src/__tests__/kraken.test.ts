import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { crc32 } from 'node:zlib';
import { KrakenFeed } from '../kraken.js';

const messages: string[] = JSON.parse(readFileSync(new URL('./fixtures/kraken-books.json', import.meta.url), 'utf8')).messages;
const symbols = [...new Set(messages.map((m) => JSON.parse(m).data[0].symbol))] as string[];
const status = (f: KrakenFeed, symbol: string, state = 'online') => (f as any).onMessage(JSON.stringify({ channel: 'instrument', data: { pairs: [{ symbol, status: state }] } }));
function feed() {
  const f = new KrakenFeed(symbols);
  (f as any).onMessage('{"channel":"status","data":[{"system":"online"}]}');
  for (const s of symbols) status(f, s);
  return f;
}
afterEach(() => vi.useRealTimers());

describe('Kraken token books', () => {
  it('replays real snapshots and incremental updates with exact-decimal checksums', () => {
    const f = feed();
    for (const raw of messages) (f as any).onMessage(raw);
    for (const symbol of symbols) {
      expect(f.mid(symbol)).toBeGreaterThan(0);
      const buy = f.walk(symbol, 'buy', 0.01), sell = f.walk(symbol, 'sell', 0.01);
      expect(buy.price).toBeGreaterThan(f.mid(symbol));
      expect(sell.price).toBeLessThan(f.mid(symbol));
      expect(buy.filledFull && sell.filledFull).toBe(true);
    }
  });
  it('invalidates a corrupted book instead of serving its last good price', () => {
    const f = feed();
    const first = messages[0];
    (f as any).onMessage(first);
    const sym = JSON.parse(first).data[0].symbol;
    expect(f.mid(sym)).toBeGreaterThan(0);
    expect(() => (f as any).onMessage(first.replace(/"checksum":\s*\d+/, '"checksum":0'))).toThrow('checksum mismatch');
    expect(f.mid(sym)).toBe(0);
  });
  it('honors market/engine status, heartbeat liveness, and reset until a new snapshot', () => {
    vi.useFakeTimers();
    const f = feed(), first = messages[0], sym = JSON.parse(first).data[0].symbol;
    (f as any).onMessage(first);
    status(f, sym, 'cancel_only'); expect(f.mid(sym)).toBe(0);
    status(f, sym); expect(f.mid(sym)).toBeGreaterThan(0);
    vi.advanceTimersByTime(29_000); (f as any).onMessage('{"channel":"heartbeat"}');
    vi.advanceTimersByTime(29_000); expect(f.mid(sym)).toBeGreaterThan(0);
    vi.advanceTimersByTime(2_000); expect(f.mid(sym)).toBe(0);
    (f as any).onMessage('{"channel":"heartbeat"}');
    (f as any).onMessage('{"channel":"status","data":[{"system":"maintenance"}]}');
    expect(f.mid(sym)).toBe(0);
    (f as any).reset(); status(f, sym);
    (f as any).onMessage('{"channel":"status","data":[{"system":"online"}]}');
    expect(f.mid(sym)).toBe(0);
  });
  it('applies repeated levels sequentially, deletes zero quantities, preserves decimal zeros and walks finite depth', () => {
    const f = feed(), sym = symbols[0];
    // 10.00*2.000 and 9.00*3.000 preserve all trailing zeroes in CRC input.
    const snapshot = `{"channel":"book","type":"snapshot","data":[{"symbol":"${sym}","asks":[{"price":10.00,"qty":2.000}],"bids":[{"price":9.00,"qty":3.000}],"checksum":${crc32('100020009003000')}}]}`;
    (f as any).onMessage(snapshot);
    expect(f.walk(sym, 'buy', 3)).toEqual({ price: 10, filledBase: 2, filledFull: false });
    const update = `{"channel":"book","type":"update","data":[{"symbol":"${sym}","asks":[{"price":10.00,"qty":0},{"price":11.00,"qty":4.000},{"price":11.00,"qty":1.000}],"checksum":${crc32('110010009003000')}}]}`;
    (f as any).onMessage(update);
    expect(f.mid(sym)).toBe(10);
    expect(f.walk(sym, 'buy', 2)).toEqual({ price: 11, filledBase: 1, filledFull: false });
  });
  // A fill that settled on-chain while the market was closed is still valued:
  // never by a reference (mid/walk stay 0), only by settledMid.
  it('keeps the last validated mid for settled fills through a closure and a reset', () => {
    const f = feed(), first = messages[0], sym = JSON.parse(first).data[0].symbol;
    (f as any).onMessage(first);
    const open = f.mid(sym);
    expect(open).toBeGreaterThan(0);
    expect(f.settledMid(sym)).toBe(open);
    status(f, sym, 'cancel_only');
    expect(f.mid(sym)).toBe(0);
    expect(f.walk(sym, 'buy', 1).price).toBe(0);
    expect(f.settledMid(sym)).toBe(open);
    (f as any).reset();
    expect(f.settledMid(sym)).toBe(open);
  });
  it("falls back to the ticker's last trade when no book was ever open", () => {
    const f = feed(), sym = symbols[0];
    expect(f.settledMid(sym)).toBe(0);
    (f as any).onMessage(JSON.stringify({ channel: 'ticker', type: 'snapshot', data: [{ symbol: sym, last: 770.5, change_pct: 0.1 }] }));
    expect(f.mid(sym)).toBe(0);
    expect(f.settledMid(sym)).toBe(770.5);
    expect(f.settledMid('NOT/LISTED')).toBe(0);
  });
  it("leaves the other books up when Kraken rejects one symbol's subscription", () => {
    const f = feed();
    for (const raw of messages) (f as any).onMessage(raw);
    const [rejected, ...others] = symbols;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => (f as any).onMessage(JSON.stringify({ method: 'subscribe', success: false, error: `Currency pair not supported ${rejected}`, symbol: rejected }))).not.toThrow();
    expect(f.mid(rejected)).toBe(0);
    for (const s of others) expect(f.mid(s)).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  // A closure Kraken reports is not a failure; a dead connection is.
  it('tells a market Kraken reports closed apart from a broken feed', () => {
    vi.useFakeTimers();
    const f = feed(), sym = symbols[0];
    expect(f.marketClosed(sym)).toBe(false);                  // online
    status(f, sym, 'cancel_only'); expect(f.marketClosed(sym)).toBe(true);
    status(f, sym, 'delisted'); expect(f.marketClosed(sym)).toBe(false);   // needs a human
    status(f, sym);
    (f as any).onMessage('{"channel":"status","data":[{"system":"maintenance"}]}');
    expect(f.marketClosed(sym)).toBe(true);
    vi.advanceTimersByTime(31_000);                           // silent connection
    expect(f.marketClosed(sym)).toBe(false);
    (f as any).reset(); (f as any).onMessage('{"channel":"heartbeat"}');
    expect(f.marketClosed(sym)).toBe(false);                  // nothing reported yet
  });
  it('rejects updates before a snapshot and subscription errors', () => {
    const f = feed();
    const upd = messages.find((raw) => JSON.parse(raw).type === 'update')!;
    expect(() => (f as any).onMessage(upd)).toThrow('before snapshot');
    expect(() => (f as any).onMessage('{"success":false,"error":"invalid symbol"}')).toThrow('invalid symbol');
  });
});
