import { describe, it, expect } from 'vitest';
import { decodeCloberTake, cloberTickToPrice, cloberLegFilledFull, assembleCloberMarkets, type CloberBook } from '../clober.js';
import { TOKENS } from '@shared';

/**
 * Fixture-based decode tests — the pattern every adapter PR should follow
 * (docs/adapters.md → Tests). The fixture is a REAL log captured from Monad
 * (tx 0x42991909…, block 86,746,586) with its book config from the Clober
 * subgraph; the expected values were computed independently of the adapter
 * (plain math from tick/unit/decimals). No network — fixtures only.
 */

/** MON/USDC vault book (base = native MON, quote = USDC, unitSize 1). */
const BOOK: CloberBook = {
  bookId: 5954885684956363054050231031211743946744177791604395877538n,
  base: '0x0000000000000000000000000000000000000000',
  quote: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
  unitSize: 1n,
  baseSym: 'MON',
  quoteSym: 'USDC',
  isVault: true,
};

const TAKE_LOG = {
  args: {
    bookId: 5954885684956363054050231031211743946744177791604395877538n,
    user: '0x553037Bac82741e7CA05AfB48e8538996fD70ECa',
    tick: -313882,
    unit: 296730680n,
  },
  transactionHash: '0x42991909a8e6b88ef087bf0f108ec882b191b8f1d77241cc92a3d2381547e2e7',
  blockNumber: 86746586n,
  logIndex: 6,
};

const TS = 1_783_600_000_000;

describe('decodeCloberTake (real MON/USDC vault Take)', () => {
  const books = new Map([[String(BOOK.bookId), BOOK]]);
  const fill = decodeCloberTake(TAKE_LOG, books, TS)!;

  it('decodes the fill', () => {
    expect(fill).not.toBeNull();
  });

  it('quote leg is exact: usd = unit × unitSize / 10^6', () => {
    expect(fill.usd).toBeCloseTo(296.73068, 5);
  });

  it('realized price from the resting tick (1.0001^tick × 10^(baseDec−stableDec))', () => {
    expect(fill.execPx).toBeCloseTo(0.023386190540000906, 12);
  });

  it('base amount = usd / execPx', () => {
    expect(fill.baseAmount).toBeCloseTo(12688.28625561983, 6);
  });

  it('a Take on a base-side book consumes resting bids ⇒ taker sells', () => {
    expect(fill.side).toBe('sell');
    expect(fill.market).toBe('MON/USDC');
  });

  it('deterministic id (txHash:logIndex) so re-tails dedupe', () => {
    expect(fill.id).toBe('clb-0x42991909a8e6b88ef087bf0f108ec882b191b8f1d77241cc92a3d2381547e2e7-6');
    expect(fill.venueId).toBe('clober-vault');
    expect(fill.blockNumber).toBe(86746586);
    expect(fill.ts).toBe(TS);
  });

  it('markouts start null — the core ages them vs the reference', () => {
    expect(fill.markoutsBps).toEqual([null, null, null, null, null]);
  });

  it('an unknown book decodes to null, never a bad fill', () => {
    expect(decodeCloberTake(TAKE_LOG, new Map(), TS)).toBeNull();
  });
});

describe('cloberTickToPrice', () => {
  it('base-side book: price = 1.0001^tick scaled by decimals', () => {
    expect(cloberTickToPrice(-313882, true, 6, 18)).toBeCloseTo(0.023386190540000906, 12);
  });

  it('quote-side (mirror) book inverts the tick', () => {
    const px = cloberTickToPrice(313882, false, 6, 18);
    expect(px).toBeCloseTo(0.023386190540000906, 12);
  });

  it('generic over base decimals (WBTC = 8, not 18)', () => {
    // same tick, 8-decimal base: scale shrinks by 10^10
    expect(cloberTickToPrice(-313882, true, 6, 8)).toBeCloseTo(0.023386190540000906e-10, 20);
  });
});

/**
 * getExpectedOutput legs recorded from the live MON/USDC vault book pair
 * (block ~107,844,301). Expected verdicts are from the raw numbers alone.
 */
describe('cloberLegFilledFull (unit-size rounding)', () => {
  it('a $100 sell that leaves sub-unit dust is a full fill', () => {
    // 3867.72 MON in → 99.883739 USDC out; 1.876e-5 MON (< one 1e-6 USDC unit) unspent
    expect(cloberLegFilledFull(3867723844517501220253n, 3867723825756573480247n, 99883739n, 1n)).toBe(true);
  });
  it('an exact fill is full', () => {
    expect(cloberLegFilledFull(100000000n, 100000000n, 3862171404234000000000n, 1000000000000n)).toBe(true);
  });
  it('a real partial on a thin book is not', () => {
    // $1000 buy: only 698.37 USDC of 1000 could be spent
    expect(cloberLegFilledFull(1000000000n, 698370382n, 24415081308693900000000n, 1000000000000n)).toBe(false);
    // $10k sell: 386,772 MON requested, 337,510 spent
    expect(cloberLegFilledFull(386772384451750083826482n, 337510314431399524539628n, 496331042n, 1n)).toBe(false);
  });
  it('accepts every leg the old 1e-9 relative check accepted', () => {
    const old = (req: bigint, spent: bigint) => spent >= (req * 999_999_999n) / 1_000_000_000n;
    for (const req of [1n, 999n, 100000000n, 1_000_000_001n, 3867723844517501220253n]) {
      const floor = (req * 999_999_999n) / 1_000_000_000n; // old acceptance boundary
      // unitSize 0 zeroes the unit-dust bound, isolating the relative one
      expect(old(req, floor)).toBe(true);
      expect(cloberLegFilledFull(req, floor, 1n, 0n)).toBe(true);
    }
  });
  it('nothing taken is never full', () => {
    expect(cloberLegFilledFull(100n, 99n, 0n, 1n)).toBe(false);
  });
});

describe('Clober wrapper-specific pairs (cbBTC ≠ WBTC)', () => {
  const usdc = TOKENS.USDC.address.toLowerCase();
  const book = (id: bigint, base: string, quote: string, baseSym: string, quoteSym: string): CloberBook =>
    ({ bookId: id, base: base.toLowerCase(), quote: quote.toLowerCase(), unitSize: 1n, baseSym, quoteSym, isVault: true });
  const wbtcSell = book(1n, TOKENS.WBTC.address, usdc, 'WBTC', 'USDC');
  const wbtcBuy = book(2n, usdc, TOKENS.WBTC.address, 'USDC', 'WBTC');
  const cbbtcSell = book(3n, TOKENS.CBBTC.address, usdc, 'cbBTC', 'USDC');

  it('WBTC books assemble into BTC/USDC only, never cbBTC/USDC', () => {
    const markets = assembleCloberMarkets(new Map([['1', wbtcSell], ['2', wbtcBuy]]));
    expect(markets.map((m) => m.market)).toEqual(['BTC/USDC']);
    expect(markets[0].baseToken).toBe('WBTC');
  });
  it('a cbBTC book assembles into cbBTC/USDC, sized as cbBTC', () => {
    const markets = assembleCloberMarkets(new Map([['3', cbbtcSell]]));
    expect(markets.map((m) => m.market)).toEqual(['cbBTC/USDC']);
    expect(markets[0].baseToken).toBe('CBBTC');
    expect(markets[0].baseBook).toBe(cbbtcSell);
  });
  it('a Take on a cbBTC book decodes to cbBTC/USDC, a WBTC book to BTC/USDC', () => {
    const take = (bookId: bigint) => ({ ...TAKE_LOG, args: { ...TAKE_LOG.args, bookId, tick: 0, unit: 1_000_000n } });
    const books = new Map([['1', wbtcSell], ['3', cbbtcSell]]);
    expect(decodeCloberTake(take(3n), books, TS)?.market).toBe('cbBTC/USDC');
    expect(decodeCloberTake(take(1n), books, TS)?.market).toBe('BTC/USDC');
  });
  it('MON books (native quote side) still resolve to the canonical pair', () => {
    const monBuy = book(4n, usdc, '0x0000000000000000000000000000000000000000', 'USDC', 'MON');
    const markets = assembleCloberMarkets(new Map([['0', BOOK], ['4', monBuy]]));
    expect(markets.map((m) => m.market)).toEqual(['MON/USDC']);
    expect(markets[0].baseToken).toBe('WMON');
    expect(markets[0].stableBook).toBe(monBuy);
  });
});
