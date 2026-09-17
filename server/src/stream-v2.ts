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
type Peer = { ws: WebSocket; topics: Set<string> };
type Group = {
  topic: StreamTopic; peers: Set<Peer>; seq: number; stop?: () => void;
  encoding: boolean; pending?: TopicMessage; lastJson?: string; lastCatalog?: string; lastAt: number;
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
    const peer: Peer = { ws, topics: new Set() };
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
    for (const key of peer.topics) {
      if (wanted.has(key)) continue;
      const group = this.groups.get(key);
      group?.peers.delete(peer);
      if (group && !group.peers.size) { group.stop?.(); this.groups.delete(key); }
    }
    for (const topic of topics) {
      const key = topicKey(topic);
      if (peer.topics.has(key)) continue;
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
      if (initial) this.send(peer, JSON.stringify(this.envelope(group, initial, true)));
    }
    peer.topics = wanted;
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

  private select(topic: StreamTopic, message: StreamMessage): TopicMessage | undefined {
    if (message.ch !== topic.channel) return;
    if (message.ch === 'quotes' && topic.channel === 'quotes') {
      const baselines = new Set(this.source.getState().venues.filter((v) => v.role === 'baseline').map((v) => v.id));
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
    for (const group of this.groups.values()) {
      if (group.topic.channel === 'state' && Date.now() - group.lastAt < 1_000) continue;
      const selected = this.select(group.topic, message);
      if (!selected) continue;
      if (selected.ch === 'state') {
        const catalog = JSON.stringify(selected.data.quoteMarkets);
        if (catalog === group.lastCatalog) delete selected.data.quoteMarkets;
        else group.lastCatalog = catalog;
      }
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

  private publish(group: Group, message: TopicMessage): void {
    if (!group.peers.size) return;
    if (group.encoding) { group.pending = message; this.metrics.coalesced++; return; }
    group.lastAt = Date.now();
    group.seq++;
    this.sequences.set(topicKey(group.topic), group.seq);
    const json = JSON.stringify(this.envelope(group, message));
    this.metrics.rawBytes += Buffer.byteLength(json);
    // Small events avoid zlib entirely, keeping fill ordering independent of
    // compression. Each snapshot topic permits only one queued replacement.
    const compress = message.ch !== 'fill' && json.length >= 512
      && [...group.peers].some((peer) => peer.ws.protocol === STREAM_V2_GZIP);
    if (!compress) { for (const peer of group.peers) this.send(peer, json); return; }
    group.encoding = true;
    this.metrics.encodes++;
    void zip(json, { level: 3 }).then((buffer) => {
      this.metrics.encodedBytes += buffer.length;
      for (const peer of group.peers) this.send(peer, peer.ws.protocol === STREAM_V2_GZIP ? buffer : json);
    }).catch(() => {
      for (const peer of group.peers) this.send(peer, json);
    }).finally(() => {
      group.encoding = false;
      const next = group.pending;
      group.pending = undefined;
      if (next) this.publish(group, next);
    });
  }

  private send(peer: Peer, payload: string | Buffer): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > BACKLOG) {
      this.metrics.slowClients++;
      peer.ws.terminate();
      return;
    }
    this.metrics.sentBytes += Buffer.byteLength(payload);
    peer.ws.send(payload, { compress: false });
  }
}
