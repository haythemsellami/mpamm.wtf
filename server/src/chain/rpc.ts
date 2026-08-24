import { createPublicClient, createTransport, defineChain, http, type PublicClient, type Transport } from 'viem';
import { config } from '../config.js';
import { ADDR, MONAD_CHAIN_ID } from '@shared';
import { RpcBreaker, type RpcNote, type RpcStatusView, type RpcVerifyResult } from './failover.js';

export const monad = defineChain({
  id: MONAD_CHAIN_ID,
  name: 'Monad',
  // Monad's official block time. Viem derives its polling interval from this;
  // without it, a custom chain falls back to 12s blocks and caches
  // eth_blockNumber for 4s. Every "N blocks ≈ T" comment in the indexer is
  // derived from this number — if it ever changes, grep for the derivations
  // (finality margins, the backfill hole-skip stride) rather than editing here
  // alone.
  blockTime: 300,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [config.rpcHttp] },
  },
  contracts: {
    multicall3: { address: ADDR.multicall3 as `0x${string}` },
  },
});

/** The public endpoint, called out in labels so a note reader can tell a paid
 *  node from the free fallback. Labels are the only thing that may ever surface
 *  publicly; URLs embed keys. */
const PUBLIC_RPC = 'https://rpc.monad.xyz';

/** One ordered endpoint list behind one breaker behind one viem client.
 *  `pool` names the pool in every note it raises (chain/failover.ts). */
interface RpcPool {
  client: PublicClient;
  status: () => RpcStatusView;
  onEvent: (cb: (n: RpcNote) => void) => void;
  verify: () => Promise<RpcVerifyResult>;
}

/**
 * Build a failover pool: K consecutive transport failures advance to the next
 * endpoint; a 60s probe snaps back to the primary once it recovers. Inner
 * transports keep their own retry/backoff (so the breaker only sees post-retry
 * failures); the outer transport must not retry again on top.
 */
function createPool(primary: string, backups: readonly string[], pool: string, label: (i: number) => string): RpcPool {
  // deduped — with no primary configured the default backup IS the primary.
  const urls = [primary, ...backups.filter((u) => u !== primary)];
  const breaker = new RpcBreaker({ pool });
  const transport: Transport = ({ chain }) => {
    breaker.attach(urls.map((url, i) => ({
      label: `${label(i)}${url === PUBLIC_RPC && i > 0 ? ' (public)' : ''}`,
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
  const client = createPublicClient({
    chain: monad,
    // Quote and fill-tail loops need the actual head on every pass. A cached
    // head makes the UI jump blocks and adds the cache window to fill latency.
    cacheTime: 0,
    transport,
  });
  return {
    client,
    status: () => breaker.status(),
    onEvent: (cb) => breaker.subscribe(cb),
    verify: () => breaker.verify(MONAD_CHAIN_ID),
  };
}

/** HOT pool — quotes + fills tail. JSON-RPC batching is enabled so the quote
 *  poller's per-market reads collapse toward a single round-trip
 *  (docs/architecture.md: quote poller). */
const hotPool = createPool(config.rpcHttp, config.rpcBackups, 'RPC', (i) => (i === 0 ? 'primary' : `backup-${i}`));

/** True when a DEDICATED deep-history pool is configured. When false the
 *  archive client below is literally the hot client — same breaker, same
 *  status, one set of notes — which is the pre-split behavior exactly. */
export const hasDedicatedArchive = config.rpcArchive !== '';

/** ARCHIVE pool — deep crawls only (volume backfill, markout onboarding, gas,
 *  blockAtOrAfter). Chosen for RETENTION, not for tip freshness: these reads
 *  are months old, so a node several blocks behind the head costs nothing here
 *  and buys the history the hot node has pruned (see config.ts: RPC pools). */
const archivePool = hasDedicatedArchive
  ? createPool(config.rpcArchive, config.rpcArchiveBackups, 'RPC archive', (i) => (i === 0 ? 'archive' : `archive-backup-${i}`))
  : hotPool;

export const publicClient: PublicClient = hotPool.client;
export const archiveClient: PublicClient = archivePool.client;

/** Failover status for /api/markets (labels only) + event sink for state.notes
 *  (each event carries its own note code — see failover.ts RpcNote). */
export const rpcStatus = (): RpcStatusView => hotPool.status();
export const onRpcEvent = (cb: (n: RpcNote) => void): void => hotPool.onEvent(cb);

/** Same, for the deep-history pool. With no dedicated archive these mirror the
 *  hot pool — callers get one consistent answer either way, and the live source
 *  only PUBLISHES the archive status when the pools actually differ. */
export const archiveRpcStatus = (): RpcStatusView => archivePool.status();
export const onArchiveRpcEvent = (cb: (n: RpcNote) => void): void => archivePool.onEvent(cb);

/** Boot sanity check — verifies chain id 143 on EVERY endpoint (wrong-chain
 *  backups are dropped, wrong-chain primary is fatal) and pre-positions onto
 *  the first healthy endpoint when the primary is mid-outage. Boot proceeds if
 *  ANY endpoint serves (docs/architecture.md: operations). */
export async function probeChain(): Promise<RpcVerifyResult> {
  return hotPool.verify();
}

/** Same for the archive pool. NOT fatal to boot: the deep crawls are background
 *  work, so a dead archive must degrade to "history stalls, loudly" rather than
 *  take down live quoting — the one job that still works without any history.
 *  A no-op when the pools are shared (probeChain already verified them). */
export async function probeArchiveChain(): Promise<RpcVerifyResult> {
  return hasDedicatedArchive ? archivePool.verify() : { ok: true, block: 0 };
}

/** Earliest block whose timestamp >= `targetSec`, by binary search over [0, hi]
 *  (~log2(hi) getBlock calls). Maps a backfill start date → a start block. A
 *  pruned/missing block just pushes the search higher.
 *
 *  Rides the ARCHIVE pool: the search probes mid-points across the whole chain
 *  (the first probe is ~block hi/2), so on a pruning fullnode nearly every early
 *  probe 404s, the failure budget below is spent in seconds, and it throws. */
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
    try { ts = Number((await archiveClient.getBlock({ blockNumber: mid })).timestamp); }
    catch {
      if (++failures > 8) throw new Error(`blockAtOrAfter: ${failures} probe failures — RPC unhealthy, not converging to head`);
      lo = mid + 1n; continue;
    }
    if (ts >= targetSec) { ans = mid; h = mid - 1n; } else { lo = mid + 1n; }
  }
  return ans;
}

/**
 * getLogs with automatic range-chunking, narrowing on demand.
 *
 * Endpoints disagree on how wide a range they will serve — the devcore4 fleet
 * answers 1000 blocks, the public endpoint 413s past ~100 — and the failover
 * breaker can move us between them mid-run. So the span is not a constant: we
 * ATTEMPT `chunk` and halve toward `getLogsMinChunk` when a call is refused,
 * retrying the SAME start so no range is skipped. The narrowed span sticks for
 * the rest of the call rather than re-probing per chunk.
 *
 * Failing at the floor still THROWS: a required source that cannot be read must
 * hold the cursor, never return a short read that reads as "no logs here"
 * (AGENTS.md: never swallow an error that would silently undercount fills).
 */
export async function getLogsChunked(
  params: { address: `0x${string}` | `0x${string}`[]; fromBlock: bigint; toBlock: bigint; events?: readonly unknown[] },
  chunk = BigInt(config.getLogsChunk),
  fetchLogs: (a: { address: unknown; fromBlock: bigint; toBlock: bigint; events?: unknown }) => Promise<unknown[]>
    = (a) => publicClient.getLogs(a as any) as Promise<unknown[]>,
): Promise<unknown[]> {
  const floor = BigInt(config.getLogsMinChunk);
  const out: unknown[] = [];
  let span = chunk > floor ? chunk : floor;
  let start = params.fromBlock;
  while (start <= params.toBlock) {
    const end = start + span - 1n > params.toBlock ? params.toBlock : start + span - 1n;
    try {
      out.push(...await fetchLogs({ address: params.address, fromBlock: start, toBlock: end, events: params.events }));
      start = end + 1n;
    } catch (e) {
      if (span <= floor) throw e;             // already as narrow as we go — fail closed
      const half = span / 2n;
      span = half > floor ? half : floor;     // retry the same start, narrower
    }
  }
  return out;
}
