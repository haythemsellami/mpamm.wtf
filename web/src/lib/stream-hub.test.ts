import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamHub } from './stream-hub';
import type { StreamEnvelope, StreamTopic } from '@shared';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = '';
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: any[] = [];
  constructor(readonly url: string, readonly protocol: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  emit(envelope: StreamEnvelope) { this.onmessage?.({ data: JSON.stringify(envelope) }); }
}
const hubs: StreamHub[] = [];
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const quoteTopic = { channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false } as const;
const quote = (seq: number, epoch = 'one'): StreamEnvelope => ({ v: 2, epoch, topic: 'quotes:MON/USDC:1000:0', seq, message: { ch: 'quotes', data: { block: seq, monUsd: 1, ts: seq, rows: [] } } });
function boot() { vi.stubGlobal('WebSocket', Socket); const hub = new StreamHub('ws://localhost/stream'); hubs.push(hub); return hub; }
afterEach(async () => { for (const hub of hubs.splice(0)) hub.close(); await tick(); vi.unstubAllGlobals(); vi.useRealTimers(); Socket.instances = []; });

describe('shared subscription hub', () => {
  it.each(['aged', 'disconnected', 'old-quote'] as const)('does not replay a stale cache to a new listener (%s)', async (mode) => {
    vi.useFakeTimers(); const hub = boot();
    hub.set('a', { topics: [quoteTopic], message: vi.fn(), status: vi.fn() }); await tick();
    const socket = Socket.instances[0]; socket.open();
    const frame = quote(1);
    if (frame.message.ch === 'quotes') frame.message.data.ts = Date.now() - (mode === 'old-quote' ? 60_001 : 0);
    socket.emit(frame); await tick();
    if (mode === 'aged') await vi.advanceTimersByTimeAsync(5_001);
    if (mode === 'disconnected') socket.close();
    const later = vi.fn();
    hub.set('b', { topics: [quoteTopic], message: later, status: vi.fn() });
    expect(later).not.toHaveBeenCalled();
  });

  it('uses one socket for multiple tabs/components and sends the union only once', async () => {
    const hub = boot();
    const a = vi.fn(), b = vi.fn(), depth = vi.fn();
    hub.set('a', { topics: [quoteTopic], message: a, status: vi.fn() });
    hub.set('b', { topics: [quoteTopic], message: b, status: vi.fn() });
    hub.set('c', { topics: [{ channel: 'depth', market: 'BTC/USDC' }], message: depth, status: vi.fn() });
    await tick();
    expect(Socket.instances).toHaveLength(1);
    expect(hub.isLive()).toBe(false);
    const socket = Socket.instances[0]; socket.open();
    expect(hub.isLive()).toBe(true);
    expect(socket.sent[0].topics).toHaveLength(2);
    socket.emit(quote(1)); await tick();
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1); expect(depth).not.toHaveBeenCalled();
    hub.set('a'); await tick();
    expect(socket.readyState).toBe(Socket.OPEN);
    hub.set('b'); hub.set('c'); await tick();
    expect(socket.readyState).toBe(3);
    expect(hub.isLive()).toBe(false);
  });

  it('drops older quote frames and resynchronizes on an epoch change', async () => {
    const hub = boot(), message = vi.fn(), status = vi.fn();
    hub.set('a', { topics: [quoteTopic], message, status }); await tick();
    const socket = Socket.instances[0]; socket.open();
    socket.emit(quote(3)); socket.emit(quote(2)); socket.emit(quote(3)); await tick();
    expect(message).toHaveBeenCalledTimes(1);
    socket.emit(quote(1, 'two')); await tick();
    expect(message).toHaveBeenCalledTimes(2);
    expect(status.mock.calls.map(([state]) => state)).toEqual(['live', 'reconnecting', 'live']);
  });

  it('resubscribes after a dropped connection with the latest demand', async () => {
    vi.useFakeTimers();
    const hub = boot(), status = vi.fn();
    const topics: StreamTopic[] = [{ channel: 'volume' }];
    hub.set('a', { topics, message: vi.fn(), status }); await tick();
    Socket.instances[0].open(); Socket.instances[0].close();
    await vi.advanceTimersByTimeAsync(1250);
    expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].open();
    expect(Socket.instances[1].sent[0].topics).toEqual(topics);
    expect(status).toHaveBeenLastCalledWith('live');
  });

  it('replays complete cached state to a newly attached tab', async () => {
    const hub = boot();
    const topics = [{ channel: 'state' }] as const;
    hub.set('a', { topics: [...topics], message: vi.fn(), status: vi.fn() }); await tick();
    const socket = Socket.instances[0]; socket.open();
    const state = { chainId: 143, block: 1, monUsd: 1, monChangePct: 0, takerBps: 0, markets: [], sizesUsd: [], quoteCadenceMs: 300, source: 'sim' as const };
    socket.emit({ v: 2, epoch: 'one', topic: 'state', seq: 0, snapshot: true, message: { ch: 'state', data: { ...state, venues: [] } } });
    socket.emit({ v: 2, epoch: 'one', topic: 'state', seq: 1, message: { ch: 'state', data: { ...state, block: 2 } } }); await tick();
    const later = vi.fn();
    hub.set('b', { topics: [...topics], message: later, status: vi.fn() });
    expect(later.mock.calls[0][0].message.data).toMatchObject({ block: 2, venues: [] });
  });

  // `tail` rides the state frame only while the fill tail is behind, so its
  // absence is the "caught up" signal. Merging each frame onto the last kept
  // the header's FILLS chip up after recovery until the socket reconnected.
  it('carries forward only what the server sends once: a field it stops sending is gone', async () => {
    const hub = boot();
    const topics = [{ channel: 'state' }] as const;
    const seen = vi.fn();
    hub.set('a', { topics: [...topics], message: seen, status: vi.fn() }); await tick();
    const socket = Socket.instances[0]; socket.open();
    const state = { chainId: 143, block: 1, monUsd: 1, monChangePct: 0, takerBps: 0, markets: [], sizesUsd: [], quoteCadenceMs: 300, source: 'live' as const };
    const venues = [{ id: 'poe', name: 'LFJ POE', color: { light: '#111', dark: '#eee' }, kind: 'amm' as const, role: 'venue' as const }];
    const quoteMarkets = { poe: ['MON/USDC'] };
    const tail = { block: 1, lagBlocks: 5_000, lagMs: 1_500_000, held: false };
    socket.emit({ v: 2, epoch: 'one', topic: 'state', seq: 0, snapshot: true, message: { ch: 'state', data: { ...state, venues, quoteMarkets, tail } } }); await tick();
    socket.emit({ v: 2, epoch: 'one', topic: 'state', seq: 1, message: { ch: 'state', data: { ...state, block: 2, tail: { ...tail, lagBlocks: 4_000 } } } }); await tick();
    socket.emit({ v: 2, epoch: 'one', topic: 'state', seq: 2, message: { ch: 'state', data: { ...state, block: 3 } } }); await tick(); // caught up

    const frames = seen.mock.calls.map((c) => c[0].message.data);
    expect(frames[1].tail).toMatchObject({ lagBlocks: 4_000 }); // still behind: shown, and current
    expect(frames[2]).toMatchObject({ block: 3, venues, quoteMarkets }); // the once-only fields survive
    expect('tail' in frames[2]).toBe(false);
    // and the cached state a late tab is replayed says the same
    const later = vi.fn();
    hub.set('b', { topics: [...topics], message: later, status: vi.fn() });
    expect(later.mock.calls[0][0].message.data).toMatchObject({ block: 3, venues, quoteMarkets });
    expect('tail' in later.mock.calls[0][0].message.data).toBe(false);
  });
});
