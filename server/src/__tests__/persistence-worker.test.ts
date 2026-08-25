import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VolumeStore } from '../db.js';
import { SnapshotWriter } from '../persistence.js';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

describe('snapshot worker', () => {
  it('acknowledges only after the atomic snapshot is readable from SQLite', async () => {
    const path = join(tmpdir(), `snapshot-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(path);
    const setup = new VolumeStore(path);
    setup.close();
    const writer = new SnapshotWriter(path);

    await writer.persist({
      days: [{ utcDay: '2026-08-25', partial: true, byVenue: { test: { usd: 12, swaps: 3 } } }],
      meta: { lastProcessedBlock: '123' },
      fills: [{
        id: 'test-0xabc-0', venueId: 'test', market: 'MON/USDC', side: 'buy', category: 'ROUTER',
        usd: 12, baseAmount: 10, execPx: 1.2, txHash: '0xabc', to: 'Router', router: 'Test Router',
        pool: 'Test Pool', blockNumber: 123, ts: 1_777_000_000_000, markoutsBps: [1, null, null, null, null],
      }],
      mids: [{ market: 'MON/USDC', ts: 1_777_000_000_000, mid: 1.21 }],
    });
    await writer.close();

    const read = new VolumeStore(path);
    expect(read.getMeta('lastProcessedBlock')).toBe('123');
    expect(read.all()).toEqual([
      { utcDay: '2026-08-25', partial: true, byVenue: { test: { usd: 12, swaps: 3 } } },
    ]);
    expect(read.recentFills(1)).toEqual([expect.objectContaining({
      id: 'test-0xabc-0', router: 'Test Router', markoutsBps: [1, null, null, null, null],
    })]);
    read.close();
  });
});
