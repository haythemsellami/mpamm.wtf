import { describe, it, expect } from 'vitest';
import { quoteClober, type CloberBook, type CloberMarket } from '../clober.js';

/**
 * Clober's quote-outage verdict (quoteClober → createQuoteOutageLatch). The
 * vault can answer every leg and still quote nothing, so no leg reverts and
 * only the adapter can say why. Legs recorded live from the MON/USDC vault
 * books at block 109,422,525 (2026-10-01), $100 each side, while the vault
 * was dark on mpamm.wtf: both sides filled in full but swept far from the
 * 0.029085 mid.
 */

const MID = 0.029085;
const SELL_BOOK: CloberBook = {
  bookId: 5954885684956363054050231031211743946744177791604395877538n,
  base: '0x0000000000000000000000000000000000000000', quote: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
  unitSize: 1n, baseSym: 'MON', quoteSym: 'USDC', isVault: true,
};
const BUY_BOOK: CloberBook = {
  bookId: 3875727077379471850923186002296331935053867847116966170720n,
  base: '0x754704bc059f8c67012fed69bc8a327a5aafb603', quote: '0x0000000000000000000000000000000000000000',
  unitSize: 1n, baseSym: 'USDC', quoteSym: 'MON', isVault: true,
};
const MARKET: CloberMarket = { market: 'MON/USDC', stable: 'USDC', baseAsset: 'MON', baseToken: 'WMON', baseDec: 18, baseBook: SELL_BOOK, stableBook: BUY_BOOK };

/** [takenQuote, spentBase] per book, as getExpectedOutput returned it. */
const RECORDED = new Map<bigint, readonly [bigint, bigint]>([
  [SELL_BOOK.bookId, [25_156_797n, 3_438_197_658_764_939_368_693n]], // 3438 MON → 25.16 USDC
  [BUY_BOOK.bookId, [501_600_059_977_500_000_000n, 99_999_940n]],     // 99.99 USDC → 501.6 MON
]);

const clientFor = (legs: (id: bigint) => { status: 'success'; result: readonly [bigint, bigint] } | { status: 'failure'; error: unknown }) =>
  ({ multicall: async ({ contracts }: any) => contracts.map((c: any) => legs(c.args[0].id)) }) as any;
const recorded = clientFor((id) => ({ status: 'success', result: RECORDED.get(id)! }));
const pricer = (mid = MID) => ({ pairMid: () => mid, tokenForUsd: (_t: string, usd: number) => usd / MID }) as any;

describe('quoteClober outage verdict', () => {
  it('explains the recorded dark vault: every leg answered, none executable', async () => {
    const { rows, outage } = await quoteClober(recorded, [MARKET], [100], pricer(), 109_422_525n);
    expect(rows).toEqual([]);
    expect(outage?.reason).toBe('no vault book side fills $100 within ±2000 bps of mid');
    // sell: 25.156797 / 3438.19766 = 0.0073168 USDC/MON → −7484 bps (buy is +58545)
    expect(outage?.msg).toContain('(nearest: MON/USDC sell at −7484 bps');
    expect(outage?.msg).toContain('not an adapter fault');
  });

  it('reports a thin side by what it actually filled', async () => {
    // BTC-book shape seen the same day: the book stops after ~$1 of input.
    const thin = clientFor((id) => ({ status: 'success', result: id === SELL_BOOK.bookId ? [29_000n, 1_000_000_000_000_000_000n] : [0n, 0n] }));
    const { outage } = await quoteClober(thin, [MARKET], [100], pricer(), 1n);
    expect(outage?.msg).toMatch(/\(nearest: MON\/USDC sell at −\d+ bps, ~\$0\.03 of \$100 filled\)/);
  });

  it('reports the most executable side, not a dust leg that happens to sit at mid', async () => {
    // Live 2026-10-01: an ETH book's sell leg spent 3831 wei at +224 bps.
    // Here the dust sell sits at +112 bps (1 raw USDC for 3.4e-5 MON), far
    // closer to mid than the buy, so a bps-only ranking would pick it.
    const dustAtMid = clientFor((id) => ({ status: 'success', result: id === SELL_BOOK.bookId
      ? [1n, 34_000_000_000_000n] // 3.4e-5 MON in, ~$0.000001 filled
      : RECORDED.get(id)! }));    // buy: ~$100 at +58545 bps
    const { outage } = await quoteClober(dustAtMid, [MARKET], [100], pricer(), 1n);
    expect(outage?.msg).toContain('(nearest: MON/USDC buy at +58545 bps, ~$100.00 of $100 filled)');
  });

  it('does not call it a depth outage when some book calls failed', async () => {
    const mixed = clientFor((id) => id === SELL_BOOK.bookId
      ? { status: 'failure', error: Object.assign(new Error('x'), { reason: 'book not open' }) }
      : { status: 'success', result: RECORDED.get(id)! });
    const { outage } = await quoteClober(mixed, [MARKET], [100], pricer(), 1n);
    expect(outage?.reason).toBe('some book calls failed with "book not open"');
    expect(outage?.msg).toContain('1 of 2 book calls failed with "book not open", and no answered side fills $100');
    expect(outage?.msg).not.toContain('not an adapter fault');
  });

  it('names a market it could not price instead of withholding the verdict', async () => {
    // A cold reference leaves a market with no legs, so it cannot quote this
    // frame either way. The warm books still explain the outage.
    const btc: CloberMarket = { ...MARKET, market: 'BTC/USDC', baseAsset: 'BTC', baseToken: 'WBTC', baseDec: 8 };
    const coldBtc = { pairMid: (m: string) => (m === 'BTC/USDC' ? 0 : MID), tokenForUsd: (_t: string, usd: number) => usd / MID } as any;
    const { outage } = await quoteClober(recorded, [MARKET, btc], [100], coldBtc, 1n);
    expect(outage?.reason).toBe('no vault book side fills $100 within ±2000 bps of mid');
    expect(outage?.msg).toContain('; not priced, reference cold: BTC/USDC)');
  });

  it('clears once a side is executable again', async () => {
    const healthy = clientFor((id) => ({ status: 'success', result: id === SELL_BOOK.bookId
      ? [99_800_000n, 3_438_198_384_046_759_497_000n] // 3438.198 MON → $99.80, −20 bps
      : [0n, 0n] }));
    const { rows, outage } = await quoteClober(healthy, [MARKET], [100], pricer(), 1n);
    expect(rows).toHaveLength(1);
    expect(rows[0].oneSided).toBe(true);
    expect(outage).toBeNull();
  });

  it('names the shared revert when every leg fails, worded like the multicall reporter', async () => {
    const reverted = clientFor(() => ({ status: 'failure', error: Object.assign(new Error('x'), { reason: 'book not open' }) }));
    const { outage } = await quoteClober(reverted, [MARKET], [100], pricer(), 1n);
    expect(outage).toEqual({ reason: 'book not open', msg: 'Clober quotes unavailable — all 2 legs failed with "book not open" (venue disabled, or the ABI drifted from the contract)' });
  });

  it('gives no verdict when nothing could be priced (cold reference)', async () => {
    const { rows, outage } = await quoteClober(recorded, [MARKET], [100], pricer(0), 1n);
    expect(rows).toEqual([]);
    expect(outage).toBeUndefined();
  });
});
