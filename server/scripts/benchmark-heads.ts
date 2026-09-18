import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import type { AddressInfo } from 'node:net';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const batches: string[][] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const calls = Array.isArray(body) ? body : [body];
  batches.push(calls.map((call) => call.method));
  const responses = await Promise.all(calls.map(async (call) => {
    await pause(call.method === 'eth_getLogs' ? 80 : 5);
    return { jsonrpc: '2.0', id: call.id, result: call.method === 'eth_getLogs' ? [] : call.method === 'eth_chainId' ? '0x8f' : '0x7b' };
  }));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
process.env.RPC_HTTP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.RPC_HTTP_BACKUP_URLS = '';
process.env.RPC_ARCHIVE_URL = '';
const { publicClient, headClient, probeChain } = await import('../src/chain/rpc.js');
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];

try {
  if (!(await probeChain()).ok) throw new Error('loopback RPC probe failed');
  const results = [];
  for (const mode of ['shared-tail-head', 'isolated-tail-head'] as const) {
    const client = mode === 'shared-tail-head' ? publicClient : headClient;
    const samples: Array<{ headMs: number; logsMs: number }> = [];
    const before = batches.length;
    for (let trial = 0; trial < 21; trial++) {
      const started = performance.now();
      let headMs = 0, logsMs = 0;
      await Promise.all([
        publicClient.getLogs({ fromBlock: 1n, toBlock: 1n }).then((logs) => {
          if (logs.length) throw new Error('unexpected loopback log');
          logsMs = performance.now() - started;
        }),
        client.getBlockNumber().then((head) => {
          if (head !== 123n) throw new Error('head result mismatch');
          headMs = performance.now() - started;
        }),
      ]);
      if (trial) samples.push({ headMs, logsMs });
    }
    const requests = batches.slice(before);
    const mixedBatches = requests.filter((methods) => methods.includes('eth_getLogs') && methods.includes('eth_blockNumber')).length;
    if (mode === 'isolated-tail-head' && mixedBatches) throw new Error('head joined the log batch');
    results.push({ mode, trials: samples.length, headP50Ms: percentile(samples.map((s) => s.headMs), .5),
      headP95Ms: percentile(samples.map((s) => s.headMs), .95), logsP50Ms: percentile(samples.map((s) => s.logsMs), .5),
      httpRequestsIncludingWarmup: requests.length, mixedBatchesIncludingWarmup: mixedBatches, samples });
  }
  const report = { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
    method: 'Actual exported publicClient and headClient against a loopback JSON-RPC provider: concurrent 80ms log read and 5ms head read, batches respond only after all members finish. One warmup and twenty trials per mode. Read-only; no live provider, database, browser or socket fanout.', results };
  writeFileSync(process.argv[2] ?? '/tmp/mpamm-heads.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
