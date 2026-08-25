import { parentPort, workerData } from 'node:worker_threads';
import { VolumeStore } from './db.js';
import type { StoreMutation } from './persistence.js';

if (!parentPort) throw new Error('persistence worker requires a parent port');

const store = new VolumeStore((workerData as { dbPath: string }).dbPath);

function apply(mutation: StoreMutation): unknown {
  switch (mutation.kind) {
    case 'snapshot': {
      const { days, meta, fills, mids } = mutation.snapshot;
      return store.persistSnapshot(days, meta, fills, mids);
    }
    case 'setMeta': return store.setMeta(mutation.key, mutation.value);
    case 'deleteMetaPrefix': return store.deleteMetaPrefix(mutation.prefix);
    case 'resetVenueHistory': return store.resetVenueHistory(mutation.venueId, mutation.deletes, mutation.fromBlock);
    case 'applyGas': return store.applyGas(mutation.rows, mutation.cursorKey, mutation.cursorVal);
    case 'resetGas': return store.resetGas(mutation.venueId);
    case 'resetGasFrom': return store.resetGasFrom(mutation.venueId, mutation.fromDay);
    case 'insertFillsIfAbsent': return store.insertFillsIfAbsent(mutation.fills);
    case 'applyRemarks': return store.applyRemarks(mutation.rows);
  }
}

parentPort.on('message', ({ id, mutation, close }: { id: number; mutation?: StoreMutation; close?: boolean }) => {
  if (close) {
    store.close();
    parentPort!.postMessage({ id, ok: true });
    parentPort!.close();
    return;
  }
  try {
    if (!mutation) throw new Error('persistence mutation is required');
    parentPort!.postMessage({ id, ok: true, result: apply(mutation) });
  } catch (error) {
    parentPort!.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
