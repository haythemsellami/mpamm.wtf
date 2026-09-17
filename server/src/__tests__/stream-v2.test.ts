import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { BaseSource } from '../datasource/index.js';
import { STREAM_V2_GZIP, STREAM_V2_JSON, type MarketState, type QuoteSnapshot, type StreamEnvelope, type StreamTopic, type StreamMessage } from '@shared';

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
    const largeCatalog = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`venue-${i}`, ['MON/USDC', 'BTC/USDC']]));
    for (const block of [2, 3, 4]) {
      source.catalog = block === 2 ? largeCatalog : { venue: ['BTC/USDC'] };
      now += 1_001;
      source.push({ ch: 'state', data: { ...source.getState(), block } });
    }
    await waitFor(() => client.frames.length === 3);
    expect(client.binaries).toHaveLength(1);
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
    expect(client.binaries).toHaveLength(selected === STREAM_V2_GZIP ? 1 : 0);
  });

  it('does not negotiate unsupported protocols as legacy streams', async () => {
    const { port } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, 'mpamm.future');
    cleanup.push(() => ws.terminate());
    await expect(once(ws, 'open')).rejects.toThrow('Server sent no subprotocol');
  });

  it('filters before encoding, shares quote demand and compression, and works without extension negotiation', async () => {
    const { source, port } = await boot();
    const watch = vi.spyOn(source, 'watchQuotes');
    const topic = { channel: 'quotes', market: 'MON/USDC', sizeUsd: 1000, baseline: false } as const;
    const a = await connect(port, [topic]);
    const b = await connect(port, [topic]);
    const historical = await connect(port, [{ channel: 'state' }]);
    expect(watch).toHaveBeenCalledTimes(1);
    const initial = a.frames[0].message;
    expect(initial.ch).toBe('quotes');
    if (initial.ch === 'quotes') expect(initial.data.rows).toEqual([row]);
    expect(JSON.stringify(historical.frames)).not.toContain('private diagnostic');
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), block: 2 } });
    await waitFor(() => a.frames.length === 2 && b.frames.length === 2);
    expect(a.frames[1]).toEqual(b.frames[1]);
    expect(a.frames[1].seq).toBe(1);
    expect(a.binaries.length).toBe(1);
    expect(historical.frames.every((f) => f.message.ch === 'state')).toBe(true);
    const metrics = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
    expect(metrics.stream.encodes).toBe(1);
    expect(metrics.stream.protocol).toBe('v2');
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
});

describe('legacy snapshot and idle history', () => {
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
    source.push({ ch: 'quotes', data: { ...source.getQuotes(), ts: now } });
    now += 60_000;
    expect(source.quoteHistory('MON/USDC', 1000)).toHaveLength(1);
    now++;
    expect(source.quoteHistory('MON/USDC', 1000)).toEqual([]);
  });
});
