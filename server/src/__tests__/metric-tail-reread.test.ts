// A Metric pool created AND traded inside one tail window (review on #127).
// tailFills() snapshots logSources() before it fetches, so that window's swap
// query cannot contain the new pool; the adapter must make the core re-read
// the window rather than let the cursor advance past the pool's first swaps.
// Runs the REAL Metric adapter through the REAL tailFills() against a mocked
// chain, so it pins the core/adapter contract the fix relies on: a decode
// throw holds the cursor, and the retry re-snapshots logSources().
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOKENS } from '@shared';

const paths: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

const NEW = '0xcccc000000000000000000000000000000000005';
const FACTORY = '0xe22f9fc0f04486de25ed6cf1800a4a47afd82e0c';

/** Chain state: NEW is created at block 110 and trades at block 150. */
const chainLogs = (address: string | string[]) => {
  const addrs = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
  const out: any[] = [];
  if (addrs.includes(FACTORY)) out.push({ address: FACTORY, args: { pool: NEW }, blockNumber: 110n, transactionHash: '0x' + '1'.repeat(64), logIndex: 0 });
  if (addrs.includes(NEW)) {
    out.push({
      address: NEW, blockNumber: 150n, transactionHash: '0x' + '2'.repeat(64), logIndex: 3,
      args: { amount0Delta: -1_000_000_000_000_000_000n, amount1Delta: 2_000_000n, recipient: '0x' + '3'.repeat(40) },
    });
  }
  return out;
};

async function setup() {
  const path = join(tmpdir(), `metric-reread-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', 'off');
  vi.stubEnv('MARKOUT_BACKFILL', 'off');
  vi.stubEnv('GAS_METRIC', 'off');
  vi.stubEnv('DEPTH', 'off');
  vi.resetModules();

  // Every Metric pool (seeds and NEW) is a funded WMON/USDC pool with a price.
  const multicall = vi.fn(async ({ contracts }: any) => contracts.map((c: any) => {
    if (c.functionName === 'getImmutables') return { status: 'success', result: ['0x' + '0'.repeat(40), '0x' + 'b'.repeat(40), TOKENS.WMON.address, TOKENS.USDC.address, 0n, 0n, 0n, false, 0n, 0n, 0, 0, 0n, 0n] };
    if (c.functionName === 'balanceOf') return { status: 'success', result: 1_000n };
    if (c.functionName === 'getBidAndAskPrice') return { status: 'success', result: [100n, 101n] };
    if (c.functionName === 'offchainOracle') return { status: 'success', result: '0x' + 'd'.repeat(40) };
    if (c.functionName === 'offchainFeedId') return { status: 'success', result: '0x' + 'e'.repeat(64) };
    return { status: 'failure' };
  }));
  const getHead = vi.fn(async () => 100n);
  const getLogsChunked = vi.fn(async ({ address }: any) => chainLogs(address));
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    monad: { blockTime: 300 },
    publicClient: { getBlockNumber: getHead, multicall, readContract: vi.fn(async () => 1n), getBlock: async ({ blockNumber }: any) => ({ timestamp: 1_790_000_000n + blockNumber }) },
    quoteClient: {},
    headClient: { getBlockNumber: getHead },
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
  const { createMetricAdapter } = await import('../venues/metric.js');
  const metric = createMetricAdapter();
  vi.doMock('../venues/registry.js', () => ({
    ADAPTERS: [metric],
    REFERENCES: {
      start: vi.fn(async () => {}), stop: vi.fn(),
      assetUsd: vi.fn(() => 1), changePctFor: vi.fn(() => 0), midForPair: vi.fn(() => 1),
      quote: vi.fn(() => []), metas: () => [],
    },
    venueMeta: () => metric.venues(),
    venueIds: () => new Set(['metric']),
    allVenueIds: () => ['metric'],
    allAdapterVenueIds: () => new Set(['metric']),
    validateRegistry: vi.fn(),
  }));

  const { LiveDataSource } = await import('../datasource/live.js');
  const source = new LiveDataSource() as any;
  source.knownVenueIds = new Set(['metric']);
  await metric.discover(source.ctxFor(metric));   // boot discovery: scan anchored at head 100
  const setHead = (head: bigint) => getHead.mockResolvedValue(head + 5n);
  return { source, metric, getLogsChunked, setHead };
}

describe('Metric pool created and traded inside one tail window', () => {
  it('holds the cursor on the first pass, then counts the swap on the re-read', async () => {
    const { source, getLogsChunked, setHead } = await setup();
    source.lastBlock = 100n;
    setHead(200n);   // one window: 101..200 holds both the PoolCreated and the swap
    try {
      await source.tailFills();
      expect(source.lastBlock).toBe(100n);                         // held — not advanced past block 150
      expect(source.fills.filter((f: any) => f.venueId === 'metric')).toHaveLength(0);

      await source.tailFills();                                      // the core's retry
      const swapQueries = (getLogsChunked.mock.calls as any[][]).map(([q]) => q).filter((q) => Array.isArray(q.address));
      expect(swapQueries.at(-1).address.map((a: string) => a.toLowerCase())).toContain(NEW);   // re-snapshotted
      expect(source.lastBlock).toBe(200n);
      const fills = source.fills.filter((f: any) => f.venueId === 'metric');
      expect(fills).toHaveLength(1);
      expect(fills[0].id).toBe(`metric-0x${'2'.repeat(64)}-3`);
      expect(fills[0].usd).toBeCloseTo(2, 9);

      // and the pool is durable: written to meta before the cursor moved
      expect(JSON.parse(source.store.getMeta('adapter_metric_factory_pools'))).toEqual([NEW]);
    } finally { source.store.close(); }
  });
});
