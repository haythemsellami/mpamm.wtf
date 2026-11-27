// Marks trades from the exchanges' archives the way today's remark sweep does
// (live.ts → remarkVenueMarket: pairMidSeries per market and UTC day, every
// horizon at ts + h s, taker-signed bps) and prints one {id, markoutsBps} per
// line as each market-day is done: the TypeScript half of the archive parity
// check; the Rust half is `mpamm-tools archive-marks`, and
// service/tools/compare-marks.py diffs them.
//   HIST_CACHE_DIR=/tmp/ts-archives npx tsx scripts/archive-marks.ts fills.json > ts-marks.ndjson
//
// Each market-day's series covers [day start, the day's last mark] rather
// than the sweep's [day start, day end + 2 min]: the values are the same (a
// series is only filtered to its window), and a closed day is then marked
// without waiting for the next day's Bybit file. A market-day whose archive
// fetch fails is retried (the sweep retries it on its next pass); markets
// already in an earlier output (`--skip done.ndjson`) are left out.
import { existsSync, readFileSync } from 'node:fs';
import { MARKOUT_HORIZONS, type Fill } from '@shared';
import { pairMidSeries } from '../src/history/cex.js';

const DAY = 86_400_000;
const args = process.argv.slice(2);
const skipAt = args.indexOf('--skip');
const done = new Set<string>();
if (skipAt >= 0) {
  const path = args.splice(skipAt, 2)[1];
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split('\n')) if (line) done.add(JSON.parse(line).id);
}
const fills: Fill[] = JSON.parse(readFileSync(args[0], 'utf8'));
const groups = new Map<string, Fill[]>();
for (const f of fills) {
  if (done.has(f.id)) continue;
  const key = `${f.market}|${Math.floor(f.ts / DAY) * DAY}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
}
const t0 = Date.now();
for (const [key, group] of groups) {
  const [market, start] = key.split('|');
  const dayStart = Number(start);
  const lastMark = Math.max(...group.map((f) => f.ts + MARKOUT_HORIZONS[MARKOUT_HORIZONS.length - 1] * 1000));
  let series: Awaited<ReturnType<typeof pairMidSeries>> = null;
  for (let attempt = 1; ; attempt++) {
    try { series = await pairMidSeries(market, dayStart, lastMark + 1); break; }
    catch (e) {
      if (attempt >= 5) throw e;
      process.stderr.write(`${market}: ${(e as Error).message}; retrying\n`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  let lines = '';
  for (const f of group) {
    const ss = f.side === 'buy' ? 1 : -1;
    const markoutsBps = series
      ? MARKOUT_HORIZONS.map((h) => {
        const mid = series!.at(f.ts + h * 1000);
        return mid == null || mid <= 0 || f.execPx <= 0 ? null : ss * (mid / f.execPx - 1) * 1e4;
      })
      : null;
    lines += JSON.stringify({ id: f.id, markoutsBps }) + '\n';
  }
  process.stdout.write(lines);
  process.stderr.write(`${market} ${new Date(dayStart).toISOString().slice(0, 10)}: ${group.length} trade(s), ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}
