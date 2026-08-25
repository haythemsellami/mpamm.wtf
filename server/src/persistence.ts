import { Worker } from 'node:worker_threads';
import type { DailyVolume, Fill } from '@shared';
import type { MidPoint, ResetDeletes, VolumeStore } from './db.js';

export interface SnapshotWrite {
  days: DailyVolume[];
  meta: Record<string, string>;
  fills: Fill[];
  mids: MidPoint[];
}

export type GasWrite = { utcDay: string; venueId: string; mon: number; txs: number };
export type RemarkWrite = { id: string; markoutsBps: (number | null)[] };

export type StoreMutation =
  | { kind: 'snapshot'; snapshot: SnapshotWrite }
  | { kind: 'setMeta'; key: string; value: string }
  | { kind: 'deleteMetaPrefix'; prefix: string }
  | { kind: 'resetVenueHistory'; venueId: string; deletes: ResetDeletes; fromBlock?: bigint }
  | { kind: 'applyGas'; rows: GasWrite[]; cursorKey: string; cursorVal: string }
  | { kind: 'resetGas'; venueId: string }
  | { kind: 'resetGasFrom'; venueId: string; fromDay: string }
  | { kind: 'insertFillsIfAbsent'; fills: Fill[] }
  | { kind: 'applyRemarks'; rows: RemarkWrite[] };

/** The one post-boot SQLite mutation lane. Production implements it in a
 * worker; tests may use the direct adapter before realtime loops exist. */
export interface StoreWriter {
  persist(snapshot: SnapshotWrite): Promise<void>;
  setMeta(key: string, value: string): Promise<void>;
  deleteMetaPrefix(prefix: string): Promise<void>;
  resetVenueHistory(venueId: string, deletes: ResetDeletes, fromBlock?: bigint): Promise<{ volume: number; fills: number }>;
  applyGas(rows: GasWrite[], cursorKey: string, cursorVal: string): Promise<void>;
  resetGas(venueId: string): Promise<void>;
  resetGasFrom(venueId: string, fromDay: string): Promise<void>;
  insertFillsIfAbsent(fills: Fill[]): Promise<number>;
  applyRemarks(rows: RemarkWrite[]): Promise<void>;
}

export function directStoreWriter(store: VolumeStore): StoreWriter {
  return {
    persist: async (snapshot) => store.persistSnapshot(snapshot.days, snapshot.meta, snapshot.fills, snapshot.mids),
    setMeta: async (key, value) => store.setMeta(key, value),
    deleteMetaPrefix: async (prefix) => store.deleteMetaPrefix(prefix),
    resetVenueHistory: async (venueId, deletes, fromBlock) => store.resetVenueHistory(venueId, deletes, fromBlock),
    applyGas: async (rows, cursorKey, cursorVal) => store.applyGas(rows, cursorKey, cursorVal),
    resetGas: async (venueId) => store.resetGas(venueId),
    resetGasFrom: async (venueId, fromDay) => store.resetGasFrom(venueId, fromDay),
    insertFillsIfAbsent: async (fills) => store.insertFillsIfAbsent(fills),
    applyRemarks: async (rows) => store.applyRemarks(rows),
  };
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * The Render disk can spend hundreds of milliseconds inside a synchronous
 * SQLite commit. Keep that durability boundary intact, but execute it outside
 * the process's quote/API event loop. Calls are acknowledged only after COMMIT.
 */
export class SnapshotWriter implements StoreWriter {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private failed?: Error;
  private closing = false;

  constructor(dbPath: string) {
    this.worker = new Worker(new URL('./persistence-worker.ts', import.meta.url), {
      workerData: { dbPath },
      // The production server runs TypeScript through tsx; give the worker the
      // same resolver explicitly so it can reuse VolumeStore instead of
      // duplicating schema-sensitive SQL in a second implementation.
      execArgv: ['--import', 'tsx'],
    });
    this.worker.unref();
    this.worker.on('message', (reply: WorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new Error(reply.error || 'snapshot worker failed'));
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closing || this.pending.size) this.fail(new Error(`snapshot worker exited with code ${code}`));
    });
  }

  persist(snapshot: SnapshotWrite): Promise<void> {
    return this.request({ kind: 'snapshot', snapshot });
  }
  setMeta(key: string, value: string): Promise<void> { return this.request({ kind: 'setMeta', key, value }); }
  deleteMetaPrefix(prefix: string): Promise<void> { return this.request({ kind: 'deleteMetaPrefix', prefix }); }
  resetVenueHistory(venueId: string, deletes: ResetDeletes, fromBlock?: bigint): Promise<{ volume: number; fills: number }> {
    return this.request({ kind: 'resetVenueHistory', venueId, deletes, fromBlock });
  }
  applyGas(rows: GasWrite[], cursorKey: string, cursorVal: string): Promise<void> {
    return this.request({ kind: 'applyGas', rows, cursorKey, cursorVal });
  }
  resetGas(venueId: string): Promise<void> { return this.request({ kind: 'resetGas', venueId }); }
  resetGasFrom(venueId: string, fromDay: string): Promise<void> { return this.request({ kind: 'resetGasFrom', venueId, fromDay }); }
  insertFillsIfAbsent(fills: Fill[]): Promise<number> { return this.request({ kind: 'insertFillsIfAbsent', fills }); }
  applyRemarks(rows: RemarkWrite[]): Promise<void> { return this.request({ kind: 'applyRemarks', rows }); }

  private request<T>(mutation: StoreMutation): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing) return Promise.reject(new Error('snapshot worker is closing'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject });
      try { this.worker.postMessage({ id, mutation }); }
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
      this.pending.set(id, { resolve: () => resolve(), reject });
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
