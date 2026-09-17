import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { LeaderboardResponse } from '@shared';
import { AnalyticsPublications } from '../analytics-publications.js';

const encodes = vi.hoisted(() => [] as Array<{ json: string; done: (error: Error | null, result?: Buffer) => void }>);
vi.mock('node:zlib', async (original) => ({
  ...await original<typeof import('node:zlib')>(),
  gzip: (json: string, _options: unknown, done: (error: Error | null, result?: Buffer) => void) => { encodes.push({ json, done }); },
}));
afterEach(() => { encodes.length = 0; });
const result = (days: number, totalFills: number, generatedAt: number): LeaderboardResponse => ({
  days, generatedAt, totalFills, groups: { protocol: {}, pool: {}, to: {}, category: {} }, topSwaps: {}, outliers: [],
});
const finish = (index: number) => encodes[index].done(null, gzipSync(encodes[index].json));

describe('ordered analytics publications', () => {
  it('serializes corrected results per window and reuses the newest immutable artifact', async () => {
    const publications = new AnalyticsPublications();
    const old = publications.publish(result(1, 1, 100));
    const corrected = publications.publish(result(1, 2, 101));
    const unchanged = publications.publish(result(1, 2, 102));
    expect(encodes).toHaveLength(1);
    finish(0);
    const oldArtifact = await old;
    await vi.waitFor(() => expect(encodes).toHaveLength(2));
    expect(JSON.parse(encodes[1].json).totalFills).toBe(2);
    finish(1);
    const latest = await corrected;
    expect(await unchanged).toBe(latest);
    expect(await publications.publish(result(1, 2, 103))).toBe(latest);
    expect(encodes).toHaveLength(2);
    expect(publications.get(oldArtifact.revision)).toBe(oldArtifact);
    expect(publications.get(latest.revision)).toBe(latest);
  });

  it('encodes different windows independently', async () => {
    const publications = new AnalyticsPublications();
    const oneDay = publications.publish(result(1, 1, 100));
    const week = publications.publish(result(7, 2, 100));
    expect(encodes).toHaveLength(2);
    finish(1);
    expect(JSON.parse((await week).json).days).toBe(7);
    finish(0);
    expect(JSON.parse((await oneDay).json).days).toBe(1);
  });

  it('continues a window after a failed compression', async () => {
    const publications = new AnalyticsPublications();
    const failed = publications.publish(result(1, 1, 100));
    const rejected = expect(failed).rejects.toThrow('compression failed');
    const next = publications.publish(result(1, 2, 101));
    encodes[0].done(new Error('compression failed'));
    await rejected;
    await vi.waitFor(() => expect(encodes).toHaveLength(2));
    finish(1);
    expect(JSON.parse((await next).json).totalFills).toBe(2);
  });
});
