// Gap-fill catch-up note lifecycle (live.ts checkGapFill). Family B of #6.
// The bug this covers: the boot "resuming: gap-filling N block(s)" note was
// sticky for the process lifetime, so it kept implying the tail was behind long
// after the cursor had caught up to the boot head and gone current.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkGapFill, shouldGapFill } from '../datasource/live.js';

afterEach(() => vi.resetModules());

const RESUME = 'resuming: gap-filling 128 block(s) since last run';

/** notes array that behaves like the source's: announce pushes, clear retracts. */
const sink = () => {
  const notes: string[] = [];
  return {
    notes,
    io: {
      clear: (m: string) => { const i = notes.indexOf(m); if (i >= 0) notes.splice(i, 1); },
      announce: (m: string) => notes.push(m),
    },
  };
};

describe('checkGapFill', () => {
  it('does nothing while the cursor is still short of the boot head', () => {
    const { notes, io } = sink();
    const state: { msg?: string } = { msg: RESUME };
    notes.push(RESUME); // the boot resume note, still outstanding
    checkGapFill(900n, 1000n, state, io);
    expect(notes).toEqual([RESUME]);
    expect(state.msg).toBe(RESUME);
  });

  it('RETRACTS the resume note and announces once the cursor reaches the boot head', () => {
    const { notes, io } = sink();
    const state: { msg?: string } = { msg: RESUME };
    notes.push(RESUME);
    checkGapFill(1000n, 1000n, state, io);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('gap-fill caught up: decoded through block 1000');
    expect(notes).not.toContain(RESUME); // the stale note is GONE
    expect(state.msg).toBeUndefined();
  });

  it('clear() receives the exact string emitted at boot (else the stale note survives)', () => {
    const cleared: string[] = [];
    const state: { msg?: string } = { msg: RESUME };
    const io = { clear: (m: string) => cleared.push(m), announce: () => {} };
    checkGapFill(1000n, 1000n, state, io);
    expect(cleared).toEqual([RESUME]);
  });

  it('fires once: a later tail tick past the boot head says nothing more', () => {
    const { notes, io } = sink();
    const state: { msg?: string } = { msg: RESUME };
    notes.push(RESUME);
    checkGapFill(1000n, 1000n, state, io); // catches up
    const after = [...notes];
    checkGapFill(1200n, 1000n, state, io); // still current, nothing to say
    expect(notes).toEqual(after);
  });

  it('says nothing when there was no gap to fill (cold start leaves msg unset)', () => {
    const { notes, io } = sink();
    const state: { msg?: string } = {}; // cold start / gap skipped never set it
    checkGapFill(1000n, 1000n, state, io);
    checkGapFill(2000n, 1000n, state, io);
    expect(notes).toEqual([]);
    expect(state.msg).toBeUndefined();
  });
});

// Resume-vs-cold-start (shouldGapFill). The 200k default cap silently dropped
// a ~216k-block outage hole on 2026-09-17 (fix deploy cold-started past it;
// the day's volume stayed undercounted) — these pin the new behavior: resume
// for ANY gap unless an operator explicitly set a smaller GAPFILL_MAX_BLOCKS.
describe('shouldGapFill', () => {
  it('no persisted cursor (first boot) is a cold start, not a loss', () => {
    expect(shouldGapFill(undefined, 1000n, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(shouldGapFill('', 1000n, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('cursor current or behind by exactly the cap resumes', () => {
    expect(shouldGapFill('1000', 1000n, 0)).toBe(true); // gap 0 ≤ 0
    expect(shouldGapFill('900', 1000n, 100)).toBe(true); // gap 100 == cap, inclusive
  });

  it('a gap one past an operator-set cap cold-starts (the warned, lossy path)', () => {
    expect(shouldGapFill('899', 1000n, 100)).toBe(false); // gap 101 > 100
  });

  it('an outage-sized gap resumes under the unlimited default', () => {
    // the 2026-09-17 incident shape: ~216k-block hole, default cap at the time 200k
    expect(shouldGapFill('105331612', 105548026n, 200_000)).toBe(false); // what happened
    expect(shouldGapFill('105331612', 105548026n, Number.MAX_SAFE_INTEGER)).toBe(true); // now
  });
});

describe('GAPFILL_MAX_BLOCKS default', () => {
  it('is unlimited unless explicitly set — a re-tightened default re-creates the 2026-09-17 loss', async () => {
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.gapFillMaxBlocks).toBe(Number.MAX_SAFE_INTEGER);
  });
});
