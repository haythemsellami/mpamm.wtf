import { StreamHub } from './stream-hub';
import { parseTopics } from '@shared';

const worker = self as unknown as { location: Location; onconnect: (event: MessageEvent) => void };
const hub = new StreamHub(`${worker.location.protocol === 'https:' ? 'wss' : 'ws'}://${worker.location.host}/stream`);
const ports = new Map<string, { port: MessagePort; seen: number }>();
let nextId = 0;
worker.onconnect = (event) => {
  const port = event.ports[0];
  const id = String(++nextId);
  ports.set(id, { port, seen: Date.now() });
  port.onmessage = ({ data }) => {
    const entry = ports.get(id);
    if (!entry) return;
    entry.seen = Date.now();
    if (data.type === 'ping') { port.postMessage({ ready: true }); return; }
    if (data.type === 'close') { hub.set(id); ports.delete(id); port.close(); return; }
    const topics = parseTopics(data.topics);
    if (!topics) return;
    hub.set(id, { topics, message: (envelope) => port.postMessage({ envelope }), status: (status) => port.postMessage({ status }) });
  };
  port.start();
  port.postMessage({ ready: true });
};
// A killed tab cannot send cleanup. A generous lease tolerates background
// timer throttling; normal visibility changes remove demand immediately.
setInterval(() => {
  for (const [id, entry] of ports) if (Date.now() - entry.seen > 120_000) {
    hub.set(id); ports.delete(id); entry.port.close();
  }
}, 30_000);
