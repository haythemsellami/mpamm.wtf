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
    const connected = vi.fn();
    const watcher = new HotHeadWatcher(
      { getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://credential-bearing.example/ws/key', openSocket: () => socket as any },
    );

    watcher.start({
      onBlock: (block, source) => seen.push({ block, source }),
      onWsConnected: connected,
      onWsFallback: fallback,
    });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('open');
    expect(JSON.parse(socket.sent[0])).toMatchObject({ method: 'eth_chainId', params: [] });
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x8f' }));
    expect(JSON.parse(socket.sent[1])).toMatchObject({ method: 'eth_subscribe', params: ['monadNewHeads'] });
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 2, result: '0xsub' }));
    expect(connected).toHaveBeenCalledOnce();
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: { number: '0x64' } } }));
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: { number: '0x65' } } }));

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
    second.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: { number: '0x65' } } }));
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
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: { number: '0x989680' } } }));
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
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: { number: '0x989680' } } }));

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

  it('ignores malformed notifications without disrupting subsequent heads', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(), seen = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid', openSocket: () => socket as any });
    watcher.start({ onBlock: seen }); await vi.advanceTimersByTimeAsync(0);
    socket.emit('open'); socket.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    socket.emit('message', JSON.stringify({ id: 2, result: '0xsub' }));
    for (const raw of ['null', 'true', '[]', '{']) expect(() => socket.emit('message', raw)).not.toThrow();
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub',
      result: { number: '0x65', commitState: { toString: 1 } } } }));
    expect(seen.mock.calls.map((call) => call[0])).toEqual([100n, 101n]);
    expect(watcher.identity(101n).commitState).toBeUndefined();
    watcher.stop();
  });
  it('falls back to standard heads when the provider lacks Monad subscriptions', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const seen = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid', openSocket: () => socket as any });
    watcher.start({ onBlock: seen });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('open');
    socket.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    socket.emit('message', JSON.stringify({ id: 2, error: { code: -32602 } }));
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ id: 3, params: ['newHeads'] });
    socket.emit('message', JSON.stringify({ id: 3, result: 'standard' }));
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: 'standard', result: { number: '0x65' } } }));
    expect(seen.mock.calls.map((c) => c[0])).toEqual([100n, 101n]);
    watcher.stop();
  });

  it('replaces a proposal, dedupes commitment upgrades and rejects a losing proposal after finality', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const seen = vi.fn(), replaced = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 99n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid', openSocket: () => socket as any });
    watcher.start({ onBlock: seen, onReplaced: replaced });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('open'); socket.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    socket.emit('message', JSON.stringify({ id: 2, result: '0xsub' }));
    const hashA = `0x${'a'.repeat(64)}`, hashB = `0x${'b'.repeat(64)}`;
    const head = (hash: string, commitState: string) => socket.emit('message', JSON.stringify({ method: 'eth_subscription',
      params: { subscription: '0xsub', result: { number: '0x64', hash, blockId: hash, commitState } } }));
    head(hashA, 'Proposed');
    const original = watcher.identity(100n);
    head(hashA, 'Voted'); head(hashB, 'Proposed'); head(hashB, 'Finalized'); head(hashA, 'Proposed');
    expect(replaced).toHaveBeenCalledExactlyOnceWith(100n);
    expect(seen.mock.calls.map((c) => c[0])).toEqual([99n, 100n, 100n]);
    expect(watcher.isCurrent(100n, original)).toBe(false);
    expect(watcher.identity(100n)).toMatchObject({ hash: hashB, revision: 1, commitState: 'Finalized' });
    watcher.stop();
  });

  it.each(['Finalized', 'Verified'] as const)('retains %s commitment after reconnecting to standard heads', async (commitState) => {
    vi.useFakeTimers();
    const native = new FakeSocket(), standard = new FakeSocket();
    const sockets = [native, standard];
    const seen = vi.fn(), replaced = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 99n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid', openSocket: () => sockets.shift() as any });
    const hash = `0x${'a'.repeat(64)}`, losingHash = `0x${'b'.repeat(64)}`;
    watcher.start({ onBlock: seen, onReplaced: replaced });
    try {
      await vi.advanceTimersByTimeAsync(0);
      native.emit('open'); native.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
      native.emit('message', JSON.stringify({ id: 2, result: 'native' }));
      native.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: 'native',
        result: { number: '0x64', hash, blockId: hash, commitState } } }));
      native.close();
      await vi.advanceTimersByTimeAsync(1_000);
      standard.emit('open'); standard.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
      standard.emit('message', JSON.stringify({ id: 2, error: { code: -32602 } }));
      standard.emit('message', JSON.stringify({ id: 3, result: 'standard' }));
      const head = (nextHash: string) => standard.emit('message', JSON.stringify({ method: 'eth_subscription',
        params: { subscription: 'standard', result: { number: '0x64', hash: nextHash } } }));
      head(hash);
      expect(watcher.identity(100n)).toMatchObject({ hash, blockId: hash, commitState, revision: 0 });
      head(losingHash);
      expect(replaced).not.toHaveBeenCalled();
      expect(watcher.identity(100n)).toMatchObject({ hash, commitState, revision: 0 });
      expect(seen.mock.calls.map((call) => call[0])).toEqual([99n, 100n]);
    } finally { watcher.stop(); }
  });

  it('pairs the socket with the active HTTP generation and discards a late primary head', async () => {
    vi.useFakeTimers();
    const a = new FakeSocket(), b = new FakeSocket();
    let endpoint = { generation: 0, wsUrl: 'wss://primary.invalid' };
    const openSocket = vi.fn((url) => (url === endpoint.wsUrl && endpoint.generation === 0 ? a : b) as any);
    const seen = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, endpoint: () => endpoint, openSocket });
    watcher.start({ onBlock: seen }); await vi.advanceTimersByTimeAsync(0);
    a.emit('open'); a.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    a.emit('message', JSON.stringify({ id: 2, result: '0xsub' }));
    endpoint = { generation: 1, wsUrl: 'wss://backup.invalid' };
    a.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: { number: '0xffff' } } }));
    await vi.advanceTimersByTimeAsync(75);
    expect(openSocket.mock.calls.map((c) => c[0])).toEqual(['wss://primary.invalid', 'wss://backup.invalid']);
    expect(seen.mock.calls.map((c) => c[0])).toEqual([100n, 100n]);
    expect(seen.mock.lastCall?.[3]).toMatchObject({ generation: 1 });
    watcher.stop();
  });

  it('invalidates an HTTP-first quote when WS reports a different proposal at the same height', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(), seen = vi.fn(), replaced = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid', openSocket: () => socket as any });
    watcher.start({ onBlock: seen, onReplaced: replaced });
    await vi.advanceTimersByTimeAsync(0);
    const resolved = { ...watcher.identity(100n), hash: `0x${'a'.repeat(64)}` as `0x${string}` };
    expect(watcher.rememberResolved(100n, resolved)).toBe(true);
    socket.emit('open'); socket.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    socket.emit('message', JSON.stringify({ id: 2, result: '0xsub' }));
    socket.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub',
      result: { number: '0x64', hash: `0x${'b'.repeat(64)}`, commitState: 'Proposed' } } }));
    expect(replaced).toHaveBeenCalledExactlyOnceWith(100n);
    expect(seen.mock.calls.map((call) => call[0])).toEqual([100n, 100n]);
    expect(watcher.rememberResolved(100n, resolved)).toBe(false);
    expect(watcher.identity(100n).hash).toBe(`0x${'b'.repeat(64)}`);
    watcher.stop();
  });

  it('reconnects an acknowledged socket that stops sending while HTTP continues', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(), next = new FakeSocket(), sockets = [socket, next];
    const fallback = vi.fn(), seen = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 100n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid', openSocket: () => sockets.shift() as any });
    watcher.start({ onBlock: seen, onWsFallback: fallback });
    socket.emit('open'); socket.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    socket.emit('message', JSON.stringify({ id: 2, result: '0xsub' }));
    await vi.advanceTimersByTimeAsync(3_100);
    expect(fallback).toHaveBeenCalledOnce();
    // The previous socket's silence must not cancel a new handshake while
    // HTTP watchdog polls run during its connection/chain/subscription setup.
    await vi.advanceTimersByTimeAsync(1_600);
    next.emit('open'); next.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    next.emit('message', JSON.stringify({ id: 2, result: '0xsub' }));
    next.emit('message', JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: { number: '0x65' } } }));
    expect(seen.mock.lastCall?.[0]).toBe(101n);
    watcher.stop();
  });

  it('moves back to a corrected ancestor instead of quoting its abandoned descendant', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(), seen = vi.fn();
    const watcher = new HotHeadWatcher({ getBlockNumber: vi.fn(async () => 99n) } as any,
      { pollMs: 75, wsUrl: 'wss://example.invalid', openSocket: () => socket as any });
    watcher.start({ onBlock: seen }); await vi.advanceTimersByTimeAsync(0);
    socket.emit('open'); socket.emit('message', JSON.stringify({ id: 1, result: '0x8f' }));
    socket.emit('message', JSON.stringify({ id: 2, result: '0xsub' }));
    const head = (number: string, letter: string) => socket.emit('message', JSON.stringify({ method: 'eth_subscription',
      params: { subscription: '0xsub', result: { number, hash: `0x${letter.repeat(64)}`, commitState: 'Proposed' } } }));
    head('0x64', 'a'); head('0x65', 'b');
    const descendant = watcher.identity(101n);
    head('0x64', 'c');
    expect(seen.mock.calls.map((call) => call[0])).toEqual([99n, 100n, 101n, 100n]);
    expect(watcher.isCurrent(101n, descendant)).toBe(false);
    expect(watcher.isCurrent(101n, { ...descendant, revision: 1 })).toBe(false);
    head('0x65', 'b');
    expect(seen.mock.calls.at(-1)?.[0]).toBe(100n);
    watcher.stop();
  });

});
