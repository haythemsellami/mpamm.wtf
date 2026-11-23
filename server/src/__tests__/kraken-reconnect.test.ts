// The Kraken feed's reconnect cadence, against a fake socket. A connection
// that fails right after its first message (an unscoped rejection) must
// back off, not reconnect every half second:
// the backoff used to reset on ANY parsed message, so it never grew.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { crc32 } from 'node:zlib';

const sockets = vi.hoisted(() => [] as any[]);
vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  // closes once, as `ws` does: terminating a closed socket is a no-op
  class FakeSocket extends Emitter {
    static OPEN = 1;
    readyState = FakeSocket.OPEN;
    sent: any[] = [];
    closed = false;
    constructor() { super(); sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    terminate() { if (!this.closed) { this.closed = true; this.emit('close'); } }
    close() { this.terminate(); }
  }
  return { default: FakeSocket };
});
import { KrakenFeed } from '../kraken.js';

afterEach(() => { vi.useRealTimers(); sockets.length = 0; vi.restoreAllMocks(); });

/** open the newest socket, send it one good message, then one that fails */
function failAfterFirstMessage() {
  const ws = sockets[sockets.length - 1] as EventEmitter;
  ws.emit('open');
  ws.emit('message', Buffer.from('{"channel":"status","data":[{"system":"online"}]}'));
  ws.emit('message', Buffer.from('{"success":false,"error":"subscription rejected"}'));
}

describe('Kraken reconnect backoff', () => {
  it('grows while every connection fails right after its first message', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = new KrakenFeed(['SPYx/USD']);
    await f.start();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = sockets.length;
      failAfterFirstMessage();
      let waited = 0;
      while (sockets.length === before) { vi.advanceTimersByTime(100); waited += 100; }
      delays.push(waited);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
    f.stop();
  });

  it('starts over after a connection that stayed up, and caps at a minute', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = new KrakenFeed(['SPYx/USD']);
    await f.start();
    for (let i = 0; i < 9; i++) {           // 0.5 s doubling past the cap
      const before = sockets.length;
      failAfterFirstMessage();
      while (sockets.length === before) vi.advanceTimersByTime(1_000);
    }
    const capped = sockets.length;
    failAfterFirstMessage();
    vi.advanceTimersByTime(59_999);
    expect(sockets.length).toBe(capped);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(capped + 1);

    // a healthy minute, kept alive by heartbeats, then a drop: 500 ms again
    const ws = sockets[sockets.length - 1] as EventEmitter & { terminate(): void };
    ws.emit('open');
    for (let t = 0; t < 61; t++) { vi.advanceTimersByTime(1_000); ws.emit('message', Buffer.from('{"channel":"heartbeat"}')); }
    const before = sockets.length;
    ws.terminate();
    vi.advanceTimersByTime(499);
    expect(sockets.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(before + 1);
    f.stop();
  });
});

it('repairs just the damaged subscription and keeps pricing other stocks and the stable cross', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const bad = 'SPCXx/USD', good = 'SPYx/USD', cross = 'USDC/USD';
  const f = new KrakenFeed([bad, good, cross]);
  await f.start();
  try {
    const ws = sockets[0];
    const send = (msg: object) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
    const book = (symbol: string, type = 'snapshot', checksum = crc32('111101')) =>
      send({ channel: 'book', type, data: [{ symbol, asks: [{ price: 11, qty: 1 }], bids: [{ price: 10, qty: 1 }], checksum }] });
    ws.emit('open');
    send({ channel: 'status', data: [{ system: 'online' }] });
    send({ channel: 'instrument', data: { pairs: [bad, good, cross].map((symbol) => ({ symbol, status: 'online' })) } });
    for (const symbol of [bad, good, cross]) book(symbol);
    expect(f.mid(bad)).toBe(10.5);
    book(bad, 'update', 0);
    expect(f.mid(bad)).toBe(0);
    expect([f.mid(good), f.mid(cross)]).toEqual([10.5, 10.5]);
    expect(ws.closed).toBe(false);

    // sent with the failure, not on the next watchdog tick
    const unsub = ws.sent.at(-1);
    expect(unsub).toMatchObject({ method: 'unsubscribe', params: { symbol: [bad], depth: 25 } });
    vi.advanceTimersByTime(10_000);
    expect(ws.sent.at(-1)).toBe(unsub);
    book(bad);   // old subscription, its unsubscribe has not been acknowledged
    expect(f.mid(bad)).toBe(0);
    send({ method: 'unsubscribe', req_id: unsub.req_id, success: true });
    expect(ws.sent.at(-1)).toMatchObject({ method: 'subscribe', params: { symbol: [bad], snapshot: true } });
    book(bad, 'update');
    expect(f.mid(bad)).toBe(0);
    book(bad);
    expect(f.mid(bad)).toBe(10.5);
    send({ method: 'subscribe', success: false, req_id: unsub.req_id, error: 'late response' });
    expect(ws.closed).toBe(false);
    const count = ws.sent.length;
    vi.advanceTimersByTime(20_000);
    expect(ws.sent).toHaveLength(count);
  } finally { f.stop(); }
});

it('retries a silent repair on a live connection and cancels its requests on disconnect', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const symbol = 'SPYx/USD';
  const f = new KrakenFeed([symbol]);
  await f.start();
  try {
    const ws = sockets[0];
    const send = (msg: object) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
    ws.emit('open');
    send({ channel: 'book', type: 'update', data: [{ symbol }] });
    const first = ws.sent.at(-1);
    expect(first.method).toBe('unsubscribe');
    vi.advanceTimersByTime(20_000);
    send({ channel: 'heartbeat' });
    vi.advanceTimersByTime(9_999);
    expect(ws.sent.at(-1)).toBe(first);
    vi.advanceTimersByTime(1);
    const retry = ws.sent.at(-1);
    expect(retry.method).toBe('unsubscribe');
    expect(retry.req_id).not.toBe(first.req_id);
    send({ method: 'unsubscribe', req_id: first.req_id, success: true });
    expect(ws.sent.at(-1)).toBe(retry);
    ws.terminate();
    vi.advanceTimersByTime(500);
    const next = sockets[1];
    next.emit('open');
    send({ method: 'unsubscribe', req_id: retry.req_id, success: true });
    next.emit('message', Buffer.from('{"channel":"heartbeat"}'));
    vi.advanceTimersByTime(10_000);
    expect(next.sent.map((msg: any) => msg.params.channel)).toEqual(['instrument', 'book', 'ticker']);
  } finally { f.stop(); }
});

/** A one-symbol feed past its first good snapshot; `book` sends an 11/10 book. */
async function repairedFeed(symbol: string) {
  const f = new KrakenFeed([symbol]);
  await f.start();
  const ws = sockets[sockets.length - 1];
  const send = (msg: object) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  const book = (type = 'snapshot', checksum = crc32('111101')) =>
    send({ channel: 'book', type, data: [{ symbol, asks: [{ price: 11, qty: 1 }], bids: [{ price: 10, qty: 1 }], checksum }] });
  ws.emit('open');
  send({ channel: 'status', data: [{ system: 'online' }] });
  send({ channel: 'instrument', data: { pairs: [{ symbol, status: 'online' }] } });
  book();
  return { f, ws, send, book };
}

it('resubscribes after a rejected unsubscribe, and says so when the resubscribe is rejected', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { f, ws, send } = await repairedFeed('NVDAx/USD');
  try {
    send({ channel: 'book', type: 'update', data: [{ symbol: 'NVDAx/USD', asks: [], bids: [], checksum: 0 }] });
    // the mismatch carries what was hashed, for diagnosing it from the log
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining(`(got 0, computed ${crc32('111101')}; asks 11@1 | bids 10@1)`));
    const unsub = ws.sent.at(-1);
    // a lost ack's retry, or a book Kraken already dropped: still resubscribe
    send({ method: 'unsubscribe', req_id: unsub.req_id, success: false, error: 'Subscription Not Found' });
    expect(ws.sent.at(-1)).toMatchObject({ method: 'subscribe', req_id: unsub.req_id, params: { symbol: ['NVDAx/USD'], snapshot: true } });
    send({ method: 'subscribe', req_id: unsub.req_id, success: false, error: 'Already subscribed' });
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('NVDAx/USD resubscribe rejected (Already subscribed)'));
    expect(f.mid('NVDAx/USD')).toBe(0);
  } finally { f.stop(); }
});

it('keeps the repair when its fresh snapshot also fails, and retries on the watchdog', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { f, ws, send, book } = await repairedFeed('ANTx/USD');
  try {
    book('update', 0);
    const unsub = ws.sent.at(-1);
    send({ method: 'unsubscribe', req_id: unsub.req_id, success: true });
    const sent = ws.sent.length;
    book('snapshot', 0);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('ANTx/USD repair snapshot rejected'));
    expect(ws.sent).toHaveLength(sent);        // no new request until the retry is due
    book('update');                              // deltas on a rejected snapshot are not applied
    expect(f.mid('ANTx/USD')).toBe(0);

    vi.advanceTimersByTime(20_000);
    send({ channel: 'heartbeat' });
    vi.advanceTimersByTime(10_000);
    const retry = ws.sent.at(-1);
    expect(retry).toMatchObject({ method: 'unsubscribe', params: { symbol: ['ANTx/USD'] } });
    expect(retry.req_id).not.toBe(unsub.req_id);
    send({ method: 'unsubscribe', req_id: retry.req_id, success: true });
    book();
    expect(f.mid('ANTx/USD')).toBe(10.5);
  } finally { f.stop(); }
});
