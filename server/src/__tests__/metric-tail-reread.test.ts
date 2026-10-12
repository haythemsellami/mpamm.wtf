// A Metric (v1) pool created AND traded inside one tail window (review on #127).
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
const FACTORY = '0x2a53833cc95548cf52c7b159110e22d3a9018f32';   // v1
const WMON_POOL = '0xe6831acf980c2dfc5ae993f06b198d872fddf515';
const MASK = (1n << 128n) - 1n;
/** a realistic height: v1 sources are bounded below by the factory's creation block */
const B = 112_000_000n;

/** Chain state: NEW is created at block B+110 and trades at block B+150. */
const chainLogs = (address: string | string[]) => {
  const addrs = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
  const out: any[] = [];
  if (addrs.includes(FACTORY)) out.push({ address: FACTORY, args: { poolAddress: NEW }, blockNumber: B + 110n, transactionHash: '0x' + '1'.repeat(64), logIndex: 0 });
  if (addrs.includes(NEW)) {
    out.push({
      address: NEW, blockNumber: B + 150n, transactionHash: '0x' + '2'.repeat(64), logIndex: 3,
      // packed: token0 (WMON) -1e18 high, token1 (USDC) +2e6 low
      args: { amountDeltas: ((-1_000_000_000_000_000_000n & MASK) << 128n) | 2_000_000n, recipient: '0x' + '3'.repeat(40) },
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

  // The v1 factory lists one pool at boot and NEW once it exists; every pool is
  // a funded WMON/USDC pool with a price.
  let listed = [WMON_POOL];
  const multicall = vi.fn(async ({ contracts, allowFailure }: any) => {
    const out = contracts.map((c: any) => {
      if (c.functionName === 'idxToPool') return { status: 'success', result: listed[Number(c.args[0]) - 1] };
      if (c.functionName === 'getImmutables') return { status: 'success', result: { factory: FACTORY, token0: TOKENS.WMON.address, token1: TOKENS.USDC.address, immutablePriceProvider: '0x' + 'b'.repeat(40) } };
      if (c.functionName === 'priceProvider') return { status: 'success', result: '0x' + 'b'.repeat(40) };
      if (c.functionName === 'balanceOf') return { status: 'success', result: 1_000n };
      if (c.functionName === 'getSellAndBuyPrices') return { status: 'success', result: [100n, 101n] };
      if (c.functionName === 'offchainOracle') return { status: 'success', result: '0x' + 'd'.repeat(40) };
      return { status: 'failure' };
    });
    return allowFailure === false ? out.map((r: any) => r.result) : out;
  });
  const readContract = vi.fn(async ({ functionName }: any) => (functionName === 'nextPoolIdx' ? BigInt(listed.length + 1) : 1n));
  const getHead = vi.fn(async () => B + 100n);
  const getLogsChunked = vi.fn(async ({ address }: any) => chainLogs(address));
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    monad: { blockTime: 300 },
    publicClient: { getBlockNumber: getHead, multicall, readContract, getBlock: async ({ blockNumber }: any) => ({ timestamp: 1_790_000_000n + blockNumber }) },
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
  await metric.discover(source.ctxFor(metric));   // boot discovery: the factory lists the WMON pool only
  listed = [WMON_POOL, NEW];                       // NEW is created at block B+110 — after boot
  const setHead = (head: bigint) => getHead.mockResolvedValue(head + 5n);
  return { source, metric, getLogsChunked, setHead };
}

describe('Metric pool created and traded inside one tail window', () => {
  it('holds the cursor on the first pass, then counts the swap on the re-read', async () => {
    const { source, getLogsChunked, setHead } = await setup();
    source.lastBlock = B + 100n;
    setHead(B + 200n);   // one window: B+101..B+200 holds both the PoolCreated and the swap
    try {
      await source.tailFills();
      expect(source.lastBlock).toBe(B + 100n);                     // held — not advanced past block B+150
      expect(source.fills.filter((f: any) => f.venueId === 'metric')).toHaveLength(0);

      await source.tailFills();                                      // the core's retry
      const swapQueries = (getLogsChunked.mock.calls as any[][]).map(([q]) => q).filter((q) => Array.isArray(q.address));
      expect(swapQueries.at(-1).address.map((a: string) => a.toLowerCase())).toContain(NEW);   // re-snapshotted
      expect(source.lastBlock).toBe(B + 200n);
      const fills = source.fills.filter((f: any) => f.venueId === 'metric');
      expect(fills).toHaveLength(1);
      expect(fills[0].id).toBe(`metric-0x${'2'.repeat(64)}-3`);
      expect(fills[0].usd).toBeCloseTo(2, 9);
      // the retired v0 generation cost nothing: its span ended long before this window
      const v0Pool = '0x2d82ac42334b394a9a8d8f097d61dc1c6b065fd8';
      expect(swapQueries.some((q) => q.address.map((a: string) => a.toLowerCase()).includes(v0Pool))).toBe(false);
    } finally { source.store.close(); }
  });
});
