import { MARKETS, SIZES_USD, type DepthSnapshot, type StreamMessage } from './index.js';

/** Versioned topics keep demand bounded by the registry, not arbitrary client input. */
export type QuoteScope = { market: string; sizeUsd: number; baseline: boolean };
export type StreamTopic =
  | ({ channel: 'quotes' } & QuoteScope)
  | { channel: 'depth'; market: string }
  | { channel: 'state' | 'fill' | 'volume' };
export type TopicMessage = StreamMessage | { ch: 'depth'; data: DepthSnapshot };
export interface StreamEnvelope {
  v: 2;
  epoch: string;
  topic: string;
  seq: number;
  snapshot?: boolean;
  message: TopicMessage;
}
export const STREAM_V2_GZIP = 'mpamm.v2.gzip';
export const STREAM_V2_JSON = 'mpamm.v2.json';
export const MAX_STREAM_TOPICS = 128;

export function topicKey(topic: StreamTopic): string {
  if (topic.channel === 'quotes') return `quotes:${topic.market}:${topic.sizeUsd}:${Number(topic.baseline)}`;
  if (topic.channel === 'depth') return `depth:${topic.market}`;
  return topic.channel;
}

export function parseTopics(input: unknown): StreamTopic[] | null {
  if (!Array.isArray(input) || input.length > MAX_STREAM_TOPICS) return null;
  const unique = new Map<string, StreamTopic>();
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    let topic: StreamTopic;
    if (item.channel === 'state' || item.channel === 'fill' || item.channel === 'volume') {
      topic = { channel: item.channel };
    } else if (item.channel === 'depth' || item.channel === 'quotes') {
      if (!(MARKETS as readonly unknown[]).includes(item.market)) return null;
      if (item.channel === 'depth') topic = { channel: 'depth', market: item.market };
      else {
        if (!(SIZES_USD as readonly unknown[]).includes(item.sizeUsd) || typeof item.baseline !== 'boolean') return null;
        topic = { channel: 'quotes', market: item.market, sizeUsd: item.sizeUsd, baseline: item.baseline };
      }
    } else return null;
    unique.set(topicKey(topic), topic);
  }
  return [...unique.values()].sort((a, b) => topicKey(a).localeCompare(topicKey(b)));
}
