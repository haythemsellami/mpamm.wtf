import { parseAbi } from 'viem';
import { PAIRS, TOKENS, cexForBase, type Pair } from '@shared';
import { tokenKeysForPair } from './venues/pair-tokens.js';
import { fromUnits } from './util.js';

/**
 * Is a share wrapper worth exactly one underlying right now?
 *
 * A pair that trades a `parityWrapper` token (wANTx) is referenced by the
 * UNDERLYING's CEX book at one underlying per share. That is a fact about the
 * chain, and it stops being true when the underlying rebases: the share's
 * `convertToAssets` moves, and every number taken against the reference is
 * off by the same amount (wQQQx read 1.003456 on 2026-11-09: 34.6 bp).
 *
 * So the fact is read here, once for the process, and the reference registry
 * has NO mid and NO walk rows for the pair unless a recent read says the rate
 * is 1 (venues/reference.ts). Everything downstream of the reference follows
 * without knowing a wrapper exists: an adapter has no bps anchor and quotes
 * nothing, the markout ring takes no samples, so no markout and no curve.
 *
 * It lives with the reference, not in an adapter, because the reference is the
 * thing that is wrong. The first version gated one venue's quotes from its own
 * discovery pass: fills on the same market were still marked out against the
 * biased mid, and any other adapter could still quote it (PR #173 review).
 *
 * Fails closed: a rate never read, a wrapper that did not answer and a read
 * that is too old are all "no reference". One failed read does not erase the
 * last good one (a dropped eth_call must not blank a market for a minute), but
 * that answer expires after WRAPPER_PARITY_MAX_AGE_MS without a fresh one.
 *
 * The limit: a rebase is seen at the next read, so what was quoted or marked
 * in the WRAPPER_PARITY_REFRESH_MS before it used the old rate.
 *
 * Fills are not gated. A wrapper pair's USD comes from its stable leg.
 */

/** How often each process re-reads the rate (one eth_call for all wrappers). */
export const WRAPPER_PARITY_REFRESH_MS = 60_000;
/** How long a good read is trusted when the reads after it fail. */
export const WRAPPER_PARITY_MAX_AGE_MS = 5 * 60_000;

const shareWrapperAbi = parseAbi(['function convertToAssets(uint256 shares) view returns (uint256)']);

/** `assetsPerShare` is convertToAssets(1 share). The 0.1 bp band is far above
 *  the wei of rounding a rebasing underlying leaves and far below any real
 *  rebase. */
export function wrapperAtParity(assetsPerShare: bigint, decimals: number): boolean {
  const one = 10n ** BigInt(decimals);
  const off = assetsPerShare > one ? assetsPerShare - one : one - assetsPerShare;
  return off <= one / 100_000n;
}

const wrappersByPair = new Map<string, readonly string[]>();
/** TOKENS keys of the share wrappers a pair trades, on either leg. Empty for
 *  every pair without one, which is what keeps the gate free for them. */
export function parityWrappersOf(pair: Pair): readonly string[] {
  let keys = wrappersByPair.get(pair.symbol);
  if (!keys) {
    keys = (tokenKeysForPair(pair) ?? []).filter((key) => TOKENS[key]?.parityWrapper);
    wrappersByPair.set(pair.symbol, keys);
  }
  return keys;
}

/** The slice of a viem client a refresh needs. */
export interface ShareRateReader {
  multicall(args: { contracts: readonly { address: `0x${string}`; abi: typeof shareWrapperAbi; functionName: 'convertToAssets'; args: readonly [bigint] }[]; allowFailure: true }): Promise<readonly { status: 'success' | 'failure'; result?: unknown }[]>;
}

export class WrapperParity {
  /** the last rate each wrapper ANSWERED, and when */
  private readonly last = new Map<string, { perShare: bigint; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Every wrapper a registered pair trades: what a refresh reads. */
  tokens(): string[] { return [...new Set(PAIRS.flatMap((pair) => parityWrappersOf(pair)))]; }

  /** Why the pair has no reference, or null when its reference stands (always
   *  null for a pair with no wrapper). The text is stable while the cause is,
   *  so it can key a note. */
  why(pair: Pair): string | null {
    for (const key of parityWrappersOf(pair)) {
      const token = TOKENS[key];
      const read = this.last.get(key);
      if (!read || this.now() - read.at > WRAPPER_PARITY_MAX_AGE_MS) return `${token.symbol} has not answered convertToAssets`;
      if (!wrapperAtParity(read.perShare, token.decimals)) return `1 ${token.symbol} = ${fromUnits(read.perShare, token.decimals)} underlying`;
    }
    return null;
  }
  valid(pair: Pair): boolean { return this.why(pair) === null; }

  /** One wrapper's answer. null = it did not answer: the last answer stands
   *  until it is too old. */
  record(tokenKey: string, perShare: bigint | null): void {
    if (perShare !== null) this.last.set(tokenKey, { perShare, at: this.now() });
  }

  /** Re-read every wrapper. Never throws: a read that failed as a whole is
   *  every wrapper not answering. */
  async refresh(client: ShareRateReader): Promise<void> {
    const keys = this.tokens();
    if (!keys.length) return;
    let results: readonly { status: 'success' | 'failure'; result?: unknown }[];
    try {
      results = await client.multicall({
        contracts: keys.map((key) => ({ address: TOKENS[key].address as `0x${string}`, abi: shareWrapperAbi, functionName: 'convertToAssets' as const, args: [10n ** BigInt(TOKENS[key].decimals)] as const })),
        allowFailure: true,
      });
    } catch { return; }
    keys.forEach((key, i) => {
      const r = results[i];
      this.record(key, r?.status === 'success' && typeof r.result === 'bigint' ? r.result : null);
    });
  }
}

/** The process's one view of wrapper parity (the main process and the depth
 *  worker each hold their own and refresh it themselves). */
export const WRAPPER_PARITY = new WrapperParity();

/**
 * The notes for a pair losing and regaining its reference to parity. Call it
 * after every refresh. Same shape as the reference-starvation check: the
 * warning is retracted with the exact string it was raised with, and the
 * return is announced.
 *
 * Keyed on the RATE alone. Whether a venue's pool is funded or its oracle
 * answers is that venue's business and has its own notes: the first version
 * derived this from the pools that were live and off parity, so a pool that
 * also lost its funding announced "back at parity" while the rate was still off.
 *
 * `unreferenced` fires on every check that finds the pair without a
 * reference, so the caller can drop what it sampled just before the read.
 */
export function createParityReporter(
  parity: Pick<WrapperParity, 'why'>,
  io: { warn: (m: string) => void; clear: (m: string) => void; announce: (m: string) => void; unreferenced?: (market: string) => void },
  pairs: readonly Pair[] = PAIRS,
): () => void {
  const warned = new Map<string, string>(); // market → the line on the record
  return () => {
    for (const pair of pairs) {
      if (!parityWrappersOf(pair).length) continue;
      const why = parity.why(pair);
      const prev = warned.get(pair.symbol);
      if (why === null) {
        if (prev === undefined) continue;
        warned.delete(pair.symbol);
        io.clear(prev);
        io.announce(`${pair.symbol} has its ${cexForBase(pair.base)} reference again — the wrapper is back at one underlying per share`);
        continue;
      }
      io.unreferenced?.(pair.symbol);
      const msg = `${pair.symbol} has no reference — ${why}, and the ${cexForBase(pair.base)} book it is benchmarked against is the underlying's, like-for-like only at one underlying per share. No venue is quoted on it and its fills are not marked out (they are still counted)`;
      if (prev === msg) continue;
      if (prev !== undefined) io.clear(prev);
      warned.set(pair.symbol, msg);
      io.warn(msg);
    }
  };
}
