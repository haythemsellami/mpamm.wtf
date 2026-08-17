// BACKFILL_RESET's key set (live.ts resetVenueHistory).
//
// A reset that clears a done-flag but leaves its cursor reports success and
// recovers nothing: backfillRecentFills resumes with `if (cb > from) from = cb`,
// so a stale mkfill_cursor restarts the scan wherever the LAST onboarding
// finished — past the window the reset was reached for. Whether that bites
// depends on how long ago onboarding ran, which is exactly the kind of
// non-determinism a reset must not have.
import { describe, expect, it } from 'vitest';
import { resetVenueHistory } from '../datasource/live.js';

/** records what a reset touched, without a real SQLite file. */
function fakeStore(seed: Record<string, string> = {}) {
  const meta = new Map(Object.entries(seed));
  return {
    meta,
    setMeta: (k: string, v: string) => { meta.set(k, v); },
    deleteMetaPrefix: (p: string) => { for (const k of [...meta.keys()]) if (k.startsWith(p)) meta.delete(k); },
  };
}

const seeded = (vid: string) => ({
  [`backfill_done_${vid}`]: '1',
  [`backfill_cursor_${vid}`]: '95000000',
  [`mkfill_done_${vid}`]: '1',
  [`mkfill_cursor_${vid}`]: '96000000',      // past the window we want back
  [`mkhist_cursor_${vid}_MON/USDC`]: '2026-08-16',
  [`mkhist_cursor_${vid}_BTC/USDC`]: '2026-08-16',
});

describe('resetVenueHistory', () => {
  it('clears BOTH halves — volume and fills — flags and cursors alike', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric');
    expect(s.meta.get('backfill_done_metric')).toBe('');
    expect(s.meta.get('backfill_cursor_metric')).toBe('');
    expect(s.meta.get('mkfill_done_metric')).toBe('');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('');   // the one that was missed
  });

  it('drops every per-market markout walk cursor', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric');
    expect([...s.meta.keys()].filter((k) => k.startsWith('mkhist_cursor_metric_'))).toEqual([]);
  });

  it('leaves other venues completely untouched', () => {
    const s = fakeStore({ ...seeded('metric'), ...seeded('poe') });
    resetVenueHistory(s, 'metric');
    expect(s.meta.get('backfill_done_poe')).toBe('1');
    expect(s.meta.get('mkfill_cursor_poe')).toBe('96000000');
    expect(s.meta.get('mkhist_cursor_poe_MON/USDC')).toBe('2026-08-16');
  });

  it('does not clear the applied-marker, so a reset stays one-shot', () => {
    const s = fakeStore({ ...seeded('metric'), backfill_reset_applied: 'metric' });
    resetVenueHistory(s, 'metric');
    expect(s.meta.get('backfill_reset_applied')).toBe('metric');
  });
});
