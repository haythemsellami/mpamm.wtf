import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bybitTradeSeries } from '../cex.js';

/**
 * Archive selection for the Bybit trade series — no network. Fixture archives
 * sit in HIST_CACHE_DIR (which the loader treats as already downloaded); every
 * other URL 404s, i.e. "not published yet". Layout mirrors public.bybit.com:
 * monthly `SYM-YYYY-MM` after the month closes, daily `SYM_YYYY-MM-DD` next day.
 */
const SYM = 'MONUSDT';
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
let dir: string;
const put = (name: string, rows: Array<[number, number]>, rpi = false) =>
  writeFileSync(join(dir, `${name}.csv.gz`), gzipSync(
    [rpi ? 'id,timestamp,price,volume,side,rpi' : 'id,timestamp,price,volume,side',
      ...rows.map(([t, p], i) => `${i + 1},${t},${p},100,buy${rpi ? ',0' : ''}`)].join('\n')));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bybit-archive-'));
  vi.stubEnv('HIST_CACHE_DIR', dir);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('bybitTradeSeries archive selection', () => {
  it('uses the daily file while the running month has no monthly dump', async () => {
    const t = day('2026-09-16') + 3_600_000;
    put(`${SYM}_2026-09-16`, [[t, 0.0217], [t + 5_000, 0.0219]], true);
    const s = await bybitTradeSeries(SYM, day('2026-09-16'), day('2026-09-17'));
    expect(s?.at(t + 1_000)).toBe(0.0217);
    expect(s?.at(t + 6_000)).toBe(0.0219);
  });

  it('defers (null) when a needed day is not published yet', async () => {
    put(`${SYM}_2026-09-16`, [[day('2026-09-16') + 1_000, 0.02]]);
    // the markout window runs past midnight into the 17th, whose file is missing
    expect(await bybitTradeSeries(SYM, day('2026-09-16'), day('2026-09-17') + 120_000)).toBeNull();
  });

  it('prefers the monthly dump, and stitches month → daily chronologically', async () => {
    const aug = day('2026-08-31') + 86_000_000, sep = day('2026-09-01') + 60_000;
    put(`${SYM}-2026-08`, [[aug, 0.03]]);
    put(`${SYM}_2026-08-31`, [[aug, 999]]); // must NOT be read — monthly wins
    put(`${SYM}_2026-09-01`, [[sep, 0.031]]);
    const s = await bybitTradeSeries(SYM, day('2026-08-31'), day('2026-09-01') + 120_000);
    expect(s?.at(aug + 1_000)).toBe(0.03);
    expect(s?.at(sep + 1_000)).toBe(0.031);
  });
});
