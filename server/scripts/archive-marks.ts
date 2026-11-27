// Marks trades from the exchanges' archives the way today's remark sweep does
// (live.ts → remarkVenueMarket: pairMidSeries per market and UTC day, every
// horizon at ts + h s, taker-signed bps) and prints [{id, markoutsBps}] as
// JSON: the TypeScript half of the archive parity check; the Rust half is
// `mpamm-tools archive-marks`, and service/tools/compare-marks.py diffs them.
//   HIST_CACHE_DIR=/tmp/ts-archives npx tsx scripts/archive-marks.ts fills.json > ts-marks.json
//
// Each market-day's series covers [day start, the day's last mark] rather
// than the sweep's [day start, day end + 2 min]: the values are the same (a
// series is only filtered to its window), and a closed day is then marked
// without waiting for the next day's Bybit file.
import { readFileSync } from 'node:fs';
import { MARKOUT_HORIZONS, type Fill } from '@shared';
import { pairMidSeries } from '../src/history/cex.js';

const DAY = 86_400_000;
const fills: Fill[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const groups = new Map<string, Fill[]>();
for (const f of fills) {
  const key = `${f.market}|${Math.floor(f.ts / DAY) * DAY}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
}
const out: Array<{ id: string; markoutsBps: Array<number | null> | null }> = [];
const t0 = Date.now();
for (const [key, group] of groups) {
  const [market, start] = key.split('|');
  const dayStart = Number(start);
  const lastMark = Math.max(...group.map((f) => f.ts + MARKOUT_HORIZONS[MARKOUT_HORIZONS.length - 1] * 1000));
  const series = await pairMidSeries(market, dayStart, lastMark + 1);
  for (const f of group) {
    const ss = f.side === 'buy' ? 1 : -1;
    out.push({
      id: f.id,
      markoutsBps: series
        ? MARKOUT_HORIZONS.map((h) => {
          const mid = series.at(f.ts + h * 1000);
          return mid == null || mid <= 0 || f.execPx <= 0 ? null : ss * (mid / f.execPx - 1) * 1e4;
        })
        : null,
    });
  }
  process.stderr.write(`${market} ${new Date(dayStart).toISOString().slice(0, 10)}: ${group.length} trade(s), ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}
process.stdout.write(JSON.stringify(out) + '\n');
