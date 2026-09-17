import { topicKey, type StreamEnvelope, type StreamTopic, type TopicMessage } from '@shared';
import { StreamHub, type HubListener, type StreamStatus } from './stream-hub';

let nextId = 0;
const listeners = new Map<string, HubListener>();
let shared: SharedWorker | undefined;
let direct: StreamHub | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let startup: ReturnType<typeof setTimeout> | undefined;
let lastHeard = 0;
let failedShared = false;
let syncPending = false;
let pageSuspended = false;

function disconnectShared(): void {
  const worker = shared;
  shared = undefined;
  if (!worker) return;
  // Keep the channel open until the worker has removed its demand. Closing
  // immediately can race the cleanup message; a dead worker has the lease.
  const finish = () => { clearTimeout(timer); worker.port.onmessage = null; worker.port.close(); };
  const timer = setTimeout(finish, 5_000);
  worker.port.onmessage = ({ data }) => { if (data.type === 'closed') finish(); };
  try { worker.port.postMessage({ type: 'close' }); } catch { finish(); }
}

function fallback(): void {
  if (startup) clearTimeout(startup);
  startup = undefined;
  failedShared = true;
  if (shared) for (const listener of listeners.values()) listener.status('reconnecting');
  disconnectShared();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  direct ??= new StreamHub(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`);
  for (const [id, listener] of listeners) direct.set(id, listener);
}

function sync(): void {
  if (pageSuspended) return;
  if (!listeners.size) {
    if (startup) clearTimeout(startup);
    startup = undefined;
    disconnectShared();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    direct?.close(); direct = undefined;
    return;
  }
  if (direct) return;
  if (!shared && !failedShared && typeof SharedWorker !== 'undefined') {
    try {
      const worker = new SharedWorker(new URL('./stream.shared-worker.ts', import.meta.url), { type: 'module', name: 'mpamm-stream-v2' });
      shared = worker;
      worker.onerror = () => { if (shared === worker) fallback(); };
      worker.port.onmessage = ({ data }: MessageEvent<{ envelope?: StreamEnvelope; status?: StreamStatus; upstreamLive?: boolean }>) => {
        if (shared !== worker) return;
        // Port readiness and ping replies do not prove the upstream socket is
        // usable. Keep the recovery deadline until a live stream is observed.
        if (data.status === 'live' || data.envelope || data.upstreamLive === true) {
          lastHeard = Date.now();
          if (startup) clearTimeout(startup);
          startup = undefined;
        } else if (data.status === 'reconnecting' && !startup) {
          startup = setTimeout(fallback, 5_000);
        }
        for (const listener of listeners.values()) {
          if (data.status) listener.status(data.status);
          if (data.envelope && listener.topics.some((topic) => topicKey(topic) === data.envelope!.topic)) listener.message(data.envelope);
        }
      };
      shared.port.start();
      lastHeard = Date.now();
      startup = setTimeout(fallback, 5_000);
      heartbeat = setInterval(() => {
        if (Date.now() - lastHeard > 60_000) fallback();
        else shared?.port.postMessage({ type: 'ping' });
      }, 20_000);
    } catch { fallback(); }
  }
  if (!shared) { fallback(); return; }
  const topics = new Map<string, StreamTopic>();
  for (const listener of listeners.values()) for (const topic of listener.topics) topics.set(topicKey(topic), topic);
  shared.port.postMessage({ type: 'subscribe', topics: [...topics.values()] });
}

function scheduleSync(): void {
  if (syncPending) return;
  syncPending = true;
  queueMicrotask(() => { syncPending = false; sync(); });
}

export function subscribeTopics(topics: StreamTopic[], message: (message: TopicMessage) => void, status: (state: StreamStatus) => void = () => {}): () => void {
  const id = String(++nextId);
  const listener: HubListener = { topics, message: (envelope) => message(envelope.message), status };
  listeners.set(id, listener);
  direct?.set(id, listener);
  scheduleSync();
  return () => { listeners.delete(id); direct?.set(id); scheduleSync(); };
}

// BFCache preserves JS state. Release the old port on departure and rebuild
// the same union on return, including browsers without SharedWorker support.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    pageSuspended = true;
    if (startup) clearTimeout(startup);
    startup = undefined;
    disconnectShared();
    direct?.close(); direct = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  });
  window.addEventListener('pageshow', () => {
    if (!pageSuspended) return;
    pageSuspended = false;
    for (const listener of listeners.values()) listener.status('reconnecting');
    if (listeners.size) scheduleSync();
  });
}
