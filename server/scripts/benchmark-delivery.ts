import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { gunzipSync } from 'node:zlib';
import { BaseSource } from '../src/datasource/index.js';
import { MARKETS, SIZES_USD, STREAM_V2_GZIP, type QuoteSnapshot, type MarketState } from '@shared';

process.env.API_PORT = '0';
const { startServer } = await import('../src/server.js');
const { venueMeta } = await import('../src/venues/registry.js');
const fixture: QuoteSnapshot = JSON.parse(readFileSync(new URL('./fixtures/quote-matrix.json', import.meta.url), 'utf8'));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Source extends BaseSource {
  readonly mode = 'sim' as const;
  quotes = fixture;
  async start() {} stop() {}
  getState(): MarketState { return { chainId: 143, block: this.quotes.block, monUsd: fixture.monUsd, monChangePct: 0, takerBps: 4.5, markets: [...MARKETS], sizesUsd: [...SIZES_USD], quoteCadenceMs: 300, source: 'sim', venues: venueMeta() }; }
  getQuotes() { return this.quotes; } getFills() { return []; } getVolume() { return []; }
  tick(index: number) {
    const now = Date.now();
    this.quotes = { ...fixture, block: fixture.block + index, ts: now, rows: fixture.rows.map((r) => ({ ...r, ts: now })), frame: fixture.frame && { ...fixture.frame, emittedAt: now } };
    this.emitMsg({ ch: 'quotes', data: this.quotes });
  }
}

async function sample(viewers: number, mode: 'legacy-raw' | 'legacy-deflate' | 'v2-shared-gzip') {
  const source = new Source();
  const server = startServer(source); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const clients: WebSocket[] = [];
  const received: number[] = [], latency: number[] = [];
  for (let i = 0; i < viewers; i++) {
    const v2 = mode === 'v2-shared-gzip';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, v2 ? STREAM_V2_GZIP : [], { perMessageDeflate: mode === 'legacy-deflate' });
    received[i] = 0;
    ws.on('message', (raw, binary) => {
      const parsed = JSON.parse((binary ? gunzipSync(raw as Buffer) : raw).toString());
      const message = v2 ? parsed.message : parsed;
      if (message?.ch === 'quotes' && message.data.block > fixture.block) { received[i]++; latency.push(Date.now() - message.data.ts); }
    });
    await once(ws, 'open');
    if (v2) ws.send(JSON.stringify({ type: 'subscribe', topics: [{ channel: 'quotes', market: 'MON/USDC', sizeUsd: 10000, baseline: false }] }));
    clients.push(ws);
  }
  await pause(100);
  const bytes = () => clients.reduce((total, ws) => total + (ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead, 0);
  const before = bytes(), cpu = process.cpuUsage();
  let rssPeak = process.memoryUsage().rss;
  const memory = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 50);
  const start = performance.now();
  const frames = 20;
  for (let i = 1; i <= frames; i++) { source.tick(i); await pause(300); }
  await pause(100);
  const elapsedMs = performance.now() - start;
  clearInterval(memory);
  const wireBytes = bytes() - before;
  const usage = process.cpuUsage(cpu);
  latency.sort((a, b) => a - b);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as any;
  const report = { viewers, mode, frames, elapsedMs, wireBytes, perViewerKBps: wireBytes / viewers / (elapsedMs / 1000) / 1000,
    totalCpuMs: (usage.user + usage.system) / 1000, processRssPeakMB: rssPeak / 1024 ** 2,
    receiptP95Ms: latency[Math.floor((latency.length - 1) * .95)], receivedMin: Math.min(...received),
    sharedCompressionJobs: health.stream.encodes };
  for (const ws of clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (report.receivedMin !== frames) throw new Error(`lost frames in ${mode}`);
  return report;
}

const results = [];
for (const viewers of [10, 100]) for (const mode of ['legacy-raw', 'legacy-deflate', 'v2-shared-gzip'] as const) {
  const result = await sample(viewers, mode); results.push(result); console.log(JSON.stringify(result));
}
const output = process.argv[2] ?? '/tmp/mpamm-v2-delivery.json';
writeFileSync(output, JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: `${platform()} ${arch()}`, cpu: cpus()[0].model,
  methodology: '20 recorded-matrix quote frames at 300ms; 10/100 loopback clients in the same process. CPU/RSS include clients and decoding; excludes depth, REST, TLS and remote latency. V2 selects MON/USDC $10k, legacy receives full matrix. Bootstrap excluded.', results }, null, 2) + '\n');
