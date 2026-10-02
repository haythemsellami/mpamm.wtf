import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bybitBookMidSeries, pairMidSeries, reduceBookMids } from '../cex.js';

/**
 * Bybit orderbook archives → BBO-mid series — no network. `fetch` serves
 * zips built here in the archive's exact layout (one deflated entry, data-
 * descriptor flag set — sizes zeroed locally, real ones in the descriptor and
 * central directory) and message format
 * (`orderbook.200.<SYM>` snapshot + absolute-size deltas, `ts` = send time);
 * every other URL 404s, i.e. "not published yet".
 */
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
type Lv = Array<[string, string]>;
// `u` counts up across every built message: a file's snapshot re-bases it and
// its deltas follow contiguously, as in the real archive.
let nextU = 1;
const msg = (sym: string, ts: number, type: 'snapshot' | 'delta', b: Lv, a: Lv, u = nextU++) =>
  JSON.stringify({ topic: `orderbook.200.${sym}`, ts, type, data: { s: sym, b, a, u, seq: u }, cts: ts - 10 });

function zip(name: string, body: string, opts: { crc?: number } = {}): Uint8Array {
  const n = Buffer.from(name), raw = Buffer.from(body), def = deflateRawSync(raw);
  const crc = opts.crc ?? crc32(raw);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0008, 6); h.writeUInt16LE(8, 8);
  h.writeUInt16LE(n.length, 26);
  const dd = Buffer.alloc(16);
  dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(def.length, 8); dd.writeUInt32LE(raw.length, 12);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0008, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(def.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(n.length, 28);
  const cdOffset = h.length + n.length + def.length + dd.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + n.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([h, n, def, dd, cd, n, eocd]));
}

let dir: string;
let files: Map<string, Uint8Array>;
let fetchMock: ReturnType<typeof vi.fn>;
const url = (sym: string, d: string) => `https://quote-saver.bycsi.com/orderbook/spot/${sym}/${d}_${sym}_ob200.data.zip`;
const publish = (sym: string, d: string, lines: string[]) => files.set(url(sym, d), zip(`${d}_${sym}_ob200.data`, lines.join('\n') + '\n'));
const gets = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'HEAD').map(([u]) => String(u));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bybit-archive-'));
  vi.stubEnv('HIST_CACHE_DIR', dir);
  files = new Map();
  fetchMock = vi.fn(async (u: string | URL, init?: RequestInit) => {
    const f = files.get(String(u));
    if (!f) return new Response(null, { status: 404 });
    return new Response(init?.method === 'HEAD' ? null : f, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

async function* lines(xs: string[]) { yield* xs; }

describe('reduceBookMids', () => {
  const D = day('2026-09-29');
  it('replays snapshot + deltas into the BBO mid, recomputing when the best level empties', async () => {
    const { ts, px } = await reduceBookMids(lines([
      msg('MONUSDT', D - 1_000, 'snapshot', [['0.02840', '5']], [['0.02842', '5']]), // previous file's day: dropped
      msg('MONUSDT', D + 1_000, 'snapshot', [['0.02850', '10'], ['0.02849', '10']], [['0.02851', '10'], ['0.02852', '10']]),
      msg('MONUSDT', D + 2_000, 'delta', [['0.02850', '7']], []),           // size change only: same mid
      msg('MONUSDT', D + 3_000, 'delta', [], [['0.02851', '0']]),           // best ask gone → 0.02852
      msg('MONUSDT', D + 4_000, 'delta', [['0.02851', '3']], []),           // bid improves
      msg('MONUSDT', D + 9_100, 'delta', [['0.02849', '1']], []),           // quiet mid: heartbeat point
      msg('MONUSDT', D + 86_400_500, 'delta', [['0.02860', '1']], []),      // next day's seconds: dropped
    ]), 'MONUSDT', D);
    expect(ts).toEqual([D + 1_000, D + 3_000, D + 4_000, D + 9_100]);
    expect(px.map((p) => +p.toFixed(6))).toEqual([0.028505, 0.02851, 0.028515, 0.028515]);
  });

  it('throws on a line it cannot replay (a skipped delta would corrupt the book)', async () => {
    await expect(reduceBookMids(lines([msg('MONUSDT', D + 1, 'snapshot', [['1', '1']], [['2', '1']]), '{"topic":"orderbook.200.MON']), 'MONUSDT', D)).rejects.toThrow();
    await expect(reduceBookMids(lines([msg('USDCUSDT', D + 1, 'snapshot', [['1', '1']], [['2', '1']])]), 'MONUSDT', D)).rejects.toThrow(/unexpected message/);
  });

  it('rejects a parseable but malformed record BEFORE it touches the book', async () => {
    const snap = msg('MONUSDT', D + 1_000, 'snapshot', [['0.0285', '1']], [['0.0286', '1']]);
    const raw = (o: object) => JSON.stringify({ topic: 'orderbook.200.MONUSDT', ts: D + 2_000, type: 'delta', data: { b: [], a: [] }, ...o });
    for (const [bad, why] of [
      [raw({ type: 'update' }), /unknown type/],
      [raw({ ts: 'soon' }), /non-finite ts/],
      [raw({ data: { b: [['0.0287', 'x']], a: [] } }), /bad level/],
      [raw({ data: { b: [['-1', '1']], a: [] } }), /bad level/],
      [raw({ data: { b: [['0.0287']], a: [] } }), /bad level/],
      [raw({ data: { a: [] } }), /not an array/],
    ] as const) {
      await expect(reduceBookMids(lines([snap, bad]), 'MONUSDT', D), bad).rejects.toThrow(why);
    }
  });

  it('throws on a gap in the update id (a dropped delta), re-basing on each snapshot', async () => {
    const snap = (t: number, u: number) => msg('MONUSDT', D + t, 'snapshot', [['0.0285', '1']], [['0.0286', '1']], u);
    const delta = (t: number, u: number) => msg('MONUSDT', D + t, 'delta', [['0.0285', '2']], [], u);
    await expect(reduceBookMids(lines([snap(1_000, 10), delta(2_000, 11), delta(3_000, 13)]), 'MONUSDT', D)).rejects.toThrow(/update id gap 11 → 13/);
    const { ts } = await reduceBookMids(lines([snap(1_000, 10), delta(2_000, 11), snap(3_000, 500), delta(4_000, 501)]), 'MONUSDT', D);
    expect(ts).toEqual([D + 1_000]);
  });

  it('applies but does not emit a regressed ts (book order is file order)', async () => {
    const { ts, px } = await reduceBookMids(lines([
      msg('MONUSDT', D + 5_000, 'snapshot', [['0.0285', '1']], [['0.0286', '1']]),
      msg('MONUSDT', D + 4_000, 'delta', [['0.02855', '1']], []), // regressed: applied, not emitted
      msg('MONUSDT', D + 6_000, 'delta', [['0.02840', '1']], []), // mid includes the regressed level
    ]), 'MONUSDT', D);
    expect(ts).toEqual([D + 5_000, D + 6_000]);
    expect(px.map((p) => +p.toFixed(6))).toEqual([0.02855, 0.028575]);
  });

  it('ignores deltas until the first snapshot (no book to apply them to)', async () => {
    const { ts } = await reduceBookMids(lines([
      msg('MONUSDT', D + 1_000, 'delta', [['0.0285', '1']], [['0.0286', '1']]),
      msg('MONUSDT', D + 2_000, 'snapshot', [['0.0284', '1']], [['0.0285', '1']]),
    ]), 'MONUSDT', D);
    expect(ts).toEqual([D + 2_000]);
  });
});

describe('bybitBookMidSeries', () => {
  const D = '2026-09-29', N = '2026-09-30';
  const book = (sym: string, d: string, mids: Array<[number, string, string]>) =>
    publish(sym, d, [
      // files overlap their neighbours by a few seconds, like the real archive
      msg(sym, day(d) - 2_000, 'snapshot', [['0.5', '1']], [['0.6', '1']]),
      ...mids.map(([t, b, a]) => msg(sym, day(d) + t, 'snapshot', [[b, '1']], [[a, '1']])),
    ]);

  it('stitches days chronologically and caches the reduced curve (one download per day)', async () => {
    book('MONUSDT', D, [[3_000, '0.02850', '0.02851'], [86_400_000 - 10_000, '0.02860', '0.02861']]);
    book('MONUSDT', N, [[3_000, '0.02870', '0.02871']]);
    const s = await bybitBookMidSeries('MONUSDT', day(D), day(N) + 120_000);
    expect(s?.at(day(D) + 4_000)).toBeCloseTo(0.028505, 9);
    expect(s?.at(day(N) + 1_000)).toBeCloseTo(0.028605, 9); // carries across midnight, not the overlap
    expect(s?.at(day(N) + 3_000)).toBeCloseTo(0.028705, 9);
    expect(s?.at(day(D) + 1_000)).toBeNull();              // before the first point
    expect(readdirSync(dir).sort()).toEqual([`MONUSDT_${D}.bbo-mid.csv`, `MONUSDT_${N}.bbo-mid.csv`]);
    expect(gets()).toHaveLength(2);
    const again = await bybitBookMidSeries('MONUSDT', day(D), day(N) + 120_000);
    expect(again?.at(day(N) + 3_000)).toBe(s?.at(day(N) + 3_000));
    expect(gets()).toHaveLength(2); // served from the reduced cache
  });

  it('defers (null) before downloading anything when a needed day is unpublished', async () => {
    book('MONUSDT', D, [[3_000, '0.02850', '0.02851']]);
    expect(await bybitBookMidSeries('MONUSDT', day(D), day(N) + 120_000)).toBeNull();
    expect(gets()).toEqual([]);
  });

  it('throws on a truncated download and leaves no cache file', async () => {
    book('MONUSDT', D, [[3_000, '0.02850', '0.02851']]);
    const full = files.get(url('MONUSDT', D))!;
    const payload = 30 + full[26]; // local header + name (no extra field)
    files.set(url('MONUSDT', D), full.subarray(0, payload + 4)); // cut inside the deflate stream
    await expect(bybitBookMidSeries('MONUSDT', day(D), day(D) + 60_000)).rejects.toThrow(/unexpected end/);
    expect(existsSync(join(dir, `MONUSDT_${D}.bbo-mid.csv`))).toBe(false);
  });

  it('throws when the body is cut off AFTER the deflate stream (directory missing)', async () => {
    book('MONUSDT', D, [[3_000, '0.02850', '0.02851']]);
    const full = files.get(url('MONUSDT', D))!;
    files.set(url('MONUSDT', D), full.subarray(0, full.length - 30)); // deflate + descriptor intact
    await expect(bybitBookMidSeries('MONUSDT', day(D), day(D) + 60_000)).rejects.toThrow(/directory/);
    expect(existsSync(join(dir, `MONUSDT_${D}.bbo-mid.csv`))).toBe(false);
  });

  it('throws on a CRC mismatch even though the payload inflates', async () => {
    files.set(url('MONUSDT', D), zip(`${D}_MONUSDT_ob200.data`, msg('MONUSDT', day(D) + 3_000, 'snapshot', [['0.0285', '1']], [['0.0286', '1']]) + '\n', { crc: 0xdeadbeef }));
    await expect(bybitBookMidSeries('MONUSDT', day(D), day(D) + 60_000)).rejects.toThrow(/CRC/);
    expect(existsSync(join(dir, `MONUSDT_${D}.bbo-mid.csv`))).toBe(false);
  });

  it('throws (and caches nothing) on a valid zip with no in-day book, so the next sweep re-fetches', async () => {
    publish('MONUSDT', D, [msg('MONUSDT', day(D) + 1_000, 'delta', [['0.0285', '1']], [['0.0286', '1']])]); // no snapshot
    await expect(bybitBookMidSeries('MONUSDT', day(D), day(D) + 60_000)).rejects.toThrow(/unusable archive/);
    expect(existsSync(join(dir, `MONUSDT_${D}.bbo-mid.csv`))).toBe(false);
    book('MONUSDT', D, [[3_000, '0.02850', '0.02851']]); // archive fixed upstream
    expect((await bybitBookMidSeries('MONUSDT', day(D), day(D) + 60_000))?.at(day(D) + 4_000)).toBeCloseTo(0.028505, 9);
  });

  it('a gap in the feed past the staleness cap yields null, never a carried mid', async () => {
    book('MONUSDT', D, [[3_000, '0.02850', '0.02851'], [600_000, '0.02850', '0.02851']]);
    const s = await bybitBookMidSeries('MONUSDT', day(D), day(D) + 86_400_000);
    expect(s?.at(day(D) + 60_000)).not.toBeNull();
    expect(s?.at(day(D) + 300_000)).toBeNull();
  });
});

describe('pairMidSeries — Bybit-based stable pair', () => {
  it('takes base AND cross from the book archive, on every host (no REST, no Binance)', async () => {
    const D = '2026-09-29', P = '2026-09-28', N = '2026-09-30';
    // the lead-in reaches into P, the 120s tail into N; a size-only delta every
    // minute keeps both feeds inside the staleness cap
    for (const [sym, b] of [['MONUSDT', '0.02875'], ['USDCUSDT', '1.0002']] as const) {
      for (const d of [P, D, N]) {
        const ls = [msg(sym, day(d) + 1_000, 'snapshot', [[b, '1']], [[sym === 'MONUSDT' ? '0.02876' : '1.0003', '1']])];
        for (let t = 60_000; t < 86_400_000; t += 60_000) ls.push(msg(sym, day(d) + t, 'delta', [[b, String(1 + (t % 7))]], []));
        publish(sym, d, ls);
      }
    }
    const s = await pairMidSeries('MON/USDC', day(D), day(D) + 86_400_000 + 120_000);
    // 0.028755 ÷ 1.00025 — the half-tick BBO mids, as the live crossMid() reads them
    expect(s?.at(day(D) + 52_131_000)).toBeCloseTo(0.028755 / 1.00025, 12);
    const hosts = new Set(fetchMock.mock.calls.map(([u]) => new URL(String(u)).host));
    expect([...hosts]).toEqual(['quote-saver.bycsi.com']);
  });

  it('defers (null) when the cross day is unpublished — never pegs the cross to 1', async () => {
    const D = '2026-09-29';
    for (const d of ['2026-09-28', D, '2026-09-30']) publish('MONUSDT', d, [msg('MONUSDT', day(d) + 1_000, 'snapshot', [['0.02875', '1']], [['0.02876', '1']])]);
    expect(await pairMidSeries('MON/USDC', day(D), day(D) + 86_400_000 + 120_000)).toBeNull();
  });
});
