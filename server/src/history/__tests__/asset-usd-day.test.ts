// assetUsdDay (history/cex.ts): one asset's USD price over a closed UTC day,
// what a history replay values a crypto-quoted fill with. The three answers
// matter as much as the prices: a series, null (no archive will ever answer:
// keep the live price), or a throw (the archive is on its way: hold). No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetUsdDay } from '../cex.js';

const DAY = '2026-10-14';
const D = Date.parse(`${DAY}T00:00:00Z`);
const MIN = 60_000;

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
/** Binance klines keyed by symbol: [openTime, close] rows, served 1000 a page like the API */
let klines: Record<string, Array<[number, number]>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'asset-usd-day-'));
  vi.stubEnv('HIST_CACHE_DIR', dir);
  klines = {};
  fetchMock = vi.fn(async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.pathname !== '/api/v3/klines') return new Response(null, { status: 404 }); // Bybit: not published
    const start = Number(url.searchParams.get('startTime')), end = Number(url.searchParams.get('endTime'));
    const rows = (klines[url.searchParams.get('symbol')!] ?? []).filter(([t]) => t >= start && t <= end).slice(0, 1000)
      .map(([t, c]) => [t, '0', '0', '0', String(c), '0', t + MIN - 1]);
    return new Response(JSON.stringify(rows), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

/** a day already reduced to its BBO-mid curve, as bybitBookDay caches it */
const cacheBookDay = (symbol: string, day: string, pts: Array<[number, number]>) =>
  writeFileSync(join(dir, `${symbol}_${day}.bbo-mid.csv`), pts.map(([t, p]) => `${t},${p}`).join('\n') + '\n');

describe('assetUsdDay', () => {
  it('serves a Binance asset from one day of 1-minute klines, on a line between the two closes around the instant', async () => {
    // a full day, ETH drifting 2,400 → 2,543.9
    klines.ETHUSDT = Array.from({ length: 1440 }, (_, i) => [D + i * MIN, 2_400 + i * 0.1] as [number, number]);
    klines.ETHUSDT.push([D + 1440 * MIN, 9_999]); // the next day's first minute: not ours
    const px = (await assetUsdDay('ETH', DAY))!;
    expect(px.at(D + 10 * MIN - 1)).toBeCloseTo(2_400.9, 9);            // minute 9's close, at its close time
    expect(px.at(D + 10 * MIN + 30_000 - 1)).toBeCloseTo(2_400.95, 9);  // halfway to minute 10's: no 30s-old price
    expect(px.at(D + 11 * MIN - 1)).toBeCloseTo(2_401.0, 9);
    expect(px.at(D + 86_400_000 - 1)).toBeCloseTo(2_543.9, 9);          // the day's last close, never the next day's
    expect(px.at(D)).toBe(2_400);                                       // before the first close: the first price
    const calls = fetchMock.mock.calls.map(([u]) => new URL(String(u)));
    expect(calls).toHaveLength(2);                                      // 1,440 rows, 1,000 a page
    expect(calls.every((u) => u.searchParams.get('symbol') === 'ETHUSDT' && u.searchParams.get('interval') === '1m')).toBe(true);
    expect(calls[0].searchParams.get('startTime')).toBe(String(D));
    expect(calls[0].searchParams.get('endTime')).toBe(String(D + 86_400_000 - 1));
  });

  it('carries the last price through an exchange outage: hours old still beats the day of the replay', async () => {
    klines.BTCUSDT = [[D, 111_000], [D + MIN, 111_100], [D + 9 * 3_600_000, 112_000]];
    const px = (await assetUsdDay('BTC', DAY))!;
    expect(px.at(D + MIN + 30_000 - 1)).toBeCloseTo(111_050, 6);  // between two consecutive closes: joined
    expect(px.at(D + 5 * 3_600_000)).toBe(111_100);               // across the gap: carried, not drawn toward 112,000
    expect(px.at(D + 10 * 3_600_000)).toBe(112_000);
  });

  it('is null for a Binance day with no klines: the symbol did not trade, and never will have', async () => {
    expect(await assetUsdDay('XAUt', DAY)).toBeNull();
  });

  it('is null for a Kraken xStock without asking anyone: there is no keyless archive', async () => {
    expect(await assetUsdDay('SPYx', DAY)).toBeNull();
    expect(await assetUsdDay('DOGE', DAY)).toBeNull(); // unregistered
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads MON off the day's whole Bybit book-mid curve: the last mid at or before the instant, over outage points", async () => {
    cacheBookDay('MONUSDT', DAY, [
      [D + 4_200, 0.02440],            // the file starts a few seconds after midnight
      [D + 30_000, 0.02442],
      [D + 59_900, 0.02444],
      [D + MIN + 100, 0.02450],
      [D + MIN + 50_000, NaN],         // one-sided book: no mid, not a price
      [D + 5 * MIN + 1, 0.02460],
    ]);
    const px = (await assetUsdDay('MON', DAY))!;
    expect(px.at(D)).toBe(0.02440);                 // before the first mid: the first one
    expect(px.at(D + 30_000)).toBe(0.02442);        // to the second, not a minute's close: swaps bunch up when MON runs
    expect(px.at(D + 45_000)).toBe(0.02442);        // a mid stands until the book moves, never a line to the next
    expect(px.at(D + 59_900)).toBe(0.02444);
    expect(px.at(D + MIN)).toBe(0.02444);
    expect(px.at(D + MIN + 100)).toBe(0.02450);
    expect(px.at(D + 3 * MIN)).toBe(0.02450);       // through the outage, not NaN
    expect(px.at(D + 5 * MIN + 1)).toBe(0.02460);
    expect(fetchMock).not.toHaveBeenCalled();       // the reduced day is on disk
  });

  it('throws for a Bybit day not published yet: the replay holds instead of pricing it from today', async () => {
    const now = D + 86_400_000 + 4 * 3_600_000; // four hours after the day closed
    await expect(assetUsdDay('MON', DAY, now)).rejects.toThrow('bybit book archive MONUSDT 2026-10-14 is not published yet');
  });

  it('retries a download that failed before giving up: one dropped connection must not pause a whole scan', async () => {
    const now = D + 86_400_000 + 4 * 3_600_000;
    let attempts = 0;
    fetchMock.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new TypeError('fetch failed'); // a connect timeout, as undici reports it
      return new Response(null, { status: 404 });
    });
    // the third attempt gets an answer; here it is "not published", which is thrown as itself
    await expect(assetUsdDay('MON', DAY, now)).rejects.toThrow('is not published yet');
    expect(attempts).toBe(3);

    attempts = 0;
    fetchMock.mockImplementation(async () => { attempts++; throw new TypeError('fetch failed'); });
    await expect(assetUsdDay('MON', DAY, now)).rejects.toThrow('fetch failed');
    expect(attempts).toBe(3); // bounded: the scan's own pause-and-retry takes over
  });

  it('is null for a Bybit day still missing days after it closed: it is not coming, and a replay must not wait forever', async () => {
    const now = D + 86_400_000 + 3 * 86_400_000 + 1;
    expect(await assetUsdDay('MON', DAY, now)).toBeNull();
  });
});
