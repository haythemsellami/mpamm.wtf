// Gap-fill catch-up note lifecycle (live.ts checkGapFill). Family B of #6.
// The bug this covers: the boot "resuming: gap-filling N block(s)" note was
// sticky for the process lifetime, so it kept implying the tail was behind long
// after the cursor had caught up to the boot head and gone current.
import { describe, expect, it } from 'vitest';
import { checkGapFill } from '../datasource/live.js';

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
