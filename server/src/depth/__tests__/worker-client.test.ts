import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));

vi.mock('node:child_process', () => ({ fork: forkMock }));
vi.mock('../../config.js', () => ({
  config: {
    depthEnabled: true,
    rpcDepth: 'https://depth.invalid',
    rpcHttp: 'https://hot.invalid',
    rpcDepthWs: '',
    rpcDepthBackups: [],
  },
}));

import { DepthWorkerClient } from '../worker-client.js';

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  send = vi.fn();
  kill = vi.fn(() => true);
}

describe('DepthWorkerClient lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forkMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('force-kills a worker that does not stop after becoming idle', async () => {
    const child = new FakeChild();
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    const client = new DepthWorkerClient(() => {});

    client.setDemand('MON/USDC', true);
    client.setDemand('MON/USDC', false);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(child.send.mock.calls.at(-1)?.[0]).toEqual({ type: 'stop' });
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('force-kills a worker that does not stop during service shutdown', async () => {
    const child = new FakeChild();
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    const client = new DepthWorkerClient(() => {});
    client.setDemand('MON/USDC', true);

    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await stopping;
  });

  it('does not wait for an exit event that already happened', async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    const client = new DepthWorkerClient(() => {});
    client.setDemand('MON/USDC', true);

    await expect(client.stop()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('cancels a pending restart when the last viewer leaves', async () => {
    const child = new FakeChild();
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    const client = new DepthWorkerClient(() => {});
    client.setDemand('MON/USDC', true);

    child.exitCode = 1;
    child.emit('exit', 1, null);
    client.setDemand('MON/USDC', false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(forkMock).toHaveBeenCalledOnce();
  });

  it('retries a synchronous fork failure without throwing into the API process', async () => {
    const child = new FakeChild();
    forkMock
      .mockImplementationOnce(() => { throw new Error('EMFILE'); })
      .mockReturnValue(child as unknown as ChildProcess);
    const onStatus = vi.fn();
    const client = new DepthWorkerClient(() => {}, onStatus);

    expect(() => client.setDemand('MON/USDC', true)).not.toThrow();
    expect(onStatus).toHaveBeenCalledWith('warn', 'depth worker failed to start: EMFILE');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('contains an IPC-close race while forwarding demand', () => {
    const child = new FakeChild();
    child.send.mockImplementation(() => { throw new Error('IPC channel closed'); });
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    const client = new DepthWorkerClient(() => {});

    expect(() => client.setDemand('MON/USDC', true)).not.toThrow();
  });
});
