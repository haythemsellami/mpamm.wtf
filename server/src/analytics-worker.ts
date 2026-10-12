import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { LeaderboardResponse, MarkoutCurvesResponse } from '@shared';
import { VolumeStore } from './db.js';
import { computeLeaderboard } from './analytics.js';
import { computeMarkoutCurves } from './markout-curves.js';
import { config } from './config.js';

/** Analytics gets its own read-only connection and a consistent WAL snapshot.
 * Both percentile passes see the same marks while the writer keeps committing. */
export async function aggregateHistory(store: VolumeStore, days: number, now: number): Promise<LeaderboardResponse> {
  return store.readSnapshot(async () => {
    const makePass = () => {
      let ts = -1, id = '';
      return () => {
        const page = store.lbFillsChunk(now - days * 86_400_000, ts, id, 25_000, now);
        if (page.length) { const last = page.at(-1)!; ts = last.ts; id = last.id; }
        return page;
      };
    };
    return computeLeaderboard(makePass, days, now, (ids) => store.fillsByIds(ids));
  });
}

/** Markout curves over the window — one keyset pass in the same snapshot discipline. */
export async function aggregateCurves(store: VolumeStore, days: number, now: number): Promise<MarkoutCurvesResponse> {
  return store.readSnapshot(async () => {
    let ts = -1, id = '';
    return computeMarkoutCurves(() => {
      const page = store.curveFillsChunk(now - days * 86_400_000, ts, id, 10_000, now);
      if (page.length) { const last = page.at(-1)!; ts = last.ts; id = last.id; }
      return page;
    }, days, now);
  });
}

type AnalyticsKind = 'leaderboard' | 'curves';
interface AnalyticsResults { leaderboard: LeaderboardResponse; curves: MarkoutCurvesResponse }

if (!isMainThread) {
  const store = new VolumeStore(workerData.path, true);
  let queue = Promise.resolve();
  parentPort!.on('message', (request: { id: number; kind?: AnalyticsKind; days: number; now: number }) => {
    queue = queue.then(async () => {
      try {
        const result = request.kind === 'curves'
          ? await aggregateCurves(store, request.days, request.now)
          : await aggregateHistory(store, request.days, request.now);
        parentPort!.postMessage({ id: request.id, result });
      } catch { parentPort!.postMessage({ id: request.id, error: 'history aggregation failed' }); }
    });
  });
}

export class AnalyticsWorker {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<number, { resolve: (result: never) => void; reject: (error: Error) => void }>();
  constructor(private readonly path: string) {}

  compute(days: number, now: number): Promise<LeaderboardResponse> {
    return this.request('leaderboard', days, now);
  }

  computeCurves(days: number, now: number): Promise<MarkoutCurvesResponse> {
    return this.request('curves', days, now);
  }

  private request<K extends AnalyticsKind>(kind: K, days: number, now: number): Promise<AnalyticsResults[K]> {
    if (!this.worker) {
      // Bound the extra isolate's JS heap on memory-constrained instances.
      // Native SQLite pages and typed-array storage still require RSS headroom.
      const worker = new Worker(new URL('./analytics-worker.ts', import.meta.url), {
        workerData: { path: this.path }, execArgv: ['--import', 'tsx'],
        resourceLimits: { maxOldGenerationSizeMb: config.analyticsWorkerHeapMb },
      });
      this.worker = worker;
      worker.unref();
      worker.on('message', (reply) => {
        const request = this.pending.get(reply.id);
        if (!request) return;
        this.pending.delete(reply.id);
        if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply.result as never);
      });
      const failed = () => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const request of this.pending.values()) request.reject(new Error('analytics worker stopped'));
        this.pending.clear();
      };
      worker.once('error', failed);
      worker.once('exit', failed);
    }
    const id = ++this.next;
    return new Promise<AnalyticsResults[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: never) => void, reject });
      this.worker!.postMessage({ id, kind, days, now });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (worker) await worker.terminate();
  }
}
