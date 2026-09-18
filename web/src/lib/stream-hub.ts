import { STREAM_V2_GZIP, STREAM_V2_JSON, topicKey, type StreamEnvelope, type StreamTopic } from '@shared';

export type StreamStatus = 'live' | 'reconnecting';
export interface HubListener {
  topics: StreamTopic[];
  message: (envelope: StreamEnvelope) => void;
  status: (status: StreamStatus) => void;
}

/** One upstream connection for the union of local consumers. The same class
 * runs in a SharedWorker and in the per-tab fallback. Decoding stays ordered. */
export class StreamHub {
  private listeners = new Map<string, HubListener>();
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private scheduled = false;
  private epoch = '';
  private sequences = new Map<string, number>();
  private latest = new Map<string, StreamEnvelope>();
  private receivedAt = new Map<string, number>();
  private status?: StreamStatus;

  constructor(private readonly url: string) {}

  isLive(): boolean { return this.status === 'live' && this.socket?.readyState === WebSocket.OPEN; }

  set(id: string, listener?: HubListener): void {
    if (listener) {
      const previous = this.listeners.get(id);
      const retained = new Set(previous?.topics.map(topicKey));
      this.listeners.set(id, listener);
      if (!previous && this.status) listener.status(this.status);
      for (const topic of listener.topics) {
        if (retained.has(topicKey(topic))) continue;
        const cached = this.latest.get(topicKey(topic));
        const receivedAt = this.receivedAt.get(topicKey(topic)) ?? -Infinity;
        if (cached && topic.channel !== 'fill' && this.isLive() && Date.now() - receivedAt <= 5_000
          && (cached.message.ch !== 'quotes' || Date.now() - cached.message.data.ts <= 60_000)
          && (cached.message.ch !== 'depth' || Date.now() - cached.message.data.ts <= 5_000)) listener.message(cached);
      }
    } else this.listeners.delete(id);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; this.sync(); });
    }
  }

  close(): void {
    this.listeners.clear();
    this.sync();
  }

  private sync(): void {
    const topics = new Map<string, StreamTopic>();
    for (const listener of this.listeners.values()) for (const topic of listener.topics) topics.set(topicKey(topic), topic);
    for (const key of this.latest.keys()) if (!topics.has(key)) { this.latest.delete(key); this.receivedAt.delete(key); this.sequences.delete(key); }
    if (!topics.size) {
      if (this.retry) clearTimeout(this.retry);
      this.retry = undefined;
      const socket = this.socket;
      this.socket = undefined;
      socket?.close();
      this.status = undefined;
      return;
    }
    if (!this.socket) this.open();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'subscribe', topics: [...topics.values()] }));
  }

  private notify(status: StreamStatus): void {
    this.status = status;
    for (const listener of this.listeners.values()) listener.status(status);
  }

  private open(): void {
    const socket = new WebSocket(this.url, typeof DecompressionStream === 'function' ? STREAM_V2_GZIP : STREAM_V2_JSON);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    this.sequences.clear();
    this.latest.clear();
    this.receivedAt.clear();
    let queue = Promise.resolve();
    let pending = 0;
    socket.onopen = () => { if (this.socket !== socket) return; this.sync(); this.notify('live'); };
    socket.onmessage = (event) => {
      if (++pending > 64) { socket.close(); return; }
      queue = queue.then(async () => {
        if (this.socket !== socket) return;
        const text = typeof event.data === 'string' ? event.data
          : await new Response(new Blob([event.data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        if (this.socket !== socket) return;
        const envelope = JSON.parse(text) as StreamEnvelope;
        if (envelope.v !== 2 || !envelope.message || !Number.isSafeInteger(envelope.seq)) throw new Error('invalid stream frame');
        if (this.epoch && this.epoch !== envelope.epoch) {
          this.sequences.clear(); this.latest.clear(); this.receivedAt.clear();
          this.notify('reconnecting'); this.notify('live');
        }
        this.epoch = envelope.epoch;
        const previous = this.sequences.get(envelope.topic);
        if (previous !== undefined && envelope.seq < previous) return;
        if (previous !== undefined && envelope.seq === previous && !envelope.snapshot) return;
        if (envelope.topic === 'fill' && previous !== undefined && envelope.seq > previous + 1) {
          this.notify('reconnecting'); this.notify('live');
        }
        this.sequences.set(envelope.topic, envelope.seq);
        if (envelope.message.ch === 'state') {
          const prior = this.latest.get(envelope.topic);
          if (prior?.message.ch === 'state') envelope.message.data = { ...prior.message.data, ...envelope.message.data };
        }
        if (envelope.topic !== 'fill') { this.latest.set(envelope.topic, envelope); this.receivedAt.set(envelope.topic, Date.now()); }
        for (const listener of this.listeners.values()) {
          if (listener.topics.some((topic) => topicKey(topic) === envelope.topic)) listener.message(envelope);
        }
      }).catch(() => { if (this.socket === socket) socket.close(); }).finally(() => { pending--; });
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.latest.clear(); this.receivedAt.clear();
      this.notify('reconnecting');
      this.retry = setTimeout(() => { this.retry = undefined; this.sync(); }, 1_000 + Math.random() * 250);
    };
  }
}
