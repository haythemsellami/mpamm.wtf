import { createPublicClient, createTransport, defineChain, http, type PublicClient, type Transport } from 'viem';
import { config } from '../config.js';
import { ADDR, MONAD_CHAIN_ID } from '@shared';
import { RpcBreaker, type RpcNote, type RpcStatusView } from './failover.js';

export const monad = defineChain({
  id: MONAD_CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [config.rpcHttp], webSocket: [config.rpcWs] },
  },
  contracts: {
    multicall3: { address: ADDR.multicall3 as `0x${string}` },
  },
});

/** Ordered endpoints: primary first, then backups (deduped — with no
 *  RPC_HTTP_URL set the default backup IS the primary). Labels are the only
 *  thing that may ever surface publicly; URLs embed keys. */
const RPC_URLS = [config.rpcHttp, ...config.rpcBackups.filter((u) => u !== config.rpcHttp)];
const PUBLIC_RPC = 'https://rpc.monad.xyz';
const rpcLabel = (i: number) =>
  i === 0 ? 'primary' : `backup-${i}${RPC_URLS[i] === PUBLIC_RPC ? ' (public)' : ''}`;

const breaker = new RpcBreaker();

/** All endpoints share one failover breaker (chain/failover.ts): K consecutive
 *  transport failures advance to the next endpoint; a 60s probe snaps back to
 *  the primary once it recovers. Inner transports keep their own retry/backoff
 *  (so the breaker only sees post-retry failures); the outer transport must
 *  not retry again on top. */
const failoverTransport: Transport = ({ chain }) => {
  breaker.attach(RPC_URLS.map((url, i) => ({
    label: rpcLabel(i),
    request: http(url, {
      batch: { batchSize: 256, wait: 8 },
      retryCount: 2,
      timeout: 12_000,
    })({ chain }).request as (args: { method: string; params?: unknown }) => Promise<unknown>,
  })));
  return createTransport({
    key: 'failover',
    name: 'Failover HTTP',
    type: 'failover',
    retryCount: 0,
    request: (args) => breaker.request(args) as Promise<any>,
  });
};

/** HTTP public client. JSON-RPC batching is enabled so the quote poller's
 *  per-market reads collapse toward a single round-trip (docs/architecture.md: quote poller). */
export const publicClient: PublicClient = createPublicClient({
  chain: monad,
  transport: failoverTransport,
});

/** Failover status for /api/markets (labels only) + event sink for state.notes
 *  (each event carries its own note code — see failover.ts RpcNote). */
export const rpcStatus = (): RpcStatusView => breaker.status();
export const onRpcEvent = (cb: (n: RpcNote) => void): void => breaker.subscribe(cb);

/** Boot sanity check — verifies chain id 143 on EVERY endpoint (wrong-chain
 *  backups are dropped, wrong-chain primary is fatal) and pre-positions onto
 *  the first healthy endpoint when the primary is mid-outage. Boot proceeds if
 *  ANY endpoint serves (docs/architecture.md: operations). */
export async function probeChain(): Promise<{ ok: boolean; block: number; reason?: string }> {
  return breaker.verify(MONAD_CHAIN_ID);
}

/** Earliest block whose timestamp >= `targetSec`, by binary search over [0, hi]
 *  (~log2(hi) getBlock calls). Maps a backfill start date → a start block. A
 *  pruned/missing block just pushes the search higher. */
export async function blockAtOrAfter(targetSec: number, hi: bigint): Promise<bigint> {
  let lo = 0n, h = hi, ans = hi;
  // a single failed probe usually IS a pruned block (search higher), but a
  // string of failures is an RPC brownout — converging to `hi` then would hand
  // callers a head-anchored "start", which they make PERMANENT (backfill
  // done-flags, gas_from). Fail loud instead; every caller retries later.
  let failures = 0;
  while (lo <= h) {
    const mid = lo + (h - lo) / 2n;
    let ts: number | undefined;
    try { ts = Number((await publicClient.getBlock({ blockNumber: mid })).timestamp); }
    catch {
      if (++failures > 8) throw new Error(`blockAtOrAfter: ${failures} probe failures — RPC unhealthy, not converging to head`);
      lo = mid + 1n; continue;
    }
    if (ts >= targetSec) { ans = mid; h = mid - 1n; } else { lo = mid + 1n; }
  }
  return ans;
}

/** getLogs with automatic range-chunking — the public RPC 413s past ~100
 *  blocks (docs/architecture.md: operations). Returns logs across [from,to]. */
export async function getLogsChunked(
  params: { address: `0x${string}` | `0x${string}`[]; fromBlock: bigint; toBlock: bigint; events?: readonly unknown[] },
  chunk = BigInt(config.getLogsChunk),
): Promise<unknown[]> {
  const out: unknown[] = [];
  let start = params.fromBlock;
  while (start <= params.toBlock) {
    const end = start + chunk - 1n > params.toBlock ? params.toBlock : start + chunk - 1n;
    const logs = await publicClient.getLogs({
      address: params.address as any,
      fromBlock: start,
      toBlock: end,
      events: params.events as any,
    } as any);
    out.push(...logs);
    start = end + 1n;
  }
  return out;
}
