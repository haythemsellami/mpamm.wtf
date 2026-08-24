import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HotHeadWatcher } from '../heads.js';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  close(): void { this.emit('close'); }
  terminate(): void { this.emit('close'); }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HotHeadWatcher', () => {
  it('polls below block cadence and emits only monotonically newer heads', async () => {
    vi.useFakeTimers();
    const getBlockNumber = vi.fn()
      .mockResolvedValueOnce(100n)
      .mockResolvedValueOnce(100n)
      .mockResolvedValueOnce(99n)
      .mockResolvedValueOnce(101n);
    const seen: bigint[] = [];
    const watcher = new HotHeadWatcher({ getBlockNumber } as any, { pollMs: 75 });

    watcher.start({ onBlock: (block) => seen.push(block) });
    await vi.advanceTimersByTimeAsync(225);

    expect(seen).toEqual([100n, 101n]);
    watcher.stop();
  });

  it('subscribes to newHeads, dedupes it against HTTP, and falls back safely', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const seen: Array<{ block: bigint; source: string }> = [];
    const fallback = vi.fn();
    const watcher = new HotHeadWatcher(
      { getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://credential-bearing.example/ws/key', openSocket: () => socket as any },
    );

    watcher.start({
      onBlock: (block, source) => seen.push({ block, source }),
      onWsFallback: fallback,
    });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('open');
    expect(JSON.parse(socket.sent[0])).toMatchObject({ method: 'eth_chainId', params: [] });
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x8f' }));
    expect(JSON.parse(socket.sent[1])).toMatchObject({ method: 'eth_subscribe', params: ['newHeads'] });
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0xsub' }));
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { result: { number: '0x64' } } }));
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { result: { number: '0x65' } } }));

    expect(seen).toEqual([{ block: 100n, source: 'http' }, { block: 101n, source: 'ws' }]);
    socket.emit('error', new Error('handshake failed at a secret URL'));
    expect(fallback).toHaveBeenCalledOnce();
    watcher.stop();
  });

  it('reconnects after failure and reports recovery only once a new head arrives', async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const fallback = vi.fn();
    const recovered = vi.fn();
    const watcher = new HotHeadWatcher(
      { getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid/ws', openSocket: () => sockets.shift() as any },
    );

    watcher.start({ onBlock: vi.fn(), onWsFallback: fallback, onWsRecovered: recovered });
    first.emit('error', new Error('upgrade failed'));
    expect(fallback).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    second.emit('open');
    second.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x8f' }));
    second.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0xsub' }));
    expect(recovered).not.toHaveBeenCalled();
    second.emit('message', JSON.stringify({ method: 'eth_subscription', params: { result: { number: '0x65' } } }));
    expect(recovered).toHaveBeenCalledOnce();
    watcher.stop();
  });

  it('ignores buffered heads from a socket after it has been detached', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const getBlockNumber = vi.fn().mockResolvedValueOnce(100n).mockResolvedValue(101n);
    const seen: Array<{ block: bigint; source: string }> = [];
    const watcher = new HotHeadWatcher(
      { getBlockNumber } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid/ws', openSocket: () => socket as any },
    );

    watcher.start({ onBlock: (block, source) => seen.push({ block, source }) });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('open');
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x8f' }));
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0xsub' }));
    socket.emit('error', new Error('connection lost'));

    // A detached connection can still deliver data already queued by the
    // socket implementation. It must not advance the monotonic head cursor.
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { result: { number: '0x989680' } } }));
    await vi.advanceTimersByTimeAsync(75);

    expect(seen).toEqual([{ block: 100n, source: 'http' }, { block: 101n, source: 'http' }]);
    watcher.stop();
  });

  it('rejects a WebSocket from the wrong chain before it can publish a head', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const seen: bigint[] = [];
    const fallback = vi.fn();
    const watcher = new HotHeadWatcher(
      { getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid/ws', openSocket: () => socket as any },
    );

    watcher.start({ onBlock: (block) => seen.push(block), onWsFallback: fallback });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('open');
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { result: { number: '0x989680' } } }));

    expect(seen).toEqual([100n]);
    expect(fallback).toHaveBeenCalledOnce();
    watcher.stop();
  });

  it('keeps HTTP polling alive when socket creation fails synchronously', async () => {
    vi.useFakeTimers();
    const seen: bigint[] = [];
    const fallback = vi.fn();
    const watcher = new HotHeadWatcher(
      { getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'not-a-url', openSocket: () => { throw new Error('invalid URL'); } },
    );

    watcher.start({ onBlock: (block) => seen.push(block), onWsFallback: fallback });
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([100n]);
    expect(fallback).toHaveBeenCalledOnce();
    watcher.stop();
  });
});
