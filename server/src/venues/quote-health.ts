import type { AdapterContext } from './adapter.js';

/**
 * Why a venue stopped quoting.
 *
 * Returning `[]` from `quote()` is how a venue leaves the Execution grid, and
 * on its own it carries no signal: a maker switching itself off and an adapter
 * whose ABI drifted after a proxy upgrade look identical from the outside.
 * ThogAMM proved it — its keeper posted `sideEnableBits = 0` on 2026-08-04 and
 * every leg began reverting "maker: paused", which took an on-chain binary
 * search to establish instead of one line of telemetry.
 *
 * Every venue quotes through an `allowFailure: true` multicall, which discards
 * exactly the per-leg revert that says which of the two it is. This digs it
 * back out. The core raises its own generic note when a venue goes dark
 * (datasource/live.ts: checkQuoteOutage) — what an adapter adds here is the
 * REASON, so the two layers compose: the core can never be forgotten, the
 * adapter says something the core cannot know.
 */

/** The Error(string) payload of a reverted eth_call, from anywhere in viem's
 *  nested error chain (multicall wraps it a few `cause` levels deep). Falls
 *  back to parsing the rendered message, which always carries the reason. */
function revertReason(err: unknown): string | null {
  for (let e = err as any, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (typeof e.reason === 'string' && e.reason.trim()) return e.reason.trim();
  }
  const rendered = err instanceof Error ? err.message : String(err ?? '');
  const m = /reverted with the following reason:\s*\n?(.+)/.exec(rendered);
  return m ? m[1].trim() : null;
}

/** One entry of an `allowFailure: true` multicall result. */
export interface MulticallOutcome { status: 'success' | 'failure'; error?: unknown }

/**
 * The venue-wide quote outage reason, or null while ANY leg still quotes.
 *
 * Only an ALL-failure round counts: one market going quiet is routine per-pair
 * behaviour (a drained side, a cold reference), not an outage. When legs fail
 * for different reasons the most common one is reported (a plurality, not
 * necessarily a majority; ties go to whichever was seen first) — a venue-wide
 * cause is the same string on every leg, so it dominates whatever noise a
 * flaky leg contributes.
 */
export function quoteOutageReason(results: readonly MulticallOutcome[]): string | null {
  if (!results.length || results.some((r) => r.status === 'success')) return null;
  const counts = new Map<string, number>();
  for (const r of results) {
    const reason = revertReason(r.error) ?? 'call failed';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  let top = 'call failed', most = 0;
  for (const [reason, n] of counts) if (n > most) { most = n; top = reason; }
  return top;
}

/**
 * Per-adapter outage reporter. Call it with the quote multicall's results;
 * it returns true when the venue is dark (the caller then returns `[]`).
 *
 * Holds the reason currently on the record so block-triggered quoting notes it
 * once — but a CHANGED reason is a new event and gets its own note. Recovery
 * is ANNOUNCED rather than retracted: an adapter can only append, so a heal
 * that said nothing would leave the warning standing until the served window
 * rolled it off (the stale scare-warning lesson, 6c3cf5b).
 */
export function createQuoteOutageReporter(venueName: string): (ctx: AdapterContext, results: readonly MulticallOutcome[]) => boolean {
  let current: string | null = null;
  return (ctx, results) => {
    const reason = quoteOutageReason(results);
    if (reason) {
      if (current !== reason) {
        current = reason;
        // "failed", not "reverted": a leg can fail without reverting (transport
        // error, decode failure), and `reason` falls back to a generic string
        // in that case — `reverted "call failed"` would be a lie.
        ctx.note('venue.quote.unavailable', `${venueName} quotes unavailable — all ${results.length} legs failed with "${reason}" (venue disabled, or the ABI drifted from the contract)`);
      }
      return true;
    }
    if (current) {
      ctx.note('venue.quote.recovered', `${venueName} quoting again (was "${current}")`);
      current = null;
    }
    return false;
  };
}
