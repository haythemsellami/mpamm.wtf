// Writes today's archive answers (src/history/cex.ts) to
// service/crates/pricing/tests/archive-golden.json, which the Rust archives
// (service/crates/pricing/src/archives) are tested against:
//   npx tsx scripts/archive-golden.ts
//
// Three parts, all offline: the BBO-mid curve of a recorded Bybit archive's
// first 800 messages (tests/fixtures/bybit-MONUSDT-2026-11-26-head.zip); every
// registered pair's mid series from archives (pairMidSeries) over two windows,
// one across midnight, from synthetic book curves and klines with outages and
// gaps past each staleness cap; and assetUsdDay for a Binance and a Bybit
// asset. The synthetic inputs are written into the golden file too, so the
// Rust test replays exactly what this script served.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const DAY = 86_400_000, MIN = 60_000;
const P = Date.parse('2026-09-28T00:00:00Z'), D = P + DAY, N = D + DAY;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** [from, to) of each window; the second crosses midnight. */
const WINDOWS: Array<[number, number]> = [[D + 12 * 3_600_000, D + 12 * 3_600_000 + 15 * MIN], [N - 7.5 * MIN, N + 7.5 * MIN]];

// mulberry32: a fixed sequence, so the golden only changes when this does.
let seed = 0x5eed;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const round = (x: number, dp: number) => Number(x.toFixed(dp));

/** Book mid curves by symbol and day: [t, mid | null (outage)]. */
const bybit: Record<string, Record<string, Array<[number, number | null]>>> = {};
function bookPoints(sym: string, from: number, to: number, everyMs: [number, number], start: number, step: number, dp: number,
  holes: Array<[number, number, 'outage' | 'silent']>) {
  let t = from, px = start;
  while (t < to) {
    const hole = holes.find(([a, b]) => t >= a && t < b);
    if (hole) {
      if (hole[2] === 'outage') (bybit[sym][iso(hole[0])] ??= []).push([hole[0], null]);
      t = hole[1];
      continue;
    }
    px = round(px + (rand() < 0.5 ? -step : step) * Math.floor(rand() * 3), dp);
    (bybit[sym][iso(t)] ??= []).push([t, px]);
    t += Math.floor(everyMs[0] + rand() * (everyMs[1] - everyMs[0]));
  }
}
for (const sym of ['MONUSDT', 'USDCUSDT', 'USD1USDT']) bybit[sym] = { [iso(D)]: [], [iso(N)]: [] };
for (const [i, [from, to]] of WINDOWS.entries()) {
  const lead = from - 35 * MIN;
  // MON ticks every 1–6 s; an outage (one-sided book) at +5 min for 90 s, and a
  // silence past the 2-minute cap at +12 min.
  bookPoints('MONUSDT', from - 3 * MIN, to + 5_000, [1_000, 6_000], 0.02875, 0.000005, 6,
    [[from + 5 * MIN, from + 6.5 * MIN, 'outage'], [from + 12 * MIN, from + 14.5 * MIN, 'silent']]);
  // The stable crosses change every few minutes; USDC's goes quiet past the
  // 30-minute cap before the first window, and has an outage in the second.
  bookPoints('USDCUSDT', lead, to + 5_000, [MIN, 6 * MIN], 1.00025, 0.00005, 5,
    i === 0 ? [[lead + 4 * MIN, from + 2 * MIN, 'silent']] : [[from + 3 * MIN, from + 4 * MIN, 'outage']]);
  bookPoints('USD1USDT', lead, to + 5_000, [2 * MIN, 9 * MIN], 0.9992, 0.0001, 4, []);
}
for (const sym of Object.keys(bybit)) for (const day of Object.keys(bybit[sym])) bybit[sym][day].sort((a, b) => a[0] - b[0]);

/** Klines by "SYMBOL|interval": [openTime, close]. */
const binance: Record<string, Array<[number, number]>> = {};
function klines(key: string, from: number, to: number, stepMs: number, p: number, start: number, dp: number, rel: number, gaps: Array<[number, number]>) {
  const rows = (binance[key] ??= []);
  let px = start;
  for (let t = Math.floor(from / stepMs) * stepMs; t < to; t += stepMs) {
    px = round(px * (1 + (rand() - 0.5) * rel), dp);
    if (rand() < p && !gaps.some(([a, b]) => t >= a && t < b)) rows.push([t, px]);
  }
}
for (const [i, [from, to]] of WINDOWS.entries()) {
  klines('BTCUSDT|1s', from - 130_000, to + 1_000, 1_000, 0.3, 60_000, 2, 2e-5, i === 0 ? [[from + 8 * MIN, from + 10.5 * MIN]] : []);
  klines('ETHUSDT|1s', from - 130_000, to + 1_000, 1_000, 0.3, 2_400, 2, 3e-5, []);
  klines('XAUTUSDT|1s', from - 130_000, to + 1_000, 1_000, 0.2, 4_000, 1, 1e-5, []);
  // WBTCBTC stops 35 minutes before the second window and resumes 5 minutes
  // into it: a missing wrapper basis is no price, never parity.
  klines('WBTCBTC|1m', from - 40 * MIN, to + MIN, MIN, 1, 0.9995, 4, 2e-4, i === 1 ? [[from - 35 * MIN, from + 5 * MIN]] : []);
  klines('USDCUSDT|1m', from - 40 * MIN, to + MIN, MIN, 1, 1.0001, 5, 1e-4, []);
}
// A whole day of ETH 1-minute closes for assetUsdDay, with a 10-minute gap
// (not joined by a line).
klines('ETHUSDT|1m', D, N, MIN, 0.5, 2_400, 2, 1e-3, [[D + 7 * 3_600_000, D + 7 * 3_600_000 + 10 * MIN]]);
for (const key of Object.keys(binance)) binance[key].sort((a, b) => a[0] - b[0]);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'archive-golden-'));
  process.env.HIST_CACHE_DIR = dir;
  process.env.BACKFILL_PACE_MS = '0';
  const { PAIRS } = await import('@shared');
  const { pairMidSeries, assetUsdDay, reduceBookMids } = await import('../src/history/cex.js');

  // the reduced curves, as bybitBookDay caches them
  for (const [sym, days] of Object.entries(bybit)) {
    for (const [day, pts] of Object.entries(days)) {
      writeFileSync(join(dir, `${sym}_${day}.bbo-mid.csv`), pts.map(([t, p]) => `${t},${p ?? NaN}`).join('\n') + '\n');
    }
  }
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.pathname !== '/api/v3/klines') return new Response(null, { status: 404 });
    const q = url.searchParams, iv = q.get('interval')!, step = iv === '1s' ? 1_000 : MIN;
    const start = Number(q.get('startTime')), end = Number(q.get('endTime'));
    const rows = (binance[`${q.get('symbol')}|${iv}`] ?? []).filter(([t]) => t >= start && t <= end).slice(0, 1000)
      .map(([t, c]) => [t, '0', '0', '0', String(c), '0', t + step - 1, '0', 1, '0', '0', '0']);
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;

  /** Per window, the times every pair is read at; `mids` is null when the
   *  pair has no archive (pairMidSeries answered null with every day there). */
  const times: number[][] = [];
  const pairs: Array<{ market: string; window: number; mids: Array<number | null> | null }> = [];
  for (const [w, [from, to]] of WINDOWS.entries()) {
    const ts: number[] = [];
    for (let t = from; t < to; t += 31_111) ts.push(t);
    // exactly at, and just before, some book points and kline closes
    for (const [t] of bybit.MONUSDT[iso(from)].filter(([t]) => t >= from && t < to).slice(0, 5)) ts.push(t, t - 1);
    for (const [t] of binance['BTCUSDT|1s'].filter(([t]) => t >= from && t < to).slice(0, 5)) ts.push(t + 999, t + 998);
    ts.sort((a, b) => a - b);
    times.push(ts);
    for (const p of PAIRS) {
      const s = await pairMidSeries(p.symbol, from, to);
      pairs.push({ market: p.symbol, window: w, mids: s ? ts.map((t) => s.at(t)) : null });
    }
  }

  const assetDays: Array<{ asset: string; day: string; at: Array<[number, number]> }> = [];
  for (const asset of ['ETH', 'MON']) {
    const px = await assetUsdDay(asset, iso(D), N + 3 * DAY);
    if (!px) throw new Error(`assetUsdDay ${asset}: no answer`);
    const times: number[] = [D];
    for (let t = D + 1; t < N; t += 1_234_567) times.push(t);
    for (const [from, to] of WINDOWS) for (let t = from; t < Math.min(to, N); t += 61_111) times.push(t);
    times.push(D + 7 * 3_600_000 + 5 * MIN, N - 1);
    times.sort((a, b) => a - b);
    assetDays.push({ asset, day: iso(D), at: times.map((t) => [t, px.at(t)]) });
  }

  // a recorded archive's head: the zip's one entry, inflated
  const fixture = fileURLToPath(new URL('../../service/crates/pricing/tests/fixtures/bybit-MONUSDT-2026-11-26-head.zip', import.meta.url));
  const zip = readFileSync(fixture);
  const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const text = inflateRawSync(zip.subarray(start)).toString('utf8');
  async function* lines() { yield* text.split('\n'); }
  const book = await reduceBookMids(lines(), 'MONUSDT', Date.parse('2026-11-26T00:00:00Z'));

  rmSync(dir, { recursive: true, force: true });
  const out = {
    windows: WINDOWS, bybit, binance, times, pairs, assetDays,
    book: { symbol: 'MONUSDT', day: '2026-11-26', ts: book.ts, px: book.px.map((p) => (Number.isNaN(p) ? null : p)) },
  };
  const file = fileURLToPath(new URL('../../service/crates/pricing/tests/archive-golden.json', import.meta.url));
  // Fractional numbers as their JavaScript text: a JSON number parser may be
  // a unit in the last place off (serde_json's default is), a string parsed
  // by the reader's own float parser never is.
  const exact = (_k: string, v: unknown) =>
    typeof v === 'number' ? (Number.isNaN(v) ? null : Number.isInteger(v) ? v : String(v)) : v;
  writeFileSync(file, JSON.stringify(out, exact) + '\n');
  const priced = pairs.reduce((n, p) => n + (p.mids ?? []).filter((v) => v != null).length, 0);
  const nulls = pairs.reduce((n, p) => n + (p.mids ?? []).filter((v) => v == null).length, 0);
  console.log(`pairs ${pairs.length} (${pairs.filter((p) => p.mids).length} supported), marks ${priced} priced / ${nulls} null; book points ${book.ts.length}`);
}

await main();
