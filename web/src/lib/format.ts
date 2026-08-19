/** Numeric + string formatting helpers, ported from propAMM.dc.html's DCLogic. */

export function sgn(x: number, dp = 2): string {
  return (x >= 0 ? '+' : '') + x.toFixed(dp);
}

export function sizeLabel(s: number): string {
  return s >= 1000 ? '$' + s / 1000 + 'k' : '$' + s;
}

/** $1.23M / $4.5k / $12.34 (DCLogic.fmtUsd). */
export function fmtUsd(x: number): string {
  return x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M'
    : x >= 1e3 ? '$' + (x / 1e3).toFixed(1) + 'k'
      : '$' + x.toFixed(2);
}

/** millions-scaled (DCLogic.f$) — input already in USD. */
export function fMillions(usd: number): string {
  const m = usd / 1e6;
  return m >= 1 ? '$' + m.toFixed(2) + 'M' : '$' + (m * 1000).toFixed(0) + 'k';
}

/**
 * A token amount in its own units — SIGNIFICANT digits, not decimal places.
 *
 * Token unit values span 3.1 million to one on this dashboard (MON at ~$0.02
 * against cbBTC at ~$68k), so no fixed decimal count serves both: the same $1k
 * trade is 45,000 MON or 0.0147 cbBTC. A flat 4dp silently rounded the
 * small-unit side toward zero — $1 of cbBTC rendered as "0.0000".
 *
 * Below 1k we therefore hold ~4 significant digits, capped at 8dp (the finest
 * on-chain resolution any tracked token has, WBTC/cbBTC). Every value ≥0.1 is
 * unchanged from the old fixed-4dp form, so the common rows do not move.
 */
export function fmtAmt(x: number): string {
  const a = Math.abs(x);
  if (!Number.isFinite(a)) return '—'; // before the k/M branches — Infinity is not "InfinityM"
  if (a === 0) return '0';
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (x / 1e3).toFixed(2) + 'k';
  return x.toFixed(Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(a)))));
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
