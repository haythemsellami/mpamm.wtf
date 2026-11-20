import type { Fill, Side, VenueMeta } from '@shared';
import { TOKENS, assetForToken, baseTokenOf, pairFor } from '@shared';
import { fromUnits, shortHex } from '../util.js';

/**
 * What every Metric contract generation shares (metric-v0.ts, metric-v1.ts):
 * the ONE venue they report as, the structural admission rule, the liveness
 * gate and the fill shape. A generation differs only in its ABIs and its
 * contract set, so anything here must stay generation-agnostic — a rule that
 * only holds for one deployment belongs in that deployment's file.
 */

// sinceUtc = Metric's first on-chain day: the first v0 pool is block 64911692
// (2026-03-30 22:13 UTC) and its first swap block 64913600 (22:26, $222) — the
// SAME anchor as backfillFromUtc, or a replay resolving it with blockAtOrAfter
// starts after that swap and loses it for good.
// ONE id across generations: history is keyed by venue id, and a new id would
// be a new venue whose old rows the boot reconcile prunes (db.ts reconcileVenues).
export const METRIC_VENUE: VenueMeta = { id: 'metric', name: 'Metric', color: { light: '#0F9D8C', dark: '#0D9488' }, kind: 'amm', role: 'venue', sinceUtc: '2026-03-30' };

export interface MetricPool {
  pool: `0x${string}`;
  /** the price provider bound at admission (v0: from getImmutables; v1: the
   *  pool's CURRENT provider). Only liveness and gas attribution read it. */
  priceProvider: `0x${string}`;
  market: string;        // 'BTC/USDC'
  baseIsToken0: boolean;
  baseToken: string;     // TOKENS key of the base wrapper ('WMON'|'WBTC'|'WETH')
  baseDec: number;
  stableSym: string;
  stableDec: number;
}

/** Why a candidate pool was not admitted (null = admitted). Pure so the
 *  permissionless admission rules are unit-tested without a chain. */
export type RejectReason = 'unresolved' | 'not-base-stable' | 'unregistered-pair' | 'unknown-base-token';

/** The token layout a pool reports on-chain (null = it did not answer). */
export interface MetricPoolTokens {
  token0: string;
  token1: string;
  priceProvider: string;
}

/** STRUCTURAL admission: does this pool describe a market we can price and
 *  benchmark? Metric is permissionless, so anyone can deploy a pool for any
 *  token combo — only registered base/stable pairs (@shared PAIRS) can carry
 *  reference rows and markouts, and everything else is dropped rather than
 *  surfaced as an unbenchmarkable market. */
export function admitMetricPool(pool: `0x${string}`, im: MetricPoolTokens | null): { ok: true; value: MetricPool } | { ok: false; reason: RejectReason; detail?: string } {
  if (!im) return { ok: false, reason: 'unresolved' };
  const token0 = String(im.token0).toLowerCase();
  const token1 = String(im.token1).toLowerCase();
  // exactly one side a tracked base asset, the other a stable
  const a0 = assetForToken(token0), a1 = assetForToken(token1);
  if (!!a0 === !!a1) return { ok: false, reason: 'not-base-stable' };
  const baseIsToken0 = !!a0;
  const base = (baseIsToken0 ? a0 : a1)!;
  const stableAddr = baseIsToken0 ? token1 : token0;
  const stable = Object.values(TOKENS).find((t) => t.stable && t.address.toLowerCase() === stableAddr);
  if (!stable) return { ok: false, reason: 'not-base-stable' };
  const pair = pairFor(base.key, stable.symbol);
  if (!pair) return { ok: false, reason: 'unregistered-pair', detail: `${base.symbol}/${stable.symbol}` };
  const baseTok = baseTokenOf(base.key);
  if (!baseTok) return { ok: false, reason: 'unknown-base-token', detail: base.key };
  return {
    ok: true,
    value: {
      pool, priceProvider: im.priceProvider as `0x${string}`, market: pair.symbol, baseIsToken0,
      baseToken: base.token, baseDec: baseTok.decimals,
      stableSym: stable.symbol, stableDec: stable.decimals,
    },
  };
}

/** Why a structurally-valid pool is not quotable right now. Three genuinely
 *  different situations that a bare boolean used to flatten into one, and the
 *  note then labelled all of them "unfunded":
 *   - unfunded   the curator's shell — no inventory, cannot trade. Common:
 *                permissionless deployment means empty pools exist.
 *   - no-price   FUNDED, but the PriceProvider will not answer. The pool can
 *                still TRADE (v0's router took bid/ask as call parameters), so
 *                this is capital we cannot price, not a dead market
 *                (observed 2026-08-14: ~$150k across three pools).
 *   - unreadable the TOKEN contract did not answer, so funding is unknown.
 *                Says nothing about the pool; reporting a read problem as the
 *                venue's fault is the mistake #63 fixed for Lunarbase. */
export type NotLiveReason = 'unfunded' | 'no-price' | 'unreadable';

/** LIVENESS: a structurally-valid pool is only QUOTED once it can actually be
 *  priced — both sides funded and the provider returning a two-sided price.
 *  Quoting an empty shell would put dead markets on the Execution tab.
 *  NOTE: fills are NOT gated on this (issue #61) — a pool we cannot price can
 *  still trade, and its Swaps are tailed off ADMISSION. */
export function metricPoolLiveness(
  bal0: bigint | null, bal1: bigint | null, bid: bigint | null, ask: bigint | null,
): 'live' | NotLiveReason {
  // These come from ONE allowFailure multicall, so a per-entry failure is
  // contract-level: a transport failure would have thrown the whole call before
  // we got here. A missing price therefore means the provider REFUSED (Metric's
  // revert since 2026-08-14), not that we could not reach it.
  if (bal0 === null || bal1 === null) return 'unreadable';  // the token contract itself did not answer
  if (bal0 <= 0n || bal1 <= 0n) return 'unfunded';          // one-sided or empty inventory
  if (bid === null || ask === null) return 'no-price';      // provider reverted
  if (bid <= 0n || ask <= 0n) return 'no-price';            // …or answered with nothing
  return 'live';
}

/** Boolean view of the above, for the quote gate. */
export function isMetricPoolLive(bal0: bigint | null, bal1: bigint | null, bid: bigint | null, ask: bigint | null): boolean {
  return metricPoolLiveness(bal0, bal1, bid, ask) === 'live';
}

/** One landed swap → a Fill. Both generations report the pool's NET token
 *  flows with the same sign convention (positive = the pool GAINED the token),
 *  so the money math lives here exactly once. Null for a degenerate log. */
export function metricFill(p: MetricPool, d0: bigint, d1: bigint, l: any, recipient: string, tsOf: (bn: bigint) => number): Fill | null {
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const baseDelta = p.baseIsToken0 ? d0 : d1;
  const stableDelta = p.baseIsToken0 ? d1 : d0;
  const baseAmount = fromUnits(abs(baseDelta), p.baseDec);
  const usd = fromUnits(abs(stableDelta), p.stableDec);
  if (baseAmount <= 0 || usd <= 0) return null;
  // stable INTO the pool (positive delta) ⇒ the trader bought the base.
  const side: Side = stableDelta > 0n ? 'buy' : 'sell';
  return {
    // deterministic and generation-free: dedup must hold across re-tails, and
    // a fill's id must not depend on which generation decoded it.
    id: `metric-${String(l.transactionHash).toLowerCase()}-${Number(l.logIndex)}`,
    venueId: METRIC_VENUE.id,
    // attribution is the core's job (tx.to): claiming DIRECT here would
    // label aggregator/searcher flow as direct — emit honest UNKNOWN.
    market: p.market, side, category: 'UNKNOWN',
    usd, baseAmount, execPx: usd / baseAmount, // realized stable-per-base (real markouts, no pxApprox)
    txHash: l.transactionHash, to: shortHex(String(recipient ?? '0x')),
    pool: `metric ${p.pool.slice(0, 8)}`,
    blockNumber: Number(l.blockNumber), ts: tsOf(BigInt(l.blockNumber)),
    markoutsBps: [null, null, null, null, null],
  };
}
