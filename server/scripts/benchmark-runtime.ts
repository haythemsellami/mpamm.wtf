import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { http } from 'viem';
import { VolumeStore } from '../src/db.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SimDataSource } from '../src/datasource/sim.js';
import type { Fill } from '@shared';

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'mpamm-runtime-benchmark-'));
const path = join(dir, 'history.db');
const store = new VolumeStore(path);
const now = 1_800_000_000_000;
const count = Number(process.env.BENCHMARK_FILLS ?? 100_000);
if (!Number.isSafeInteger(count) || count < 1000 || count % 1000) throw new Error('BENCHMARK_FILLS must be a positive multiple of 1000');
for (let start = 0; start < count; start += 1000) store.upsertFills(Array.from({ length: 1000 }, (_, offset): Fill => {
  const i = start + offset;
  return { id: `fill-${String(i).padStart(8, '0')}`, ts: now - i * 1000, venueId: `venue-${i % 7}`, market: 'MON/USDC',
    side: i % 2 ? 'buy' : 'sell', category: i % 3 ? 'DIRECT' : 'AGG', usd: 100 + (i % 1000), baseAmount: 1000, execPx: .1,
    blockNumber: i, txHash: '0x1', to: `router-${i % 18}`, pool: `pool-${i % 20}`, markoutsBps: [0, 1, 2, 3, 4].map((h) => ((i * 13 + h) % 101) - 50) };
}));
store.close();
const child = (mode: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--expose-gc', fileURLToPath(new URL('./benchmark-analytics.ts', import.meta.url)), path, mode], { encoding: 'utf8' }));
const direct = child('direct'), isolated = child('worker');
if (direct.hash !== isolated.hash) throw new Error('aggregate mismatch');
const { hash: _, ...directMetrics } = direct;
const { hash: __, ...workerMetrics } = isolated;
rmSync(dir, { recursive: true, force: true });

const source = new SimDataSource();
const quoteTimes: number[] = []; let quoteRows = 0;
for (let i = 0; i < 1100; i++) {
  const at = performance.now(); quoteRows = source.getQuotes().rows.length;
  if (i >= 100) quoteTimes.push(performance.now() - at);
}
const quoteCases = [{ mode: 'continuous', rows: quoteRows, p50Ms: percentile(quoteTimes, .5), p95Ms: percentile(quoteTimes, .95) }];

let requests = 0;
const rpc = createServer(async (req, res) => {
  requests++;
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const parsed = JSON.parse(Buffer.concat(chunks).toString());
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const results = await Promise.all(calls.map(async (call) => { await pause(call.params[0].data === '0x02' ? 80 : 5); return { jsonrpc: '2.0', id: call.id, result: '0x1' }; }));
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
});
rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
const batches: unknown[] = [];
for (const mode of ['shared-8ms', 'shared-0ms', 'per-adapter-0ms', 'no-http-batch'] as const) {
  const fast: number[] = [], slow: number[] = []; const before = requests;
  for (let i = 0; i < 21; i++) {
    const transport = (key: string) => http(`${url}#${mode === 'per-adapter-0ms' ? key : mode}`, { retryCount: 0, batch: mode === 'no-http-batch' ? false : { batchSize: 8, wait: mode === 'shared-8ms' ? 8 : 0 } })({}).request;
    const f = transport('fast'), s = transport('slow'); const at = performance.now();
    await Promise.all([f({ method: 'eth_call', params: [{ data: '0x01' }, 'latest'] }).then(() => { if (i) fast.push(performance.now() - at); }), s({ method: 'eth_call', params: [{ data: '0x02' }, 'latest'] }).then(() => { if (i) slow.push(performance.now() - at); })]);
  }
  batches.push({ mode, trials: 20, fastP50Ms: percentile(fast, .5), fastP95Ms: percentile(fast, .95), slowP50Ms: percentile(slow, .5), httpRequestsIncludingWarmup: requests - before });
}
await new Promise<void>((resolve) => rpc.close(() => resolve()));
const report = { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
  analytics: { count, exactResults: true, workerHeapMb: Number(process.env.ANALYTICS_WORKER_HEAP_MB ?? 128), method: 'Deterministic persisted fills, warmed; original 25k-page scan on main vs 25k-page consistent read-only worker. Fresh child per scenario, fixture construction excluded; one warmup, parent GC before measurement. CPU/RSS include worker, RSS is not a production sizing estimate; 5ms loop probe.', direct: directMetrics, worker: workerMetrics },
  quoteCollection: { method: 'Continuous full-matrix simulator arithmetic; 100 warmups + 1000 samples, independent of viewers. Does not measure live RPC latency.', results: quoteCases },
  rpcBatching: { method: 'Loopback JSON-RPC server returns batch after all members; 5ms fast call and 80ms slow call; 1 warmup + 20 trials.', results: batches } };
writeFileSync(process.argv[2] ?? '/tmp/mpamm-v2-runtime.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
