/**
 * Volume-weighted average markout, in bps.
 *
 * The leaderboard's percentiles describe the SHAPE of a group's markout
 * distribution but not its direction: markouts are heavily skewed, so a maker
 * can win the median trade and still lose money overall (observed live —
 * Hanji at T+0 has run a positive median against a negative mean). The mean is
 * the number that answers "did this venue make or lose", and its sign is the
 * sign of the PnL beside it.
 *
 * `pnl` is already Σ(markout_bps × usd / 10⁴) and `vol` is Σusd (@shared:
 * LeaderboardGroupRow), so this is that same sum renormalized — EXACT, not a
 * re-estimate, and it can never disagree with the POOL PNL column. It is
 * weighted by notional on purpose: a $1M fill should move it more than a $10
 * one, which is also what makes it reconcile with PnL. An unweighted mean
 * (Σbps ÷ n) answers a different question and would need a new server field.
 *
 * Pass the values AFTER the MAKER/TAKER sign flip; the ratio carries the sign.
 */
export function avgMarkoutBps(pnl: number, vol: number): number {
  if (!Number.isFinite(pnl) || !Number.isFinite(vol) || vol === 0) return 0;
  return (pnl / vol) * 1e4;
}
