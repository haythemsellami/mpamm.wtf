import { createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairOf, assetOf, TOKENS, wrapBasisFor } from '@shared';
import { config } from '../config.js';

/**
 * HISTORICAL CEX price series — the data source for venue-lifetime markouts.
 *
 * Live markouts age against the in-memory mid ring; historical fills need the
 * pair's CEX mid at second precision at times long past. Both exchanges publish
 * it, keylessly:
 *  - Bybit: daily ORDERBOOK archives (quote-saver.bycsi.com, the `orderbook.200`
 *    WS stream) replayed to a BBO-mid curve — the base series for MON AND the
 *    stable cross (USDCUSDT, USD1USDT) of Bybit-based pairs. A mid, not a trade
 *    print, on purpose: MONUSDT's 0.00001 tick is ~3.5bp at $0.03, and the last
 *    trade sits on whichever side the flow hit — flow correlated with the fill
 *    being marked. The public trade dumps this replaced marked T+0 ~+1.5bp
 *    above the live 100ms BBO-mid ring (4,208 live-marked MON/USDC fills,
 *    2026-09-29); the book mid agrees within 0.05bp at every horizon.
 *  - Binance: 1-SECOND klines via the geo-unrestricted data mirror (the base
 *    series for BTC/ETH; a last trade, but on a 0.01 tick that's ~0.001bp).
 * Binance-side cross (USDCUSDT, 0.00001 tick) and wrap (WBTCBTC) legs move
 * ~bps per hour, so 1-minute klines are ample for them (<0.1bp over 60s).
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

// ── Bybit daily orderbook archives → BBO-mid series ─────────────────────────

const dumpDir = () => {
  const d = process.env.HIST_CACHE_DIR ?? join(tmpdir(), 'mpamm-cex-dumps');
  mkdirSync(d, { recursive: true });
  return d;
};

/** Bybit's keyless historical-data host publishes each spot symbol's
 *  `orderbook.200` WS stream (snapshot + deltas, ~10ms) as ONE daily zip the
 *  next day (~00:10 UTC). Days are UTC; each file starts with a snapshot a few
 *  seconds after midnight and runs a few seconds past the next one. */
const bybitBookUrl = (symbol: string, day: string) =>
  `https://quote-saver.bycsi.com/orderbook/spot/${symbol}/${day}_${symbol}_ob200.data.zip`;
/** the day REDUCED to its BBO-mid curve — ~2 MB vs ~200 MB of raw book
 *  messages, so every venue × market remark of that day shares one download. */
const bookMidPath = (symbol: string, day: string) => join(dumpDir(), `${symbol}_${day}.bbo-mid.csv`);
/** a carry-forward point is re-emitted at least this often while messages
 *  arrive, so the staleness cap measures a FEED gap, not a quiet mid. */
const BOOK_HEARTBEAT_MS = 5_000;

/** true when the day's archive is published (HEAD, no body) — lets a multi-day
 *  request defer BEFORE downloading any file (the next day's file is what's
 *  usually missing). Non-404 probe failures return true: the GET decides, a
 *  flaky HEAD must not fabricate an "unpublished" verdict. */
async function bybitBookExists(symbol: string, day: string): Promise<boolean> {
  if (existsSync(bookMidPath(symbol, day))) return true;
  try {
    const r = await fetch(bybitBookUrl(symbol, day), { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    return r.status !== 404;
  } catch {
    return true;
  }
}

/** Strips a single-entry zip's local file header so the rest pipes straight
 *  into inflateRaw — no unzip binary on the host, no 200 MB temp file. The
 *  archives set the data-descriptor flag (sizes zeroed), which is fine: the
 *  deflate stream ends itself and inflateRaw ignores the trailing directory;
 *  a TRUNCATED body fails inflateRaw with "unexpected end of file". */
function zipEntryPayload(): Transform {
  let head: Buffer | null = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!head) return cb(null, chunk);
      head = Buffer.concat([head, chunk]);
      if (head.length < 30) return cb();
      if (head.readUInt32LE(0) !== 0x04034b50) return cb(new Error('bybit book archive: not a zip'));
      const method = head.readUInt16LE(8);
      if (method !== 8) return cb(new Error(`bybit book archive: zip method ${method} unsupported`));
      const start = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      if (head.length < start) return cb();
      const rest = head.subarray(start);
      head = null;
      cb(null, rest);
    },
  });
}

/** Replays one day's book messages and returns its BBO-mid curve over
 *  [dayStart, dayEnd), stamped with Bybit's send time (`ts` — what the live
 *  feed receives, not the matching-engine `cts`). Throws on any unparseable
 *  line: deltas are absolute per level, so a skipped one corrupts the book
 *  until the next snapshot (the archive has ~2 per day). */
export async function reduceBookMids(lines: AsyncIterable<string>, symbol: string, dayStart: number): Promise<{ ts: number[]; px: number[] }> {
  const dayEnd = dayStart + 86_400_000;
  const topic = `orderbook.200.${symbol}`;
  const bids = new Map<number, number>(), asks = new Map<number, number>();
  let bb = 0, ba = Infinity, lastMid = NaN, lastT = -Infinity;
  const ts: number[] = [], px: number[] = [];
  const recompute = () => {
    bb = 0; for (const p of bids.keys()) if (p > bb) bb = p;
    ba = Infinity; for (const p of asks.keys()) if (p < ba) ba = p;
  };
  for await (const line of lines) {
    if (!line) continue;
    const m = JSON.parse(line);
    if (m?.topic !== topic || !m.data) throw new Error(`bybit book archive ${symbol}: unexpected message ${String(line).slice(0, 80)}`);
    const t = Number(m.ts);
    let dirty = m.type === 'snapshot';
    if (dirty) { bids.clear(); asks.clear(); }
    for (const [p, s] of m.data.b ?? []) {
      const P = Number(p), S = Number(s);
      if (S === 0) { bids.delete(P); if (P === bb) dirty = true; } else { bids.set(P, S); if (P > bb) bb = P; }
    }
    for (const [p, s] of m.data.a ?? []) {
      const P = Number(p), S = Number(s);
      if (S === 0) { asks.delete(P); if (P === ba) dirty = true; } else { asks.set(P, S); if (P < ba) ba = P; }
    }
    if (dirty) recompute();
    // the file overlaps its neighbours by a few seconds — keep only its own day
    // so concatenated days stay sorted for makeSeries' binary search.
    if (!(t >= dayStart && t < dayEnd) || t < lastT) continue;
    if (!(bb > 0 && bb < ba)) continue; // one-sided/crossed: no honest mid
    const mid = (bb + ba) / 2;
    if (mid !== lastMid || t - lastT >= BOOK_HEARTBEAT_MS) { ts.push(t); px.push(mid); lastMid = mid; lastT = t; }
  }
  return { ts, px };
}

/** One day's BBO-mid curve — from the reduced cache, else downloaded, replayed
 *  and cached (write-then-rename: a crash never leaves a truncated cache).
 *  Null = not published yet. */
async function bybitBookDay(symbol: string, day: string): Promise<{ ts: number[]; px: number[] } | null> {
  const path = bookMidPath(symbol, day);
  if (!existsSync(path)) {
    const r = await fetch(bybitBookUrl(symbol, day), { signal: AbortSignal.timeout(600_000) });
    if (r.status === 404) return null;
    if (!r.ok || !r.body) throw new Error(`bybit book archive ${r.status} for ${symbol} ${day}`);
    const inflated = zipEntryPayload();
    const inflate = createInflateRaw();
    // pipeline() carries every stage's error into `done`; readline does not
    // forward input errors, so both are awaited together.
    const done = pipeline(Readable.fromWeb(r.body as any), inflated, inflate);
    const lines = createInterface({ input: inflate, crlfDelay: Infinity });
    let pts: { ts: number[]; px: number[] };
    try { [pts] = await Promise.all([reduceBookMids(lines, symbol, Date.parse(`${day}T00:00:00Z`)), done]); }
    catch (e) { inflate.destroy(); throw e; } // a bad line must also stop the download
    let out = '';
    for (let i = 0; i < pts.ts.length; i++) out += `${pts.ts[i]},${pts.px[i]}\n`;
    writeFileSync(path + '.part', out);
    renameSync(path + '.part', path);
    return pts;
  }
  const ts: number[] = [], px: number[] = [];
  for (const row of readFileSync(path, 'utf8').split('\n')) {
    const c = row.indexOf(',');
    if (c < 0) continue;
    ts.push(Number(row.slice(0, c))); px.push(Number(row.slice(c + 1)));
  }
  return { ts, px };
}

/** BBO-mid series for [fromMs, toMs) from Bybit's daily orderbook archives —
 *  the SAME quantity the live reference reads (BybitFeed.mid()/crossMid() are
 *  BBO mids), for the base leg and the stable cross alike. Null when a needed
 *  day isn't published yet — the caller defers rather than fabricating. */
export async function bybitBookMidSeries(symbol: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const days: string[] = [];
  for (let t = Math.floor(fromMs / 86_400_000) * 86_400_000; t < toMs; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  for (const day of days) if (!(await bybitBookExists(symbol, day))) return null; // fail fast
  const ts: number[] = [], px: number[] = [];
  for (const day of days) { // chronological — makeSeries binary-searches the concatenation
    const pts = await bybitBookDay(symbol, day);
    if (!pts) return null;
    for (let i = 0; i < pts.ts.length; i++) {
      const t = pts.ts[i];
      if (t >= fromMs && t < toMs) { ts.push(t); px.push(pts.px[i]); }
    }
  }
  if (!ts.length) return null;
  return makeSeries(ts, px, STALE_BASE_MS);
}

// ── pair-terms mid series (base × wrap ÷ quote leg — same construction as live) ──

/** an ASSET's own USDT-terms series at second precision — Binance 1s klines, or
 *  Bybit's orderbook BBO mid for assets Binance doesn't list (MON). Null = the
 *  archive for part of the window isn't published yet. */
async function assetUsdtSeries(assetKey: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const a = assetOf(assetKey);
  if (!a) return null;
  return a.cex === 'binance'
    ? binanceKlineSeries(a.cexSymbol, '1s', fromMs - STALE_BASE_MS, toMs)
    : bybitBookMidSeries(a.cexSymbol, fromMs - STALE_BASE_MS, toMs);
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
 * on the base's exchange — Binance 1m klines, or for Bybit-based pairs Bybit's
 * BBO mid, exactly what the live crossMid() reads — or, for ASSET-quoted pairs
 * (MON/ETH …), the quote asset's own series. Returns null when a required
 * source isn't available yet (e.g. yesterday's Bybit book archive) — the caller
 * defers, never fabricates.
 */
export async function pairMidSeries(market: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const pair = pairOf(market);
  const asset = pair ? assetOf(pair.base) : undefined;
  if (!pair || !asset) return null;
  const pad = STALE_SLOW_MS; // lead-in so carry-forward has a value at fromMs

  const base = await assetUsdtSeries(pair.base, fromMs, toMs);
  if (!base) return null; // archive day not published yet

  const wrapSym = wrapBasisFor(pair);
  const wrap = wrapSym ? await binanceKlineSeries(wrapSym, '1m', fromMs - pad, toMs) : null;

  let quote: StepSeries | null = null;
  let quoteNeeded = false;
  if (pair.quoteKind === 'asset') {
    quoteNeeded = true;
    quote = await assetUsdtSeries(pair.quote, fromMs, toMs);
    if (!quote) return null; // quote asset's archive missing (e.g. a MON book day)
  } else {
    const crossSym = TOKENS[pair.quote]?.usdtCross;
    if (crossSym) {
      quoteNeeded = true;
      if (asset.cex === 'binance') {
        quote = await binanceKlineSeries(crossSym, '1m', fromMs - pad, toMs);
      } else {
        // ONE source on every host, and the live one. This used to be Bybit 1m
        // klines falling back to Binance when api.bybit.com 403'd (Render US),
        // so prod and local marked the same fill against different crosses
        // (1.0002 vs 1.00032 — 1.2bp on a 2026-09-29 Hanji fill), and Bybit's
        // kline close is a last trade on a 0.0001 tick (1bp steps) where the
        // live cross is the half-tick BBO mid. The book archive host is the
        // keyless data CDN, not the REST API.
        quote = await bybitBookMidSeries(crossSym, fromMs - STALE_BASE_MS, toMs);
        if (!quote) return null; // cross day not published yet — defer, never peg
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
