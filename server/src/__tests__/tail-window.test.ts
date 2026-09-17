// tailFills memory bounds (PR #105). Two failure modes took prod down on
// 2026-09-16 and neither was locked down by a test: (a) a fail-closed
// logSources() throw ran INSIDE the fetch Promise.all, so one adapter's
// throw left the other adapters' range fetches running detached — and with
// the cursor held, every retry re-fetched an ever-growing range until the
// heap died; (b) the tail fetched the whole [from, head] span in one cycle,
// so a restart boot behind by ~88k blocks materialized hundreds of MB of
// logs before the single cursor commit. These tests pin the fixes: sources
// gather before ANY fetch, and the window is exactly TAIL_WINDOW_BLOCKS.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

const VENUE = { id: 'test-venue', name: 'Test Venue', color: { light: '#000', dark: '#fff' }, kind: 'amm' as const, role: 'venue' as const };

function healthyAdapter() {
  return {
    venues: () => [VENUE],
    discover: vi.fn(async () => {}),
    logSources: () => [{ key: 'swap', address: ['0x0000000000000000000000000000000000000001'], events: [], kind: 'fills' as const }],
    decode: vi.fn(async () => []),
  };
}

/** The 2026-09-16 shape: POE with discovery never completed. */
function throwingAdapter() {
  return {
    ...healthyAdapter(),
    logSources: () => { throw new Error('POE discovery unavailable'); },
  };
}

async function setup(adapters: ReturnType<typeof healthyAdapter>[]) {
  const path = join(tmpdir(), `tail-window-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', 'off');
  vi.stubEnv('MARKOUT_BACKFILL', 'off');
  vi.stubEnv('GAS_METRIC', 'off');
  vi.stubEnv('DEPTH', 'off');
  vi.resetModules();

  const getBlockNumber = vi.fn(async () => 100n);
  const getLogsChunked = vi.fn(async () => []);
  vi.doMock('../chain/rpc.js', () => ({
    monad: { blockTime: 300 },
    publicClient: { getBlockNumber },
    quoteClient: {},
    headClient: { getBlockNumber: vi.fn(async () => 100n) },
    archiveClient: {},
    getLogsChunked,
    probeChain: vi.fn(async () => ({ ok: true, block: 100 })),
    probeArchiveChain: vi.fn(async () => ({ ok: true, block: 100 })),
    blockAtOrAfter: vi.fn(),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: () => ({ active: 'primary', degraded: false, down: false }),
    rpcGeneration: () => 0,
    archiveRpcStatus: () => ({ active: 'archive', degraded: false, down: false }),
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: true,
  }));
  vi.doMock('../chain/heads.js', () => ({ HotHeadWatcher: class {} }));
  vi.doMock('../venues/registry.js', () => ({
    ADAPTERS: adapters,
    REFERENCES: {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      assetUsd: vi.fn(() => 1), // warm — passes the markout-anchor gate
      changePctFor: vi.fn(() => 0),
      midForPair: vi.fn(() => 1),
      quote: vi.fn(() => []),
      metas: () => [],
    },
    venueMeta: () => [],
    venueIds: () => [],
    allVenueIds: () => adapters.map((a) => a.venues()[0].id),
    allAdapterVenueIds: () => new Set(adapters.map((a) => a.venues()[0].id)),
    validateRegistry: vi.fn(),
  }));

  const { LiveDataSource } = await import('../datasource/live.js');
  const source = new LiveDataSource() as any;
  source.initHistory = vi.fn(async () => {});
  source.poll = vi.fn(async () => {});
  source.backgroundHistory = vi.fn(async () => {});
  source.bootHead = 0n;
  /** point the (mocked) chain tip so tailFills sees `head` = tip - 5 */
  const setHead = (head: bigint) => getBlockNumber.mockResolvedValue(head + 5n);
  return { source, getLogsChunked, setHead };
}

describe('tailFills fetch window', () => {
  it('capped at exactly TAIL_WINDOW_BLOCKS: a 1000-block gap fetches 1000, not 1001 (inclusive ends)', async () => {
    const { source, getLogsChunked, setHead } = await setup([healthyAdapter()]);
    source.lastBlock = 0n; // from = 1
    setHead(1001n);        // head - from = 1000 → capped path
    await source.tailFills();
    const calls = getLogsChunked.mock.calls as unknown as any[][];
    expect(calls.length).toBe(1);
    const range = calls[0][0];
    // inclusive ends: from 1 through 1000 is exactly 1000 blocks — the
    // off-by-one Copilot caught fetched through 1001
    expect(range.fromBlock).toBe(1n);
    expect(range.toBlock).toBe(1000n);
    expect(source.lastBlock).toBe(1000n); // commits the WINDOW, not the chain head
  });

  it('a 999-block gap stays uncapped and reaches head', async () => {
    const { source, getLogsChunked, setHead } = await setup([healthyAdapter()]);
    source.lastBlock = 0n;
    setHead(1000n); // head - from = 999 < 1000
    await source.tailFills();
    expect((getLogsChunked.mock.calls as unknown as any[][])[0][0]).toMatchObject({ fromBlock: 1n, toBlock: 1000n });
    expect(source.lastBlock).toBe(1000n);
  });

  it('a huge gap commits one window per cycle — never the whole span', async () => {
    const { source, getLogsChunked, setHead } = await setup([healthyAdapter()]);
    source.lastBlock = 0n;
    setHead(5000n);
    await source.tailFills();
    expect((getLogsChunked.mock.calls as unknown as any[][])[0][0].toBlock).toBe(1000n);
    expect(source.lastBlock).toBe(1000n); // head (4995) untouched until later windows
  });
});

describe('tailFills fail-closed ordering (no detached fetches)', () => {
  it('a throwing logSources() rejects BEFORE any adapter fetches — cursor held, zero getLogs', async () => {
    const { source, getLogsChunked, setHead } = await setup([healthyAdapter(), throwingAdapter()]);
    source.lastBlock = 123n;
    setHead(200n);
    // Pre-fix, the healthy adapter's getLogsChunked was invoked before the
    // outer promise rejected — the detached fetch the OOM spiral fed on.
    await expect(source.tailFills()).rejects.toThrow('POE discovery unavailable');
    expect(getLogsChunked).not.toHaveBeenCalled();
    expect(source.lastBlock).toBe(123n); // held
  });

  it('a transient per-SOURCE fetch failure still holds the cursor (fail-closed preserved)', async () => {
    const { source, getLogsChunked, setHead } = await setup([healthyAdapter()]);
    getLogsChunked.mockRejectedValueOnce(new Error('rpc truncated'));
    source.lastBlock = 123n;
    setHead(200n);
    await source.tailFills();
    expect(getLogsChunked).toHaveBeenCalled();
    expect(source.lastBlock).toBe(123n); // required source failed → no advance
  });
});
