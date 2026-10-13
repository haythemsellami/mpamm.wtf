import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuoteRow } from '@shared';
import { createHanjiAdapter } from '../hanji.js';

/**
 * Hanji quotes walk the proxy book, and the book carries far-tick stub orders
 * below the vault's ladder (MON/USDC bids 1 MON @ $0.001 + 10,000 MON @
 * $0.0001, asks 1 MON @ $10,000 + @ $24,172; a cbBTC/MON bid of 1 cbBTC @ 1
 * MON). Walking into them published "full two-sided" rows at −5728 bps and
 * ~−9961 bps, which fed ROLLING_STATS. Books recorded on the archive RPC at the
 * blocks the 7-day replay flagged (fixtures/hanji-books.json).
 *
 * Reference mids: cbBTC/MON is the replay's CEX pair mid at 110,682,151; the
 * MON/USDC mids are the vault's BBO midpoint at each block (the CEX series is
 * not recorded) — the band is ±2000 bps, so a few-bps stand-in can't move a
 * level across it.
 */

const configFixture = JSON.parse(readFileSync(new URL('./fixtures/hanji-config.json', import.meta.url), 'utf8')) as {
  markets: Array<{ address: string; result: string[] }>;
};
const configRows = new Map(configFixture.markets.map((m) => [m.address.toLowerCase(), m.result.map((v, i) =>
  [2, 3, 6, 7].includes(i) ? v : BigInt(v))]));

const bookFixture = JSON.parse(readFileSync(new URL('./fixtures/hanji-books.json', import.meta.url), 'utf8')) as {
  books: Array<{ block: number; market: string; proxy: string; result: string[][] }>;
};

const MIDS: Record<number, Record<string, number>> = {
  110682151: { 'MON/USDC': 0.032328, 'cbBTC/MON': 2655237.9 },
  110960000: { 'MON/USDC': 0.029299 }, // bid ladder empty: just under the best ask
  112661510: { 'MON/USDC': 0.0266755 },
};
const SIZES = [100, 1_000, 10_000, 100_000];

async function quoteAt(block: number, market: string): Promise<QuoteRow[]> {
  const mids = MIDS[block];
  const monUsd = mids['MON/USDC'];
  const usdPer: Record<string, number> = { WMON: monUsd, CBBTC: (mids['cbBTC/MON'] ?? 0) * monUsd };
  const multicall = async ({ contracts }: any) => contracts.map((c: any) => {
    if (c.functionName === 'getConfig') return { status: 'success', result: configRows.get(c.address.toLowerCase()) };
    const book = bookFixture.books.find((b) => b.block === block && b.proxy.toLowerCase() === c.args[0].toLowerCase());
    if (!book) return { status: 'failure', error: new Error('no recorded book') };
    return { status: 'success', result: book.result.map((a) => a.map(BigInt)) };
  });
  const ctx = {
    client: { multicall },
    note: () => {},
    pricer: { pairMid: (m: string) => mids[m] ?? 0, tokenForUsd: (t: string, usd: number) => (usdPer[t] ? usd / usdPer[t] : 0) },
  } as any;
  const adapter = createHanjiAdapter();
  await adapter.discover(ctx);
  return adapter.quote!(ctx, SIZES, BigInt(block), new Set([market]));
}

const bySize = (rows: QuoteRow[]) => new Map(rows.map((r) => [r.sizeUsd, r]));

describe('Hanji quote walk ignores far-tick stub orders', () => {
  it('never publishes a side beyond ±2000 bps of mid on any recorded book', async () => {
    for (const { block, market } of bookFixture.books) {
      for (const r of await quoteAt(block, market)) {
        if (r.bidPx > 0) expect(Math.abs(r.bidBps), `${market}@${block} $${r.sizeUsd} bid`).toBeLessThanOrEqual(2_001);
        if (r.askPx > 0) expect(Math.abs(r.askBps), `${market}@${block} $${r.sizeUsd} ask`).toBeLessThanOrEqual(2_001);
      }
    }
  });

  it('hand-verified $100 MON/USDC at 112,661,510: best level ± 1bp taker fee', async () => {
    const r = bySize(await quoteAt(112661510, 'MON/USDC')).get(100)!;
    // 100 / 0.0266755 = 3748.8 MON — inside level 0 on both sides (72,667 bid / 63,837 ask shares)
    expect(r.askPx).toBeCloseTo(0.026678 * 1.0001, 12);
    expect(r.bidPx).toBeCloseTo(0.026673 * 0.9999, 12);
    expect(r.askBps).toBeCloseTo(1.94, 1);
    expect(r.bidBps).toBeCloseTo(-1.94, 1);
    expect(r).toMatchObject({ filledFull: true, feeBps: 1 });
    expect(r.oneSided).toBeUndefined();
  });

  it('$100k MON/USDC at 112,661,510 is a partial at an in-band VWAP, not a +20,079 bps ask', async () => {
    const r = bySize(await quoteAt(112661510, 'MON/USDC')).get(100_000)!;
    // the vault ladder holds ~$19k bid / ~$17k ask; past it are only the stubs
    expect(r.filledFull).toBe(false);
    expect(r.askBps).toBeGreaterThan(0);
    expect(r.askBps).toBeLessThan(30);
    expect(r.bidBps).toBeLessThan(0);
    expect(r.bidBps).toBeGreaterThan(-30);
  });

  it('$10k cbBTC/MON at 110,682,151: the thin bid is a partial, not a full fill at −5728 bps', async () => {
    const r = bySize(await quoteAt(110682151, 'cbBTC/MON')).get(10_000)!;
    // in-band bid depth is 0.0498 cbBTC (~$4.3k); the rest was a 1-cbBTC bid @ 1 MON
    expect(r.filledFull).toBe(false);
    expect(r.oneSided).toBeUndefined();
    expect(r.bidBps).toBeGreaterThan(-20);
    expect(r.askBps).toBeCloseTo(-0.7, 0); // the replay's ask, unchanged
    // the smaller sizes fit inside the vault ladder and stay full two-sided
    const small = bySize(await quoteAt(110682151, 'cbBTC/MON')).get(1_000)!;
    expect(small).toMatchObject({ filledFull: true });
    expect(small.oneSided).toBeUndefined();
  });

  it('an empty vault bid ladder (110,960,000) leaves the row one-sided, not a ~$0 bid', async () => {
    const r = bySize(await quoteAt(110960000, 'MON/USDC')).get(100)!;
    expect(r).toMatchObject({ oneSided: true, filledFull: true, bidPx: 0, bidBps: 0, spreadBps: 0 });
    expect(r.askPx).toBeCloseTo(0.0293 * 1.0001, 12);
  });
});
