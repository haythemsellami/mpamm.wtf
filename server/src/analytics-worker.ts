import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { LeaderboardResponse } from '@shared';
import { VolumeStore } from './db.js';
import { computeLeaderboard } from './analytics.js';
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

if (!isMainThread) {
  const store = new VolumeStore(workerData.path, true);
  let queue = Promise.resolve();
  parentPort!.on('message', (request: { id: number; days: number; now: number }) => {
    queue = queue.then(async () => {
      try { parentPort!.postMessage({ id: request.id, result: await aggregateHistory(store, request.days, request.now) }); }
      catch { parentPort!.postMessage({ id: request.id, error: 'history aggregation failed' }); }
    });
  });
}

export class AnalyticsWorker {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<number, { resolve: (result: LeaderboardResponse) => void; reject: (error: Error) => void }>();
  constructor(private readonly path: string) {}

  compute(days: number, now: number): Promise<LeaderboardResponse> {
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
        if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply.result);
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, days, now });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (worker) await worker.terminate();
  }
}
