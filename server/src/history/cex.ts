import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createWriteStream, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairOf, assetOf, TOKENS, wrapBasisFor } from '@shared';
import { config } from '../config.js';

/**
 * HISTORICAL CEX price series — the data source for venue-lifetime markouts.
 *
 * Live markouts age against the in-memory mid ring; historical fills need the
 * pair's CEX mid at second precision at times long past. Both exchanges publish
 * exactly that, keylessly:
 *  - Bybit: monthly PUBLIC trade dumps (public.bybit.com/spot/<SYM>/<SYM>-YYYY-MM.csv.gz,
 *    `id,timestamp(ms),price,volume,side`) — reduced here to a per-second
 *    last-trade series (MON's base series; Bybit's kline API floors at 1m).
 *  - Binance: 1-SECOND klines via the geo-unrestricted data mirror (the base
 *    series for BTC/ETH).
 * Cross (USDCUSDT) and wrap (WBTCBTC) legs move ~bps per hour, so 1-minute
 * klines are ample for them (<0.1bp error over a 60s markout horizon).
 *
 * All lookups are CARRY-FORWARD with a staleness cap: `at(t)` returns the last
 * price at-or-before t, or null when no print exists within `staleMs` — a gap
 * yields a null markout (excluded), never a fabricated one.
 */

export interface StepSeries { at(t: number): number | null }

const STALE_BASE_MS = 120_000;  // base leg: trades/1s-klines — 2min gap ⇒ null
const STALE_SLOW_MS = 30 * 60_000; // cross/wrap legs: 1m klines, slow-moving

function makeSeries(ts: number[], px: number[], staleMs: number): StepSeries {
  return {
    at(t: number): number | null {
      // binary search: last index with ts[i] <= t
      let lo = 0, hi = ts.length - 1, ans = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      if (ans < 0 || t - ts[ans] > staleMs) return null;
      return px[ans];
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJson(url: string): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
      return await r.json();
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

/** Binance klines (data mirror) → StepSeries of closes stamped at close time. */
export async function binanceKlineSeries(symbol: string, interval: '1s' | '1m', fromMs: number, toMs: number): Promise<StepSeries> {
  const ts: number[] = [], px: number[] = [];
  let start = fromMs;
  while (start < toMs) {
    const rows: any[] = await fetchJson(
      `${config.binanceRest}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${toMs}&limit=1000`);
    if (!rows.length) break;
    for (const k of rows) { ts.push(Number(k[6])); px.push(parseFloat(k[4])); } // closeTime, close
    const lastOpen = Number(rows[rows.length - 1][0]);
    if (lastOpen <= start && rows.length < 1000) break;
    start = lastOpen + (interval === '1s' ? 1_000 : 60_000);
    if (rows.length < 1000 && start < toMs) break; // exchange has no more data in range
    await sleep(config.backfillPaceMs);
  }
  return makeSeries(ts, px, interval === '1s' ? STALE_BASE_MS : STALE_SLOW_MS);
}

/** Bybit klines (1-minute) → StepSeries of closes stamped at close time (cross leg).
 *  NB Bybit returns the NEWEST 1000 candles of [start,end] (newest-first), so
 *  pagination walks BACKWARD by lowering `end` — a forward walk collects only
 *  the tail of the range and silently starves earlier hours. Errors arrive as
 *  retCode in HTTP-200 envelopes; throw on them so the caller defers instead of
 *  treating an error as an empty (all-null) series. */
export async function bybitKlineSeries(symbol: string, fromMs: number, toMs: number): Promise<StepSeries> {
  const pts: Array<[number, number]> = [];
  let end = toMs;
  while (end > fromMs) {
    const j = await fetchJson(
      `${config.bybitRest}/v5/market/kline?category=spot&symbol=${symbol}&interval=1&start=${fromMs}&end=${end}&limit=1000`);
    if (j?.retCode !== 0) throw new Error(`bybit kline ${symbol}: ${j?.retCode} ${j?.retMsg ?? ''}`);
    const rows: any[] = j?.result?.list ?? [];
    if (!rows.length) break;
    for (const r of rows) pts.push([Number(r[0]) + 60_000, parseFloat(r[4])]); // close @ close time
    const oldestStart = Number(rows[rows.length - 1][0]);
    if (oldestStart <= fromMs) break;
    end = oldestStart - 1;
    await sleep(config.backfillPaceMs);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return makeSeries(pts.map((p) => p[0]), pts.map((p) => p[1]), STALE_SLOW_MS);
}

// ── Bybit monthly trade dumps ────────────────────────────────────────────────

const dumpDir = () => {
  const d = process.env.HIST_CACHE_DIR ?? join(tmpdir(), 'mpamm-cex-dumps');
  mkdirSync(d, { recursive: true });
  return d;
};

/** Bybit publishes each spot trade archive twice: a DAILY file the next day
 *  (`SYM_YYYY-MM-DD`) and a MONTHLY dump only after the month closes
 *  (`SYM-YYYY-MM`), same columns (daily adds a trailing `rpi`, unused here).
 *  Reading monthly dumps alone deferred every unmarked fill of the running
 *  month until the next month's dump landed — up to ~5 weeks of null markouts. */
const bybitDumpUrl = (symbol: string, name: string) => `https://public.bybit.com/spot/${symbol}/${name}.csv.gz`;

/** true when the archive is published (HEAD, no body) — lets a multi-file
 *  request fail fast BEFORE downloading any dump: without this, every boot
 *  re-downloaded a full month (~10²MB, tmp cache is wiped per deploy) only to
 *  defer on the NEXT file's 404. Non-404 probe failures return true (the GET
 *  decides — a flaky HEAD must not fabricate an "unpublished" verdict). */
async function bybitDumpExists(symbol: string, name: string): Promise<boolean> {
  if (existsSync(join(dumpDir(), `${name}.csv.gz`))) return true;
  try {
    const r = await fetch(bybitDumpUrl(symbol, name), { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    return r.status !== 404;
  } catch {
    return true;
  }
}

/** Download (once) a Bybit spot trade archive; returns local path or null (404 = not published). */
async function bybitDumpFile(symbol: string, name: string /* SYM-YYYY-MM | SYM_YYYY-MM-DD */): Promise<string | null> {
  const path = join(dumpDir(), `${name}.csv.gz`);
  if (existsSync(path)) return path;
  const url = bybitDumpUrl(symbol, name);
  // generous timeout: it covers the WHOLE body stream (a ~12MB file on a slow
  // link can exceed 2min), and pipeline() propagates every stream error into
  // the awaited promise (a bare .pipe() left source errors unhandled → crash).
  const r = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (r.status === 404) return null;
  if (!r.ok || !r.body) throw new Error(`bybit dump ${r.status} for ${name}`);
  const { pipeline } = await import('node:stream/promises');
  const { renameSync, rmSync } = await import('node:fs');
  try {
    await pipeline(Readable.fromWeb(r.body as any), createWriteStream(path + '.part'));
  } catch (e) {
    rmSync(path + '.part', { force: true }); // never leave a truncated cache file
    throw e;
  }
  renameSync(path + '.part', path);
  return path;
}

/** Per-second last-trade series for [fromMs, toMs) from Bybit trade archives:
 *  each month's dump when published, else that month's daily files for exactly
 *  the days in range. Returns null when a needed day isn't published yet — the
 *  caller defers those days to a later run rather than fabricating. */
export async function bybitTradeSeries(symbol: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const days: string[] = [];
  for (let t = Math.floor(fromMs / 86_400_000) * 86_400_000; t < toMs; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  // fail fast: resolve (probe) every needed file before downloading ANY of them.
  // Chronological order matters — makeSeries binary-searches the concatenation.
  const names: string[] = [];
  for (const month of [...new Set(days.map((d) => d.slice(0, 7)))]) {
    if (await bybitDumpExists(symbol, `${symbol}-${month}`)) { names.push(`${symbol}-${month}`); continue; }
    for (const day of days.filter((d) => d.startsWith(month))) {
      if (!(await bybitDumpExists(symbol, `${symbol}_${day}`))) return null;
      names.push(`${symbol}_${day}`);
    }
  }
  const ts: number[] = [], px: number[] = [];
  for (const name of names) {
    const file = await bybitDumpFile(symbol, name);
    if (!file) return null; // not published yet
    await new Promise<void>((resolve, reject) => {
      // wire EVERY stage's error into the promise — readline does not forward
      // input-stream errors, and an unhandled 'error' event kills the process.
      const raw = createReadStream(file);
      const gz = createGunzip();
      raw.on('error', reject);
      gz.on('error', reject);
      const rl = createInterface({ input: raw.pipe(gz), crlfDelay: Infinity });
      let lastSec = -1;
      rl.on('line', (line) => {
        // id,timestamp(ms),price,volume,side
        const c1 = line.indexOf(','); if (c1 < 0) return;
        const c2 = line.indexOf(',', c1 + 1); if (c2 < 0) return;
        const t = Number(line.slice(c1 + 1, c2));
        if (!Number.isFinite(t) || t < fromMs || t >= toMs) return;
        const c3 = line.indexOf(',', c2 + 1);
        const p = parseFloat(line.slice(c2 + 1, c3 < 0 ? undefined : c3));
        if (!(p > 0)) return;
        const sec = Math.floor(t / 1000);
        if (sec === lastSec) { ts[ts.length - 1] = t; px[px.length - 1] = p; } // keep the LAST trade of the second
        else { lastSec = sec; ts.push(t); px.push(p); }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });
  }
  if (!ts.length) return null;
  return makeSeries(ts, px, STALE_BASE_MS);
}

// ── pair-terms mid series (base × wrap ÷ quote leg — same construction as live) ──

/** an ASSET's own USDT-terms series at second precision — Binance 1s klines, or
 *  Bybit trade dumps for assets Binance doesn't list (MON). Null = the archive
 *  for part of the window isn't published yet. */
async function assetUsdtSeries(assetKey: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const a = assetOf(assetKey);
  if (!a) return null;
  return a.cex === 'binance'
    ? binanceKlineSeries(a.cexSymbol, '1s', fromMs - STALE_BASE_MS, toMs)
    : bybitTradeSeries(a.cexSymbol, fromMs - STALE_BASE_MS, toMs);
}

/**
 * The pair's CEX mid at second precision over [fromMs, toMs), in the PAIR'S OWN
 * terms — identical construction to the live ReferenceRegistry (§5.5), sourced
 * from the exchanges' historical archives:
 *
 *   mid(t) = baseUSDT(t) × wrapBasis(t) ÷ quoteLeg(t)
 *
 * wrapBasis resolves PER PAIR (wrapBasisFor — cbBTC pairs are parity-overridden,
 * WBTC pairs use the real WBTCBTC curve). The quote leg is a stable's USDT cross
 * at 1m (slow-moving) or, for ASSET-quoted pairs (MON/ETH …), the quote asset's
 * own 1s-precision series. Returns null when a required source isn't available
 * yet (e.g. the current month's Bybit dump) — the caller defers, never fabricates.
 */
export async function pairMidSeries(market: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const pair = pairOf(market);
  const asset = pair ? assetOf(pair.base) : undefined;
  if (!pair || !asset) return null;
  const pad = STALE_SLOW_MS; // lead-in so carry-forward has a value at fromMs

  const base = await assetUsdtSeries(pair.base, fromMs, toMs);
  if (!base) return null; // dump month not published yet

  const wrapSym = wrapBasisFor(pair);
  const wrap = wrapSym ? await binanceKlineSeries(wrapSym, '1m', fromMs - pad, toMs) : null;

  let quote: StepSeries | null = null;
  let quoteNeeded = false;
  if (pair.quoteKind === 'asset') {
    quoteNeeded = true;
    quote = await assetUsdtSeries(pair.quote, fromMs, toMs);
    if (!quote) return null; // quote asset's archive missing (e.g. MON dump month)
  } else {
    const crossSym = TOKENS[pair.quote]?.usdtCross;
    if (crossSym) {
      quoteNeeded = true;
      if (asset.cex === 'binance') {
        quote = await binanceKlineSeries(crossSym, '1m', fromMs - pad, toMs);
      } else {
        // api.bybit.com REST geo-blocks some server IPs (403 from Render US —
        // observed in prod; the dump host public.bybit.com is NOT blocked). The
        // same stable/stable cross trades on Binance within fractions of a bp,
        // so fall back to the geo-unrestricted Binance mirror.
        try { quote = await bybitKlineSeries(crossSym, fromMs - pad, toMs); }
        catch { quote = await binanceKlineSeries(crossSym, '1m', fromMs - pad, toMs); }
      }
    }
  }

  return {
    at(t: number): number | null {
      const b = base.at(t);
      if (b == null) return null;
      let v = b;
      if (wrapSym) { const w = wrap?.at(t); if (w == null) return null; v *= w; }
      if (quoteNeeded) { const q = quote?.at(t); if (q == null || q <= 0) return null; v /= q; }
      return v;
    },
  };
}
