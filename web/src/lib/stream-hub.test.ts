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
  it('uses one socket for multiple tabs/components and sends the union only once', async () => {
    const hub = boot();
    const a = vi.fn(), b = vi.fn(), depth = vi.fn();
    hub.set('a', { topics: [quoteTopic], message: a, status: vi.fn() });
    hub.set('b', { topics: [quoteTopic], message: b, status: vi.fn() });
    hub.set('c', { topics: [{ channel: 'depth', market: 'BTC/USDC' }], message: depth, status: vi.fn() });
    await tick();
    expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0]; socket.open();
    expect(socket.sent[0].topics).toHaveLength(2);
    socket.emit(quote(1)); await tick();
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1); expect(depth).not.toHaveBeenCalled();
    hub.set('a'); await tick();
    expect(socket.readyState).toBe(Socket.OPEN);
    hub.set('b'); hub.set('c'); await tick();
    expect(socket.readyState).toBe(3);
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
});
