import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CURVE_OFFSETS_S, curveFlow, curveMarkMs, type Fill } from '@shared';
import { VolumeStore } from '../db.js';
import { AnalyticsWorker, aggregateCurves } from '../analytics-worker.js';
import { computeMarkoutCurves, curveComplete, curvePoints, routeOf, type CurveRow } from '../markout-curves.js';
import { SimDataSource } from '../datasource/sim.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of clean.splice(0).reverse()) await stop(); });

const N = CURVE_OFFSETS_S.length;
const flat = (v: number) => new Array<number>(N).fill(v);
/** a taker curve whose reference ran up `move` bps between −5s and +1s */
const moving = (move: number) => CURVE_OFFSETS_S.map((h) => (h <= 1 ? move * (1 - (h + 5) / 6) : 0));

const row = (over: Partial<CurveRow>): CurveRow => ({
  id: 'f', ts: 1_000_000, venueId: 'a', market: 'MON/USDC', category: 'DIRECT', side: 'buy',
  pool: 'p', usd: 100, txHash: '0x1', pxApprox: false, curve: flat(1), ...over,
});
const pagesOf = (rows: CurveRow[], size: number) => { let i = 0; return () => rows.slice(i, (i += size)); };

describe('curve points', () => {
  it('marks every offset at the middle of the block second, taker-signed like markoutsBps', () => {
    const asked: number[] = [];
    const buy = curvePoints({ ts: 10_000, side: 'buy', execPx: 100 }, (t) => { asked.push(t); return 100.01; });
    expect(asked).toEqual(CURVE_OFFSETS_S.map((h) => 10_000 + 500 + h * 1000));
    expect(curveMarkMs(10_000, 2)).toBe(12_500);
    // mid 1bp above the fill: the buyer got a good price (+1), the seller a bad one (−1)
    expect(buy.every((v) => v === 1)).toBe(true);
    const sell = curvePoints({ ts: 10_000, side: 'sell', execPx: 100 }, () => 100.01);
    expect(sell.every((v) => v === -1)).toBe(true);
  });

  it('leaves a point null when the reference is missing — never a zero', () => {
    const c = curvePoints({ ts: 0, side: 'buy', execPx: 100 }, (t) => (t < 0 ? null : 100));
    expect(c.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(c[CURVE_OFFSETS_S.indexOf(0)]).toBe(0);
    expect(curveComplete(c)).toBe(false);
    expect(curveComplete(curvePoints({ ts: 0, side: 'buy', execPx: 0 }, () => 100))).toBe(false);
  });

  it('classifies quiet vs moving on the −5s → +1s reference move', () => {
    expect(curveFlow(flat(3))).toBe('quiet');
    expect(curveFlow(moving(0.9))).toBe('quiet');
    expect(curveFlow(moving(1.1))).toBe('moving');
    expect(curveFlow(moving(-4))).toBe('moving');
    expect(curveFlow([null, ...flat(0).slice(1)])).toBeNull();
  });
});

describe('route classification', () => {
  it('treats one pool swept in one direction as a single leg', () => {
    expect(routeOf([row({}), row({ id: 'g' })])).toBe('single');
  });
  it('separates split routes from two-sided (arbitrage-shaped) transactions', () => {
    expect(routeOf([row({}), row({ venueId: 'b', pool: 'q' })])).toBe('split');
    expect(routeOf([row({}), row({ venueId: 'b', pool: 'q', side: 'sell' })])).toBe('twoSided');
    // MON/USDC and MON/AUSD share a base asset: buying one and selling the other is two-sided
    expect(routeOf([row({}), row({ venueId: 'b', pool: 'q', market: 'MON/AUSD', side: 'sell' })])).toBe('twoSided');
  });
});

describe('aggregation', () => {
  it('groups a transaction split across a page boundary and keeps pxApprox legs out of the stats', async () => {
    const ts = 5_000;
    const rows = [
      row({ id: 'a1', ts: 4_000, txHash: '0xs', usd: 200, curve: flat(2) }),       // single
      row({ id: 'b1', ts, txHash: '0xarb', venueId: 'a', usd: 100, curve: moving(-3) }),
      row({ id: 'b2', ts, txHash: '0xarb', venueId: 'b', pool: 'q', side: 'sell', usd: 300, curve: flat(-1) }),
      row({ id: 'b3', ts, txHash: '0xarb', venueId: 'c', pool: 'r', usd: 50, pxApprox: true, curve: null }),
      row({ id: 'c1', ts: 6_000, txHash: '0xinc', usd: 1000, curve: [null, ...flat(1).slice(1)] }), // incomplete
    ];
    // page size 2 cuts the 0xarb transaction in half
    const res = await computeMarkoutCurves(pagesOf(rows, 2), 1, 9_000);
    const cell = (venueId: string) => res.cells.filter((c) => c.venueId === venueId);
    expect(cell('a')).toHaveLength(2);
    const single = cell('a').find((c) => c.route === 'single')!;
    expect(single).toMatchObject({ flow: 'quiet', fills: 1, usd: 200 });
    expect(single.usdBps).toEqual(flat(400));
    expect(cell('a').find((c) => c.route === 'twoSided')).toMatchObject({ flow: 'moving', fills: 1, usd: 100 });
    expect(cell('b')).toEqual([expect.objectContaining({ route: 'twoSided', flow: 'quiet', usd: 300, usdBps: flat(-300) })]);
    expect(cell('c')).toEqual([]);
    // coverage counts every non-approximate fill, curve or not
    expect(res.coverage).toEqual({ a: { fills: 3, usd: 1300 }, b: { fills: 1, usd: 300 } });
    expect(res.offsetsS).toEqual([...CURVE_OFFSETS_S]);
  });
});

describe('persistence', () => {
  const fill = (id: string, ts: number, over: Partial<Fill> = {}): Fill => ({
    id, ts, venueId: 'venue', market: 'MON/USDC', side: 'buy', category: 'DIRECT', usd: 100, baseAmount: 1000,
    execPx: 0.1, blockNumber: 1, txHash: `0x${id}`, to: 'direct', pool: 'pool', markoutsBps: [1, 1, 1, 1, 1], ...over,
  });

  it('stores curves off the Fill and serves them to the worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mpamm-curves-'));
    clean.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'history.db');
    const store = new VolumeStore(path); clean.push(() => store.close());
    const now = 1_800_000_000_000;
    // a curve completing in the same snapshot that first inserts its fill; 'b' never got one
    store.persistSnapshot([], {}, [fill('a', now - 3_000), fill('b', now - 2_000), fill('x', now - 1_000, { pxApprox: true })], [{ id: 'a', curveBps: flat(2) }]);
    // re-persisting a fill (markouts aging) must not clear its curve
    store.persistSnapshot([], {}, [fill('a', now - 3_000, { markoutsBps: [2, 2, 2, 2, 2] })]);
    expect(store.recentFills(10).every((f) => !('curveBps' in f))).toBe(true);

    const reader = new VolumeStore(path, true); clean.push(() => reader.close());
    const worker = new AnalyticsWorker(path); clean.push(() => worker.close());
    const expected = await aggregateCurves(reader, 1, now);
    expect(await worker.computeCurves(1, now)).toEqual(expected);
    expect(expected.cells).toEqual([expect.objectContaining({ venueId: 'venue', fills: 1, usd: 100, usdBps: flat(200) })]);
    expect(expected.coverage).toEqual({ venue: { fills: 2, usd: 200 } });
  });

  it('nulls stored curves when the curve model changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mpamm-curves-'));
    clean.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'history.db');
    const store = new VolumeStore(path);
    store.persistSnapshot([], {}, [fill('a', 1)], [{ id: 'a', curveBps: flat(2) }]);
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare(`UPDATE meta SET value = 'curve-0' WHERE key = 'curve_model_version'`).run();
    raw.close();
    const reopened = new VolumeStore(path); clean.push(() => reopened.close());
    expect(reopened.curveFillsChunk(0, -1, '', 10)[0].curve).toBeNull();
  });
});

describe('simulator', () => {
  it('aggregates synthetic curves without leaking them onto fills', async () => {
    const sim = new SimDataSource();
    await sim.start();
    clean.push(() => sim.stop());
    expect(sim.getFills().some((f) => 'curveBps' in f)).toBe(false);
    const res = await sim.markoutCurves(1);
    expect(res.cells.length).toBeGreaterThan(0);
    expect(res.cells.every((c) => c.usdBps.length === N)).toBe(true);
  });
});
