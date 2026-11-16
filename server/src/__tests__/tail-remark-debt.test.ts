// Markouts for fills the tail lands on CLOSED days (live.ts oweTailRemark /
// payTailRemark).
//
// A fill decoded after its markout horizons can only be marked by the remark
// sweep, and the sweep writes its cursor for every day it walks whether or not
// the day held fills yet. The 2026-11-12 hold lasted more than three days: by
// the time the tail came back to 11-12 and 11-13, a sweep could already be
// past them, and their fills would have stayed unmarked for good. A 'markets'
// revision and an additive re-read already rewind the cursors for the fills
// they insert; the tail did not. These tests pin that it now does, and that
// the debt is committed with the fills that owe it.
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
const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** noon UTC, `n` days before today: unambiguously inside that closed day */
const noon = (n: number) => Math.floor(Date.now() / DAY_MS) * DAY_MS - n * DAY_MS + DAY_MS / 2;

let seq = 0;
const fill = (ts: number, market = 'MON/USDC', extra: Record<string, unknown> = {}) => ({
  id: `${VENUE.id}-0x${(++seq).toString(16).padStart(64, '0')}-0`, venueId: VENUE.id, market, side: 'buy', category: 'DIRECT',
  usd: 100, baseAmount: 5_000, execPx: 0.02, txHash: `0x${seq.toString(16).padStart(64, '0')}`, to: '0xdead…beef', pool: 'p',
  blockNumber: seq, ts, markoutsBps: [null, null, null, null, null], ...extra,
});

async function setup() {
  const path = join(tmpdir(), `tail-remark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL', 'off');
  vi.stubEnv('MARKOUT_BACKFILL', 'off');
  vi.stubEnv('GAS_METRIC', 'off');
  vi.stubEnv('DEPTH', 'off');
  vi.stubEnv('BACKFILL_PACE_MS', '0');
  vi.resetModules();
  const adapter = { venues: () => [VENUE], discover: vi.fn(async () => {}), logSources: () => [], decode: vi.fn(async () => []) };
  vi.doMock('../chain/rpc.js', () => ({
    hotHeadEndpoint: () => ({ generation: 0 }),
    resolveQuoteBlock: async (number: bigint) => ({ number, generation: 0 }),
    monad: { blockTime: 300 },
    publicClient: {}, quoteClient: {}, headClient: {}, archiveClient: {},
    getLogsChunked: vi.fn(async () => []),
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
    ADAPTERS: [adapter],
    REFERENCES: {
      start: vi.fn(async () => {}), stop: vi.fn(),
      assetUsd: vi.fn(() => 1), settledUsd: vi.fn(() => 1), changePctFor: vi.fn(() => 0), midForPair: vi.fn(() => 1),
      quote: vi.fn(() => []), metas: () => [],
    },
    venueMeta: () => [VENUE],
    venueIds: () => [VENUE.id],
    allVenueIds: () => [VENUE.id],
    allAdapterVenueIds: () => new Set([VENUE.id]),
    validateRegistry: vi.fn(),
  }));
  // the archived mid every mark is taken against: 1% above the fills' execPx
  const pairMidSeries = vi.fn(async (_market: string, _from: number, _to: number) => ({ at: () => 0.0202 }));
  vi.doMock('../history/cex.js', () => ({ pairMidSeries, supportsHistoricalReference: () => true }));

  const live = await import('../datasource/live.js');
  const source = new live.LiveDataSource() as any;
  source.knownVenueIds = new Set([VENUE.id]);
  const meta = (key: string): string | undefined => source.store.getMeta(key) || undefined;
  const debt = () => { const v = meta(live.tailRemarkKey(VENUE.id)); return v ? JSON.parse(v) : undefined; };
  const cursor = (market: string) => `mkhist_cursor_${VENUE.id}_${market}`;
  /** run `work` the way the tail loop would let it: its gates drained between cycles */
  const withTail = async <T>(work: Promise<T>): Promise<T> => {
    let done = false;
    const settled = work.finally(() => { done = true; });
    while (!done) {
      for (const gate of source.tailGates.splice(0)) await gate();
      await new Promise((r) => setImmediate(r));
    }
    return settled;
  };
  const stored = (id: string) => source.store.fillsSince(0, 1000).find((f: any) => f.id === id);
  return { live, source, meta, debt, cursor, withTail, stored, pairMidSeries };
}

describe('the tail owes a remark rewind for fills it lands on closed days', () => {
  it('commits the debt in the snapshot that carries the fill', async () => {
    const { source, debt } = await setup();
    try {
      source.ingest(fill(noon(3)));
      expect(debt()).toBeUndefined(); // nothing on disk before the fill is
      await source.persist();
      expect(debt()).toEqual({ day: day(noon(3)), markets: ['MON/USDC'] });
    } finally { source.store.close(); }
  });

  it("owes nothing for today's fills: the sweep never walks today", async () => {
    const { source, debt } = await setup();
    try {
      source.ingest(fill(Date.now() - 1_000));
      await source.persist();
      expect(debt()).toBeUndefined();
      expect(source.tailRemarkOwed.size).toBe(0);
    } finally { source.store.close(); }
  });

  it('owes nothing for an approximate-price fill, which is never marked', async () => {
    const { source, debt } = await setup();
    try {
      source.ingest(fill(noon(3), 'MON/USDC', { pxApprox: true }));
      await source.persist();
      expect(debt()).toBeUndefined();
    } finally { source.store.close(); }
  });

  it('keeps the EARLIEST day and every market, across snapshots that overlap', async () => {
    const { source, debt } = await setup();
    try {
      source.ingest(fill(noon(2), 'MON/USDC'));
      const first = source.persist(); // cut, not yet acknowledged…
      source.ingest(fill(noon(4), 'cbBTC/MON'));
      const second = source.persist(); // …when the next one is cut
      await Promise.all([first, second]);
      // the later snapshot wrote everything unpaid, so landing last it erased nothing
      expect(debt()).toEqual({ day: day(noon(4)), markets: ['MON/USDC', 'cbBTC/MON'] });
    } finally { source.store.close(); }
  });

  it('adds to a debt a previous process left unpaid', async () => {
    const { live, source, debt } = await setup();
    try {
      await source.storeWriter.setMeta(live.tailRemarkKey(VENUE.id), JSON.stringify({ day: day(noon(6)), markets: ['ETH/USDC'] }));
      source.ingest(fill(noon(2), 'MON/USDC'));
      await source.persist();
      expect(debt()).toEqual({ day: day(noon(6)), markets: ['ETH/USDC', 'MON/USDC'] });
    } finally { source.store.close(); }
  });

  it('writes the debt again when the snapshot that carried it failed', async () => {
    const { source, debt } = await setup();
    try {
      source.ingest(fill(noon(3)));
      const write = source.storeWriter.persist.bind(source.storeWriter);
      source.storeWriter.persist = vi.fn(async () => { throw new Error('disk full'); });
      await source.persist();
      expect(debt()).toBeUndefined();
      source.storeWriter.persist = write;
      await source.persist();
      expect(debt()).toEqual({ day: day(noon(3)), markets: ['MON/USDC'] });
    } finally { source.store.close(); }
  });
});

describe('payTailRemark', () => {
  it('rewinds only the owed markets whose cursor is PAST the owed day, and clears the debt', async () => {
    const { source, meta, debt, cursor, withTail } = await setup();
    try {
      await source.storeWriter.setMeta(cursor('MON/USDC'), day(noon(1)));  // walked past the fill's day
      await source.storeWriter.setMeta(cursor('cbBTC/MON'), day(noon(5))); // still before it
      await source.storeWriter.setMeta(cursor('ETH/USDC'), day(noon(1)));  // past it, but owed nothing
      source.ingest(fill(noon(3), 'MON/USDC'));
      source.ingest(fill(noon(3), 'cbBTC/MON'));
      await withTail(source.payTailRemark(VENUE.id)); // flushes the fills itself

      expect(meta(cursor('MON/USDC'))).toBe(day(noon(3)));
      expect(meta(cursor('cbBTC/MON'))).toBe(day(noon(5)));
      expect(meta(cursor('ETH/USDC'))).toBe(day(noon(1)));
      expect(debt()).toBeUndefined();
      expect(source.tailRemarkOwed.size).toBe(0);
      // and it stays cleared: the next snapshot has no debt to write back
      await source.persist();
      expect(debt()).toBeUndefined();
    } finally { source.store.close(); }
  });

  it('does not stop the tail when nothing is owed', async () => {
    const { source } = await setup();
    try {
      await source.payTailRemark(VENUE.id); // resolves without a gate
      expect(source.tailGates).toHaveLength(0);
    } finally { source.store.close(); }
  });

  it('a fill landed after the debt was paid owes afresh', async () => {
    const { source, debt, withTail } = await setup();
    try {
      source.ingest(fill(noon(3)));
      await withTail(source.payTailRemark(VENUE.id));
      source.ingest(fill(noon(2)));
      await source.persist();
      expect(debt()).toEqual({ day: day(noon(2)), markets: ['MON/USDC'] });
    } finally { source.store.close(); }
  });
});

describe('remarkVenue after a held tail', () => {
  it('marks a fill the tail landed on a day the cursor had already walked past', async () => {
    const { source, meta, cursor, withTail, stored, pairMidSeries } = await setup();
    try {
      // the hold: the sweep walked on while the tail was stuck before day −4
      await source.storeWriter.setMeta(cursor('MON/USDC'), day(noon(2)));
      const late = fill(noon(4));
      source.ingest(late); // the gap-fill reaches day −4 only now
      await withTail(source.remarkVenue(VENUE.id, VENUE.name));

      // buy at 0.02 against an archived mid of 0.0202: +100 bps at every horizon
      const marks = stored(late.id).markoutsBps as number[];
      expect(marks).toHaveLength(5);
      for (const m of marks) expect(m).toBeCloseTo(100, 6);
      expect(pairMidSeries.mock.calls.map((c) => day(c[1]))).toContain(day(noon(4)));
      expect(meta(cursor('MON/USDC'))! >= day(noon(4))).toBe(true); // walked forward again from the owed day
    } finally { source.store.close(); }
  });

  it('is what the rewind is for: without the debt the same fill is never reached', async () => {
    const { live, source, cursor, withTail, stored } = await setup();
    try {
      await source.storeWriter.setMeta(cursor('MON/USDC'), day(noon(2)));
      const late = fill(noon(4));
      source.ingest(late);
      await source.persist();
      // the tail as it was: the fill is stored, nothing is owed for it
      source.tailRemarkOwed.clear(); source.tailRemarkDirty.clear();
      await source.storeWriter.setMeta(live.tailRemarkKey(VENUE.id), '');
      await withTail(source.remarkVenue(VENUE.id, VENUE.name));
      expect(stored(late.id).markoutsBps).toEqual([null, null, null, null, null]);
    } finally { source.store.close(); }
  });
});
