import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { topicKey, type StreamEnvelope, type StreamTopic } from '@shared';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: { topics: StreamTopic[] }[] = [];
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  emit(frame: StreamEnvelope) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
class Port {
  onmessage?: ((event: { data: unknown }) => void) | null;
  postMessage = vi.fn(); start = vi.fn(); close = vi.fn();
  receive(data: unknown) { this.onmessage?.({ data }); }
  messages() { return this.postMessage.mock.calls.map(([message]) => message); }
}
const stateTopic = { channel: 'state' } as const;
const quoteTopic = { channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false } as const;
const depthTopic = { channel: 'depth', market: 'MON/USDC' } as const;
const listeners: Array<{ id: string; topics: StreamTopic[] }> = [
  { id: 'dashboard', topics: [stateTopic, quoteTopic] },
  { id: 'depth-chart', topics: [depthTopic] },
];
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
let connect: (event: { ports: Port[] }) => void;
const ports: Port[] = [];
const port = () => { const result = new Port(); connect({ ports: [result] }); ports.push(result); return result; };
const subscribe = (port: Port, items = listeners) => port.receive({ type: 'subscribe', listeners: items });

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  const worker = { location: { protocol: 'https:', host: 'example.test' }, onconnect: undefined as typeof connect | undefined };
  vi.stubGlobal('self', worker);
  await import('./stream.shared-worker');
  connect = worker.onconnect!;
});
afterEach(async () => {
  for (const entry of ports.splice(0)) entry.receive({ type: 'close' });
  await tick(); vi.unstubAllGlobals(); vi.useRealTimers(); Socket.instances = [];
});

async function seed() {
  const first = port(); subscribe(first); await tick();
  const socket = Socket.instances[0]; socket.open();
  const frames: StreamEnvelope[] = [
    { v: 2, epoch: 'test', seq: 1, topic: 'state', message: { ch: 'state', data: { chainId: 143, block: 1, monUsd: 1,
      monChangePct: 0, takerBps: 0, markets: ['MON/USDC'], sizesUsd: [1000], quoteCadenceMs: 300, source: 'sim', venues: [] } } },
    { v: 2, epoch: 'test', seq: 1, topic: topicKey(quoteTopic), message: { ch: 'quotes', data: { block: 1, monUsd: 1, ts: Date.now(), rows: [] } } },
    { v: 2, epoch: 'test', seq: 1, topic: topicKey(depthTopic), message: { ch: 'depth', data: { market: 'MON/USDC', asOfBlock: 1, refMid: 1, ts: Date.now(), venues: [] } } },
  ];
  for (const frame of frames) socket.emit(frame);
  await tick();
  expect(first.messages().filter((message) => message.envelope)).toHaveLength(3);
  first.postMessage.mockClear();
  return { first, socket, frames };
}

describe('SharedWorker consumer replay', () => {
  it('seeds a new depth consumer without replaying state, quotes or depth to existing components', async () => {
    const { first, socket, frames } = await seed();
    subscribe(first, [...listeners, { id: 'size-hint', topics: [depthTopic] }]); await tick();
    expect(first.messages()).toEqual([{ id: 'size-hint', status: 'live' }, { ids: ['size-hint'], envelope: frames[2] }]);
    expect(Socket.instances).toHaveLength(1);
    expect(socket.sent.at(-1)?.topics).toHaveLength(3);
    first.postMessage.mockClear();
    subscribe(first, [...listeners, { id: 'size-hint', topics: [depthTopic] }]); await tick();
    expect(first.messages()).toEqual([]);
    socket.emit({ ...frames[2], seq: 2 }); await tick();
    expect(first.messages()).toEqual([{ ids: ['depth-chart', 'size-hint'], envelope: { ...frames[2], seq: 2 } }]);
    first.postMessage.mockClear();
    subscribe(first); await tick();
    expect(first.messages()).toEqual([]);
    socket.emit({ ...frames[2], seq: 3 }); await tick();
    expect(first.messages()).toEqual([{ ids: ['depth-chart'], envelope: { ...frames[2], seq: 3 } }]);
  });

  it('keeps consumer ids isolated by port and seeds a new tab without replaying to the first', async () => {
    const { first, socket, frames } = await seed();
    const second = port(); second.postMessage.mockClear();
    subscribe(second); await tick();
    const snapshots = second.messages().filter((message) => message.envelope).map((message) => message.envelope);
    expect(snapshots).toHaveLength(3);
    expect(snapshots).toEqual(expect.arrayContaining(frames.map((frame) => expect.objectContaining(frame))));
    expect(first.messages()).toEqual([]);
    first.receive({ type: 'close' }); await tick();
    expect(first.messages()).toEqual([{ type: 'closed' }]);
    expect(socket.readyState).toBe(Socket.OPEN);
    second.postMessage.mockClear();
    socket.emit({ ...frames[1], seq: 2 }); await tick();
    expect(second.messages()).toEqual([{ ids: ['dashboard'], envelope: expect.objectContaining({ ...frames[1], seq: 2 }) }]);
    second.receive({ type: 'close' }); await tick();
    expect(socket.readyState).toBe(3);
  });

  it('replays only added topics when an existing consumer changes its selection', async () => {
    const { first, frames } = await seed();
    const other = port(); subscribe(other); await tick();
    other.postMessage.mockClear();
    subscribe(first, [{ id: 'dashboard', topics: [stateTopic, depthTopic] }]); await tick();
    expect(first.messages()).toEqual([{ ids: ['dashboard'], envelope: frames[2] }]);
    expect(other.messages()).toEqual([]);
    first.postMessage.mockClear();
    subscribe(first, [{ id: 'dashboard', topics: [stateTopic, quoteTopic] }]); await tick();
    expect(first.messages()).toEqual([{ ids: ['dashboard'], envelope: expect.objectContaining(frames[1]) }]);
  });

  it('expires every consumer of a dead port without closing another active tab', async () => {
    const { first, socket } = await seed();
    const second = port(); subscribe(second); await tick();
    for (let i = 0; i < 5; i++) { second.receive({ type: 'ping' }); await vi.advanceTimersByTimeAsync(30_000); }
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(Socket.OPEN);
    second.receive({ type: 'close' }); await tick();
    expect(socket.readyState).toBe(3);
  });
});
