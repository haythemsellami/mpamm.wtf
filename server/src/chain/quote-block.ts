import { RpcReadUnavailableError } from './failover.js';
import type { HeadIdentity } from './heads.js';

export interface QuoteBlock extends HeadIdentity {
  number: bigint;
  hash: `0x${string}`;
  generation: number;
}

/** Pin all adapter state reads to one proposal, including multicalls and code
 * gates. A number alone can select a different proposal on a later RPC read. */
export function pinQuoteRequest(args: { method: string; params?: unknown }, block: QuoteBlock): typeof args {
  const index = args.method === 'eth_getStorageAt' ? 2
    : ['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount'].includes(args.method) ? 1 : -1;
  if (index < 0) return args;
  const params = Array.isArray(args.params) ? [...args.params] : [];
  const selected = params[index];
  if (typeof selected !== 'string' || !/^0x[\da-f]+$/i.test(selected) || BigInt(selected) !== block.number) {
    throw new RpcReadUnavailableError();
  }
  params[index] = { blockHash: block.hash, requireCanonical: false };
  return { ...args, params };
}
