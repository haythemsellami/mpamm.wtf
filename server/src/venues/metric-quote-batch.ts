import { decodeAbiParameters, encodeDeployData, parseAbi, parseAbiParameters, type PublicClient } from 'viem';
import { METRIC_QUOTE_BYTECODE } from './metric-quote-bytecode.js';

export interface MetricBatchPool {
  pool: `0x${string}`;
  provider: `0x${string}`;
  legs: { zeroForOne: boolean; amount: bigint; limit: bigint }[];
}
const constructor = parseAbi(['constructor(address router, (address pool, address provider, (bool zeroForOne, int128 amount, uint128 limit)[] legs)[] pools)']);
const resultAbi = parseAbiParameters('(bool success, int128 amount0Delta, int128 amount1Delta)[]');

/** A creation-form eth_call returns the constructor's ABI-encoded results.
 * It never sends a transaction or changes chain state. */
export async function metricBatchQuote(client: PublicClient, router: `0x${string}`, pools: MetricBatchPool[], blockNumber: bigint) {
  const { data } = await client.call({
    data: encodeDeployData({ abi: constructor, bytecode: METRIC_QUOTE_BYTECODE, args: [router, pools] }),
    blockNumber,
  });
  if (!data) throw new Error('empty Metric helper result');
  const [results] = decodeAbiParameters(resultAbi, data);
  if (results.length !== pools.reduce((n, pool) => n + pool.legs.length, 0)) throw new Error('incomplete Metric helper result');
  return results.map((r) => r.success
    ? { status: 'success' as const, result: [r.amount0Delta, r.amount1Delta] as readonly [bigint, bigint] }
    : { status: 'failure' as const });
}
