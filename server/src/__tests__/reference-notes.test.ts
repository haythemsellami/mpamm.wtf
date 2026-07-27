// Reference-feed starvation note lifecycle (live.ts checkReferenceStarvation).
// The bug this covers: the "pairs are hidden" warning was sticky for the
// process lifetime, so prod kept showing it for hours after the feed recovered
// and MON quotes were visibly live again.
import { describe, expect, it } from 'vitest';
import { checkReferenceStarvation } from '../datasource/live.js';

const MON = { key: 'MON', symbol: 'MON', cex: 'bybit', cexSymbol: 'MONUSDT' };
const BTC = { key: 'BTC', symbol: 'BTC', cex: 'binance', cexSymbol: 'BTCUSDT' };
const WARN_MON = 'bybit feed has no MONUSDT mid — MON pairs are hidden (reference/markouts unavailable)';

/** notes array that behaves like the source's: noteOnce dedupes, dropNote retracts. */
const sink = () => {
  const notes: string[] = [];
  return {
    notes,
    io: {
      warn: (m: string) => { if (!notes.includes(m)) notes.push(m); },
      clear: (m: string) => { const i = notes.indexOf(m); if (i >= 0) notes.splice(i, 1); },
      announce: (m: string) => notes.push(m),
    },
  };
};
const T0 = 1_800_000_000_000;

describe('checkReferenceStarvation', () => {
  it('warns while a mid is dark, and only once across repeated ticks', () => {
    const { notes, io } = sink();
    const st = new Map<string, number>();
    const mids = () => 0;
    checkReferenceStarvation([MON], mids, st, T0, io);
    checkReferenceStarvation([MON], mids, st, T0 + 1_000, io);
    checkReferenceStarvation([MON], mids, st, T0 + 2_000, io);
    expect(notes).toEqual([WARN_MON]);
    expect(st.get('MON')).toBe(T0); // starvation start is the FIRST dark tick
  });

  it('RETRACTS the warning and announces when the mid returns', () => {
    const { notes, io } = sink();
    const st = new Map<string, number>();
    checkReferenceStarvation([MON], () => 0, st, T0, io);
    expect(notes).toEqual([WARN_MON]);

    checkReferenceStarvation([MON], () => 0.021, st, T0 + 7 * 60_000, io);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('bybit feed recovered: MONUSDT mid is back — MON pairs visible again (hidden for ~7m)');
    expect(notes).not.toContain(WARN_MON); // the stale scare-warning is GONE
    expect(st.has('MON')).toBe(false);
  });

  it('clear() receives the exact string warn() emitted (else the stale note survives)', () => {
    const warned: string[] = [], cleared: string[] = [];
    const st = new Map<string, number>();
    const io = { warn: (m: string) => warned.push(m), clear: (m: string) => cleared.push(m), announce: () => {} };
    checkReferenceStarvation([MON], () => 0, st, T0, io);
    checkReferenceStarvation([MON], () => 1, st, T0 + 60_000, io);
    expect(cleared).toEqual(warned);
  });

  it('says nothing at all for a feed that was never starved', () => {
    const { notes, io } = sink();
    const st = new Map<string, number>();
    checkReferenceStarvation([MON, BTC], () => 42, st, T0, io);
    checkReferenceStarvation([MON, BTC], () => 42, st, T0 + 60_000, io);
    expect(notes).toEqual([]);
    expect(st.size).toBe(0);
  });

  it('tracks assets independently — one dark feed does not clear another', () => {
    const { notes, io } = sink();
    const st = new Map<string, number>();
    const mids = (k: string) => (k === 'MON' ? 0 : 65_000); // MON dark, BTC healthy
    checkReferenceStarvation([MON, BTC], mids, st, T0, io);
    expect(notes).toEqual([WARN_MON]);
    expect([...st.keys()]).toEqual(['MON']);
  });

  it('re-warns after a recovery if the feed goes dark again', () => {
    const { notes, io } = sink();
    const st = new Map<string, number>();
    checkReferenceStarvation([MON], () => 0, st, T0, io);
    checkReferenceStarvation([MON], () => 0.02, st, T0 + 60_000, io);       // recovered
    checkReferenceStarvation([MON], () => 0, st, T0 + 120_000, io);          // dark again
    expect(notes.filter((n) => n === WARN_MON)).toHaveLength(1);
    expect(notes[notes.length - 1]).toBe(WARN_MON);
    expect(st.get('MON')).toBe(T0 + 120_000); // fresh starvation clock
  });

  it('a sub-minute outage still reads as ~1m, never ~0m', () => {
    const { notes, io } = sink();
    const st = new Map<string, number>();
    checkReferenceStarvation([MON], () => 0, st, T0, io);
    checkReferenceStarvation([MON], () => 0.02, st, T0 + 5_000, io);
    expect(notes[0]).toContain('hidden for ~1m');
  });

  it('a negative/NaN mid counts as dark (feeds report 0 or garbage when starved)', () => {
    const { notes, io } = sink();
    const st = new Map<string, number>();
    checkReferenceStarvation([MON], () => -1, st, T0, io);
    expect(notes).toEqual([WARN_MON]);
  });
});
