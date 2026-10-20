// Code-declared history revisions + the today re-read (live.ts rereadToday).
//
// The operator reset replayed CLOSED days only, and refused a start of today,
// so a reset applied mid-day recovered every day but the one it shipped on:
// Metric's v1 deploy (2026-10-12) left midnight → deploy decoded without the
// v1 sources, $572k served against ~$3M on the days around it. Revisions move
// the reset into the adapter (the deploy is the trigger); the re-read covers
// today. These lock down the pure rules both rest on.
import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fill } from '@shared';
import { VolumeStore, rewindCursor } from '../db.js';
import {
  carriedRereadTarget, markResetApplied, marketsRevisionWindow, mergeIntoRing, parseMarketsAdded, planMarketsAdd, planReread,
  refuseResetStart, rereadKey, resetAlreadyApplied, resetMarker, revisionTargets,
} from '../datasource/live.js';
import { ADAPTERS } from '../venues/registry.js';

const fill = (id: string, over: Partial<Fill> = {}): Fill => ({
  id, venueId: 'metric', market: 'MON/USDC', side: 'buy', category: 'ROUTER', usd: 100, baseAmount: 50, execPx: 2,
  txHash: `0x${id}`, to: 'x', pool: 'p', blockNumber: 1000, ts: Date.parse('2026-10-12T06:00:00Z'),
  markoutsBps: [null, null, null, null, null], ...over,
});

function memStore(seed: Record<string, string> = {}) {
  const meta = new Map(Object.entries(seed));
  return { meta, getMeta: (k: string) => meta.get(k), setMeta: (k: string, v: string) => { meta.set(k, v); } };
}

describe('rewindCursor — a reset never moves a scan FORWARD', () => {
  it('a finished scan rewinds to the start block', () => {
    expect(rewindCursor('1', '113000000', 110000000n)).toBe('110000000');
  });

  it('a scan already past the start rewinds to it', () => {
    expect(rewindCursor('', '112000000', 110000000n)).toBe('110000000');
  });

  /** The hazard revisions add: they run on the FIRST boot of every database,
   *  including one whose lifetime scan is still crawling. Jumping that scan
   *  to the revision's start would skip everything in between, silently. */
  it('a scan still behind the start keeps its place', () => {
    expect(rewindCursor('', '90000000', 110000000n)).toBe('90000000');
  });

  it('a scan that never started (fresh database) stays unstarted', () => {
    expect(rewindCursor(undefined, undefined, 110000000n)).toBe('');
    expect(rewindCursor('', '', 110000000n)).toBe('');
  });

  it('a lifetime replay clears the cursor', () => {
    expect(rewindCursor('1', '113000000', undefined)).toBe('');
  });
});

describe('planReread — converge today onto the current decode', () => {
  it('SETS the bucket to the decode, whatever the tail had counted', () => {
    const plan = planReread([fill('a', { usd: 10 })], [fill('a', { usd: 10 }), fill('b', { usd: 30 })]);
    expect(plan.total).toEqual({ usd: 40, swaps: 2 });
  });

  /** today's live markouts and curve come from the 100ms reference ring and
   *  can never be rebuilt; replacing an unchanged fill would discard them */
  it('leaves an identically decoded fill alone, markouts and all', () => {
    const live = fill('a', { markoutsBps: [1, 2, 3, 4, 5] });
    const plan = planReread([live], [fill('a')]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.insert).toEqual([]);
  });

  it('ignores attribution labels — a relabel is not a different fill', () => {
    const plan = planReread([fill('a', { category: 'DIRECT', to: 'pool', router: 'R' })], [fill('a')]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.insert).toEqual([]);
  });

  it('inserts what the previous build never decoded (a redeploy’s new sources)', () => {
    const plan = planReread([fill('a')], [fill('a'), fill('v1')]);
    expect(plan.insert.map((f) => f.id)).toEqual(['v1']);
    expect(plan.deleteIds).toEqual([]);
  });

  it('replaces a fill decoded differently (a units fix) — delete AND insert', () => {
    const plan = planReread([fill('a', { usd: 1e12 })], [fill('a', { usd: 100 })]);
    expect(plan.deleteIds).toEqual(['a']);
    expect(plan.insert.map((f) => f.usd)).toEqual([100]);
  });

  it('deletes a fill the current build no longer produces', () => {
    const plan = planReread([fill('ghost')], []);
    expect(plan.deleteIds).toEqual(['ghost']);
    expect(plan.total).toEqual({ usd: 0, swaps: 0 });
  });

  it('counts a fill decoded twice (overlapping windows) once', () => {
    expect(planReread([], [fill('a'), fill('a')]).total.swaps).toBe(1);
  });
});

describe('mergeIntoRing — recovered fills join the served tape', () => {
  const at = (id: string, ts: number) => fill(id, { ts, blockNumber: ts });

  it('slots an inserted fill in ts order', () => {
    const r = mergeIntoRing([at('a', 1), at('c', 3)], [at('b', 2)], 10);
    expect(r.ring.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(r.added.map((f) => f.id)).toEqual(['b']);
    expect(r.evicted).toEqual([]);
  });

  it('keeps the newest `cap`, evicting old ring members', () => {
    const r = mergeIntoRing([at('a', 1), at('c', 3)], [at('b', 2)], 2);
    expect(r.ring.map((f) => f.id)).toEqual(['b', 'c']);
    expect(r.evicted.map((f) => f.id)).toEqual(['a']);
  });

  /** an inserted fill older than the whole ring never enters it — it must not
   *  be reported as added (no dedup id, no markout aging for it) */
  it('drops an inserted fill older than a full ring', () => {
    const r = mergeIntoRing([at('b', 2), at('c', 3)], [at('a', 1)], 2);
    expect(r.ring.map((f) => f.id)).toEqual(['b', 'c']);
    expect(r.added).toEqual([]);
    expect(r.evicted).toEqual([]);
  });
});

describe('revisionTargets', () => {
  it('a day revision is a day reset with its own marker', () => {
    const [t] = revisionTargets('metric', [{ id: 'v1-deploy-day', from: '2026-10-12' }]);
    expect(t).toMatchObject({ vid: 'metric', from: 'day', day: '2026-10-12', marker: 'history_revision_metric_v1-deploy-day' });
  });

  it('no `from` is a lifetime replay', () => {
    expect(revisionTargets('metric', [{ id: 'units' }])[0]).toMatchObject({ from: 'lifetime' });
  });

  it('never shares the env reset’s marker — applying one must not re-run the other', () => {
    const [t] = revisionTargets('metric', [{ id: 'x', from: '2026-10-12' }]);
    expect(resetMarker(t)).not.toBe(resetMarker({ vid: 'metric', spec: 'metric:2026-10-12', from: 'day', day: '2026-10-12' }));
  });

  it('rejects a block start, an impossible date, and an unsafe id', () => {
    const ts = revisionTargets('metric', [
      { id: 'blk', from: '110000000' }, { id: 'feb', from: '2026-02-30' }, { id: 'has space', from: '2026-10-12' },
    ]);
    expect(ts.map((t) => t.from)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  /** two entries on one marker would overwrite each other's record — each
   *  boot then sees the other as unapplied and re-runs it, forever */
  it('rejects EVERY entry sharing an id — the first one too', () => {
    const ts = revisionTargets('metric', [{ id: 'a', from: '2026-10-11' }, { id: 'b', from: '2026-10-11' }, { id: 'a', from: '2026-10-12' }]);
    expect(ts.map((t) => t.from)).toEqual(['invalid', 'day', 'invalid']);
  });

  it('is one-shot: applied once, skipped after', () => {
    const s = memStore();
    const [t] = revisionTargets('metric', [{ id: 'v1', from: '2026-10-12' }]);
    expect(resetAlreadyApplied(s, t)).toBe(false);
    markResetApplied(s, t);
    expect(resetAlreadyApplied(s, t)).toBe(true);
  });

  it('re-runs an applied entry whose text was edited', () => {
    const s = memStore();
    markResetApplied(s, revisionTargets('metric', [{ id: 'v1', from: '2026-10-12' }])[0]);
    expect(resetAlreadyApplied(s, revisionTargets('metric', [{ id: 'v1', from: '2026-10-11' }])[0])).toBe(false);
  });
});

describe("revisionTargets — 'markets'", () => {
  it('is an add for registered markets from a day, with its own marker', () => {
    const [t] = revisionTargets('hanji', [{ id: 'xaut-book', source: 'markets', from: '2026-09-21', markets: ['XAUt/USDC'] }]);
    expect(t).toMatchObject({
      vid: 'hanji', from: 'markets', day: '2026-09-21', markets: ['XAUt/USDC'], marker: 'history_revision_hanji_xaut-book',
    });
  });

  it('reads the same however the markets are listed — the spec is the marker value', () => {
    const [a] = revisionTargets('hanji', [{ id: 'm', source: 'markets', from: '2026-09-21', markets: ['XAUt/USDC', 'MON/USDC'] }]);
    const [b] = revisionTargets('hanji', [{ id: 'm', source: 'markets', from: '2026-09-21', markets: [' MON/USDC', 'XAUt/USDC', 'MON/USDC'] }]);
    expect(a.spec).toBe(b.spec);
  });

  it('rejects no start, an until, no markets, an unregistered market — and markets on any other source', () => {
    const ts = revisionTargets('hanji', [
      { id: 'a', source: 'markets', markets: ['XAUt/USDC'] },
      { id: 'b', source: 'markets', from: '2026-09-21', until: '2026-10-01', markets: ['XAUt/USDC'] },
      { id: 'c', source: 'markets', from: '2026-09-21', markets: [] },
      { id: 'd', source: 'markets', from: '2026-09-21', markets: ['XAUt0/USDC'] },
      { id: 'e', from: '2026-09-21', markets: ['XAUt/USDC'] },
      { id: 'f', source: 'fills', from: '2026-09-21', until: '2026-09-22', markets: ['XAUt/USDC'] },
    ]);
    expect(ts.map((t) => t.from)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
  });

  it('refuses a start after today — there is nothing to add', () => {
    const [t] = revisionTargets('hanji', [{ id: 'm', source: 'markets', from: '2026-10-21', markets: ['XAUt/USDC'] }]);
    expect(refuseResetStart(t, '2026-10-20', 0n)).toMatch(/future/);
    expect(refuseResetStart({ ...t, day: '2026-10-20' } as typeof t, '2026-10-20', 0n)).toBeNull();
  });
});

describe('marketsRevisionWindow — the blocks an older build decoded', () => {
  // `from` = block 1,000; this build's tail started at 2,500 (mid-deploy-day,
  // whose midnight is 2,000)
  const W = (o: Partial<Parameters<typeof marketsRevisionWindow>[0]>) =>
    marketsRevisionWindow({ start: 1_000n, b0: 2_500n, ...o });

  it("a settled venue: everything before the tail, the deploy day's older hours included", () => {
    expect(W({})).toEqual({ ranges: [[1_000n, 2_500n]], pending: false });
  });

  /** an unfinished replay re-SETs from the day it resumes on, with this build:
   *  what lies before it is known now, what it leaves past its end is not */
  it('an unfinished replay: the days before it now, and a wait', () => {
    expect(W({ replay: { from: 1_500n } })).toEqual({ ranges: [[1_000n, 1_500n]], pending: true });
  });

  /** the replay only reaches CLOSED days: done before the deploy day closed,
   *  it stops at that day's midnight and leaves its older hours to no one */
  it('a replay that finished before the deploy day closed leaves its older hours to the revision', () => {
    expect(W({ replay: { from: 1_500n, end: 2_000n } })).toEqual({ ranges: [[1_000n, 1_500n], [2_000n, 2_500n]], pending: false });
  });

  it('a replay that finished after it closed covered them', () => {
    expect(W({ replay: { from: 1_500n, end: 3_000n } })).toEqual({ ranges: [[1_000n, 1_500n]], pending: false });
  });

  it('a fresh database: the replay covers it all, unless it stops short of the tail', () => {
    expect(W({ replay: { from: 500n } })).toEqual({ ranges: [], pending: true });
    expect(W({ replay: { from: 500n, end: 2_000n } })).toEqual({ ranges: [[2_000n, 2_500n]], pending: false });
    expect(W({ replay: { from: 500n, end: 2_600n } })).toEqual({ ranges: [], pending: false });
  });

  /** a chain reset or re-read since hands every block from its start to this
   *  build — and with nothing left before it, nothing waits on a replay */
  it('a later reset caps the window at its start', () => {
    expect(W({ ownedFrom: 1_800n })).toEqual({ ranges: [[1_000n, 1_800n]], pending: false });
    expect(W({ ownedFrom: 0n, replay: { from: 1_500n } })).toEqual({ ranges: [], pending: false });
    expect(W({ ownedFrom: 3_000n })).toEqual({ ranges: [[1_000n, 2_500n]], pending: false });
  });
});

describe('planMarketsAdd — what one scanned range adds', () => {
  const NOON = Date.parse('2026-10-14T12:00:00Z');
  const RETAINED = Date.parse('2026-10-01T00:00:00Z');
  const xaut = (id: string, over: Partial<Fill> = {}) => fill(id, { venueId: 'hanji', market: 'XAUt/USDC', usd: 700, ts: NOON, ...over });
  const MARKETS = new Set(['XAUt/USDC']);

  it('adds only the listed markets, each fill to its own day', () => {
    const plan = planMarketsAdd([
      xaut('a'), xaut('b', { usd: 300, ts: NOON + 86_400_000 }), fill('m', { venueId: 'hanji', market: 'MON/USDC', ts: NOON }),
    ], MARKETS, () => false, RETAINED);
    expect(Object.fromEntries(plan.days)).toEqual({ '2026-10-14': { usd: 700, swaps: 1 }, '2026-10-15': { usd: 300, swaps: 1 } });
    expect(plan.insert.map((f) => f.id)).toEqual(['a', 'b']);
  });

  /** the fills onboarding stores a fill without adding it to a day: stored is
   *  not counted, so it is added — but never re-inserted (an upsert would wipe
   *  its markouts) */
  it('adds a stored fill without inserting it again, and a duplicate decode once', () => {
    const plan = planMarketsAdd([xaut('a'), xaut('a'), xaut('s')], MARKETS, (id) => id === 's', RETAINED);
    expect(Object.fromEntries(plan.days)).toEqual({ '2026-10-14': { usd: 1_400, swaps: 2 } });
    expect(plan.insert.map((f) => f.id)).toEqual(['a']);
  });

  it('adds a fill older than retention to its day without inserting a row the prune would delete', () => {
    const old = xaut('o', { ts: Date.parse('2026-09-24T08:00:00Z') });
    const plan = planMarketsAdd([old], MARKETS, () => false, RETAINED);
    expect(plan.days.get('2026-09-24')).toEqual({ usd: 700, swaps: 1 });
    expect(plan.insert).toEqual([]);
  });
});

describe('parseMarketsAdded', () => {
  it('reads the persisted running total, and anything else as nothing yet', () => {
    expect(parseMarketsAdded('{"swaps":3,"usd":12.5}')).toEqual({ swaps: 3, usd: 12.5 });
    for (const v of [undefined, '', 'x', '{}', '{"swaps":"3","usd":1}']) expect(parseMarketsAdded(v)).toEqual({ swaps: 0, usd: 0 });
  });
});

describe('every registered adapter declares valid revisions', () => {
  it('parses each one — an invalid entry would be stamped and skipped in prod', () => {
    for (const a of ADAPTERS) {
      const vid = a.venues()[0]!.id;
      for (const t of revisionTargets(vid, a.historyRevisions)) {
        expect(t.from, `${vid}: ${t.spec}`).not.toBe('invalid');
      }
    }
  });
});

describe('carriedRereadTarget — a today re-read a restart carried past midnight', () => {
  const TODAY = '2026-10-13';

  it('nothing pending, or pending for today, carries nothing', () => {
    expect(carriedRereadTarget('metric', undefined, TODAY)).toBeNull();
    expect(carriedRereadTarget('metric', '', TODAY)).toBeNull();
    expect(carriedRereadTarget('metric', TODAY, TODAY)).toBeNull();
  });

  it('a closed pending day becomes a reset from that day', () => {
    expect(carriedRereadTarget('metric', '2026-10-12', TODAY)).toMatchObject({ from: 'day', day: '2026-10-12', carried: true });
  });

  /** settled by re-queuing today's re-read over the same key, never stamped:
   *  stamping would write the OLD day back over the new pending one */
  it('is applied once the marker no longer names its day', () => {
    const s = memStore({ [rereadKey('metric')]: '2026-10-12' });
    const t = carriedRereadTarget('metric', '2026-10-12', TODAY)!;
    expect(resetAlreadyApplied(s, t)).toBe(false);
    markResetApplied(s, t);                                   // a no-op for carried targets
    expect(s.meta.get(rereadKey('metric'))).toBe('2026-10-12');
    s.setMeta(rereadKey('metric'), TODAY);                    // what queueReread writes
    expect(resetAlreadyApplied(s, t)).toBe(true);
  });
});

describe('VolumeStore — reset rewind and fill reconcile', () => {
  const paths: string[] = [];
  const open = () => {
    const path = join(tmpdir(), `history-revisions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(path);
    return new VolumeStore(path);
  };
  afterEach(() => {
    for (const path of paths.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { unlinkSync(`${path}${suffix}`); } catch { /* already removed */ }
      }
    }
  });

  it('a targeted reset on a fresh database leaves both scans unstarted', () => {
    const store = open();
    store.resetVenueHistory('metric', { beforeDay: '2026-10-13', volume: { fromDay: '2026-10-12' }, fills: { fromBlock: 110000000n } }, 110000000n);
    expect(store.getMeta('backfill_cursor_metric')).toBe('');
    expect(store.getMeta('mkfill_cursor_metric')).toBe('');
    store.close();
  });

  it('reconcileFills keeps an unchanged row as stored and replaces a changed one', () => {
    const store = open();
    store.insertFillsIfAbsent([fill('keep', { markoutsBps: [1, 2, 3, 4, 5] }), fill('fix', { usd: 1e12 }), fill('ghost')]);
    const stored = store.venueFillsInRange('metric', Date.parse('2026-10-12T00:00:00Z'), Date.parse('2026-10-13T00:00:00Z'), 1000n);
    const plan = planReread(stored, [fill('keep'), fill('fix'), fill('new')]);
    expect(store.reconcileFills(plan.deleteIds, plan.insert)).toEqual({ deleted: 2, inserted: 2 });
    const after = new Map(store.venueFillsInRange('metric', 0, Date.parse('2026-10-13T00:00:00Z'), 1000n).map((f) => [f.id, f]));
    expect([...after.keys()].sort()).toEqual(['fix', 'keep', 'new']);
    expect(after.get('keep')!.markoutsBps).toEqual([1, 2, 3, 4, 5]);
    expect(after.get('fix')!.usd).toBe(100);
    store.close();
  });

  it('venueFillsInRange bounds by venue, day and the cursor block', () => {
    const store = open();
    store.insertFillsIfAbsent([
      fill('in'), fill('later', { blockNumber: 2000 }), fill('other', { venueId: 'poe' }),
      fill('yesterday', { ts: Date.parse('2026-10-11T23:59:59Z') }),
    ]);
    const ids = store.venueFillsInRange('metric', Date.parse('2026-10-12T00:00:00Z'), Date.parse('2026-10-13T00:00:00Z'), 1500n).map((f) => f.id);
    expect(ids).toEqual(['in']);
    store.close();
  });
});
