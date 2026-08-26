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
  send = vi.fn();
  kill = vi.fn(() => true);
}

describe('DepthWorkerClient shutdown', () => {
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

    expect(child.send).toHaveBeenLastCalledWith({ type: 'stop' });
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

    child.exitCode = 137;
    child.emit('exit', 137, 'SIGKILL');
    await stopping;
  });
});
