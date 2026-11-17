// The history scans decode CLOSED days, long after they traded, and used to
// hand decode the live pricer: a crypto-quoted fill was valued at the price on
// the day of the replay. BTR's lifetime backfill (2026-11-16, MON at $0.015)
// booked $19,663 for 150 fills that traded for $26,059. These pin the fix on
// the REAL backfillAdapter and backfillRecentFills: decode gets a pricer as of
// the chunk's own blocks (closed-day-prices.ts), the volume and the stored
// fills agree, a stable-quoted venue fetches nothing, and a late archive
// holds the scan with nothing written. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fill } from '@shared';
import type { AdapterContext, LogSource, VenueAdapter } from '../venues/adapter.js';
import type { DayPrices } from '../history/cex.js';

const START = 4_000_000n;
const VID = 'closed-day';
const ADDRESS = '0x00000000000000000000000000000000000000f3' as const;
const FILL_TS = Date.parse('2026-10-14T09:30:00Z');
const NOW = Date.parse('2026-11-16T15:20:00Z');
/** MON on the fill's day (Bybit, 2026-10-14) against the day of the replay */
const MON_THEN = 0.0244;

const paths: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

const row = (id: string): Omit<Fill, 'market' | 'usd' | 'baseAmount' | 'execPx'> => ({
  id, venueId: VID, side: 'sell', category: 'UNKNOWN', txHash: `0x${id}`, to: 'x', pool: 'p',
  blockNumber: Number(START), ts: FILL_TS, markoutsBps: [null, null, null, null, null],
});
/** a BTC/MON fill of `mon` WMON on the quote leg, valued the way the adapters do */
const monQuoted = (ctx: AdapterContext, id: string, mon: number): Fill => ({
  ...row(id), market: 'BTC/MON', usd: ctx.pricer.usdForToken('WMON', mon), baseAmount: mon / 3_400_000, execPx: 3_400_000,
});
/** a MON/USDC fill: its USD is the stable leg, and no asset price is asked for */
const stableQuoted = (ctx: AdapterContext, id: string, usdc: number): Fill => ({
  ...row(id), market: 'MON/USDC', usd: ctx.pricer.usdForToken('USDC', usdc), baseAmount: usdc / MON_THEN, execPx: MON_THEN,
});

interface Chain {
  /** BACKFILL_CHUNK; one block a chunk by default */
  chunk?: number;
  /** what the archive's getLogs answers for the chunk */
  logs?: () => Array<{ blockNumber: bigint }>;
  /** a block's timestamp in seconds */
  blockTs?: (bn: bigint) => bigint;
}

async function setup(decode: (ctx: AdapterContext, bundle: any) => Fill[], assetUsdDay: (asset: string, day: string) => Promise<DayPrices | null>, chain: Chain = {}) {
  const path = join(tmpdir(), `replay-closed-day-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL_CHUNK', String(chain.chunk ?? 1));
  vi.stubEnv('GETLOGS_CHUNK', '1');
  vi.stubEnv('GETLOGS_MIN_CHUNK', '1');
  vi.stubEnv('BACKFILL_MERGE_EVERY', '1');
  vi.stubEnv('BACKFILL_PACE_MS', '0');
  vi.resetModules();

  const archiveClient: any = {
    getLogs: vi.fn(async () => chain.logs?.() ?? [{ blockNumber: START }]),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: chain.blockTs?.(blockNumber) ?? BigInt(FILL_TS / 1000) })),
    getBlockNumber: async () => START,
  };
  const status = () => ({ active: 'archive', degraded: false, down: false });
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint, identity = {}) => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, generation: 0, ...identity }),
    publicClient: {},
    quoteClient: {},
    headClient: { getBlockNumber: vi.fn(async () => 100n) },
    archiveClient,
    getLogsChunked: vi.fn(async (p: unknown, _o: unknown, fetch: (p: unknown) => Promise<unknown[]>) => fetch(p)),
    probeChain: vi.fn(),
    probeArchiveChain: vi.fn(),
    blockAtOrAfter: vi.fn(async () => START),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: status,
    rpcGeneration: () => 0,
    archiveRpcStatus: status,
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: true,
  }));
  const archive = vi.fn(assetUsdDay);
  vi.doMock('../history/cex.js', async () => ({ ...(await vi.importActual<Record<string, unknown>>('../history/cex.js')), assetUsdDay: archive }));

  const live = await import('../datasource/live.js');
  const source = new live.LiveDataSource() as any;
  source.runRereads = vi.fn(async () => {}); // the replay's queued re-read of today is not under test
  const notes: string[] = [];
  const noteOnce = source.noteOnce.bind(source);
  source.noteOnce = (code: string, msg: string, venue?: string) => { notes.push(`${code}: ${msg}`); return noteOnce(code, msg, venue); };
  const decodeSpy = vi.fn(async (ctx: AdapterContext, bundle: any) => decode(ctx, bundle));
  const adapter = {
    venues: () => [{ id: VID, name: 'Closed', color: { light: '#000', dark: '#fff' }, kind: 'amm' as const, role: 'venue' as const, sinceUtc: '2026-10-01' }],
    backfillFromUtc: '2026-10-01',
    discover: async () => {},
    logSources: () => [{ key: 'fills', address: ADDRESS, events: [] }],
    decode: decodeSpy,
  } as unknown as VenueAdapter;
  const sources: LogSource[] = [{ key: 'fills', address: ADDRESS, events: [] }];
  const day = () => source.store.all().find((d: { utcDay: string }) => d.utcDay === '2026-10-14')?.byVenue[VID];
  const fills = () => source.store.venueFillsInRange(VID, Date.parse('2026-10-14T00:00:00Z'), Date.parse('2026-10-15T00:00:00Z'), START) as Fill[];
  return { source, adapter, sources, archive, archiveClient, decodeSpy, notes, day, fills };
}

const flat = (px: number): DayPrices => ({ at: () => px });

describe('the volume replay prices a closed day as of its own blocks', () => {
  it("books a crypto-quoted fill at the asset's archived price that day, not the price while replaying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const s = await setup((ctx) => [monQuoted(ctx, 'a', 10_000), stableQuoted(ctx, 'b', 168.286102)], async (asset) => (asset === 'MON' ? flat(MON_THEN) : null));

    const run = s.source.backfillAdapter(s.adapter, VID, 'Closed', '2026-10-01', s.sources, NOW, START);
    await vi.runAllTimersAsync();
    await run;

    // 10,000 WMON × $0.0244 + the USDC leg as transferred
    expect(s.day().swaps).toBe(2);
    expect(s.day().usd).toBeCloseTo(244 + 168.286102, 6);
    expect(s.archive.mock.calls).toEqual([['MON', '2026-10-14']]);
    expect(s.source.store.getMeta(`backfill_done_${VID}`)).toBe('1');
    s.source.store.close();
  });

  it('asks no archive for a venue with only stable-quoted fills', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const s = await setup((ctx) => [stableQuoted(ctx, 'b', 168.286102)], async () => flat(1));

    const run = s.source.backfillAdapter(s.adapter, VID, 'Closed', '2026-10-01', s.sources, NOW, START);
    await vi.runAllTimersAsync();
    await run;

    expect(s.day()).toEqual({ usd: 168.286102, swaps: 1 });
    expect(s.archive).not.toHaveBeenCalled();
    expect(s.decodeSpy).toHaveBeenCalledTimes(1);
    s.source.store.close();
  });

  it('holds on an archive that is not published yet: no day written, not done, and the next run prices it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let published = false;
    const s = await setup((ctx) => [monQuoted(ctx, 'a', 10_000)], async () => {
      if (!published) throw new Error('bybit book archive MONUSDT 2026-10-14 is not published yet');
      return flat(MON_THEN);
    });

    const held = s.source.backfillAdapter(s.adapter, VID, 'Closed', '2026-10-01', s.sources, NOW, START);
    const rejected = expect(held).rejects.toThrow(/not published yet/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(s.day()).toBeUndefined();          // never the $150 the live price would book
    expect(s.source.store.getMeta(`backfill_done_${VID}`)).not.toBe('1');

    published = true;
    const run = s.source.backfillAdapter(s.adapter, VID, 'Closed', '2026-10-01', s.sources, NOW, START);
    await vi.runAllTimersAsync();
    await run;
    expect(s.day().usd).toBeCloseTo(244, 6);
    s.source.store.close();
  });

  it('keeps the live price for an asset with no archive at all, and notes it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // no archive answers, and the test's live feeds are cold: the adapter's own base-leg fallback is the `|| 1`
    const s = await setup((ctx) => [stableQuoted(ctx, 'b', 50), { ...row('a'), market: 'BTC/MON', usd: ctx.pricer.usdForToken('WMON', 100) || 1, baseAmount: 1, execPx: 1 }], async () => null);

    const run = s.source.backfillAdapter(s.adapter, VID, 'Closed', '2026-10-01', s.sources, NOW, START);
    await vi.runAllTimersAsync();
    await run;

    expect(s.day().swaps).toBe(2);
    expect(s.notes).toContain('backfill.price.live: Closed: no archived price for MON — its crypto-quoted fills on replayed days are valued at the price when replayed');
    s.source.store.close();
  });
});

describe('a chunk that spans minutes is priced slice by slice', () => {
  it('values two fills four minutes apart at their own prices, from the two block times the replay reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // MON fell 2% inside the chunk: $0.0250 until 09:32, $0.0245 after
    const falling: DayPrices = { at: (t) => (t < FILL_TS + 120_000 ? 0.0250 : 0.0245) };
    const s = await setup(
      (ctx, bundle) => bundle.fills.map((l: { blockNumber: bigint }) => monQuoted(ctx, String(l.blockNumber), 10_000)),
      async (asset) => (asset === 'MON' ? falling : null),
      {
        chunk: 1_000,
        // one fill at the chunk's first block, one 800 blocks (4 min at 0.3s) later
        logs: () => [{ blockNumber: START }, { blockNumber: START + 800n }],
        blockTs: (bn) => BigInt(FILL_TS / 1000) + (bn - START) * 3n / 10n,
      },
    );

    const run = s.source.backfillAdapter(s.adapter, VID, 'Closed', '2026-10-01', s.sources, NOW, START + 999n);
    await vi.runAllTimersAsync();
    await run;

    // one instant for the chunk would book both at $0.0250 (500), or both at $0.0245 (490)
    expect(s.day().swaps).toBe(2);
    expect(s.day().usd).toBeCloseTo(10_000 * 0.0250 + 10_000 * 0.0245, 6);
    expect(s.decodeSpy.mock.calls.filter(([, bundle]) => bundle.fills.length === 1).length).toBeGreaterThanOrEqual(2);
    // the day's prices are fetched once, and only the chunk's two ends are read for time
    expect(s.archive).toHaveBeenCalledTimes(1);
    expect(s.archiveClient.getBlock).toHaveBeenCalledTimes(2);
    s.source.store.close();
  });
});

describe('the onboarding fill scan values its fills the same way', () => {
  it('stores a crypto-quoted fill with the USD the volume replay booked for it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const s = await setup((ctx) => [monQuoted(ctx, 'a', 10_000)], async (asset) => (asset === 'MON' ? flat(MON_THEN) : null));

    const run = s.source.backfillRecentFills(s.adapter, VID, 'Closed', s.sources, NOW, START);
    await vi.runAllTimersAsync();
    await run;

    const [stored] = s.fills();
    expect(stored.id).toBe('a');
    expect(stored.usd).toBeCloseTo(244, 6);
    expect(s.archive.mock.calls).toEqual([['MON', '2026-10-14']]);
    s.source.store.close();
  });
});
