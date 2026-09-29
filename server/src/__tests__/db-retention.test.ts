// Disk-space invariants of the store (db.ts). Prod crash-looped on 2026-09-29
// when the 1 GB disk filled: an every-5s mid curve (~half the file) plus a
// single boot-time retention DELETE that needed WAL room the disk no longer
// had. These lock down the pieces that keep the file bounded.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRUNE_BATCH_ROWS, VACUUM_MIN_FREE_BYTES, VACUUM_SPACE_FACTOR, VolumeStore, retentionCutoffMs, vacuumPlan } from '../db.js';

const paths: string[] = [];
const fresh = () => {
  const path = join(tmpdir(), `db-retention-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(path);
  return path;
};
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${path}${suffix}`); } catch { /* already removed */ }
    }
  }
});

const fill = (i: number, ts: number) => ({
  id: `t-0x${i.toString(16)}-0`, venueId: 't', market: 'MON/USDC', side: 'buy' as const, category: 'ROUTER' as const,
  usd: 1, baseAmount: 1, execPx: 1, txHash: '0x1', to: 'x', pool: 'p', blockNumber: i, ts, markoutsBps: [null, null, null, null, null],
});
const tables = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name);
  db.close();
  return names;
};

describe('retired mid_history', () => {
  it('is dropped on open and its pages go to the freelist (reclaimable by VACUUM)', () => {
    const path = fresh();
    new VolumeStore(path).close();
    // an old build's table, with enough rows to span many pages
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE mid_history (market TEXT NOT NULL, ts INTEGER NOT NULL, mid REAL NOT NULL, PRIMARY KEY (market, ts)) WITHOUT ROWID`);
    const ins = legacy.prepare(`INSERT INTO mid_history VALUES (?, ?, ?)`);
    legacy.exec('BEGIN');
    for (let i = 0; i < 20_000; i++) ins.run('MON/USDC', i, 1.2);
    legacy.exec('COMMIT');
    legacy.close();

    const store = new VolumeStore(path);
    expect(tables(path)).not.toContain('mid_history');
    expect(store.freeBytes()).toBeGreaterThan(100_000);
    store.vacuum();
    expect(store.freeBytes()).toBe(0);
    store.close();
  });

  it('snapshot writes no longer create or touch it', () => {
    const path = fresh();
    const store = new VolumeStore(path);
    store.persistSnapshot([], { k: 'v' }, [fill(1, 1)]);
    expect(tables(path)).not.toContain('mid_history');
    store.close();
  });
});

describe('batched retention prune', () => {
  it('deletes only rows older than the cutoff, one bounded batch per call', () => {
    const path = fresh();
    const store = new VolumeStore(path);
    const old = PRUNE_BATCH_ROWS + 10;
    store.persistSnapshot([], {}, [
      ...Array.from({ length: old }, (_, i) => fill(i, 1_000 + i)),
      fill(old, 50_000),
    ]);
    expect(store.pruneFills(50_000)).toBe(PRUNE_BATCH_ROWS); // first batch is capped
    expect(store.pruneFillsBefore(50_000)).toEqual({ removed: 10, done: true });
    expect(store.recentFills(10).map((f) => f.ts)).toEqual([50_000]);
    store.close();
  });

  it('maxBatches bounds one sweep; the next sweep carries on', () => {
    const path = fresh();
    const store = new VolumeStore(path);
    store.persistSnapshot([], {}, Array.from({ length: PRUNE_BATCH_ROWS * 2 + 1 }, (_, i) => fill(i, i + 1)));
    expect(store.pruneFillsBefore(1e12, 1)).toEqual({ removed: PRUNE_BATCH_ROWS, done: false });
    expect(store.pruneFillsBefore(1e12, 5)).toEqual({ removed: PRUNE_BATCH_ROWS + 1, done: true });
    store.close();
  });
});

describe('disk-full back-off', () => {
  const full = () => Object.assign(new Error('database or disk is full'), { errcode: 13 });

  it('halves the batch on SQLITE_FULL and still clears the backlog', () => {
    const path = fresh();
    const store = new VolumeStore(path);
    store.persistSnapshot([], {}, Array.from({ length: 3 * PRUNE_BATCH_ROWS }, (_, i) => fill(i, i + 1)));
    const real = store.pruneFills.bind(store);
    const sizes: number[] = [];
    // the disk only has room for small batches until the first two land
    const spy = vi.spyOn(store, 'pruneFills').mockImplementation((before, limit = PRUNE_BATCH_ROWS) => {
      sizes.push(limit);
      if (limit > PRUNE_BATCH_ROWS / 4 && sizes.length < 4) throw full();
      return real(before, limit);
    });
    expect(store.pruneFillsBefore(1e12)).toEqual({ removed: 3 * PRUNE_BATCH_ROWS, done: true });
    expect(sizes.slice(0, 3)).toEqual([PRUNE_BATCH_ROWS, PRUNE_BATCH_ROWS / 2, PRUNE_BATCH_ROWS / 4]);
    expect(Math.max(...sizes.slice(3))).toBe(PRUNE_BATCH_ROWS); // grows back once space frees
    spy.mockRestore();
    store.close();
  });

  it('rethrows a non-disk error, and a disk-full one at the floor batch', () => {
    const path = fresh();
    const store = new VolumeStore(path);
    store.persistSnapshot([], {}, [fill(1, 1)]);
    vi.spyOn(store, 'pruneFills').mockImplementationOnce(() => { throw Object.assign(new Error('boom'), { errcode: 1 }); });
    expect(() => store.pruneFillsBefore(1e12)).toThrow('boom');
    vi.spyOn(store, 'pruneFills').mockImplementation(() => { throw full(); });
    expect(() => store.pruneFillsBefore(1e12)).toThrow('disk is full');
    vi.restoreAllMocks();
    store.close();
  });
});

describe('retentionCutoffMs', () => {
  it('aligns to a UTC day start so the oldest retained day is whole', () => {
    const now = Date.parse('2026-09-29T13:15:41Z');
    expect(new Date(retentionCutoffMs(now, 31)).toISOString()).toBe('2026-08-29T00:00:00.000Z');
  });

  it('keeps at least the 30-day leaderboard window at the default 31', () => {
    const now = Date.parse('2026-09-29T23:59:59Z');
    expect(retentionCutoffMs(now, 31)).toBeLessThanOrEqual(now - 30 * 86_400_000);
  });
});

describe('boot VACUUM capacity gate', () => {
  const MB = 1024 * 1024;
  const MIN = VACUUM_MIN_FREE_BYTES;

  it('skips when too little is reclaimable, whatever the disk', () => {
    expect(vacuumPlan(MIN - 1, 500 * MB, 100_000 * MB)).toBe('skip');
  });

  it('requires room for BOTH WAL-mode copies (temp + WAL), not one', () => {
    expect(VACUUM_SPACE_FACTOR).toBeGreaterThanOrEqual(2);
    // 300 MB live — the review's case: ~603 MB peak; a 1.2× gate allowed 428 MB
    const file = 900 * MB, free = 600 * MB;
    expect(vacuumPlan(free, file, 428 * MB)).toBe('defer');
    expect(vacuumPlan(free, file, 603 * MB)).toBe('defer'); // no slack left yet
    expect(vacuumPlan(free, file, 300 * MB * VACUUM_SPACE_FACTOR + MIN)).toBe('run');
  });

  it('defers when the disk cannot hold the rewrite plus slack', () => {
    // 1 GB file, 600 MB free pages → 424 MB live
    const file = 1024 * MB, free = 600 * MB, live = file - free;
    const need = live * VACUUM_SPACE_FACTOR + MIN;
    expect(vacuumPlan(free, file, need - 1)).toBe('defer');
    expect(vacuumPlan(free, file, 0)).toBe('defer'); // the prod crash state
  });

  it('runs at exactly enough room, and with plenty', () => {
    const file = 1024 * MB, free = 600 * MB;
    const need = (file - free) * VACUUM_SPACE_FACTOR + MIN;
    expect(vacuumPlan(free, file, need)).toBe('run');
    expect(vacuumPlan(free, file, 5000 * MB)).toBe('run');
  });

  it('a failed VACUUM still truncates the WAL it grew, then rethrows', () => {
    const path = fresh();
    const store = new VolumeStore(path);
    const cp = vi.spyOn(store, 'checkpointWal');
    vi.spyOn((store as any).db, 'exec').mockImplementationOnce(() => { throw Object.assign(new Error('database or disk is full'), { errcode: 13 }); });
    expect(() => store.vacuum()).toThrow('disk is full');
    expect(cp).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    store.close();
  });

  it('vacuumIfRoom calls VACUUM only on a run plan', () => {
    const path = fresh();
    const store = new VolumeStore(path);
    const spy = vi.spyOn(store, 'vacuum');
    // stub the page accounting: 100 MB file, 80 MB of it free pages (20 MB live)
    vi.spyOn(store, 'freeBytes').mockReturnValue(80 * MB);
    vi.spyOn(store, 'fileBytes').mockReturnValue(100 * MB);
    expect(store.vacuumIfRoom(10 * MB)).toMatchObject({ plan: 'defer', liveBytes: 20 * MB });
    expect(spy).not.toHaveBeenCalled();
    expect(store.vacuumIfRoom(1000 * MB).plan).toBe('run');
    expect(spy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    store.close();
  });
});
