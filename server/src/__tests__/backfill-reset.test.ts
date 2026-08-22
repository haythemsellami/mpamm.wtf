// BACKFILL_RESET's key set (live.ts resetVenueHistory).
//
// A reset that clears a done-flag but leaves its cursor reports success and
// recovers nothing: backfillRecentFills resumes with `if (cb > from) from = cb`,
// so a stale mkfill_cursor restarts the scan wherever the LAST onboarding
// finished — past the window the reset was reached for. Whether that bites
// depends on how long ago onboarding ran, which is exactly the kind of
// non-determinism a reset must not have.
import { describe, expect, it } from 'vitest';
import { parseBackfillReset, resetVenueHistory } from '../datasource/live.js';

/** records what a reset touched, without a real SQLite file. */
function fakeStore(seed: Record<string, string> = {}, rows: Record<string, number> = {}) {
  const meta = new Map(Object.entries(seed));
  const volume = new Map(Object.entries(rows));   // venueId -> stored day-rows
  return {
    meta,
    volume,
    setMeta: (k: string, v: string) => { meta.set(k, v); },
    deleteMetaPrefix: (p: string) => { for (const k of [...meta.keys()]) if (k.startsWith(p)) meta.delete(k); },
    resetVenueVolume: (vid: string) => {
      const n = volume.get(vid) ?? 0;
      volume.delete(vid);
      return { volume: n, fills: n };
    },
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

  /**
   * The merge-only reset bug (ThogAMM, PR #82/#83). mergeBackfill writes only
   * the days its scan decoded fills in, so if the rows are not dropped first a
   * re-scan can RAISE a venue's history but never lower it: 15 ThogAMM days
   * carrying ~$4.97M of wrongly-counted volume decoded to nothing on the
   * corrected scan and would have kept their old numbers forever.
   */
  it('drops the stored rows, so a re-scan can lower a venue and not just raise it', () => {
    const s = fakeStore(seeded('metric'), { metric: 20, poe: 9 });
    resetVenueHistory(s, 'metric');
    expect(s.volume.has('metric')).toBe(false);
    expect(s.volume.get('poe')).toBe(9);          // other venues keep their history
  });

  it('drops the rows for a TARGETED replay too — a stale day is stale either way', () => {
    const s = fakeStore(seeded('metric'), { metric: 20 });
    resetVenueHistory(s, 'metric', 95_000_000n);
    expect(s.volume.has('metric')).toBe(false);
  });

  it('does not clear the applied-marker, so a reset stays one-shot', () => {
    const s = fakeStore({ ...seeded('metric'), backfill_reset_applied: 'metric' });
    resetVenueHistory(s, 'metric');
    expect(s.meta.get('backfill_reset_applied')).toBe('metric');
  });
});

describe('parseBackfillReset', () => {
  it('bare vid means the whole lifetime — the original behaviour is unchanged', () => {
    expect(parseBackfillReset('metric')).toEqual([{ vid: 'metric', from: 'lifetime' }]);
    expect(parseBackfillReset(' metric , poe ')).toEqual([
      { vid: 'metric', from: 'lifetime' }, { vid: 'poe', from: 'lifetime' },
    ]);
  });

  it('`@` stays a re-run nonce, never a start point', () => {
    // pre-existing operators use metric@2 to force a repeat; that must not
    // silently become "replay from block 2".
    expect(parseBackfillReset('metric@2')).toEqual([{ vid: 'metric', from: 'lifetime' }]);
  });

  it('`:` carries a block or a day', () => {
    expect(parseBackfillReset('metric:95836845')).toEqual([{ vid: 'metric', from: 'block', block: 95836845n }]);
    expect(parseBackfillReset('metric:2026-08-14')).toEqual([{ vid: 'metric', from: 'day', day: '2026-08-14' }]);
    expect(parseBackfillReset('metric:2026-08-14@2')).toEqual([{ vid: 'metric', from: 'day', day: '2026-08-14' }]);
  });

  it('reports a malformed start instead of guessing at one', () => {
    for (const bad of ['metric:', 'metric:abc', 'metric:0', 'metric:-5', 'metric:2026-13-45', 'metric:1:2']) {
      expect(parseBackfillReset(bad)[0].from).toBe('invalid');
    }
  });

  it('rejects a malformed NONCE rather than falling back to a lifetime replay', () => {
    // the dangerous shape: everything after the first `@` used to be discarded,
    // so `metric@2:95836845` parsed as bare `metric` and would have launched the
    // ~29M-block lifetime scan the operator was explicitly trying to avoid.
    for (const bad of ['metric@2:95836845', 'metric@2@3', 'metric@']) {
      const t = parseBackfillReset(bad)[0];
      expect(t.from).toBe('invalid');
      expect(t.vid).toBe('metric');          // still named, so the note is useful
    }
  });

  it('one bad entry does not take the good ones down with it', () => {
    const out = parseBackfillReset('metric:2026-08-14,poe:oops,hanji');
    expect(out.map((t) => t.from)).toEqual(['day', 'invalid', 'lifetime']);
  });
});

describe('resetVenueHistory — targeted', () => {
  it('SETS both cursors to the start block instead of clearing them', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', 95836845n);
    expect(s.meta.get('backfill_done_metric')).toBe('');      // re-armed
    expect(s.meta.get('mkfill_done_metric')).toBe('');
    expect(s.meta.get('backfill_cursor_metric')).toBe('95836845');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('95836845');
  });

  it('still drops the markout walk cursors, which are days not blocks', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', 95836845n);
    expect([...s.meta.keys()].filter((k) => k.startsWith('mkhist_cursor_metric_'))).toEqual([]);
  });

  it('omitting the block is still a lifetime replay', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric');
    expect(s.meta.get('backfill_cursor_metric')).toBe('');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('');
  });
});
