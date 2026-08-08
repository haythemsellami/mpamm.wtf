// Archive-pending note lifecycle (live.ts checkArchivePending). Family A of #6.
// The bug this covers: the "CEX price archive not published yet" note was sticky
// for the process lifetime, so a maintainer saw "markouts resume later" for hours
// after the month's archive had landed and the deferred fills were marked.
import { describe, expect, it } from 'vitest';
import { checkArchivePending } from '../datasource/live.js';

const HANJI = { vid: 'hanji', name: 'Hanji', market: 'MON/USDC', day: '2026-07-31' };
const PENDING = 'Hanji MON/USDC: CEX price archive for 2026-07-31 not published yet — markouts resume later';

/** notes array that behaves like the source's: warn dedupes, clear retracts. */
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

describe('checkArchivePending', () => {
  it('warns while the archive is unpublished, only once across repeated sweeps', () => {
    const { notes, io } = sink();
    const pending = new Set<string>();
    checkArchivePending(HANJI, false, pending, io);
    checkArchivePending(HANJI, false, pending, io);
    expect(notes).toEqual([PENDING]);
    expect(pending.has('hanji:MON/USDC:2026-07-31')).toBe(true);
  });

  it('RETRACTS the pending note and announces when the archive publishes', () => {
    const { notes, io } = sink();
    const pending = new Set<string>();
    checkArchivePending(HANJI, false, pending, io);
    expect(notes).toEqual([PENDING]);

    checkArchivePending(HANJI, true, pending, io);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('Hanji MON/USDC: CEX price archive for 2026-07-31 published — markouts resumed');
    expect(notes).not.toContain(PENDING); // the stale note is GONE
    expect(pending.has('hanji:MON/USDC:2026-07-31')).toBe(false);
  });

  it('clear() receives the exact string warn() emitted (else the stale note survives)', () => {
    const warned: string[] = [], cleared: string[] = [];
    const pending = new Set<string>();
    const io = { warn: (m: string) => warned.push(m), clear: (m: string) => cleared.push(m), announce: () => {} };
    checkArchivePending(HANJI, false, pending, io); // unpublished → warn
    checkArchivePending(HANJI, true, pending, io);  // published → clear
    expect(cleared).toEqual(warned);
  });

  it('says nothing for a market whose archive was published all along', () => {
    const { notes, io } = sink();
    const pending = new Set<string>();
    checkArchivePending(HANJI, true, pending, io);
    checkArchivePending(HANJI, true, pending, io);
    expect(notes).toEqual([]);
    expect(pending.size).toBe(0);
  });

  it('tracks (venue, market, day) independently: one market publishing does not clear another', () => {
    const { notes, io } = sink();
    const pending = new Set<string>();
    const usdt = { vid: 'hanji', name: 'Hanji', market: 'MON/USDT0', day: '2026-07-31' };
    checkArchivePending(HANJI, false, pending, io);
    checkArchivePending(usdt, false, pending, io);
    expect(notes).toHaveLength(2);
    checkArchivePending(HANJI, true, pending, io); // only USDC publishes
    expect([...pending]).toEqual(['hanji:MON/USDT0:2026-07-31']);
    expect(notes).toContain('Hanji MON/USDT0: CEX price archive for 2026-07-31 not published yet — markouts resume later');
  });

  it('re-warns for a later deferred day after an earlier one has published', () => {
    const { notes, io } = sink();
    const pending = new Set<string>();
    const aug = { vid: 'hanji', name: 'Hanji', market: 'MON/USDC', day: '2026-08-31' };
    checkArchivePending(HANJI, false, pending, io); // July deferred
    checkArchivePending(HANJI, true, pending, io);  // July publishes → clear + announce
    checkArchivePending(aug, false, pending, io);   // August now deferred → fresh warn
    expect(notes).toContain('Hanji MON/USDC: CEX price archive for 2026-08-31 not published yet — markouts resume later');
    expect([...pending]).toEqual(['hanji:MON/USDC:2026-08-31']);
  });
});
