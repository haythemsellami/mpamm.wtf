// BACKFILL_RESET's key set (live.ts resetVenueHistory).
//
// A reset that clears a done-flag but leaves its cursor reports success and
// recovers nothing: backfillRecentFills resumes with `if (cb > from) from = cb`,
// so a stale mkfill_cursor restarts the scan wherever the LAST onboarding
// finished — past the window the reset was reached for. Whether that bites
// depends on how long ago onboarding ran, which is exactly the kind of
// non-determinism a reset must not have.
import { describe, expect, it } from 'vitest';
import { adoptLegacyResetMarker, fillsScanFromDay, parseBackfillReset, refuseResolvedStart, planVenueReset, purgeVenueDays, refuseResetStart, resetVenueHistory } from '../datasource/live.js';
import type { DailyVolume } from '@shared';
import type { ResetDeletes } from '../db.js';

/** records what a reset touched, without a real SQLite file. */
function fakeStore(seed: Record<string, string> = {}, rows: Record<string, number> = {}) {
  const meta = new Map(Object.entries(seed));
  const volume = new Map(Object.entries(rows));   // venueId -> stored day-rows
  const out = {
    meta,
    volume,
    getMeta: (k: string) => meta.get(k),
    setMeta: (k: string, v: string) => { meta.set(k, v); },
    deleteMetaPrefix: (p: string) => { for (const k of [...meta.keys()]) if (k.startsWith(p)) meta.delete(k); },
    scoped: [] as Array<{ vid: string; deletes: ResetDeletes }>,
    // Mirrors VolumeStore.resetVenueVolume: a table with no window asked for is
    // untouched and reports 0. A fake that counted rows nobody asked to delete
    // would let a real over-wide delete pass its own assertions.
    resetVenueVolume: (vid: string, deletes: ResetDeletes) => {
      out.scoped.push({ vid, deletes });
      const n = volume.get(vid) ?? 0;
      if (deletes.volume && deletes.volume.fromDay === undefined) volume.delete(vid);
      return { volume: deletes.volume ? n : 0, fills: deletes.fills ? n : 0 };
    },
  };
  return out;
}

const TODAY = '2026-08-22';

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
    resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-07-23' } } });
    expect(s.meta.get('backfill_done_metric')).toBe('');
    expect(s.meta.get('backfill_cursor_metric')).toBe('');
    expect(s.meta.get('mkfill_done_metric')).toBe('');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('');   // the one that was missed
  });

  it('drops every per-market markout walk cursor', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-07-23' } } });
    expect([...s.meta.keys()].filter((k) => k.startsWith('mkhist_cursor_metric_'))).toEqual([]);
  });

  it('leaves other venues completely untouched', () => {
    const s = fakeStore({ ...seeded('metric'), ...seeded('poe') });
    resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-07-23' } } });
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
    resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-07-23' } } });
    expect(s.volume.has('metric')).toBe(false);
    expect(s.volume.get('poe')).toBe(9);          // other venues keep their history
  });

  /**
   * The other half of the same edge (Copilot review, PR #84). A targeted replay
   * only re-scans from its start, so deleting the venue's WHOLE history would
   * drop pre-window days nothing ever restores. The delete must be scoped to
   * exactly what comes back.
   */
  it('hands the store the scope it was given, verbatim', () => {
    const s = fakeStore(seeded('metric'), { metric: 20 });
    const deletes: ResetDeletes = { beforeDay: TODAY, volume: { fromDay: '2026-08-14' }, fills: { fromBlock: 95_000_000n } };
    resetVenueHistory(s, 'metric', { from: { block: 95_000_000n, day: '2026-08-14' }, deletes });
    expect(s.scoped).toEqual([{ vid: 'metric', deletes }]);
  });

  it('reports what was dropped, so a one-shot destructive step leaves a record', () => {
    const s = fakeStore(seeded('metric'), { metric: 20 });
    expect(resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-07-23' } } }))
      .toEqual({ volume: 20, fills: 20 });
  });

  it('counts nothing for a table it was not asked to touch', () => {
    const s = fakeStore(seeded('metric'), { metric: 20 });
    expect(resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {} } }))
      .toEqual({ volume: 20, fills: 0 });
  });

  it('does not clear the applied-marker, so a reset stays one-shot', () => {
    const s = fakeStore({ ...seeded('metric'), backfill_reset_applied: 'metric' });
    resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-07-23' } } });
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

  /**
   * A start on TODAY is a total no-op: both deletes bound exclusively at today
   * and both scans skip it (the live tail owns today). Applying it would spend
   * the venue's one-shot marker on nothing — the very silence this guards.
   */
  it('refuses TODAY, which deletes nothing and re-scans nothing', () => {
    expect(refuseResetStart({ vid: 'm', from: 'day', day: TODAY }, TODAY, HEAD))
      .toMatch(/is TODAY .*use an earlier day/);
  });

  it('accepts a past day and a block at head', () => {
    expect(refuseResetStart({ vid: 'm', from: 'day', day: '2026-08-21' }, TODAY, HEAD)).toBeNull();
    expect(refuseResetStart({ vid: 'm', from: 'day', day: '2026-01-01' }, TODAY, HEAD)).toBeNull();
    expect(refuseResetStart({ vid: 'm', from: 'block', block: HEAD }, TODAY, HEAD)).toBeNull();
  });

  it('says the day is in the FUTURE only when it actually is', () => {
    expect(refuseResetStart({ vid: 'm', from: 'day', day: '2026-08-23' }, TODAY, HEAD))
      .toMatch(/is in the future/);
  });

  it('cannot judge a raw block by day — that is refuseResolvedStart\u2019s job', () => {
    // a block from earlier today is <= head and carries no day until resolved
    expect(refuseResetStart({ vid: 'm', from: 'block', block: HEAD - 1n }, TODAY, HEAD)).toBeNull();
  });

  it('never refuses a lifetime replay — it has no start to be wrong about', () => {
    expect(refuseResetStart({ vid: 'm', from: 'lifetime' }, TODAY, HEAD)).toBeNull();
  });

  it('holds its fire before the head is known, so boot order cannot refuse a valid reset', () => {
    expect(refuseResetStart({ vid: 'm', from: 'block', block: 99_000_000n }, TODAY, 0n)).toBeNull();
  });
});

/**
 * "Delete exactly what the replay restores" — the invariant the whole reset
 * hangs on. Deleting wider than the scan rebuilds is silent data loss, and the
 * two tables need two windows because their scans cover different spans: the
 * volume backfill replays a lifetime, the fills onboarding only its window.
 */
/**
 * The upgrade trap. A single global key used to record the applied VALUE, so
 * the first boot on per-venue markers has none of them — and every entry of an
 * ALREADY-APPLIED value would run again. For a destructive replay that turns
 * deploying a binary into a reset nobody asked for.
 */
/**
 * The second half of the same guard, for a start only knowable after the chain
 * answered. A RAW block carries no day until eth_getBlock resolves one, so
 * `vid:<block>` pointing anywhere inside today reaches here looking valid.
 */
describe('refuseResolvedStart', () => {
  const TODAY = '2026-08-22';
  const HEAD = 98_000_000n;

  it('refuses a block that resolves onto today', () => {
    expect(refuseResolvedStart({ block: 97_999_000n, day: TODAY }, TODAY, HEAD))
      .toMatch(/falls on 2026-08-22.*use an earlier block/);
  });

  it('refuses one that resolves past today', () => {
    expect(refuseResolvedStart({ block: 97_999_000n, day: '2026-08-25' }, TODAY, HEAD))
      .toMatch(/falls on 2026-08-25/);
  });

  it('accepts a block on a closed day', () => {
    expect(refuseResolvedStart({ block: 97_000_000n, day: '2026-08-21' }, TODAY, HEAD)).toBeNull();
  });

  it('still catches a resolve that lands past head, which no day check would', () => {
    expect(refuseResolvedStart({ block: HEAD + 1n, day: '2026-08-21' }, TODAY, HEAD))
      .toMatch(/past head/);
  });

  it('holds its fire before the head is known', () => {
    expect(refuseResolvedStart({ block: 99_000_000n, day: '2026-08-21' }, TODAY, 0n)).toBeNull();
  });
});

describe('adoptLegacyResetMarker', () => {
  it('adopts an already-applied value, so upgrading is not itself a reset', () => {
    const s = fakeStore({ backfill_reset_applied: 'thogamm@4,poe' });
    adoptLegacyResetMarker(s, 'thogamm@4,poe', ['thogamm', 'poe']);
    expect(s.meta.get('backfill_reset_applied_thogamm')).toBe('thogamm@4,poe');
    expect(s.meta.get('backfill_reset_applied_poe')).toBe('thogamm@4,poe');
  });

  it('adopts nothing when the value CHANGED — that reset is meant to run', () => {
    const s = fakeStore({ backfill_reset_applied: 'thogamm@4' });
    adoptLegacyResetMarker(s, 'thogamm@5', ['thogamm']);
    expect(s.meta.get('backfill_reset_applied_thogamm')).toBeUndefined();
  });

  it('runs once — a later boot must not re-adopt over a deferred entry', () => {
    // the legacy key keeps being written as a rollback breadcrumb, so without
    // its own flag this would re-stamp entries that legitimately deferred.
    const s = fakeStore({ backfill_reset_applied: 'thogamm@5' });
    adoptLegacyResetMarker(s, 'thogamm@5', ['thogamm']);
    s.meta.delete('backfill_reset_applied_thogamm');          // entry deferred on a transient failure
    adoptLegacyResetMarker(s, 'thogamm@5', ['thogamm']);
    expect(s.meta.get('backfill_reset_applied_thogamm')).toBeUndefined();
  });

  it('marks itself migrated even with nothing to adopt, so a fresh database is quiet', () => {
    const s = fakeStore();
    adoptLegacyResetMarker(s, 'thogamm@4', ['thogamm']);
    expect(s.meta.get('backfill_reset_migrated')).toBe('1');
    expect(s.meta.get('backfill_reset_applied_thogamm')).toBeUndefined();
  });

  it('skips an entry with no parseable venue id', () => {
    const s = fakeStore({ backfill_reset_applied: 'x' });
    adoptLegacyResetMarker(s, 'x', ['']);
    expect([...s.meta.keys()].some((k) => k.startsWith('backfill_reset_applied_'))).toBe(false);
  });
});

describe('planVenueReset', () => {
  const WINDOW = '2026-07-23';       // where the fills scan starts

  it('lifetime: every day-row, but fills only back to the scan window', () => {
    expect(planVenueReset({ fillsFromDay: WINDOW, today: TODAY, volumeEnabled: true, fillsEnabled: true }))
      .toEqual({ beforeDay: TODAY, volume: { fromDay: undefined }, fills: { fromDay: WINDOW } });
  });

  it('targeted inside the window: fills match the scan\u2019s exact resume block', () => {
    expect(planVenueReset({ from: { block: 97_000_000n, day: '2026-08-10' }, fillsFromDay: WINDOW, today: TODAY, volumeEnabled: true, fillsEnabled: true }))
      .toEqual({ beforeDay: TODAY, volume: { fromDay: '2026-08-10' }, fills: { fromBlock: 97_000_000n } });
  });

  it('targeted before the window: fills stop at the window, where the scan starts', () => {
    // the scan takes max(window, cursor), so deleting from the older targeted
    // block would drop fills it is never going to re-insert.
    expect(planVenueReset({ from: { block: 90_000_000n, day: '2026-07-01' }, fillsFromDay: WINDOW, today: TODAY, volumeEnabled: true, fillsEnabled: true }))
      .toEqual({ beforeDay: TODAY, volume: { fromDay: '2026-07-01' }, fills: { fromDay: WINDOW } });
  });

  it('a disabled stage deletes NOTHING — no scan is coming to rebuild it', () => {
    expect(planVenueReset({ fillsFromDay: WINDOW, today: TODAY, volumeEnabled: false, fillsEnabled: true }))
      .toEqual({ beforeDay: TODAY, fills: { fromDay: WINDOW } });
    expect(planVenueReset({ fillsFromDay: WINDOW, today: TODAY, volumeEnabled: true, fillsEnabled: false }))
      .toEqual({ beforeDay: TODAY, volume: { fromDay: undefined } });
    expect(planVenueReset({ fillsFromDay: WINDOW, today: TODAY, volumeEnabled: false, fillsEnabled: false })).toEqual({ beforeDay: TODAY });
  });
});

describe('fillsScanFromDay', () => {
  const NOW = Date.parse('2026-08-22T09:00:00Z');

  it('is the rolling window when the venue is older than it', () => {
    expect(fillsScanFromDay('2026-01-01', NOW, 30)).toBe('2026-07-23');
  });

  it('is floored at the venue\u2019s own first day when it is younger', () => {
    expect(fillsScanFromDay('2026-08-01', NOW, 30)).toBe('2026-08-01');
  });

  it('falls back to the window for a venue with no declared start', () => {
    expect(fillsScanFromDay(undefined, NOW, 30)).toBe('2026-07-23');
  });
});

describe('purgeVenueDays', () => {
  const days = (): DailyVolume[] => [
    { utcDay: '2026-08-10', partial: false, byVenue: { metric: { usd: 1, swaps: 1 }, poe: { usd: 2, swaps: 2 } } },
    { utcDay: '2026-08-20', partial: false, byVenue: { metric: { usd: 3, swaps: 3 } } },
  ];

  it('mirrors a lifetime delete', () => {
    const d = days();
    purgeVenueDays(d, 'metric', { beforeDay: TODAY, volume: {} });
    expect(d.map((x) => Object.keys(x.byVenue))).toEqual([['poe'], []]);
  });

  it('mirrors a targeted delete, keeping pre-window days', () => {
    const d = days();
    purgeVenueDays(d, 'metric', { beforeDay: TODAY, volume: { fromDay: '2026-08-15' } });
    expect(d.map((x) => Object.keys(x.byVenue))).toEqual([['metric', 'poe'], []]);
  });

  it('touches nothing when the store kept the rows', () => {
    const d = days();
    purgeVenueDays(d, 'metric', { beforeDay: TODAY });
    expect(d.map((x) => Object.keys(x.byVenue))).toEqual([['metric', 'poe'], ['metric']]);
  });

  it('leaves TODAY alone — the live tail owns it and no scan rebuilds it', () => {
    const d = [...days(), { utcDay: TODAY, partial: true, byVenue: { metric: { usd: 9, swaps: 9 } } }];
    purgeVenueDays(d, 'metric', { beforeDay: TODAY, volume: {} });
    expect(d[2].byVenue.metric).toEqual({ usd: 9, swaps: 9 });
  });
});

describe('resetVenueHistory — targeted', () => {
  it('SETS both cursors to the start block instead of clearing them', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', { from: { block: 95836845n, day: '2026-08-14' }, deletes: { beforeDay: TODAY, volume: { fromDay: '2026-08-14' }, fills: { fromBlock: 95836845n } } });
    expect(s.meta.get('backfill_done_metric')).toBe('');      // re-armed
    expect(s.meta.get('mkfill_done_metric')).toBe('');
    expect(s.meta.get('backfill_cursor_metric')).toBe('95836845');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('95836845');
  });

  it('still drops the markout walk cursors, which are days not blocks', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', { from: { block: 95836845n, day: '2026-08-14' }, deletes: { beforeDay: TODAY, volume: { fromDay: '2026-08-14' }, fills: { fromBlock: 95836845n } } });
    expect([...s.meta.keys()].filter((k) => k.startsWith('mkhist_cursor_metric_'))).toEqual([]);
  });

  it('omitting the block is still a lifetime replay', () => {
    const s = fakeStore(seeded('metric'));
    resetVenueHistory(s, 'metric', { deletes: { beforeDay: TODAY, volume: {}, fills: { fromDay: '2026-07-23' } } });
    expect(s.meta.get('backfill_cursor_metric')).toBe('');
    expect(s.meta.get('mkfill_cursor_metric')).toBe('');
  });
});
