import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock, rpcConfig } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  rpcConfig: {
    depthEnabled: true,
    rpcDepth: 'https://depth.invalid',
    rpcHttp: 'https://hot.invalid',
    rpcWs: 'wss://hot.invalid',
    rpcBackups: ['https://hot-backup.invalid', 'https://http-only.invalid'],
    rpcWsBackups: ['wss://hot-backup.invalid', ''],
    rpcDepthWs: '',
    rpcDepthBackups: [] as string[],
    rpcDepthWsBackups: [] as string[],
  },
}));

vi.mock('node:child_process', () => ({ fork: forkMock }));
vi.mock('../../config.js', () => ({ config: rpcConfig }));

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

  it.each(['inherit', 'dedicated', 'explicit-shared', 'no-backups'] as const)('forwards paired backup lists for a %s depth pool', async (mode) => {
    const original = { ...rpcConfig };
    const child = new FakeChild();
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    const client = new DepthWorkerClient(() => {});
    try {
      rpcConfig.rpcDepth = mode === 'inherit' ? '' : mode === 'explicit-shared' ? rpcConfig.rpcHttp : 'https://depth.invalid';
      rpcConfig.rpcDepthBackups = mode === 'inherit' || mode === 'no-backups' ? [] : ['https://depth-backup.invalid'];
      rpcConfig.rpcDepthWsBackups = mode === 'inherit' || mode === 'no-backups' ? [] : ['wss://depth-backup.invalid'];
      client.setDemand('MON/USDC', true);
      expect(forkMock).toHaveBeenCalledOnce();
      expect(forkMock.mock.calls[0][2].env).toMatchObject({
        RPC_HTTP_URL: rpcConfig.rpcDepth || rpcConfig.rpcHttp,
        RPC_WS_URL: mode === 'inherit' || mode === 'explicit-shared' ? rpcConfig.rpcWs : '',
        RPC_HTTP_BACKUP_URLS: mode === 'inherit' ? 'https://hot-backup.invalid,https://http-only.invalid' : rpcConfig.rpcDepthBackups.join(','),
        RPC_WS_BACKUP_URLS: mode === 'inherit' ? 'wss://hot-backup.invalid,' : rpcConfig.rpcDepthWsBackups.join(','),
      });
    } finally {
      Object.assign(rpcConfig, original);
      child.exitCode = 0;
      await client.stop();
    }
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
