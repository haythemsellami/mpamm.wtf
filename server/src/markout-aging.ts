import type { Fill } from '@shared';

export interface ReferenceSample { t: number; mid: number }

/** Histories are chronological. Equal-distance marks prefer the earlier
 * sample, matching the original scan, including duplicate timestamps. */
export function nearestReferenceSample(history: readonly ReferenceSample[], t: number, toleranceMs: number): ReferenceSample | undefined {
  const lowerBound = (at: number) => {
    let lo = 0, hi = history.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (history[mid].t < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const index = lowerBound(t);
  const before = history[index - 1], after = history[index];
  const best = before && (!after || t - before.t <= after.t - t)
    ? history[lowerBound(before.t)] : after;
  return best && Math.abs(best.t - t) <= toleranceMs ? best : undefined;
}

/** A pass never copies the whole pending set or monopolizes one event-loop
 * turn. Its initial size caps work even while new fills arrive. */
export async function agePendingMarkouts(
  pending: Set<Fill>, age: (fill: Fill, now: number) => void, stopped: () => boolean,
): Promise<void> {
  const limit = pending.size, now = Date.now();
  let visited = 0, inSlice = 0, sliceStarted = performance.now();
  for (const fill of pending) {
    if (stopped() || visited >= limit) return;
    age(fill, now);
    visited++;
    if (++inSlice >= 128 || performance.now() - sliceStarted >= 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      inSlice = 0;
      sliceStarted = performance.now();
    }
  }
}
