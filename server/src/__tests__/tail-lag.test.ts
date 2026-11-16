// The fill tail reporting its own lag (live.ts tailStatusOf / checkTailHeld).
//
// On 2026-11-12 the tail held for more than three days after an RPC outage.
// Quotes at the tip were healthy, so the header read "live · RPC OK" and
// /api/health answered ok while three days of volume were $0. Nothing on
// either surface carried the cursor. These tests pin what was missing: the lag
// is computed, it reaches the state frame ONLY while the tail is behind (the
// frame budget), stuck is told apart from catching up, and a hold raises a
// note that is retracted when the cursor moves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REALTIME_HOLD_MS, TAIL_HELD_MS, TAIL_LAG_SHOWN_MS, checkTailHeld, tailIsLagging, tailStatusOf } from '../datasource/live.js';

const paths: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

const BLOCK_MS = 300;
/** blocks that are just past the shown threshold at BLOCK_MS */
const BEHIND = BigInt(TAIL_LAG_SHOWN_MS / BLOCK_MS) + 1n;

describe('tailStatusOf', () => {
  const at = (lastBlock: bigint, head: bigint, quietFor = 0) =>
    tailStatusOf({ lastBlock, head, blockTimeMs: BLOCK_MS, quietSince: 1_000_000 - quietFor, now: 1_000_000 });

  it('reads the finality margin as a few seconds, neither lagging nor held', () => {
    const t = at(1_000n, 1_005n, 3_600_000); // an hour without a move: a quiet tip is not a hold
    expect(t).toEqual({ block: 1_000, lagBlocks: 5, lagMs: 1_500, held: false });
    expect(tailIsLagging(t)).toBe(false);
  });

  it('is lagging only PAST the threshold', () => {
    expect(tailIsLagging(at(0n, BEHIND - 1n))).toBe(false); // exactly the threshold
    expect(tailIsLagging(at(0n, BEHIND))).toBe(true);
  });

  it('calls a far-behind tail held only after TAIL_HELD_MS without progress', () => {
    expect(at(0n, 1_000_000n, TAIL_HELD_MS).held).toBe(false);
    expect(at(0n, 1_000_000n, TAIL_HELD_MS + 1).held).toBe(true);
  });

  it('sizes the 2026-11-12 hold: 1,021,587 blocks is about 3.5 days', () => {
    const t = at(121_585_293n, 122_606_880n, 86_400_000);
    expect(t.lagBlocks).toBe(1_021_587);
    expect(t.lagMs / 86_400_000).toBeCloseTo(3.55, 1);
    expect(t.held).toBe(true);
  });

  it('never reports a negative lag when the cursor is at or past the head it knows', () => {
    expect(at(1_000n, 990n)).toMatchObject({ lagBlocks: 0, lagMs: 0, held: false });
  });
});

describe('checkTailHeld', () => {
  const sink = () => {
    const notes: string[] = [], log: string[] = [];
    return {
      notes, log,
      io: {
        // noteOnce: a verbatim repeat is dropped while the line is still held
        warn: (m: string) => { if (!notes.includes(m)) { notes.push(m); log.push(`warn ${m}`); } },
        clear: (m: string) => { const i = notes.indexOf(m); if (i >= 0) notes.splice(i, 1); },
        announce: (m: string) => { notes.push(m); log.push(`info ${m}`); },
      },
    };
  };
  const held = { block: 121_585_293, lagBlocks: 1_021_587, lagMs: 306_476_100, held: true };
  const moving = { ...held, block: 121_586_293, lagBlocks: 1_020_587, held: false };

  it('says nothing for a tail that was never held', () => {
    const { notes, io } = sink();
    checkTailHeld({ block: 1, lagBlocks: 5, lagMs: 1_500, held: false }, 0, 1, {}, io);
    expect(notes).toEqual([]);
  });

  it('raises ONE line for a hold, however many cycles it lasts and however far the head runs', () => {
    const { notes, log, io } = sink();
    const state = {};
    for (let i = 0; i < 500; i++) checkTailHeld({ ...held, lagBlocks: held.lagBlocks + i * 2, lagMs: held.lagMs + i * 600 }, 0, i * 500, state, io);
    expect(notes).toHaveLength(1);
    expect(log).toHaveLength(1);
    expect(notes[0]).toContain('held at block 121585293');
    expect(notes[0]).not.toMatch(/1021587|306476/); // the lag moves; a line naming it would never dedupe
  });

  it('raises the same line again once the buffer has rolled it out', () => {
    const { notes, log, io } = sink();
    const state = {};
    checkTailHeld(held, 0, 1, state, io);
    notes.length = 0; // the notes window evicted it
    checkTailHeld(held, 0, 2, state, io);
    expect(log).toHaveLength(2);
    expect(log[0]).toBe(log[1]);
  });

  it('retracts the line and announces the resume once, with how long the hold lasted', () => {
    const { notes, log, io } = sink();
    const state = {};
    const start = 1_000_000;
    checkTailHeld(held, start, start + TAIL_HELD_MS + 1, state, io);
    checkTailHeld(moving, start, start + 31 * 3_600_000, state, io);
    checkTailHeld(moving, start, start + 31 * 3_600_000 + 500, state, io);
    expect(notes).toEqual(['fill tail moving again after a hold of ~31h']);
    expect(log.filter((l) => l.startsWith('info'))).toHaveLength(1);
  });

  it('treats a second hold as a new one', () => {
    const { notes, io } = sink();
    const state = {};
    checkTailHeld(held, 0, 200_000, state, io);
    checkTailHeld(moving, 0, 300_000, state, io);
    checkTailHeld({ ...moving, held: true }, 300_000, 500_000, state, io);
    expect(notes.at(-1)).toContain('held at block 121586293');
  });
});

// The wiring: LiveDataSource samples the cursor once per tail cycle, and
// getState() is the state frame.
describe('LiveDataSource tail status', () => {
  const VENUE = { id: 'test-venue', name: 'Test Venue', color: { light: '#000', dark: '#fff' }, kind: 'amm' as const, role: 'venue' as const };

  async function setup() {
    const path = join(tmpdir(), `tail-lag-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(path);
    vi.stubEnv('DB_PATH', path);
    vi.stubEnv('BACKFILL', 'off');
    vi.stubEnv('MARKOUT_BACKFILL', 'off');
    vi.stubEnv('GAS_METRIC', 'off');
    vi.stubEnv('DEPTH', 'off');
    vi.resetModules();
    const adapter = { venues: () => [VENUE], discover: vi.fn(async () => {}), logSources: () => [], decode: vi.fn(async () => []) };
    vi.doMock('../chain/rpc.js', () => ({
      hotHeadEndpoint: () => ({ generation: 0 }),
      resolveQuoteBlock: async (number: bigint) => ({ number, generation: 0 }),
      monad: { blockTime: BLOCK_MS },
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
        assetUsd: vi.fn(() => 1), changePctFor: vi.fn(() => 0), midForPair: vi.fn(() => 1),
        quote: vi.fn(() => []), metas: () => [],
      },
      venueMeta: () => [],
      venueIds: () => [],
      allVenueIds: () => [VENUE.id],
      allAdapterVenueIds: () => new Set([VENUE.id]),
      validateRegistry: vi.fn(),
    }));
    const { LiveDataSource } = await import('../datasource/live.js');
    const source = new LiveDataSource() as any;
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const notes = (code: string) => (source.getState().notes as Array<{ code: string; level: string; msg: string }>).filter((n) => n.code === code);
    return { source, notes, advance: (ms: number) => { now += ms; } };
  }

  it('has no status before boot has set the resume point', async () => {
    const { source } = await setup();
    try {
      source.observedHead = 5_000n;
      expect(source.tailStatus()).toBeUndefined();
      expect('tail' in source.getState()).toBe(false);
    } finally { source.store.close(); }
  });

  it('at the tip: health has the status, the state frame has no tail key', async () => {
    const { source } = await setup();
    try {
      source.lastBlock = 1_000n;
      source.observedHead = 1_005n;
      source.observeTail();
      expect(source.tailStatus()).toEqual({ block: 1_000, lagBlocks: 5, lagMs: 1_500, held: false });
      expect('tail' in source.getState()).toBe(false);
    } finally { source.store.close(); }
  });

  it('behind and stuck: the frame carries it, held after TAIL_HELD_MS, with a warn note retracted on resume', async () => {
    const { source, notes, advance } = await setup();
    try {
      source.lastBlock = 1_000n;
      source.observedHead = 1_000n + BEHIND * 10n;
      source.observeTail();
      expect(source.getState().tail).toMatchObject({ block: 1_000, lagBlocks: Number(BEHIND * 10n), held: false });
      expect(notes('tail.held')).toEqual([]);

      advance(TAIL_HELD_MS + 1);
      source.observeTail();
      expect(source.getState().tail.held).toBe(true);
      expect(notes('tail.held')).toHaveLength(1);
      expect(notes('tail.held')[0]).toMatchObject({ level: 'warn' });

      advance(3_600_000);
      source.observeTail(); // still held an hour on: the same line, not a second one
      expect(notes('tail.held')).toHaveLength(1);

      source.lastBlock = 2_000n; // a window commits
      source.observeTail();
      expect(source.getState().tail).toMatchObject({ block: 2_000, held: false }); // still behind, now catching up
      expect(notes('tail.held')).toEqual([]);
      expect(notes('tail.resume').at(-1)?.msg).toBe('fill tail moving again after a hold of ~62m');
    } finally { source.store.close(); }
  });

  it('catching up: far behind for longer than TAIL_HELD_MS is not held while windows keep committing', async () => {
    const { source, notes, advance } = await setup();
    try {
      source.lastBlock = 1_000n;
      source.observedHead = 5_000_000n;
      for (let i = 0; i < 40; i++) {
        source.observeTail();
        expect(source.getState().tail.held).toBe(false);
        advance(10_000);
        source.lastBlock += 1_000n;
      }
      expect(notes('tail.held')).toEqual([]);
    } finally { source.store.close(); }
  });

  it('a tail that sat at the tip through an outage is not held the instant the head jumps', async () => {
    const { source, advance } = await setup();
    try {
      source.lastBlock = 1_000n;
      source.observedHead = 1_005n;
      source.observeTail();
      advance(31 * 3_600_000); // hot pool down: no head, no cursor move
      source.observeTail();
      source.observedHead = 1_005n + 372_000n; // recovered: the head is 31 h on
      source.observeTail();
      expect(source.getState().tail).toMatchObject({ lagBlocks: 372_005, held: false });

      advance(TAIL_HELD_MS + 1); // …and it gets this long to commit a window
      source.observeTail();
      expect(source.getState().tail.held).toBe(true);
    } finally { source.store.close(); }
  });

  it('back at the tip the key leaves the frame again', async () => {
    const { source } = await setup();
    try {
      source.lastBlock = 1_000n;
      source.observedHead = 1_000n + BEHIND * 10n;
      source.observeTail();
      expect('tail' in source.getState()).toBe(true);
      source.lastBlock = source.observedHead - 5n;
      source.observeTail();
      expect('tail' in source.getState()).toBe(false);
    } finally { source.store.close(); }
  });

  // The quote-pace note shares this harness (its lifecycle is unit-tested in
  // realtime.test.ts). Review of #171: the sampler returned early while no
  // frame existed, and a failed frame is retried silently, so a quote loop
  // failing every frame from boot was never reported at all.
  describe('quote pace sampler', () => {
    const SAMPLE_MS = 5_000;
    const degraded = 'quote.realtime.degraded';

    it('says nothing through warm-up, before the quote loop has started', async () => {
      const { source, notes, advance } = await setup();
      try {
        source.observedHead = 1_000n;
        for (let i = 0; i < 60; i++) { advance(SAMPLE_MS); source.observeRealtime(); }
        expect(notes(degraded)).toEqual([]);
      } finally { source.store.close(); }
    });

    it('reports a loop that never completes a frame while heads advance, and retracts on the first frame', async () => {
      const { source, notes, advance } = await setup();
      try {
        source.quoteLoopSince = Date.now();   // loops started; every poll() throws and is retried
        source.observedHead = 1_000n;
        const sample = () => { advance(SAMPLE_MS); source.observedHead += 16n; source.observeRealtime(); };

        for (let t = 0; t < REALTIME_HOLD_MS; t += SAMPLE_MS) sample(); // the startup grace
        expect(notes(degraded)).toEqual([]);
        expect(source.getState().realtime).toBeUndefined();            // nothing to read on /api/health either

        sample();
        expect(notes(degraded)).toHaveLength(1);
        expect(notes(degraded)[0]).toMatchObject({
          level: 'warn',
          msg: 'quotes are not keeping up with the chain head: no quote frame since the quote loop started — live values on GET /api/health',
        });
        for (let i = 0; i < 48; i++) sample();                           // four more minutes of failed frames
        expect(notes(degraded)).toHaveLength(1);

        // the first frame completes, at the head
        const at = Date.now();
        const block = Number(source.observedHead);
        source.quotes = { block, monUsd: 1, ts: at, rows: [], frame: {
          headSource: 'http', headObservedAt: at - 150, quoteStartedAt: at - 140, quoteCompletedAt: at, emittedAt: at,
          durationMs: 140, adapterMs: { 'test-venue': 120 }, missingVenues: [], coalescedBlocks: 0,
        } };
        source.realtimeFrames = [{ block, emittedAt: at, coalescedBlocks: 0, durationMs: 140 }];
        source.observeRealtime();
        expect(notes(degraded)).toHaveLength(1);                         // clear, not yet trusted
        advance(REALTIME_HOLD_MS);
        source.observeRealtime();
        expect(notes(degraded)).toEqual([]);
        expect(notes('quote.realtime.recovered').at(-1)).toMatchObject({ level: 'info', msg: 'quotes are keeping up with the chain head again after ~5m' });
      } finally { source.store.close(); }
    });
  });
});
