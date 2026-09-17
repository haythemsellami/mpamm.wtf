import { WebSocket } from 'ws';
import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { STREAM_V2_GZIP, type QuoteSnapshot, type StreamEnvelope } from '@shared';

const socket = new WebSocket(process.argv[2] ?? 'ws://127.0.0.1:8894/stream', STREAM_V2_GZIP, { perMessageDeflate: false });
const frames: QuoteSnapshot[] = [];
let bytes = 0;
socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', topics: [
  { channel: 'state' }, { channel: 'quotes', market: 'BTC/USDC', sizeUsd: 1000, baseline: false },
] })));
socket.on('message', (raw, binary) => {
  bytes += (raw as Buffer).length;
  const envelope = JSON.parse((binary ? gunzipSync(raw as Buffer) : raw).toString()) as StreamEnvelope;
  if (envelope.message.ch === 'quotes' && !envelope.snapshot) frames.push(envelope.message.data);
});
socket.on('error', () => { console.error('stream unavailable'); process.exitCode = 1; });
setTimeout(() => {
  socket.close();
  if (!frames.length) { console.error('no quote frames observed'); process.exitCode = 1; return; }
  const durations = frames.map((f) => f.frame!.durationMs).sort((a, b) => a - b);
  const blocks = frames.at(-1)!.block - frames[0].block + 1;
  const report = { measuredAt: new Date().toISOString(), node: process.version, sampleSeconds: 20, frames: frames.length,
    blocks, coveragePct: new Set(frames.map((f) => f.block)).size / blocks * 100, bytes,
    medianDurationMs: durations[Math.floor(durations.length / 2)], maxDurationMs: durations.at(-1),
    metricFrames: frames.filter((f) => f.rows.some((r) => r.venueId === 'metric' && r.bidPx > 0 && r.askPx > 0)).length,
    samples: frames.map((f) => ({ block: f.block, frame: f.frame, rows: f.rows.map((r) => ({ venue: r.venueId, market: r.market, size: r.sizeUsd, bid: r.bidPx, ask: r.askPx })) })) };
  writeFileSync(process.argv[3] ?? '/tmp/mpamm-v2-live-stream.json', JSON.stringify(report, null, 2) + '\n');
  const { samples: _, ...summary } = report; console.log(JSON.stringify(summary));
}, 20_000);
