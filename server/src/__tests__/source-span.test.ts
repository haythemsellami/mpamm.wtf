// LogSource block spans (adapter.ts fromBlock/untilBlock): a retired contract
// generation stays decodable for lifetime replays while costing ZERO live RPC.
// These pin the contract on every core loop that fetches log sources — the
// live tail, the volume backfill and the markout onboarding — so a span is
// never fetched outside, and always fetched inside. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceSpan, type LogSource, type VenueAdapter } from '../venues/adapter.js';

describe('sourceSpan', () => {
  it('is the range itself for an unbounded source', () => {
    expect(sourceSpan({}, 10n, 20n)).toEqual({ from: 10n, to: 20n });
  });
  it('clips to the declared span on either side', () => {
    expect(sourceSpan({ untilBlock: 15n }, 10n, 20n)).toEqual({ from: 10n, to: 15n });
    expect(sourceSpan({ fromBlock: 15n }, 10n, 20n)).toEqual({ from: 15n, to: 20n });
    expect(sourceSpan({ fromBlock: 12n, untilBlock: 18n }, 10n, 20n)).toEqual({ from: 12n, to: 18n });
  });
  it('is null when the range lies wholly outside the span (inclusive edges)', () => {
    expect(sourceSpan({ untilBlock: 9n }, 10n, 20n)).toBeNull();
    expect(sourceSpan({ fromBlock: 21n }, 10n, 20n)).toBeNull();
    expect(sourceSpan({ untilBlock: 10n }, 10n, 20n)).toEqual({ from: 10n, to: 10n });
    expect(sourceSpan({ fromBlock: 20n }, 10n, 20n)).toEqual({ from: 20n, to: 20n });
  });
});

const paths: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

const VID = 'span-venue';
const RETIRED = '0x00000000000000000000000000000000000000a0' as const;
const LIVE = '0x00000000000000000000000000000000000000a1' as const;
const START = 1_000n;

async function setup() {
  const path = join(tmpdir(), `source-span-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', 'off');
  vi.stubEnv('MARKOUT_BACKFILL', 'off');
  vi.stubEnv('GAS_METRIC', 'off');
  vi.stubEnv('DEPTH', 'off');
  vi.stubEnv('BACKFILL_CHUNK', '10');
  vi.stubEnv('GETLOGS_MIN_CHUNK', '10');
  vi.stubEnv('BACKFILL_MERGE_EVERY', '1');
  vi.stubEnv('BACKFILL_PACE_MS', '0');
  vi.resetModules();

  const getHead = vi.fn(async () => 100n);
  const getLogsChunked = vi.fn(async () => []);
  const archiveGetLogs = vi.fn(async () => []);
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    monad: { blockTime: 300 },
    publicClient: { getBlockNumber: getHead },
    quoteClient: {},
    headClient: { getBlockNumber: getHead },
    archiveClient: { getLogs: archiveGetLogs, getBlock: async () => ({ timestamp: 1_790_000_000n }), getBlockNumber: async () => START },
    getLogsChunked,
    probeChain: vi.fn(async () => ({ ok: true, block: 100 })),
    probeArchiveChain: vi.fn(async () => ({ ok: true, block: 100 })),
    blockAtOrAfter: vi.fn(async () => START),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: () => ({ active: 'primary', degraded: false, down: false }),
    rpcGeneration: () => 0,
    archiveRpcStatus: () => ({ active: 'archive', degraded: false, down: false }),
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: true,
  }));
  vi.doMock('../chain/heads.js', () => ({ HotHeadWatcher: class {} }));

  const decode = vi.fn(async () => []);
  /** a venue whose old contract retired at block 50 (and at START+14 for the
   *  replays), and whose new one is live from START+20 */
  let sources: LogSource[] = [
    { key: 'old', address: RETIRED, events: [], kind: 'fills', untilBlock: 50n },
    { key: 'new', address: LIVE, events: [], kind: 'fills' },
  ];
  const adapter = {
    venues: () => [{ id: VID, name: VID, color: { light: '#000', dark: '#fff' }, kind: 'amm' as const, role: 'venue' as const, sinceUtc: '2026-08-01' }],
    backfillFromUtc: '2026-08-01',
    discover: async () => {},
    logSources: () => sources,
    decode,
  } as unknown as VenueAdapter;
  vi.doMock('../venues/registry.js', () => ({
    ADAPTERS: [adapter],
    REFERENCES: {
      start: vi.fn(async () => {}), stop: vi.fn(),
      assetUsd: vi.fn(() => 1), changePctFor: vi.fn(() => 0), midForPair: vi.fn(() => 1),
      quote: vi.fn(() => []), metas: () => [],
    },
    venueMeta: () => adapter.venues(),
    venueIds: () => new Set([VID]),
    allVenueIds: () => [VID],
    allAdapterVenueIds: () => new Set([VID]),
    validateRegistry: vi.fn(),
  }));

  const { LiveDataSource } = await import('../datasource/live.js');
  const source = new LiveDataSource() as any;
  source.knownVenueIds = new Set([VID]);
  const setHead = (head: bigint) => getHead.mockResolvedValue(head + 5n);
  const setSources = (s: LogSource[]) => { sources = s; };
  const fetched = (fn: typeof getLogsChunked | typeof archiveGetLogs) => (fn.mock.calls as unknown as any[][]).map(([q]) => [String(q.address).toLowerCase(), q.fromBlock, q.toBlock]);
  return { source, adapter, decode, getLogsChunked, archiveGetLogs, setHead, setSources, fetched };
}

describe('the live tail honours source spans', () => {
  it('never fetches a source whose span ended before the range — yet still hands decode its (empty) key', async () => {
    const { source, decode, getLogsChunked, setHead, fetched } = await setup();
    source.lastBlock = 100n;
    setHead(200n);
    try {
      await source.tailFills();
      expect(fetched(getLogsChunked)).toEqual([[LIVE, 101n, 200n]]);
      expect((decode.mock.calls as unknown as any[][])[0][1]).toEqual({ old: [], new: [] });
      expect(source.lastBlock).toBe(200n);   // a skipped source is not a failed one
    } finally { source.store.close(); }
  });

  it('fetches only the part of the range inside the span when the range straddles it', async () => {
    const { source, getLogsChunked, setHead, fetched } = await setup();
    source.lastBlock = 40n;
    setHead(60n);
    try {
      await source.tailFills();
      expect(fetched(getLogsChunked)).toEqual(expect.arrayContaining([[RETIRED, 41n, 50n], [LIVE, 41n, 60n]]));
      expect(source.lastBlock).toBe(60n);
    } finally { source.store.close(); }
  });
});

describe('the history replays honour source spans', () => {
  const spans: LogSource[] = [
    { key: 'old', address: RETIRED, events: [], kind: 'fills', untilBlock: START + 14n },
    { key: 'new', address: LIVE, events: [], kind: 'fills', fromBlock: START + 20n },
  ];
  const expected = [
    [RETIRED, START, START + 9n], [RETIRED, START + 10n, START + 14n],
    [LIVE, START + 20n, START + 29n],
  ];

  it('volume backfill: each source only inside its span, and the cursor still crosses the gap', async () => {
    const { source, adapter, archiveGetLogs, fetched } = await setup();
    try {
      await source.backfillAdapter(adapter, VID, VID, '2026-08-01', spans, Date.now(), START + 29n);
      expect(fetched(archiveGetLogs)).toEqual(expected);
      expect(source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    } finally { source.store.close(); }
  });

  it('markout onboarding: the same', async () => {
    const { source, adapter, archiveGetLogs, fetched } = await setup();
    try {
      await source.backfillRecentFills(adapter, VID, VID, spans, Date.now(), START + 29n);
      expect(fetched(archiveGetLogs)).toEqual(expected);
      expect(source.store.getMeta(`mkfill_done_${VID}`)).toBe('1');
    } finally { source.store.close(); }
  });
});
