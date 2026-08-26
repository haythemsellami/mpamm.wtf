// Stream backpressure policy (server.ts). Prod OOM-crashed on 2026-07-29 with
// heap 311MB after 18h uptime: the broadcast loop only checked readyState, so a
// peer that stayed OPEN without draining (sleeping laptop, backgrounded phone,
// half-dead TCP) accumulated every pushed frame in OUR heap — ~330MB/hour at
// the current tick size. These lock in the policy: healthy clients are never
// cut, hopeless ones always are.
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MAX_BACKLOG_BYTES, streamAction, trySseWrite } from '../server.js';

const QUOTE_TICK_BYTES = 46_000; // measured on prod: 170 rows ≈ 46KB

describe('streamAction', () => {
  it('sends to a healthy client with an empty buffer', () => {
    expect(streamAction(WebSocket.OPEN, 0)).toBe('send');
  });

  it('keeps sending while a client is merely a few ticks behind', () => {
    // a real browser on a slow link briefly queues a handful of ticks
    expect(streamAction(WebSocket.OPEN, QUOTE_TICK_BYTES * 5)).toBe('send');
    expect(streamAction(WebSocket.OPEN, MAX_BACKLOG_BYTES)).toBe('send'); // boundary is inclusive
  });

  it('cuts a client whose backlog passes the cap — the leak that killed prod', () => {
    expect(streamAction(WebSocket.OPEN, MAX_BACKLOG_BYTES + 1)).toBe('cut');
    expect(streamAction(WebSocket.OPEN, 50_000_000)).toBe('cut');
  });

  it('drops (without terminating) a socket that is already closing or closed', () => {
    expect(streamAction(WebSocket.CLOSING, 0)).toBe('drop');
    expect(streamAction(WebSocket.CLOSED, 0)).toBe('drop');
    expect(streamAction(WebSocket.CONNECTING, 0)).toBe('drop');
    // a closed socket with a huge buffer is still just dropped — nothing to cut
    expect(streamAction(WebSocket.CLOSED, 50_000_000)).toBe('drop');
  });

  it('tolerates ~20 quote ticks of backlog before cutting (headroom for a hiccup)', () => {
    const ticksTolerated = Math.floor(MAX_BACKLOG_BYTES / QUOTE_TICK_BYTES);
    expect(ticksTolerated).toBeGreaterThanOrEqual(15);
    expect(streamAction(WebSocket.OPEN, QUOTE_TICK_BYTES * (ticksTolerated - 1))).toBe('send');
  });
});

describe('trySseWrite', () => {
  const response = (overrides: Record<string, unknown> = {}) => ({
    destroyed: false,
    writableLength: 0,
    write: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  });

  it('writes to a healthy response', () => {
    const res = response();
    expect(trySseWrite(res, 'data: ok\n\n')).toBe(true);
    expect(res.write).toHaveBeenCalledWith('data: ok\n\n');
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('drops a response that is already destroyed', () => {
    const res = response({ destroyed: true });
    expect(trySseWrite(res, 'data: late\n\n')).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('cuts a response whose pending writes exceed the backlog cap', () => {
    const res = response({ writableLength: MAX_BACKLOG_BYTES + 1 });
    expect(trySseWrite(res, 'data: slow\n\n')).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
    expect(res.destroy).toHaveBeenCalledOnce();
  });

  it('contains a write that races a client disconnect', () => {
    const res = response({ write: vi.fn(() => { throw new Error('socket closed'); }) });
    expect(trySseWrite(res, 'data: race\n\n')).toBe(false);
    expect(res.destroy).toHaveBeenCalledOnce();
  });
});
