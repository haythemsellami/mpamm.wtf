// Live readiness is independent of archive verification, but every worker that
// can persist deep-chain data remains gated until chain-id validation is armed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const paths: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

async function setup() {
  const path = join(tmpdir(), `live-startup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', 'on');
  vi.stubEnv('MARKOUT_BACKFILL', 'on');
  vi.stubEnv('GAS_METRIC', 'on');
  vi.resetModules();

  const archiveProbe = deferred<{ ok: boolean; block: number; reason?: string; wrongChain?: boolean }>();
  const references = {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    assetUsd: vi.fn(() => 1),
    changePctFor: vi.fn(() => 0),
    midForPair: vi.fn(() => 1),
    quote: vi.fn(() => []),
  };
  vi.doMock('../venues/registry.js', () => ({
    ADAPTERS: [],
    REFERENCES: references,
    venueMeta: () => [],
    venueIds: () => [],
    allVenueIds: () => [],
    allAdapterVenueIds: () => [],
    validateRegistry: vi.fn(),
  }));
  vi.doMock('../chain/rpc.js', () => ({
    publicClient: { getBlockNumber: vi.fn(async () => 100n) },
    archiveClient: {},
    getLogsChunked: vi.fn(),
    probeChain: vi.fn(async () => ({ ok: true, block: 100 })),
    probeArchiveChain: vi.fn(() => archiveProbe.promise),
    blockAtOrAfter: vi.fn(),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: () => ({ active: 'primary', degraded: false, down: false }),
    rpcGeneration: () => 0,
    archiveRpcStatus: () => ({ active: 'archive', degraded: false, down: false }),
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: true,
  }));

  const { LiveDataSource } = await import('../datasource/live.js');
  const source = new LiveDataSource() as any;
  source.initHistory = vi.fn(async () => {});
  source.poll = vi.fn(async () => {});
  source.scheduleLoop = vi.fn();
  source.backgroundHistory = vi.fn(async () => {});
  source.gas = { start: vi.fn(), stop: vi.fn() };
  return { source, archiveProbe };
}

describe('live startup archive gate', () => {
  it('warms hot loops while archive verification is still pending, then starts deep workers', async () => {
    const { source, archiveProbe } = await setup();
    const started = source.start();

    await vi.waitFor(() => {
      expect(source.poll).toHaveBeenCalledOnce();
      expect(source.scheduleLoop).toHaveBeenCalledWith('quote');
      expect(source.scheduleLoop).toHaveBeenCalledWith('tail');
    });
    expect(source.backgroundHistory).not.toHaveBeenCalled();
    expect(source.gas.start).not.toHaveBeenCalled();

    archiveProbe.resolve({ ok: true, block: 100 });
    await started;
    expect(source.backgroundHistory).toHaveBeenCalledOnce();
    expect(source.gas.start).toHaveBeenCalledOnce();
    source.stop();
  });

  it('never starts deep workers when the archive primary is on the wrong chain', async () => {
    const { source, archiveProbe } = await setup();
    const outcome = source.start().then((): Error | undefined => undefined, (error: unknown) => error as Error);

    await vi.waitFor(() => {
      expect(source.scheduleLoop).toHaveBeenCalledWith('quote');
      expect(source.scheduleLoop).toHaveBeenCalledWith('tail');
    });
    archiveProbe.resolve({ ok: false, block: 0, wrongChain: true, reason: 'archive primary is on the wrong chain' });
    const error = await outcome;
    expect(error?.message).toMatch(/Archive RPC sanity check failed.*wrong chain/i);
    expect(source.backgroundHistory).not.toHaveBeenCalled();
    expect(source.gas.start).not.toHaveBeenCalled();
    source.stop();
  });
});
