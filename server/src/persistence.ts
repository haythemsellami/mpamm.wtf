import { Worker } from 'node:worker_threads';
import type { DailyVolume, Fill } from '@shared';
import type { MidPoint } from './db.js';

export interface SnapshotWrite {
  days: DailyVolume[];
  meta: Record<string, string>;
  fills: Fill[];
  mids: MidPoint[];
}

interface WorkerReply {
  id: number;
  ok: boolean;
  error?: string;
}

/**
 * The Render disk can spend hundreds of milliseconds inside a synchronous
 * SQLite commit. Keep that durability boundary intact, but execute it outside
 * the process's quote/API event loop. Calls are acknowledged only after COMMIT.
 */
export class SnapshotWriter {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private failed?: Error;
  private closing = false;

  constructor(dbPath: string) {
    this.worker = new Worker(new URL('./persistence-worker.mjs', import.meta.url), { workerData: { dbPath } });
    this.worker.unref();
    this.worker.on('message', (reply: WorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve();
      else pending.reject(new Error(reply.error || 'snapshot worker failed'));
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closing || this.pending.size) this.fail(new Error(`snapshot worker exited with code ${code}`));
    });
  }

  persist(snapshot: SnapshotWrite): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing) return Promise.reject(new Error('snapshot worker is closing'));
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, snapshot }); }
      catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.failed) {
      await this.worker.terminate();
      return;
    }
    const id = this.nextId++;
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, close: true }); }
      catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error): void {
    this.failed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
