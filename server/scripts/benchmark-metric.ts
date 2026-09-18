import { createPublicClient, http } from 'viem';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TOKENS } from '@shared';
import { config } from '../src/config.js';
import { monad } from '../src/chain/rpc.js';
import { ROUTER, SEED_POOLS, metricPoolAbi, priceProviderAbi, metricRouterAbi } from '../src/venues/metric.js';
import { metricBatchQuote, type MetricBatchPool } from '../src/venues/metric-quote-batch.js';

const output = process.argv[2] ?? '/tmp/mpamm-metric-benchmark.json';
const client = createPublicClient({ chain: monad, cacheTime: 0, transport: http(config.rpcHttp, { retryCount: 0, timeout: 10_000 }) });
const samples: { block: number; legacyMs: number; helperMs: number }[] = [];
let executableMatches = 0, zeroMatches = 0, failedMatches = 0;
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];

async function main() {
  const pools = await Promise.all(SEED_POOLS.map(async (pool) => {
    const im = await client.readContract({ address: pool, abi: metricPoolAbi, functionName: 'getImmutables' });
    const stable0 = Object.values(TOKENS).find((t) => t.stable && t.address.toLowerCase() === im[2].toLowerCase());
    const stable = stable0 ?? Object.values(TOKENS).find((t) => t.stable && t.address.toLowerCase() === im[3].toLowerCase());
    if (!stable) throw new Error('unregistered stable leg');
    const base = Object.values(TOKENS).find((t) => t.address.toLowerCase() === (stable0 ? im[3] : im[2]).toLowerCase());
    if (!base) throw new Error('unregistered base leg');
    const request: MetricBatchPool = { pool, provider: im[1], legs: [{ zeroForOne: !!stable0, amount: 100n * 10n ** BigInt(stable.decimals), limit: (1n << 128n) - 1n }, { zeroForOne: !stable0, amount: 10n ** BigInt(base.decimals), limit: 1n }] };
    return { request, baseDecimals: base.decimals, stableDecimals: stable.decimals, stable0: !!stable0 };
  }));
  let example: unknown;
  for (let i = 0; i < 13; i++) {
    const blockNumber = await client.getBlockNumber();
    const legacy = async () => {
      const prices = await client.multicall({ contracts: pools.map(({ request }) => ({ address: request.provider, abi: priceProviderAbi, functionName: 'getBidAndAskPrice' as const })), blockNumber, allowFailure: false });
      return client.multicall({ contracts: pools.flatMap(({ request }, index) => request.legs.map((leg) => ({ address: ROUTER, abi: metricRouterAbi, functionName: 'quoteSwap' as const,
        args: [request.pool, leg.zeroForOne, leg.amount, leg.limit, prices[index][0], prices[index][1]] as const }))), blockNumber, allowFailure: true });
    };
    let old: Awaited<ReturnType<typeof legacy>>, batch: Awaited<ReturnType<typeof metricBatchQuote>>;
    let legacyMs = 0, helperMs = 0;
    const oldRun = async () => { const start = performance.now(); old = await legacy(); legacyMs = performance.now() - start; };
    const newRun = async () => { const start = performance.now(); batch = await metricBatchQuote(client, ROUTER, pools.map((p) => p.request), blockNumber); helperMs = performance.now() - start; };
    if (i % 2) { await oldRun(); await newRun(); } else { await newRun(); await oldRun(); }
    for (let j = 0; j < pools.length * 2; j++) {
      if (old![j].status !== batch![j].status) throw new Error(`leg status mismatch at ${blockNumber}`);
      const before = old![j], after = batch![j];
      if (before.status === 'success' && after.status === 'success' && (before.result[0] !== after.result[0] || before.result[1] !== after.result[1])) throw new Error(`delta mismatch at ${blockNumber}`);
      if (i) { if (after.status !== 'success') failedMatches++; else if (after.result[0] && after.result[1]) executableMatches++; else zeroMatches++; }
    }
    if (i) samples.push({ block: Number(blockNumber), legacyMs, helperMs });
    const at = batch!.findIndex((r) => r.status === 'success' && r.result[0] !== 0n && r.result[1] !== 0n);
    const result = batch![at];
    if (result?.status === 'success') {
      const pool = pools[Math.floor(at / 2)];
      const { stable0, stableDecimals, baseDecimals } = pool;
      const abs = (n: bigint) => n < 0n ? -n : n;
      const usd = Number(abs(result.result[stable0 ? 0 : 1])) / 10 ** stableDecimals;
      const baseAmount = Number(abs(result.result[stable0 ? 1 : 0])) / 10 ** baseDecimals;
      example = { block: Number(blockNumber), ...pool, side: at % 2 ? 'sell' : 'buy', deltas: result.result, usd, baseAmount, execPx: usd / baseAmount };
    }
  }
  const report = { measuredAt: new Date().toISOString(), method: '12 alternating same-block trials after one warmup; 3 seed pools, $100 buy and 1 base-token sell each; no transactions',
    node: process.version, executableMatches, zeroMatches, failedMatches, exactMatches: samples.length * pools.length * 2, requestsPerFrame: { legacy: 2, helper: 1 },
    legacy: { p50Ms: percentile(samples.map((s) => s.legacyMs), .5), p95Ms: percentile(samples.map((s) => s.legacyMs), .95) },
    helper: { p50Ms: percentile(samples.map((s) => s.helperMs), .5), p95Ms: percentile(samples.map((s) => s.helperMs), .95) }, samples, example };
  if (!executableMatches) throw new Error('no executable quotes verified');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  console.log(JSON.stringify({ output, exactMatches: report.exactMatches, legacy: report.legacy, helper: report.helper }));
}
main().catch((error) => { console.error(`Metric verification failed: ${error instanceof Error ? error.name : 'unknown error'}`); process.exitCode = 1; });
