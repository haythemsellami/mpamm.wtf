import { randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import {
  parseTopics, topicKey, STREAM_V2_GZIP,
  type StreamTopic, type StreamEnvelope, type StreamMessage, type TopicMessage,
} from '@shared';
import type { DataSource } from './datasource/index.js';

const zip = promisify(gzip);
const BACKLOG = 256_000;
type Payload = string | Buffer;
type Queued = { topic: string; subscription: symbol; payload: Payload | Promise<Payload>; bytes: number };
type Peer = {
  ws: WebSocket; topics: Map<string, symbol>;
  sending: boolean; queuedBytes: number; queue: Queued[];
};
type Group = {
  topic: StreamTopic; peers: Set<Peer>; seq: number; stop?: () => void;
  encoding: boolean; pending?: TopicMessage; lastJson?: string; lastCatalog?: string; lastAt: number;
  initial?: { json: string; payload: Promise<Payload> };
};

/** Public frames are encoded once per topic. Slow snapshots replace pending
 * snapshots; durable fill updates either arrive in order or force a resync. */
export class SubscriptionGateway {
  readonly epoch = randomUUID();
  readonly metrics = { connections: 0, topics: 0, encodes: 0, rawBytes: 0, encodedBytes: 0, sentBytes: 0, coalesced: 0, slowClients: 0 };
  private groups = new Map<string, Group>();
  private sequences = new Map<string, number>();
  private peers = new Set<Peer>();

  constructor(private readonly source: DataSource) {}

  accept(ws: WebSocket): void {
    const peer: Peer = { ws, topics: new Map(), sending: false, queuedBytes: 0, queue: [] };
    this.peers.add(peer);
    this.metrics.connections = this.peers.size;
    let changes = 0;
    const limit = setInterval(() => { changes = 0; }, 1_000);
    limit.unref();
    ws.on('message', (raw) => {
      try {
        const request = JSON.parse(raw.toString());
        const topics = request.type === 'subscribe' ? parseTopics(request.topics) : null;
        if (!topics || ++changes > 20) { ws.close(1008, 'invalid subscription'); return; }
        this.subscribe(peer, topics);
      } catch { ws.close(1008, 'invalid subscription'); }
    });
    ws.once('close', () => {
      clearInterval(limit);
      this.subscribe(peer, []);
      this.peers.delete(peer);
      this.metrics.connections = this.peers.size;
    });
  }

  close(): void {
    for (const peer of this.peers) peer.ws.terminate();
    for (const group of this.groups.values()) group.stop?.();
    this.groups.clear();
  }

  private subscribe(peer: Peer, topics: StreamTopic[]): void {
    const wanted = new Set(topics.map(topicKey));
    for (const key of peer.topics.keys()) {
      if (wanted.has(key)) continue;
      peer.topics.delete(key);
      const group = this.groups.get(key);
      group?.peers.delete(peer);
      if (group && !group.peers.size) { group.stop?.(); this.groups.delete(key); }
    }
    // Include the entry currently awaiting compression. Retained topics keep
    // their ordered events; removed topics immediately release their budget.
    peer.queue = peer.queue.filter((entry) => peer.topics.get(entry.topic) === entry.subscription);
    peer.queuedBytes = peer.queue.reduce((total, entry) => total + entry.bytes, 0);
    for (const topic of topics) {
      const key = topicKey(topic);
      if (peer.topics.has(key)) continue;
      peer.topics.set(key, Symbol());
      let group = this.groups.get(key);
      if (!group) {
        group = { topic, peers: new Set(), seq: this.sequences.get(key) ?? 0, encoding: false, lastAt: 0 };
        this.groups.set(key, group);
        if (topic.channel === 'quotes') group.stop = this.source.watchQuotes?.(topic);
        if (topic.channel === 'depth') {
          const g = group;
          group.stop = this.source.watchDepth(topic.market, (publication) => {
            this.publish(g, { ch: 'depth', data: JSON.parse(publication.json) });
          });
        }
      }
      group.peers.add(peer);
      const initial = this.snapshot(topic);
      if (initial) {
        // A later peer's snapshot must not hide a catalog update still owed
        // to the existing peers. Only the first snapshot establishes it.
        if (initial.ch === 'state' && group.peers.size === 1) group.lastCatalog = JSON.stringify(initial.data.quoteMarkets);
        this.sendSnapshot(peer, group, initial);
      }
    }
    this.metrics.topics = this.groups.size;
  }

  private snapshot(topic: StreamTopic): TopicMessage | undefined {
    if (topic.channel === 'state') {
      const { notes: _, ...state } = this.source.getState();
      return { ch: 'state', data: state };
    }
    if (topic.channel === 'quotes') return this.select(topic, { ch: 'quotes', data: this.source.getQuotes() });
    if (topic.channel === 'volume') {
      const today = this.source.getVolume().at(-1);
      return today && { ch: 'volume', data: today };
    }
    if (topic.channel === 'depth') {
      const depth = this.source.getDepth(topic.market);
      return depth && { ch: 'depth', data: JSON.parse(depth.json) };
    }
  }

  private select(topic: StreamTopic, message: StreamMessage, baselineIds?: ReadonlySet<string>): TopicMessage | undefined {
    if (message.ch !== topic.channel) return;
    if (message.ch === 'quotes' && topic.channel === 'quotes') {
      const baselines = baselineIds ?? new Set(this.source.getState().venues.filter((v) => v.role === 'baseline').map((v) => v.id));
      return { ch: 'quotes', data: { ...message.data, rows: message.data.rows.filter((r) =>
        r.market === topic.market && r.sizeUsd === topic.sizeUsd && (topic.baseline || !baselines.has(r.venueId))) } };
    }
    if (message.ch === 'state') {
      const { notes: _, venues: __, ...state } = message.data as ReturnType<DataSource['getState']>;
      return { ch: 'state', data: state };
    }
    return message;
  }

  onMessage(message: StreamMessage): void {
    let baselineIds: ReadonlySet<string> | undefined;
    for (const group of this.groups.values()) {
      if (group.topic.channel === 'state' && Date.now() - group.lastAt < 1_000) continue;
      if (message.ch === 'quotes' && group.topic.channel === 'quotes' && !baselineIds) {
        baselineIds = new Set(this.source.getState().venues.filter((v) => v.role === 'baseline').map((v) => v.id));
      }
      const selected = this.select(group.topic, message, baselineIds);
      if (!selected) continue;
      if (selected.ch === 'volume') {
        const json = JSON.stringify(selected.data);
        if (json === group.lastJson) continue;
        group.lastJson = json;
      }
      this.publish(group, selected);
    }
  }

  private envelope(group: Group, message: TopicMessage, snapshot = false): StreamEnvelope {
    return { v: 2, epoch: this.epoch, topic: topicKey(group.topic), seq: group.seq, ...(snapshot ? { snapshot: true } : {}), message };
  }

  private sendSnapshot(peer: Peer, group: Group, message: TopicMessage): void {
    const key = topicKey(group.topic);
    const json = JSON.stringify(this.envelope(group, message, true));
    if (peer.ws.protocol !== STREAM_V2_GZIP || json.length < 512) { this.send(peer, key, json); return; }
    if (group.initial?.json !== json) {
      this.metrics.rawBytes += Buffer.byteLength(json);
      this.metrics.encodes++;
      const payload = zip(json, { level: 3 }).then((buffer) => {
        this.metrics.encodedBytes += buffer.length;
        return buffer;
      }).catch(() => json);
      group.initial = { json, payload };
    }
    this.send(peer, key, group.initial.payload, Buffer.byteLength(json));
  }

  private publish(group: Group, message: TopicMessage): void {
    if (!group.peers.size) return;
    if (group.encoding) { group.pending = message; this.metrics.coalesced++; return; }
    // Track catalogs only when publishing: a coalesced pending state must
    // keep its catalog until the update actually reaches the shared stream.
    if (message.ch === 'state') {
      const catalog = JSON.stringify(message.data.quoteMarkets);
      if (catalog === group.lastCatalog) delete message.data.quoteMarkets;
      else group.lastCatalog = catalog;
    }
    group.lastAt = Date.now();
    group.seq++;
    this.sequences.set(topicKey(group.topic), group.seq);
    const json = JSON.stringify(this.envelope(group, message));
    const key = topicKey(group.topic);
    this.metrics.rawBytes += Buffer.byteLength(json);
    // Small events avoid zlib entirely, keeping fill ordering independent of
    // compression. Each snapshot topic permits only one queued replacement.
    const compress = message.ch !== 'fill' && json.length >= 512
      && [...group.peers].some((peer) => peer.ws.protocol === STREAM_V2_GZIP);
    if (!compress) { for (const peer of group.peers) this.send(peer, key, json); return; }
    // A peer joining during compression already gets its own snapshot. An
    // earlier subscription must not deliver into a later one for the same key.
    const recipients = new Map([...group.peers].map((peer) => [peer, peer.topics.get(key)]));
    const fanout = (payload: Payload) => {
      for (const [peer, subscription] of recipients) {
        if (peer.topics.get(key) === subscription) this.send(peer, key, peer.ws.protocol === STREAM_V2_GZIP ? payload : json);
      }
    };
    group.encoding = true;
    this.metrics.encodes++;
    void zip(json, { level: 3 }).then((buffer) => {
      this.metrics.encodedBytes += buffer.length;
      fanout(buffer);
    }).catch(() => fanout(json)).finally(() => {
      group.encoding = false;
      const next = group.pending;
      group.pending = undefined;
      if (next) this.publish(group, next);
    });
  }

  private send(peer: Peer, topic: string, payload: Payload | Promise<Payload>, bytes = payload instanceof Promise ? 0 : Buffer.byteLength(payload)): void {
    const subscription = peer.topics.get(topic);
    if (!subscription || peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount + peer.queuedBytes + bytes > BACKLOG) {
      this.metrics.slowClients++;
      peer.ws.terminate();
      return;
    }
    // Initial compression must complete before any subsequent frame reaches
    // this peer. Bound queued memory too, including the uncompressed input.
    if (peer.sending || payload instanceof Promise) {
      peer.queue.push({ topic, subscription, payload, bytes });
      peer.queuedBytes += bytes;
      if (!peer.sending) { peer.sending = true; void this.drain(peer); }
      return;
    }
    this.write(peer, payload);
  }

  private async drain(peer: Peer): Promise<void> {
    try {
      while (peer.queue.length && peer.ws.readyState === WebSocket.OPEN) {
        const next = peer.queue[0];
        const payload = await next.payload;
        if (peer.queue[0] !== next) continue;
        peer.queue.shift();
        peer.queuedBytes -= next.bytes;
        if (peer.ws.readyState !== WebSocket.OPEN) break;
        if (peer.ws.bufferedAmount + Buffer.byteLength(payload) > BACKLOG) {
          this.metrics.slowClients++;
          peer.ws.terminate();
          break;
        }
        this.write(peer, payload);
      }
    } catch { peer.ws.terminate(); }
    finally { peer.queue = []; peer.queuedBytes = 0; peer.sending = false; }
  }

  private write(peer: Peer, payload: Payload): void {
    this.metrics.sentBytes += Buffer.byteLength(payload);
    peer.ws.send(payload, { compress: false });
  }
}
