import { describe, expect, it } from 'vitest';
import type { Fill } from '@shared';
import { agePendingMarkouts, nearestReferenceSample, type ReferenceSample } from '../markout-aging.js';

const fill = (id: number) => ({ id: String(id) } as Fill);

describe('reference horizon lookup', () => {
  it('matches the original linear scan across boundaries, ties, duplicates and gaps', () => {
    const history: ReferenceSample[] = Array.from({ length: 2000 }, (_, i) => ({ t: Math.floor(i / 2) * 100, mid: i + 1 }));
    const linear = (t: number, tolerance: number) => {
      let best: ReferenceSample | undefined, delta = Infinity;
      for (const sample of history) if (Math.abs(sample.t - t) < delta) { delta = Math.abs(sample.t - t); best = sample; }
      return delta <= tolerance ? best : undefined;
    };
    for (let t = -10_000; t <= 110_000; t += 25) {
      for (const tolerance of [0, 50, 6000]) expect(nearestReferenceSample(history, t, tolerance)).toBe(linear(t, tolerance));
    }
    expect(nearestReferenceSample([], 0, 6000)).toBeUndefined();
  });
});

describe('bounded markout passes', () => {
  it('yields before finishing a large set and visits each original fill once', async () => {
    const pending = new Set(Array.from({ length: 1000 }, (_, i) => fill(i)));
    const seen: string[] = [];
    const work = agePendingMarkouts(pending, (f) => { seen.push(f.id); pending.delete(f); }, () => false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(128);
    await work;
    expect(new Set(seen).size).toBe(1000);
    expect(pending.size).toBe(0);
  });

  it('caps a pass when each processed fill appends another one', async () => {
    const pending = new Set(Array.from({ length: 500 }, (_, i) => fill(i)));
    let visited = 0;
    await agePendingMarkouts(pending, (f) => { pending.delete(f); pending.add(fill(1000 + visited++)); }, () => false);
    expect(visited).toBe(500);
    expect(pending.size).toBe(500);
  });

  it('stops between slices without dropping unprocessed fills', async () => {
    const pending = new Set(Array.from({ length: 500 }, (_, i) => fill(i)));
    let stopped = false, visited = 0;
    const work = agePendingMarkouts(pending, () => { visited++; }, () => stopped);
    const beforeStop = visited;
    stopped = true;
    await work;
    expect(visited).toBe(beforeStop);
    expect(pending.size).toBe(500);
  });
});
