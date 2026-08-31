/** Numeric + string formatting helpers, ported from propAMM.dc.html's DCLogic. */

export function sgn(x: number, dp = 2): string {
  return (x >= 0 ? '+' : '') + x.toFixed(dp);
}

/** A trade-size label: the SIZE pills ($100 … $100k) and the depth curve's
 *  y axis, which runs a decade further ($1M reads better than "$1000k"). */
export function sizeLabel(s: number): string {
  if (s >= 1e6) return '$' + s / 1e6 + 'M';
  return s >= 1000 ? '$' + s / 1000 + 'k' : '$' + s;
}

/**
 * Lowest value that belongs on a rung — the point where the rung BELOW would
 * ROUND UP into it. A rung selected at its round unit (x >= 1e6) still prints
 * the magnitude above it, because the rounding happens after the selection:
 * $999,999 renders "$1000.0k", which is the very label the B rung exists to
 * get rid of. `dpBelow` is the decimal count that lower rung prints.
 */
const rungMin = (unit: number, dpBelow: number) => unit - unit / 1000 * 0.5 * 10 ** -dpBelow;

/** $1.016B / $1.23M / $4.5k / $12.34 (DCLogic.fmtUsd).
 *  The B rung carries 3dp for the reason spelled out on `fmtVolUsd`. */
export function fmtUsd(x: number): string {
  return x >= rungMin(1e9, 2) ? '$' + (x / 1e9).toFixed(3) + 'B'
    : x >= rungMin(1e6, 1) ? '$' + (x / 1e6).toFixed(2) + 'M'
      : x >= rungMin(1e3, 2) ? '$' + (x / 1e3).toFixed(1) + 'k'
        : '$' + x.toFixed(2);
}

/**
 * USD at volume scale (DCLogic.f$) — $420k / $12.34M / $1.016B. Input is
 * already USD; the tiles, axis labels and legends all read through here, so
 * one number never appears in two different scales on the same screen.
 *
 * Billions carry THREE decimals where millions carry two. At 2dp the label
 * advances one tick per $10M, and Monad days run $1–5M — the all-time tile
 * would sit frozen for days, reading as a stalled feed. 3dp is $1M of
 * resolution, which moves daily and still fits the tile.
 *
 * The k rung prints whole thousands here (0dp), so its carry point sits lower
 * than fmtUsd's — hence `rungMin` per rung rather than one shared constant.
 */
export function fmtVolUsd(usd: number): string {
  if (usd >= rungMin(1e9, 2)) return '$' + (usd / 1e9).toFixed(3) + 'B';
  if (usd >= rungMin(1e6, 0)) return '$' + (usd / 1e6).toFixed(2) + 'M';
  return '$' + (usd / 1e3).toFixed(0) + 'k';
}

/** Doubles carry ~15–17 significant digits; 15 is the last one always safe.
 *  Past it a JS number prints its own binary noise (7.4387 ETH round-trips as
 *  7.438700000000001), which must never reach a column that reads as exact. */
const SAFE_SIG_DIGITS = 15;

/** Drop the padding a fixed-dp render adds, so an exact value shows its real
 *  length: "0.07915300" → "0.079153", "3.33350000000000" → "3.3335". */
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * A token amount in its own units.
 *
 * On-chain amounts are INTEGERS of 10^-decimals, so the true value never has
 * more fractional digits than the token has decimals. Given `decimals` this
 * renders exactly that and trims the padding — an 8dp token prints its real
 * traded amount (0.07285608 cbBTC, not 0.07286), which is what a trading
 * dashboard owes the reader.
 *
 * Two limits are honest to state rather than hide:
 *  - Above 1k the k/M compaction stays. That form READS as approximate, so it
 *    cannot mislead the way a decimal like "0.07286" does — the full value is
 *    carried in the cell's tooltip instead of widening every row.
 *  - An 18-decimal amount can exceed what a double holds (14718.074205856226
 *    is already lossy before it reaches us, since `Fill.baseAmount` is a JSON
 *    number). Rounding at SAFE_SIG_DIGITS strips the resulting binary noise
 *    rather than printing it as if it were precision. Recovering those digits
 *    would mean carrying the raw integer on the wire.
 *
 * Without `decimals` it falls back to ~4 significant digits — still never the
 * old flat 4dp, which rendered $1 of cbBTC as "0.0000".
 */
export function fmtAmt(x: number, decimals?: number): string {
  const a = Math.abs(x);
  if (!Number.isFinite(a)) return '—'; // before the k/M branches — Infinity is not "InfinityM"
  if (a === 0) return '0';
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (x / 1e3).toFixed(2) + 'k';
  if (decimals === undefined) return x.toFixed(Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(a)))));
  return trimZeros(x.toFixed(exactDp(a, decimals)));
}

/** Fractional digits that are BOTH real on-chain (≤ token decimals) and
 *  representable (≤ what the double can justify at this magnitude). */
function exactDp(a: number, decimals: number): number {
  const intDigits = Math.max(1, Math.floor(Math.log10(a)) + 1);
  return Math.max(0, Math.min(decimals, SAFE_SIG_DIGITS - intDigits));
}

/**
 * The same amount at FULL precision — no k/M compaction — for a tooltip on a
 * compacted cell, so the exact figure is always one hover away even when the
 * column shows "445.20k MON".
 */
export function fmtAmtFull(x: number, decimals?: number): string {
  const a = Math.abs(x);
  if (!Number.isFinite(a)) return '—';
  if (a === 0) return '0';
  return trimZeros(x.toFixed(decimals === undefined ? Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(a)))) : exactDp(a, decimals)));
}

/**
 * A PRICE in quote-per-base terms (execPx, bidPx/askPx).
 *
 * This dashboard's unit of meaning is the basis point, so a price must resolve
 * FINER than the effect being measured — otherwise the rounding is itself a
 * multi-bp error, silently, on a number that still looks plausible. A flat
 * toFixed(5) resolved MON/USDC (~0.0212) to ±2.4bps on ~70% of all fills, and
 * collapsed MON/ETH (~0.0000112) to "0.00001" — one significant digit.
 *
 * ~6 significant digits keeps every tracked market finer than 0.1bp: 1bp of
 * 2,010 is 0.20 (2dp is 20× finer), 1bp of 0.0212 is 0.0000021 (7dp is 20×
 * finer). The ≥1000 branch also keeps big prices narrow enough not to clip a
 * table cell or an axis gutter.
 */
export function fmtPx(x: number): string {
  const a = Math.abs(x);
  if (!Number.isFinite(a)) return '—';
  if (a === 0) return '0';
  if (a >= 1000) return x.toFixed(2);
  return x.toFixed(Math.min(10, Math.max(2, 5 - Math.floor(Math.log10(a)))));
}

export function pnlFmt(x: number): string {
  return (x >= 0 ? '+' : '−') + fmtUsd(Math.abs(x));
}

// percentile moved to @shared — the server-side leaderboard aggregation uses
// the SAME implementation, so client and server numbers can never drift.
export { percentile } from '@shared';

export function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

/** SVG path for a sparkline over [w,h] (DCLogic.sparkPath). */
export function sparkPath(arr: number[], w: number, h: number): string {
  if (!arr || arr.length < 2) return '';
  const mn = Math.min(...arr), mx = Math.max(...arr), rg = (mx - mn) || 1;
  return 'M' + arr.map((v, i) => (i / (arr.length - 1) * w).toFixed(1) + ',' + (h - (v - mn) / rg * h).toFixed(1)).join(' L');
}

export function humanAge(a: number): string {
  return a < 60 ? Math.round(a) + 's ago' : a < 3600 ? Math.round(a / 60) + 'm ago' : Math.round(a / 3600) + 'h ago';
}

/** HH:MM:SS.mmm UTC from an epoch-ms timestamp. */
export function clockMs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}
export function clockSec(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(11, 19);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Abbreviate a hash/address for display (idempotent — pre-shortened or short
 *  values pass through unchanged). Live decoders store full tx hashes. */
export function shortHex(h: string, head = 4, tail = 4): string {
  if (!h || h.includes('…') || h.length <= 2 + head + tail + 1) return h;
  return h.slice(0, 2 + head) + '…' + h.slice(-tail);
}
