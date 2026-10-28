// The Kraken feed's reconnect cadence, against a fake socket. A connection
// that fails right after its first message (a deterministic rejection,
// checksum or crossed book) must back off, not reconnect every half second:
// the backoff used to reset on ANY parsed message, so it never grew.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const sockets = vi.hoisted(() => [] as any[]);
vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  // closes once, as `ws` does: terminating a closed socket is a no-op
  class FakeSocket extends Emitter {
    closed = false;
    constructor() { super(); sockets.push(this); }
    send() {}
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
