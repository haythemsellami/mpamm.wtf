// 'fills' history revisions (live.ts: revisionTargets, planFillsRevision;
// db.ts: fillTotalsByDay).
//
// The 2026-09-21 replay booked the first minutes of 09-18 and 09-19 on the
// day before, for clober-vault and hanji (replay-day-stamp.test.ts has the
// chunks). Their fills were right, only the day buckets were wrong. A chain
// replay was the only repair, and for hanji it would have re-priced four
// weeks of cross-pair volume at the deploy-time mid and dropped live markout
// curves. A 'fills' revision SETs just the window's days from the fills
// instead. What must hold: it applies only when the fills are complete for
// the window, and then it lands exactly on them.
import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fill } from '@shared';
import { VolumeStore } from '../db.js';
import { planFillsRevision, revisionTargets } from '../datasource/live.js';

type Totals = Map<string, { usd: number; swaps: number }>;
const totals = (rows: [string, number, number][]): Totals => new Map(rows.map(([d, usd, swaps]) => [d, { usd, swaps }]));

/** prod (Railway, 2026-10-14): the stored buckets, and the same window's fills
 *  summed on their own block days. Hanji's fills match an independent chain
 *  recount (7,163 trades); clober-vault's match a replay of both days. */
const HANJI = {
  stored: totals([['2026-09-17', 3103244.64729, 1921], ['2026-09-18', 3707652.563128, 3042], ['2026-09-19', 1825544.118163, 2200]]),
  fills: totals([['2026-09-17', 3086970.649952, 1921], ['2026-09-18', 3692735.856759, 3042], ['2026-09-19', 1855888.731988, 2200]]),
};
const CLOBER = {
  stored: totals([['2026-09-18', 51287.767256, 491], ['2026-09-19', 185030.154779, 701]]),
  fills: totals([['2026-09-18', 50019.383993, 491], ['2026-09-19', 186298.538042, 701]]),
};

const base = {
  from: '2026-09-17', until: '2026-09-20', today: '2026-10-15', retainedFrom: '2026-09-14',
  scansDone: true, unpersisted: 0, ...HANJI,
};

describe('revisionTargets — the fills form', () => {
  it('parses a window with its own marker', () => {
    const [t] = revisionTargets('hanji', [{ id: 'm', source: 'fills', from: '2026-09-17', until: '2026-09-20' }]);
    expect(t).toMatchObject({ from: 'fills', day: '2026-09-17', until: '2026-09-20', marker: 'history_revision_hanji_m' });
  });

  it('needs both ends, as real days, in order', () => {
    const ts = revisionTargets('hanji', [
      { id: 'a', source: 'fills', from: '2026-09-17' },
      { id: 'b', source: 'fills', until: '2026-09-20' },
      { id: 'c', source: 'fills', from: '2026-09-20', until: '2026-09-17' },
      { id: 'd', source: 'fills', from: '2026-09-17', until: '2026-09-17' },
      { id: 'e', source: 'fills', from: '2026-09-17', until: '2026-09-31' },
    ]);
    expect(ts.map((t) => t.from)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
  });

  /** a chain replay cannot stop at `until`; accepting one would promise a
   *  bounded replay and deliver a replay to yesterday */
  it('rejects `until` on a chain revision', () => {
    expect(revisionTargets('hanji', [{ id: 'x', from: '2026-09-17', until: '2026-09-20' }])[0].from).toBe('invalid');
    expect(revisionTargets('hanji', [{ id: 'x', source: 'chain', from: '2026-09-17' }])[0].from).toBe('day');
  });

  it('shares the id namespace with chain revisions', () => {
    const ts = revisionTargets('hanji', [{ id: 'x', from: '2026-09-17' }, { id: 'x', source: 'fills', from: '2026-09-17', until: '2026-09-20' }]);
    expect(ts.map((t) => t.from)).toEqual(['invalid', 'invalid']);
  });
});

describe('planFillsRevision', () => {
  it('hanji: SETs 09-17..19 to their fills, and only those days', () => {
    const plan = planFillsRevision(base);
    expect(plan.action).toBe('apply');
    if (plan.action !== 'apply') return;
    expect(plan.days.map((d) => [d.utcDay, d.usd, d.swaps])).toEqual([
      ['2026-09-17', 3086970.649952, 1921], ['2026-09-18', 3692735.856759, 3042], ['2026-09-19', 1855888.731988, 2200],
    ]);
    expect(plan.days[0].was).toEqual({ usd: 3103244.64729, swaps: 1921 });
  });

  it('clober-vault: the $1,268.38 goes back to 09-19', () => {
    const plan = planFillsRevision({ ...base, from: '2026-09-18', ...CLOBER });
    expect(plan.action).toBe('apply');
    if (plan.action !== 'apply') return;
    expect(plan.days.map((d) => Math.round((d.usd - d.was!.usd) * 1000) / 1000)).toEqual([-1268.383, 1268.383]);
  });

  it('a stored day with no fills left goes to zero; days outside the window are never touched', () => {
    const plan = planFillsRevision({
      ...base, from: '2026-09-18', until: '2026-09-20',
      stored: totals([['2026-09-18', 10, 1], ['2026-09-19', 0.004, 1]]),
      fills: totals([['2026-09-18', 10.004, 2]]),
    });
    expect(plan).toEqual({ action: 'apply', days: [
      { utcDay: '2026-09-18', usd: 10.004, swaps: 2, was: { usd: 10, swaps: 1 } },
      { utcDay: '2026-09-19', usd: 0, swaps: 0, was: { usd: 0.004, swaps: 1 } },
    ] });
  });

  it('waits for the window to close, the scans to finish and every fill to persist', () => {
    expect(planFillsRevision({ ...base, today: '2026-09-19' }).action).toBe('wait');
    expect(planFillsRevision({ ...base, scansDone: false }).action).toBe('wait');
    expect(planFillsRevision({ ...base, unpersisted: 1 }).action).toBe('wait');
    // the window's last day closes at `until`: that day itself may run
    expect(planFillsRevision({ ...base, today: '2026-09-20' }).action).toBe('apply');
  });

  /** fills retention is what makes the sum complete: one pruned day under
   *  the window and the "fix" would erase that day's volume */
  it('refuses a window that starts before fills retention', () => {
    expect(planFillsRevision({ ...base, retainedFrom: '2026-09-18' })).toMatchObject({ action: 'refuse' });
    expect(planFillsRevision({ ...base, retainedFrom: '2026-09-17' }).action).toBe('apply');
  });

  /** moving fills between days conserves the window's total; a gap is
   *  missing fills (a half-onboarded day), and SETting from them destroys volume */
  it('holds when the window total is not conserved', () => {
    const missing = totals([['2026-09-17', 3086970.649952, 1921], ['2026-09-19', 1855888.731988, 2200]]);
    expect(planFillsRevision({ ...base, fills: missing })).toMatchObject({ action: 'hold' });
    // hanji's real gap (cross pairs priced at two moments) is well inside tolerance
    expect(planFillsRevision(base).action).toBe('apply');
  });
});

describe('VolumeStore.fillTotalsByDay', () => {
  let path = '';
  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${path}${suffix}`); } catch { /* already removed */ }
    }
  });

  const fill = (id: string, venueId: string, ts: string, usd: number): Fill => ({
    id, venueId, market: 'MON/USDC', side: 'buy', category: 'UNKNOWN', usd, baseAmount: 1, execPx: 1,
    txHash: `0x${id}`, to: 'x', pool: 'p', blockNumber: 1, ts: Date.parse(ts), markoutsBps: [null, null, null, null, null],
  });

  it("sums one venue's fills per own-timestamp day inside [from, to)", () => {
    path = join(tmpdir(), `fills-revision-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new VolumeStore(path);
    store.insertFillsIfAbsent([
      fill('before', 'hanji', '2026-09-17T23:59:59.999Z', 1),
      fill('a', 'hanji', '2026-09-18T00:00:00Z', 2),
      fill('b', 'hanji', '2026-09-18T23:59:59Z', 3),
      fill('c', 'hanji', '2026-09-19T00:00:08Z', 4),
      fill('other', 'poe', '2026-09-18T12:00:00Z', 100),
      fill('after', 'hanji', '2026-09-20T00:00:00Z', 8),
    ]);
    const from = Date.parse('2026-09-18T00:00:00Z'), to = Date.parse('2026-09-20T00:00:00Z');
    expect(store.fillTotalsByDay('hanji', from, to)).toEqual([
      { utcDay: '2026-09-18', usd: 5, swaps: 2 },
      { utcDay: '2026-09-19', usd: 4, swaps: 1 },
    ]);
    store.close();
  });
});
