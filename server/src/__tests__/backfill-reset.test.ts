// BACKFILL_RESET's key set (live.ts resetVenueHistory).
//
// A reset that clears a done-flag but leaves its cursor reports success and
// recovers nothing: backfillRecentFills resumes with `if (cb > from) from = cb`,
// so a stale mkfill_cursor restarts the scan wherever the LAST onboarding
// finished — past the window the reset was reached for. Whether that bites
// depends on how long ago onboarding ran, which is exactly the kind of
// non-determinism a reset must not have.
import { describe, expect, it } from 'vitest';
import { parseBackfillReset, refuseResetStart, resetVenueHistory } from '../datasource/live.js';

/** records what a reset touched, without a real SQLite file. */
function fakeStore(seed: Record<string, string> = {}, rows: Record<string, number> = {}) {
  const meta = new Map(Object.entries(seed));
  const volume = new Map(Object.entries(rows));   // venueId -> stored day-rows
  const out = {
    meta,
    volume,
    setMeta: (k: string, v: string) => { meta.set(k, v); },
    deleteMetaPrefix: (p: string) => { for (const k of [...meta.keys()]) if (k.startsWith(p)) meta.delete(k); },
    scoped: [] as Array<{ vid: string; from?: { block: bigint; day: string } }>,
    resetVenueVolume: (vid: string, from?: { block: bigint; day: string }) => {
      out.scoped.push({ vid, from });
      const n = volume.get(vid) ?? 0;
      if (from === undefined) volume.delete(vid);   // lifetime: everything goes
      return { volume: n, fills: n };
    },
  };
  return out;
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

  /**
   * The other half of the same edge (Copilot review, PR #84). A targeted replay
   * only re-scans from its start, so deleting the venue's WHOLE history would
   * drop pre-window days nothing ever restores. The delete must be scoped to
   * exactly what comes back.
   */
  it('scopes a TARGETED replay to its window instead of wiping the lifetime', () => {
    const s = fakeStore(seeded('metric'), { metric: 20 });
    resetVenueHistory(s, 'metric', { block: 95_000_000n, day: '2026-08-14' });
    expect(s.scoped).toEqual([{ vid: 'metric', from: { block: 95_000_000n, day: '2026-08-14' } }]);
  });

  it('passes no scope for a lifetime replay, so everything is dropped', () => {
    const s = fakeStore(seeded('metric'), { metric: 20 });
    resetVenueHistory(s, 'metric');
    expect(s.scoped).toEqual([{ vid: 'metric', from: undefined }]);
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

/**
 * A future start does not fail loudly on its own (Copilot review, PR #84).
 * blockAtOrAfter converges to `hi` for a timestamp past the chain head, so a
 * `vid:<future-day>` reset resolves to bootHead, slips a `> bootHead` test
 * because it EQUALS head, and is reported as applied while clearing nothing
 * and re-scanning nothing — spending the one-shot marker on a typo.
 */
describe('refuseResetStart', () => {
  const TODAY = '2026-08-22';
  const HEAD = 98_000_000n;

  it('refuses a future DAY, which would otherwise resolve to head', () => {
    expect(refuseResetStart({ vid: 'm', from: 'day', day: '2026-08-23' }, TODAY, HEAD))
      .toMatch(/is in the future .*today is 2026-08-22/);
  });

  it('refuses a block past head before any RPC is spent on it', () => {
    expect(refuseResetStart({ vid: 'm', from: 'block', block: HEAD + 1n }, TODAY, HEAD))
      .toMatch(/past head/);
  });

  it('accepts today, the past, and a block at head', () => {
    expect(refuseResetStart({ vid: 'm', from: 'day', day: TODAY }, TODAY, HEAD)).toBeNull();
    expect(refuseResetStart({ vid: 'm', from: 'day', day: '2026-01-01' }, TODAY, HEAD)).toBeNull();
    expect(refuseResetStart({ vid: 'm', from: 'block', block: HEAD }, TODAY, HEAD)).toBeNull();
  });

  it('never refuses a lifetime replay — it has no start to be wrong about', () => {
    expect(refuseResetStart({ vid: 'm', from: 'lifetime' }, TODAY, HEAD)).toBeNull();
  });

  it('holds its fire before the head is known, so boot order cannot refuse a valid reset', () => {
    expect(refuseResetStart({ vid: 'm', from: 'block', block: 99_000_000n }, TODAY, 0n)).toBeNull();
  });
});

describe('resetVenueHistory — targeted', () => {
  it('SETS both cursors to the start block instead of clearing them', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', { block: 95836845n, day: '2026-08-14' });
    expect(s.meta.get('backfill_done_metric')).toBe('');      // re-armed
    expect(s.meta.get('mkfill_done_metric')).toBe('');
    expect(s.meta.get('backfill_cursor_metric')).toBe('95836845');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('95836845');
  });

  it('still drops the markout walk cursors, which are days not blocks', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', { block: 95836845n, day: '2026-08-14' });
    expect([...s.meta.keys()].filter((k) => k.startsWith('mkhist_cursor_metric_'))).toEqual([]);
  });

  it('omitting the block is still a lifetime replay', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric');
    expect(s.meta.get('backfill_cursor_metric')).toBe('');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('');
  });
});
