// The stream protocol's cost per connected tab. A Render bandwidth audit
// (2026-09) measured 228KB/s to every open dashboard — 20GB/day, ~$3/day each —
// from two causes this file locks down:
//
//   1. the `state` frame carried the immutable venue registry AND the
//      maintainer-only `notes` buffer (~11KB of ~12KB) and was re-broadcast on
//      every head advance plus every quote, ~6/s;
//   2. nothing compressed the socket — Render's edge brotli's the REST routes
//      but a WebSocket upgrade is opaque to it, and `ws` ships permessage-
//      deflate off by default.
//
// Both are invisible in normal use (the dashboard renders identically either
// way), so only a test keeps them from regressing.
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { MarketState, StateNote, StreamMessage, VenueMeta } from '@shared';
import type { DataSource } from '../datasource/index.js';

// port 0 ⇒ the OS picks a free one, so this never collides with a dev server.
// Set before the first import of ../server.js, which pulls in config at eval.
process.env.API_PORT = '0';

const VENUES: VenueMeta[] = [
  { id: 'poe', name: 'LFJ POE', color: { light: '#111', dark: '#eee' }, kind: 'amm', role: 'venue' },
  { id: 'clober', name: 'Clober', color: { light: '#222', dark: '#ddd' }, kind: 'clob', role: 'venue' },
  { id: 'bybit', name: 'Bybit', color: { light: '#333', dark: '#ccc' }, kind: 'cex', role: 'reference', taker: true },
];

// NOTES_MAX notes at the sanitizer's length cap — the worst case the buffer can
// actually reach, which is what used to ride every frame.
const NOTES: StateNote[] = Array.from({ length: 60 }, (_, i) => ({
  ts: 1_700_000_000_000 + i,
  level: 'warn' as const,
  code: 'quote.head.fallback' as StateNote['code'],
  venue: 'poe',
  msg: 'x'.repeat(297) + '…',
}));

const STATE: MarketState = {
  chainId: 143, block: 12_345, monUsd: 0.0262, monChangePct: -1.2, takerBps: 2,
  markets: ['MON/USDC'], sizesUsd: [100, 1000], quoteCadenceMs: 300, source: 'live',
  venues: VENUES,
  notes: NOTES,
  realtime: {
    headBlock: 12_345, quoteBlock: 12_344, lagBlocks: 1, frameMs: 210,
    headToFrameMs: 190, eventLoopLagMs: 3, coveragePct60s: 99.2, coalescedBlocks60s: 4,
    headSource: 'ws', wsStatus: 'connected',
  },
};

/** The transport only ever touches these; the rest of DataSource is inert here. */
function stubSource(): DataSource & EventEmitter {
  const source = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(source, {
    mode: 'sim',
    start: async () => {}, stop: () => {},
    getState: () => STATE,
    getQuotes: () => ({ block: 12_345, monUsd: 0.0262, ts: 1, rows: [] }),
    getFills: () => [], getVolume: () => [], queryFills: () => [],
    leaderboard: async () => ({}), quoteHistory: () => [], gasSeries: () => ({}),
    getDepth: () => undefined, watchDepth: () => () => {},
  });
  return source as unknown as DataSource & EventEmitter;
}

const running: Array<() => void> = [];
afterEach(() => { for (const stop of running.splice(0)) stop(); });

async function boot() {
  const { startServer } = await import('../server.js');
  const source = stubSource();
  const server = startServer(source);
  await once(server, 'listening');
  running.push(() => server.close());
  return { source, port: (server.address() as AddressInfo).port };
}

/** Collect frames until `want` state frames have arrived (hello counts as one). */
async function collect(port: number, want: number, drive: () => void) {
  const client = new WebSocket(`ws://127.0.0.1:${port}/stream`, { perMessageDeflate: true });
  const frames: Array<{ msg: StreamMessage; bytes: number }> = [];
  let extensions = '';
  client.on('upgrade', (res) => { extensions = res.headers['sec-websocket-extensions'] ?? ''; });
  const done = new Promise<void>((resolve) => {
    client.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as StreamMessage;
      frames.push({ msg, bytes: data.length });
      if (frames.filter((f) => f.msg.ch === 'state').length >= want) resolve();
    });
  });
  await once(client, 'open');
  drive();
  await done;
  client.close();
  return { frames, extensions };
}

describe('WS state frames', () => {
  it('sends the venue registry once (hello) and never again', async () => {
    const { source, port } = await boot();
    const { frames } = await collect(port, 2, () => source.emit('message', { ch: 'state', data: STATE }));
    const states = frames.filter((f) => f.msg.ch === 'state').map((f) => f.msg.data as MarketState);

    expect(states[0].venues).toEqual(VENUES); // hello — the client needs it to render
    expect(states[1].venues).toBeUndefined(); // every tick after — it cannot have changed
  });

  it('never puts the maintainer notes buffer on the stream', async () => {
    const { source, port } = await boot();
    const { frames } = await collect(port, 2, () => source.emit('message', { ch: 'state', data: STATE }));

    for (const { msg } of frames) {
      expect((msg.data as MarketState).notes).toBeUndefined();
    }
    // …and not merely absent from the parsed object: no note text on the wire.
    expect(frames.some((f) => JSON.stringify(f.msg).includes('xxxx'))).toBe(false);
  });

  it('keeps every field the dashboard actually renders', async () => {
    const { source, port } = await boot();
    const { frames } = await collect(port, 2, () => source.emit('message', { ch: 'state', data: STATE }));
    const tick = frames.filter((f) => f.msg.ch === 'state')[1].msg.data as MarketState;

    // the lean frame is a diet, not a different message: everything the UI
    // reads off state must survive it.
    expect(tick).toMatchObject({
      chainId: 143, block: 12_345, monUsd: 0.0262, monChangePct: -1.2, takerBps: 2,
      markets: ['MON/USDC'], sizesUsd: [100, 1000], quoteCadenceMs: 300, source: 'live',
    });
    expect(tick.realtime?.lagBlocks).toBe(1); // freshness/health chips
  });

  it('costs an order of magnitude less than the frame it replaced', async () => {
    const { source, port } = await boot();
    const { frames } = await collect(port, 2, () => source.emit('message', { ch: 'state', data: STATE }));
    const tick = frames.filter((f) => f.msg.ch === 'state')[1];
    const before = Buffer.byteLength(JSON.stringify({ ch: 'state', data: STATE }));

    expect(before).toBeGreaterThan(18_000);       // what prod used to ship ~6x/s
    expect(tick.bytes).toBeLessThan(before / 10);
  });
});

describe('WS compression', () => {
  it('negotiates permessage-deflate with no context takeover', async () => {
    const { source, port } = await boot();
    const { extensions } = await collect(port, 1, () => source.emit('message', { ch: 'state', data: STATE }));

    expect(extensions).toContain('permessage-deflate');
    // Both directions must be no-context-takeover or zlib retains a ~300KB
    // window PER CONNECTION between messages — the shape of the 2026-07 OOM.
    expect(extensions).toContain('server_no_context_takeover');
    expect(extensions).toContain('client_no_context_takeover');
  });

  it('compresses a quote frame on the wire', async () => {
    const { PERMESSAGE_DEFLATE } = await import('../server.js');
    const { source, port } = await boot();
    // a realistic matrix: 175 rows is what prod ships (~47KB of JSON).
    const rows = Array.from({ length: 175 }, (_, i) => ({
      venueId: VENUES[i % VENUES.length].id, market: 'MON/USDC', sizeUsd: 100,
      bidBps: -80.31 + i, askBps: 25.47 + i, bidPx: 0.0262, askPx: 0.0265,
      spreadBps: 105.78, filledFull: true, feeBps: 23.97, ts: 1_788_327_311_464 + i,
    }));
    const quotes = { block: 12_345, monUsd: 0.0262, ts: 1, rows };
    const raw = Buffer.byteLength(JSON.stringify({ ch: 'quotes', data: quotes }));

    const client = new WebSocket(`ws://127.0.0.1:${port}/stream`, { perMessageDeflate: true });
    await once(client, 'open');
    let wire = 0;
    // ws hands us decompressed payloads, so count the compressed bytes at the
    // socket instead — that is what Render actually bills.
    client.on('message', () => {});
    const socket = (client as unknown as { _socket: { bytesRead: number } })._socket;
    const before = socket.bytesRead;
    const seen = new Promise<void>((resolve) => {
      client.on('message', (d: Buffer) => {
        if (JSON.parse(d.toString()).ch === 'quotes') { wire = socket.bytesRead - before; resolve(); }
      });
    });
    source.emit('message', { ch: 'quotes', data: quotes });
    await seen;
    client.close();

    expect(raw).toBeGreaterThan(PERMESSAGE_DEFLATE.threshold);
    expect(wire).toBeGreaterThan(0);
    expect(wire).toBeLessThan(raw / 4); // measured ~6x on prod payloads
  });
});
