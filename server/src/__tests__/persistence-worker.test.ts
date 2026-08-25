import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VolumeStore } from '../db.js';
import { SnapshotWriter } from '../persistence.js';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${path}${suffix}`); } catch { /* already removed */ }
    }
  }
});

describe('persistence worker', () => {
  it('owns post-boot writes while acknowledgements are immediately readable on the main connection', async () => {
    const path = join(tmpdir(), `snapshot-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(path);
    const read = new VolumeStore(path);
    const writer = new SnapshotWriter(path);
    read.sealWrites();
    expect(() => read.setMeta('wrong-lane', '1')).toThrow(/read-only/);
    await expect((writer as any).request({ kind: 'unexpected' }))
      .rejects.toThrow("unknown persistence mutation 'unexpected'");

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
    expect(read.getMeta('lastProcessedBlock')).toBe('123');
    expect(read.all()).toEqual([
      { utcDay: '2026-08-25', partial: true, byVenue: { test: { usd: 12, swaps: 3 } } },
    ]);
    expect(read.recentFills(1)).toEqual([expect.objectContaining({
      id: 'test-0xabc-0', router: 'Test Router', markoutsBps: [1, null, null, null, null],
    })]);

    await writer.setMeta('worker-meta', 'ready');
    await writer.applyRemarks([{ id: 'test-0xabc-0', markoutsBps: [2, 3, null, null, null] }]);
    await writer.applyGas([{ utcDay: '2026-08-25', venueId: 'test', mon: 0.25, txs: 2 }], 'gas_cursor_test', '456');
    expect(read.getMeta('worker-meta')).toBe('ready');
    expect(read.getMeta('gas_cursor_test')).toBe('456');
    expect(read.recentFills(1)[0]?.markoutsBps).toEqual([2, 3, null, null, null]);
    expect(read.gasDays('2026-08-25')[0]?.byVenue.test).toEqual({ mon: 0.25, txs: 2 });

    await writer.resetGasFrom('test', '2026-08-25');
    expect(read.gasDays('2026-08-25')).toEqual([]);
    expect(await writer.resetVenueHistory('test', {
      beforeDay: '2026-08-26', volume: {}, fills: { fromBlock: 123n },
    }, 123n)).toEqual({ volume: 1, fills: 1 });
    expect(read.recentFills(1)).toEqual([]);

    await writer.close();
    read.close();
  });
});
