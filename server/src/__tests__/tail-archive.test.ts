// The fills tail's pool choice. On 2026-11-12 the hot pool was unreachable for
// 31 h, and after it reported recovered every read of the blocks it had missed
// still failed, each cycle, without tripping failover. The tail read every
// window from the hot pool whatever its age, so the shared cursor held at the
// outage's first block for as long as nobody deployed — with the archive pool
// healthy the whole time. These tests pin the fix: a window that is not at the
// tip is read from the archive pool, and anything the archive cannot do falls
// through to the hot read the tail always made.
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
const TX = `0x${'ab'.repeat(32)}`;
const POOL = '0x00000000000000000000000000000000000000aa';
/** an hour ago, in chain seconds: old enough to be a gap, inside today's ring */
const BLOCK_SEC = BigInt(Math.floor(Date.now() / 1000) - 3600);

const log = (bn: bigint) => ({ blockNumber: bn, transactionHash: TX, logIndex: 0 });

function adapter(category: 'DIRECT' | 'UNKNOWN' = 'DIRECT') {
  return {
    venues: () => [VENUE],
    discover: vi.fn(async () => {}),
    logSources: () => [{ key: 'swap', address: ['0x0000000000000000000000000000000000000001'], events: [], kind: 'fills' as const }],
    // tx.to === this address is what turns an UNKNOWN fill DIRECT (attribution.ts)
    entryPoints: () => [{ address: POOL }],
    decode: vi.fn(async (_ctx: any, bundle: any, tsOf: (bn: bigint) => number) => (bundle.swap as any[]).map((l) => ({
      id: `${VENUE.id}-${l.transactionHash}-${l.logIndex}-${l.blockNumber}`, venueId: VENUE.id, market: 'MON/USDC', side: 'buy', category,
      usd: 100, baseAmount: 1, execPx: 100, txHash: l.transactionHash, to: '0xdead…beef', pool: 'p',
      blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber), markoutsBps: [null, null, null, null, null],
    }))),
  };
}

async function setup(a: ReturnType<typeof adapter>, opts: { dedicated?: boolean } = {}) {
  const path = join(tmpdir(), `tail-archive-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', 'off');
  vi.stubEnv('MARKOUT_BACKFILL', 'off');
  vi.stubEnv('GAS_METRIC', 'off');
  vi.stubEnv('DEPTH', 'off');
  vi.resetModules();

  const archiveStatus = { active: 'archive', degraded: false, down: false };
  const hot = {
    head: vi.fn(async () => 100n),
    getLogs: vi.fn(async (_p: any): Promise<any[]> => []),
    getBlock: vi.fn(async (_p: any) => ({ timestamp: BLOCK_SEC })),
    getTransaction: vi.fn(async (_p: any) => ({ to: POOL, from: '0x1111111111111111111111111111111111111111' })),
  };
  const archive = {
    getBlockNumber: vi.fn(async () => 10_000_000n),
    getLogs: vi.fn(async (_p: any): Promise<any[]> => []),
    getBlock: vi.fn(async (_p: any) => ({ timestamp: BLOCK_SEC })),
    getTransaction: vi.fn(async (_p: any) => ({ to: POOL, from: '0x1111111111111111111111111111111111111111' })),
  };
  // the real chunker's contract, minus the chunking: the default fetch is the
  // hot client, and a caller-supplied fetch replaces it
  const getLogsChunked = vi.fn(async (params: any, _chunk?: bigint, fetchLogs?: (p: any) => Promise<any[]>) => (fetchLogs ? fetchLogs(params) : hot.getLogs(params)));
  const publicClient = { getBlockNumber: vi.fn(async () => 100n), getLogs: hot.getLogs, getBlock: hot.getBlock, getTransaction: hot.getTransaction };
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    monad: { blockTime: 300 },
    publicClient,
    quoteClient: {},
    headClient: { getBlockNumber: hot.head },
    archiveClient: archive,
    getLogsChunked,
    probeChain: vi.fn(async () => ({ ok: true, block: 100 })),
    probeArchiveChain: vi.fn(async () => ({ ok: true, block: 100 })),
    blockAtOrAfter: vi.fn(),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: () => ({ active: 'primary', degraded: false, down: false }),
    rpcGeneration: () => 0,
    archiveRpcStatus: () => archiveStatus,
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: opts.dedicated ?? true,
  }));
  vi.doMock('../chain/heads.js', () => ({ HotHeadWatcher: class {} }));
  vi.doMock('../venues/registry.js', () => ({
    ADAPTERS: [a],
    REFERENCES: {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      assetUsd: vi.fn(() => 1), // warm — passes the markout-anchor gate
      changePctFor: vi.fn(() => 0),
      midForPair: vi.fn(() => 1),
      quote: vi.fn(() => []),
      metas: () => [],
    },
    venueMeta: () => [VENUE],
    venueIds: () => [VENUE.id],
    allVenueIds: () => [VENUE.id],
    allAdapterVenueIds: () => new Set([VENUE.id]),
    validateRegistry: vi.fn(),
  }));

  const live = await import('../datasource/live.js');
  const source = new live.LiveDataSource() as any;
  source.initHistory = vi.fn(async () => {});
  source.poll = vi.fn(async () => {});
  source.backgroundHistory = vi.fn(async () => {});
  source.bootHead = 0n;
  source.knownVenueIds = new Set([VENUE.id]); // start() sets it; ingest drops a fill for any other venue
  /** point the (mocked) chain tip so tailFills sees `head` = tip - 5 */
  const setHead = (head: bigint) => hot.head.mockResolvedValue(head + 5n);
  const notes = (code: string): string[] => source.notes.list().filter((n: any) => n.code === code).map((n: any) => n.msg);
  return { live, source, a, hot, archive, archiveStatus, getLogsChunked, setHead, notes };
}

/** the cursor sits 5000 blocks behind: window 1..1000 is 3995 behind the head */
async function gap(a = adapter(), opts: { dedicated?: boolean } = {}) {
  const s = await setup(a, opts);
  s.source.lastBlock = 0n;
  s.setHead(5000n);
  return s;
}

describe('tailWindowIsDeep', () => {
  it('a window is deep only when its END is more than one window behind the hot head', async () => {
    const { live, source } = await setup(adapter());
    try {
      expect(live.tailWindowIsDeep(4000n, 5000n)).toBe(false); // exactly 1000 behind: the hot pool's
      expect(live.tailWindowIsDeep(3999n, 5000n)).toBe(true);
      expect(live.tailWindowIsDeep(5000n, 5000n)).toBe(false); // the tip
    } finally { source.store.close(); }
  });
});

describe('rpcFailureReason', () => {
  it("keeps the node's answer and drops what changes per request", async () => {
    const { live, source } = await setup(adapter());
    try {
      // viem: `details` is the node's own message; `message` carries URL + request body
      const viemLike = Object.assign(new Error('RPC Request failed.\n\nURL: https://node.example/rpc/SECRET\nRequest body: {"fromBlock":"0x73f3e0e"}'), {
        shortMessage: 'RPC Request failed.', details: 'error getting block header from triedb and archive',
      });
      expect(live.rpcFailureReason(viemLike)).toBe('error getting block header from triedb and archive');
      // a block number would make every retry of a moving window a NEW note
      expect(live.rpcFailureReason(Object.assign(new Error('x'), { details: 'block 121585294 (0x73f3e0e) not available' })))
        .toBe('block # (0x…) not available');
      expect(live.rpcFailureReason(Object.assign(new Error('x'), { details: 'Bad Gateway', status: 502 }))).toBe('HTTP 502: Bad Gateway');
      // a plain Error: first line only, so a multi-line message never carries a URL line
      expect(live.rpcFailureReason(new Error('rpc truncated\nURL: https://node.example/SECRET'))).toBe('rpc truncated');
      expect(live.rpcFailureReason('boom')).toBe('boom');
    } finally { source.store.close(); }
  });
});

describe('tailFills pool choice', () => {
  it('reads a gap window from the archive pool: logs, timestamps, decode state and attribution', async () => {
    const a = adapter('UNKNOWN');
    const { source, hot, archive, notes } = await gap(a);
    archive.getLogs.mockResolvedValueOnce([log(10n), log(20n)]);
    try {
      await source.tailFills();
      expect(archive.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 1n, toBlock: 1000n }));
      expect(hot.getLogs).not.toHaveBeenCalled();
      expect(archive.getBlock).toHaveBeenCalledTimes(2);
      expect(hot.getBlock).not.toHaveBeenCalled();
      // decode reads chain state at the window's blocks: it must get the pool that holds them
      expect(a.decode.mock.calls[0][0].client).toBe(archive);
      expect(archive.getTransaction).toHaveBeenCalledOnce(); // one tx, asked of the archive first
      expect(hot.getTransaction).not.toHaveBeenCalled();
      expect(source.fills.map((f: any) => f.blockNumber)).toEqual([10, 20]);
      expect(source.fills[0].category).toBe('DIRECT'); // attribution landed
      expect(source.lastBlock).toBe(1000n);
      expect(notes('tail.archive')).toHaveLength(1);
      expect(notes('venue.source.failed')).toEqual([]);
    } finally { source.store.close(); }
  });

  it('the tip stays on the hot pool and never consults the archive', async () => {
    const a = adapter('UNKNOWN');
    const { source, hot, archive, setHead, notes } = await setup(a);
    source.lastBlock = 4990n;
    setHead(5000n);
    hot.getLogs.mockResolvedValueOnce([log(4995n)]);
    try {
      await source.tailFills();
      expect(archive.getBlockNumber).not.toHaveBeenCalled();
      expect(archive.getLogs).not.toHaveBeenCalled();
      expect(archive.getTransaction).not.toHaveBeenCalled();
      expect(hot.getTransaction).toHaveBeenCalledOnce();
      expect(a.decode.mock.calls[0][0].client).not.toBe(archive);
      expect(source.fills).toHaveLength(1);
      expect(source.lastBlock).toBe(5000n);
      expect(notes('tail.archive')).toEqual([]);
    } finally { source.store.close(); }
  });

  it('a capped window exactly one window behind the head is still the hot pool\'s', async () => {
    const { source, hot, archive, setHead } = await setup(adapter());
    source.lastBlock = 0n;
    setHead(2000n); // window 1..1000, head − to = 1000
    try {
      await source.tailFills();
      expect(archive.getBlockNumber).not.toHaveBeenCalled();
      expect(hot.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 1n, toBlock: 1000n }));
      expect(source.lastBlock).toBe(1000n);
    } finally { source.store.close(); }
  });

  it('an archive whose head has not reached the window is not asked for it', async () => {
    // beyond its head a node can answer "no logs", and an empty answer consumes the cursor
    const { source, hot, archive } = await gap();
    archive.getBlockNumber.mockResolvedValue(999n);
    hot.getLogs.mockResolvedValueOnce([log(10n)]);
    try {
      await source.tailFills();
      expect(archive.getLogs).not.toHaveBeenCalled();
      expect(source.fills).toHaveLength(1);
      expect(source.lastBlock).toBe(1000n);
    } finally { source.store.close(); }
  });

  it('a failed-over archive pool leaves the gap to the hot pool', async () => {
    const { source, hot, archive, archiveStatus } = await gap();
    archiveStatus.degraded = true;
    try {
      await source.tailFills();
      expect(archive.getBlockNumber).not.toHaveBeenCalled();
      expect(archive.getLogs).not.toHaveBeenCalled();
      expect(hot.getLogs).toHaveBeenCalledOnce();
      expect(source.lastBlock).toBe(1000n);
    } finally { source.store.close(); }
  });

  it('shared pools (no RPC_ARCHIVE_URL) read every window the way they always did', async () => {
    const { source, hot, archive } = await gap(adapter(), { dedicated: false });
    try {
      await source.tailFills();
      expect(archive.getBlockNumber).not.toHaveBeenCalled();
      expect(archive.getLogs).not.toHaveBeenCalled();
      expect(hot.getLogs).toHaveBeenCalledOnce();
      expect(source.lastBlock).toBe(1000n);
    } finally { source.store.close(); }
  });
});

describe('tailFills archive fallback (never worse than the hot read)', () => {
  it('an archive log failure falls through to the hot pool in the same cycle, then backs off', async () => {
    const { source, hot, archive, notes } = await gap();
    archive.getLogs.mockRejectedValueOnce(Object.assign(new Error('x'), { details: 'Too Many Requests', status: 429 }));
    hot.getLogs.mockResolvedValueOnce([log(10n)]);
    try {
      await source.tailFills();
      expect(source.fills).toHaveLength(1);
      expect(source.lastBlock).toBe(1000n);
      expect(notes('venue.source.failed')).toEqual(["Test Venue log source 'swap' failed on the archive pool — trying the hot pool: HTTP 429: Too Many Requests"]);
      expect(notes('tail.archive')).toEqual([]); // the hot pool served it

      // the next gap window does not hammer a throttled archive…
      await source.tailFills();
      expect(archive.getBlockNumber).toHaveBeenCalledOnce();
      expect(archive.getLogs).toHaveBeenCalledOnce();
      expect(source.lastBlock).toBe(2000n);
      // …and goes back to it once the back-off has passed
      source.tailArchiveRetryAt = 0;
      await source.tailFills();
      expect(archive.getLogs).toHaveBeenCalledTimes(2);
      expect(source.lastBlock).toBe(3000n);
      expect(notes('tail.archive')).toHaveLength(1);
    } finally { source.store.close(); }
  });

  it('a gap neither pool can serve holds the cursor and says why, per pool', async () => {
    const a = adapter();
    const { source, hot, archive, notes } = await gap(a);
    archive.getLogs.mockRejectedValue(Object.assign(new Error('x'), { details: 'archive db unavailable' }));
    hot.getLogs.mockRejectedValue(Object.assign(new Error('x'), { details: 'error getting block header from triedb and archive' }));
    try {
      await source.tailFills();
      expect(source.lastBlock).toBe(0n);
      expect(a.decode).not.toHaveBeenCalled();
      expect(source.fills).toEqual([]);
      expect(notes('venue.source.failed')).toEqual([
        "Test Venue log source 'swap' failed on the archive pool — trying the hot pool: archive db unavailable",
        "Test Venue log source 'swap' failed — holding cursor, retrying: error getting block header from triedb and archive",
      ]);
      // retried every cycle: the reason is stable, so the note is not repeated
      source.tailArchiveRetryAt = 0;
      await source.tailFills();
      expect(notes('venue.source.failed')).toHaveLength(2);
      expect(source.lastBlock).toBe(0n);
    } finally { source.store.close(); }
  });

  it('archive logs without archive timestamps are discarded: the window is re-read whole from the hot pool', async () => {
    const a = adapter();
    const { source, hot, archive, notes } = await gap(a);
    archive.getLogs.mockResolvedValueOnce([log(10n)]);
    archive.getBlock.mockRejectedValueOnce(new Error('header not found'));
    hot.getLogs.mockResolvedValueOnce([log(10n), log(30n)]);
    try {
      await source.tailFills();
      // one decode, of the hot bundle: one pool per window, never a mix
      expect(a.decode).toHaveBeenCalledOnce();
      expect(a.decode.mock.calls[0][1].swap).toHaveLength(2);
      expect(hot.getBlock).toHaveBeenCalledTimes(2);
      expect(source.fills.map((f: any) => f.blockNumber)).toEqual([10, 30]);
      expect(source.lastBlock).toBe(1000n);
      expect(notes('tail.timestamps.failed')).toEqual(['block timestamp lookup failed on the archive pool — trying the hot pool: header not found']);
    } finally { source.store.close(); }
  });

  it('a decode the archive context cannot complete is retried with the hot context', async () => {
    const a = adapter();
    const { source, hot, archive, notes } = await gap(a);
    archive.getLogs.mockResolvedValueOnce([log(10n)]);
    hot.getLogs.mockResolvedValueOnce([log(10n)]);
    const decode = a.decode.getMockImplementation()!;
    a.decode.mockImplementationOnce(async () => { throw new Error('historical state unavailable'); });
    try {
      await source.tailFills();
      expect(a.decode).toHaveBeenCalledTimes(2);
      expect(a.decode.mock.calls[0][0].client).toBe(archive);
      expect(a.decode.mock.calls[1][0].client).not.toBe(archive);
      expect(await decode(null, { swap: [] }, () => 0)).toEqual([]); // the harness decode is intact
      expect(source.fills).toHaveLength(1); // counted once, from the hot decode
      expect(source.lastBlock).toBe(1000n);
      expect(notes('venue.decode.failed')).toEqual(['Test Venue decode error on the archive pool — trying the hot pool: historical state unavailable']);
    } finally { source.store.close(); }
  });

  it('attribution falls back to the hot pool for a tx the archive cannot find', async () => {
    const { source, hot, archive } = await gap(adapter('UNKNOWN'));
    archive.getLogs.mockResolvedValueOnce([log(10n)]);
    archive.getTransaction.mockRejectedValue(new Error('not found'));
    try {
      await source.tailFills();
      expect(archive.getTransaction).toHaveBeenCalledTimes(2); // its two tries
      expect(hot.getTransaction).toHaveBeenCalledOnce();
      expect(source.fills[0].category).toBe('DIRECT');
      expect(source.lastBlock).toBe(1000n);
    } finally { source.store.close(); }
  });
});
