import { parseAbi } from 'viem';
import { PAIRS, TOKENS, cexForBase, type Pair } from '@shared';
import { tokenKeysForPair } from './venues/pair-tokens.js';
import { fromUnits } from './util.js';

/** ERC-4626 assets per whole share, sampled once per process. A failed
 *  RPC retains the last successful observation until its freshness limit.
 *  Older overlapping requests cannot roll a newer observation back. */

/** How often each process re-reads the rate (one eth_call for all wrappers). */
export const WRAPPER_RATES_REFRESH_MS = 60_000;
/** How long a good read is trusted when the reads after it fail. */
export const WRAPPER_RATES_MAX_AGE_MS = 5 * 60_000;

const shareWrapperAbi = parseAbi(['function convertToAssets(uint256 shares) view returns (uint256)']);

const wrappersByPair = new Map<string, readonly string[]>();
/** TOKENS keys of the share wrappers a pair trades, on either leg. Empty for
 *  every pair without one, which is what keeps the gate free for them. */
export function shareWrappersOf(pair: Pair): readonly string[] {
  let keys = wrappersByPair.get(pair.symbol);
  if (!keys) {
    keys = (tokenKeysForPair(pair) ?? []).filter((key) => TOKENS[key]?.underlyingXStock);
    wrappersByPair.set(pair.symbol, keys);
  }
  return keys;
}

/** The slice of a viem client a refresh needs. */
export interface ShareRateReader {
  multicall(args: { contracts: readonly { address: `0x${string}`; abi: typeof shareWrapperAbi; functionName: 'convertToAssets'; args: readonly [bigint] }[]; allowFailure: true }): Promise<readonly { status: 'success' | 'failure'; result?: unknown }[]>;
}

export class WrapperRates {
  /** the rate each wrapper answered to the most recent request that got an
   *  answer: when that request was SENT, and its place in the order of sends */
  private readonly last = new Map<string, { perShare: number; at: number; seq: number }>();
  private sent = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Every wrapper a registered pair trades: what a refresh reads. */
  tokens(): string[] { return [...new Set(PAIRS.flatMap((pair) => shareWrappersOf(pair)))]; }

  /** Underlying xStocks per wrapped token. Missing, zero and stale rates cannot price shares. */
  rate(tokenKey: string): number {
    const token = TOKENS[tokenKey];
    if (!token?.underlyingXStock) return 1;
    const read = this.last.get(tokenKey);
    if (!read || this.now() - read.at > WRAPPER_RATES_MAX_AGE_MS) return 0;
    return read.perShare;
  }

  why(pair: Pair): string | null {
    for (const key of shareWrappersOf(pair)) {
      if (!(this.rate(key) > 0)) return `${TOKENS[key].symbol} has no fresh positive convertToAssets rate`;
    }
    return null;
  }
  valid(pair: Pair): boolean { return this.why(pair) === null; }

  /** One wrapper's answer to request number `seq`, sent at `at`. null = it
   *  did not answer: the last answer stands until it is too old. An answer to
   *  an EARLIER request than the one on record is dropped. */
  private record(tokenKey: string, perShare: bigint | null, at: number, seq: number): void {
    if (perShare === null) return;
    const held = this.last.get(tokenKey);
    if (held && held.seq > seq) return;
    this.last.set(tokenKey, { perShare: fromUnits(perShare, TOKENS[tokenKey].decimals), at, seq });
  }

  /** Re-read every wrapper. Never throws: a read that failed as a whole is
   *  every wrapper not answering. Calls may overlap (a slow read, the next
   *  tick): each is stamped when it is sent, so the latest SENT wins whatever
   *  order they land in, and a hung one blocks nothing. */
  async refresh(client: ShareRateReader): Promise<void> {
    const keys = this.tokens();
    if (!keys.length) return;
    const seq = ++this.sent, at = this.now();
    let results: readonly { status: 'success' | 'failure'; result?: unknown }[];
    try {
      results = await client.multicall({
        contracts: keys.map((key) => ({ address: TOKENS[key].address as `0x${string}`, abi: shareWrapperAbi, functionName: 'convertToAssets' as const, args: [10n ** BigInt(TOKENS[key].decimals)] as const })),
        allowFailure: true,
      });
    } catch { return; }
    keys.forEach((key, i) => {
      const r = results[i];
      this.record(key, r?.status === 'success' && typeof r.result === 'bigint' ? r.result : null, at, seq);
    });
  }
}

/** The process's one view of wrapper rates (the main process and the depth
 *  worker each hold their own and refresh it themselves). */
export const WRAPPER_RATES = new WrapperRates();

/** Retract warnings on recovery. Drop samples from the old conversion when
 *  a rate changes, and keep the ring empty throughout a missing-rate episode. */
export function createWrapperRateReporter(
  rates: Pick<WrapperRates, 'why' | 'rate'>,
  io: { warn: (m: string) => void; clear: (m: string) => void; announce: (m: string) => void; invalidateSamples?: (market: string) => void },
  pairs: readonly Pair[] = PAIRS,
): () => void {
  const lastRate = new Map<string, number>();
  const warned = new Map<string, string>(); // market → the line on the record
  const keys = new Set(pairs.flatMap(shareWrappersOf));
  return () => {
    const changed = new Set<string>();
    for (const key of keys) {
      const rate = rates.rate(key);
      if (lastRate.has(key) && lastRate.get(key) !== rate) changed.add(key);
      lastRate.set(key, rate);
    }
    for (const pair of pairs) {
      const wrappers = shareWrappersOf(pair);
      if (!wrappers.length) continue;
      const why = rates.why(pair);
      const prev = warned.get(pair.symbol);
      if (why === null) {
        if (wrappers.some((key) => changed.has(key))) io.invalidateSamples?.(pair.symbol);
        if (prev === undefined) continue;
        warned.delete(pair.symbol);
        io.clear(prev);
        io.announce(`${pair.symbol} has its ${cexForBase(pair.base)} reference again — the wrapper conversion rate is available`);
        continue;
      }
      io.invalidateSamples?.(pair.symbol);
      const msg = `${pair.symbol} has no reference — ${why}, so the ${cexForBase(pair.base)} underlying book cannot be converted into share units. No venue is quoted on it and its fills are not marked out (they are still counted)`;
      if (prev === msg) continue;
      if (prev !== undefined) io.clear(prev);
      warned.set(pair.symbol, msg);
      io.warn(msg);
    }
  };
}
