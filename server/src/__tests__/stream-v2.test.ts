import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { BaseSource } from '../datasource/index.js';
import { SubscriptionGateway } from '../stream-v2.js';
import { SIZES_USD, STREAM_V2_GZIP, STREAM_V2_JSON, type MarketState, type QuoteSnapshot, type StreamEnvelope, type StreamTopic, type StreamMessage } from '@shared';

process.env.API_PORT = '0';
const row = { venueId: 'venue', market: 'MON/USDC', sizeUsd: 1000, bidBps: -1.23, askBps: 2.34, bidPx: .024123456789, askPx: .024132198765, spreadBps: 3.57, filledFull: true, feeBps: .2, ts: 100 };
class Source extends BaseSource {
  readonly mode = 'sim' as const;
  catalog: Record<string, string[]> = { venue: ['MON/USDC'] };
  async start() {} stop() {}
  getState(): MarketState { return { chainId: 143, block: 1, monUsd: .024, monChangePct: 0, takerBps: 1, markets: ['MON/USDC', 'BTC/USDC'], sizesUsd: [1000], quoteCadenceMs: 300, source: 'sim', venues: [
    { id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { dark: '#fff', light: '#000' } },
  ], quoteMarkets: this.catalog, notes: [{ ts: 0, level: 'info', code: 'source.sim', msg: 'private diagnostic' }] }; }
  getQuotes(): QuoteSnapshot { return { block: 1, monUsd: .024, ts: 100, frame: { headSource: 'sim', headObservedAt: 80, quoteStartedAt: 81, quoteCompletedAt: 99, emittedAt: 100, durationMs: 18, adapterMs: { venue: 17 }, missingVenues: [], coalescedBlocks: 0 }, rows: [row, { ...row, market: 'BTC/USDC' }, { ...row, sizeUsd: 100 }] }; }
  getFills() { return []; } getVolume() { return []; }
  push(message: StreamMessage) { this.emitMsg(message); }
}
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks(); });
const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5)); expect(predicate()).toBe(true); };

async function boot(source = new Source()) {
  const { startServer } = await import('../server.js');
  const server = startServer(source);
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { source, port: (server.address() as AddressInfo).port };
}
async function connect(port: number, topics: StreamTopic[], protocols: string | string[] = STREAM_V2_GZIP) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, protocols, { perMessageDeflate: false });
  const frames: StreamEnvelope[] = [];
  const binaries: number[] = [];
  ws.on('message', (data, binary) => {
    if (binary) binaries.push((data as Buffer).length);
    frames.push(JSON.parse((binary ? gunzipSync(data as Buffer) : data).toString()));
  });
  await once(ws, 'open');
  cleanup.push(() => { ws.terminate(); });
  ws.send(JSON.stringify({ type: 'subscribe', topics }));
  await waitFor(() => frames.length > 0);
  return { ws, frames, binaries };
}
function localPeer(gateway: SubscriptionGateway) {
  const frames: StreamEnvelope[] = [];
  const ws = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN as number, protocol: STREAM_V2_GZIP, bufferedAmount: 0,
    send: vi.fn((payload: string | Buffer) => frames.push(JSON.parse((typeof payload === 'string' ? payload : gunzipSync(payload)).toString()))),
    close: vi.fn(), terminate: vi.fn(() => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); }) });
  gateway.accept(ws as unknown as WebSocket);
  return { ws, frames, subscribe: (topics: StreamTopic[]) => ws.emit('message', JSON.stringify({ type: 'subscribe', topics })) };
}

describe('subscription transport', () => {
  it('sends the catalog once on subscription, then only when it changes', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { source, port } = await boot();
    const client = await connect(port, [{ channel: 'state' }], STREAM_V2_JSON);
    expect(client.frames[0].message.data).toHaveProperty('quoteMarkets', source.catalog);
    for (const block of [2, 3, 4]) {
      if (block === 3) source.catalog = { venue: ['MON/USDC', 'BTC/USDC'] };
      now += 1_001;
      source.push({ ch: 'state', data: { ...source.getState(), block } });
      await waitFor(() => client.frames.length === block);
    }
    expect(client.frames[1].message.data).not.toHaveProperty('quoteMarkets');
    expect(client.frames[2].message.data).toHaveProperty('quoteMarkets', source.catalog);
    expect(client.frames[3].message.data).not.toHaveProperty('quoteMarkets');
  });

  it('does not let a new subscriber hide a catalog update from existing subscribers', async () => {
    const { source, port } = await boot();
    const existing = await connect(port, [{ channel: 'state' }], STREAM_V2_JSON);
    source.catalog = { venue: ['BTC/USDC'] };
    const joining = await connect(port, [{ channel: 'state' }], STREAM_V2_JSON);
    expect(joining.frames[0].message.data).toHaveProperty('quoteMarkets', source.catalog);
    source.push({ ch: 'state', data: { ...source.getState(), block: 2 } });
    await waitFor(() => existing.frames.length === 2);
    expect(existing.frames[1].message.data).toHaveProperty('quoteMarkets', source.catalog);
  });

  it('preserves a catalog change when newer state replaces a pending compressed frame', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { source, port } = await boot();
    const client = await connect(port, [{ channel: 'state' }]);
    const initialBinaries = client.binaries.length;
    const largeCatalog = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`venue-${i}`, ['MON/USDC', 'BTC/USDC']]));
    for (const block of [2, 3, 4]) {
      source.catalog = block === 2 ? largeCatalog : { venue: ['BTC/USDC'] };
      now += 1_001;
      source.push({ ch: 'state', data: { ...source.getState(), block } });
    }
    await waitFor(() => client.frames.length === 3);
    expect(client.binaries).toHaveLength(initialBinaries + 1);
    expect(client.frames[1].message.data).toMatchObject({ block: 2, quoteMarkets: largeCatalog });
    expect(client.frames[2].message.data).toMatchObject({ block: 4, quoteMarkets: source.catalog });
    expect(client.frames.map((frame) => frame.seq)).toEqual([0, 1, 2]);
  });

  it.each([
    { offered: [STREAM_V2_GZIP], selected: STREAM_V2_GZIP },
    { offered: [STREAM_V2_JSON], selected: STREAM_V2_JSON },
    { offered: ['mpamm.future', STREAM_V2_JSON], selected: STREAM_V2_JSON },
    { offered: [STREAM_V2_JSON, STREAM_V2_GZIP], selected: STREAM_V2_GZIP },
  ])('negotiates $selected from $offered and delivers versioned frames', async ({ offered, selected }) => {
    const { source, port } = await boot();
    const client = await connect(port, [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false }], offered);
    expect(client.ws.protocol).toBe(selected);
    expect(client.frames[0]).toMatchObject({ v: 2, message: { ch: 'quotes', data: { rows: [row] } } });
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 2 } });
    await waitFor(() => client.frames.length === 2);
    expect(client.frames[1]).toMatchObject({ v: 2, seq: 1, message: { ch: 'quotes', data: { block: 2, rows: [row] } } });
    expect(client.binaries).toHaveLength(selected === STREAM_V2_GZIP ? 2 : 0);
  });

  it('does not negotiate unsupported protocols as legacy streams', async () => {
    const { port } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, 'mpamm.future');
    cleanup.push(() => ws.terminate());
    await expect(once(ws, 'open')).rejects.toThrow('Server sent no subprotocol');
  });

  it('filters before encoding, shares compression, and works without extension negotiation', async () => {
    const { source, port } = await boot();
    const topic = { channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false } as const;
    const a = await connect(port, [topic]);
    const b = await connect(port, [topic]);
    expect(a.binaries).toHaveLength(1);
    expect(b.binaries).toHaveLength(1);
    expect(a.frames[0]).toEqual(b.frames[0]);
    const before = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
    expect(before.stream.encodes).toBe(1);
    const historical = await connect(port, [{ channel: 'state' }]);
    const initialMetrics = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
    const initial = a.frames[0].message;
    expect(initial.ch).toBe('quotes');
    if (initial.ch === 'quotes') expect(initial.data.rows).toEqual([row]);
    expect(JSON.stringify(historical.frames)).not.toContain('private diagnostic');
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 2 } });
    await waitFor(() => a.frames.length === 2 && b.frames.length === 2);
    expect(a.frames[1]).toEqual(b.frames[1]);
    expect(a.frames[1].seq).toBe(1);
    expect(a.binaries.length).toBe(2);
    expect(historical.frames.every((f) => f.message.ch === 'state')).toBe(true);
    const metrics = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
    expect(metrics.stream.encodes - initialMetrics.stream.encodes).toBe(1);
    expect(metrics.stream.protocol).toBe('v2');
  });

  it('keeps a small live update behind its compressed initial snapshot', async () => {
    const source = new Source();
    const original = source.getQuotes.bind(source);
    vi.spyOn(source, 'getQuotes').mockImplementationOnce(() => {
      queueMicrotask(() => source.push({ ch: 'quotes', data: { block: 2, ts: 101, monUsd: .024, rows: [] } }));
      return original();
    });
    const { port } = await boot(source);
    const client = await connect(port, [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false }]);
    await waitFor(() => client.frames.length === 2);
    expect(client.binaries).toHaveLength(1);
    expect(client.frames[0]).toMatchObject({ snapshot: true, seq: 0, message: { ch: 'quotes', data: { block: 1, rows: [row] } } });
    expect(client.frames[1]).toMatchObject({ seq: 1, message: { ch: 'quotes', data: { block: 2, rows: [] } } });
    expect(client.frames[1]).not.toHaveProperty('snapshot');
  });

  it('bounds live frames queued behind initial compression and forces a resync', async () => {
    const source = new Source();
    const gateway = new SubscriptionGateway(source);
    const ws = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN as number, protocol: STREAM_V2_GZIP, bufferedAmount: 0,
      send: vi.fn(), close: vi.fn(), terminate: vi.fn(() => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); }) });
    gateway.accept(ws as unknown as WebSocket);
    cleanup.push(() => gateway.close());
    ws.emit('message', JSON.stringify({ type: 'subscribe', topics: [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false }] }));
    for (let block = 2; block < 2_000 && ws.readyState === WebSocket.OPEN; block++) {
      gateway.onMessage({ ch: 'quotes', data: { block, ts: 101, monUsd: .024, rows: [] } });
    }
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(gateway.metrics.slowClients).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ws.send).not.toHaveBeenCalled();
    expect(gateway.metrics.connections).toBe(0);
    expect(gateway.metrics.topics).toBe(0);
  });

  it('compresses state, quote and depth bootstraps once for identical subscribers', async () => {
    const source = new Source();
    source.catalog = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`venue-${i}`, ['MON/USDC', 'BTC/USDC']]));
    const depth = { market: 'MON/USDC', asOfBlock: 1, refMid: .024, ts: 100, venues: [{ venueId: 'venue', maxNotional: 100_000,
      points: Array.from({ length: 25 }, (_, i) => ({ notional: 10 * (i + 1), bidBps: i ? -i : 0, askBps: i })) }] };
    vi.spyOn(source, 'getDepth').mockReturnValue({ market: depth.market, asOfBlock: 1, ts: 100, json: JSON.stringify(depth) });
    const { port } = await boot(source);
    const topics: StreamTopic[] = [{ channel: 'state' }, { channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false }, { channel: 'depth', market: 'MON/USDC' }];
    const a = await connect(port, topics);
    const b = await connect(port, topics);
    await waitFor(() => a.frames.length === 3 && b.frames.length === 3);
    expect(a.binaries).toHaveLength(3);
    expect(b.binaries).toHaveLength(3);
    expect(a.frames).toEqual(b.frames);
    expect(a.frames.every((frame) => frame.snapshot && frame.seq === 0)).toBe(true);
    const state = a.frames.find((frame) => frame.message.ch === 'state')!.message.data;
    expect(state).toHaveProperty('venues');
    expect(state).not.toHaveProperty('notes');
    expect(a.frames.find((frame) => frame.message.ch === 'depth')!.message.data).toEqual(depth);
    const metrics = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
    expect(metrics.stream.encodes).toBe(3);
  });

  it('reads the baseline registry once per publication across quote topics', async () => {
    const { source, port } = await boot();
    const topics: StreamTopic[] = ['MON/USDC', 'BTC/USDC'].flatMap((market) => SIZES_USD.map((sizeUsd) => ({ channel: 'quotes' as const, market, sizeUsd, baseline: false })));
    const client = await connect(port, topics, STREAM_V2_JSON);
    await waitFor(() => client.frames.length === topics.length);
    const reads = vi.spyOn(source, 'getState');
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 2 } });
    await waitFor(() => client.frames.length === topics.length * 2);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('changes subscriptions without leaking rows from the previous market', async () => {
    const { source, port } = await boot();
    const c = await connect(port, [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false }]);
    c.ws.send(JSON.stringify({ type: 'subscribe', topics: [{ channel: 'quotes', market: 'BTC/USDC', sizeUsd: 1000, baseline: false }] }));
    await waitFor(() => c.frames.length === 2);
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 2 } });
    await waitFor(() => c.frames.length === 3);
    for (const frame of c.frames.slice(1)) {
      expect(frame.message.ch).toBe('quotes');
      if (frame.message.ch === 'quotes') expect(frame.message.data.rows.map((r) => r.market)).toEqual(['BTC/USDC']);
    }
  });

  it('discards removed snapshots and queued updates while preserving retained fill events', async () => {
    const gateway = new SubscriptionGateway(new Source());
    cleanup.push(() => gateway.close());
    const client = localPeer(gateway);
    const topic = (market: string): StreamTopic => ({ channel: 'quotes', market, sizeUsd: 1000, baseline: false });
    client.subscribe([topic('MON/USDC'), { channel: 'fill' }]);
    gateway.onMessage({ ch: 'quotes', data: { block: 2, ts: 101, monUsd: .024, rows: [] } });
    const fill = { id: 'retained-fill', venueId: 'venue', market: 'MON/USDC', side: 'buy' as const, category: 'UNKNOWN' as const,
      usd: 100, baseAmount: 1, execPx: 100, txHash: '0x123', to: '0x456', pool: 'pool', blockNumber: 2, ts: 101,
      markoutsBps: [null, null, null, null, null] as [null, null, null, null, null] };
    gateway.onMessage({ ch: 'fill', data: fill });
    client.subscribe([topic('BTC/USDC'), { channel: 'fill' }]);
    gateway.onMessage({ ch: 'quotes', data: { block: 3, ts: 102, monUsd: .024, rows: [] } });
    await waitFor(() => client.frames.length === 3);
    expect(client.frames[0]).toMatchObject({ seq: 1, message: { ch: 'fill', data: fill } });
    expect(client.frames.slice(1).map((frame) => frame.topic)).toEqual(['quotes:BTC/USDC:1000:0', 'quotes:BTC/USDC:1000:0']);
    expect(client.frames[1]).toMatchObject({ snapshot: true, seq: 0 });
    expect(client.frames[2]).toMatchObject({ seq: 1, message: { data: { block: 3 } } });
    expect(client.ws.terminate).not.toHaveBeenCalled();
  });

  it('releases abandoned snapshot backlog during rapid market switches', async () => {
    const source = new Source();
    const quote = source.getQuotes();
    quote.rows = Array.from({ length: 300 }, () => [row, { ...row, market: 'BTC/USDC' }]).flat();
    vi.spyOn(source, 'getQuotes').mockReturnValue(quote);
    const gateway = new SubscriptionGateway(source);
    cleanup.push(() => gateway.close());
    const client = localPeer(gateway);
    for (let i = 0; i < 10; i++) client.subscribe([{ channel: 'quotes', market: i % 2 ? 'BTC/USDC' : 'MON/USDC', sizeUsd: 1000, baseline: false }]);
    expect(client.ws.terminate).not.toHaveBeenCalled();
    await waitFor(() => client.frames.length === 1);
    expect(client.frames[0]).toMatchObject({ snapshot: true, message: { data: { rows: Array.from({ length: 300 }, () => ({ ...row, market: 'BTC/USDC' })) } } });
    expect(gateway.metrics.slowClients).toBe(0);
  });

  it('does not deliver an older compression job into a replacement subscription for the same topic', async () => {
    const source = new Source();
    let quote = source.getQuotes();
    vi.spyOn(source, 'getQuotes').mockImplementation(() => quote);
    const gateway = new SubscriptionGateway(source);
    cleanup.push(() => gateway.close());
    const observer = localPeer(gateway), client = localPeer(gateway);
    const topic = { channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false } as const;
    observer.subscribe([topic]); client.subscribe([topic]);
    await waitFor(() => observer.frames.length === 1 && client.frames.length === 1);
    quote = { ...quote, block: 2 };
    gateway.onMessage({ ch: 'quotes', data: quote });
    client.subscribe([]);
    quote = { ...quote, block: 3 };
    client.subscribe([topic]);
    await waitFor(() => observer.frames.length === 2 && client.frames.length === 2);
    quote = { ...quote, block: 4 };
    gateway.onMessage({ ch: 'quotes', data: quote });
    await waitFor(() => observer.frames.length === 3 && client.frames.length === 3);
    expect(client.frames.map((frame) => frame.message.ch === 'quotes' && frame.message.data.block)).toEqual([1, 3, 4]);
    expect(observer.frames.map((frame) => frame.message.ch === 'quotes' && frame.message.data.block)).toEqual([1, 2, 4]);
    expect(client.frames.map((frame) => frame.seq)).toEqual([0, 1, 2]);
  });

  it('rejects arbitrary sizes instead of creating unbounded RPC demand', async () => {
    const { port } = await boot();
    const c = await connect(port, [{ channel: 'state' }]);
    const closed = once(c.ws, 'close');
    c.ws.send(JSON.stringify({ type: 'subscribe', topics: [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 12345, baseline: false }] }));
    expect((await closed)[0]).toBe(1008);
  });

  it('keeps only the latest pending snapshot during a burst', async () => {
    const { source, port } = await boot();
    const c = await connect(port, [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false }]);
    for (const block of [2, 3, 4]) source.push({ ch: 'quotes', data: { ...source.getQuotes(), block } });
    await waitFor(() => c.frames.length === 3);
    expect(c.frames.slice(1).map((f) => f.message.ch === 'quotes' && f.message.data.block)).toEqual([2, 4]);
    expect(c.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
    expect(health.stream.coalesced).toBe(2);
  });

  it('serves immutable compressed aggregates and rejects missing revisions', async () => {
    const { port } = await boot();
    const base = `http://127.0.0.1:${port}`;
    const manifest = await fetch(`${base}/api/leaderboard/publication?days=1`).then((r) => r.json()) as { url: string };
    const unchanged = await fetch(`${base}/api/leaderboard/publication?days=1`).then((r) => r.json());
    expect(unchanged).toEqual(manifest);
    const response = await fetch(base + manifest.url);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(await response.json()).toMatchObject({ days: 1 });
    const etag = response.headers.get('etag')!;
    expect((await fetch(base + manifest.url, { headers: { 'If-None-Match': etag } })).status).toBe(304);
    const identity = await fetch(base + manifest.url, { headers: { 'Accept-Encoding': 'gzip;q=0, identity' } });
    expect(identity.headers.get('content-encoding')).toBeNull();
    const missing = await fetch(`${base}/api/analytics/${'0'.repeat(64)}.json`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });

  it('never computes or publishes cached aggregates before persisted history is ready', async () => {
    const source = new Source(); let ready = false;
    Object.assign(source, { isReady: () => ready });
    const leaderboard = vi.spyOn(source, 'leaderboard').mockImplementation(async (days) => ({
      days, generatedAt: 123, totalFills: ready ? 42 : 0, groups: { protocol: {}, pool: {}, to: {}, category: {} }, topSwaps: {}, outliers: [],
    }));
    const { port } = await boot(source);
    const base = `http://127.0.0.1:${port}`;
    for (const days of [1, 7, 30]) for (const path of ['/api/leaderboard', '/api/leaderboard/publication']) {
      const response = await fetch(`${base}${path}?days=${days}`);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
    }
    expect(leaderboard).not.toHaveBeenCalled();
    ready = true;
    for (const days of [1, 7, 30]) {
      const direct = await fetch(`${base}/api/leaderboard?days=${days}`).then((response) => response.json());
      expect(direct).toMatchObject({ days, totalFills: 42 });
      const manifest = await fetch(`${base}/api/leaderboard/publication?days=${days}`).then((response) => response.json()) as { url: string };
      expect(await fetch(base + manifest.url).then((response) => response.json())).toEqual(direct);
    }
  });
});

describe('legacy snapshot and idle history', () => {
  it('keeps partial deadline frames on v2 while withholding them from ready legacy sockets', async () => {
    const source = new Source(); let complete = true;
    Object.assign(source, { quoteSnapshotComplete: () => complete });
    const { port } = await boot(source);
    const v2 = await connect(port, [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false }], STREAM_V2_JSON);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    const quotes: QuoteSnapshot[] = [];
    ws.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.ch === 'quotes') quotes.push(m.data); });
    cleanup.push(() => ws.terminate());
    await once(ws, 'open'); await waitFor(() => quotes.length === 1);
    complete = false; source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 2, rows: [] } });
    await waitFor(() => v2.frames.length === 2);
    expect(quotes.map((q) => q.block)).toEqual([1]);
    complete = true; source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 3 } });
    await waitFor(() => quotes.length === 2);
    expect(quotes.map((q) => q.block)).toEqual([1, 3]);
  });

  it('withholds scoped frames until the first full snapshot, then streams subsequent quotes', async () => {
    let resolve!: (quotes: QuoteSnapshot) => void;
    const source = new Source();
    const pending = new Promise<QuoteSnapshot>((done) => { resolve = done; });
    Object.assign(source, { fullQuoteSnapshot: () => pending });
    const { port } = await boot(source);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    const frames: StreamMessage[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    cleanup.push(() => ws.terminate());
    await once(ws, 'open');
    expect(ws.protocol).toBe('');
    await waitFor(() => frames.length === 1);
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 2, rows: [row] } });
    source.push({ ch: 'state', data: source.getState() });
    await waitFor(() => frames.filter((frame) => frame.ch === 'state').length === 2);
    expect(frames.some((frame) => frame.ch === 'quotes')).toBe(false);
    const full = { ...source.getQuotes(), block: 3 };
    resolve(full);
    await waitFor(() => frames.some((frame) => frame.ch === 'quotes'));
    expect(frames.find((frame) => frame.ch === 'quotes')?.data).toEqual(full);
    source.push({ ch: 'quotes', data: { ...full, block: 4 } });
    await waitFor(() => frames.filter((frame) => frame.ch === 'quotes').length === 2);
    expect(frames.at(-1)?.data).toMatchObject({ block: 4 });
  });

  it('closes a legacy connection if a full snapshot cannot be produced', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<QuoteSnapshot>((_resolve, fail) => { reject = fail; });
    const source = new Source();
    Object.assign(source, { fullQuoteSnapshot: () => pending });
    const { port } = await boot(source);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    cleanup.push(() => ws.terminate());
    const closed = once(ws, 'close');
    await once(ws, 'open');
    reject(new Error('no fresh full frame'));
    await closed;
  });

  it('expires history by wall time even when no new quotes are emitted', () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const source = new Source();
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), ts: now, frame: undefined } });
    now += 59_999;
    expect(source.quoteHistory('MON/USDC', 1000)).toHaveLength(1);
    now++;
    expect(source.quoteHistory('MON/USDC', 1000)).toEqual([]);
  });
});

describe('execution history delivery', () => {
  it('retains unseen quotes through zero subscribers and serves the same aggregate to every viewer', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { source, port } = await boot();
    const push = (block: number) => { now += 300; source.push({ ch: 'quotes', data: { ...source.getQuotes(), block, ts: now, frame: undefined } }); };
    push(1); // collected before the first viewer arrived
    const topic = { channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false } as const;
    const a = await connect(port, [topic], STREAM_V2_JSON), b = await connect(port, [topic], STREAM_V2_JSON);
    push(2);
    await waitFor(() => a.frames.length === 2 && b.frames.length === 2);
    a.ws.send(JSON.stringify({ type: 'subscribe', topics: [{ channel: 'state' }] }));
    b.ws.close(); await once(b.ws, 'close');
    await waitFor(() => a.frames.some((f) => f.message.ch === 'state'));
    const delivered = a.frames.filter((f) => f.message.ch === 'quotes').length;
    for (const block of [3, 4, 5]) push(block);
    const api = `http://127.0.0.1:${port}/api/quotes`;
    const history = await fetch(`${api}/history?market=MON%2FUSDC&size=1000`).then((r) => r.json()) as QuoteSnapshot[];
    expect(history.map((q) => q.block)).toEqual([1, 2, 3, 4, 5]);
    expect(a.frames.filter((f) => f.message.ch === 'quotes')).toHaveLength(delivered);
    const statsUrl = `${api}/stats?market=MON%2FUSDC&size=1000`;
    const [first, second] = await Promise.all([fetch(statsUrl).then((r) => r.json()), fetch(statsUrl).then((r) => r.json())]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ market: 'MON/USDC', sizeUsd: 1000, windowMs: 300_000, rows: [{ venueId: 'venue', n: 5 }] });
    expect(JSON.stringify(first)).not.toContain('bidPx');
    a.ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
    await waitFor(() => a.frames.filter((f) => f.message.ch === 'quotes').length > delivered);
    push(6);
    await waitFor(() => a.frames.some((f) => f.message.ch === 'quotes' && f.message.data.block === 6));
    expect(a.frames.some((f) => 'stats' in f.message.data)).toBe(false);
  });

  it('validates the stats selection, returns empty cold windows, and does not open quote work', async () => {
    const { port } = await boot();
    const base = `http://127.0.0.1:${port}/api/quotes/stats`;
    for (const query of ['', '?market=unknown&size=1000', '?market=MON%2FUSDC&size=0', '?market=MON%2FUSDC&size=123', '?market=MON%2FUSDC&size=NaN']) {
      expect((await fetch(base + query)).status).toBe(400);
    }
    const response = await fetch(base + '?market=MON%2FUSDC&size=1000');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ rows: [], windowMs: 300_000 });
    const metrics = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
    expect(metrics.stream).toMatchObject({ connections: 0, topics: 0, encodes: 0 });
  });
});
