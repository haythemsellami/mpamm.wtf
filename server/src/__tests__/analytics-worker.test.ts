import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { VolumeStore } from '../db.js';
import { AnalyticsWorker, aggregateHistory } from '../analytics-worker.js';
import { AnalyticsPublications } from '../analytics-publications.js';
import type { Fill } from '@shared';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of clean.splice(0).reverse()) await stop(); });
const fill = (id: string, ts: number, mark: number): Fill => ({ id, ts, venueId: 'venue', market: 'MON/USDC', side: 'buy', category: 'DIRECT', usd: 100, baseAmount: 1000, execPx: .1, blockNumber: 1, txHash: '0x1', to: 'direct', pool: 'pool', markoutsBps: [mark, mark, mark, mark, mark] });

describe('isolated historical aggregates', () => {
  it('matches every exact aggregate and publishes a different immutable revision after corrections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mpamm-analytics-'));
    clean.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'history.db');
    const writer = new VolumeStore(path); clean.push(() => writer.close());
    const now = 1_800_000_000_000;
    writer.upsertFills(Array.from({ length: 321 }, (_, i) => fill(`fill-${i}`, now - i * 1000, (i % 17) - 8)));
    const reader = new VolumeStore(path, true); clean.push(() => reader.close());
    const worker = new AnalyticsWorker(path); clean.push(() => worker.close());
    const expected = await aggregateHistory(reader, 1, now);
    const actual = await worker.compute(1, now);
    expect(actual).toEqual(expected);
    const publications = new AnalyticsPublications();
    const first = await publications.publish(actual);
    expect(JSON.parse(gunzipSync(first.gzip).toString())).toEqual(actual);
    expect(await publications.publish(actual)).toBe(first);
    for (let i = 1; i <= 100; i++) {
      expect(await publications.publish({ ...actual, generatedAt: now + i * 30_000 })).toBe(first);
    }
    expect(publications.get(first.revision)?.json).toBe(JSON.stringify(actual));
    const concurrent = new AnalyticsPublications();
    const sameData = await Promise.all([actual, { ...actual, generatedAt: now + 1 }].map((result) => concurrent.publish(result)));
    expect(sameData[0]).toBe(sameData[1]);
    writer.upsertFills([fill('fill-0', now, 500)]);
    const changed = await publications.publish(await worker.compute(1, now));
    expect(changed.revision).not.toBe(first.revision);
    expect(publications.get(first.revision)?.json).toBe(first.json);
    expect(JSON.parse(changed.json)).not.toEqual(actual);
  });

  it('read-only analytics never runs schema migrations or writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mpamm-readonly-'));
    clean.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'history.db');
    const writer = new VolumeStore(path); clean.push(() => writer.close());
    const reader = new VolumeStore(path, true); clean.push(() => reader.close());
    expect(() => reader.upsertFills([fill('one', 1, 1)])).toThrow(/read-only/);
    expect(reader.fillsSince(0, 10)).toEqual([]);
  });
});
