import { StreamHub } from './stream-hub';
import { parseTopics, type StreamEnvelope, type StreamTopic } from '@shared';

const worker = self as unknown as { location: Location; onconnect: (event: MessageEvent) => void };
const hub = new StreamHub(`${worker.location.protocol === 'https:' ? 'wss' : 'ws'}://${worker.location.host}/stream`);
const ports = new Map<string, { port: MessagePort; seen: number; listeners: Set<string>; pending: Map<StreamEnvelope, Set<string>>; scheduled: boolean }>();
const remove = (id: string) => {
  for (const listener of ports.get(id)?.listeners ?? []) hub.set(`${id}:${listener}`);
  ports.delete(id);
};
let nextId = 0;
worker.onconnect = (event) => {
  const port = event.ports[0];
  const id = String(++nextId);
  ports.set(id, { port, seen: Date.now(), listeners: new Set(), pending: new Map(), scheduled: false });
  const deliver = (listener: string, envelope: StreamEnvelope) => {
    const entry = ports.get(id);
    if (!entry) return;
    const ids = entry.pending.get(envelope) ?? new Set<string>();
    ids.add(listener); entry.pending.set(envelope, ids);
    if (entry.scheduled) return;
    entry.scheduled = true;
    // Share one structured clone per frame and tab, even when several local
    // components consume depth. Cached replays target only joining consumers.
    queueMicrotask(() => {
      entry.scheduled = false;
      const pending = entry.pending; entry.pending = new Map();
      if (ports.get(id) !== entry) return;
      for (const [envelope, consumers] of pending) {
        const ids = [...consumers].filter((consumer) => entry.listeners.has(consumer));
        if (ids.length) port.postMessage({ ids, envelope });
      }
    });
  };
  port.onmessage = ({ data }) => {
    const entry = ports.get(id);
    if (!entry) return;
    entry.seen = Date.now();
    if (data.type === 'ping') { port.postMessage({ ready: true, upstreamLive: hub.isLive() }); return; }
    if (data.type === 'close') {
      remove(id);
      port.onmessage = null;
      // The client closes the channel after receiving this acknowledgement.
      port.postMessage({ type: 'closed' });
      return;
    }
    if (data.type !== 'subscribe' || !Array.isArray(data.listeners)) return;
    const wanted = new Map<string, StreamTopic[]>();
    for (const listener of data.listeners) {
      const topics = parseTopics(listener?.topics);
      if (typeof listener?.id !== 'string' || !topics) return;
      wanted.set(listener.id, topics);
    }
    for (const listener of entry.listeners) if (!wanted.has(listener)) hub.set(`${id}:${listener}`);
    for (const [listener, topics] of wanted) hub.set(`${id}:${listener}`, {
      topics, message: (envelope) => deliver(listener, envelope), status: (status) => port.postMessage({ id: listener, status }),
    });
    entry.listeners = new Set(wanted.keys());
  };
  port.start();
  port.postMessage({ ready: true });
};
// A killed tab cannot send cleanup. A generous lease tolerates background
// timer throttling; normal visibility changes remove demand immediately.
setInterval(() => {
  for (const [id, entry] of ports) if (Date.now() - entry.seen > 120_000) {
    remove(id); entry.port.close();
  }
}, 30_000);
