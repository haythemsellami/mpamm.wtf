// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  constructor() { Socket.instances.push(this); }
  send = vi.fn();
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
}
class Worker {
  static instances: Worker[] = [];
  onerror?: () => void;
  port = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: undefined as ((event: { data: unknown }) => void) | undefined };
  constructor() { Worker.instances.push(this); }
  live() { this.port.onmessage?.({ data: { status: 'live' } }); }
  closed() { this.port.onmessage?.({ data: { type: 'closed' } }); }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const clean: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('SharedWorker', Worker);
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    original(type, listener, options);
    clean.push(() => window.removeEventListener(type, listener, options));
  });
});
afterEach(async () => {
  for (const dispose of clean.splice(0).reverse()) dispose();
  await tick();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Socket.instances = []; Worker.instances = [];
});

async function listen() {
  const { subscribeTopics } = await import('./subscriptions');
  const status = vi.fn();
  clean.push(subscribeTopics([{ channel: 'fill' }], vi.fn(), status));
  await tick();
  return status;
}

describe('subscription recovery', () => {
  it.each(['error', 'heartbeat'] as const)('signals a gap before replacing a worker after %s', async (failure) => {
    const first = await listen(), second = await listen();
    const worker = Worker.instances[0];
    worker.live();
    if (failure === 'error') worker.onerror?.();
    else await vi.advanceTimersByTimeAsync(80_000);
    await tick();
    expect(Socket.instances).toHaveLength(1);
    for (const status of [first, second]) expect(status.mock.calls.map(([s]) => s)).toEqual(['live', 'reconnecting']);
    worker.live(); // Messages already queued on the abandoned port are stale.
    expect(first).toHaveBeenLastCalledWith('reconnecting');
    Socket.instances[0].open();
    for (const status of [first, second]) expect(status.mock.calls.map(([s]) => s)).toEqual(['live', 'reconnecting', 'live']);
    expect(worker.port.close).not.toHaveBeenCalled();
    worker.closed();
    expect(worker.port.close).toHaveBeenCalledOnce();
  });

  it.each(['shared', 'direct'] as const)('resynchronizes on page restoration with %s connections', async (mode) => {
    if (mode === 'direct') vi.stubGlobal('SharedWorker', undefined);
    const status = await listen();
    if (mode === 'shared') Worker.instances[0].live();
    else Socket.instances[0].open();
    window.dispatchEvent(new Event('pagehide'));
    await tick();
    if (mode === 'shared') {
      expect(Worker.instances[0].port.close).not.toHaveBeenCalled();
      Worker.instances[0].closed();
      expect(Worker.instances[0].port.close).toHaveBeenCalledOnce();
    }
    expect(status.mock.calls.map(([s]) => s)).toEqual(['live']);
    window.dispatchEvent(new Event('pageshow'));
    expect(status).toHaveBeenLastCalledWith('reconnecting');
    await tick();
    if (mode === 'shared') { expect(Worker.instances).toHaveLength(2); Worker.instances[1].live(); }
    else { expect(Socket.instances).toHaveLength(2); Socket.instances[1].open(); }
    expect(status.mock.calls.map(([s]) => s)).toEqual(['live', 'reconnecting', 'live']);
  });

  it('falls back after worker startup timeout', async () => {
    const status = await listen();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(status).toHaveBeenLastCalledWith('reconnecting');
    expect(Socket.instances).toHaveLength(1);
    Socket.instances[0].open();
    expect(status).toHaveBeenLastCalledWith('live');
  });

  it.each([true, false])('retires the last listener after acknowledgement or a dead-worker timeout (ack: %s)', async (ack) => {
    const { subscribeTopics } = await import('./subscriptions');
    const dispose = subscribeTopics([{ channel: 'fill' }], vi.fn()); clean.push(dispose);
    await tick();
    const worker = Worker.instances[0]; worker.live();
    dispose(); await tick();
    expect(worker.port.postMessage).toHaveBeenLastCalledWith({ type: 'close' });
    expect(worker.port.close).not.toHaveBeenCalled();
    if (ack) worker.closed(); else await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.port.close).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(0);
  });
});
