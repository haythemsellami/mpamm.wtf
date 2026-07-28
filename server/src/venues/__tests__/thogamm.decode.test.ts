import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import {
  THOGAMM_ADDRESS,
  decodeThogammSwap,
  indexThogammMarkets,
  thogammMarketsForTokens,
} from '../thogamm.js';

/**
 * The only MakerSwapExecuted log in ThogAMM's on-chain history when this
 * adapter was authored:
 * https://monadscan.com/tx/0xa7d17be22f83bb43b6fd983bdbf924a8ad5eb5eaf5ea1d89fa1572d4f9bc151f
 *
 * block 90,433,928 · log index 50 · 2026-07-26 08:08:16 UTC
 * 0.01 WMON in → 0.000210 USDC out, so realized px = 0.021 USDC/MON.
 */
const REAL_MON_USDC_FILL = {
  address: THOGAMM_ADDRESS,
  eventName: 'MakerSwapExecuted',
  args: {
    tokenIn: TOKENS.WMON.address,
    tokenOut: TOKENS.USDC.address,
    sender: '0xd364e667df69f393ae080a18236c4bcb8be7b4db',
    recipient: '0xd364e667df69f393ae080a18236c4bcb8be7b4db',
    amountIn: 10_000_000_000_000_000n,
    amountOut: 210n,
    quoteAgeBlocks: 1n,
    inventoryPenaltyUsdWad: 60_845_104_272n,
  },
  transactionHash: '0xa7d17be22f83bb43b6fd983bdbf924a8ad5eb5eaf5ea1d89fa1572d4f9bc151f',
  blockNumber: 90_433_928n,
  logIndex: 50,
};

const LIVE_TOKEN_ADDRESSES = [
  TOKENS.USDC.address,
  TOKENS.AUSD.address,
  TOKENS.USDT0.address,
  TOKENS.WMON.address,
  TOKENS.WETH.address,
  TOKENS.WBTC.address,
  TOKENS.CBBTC.address,
];
const MARKETS = thogammMarketsForTokens(LIVE_TOKEN_ADDRESSES);
const BY_DIRECTION = indexThogammMarkets(MARKETS);
const usdForToken = (tokenKey: string, amount: number) => {
  if (TOKENS[tokenKey]?.stable) return amount;
  const px: Record<string, number> = { WMON: 0.021, WETH: 3_800, WBTC: 118_000, CBBTC: 118_000 };
  return amount * (px[tokenKey] ?? 0);
};

describe('ThogAMM registered-market coverage', () => {
  it('lists every base/stable and crypto/crypto pair supported by the reference model', () => {
    expect(MARKETS.map((market) => market.market)).toEqual([
      'MON/USDC',
      'BTC/USDC',
      'ETH/USDC',
      'MON/USDT0',
      'MON/AUSD',
      'BTC/USDT0',
      'BTC/AUSD',
      'ETH/USDT0',
      'ETH/AUSD',
      'cbBTC/USDC',
      'cbBTC/USDT0',
      'cbBTC/AUSD',
      'MON/ETH',
      'BTC/MON',
      'BTC/ETH',
      'cbBTC/MON',
      'cbBTC/ETH',
      'WBTC/cbBTC',
    ]);
    expect(MARKETS).toHaveLength(18);
    expect(new Set(MARKETS.flatMap((market) => [market.base.address, market.quote.address]))).toEqual(new Set(LIVE_TOKEN_ADDRESSES));
    expect(BY_DIRECTION.size).toBe(36);
  });

  it('does not advertise pairs for a token absent from the on-chain registry', () => {
    const withoutCbBtc = thogammMarketsForTokens(LIVE_TOKEN_ADDRESSES.filter((address) => address !== TOKENS.CBBTC.address));
    expect(withoutCbBtc.some((market) => market.market.includes('cbBTC'))).toBe(false);
  });
});

describe('decodeThogammSwap (real Monad fixture)', () => {
  it('decodes exact token units, side, realized price and deterministic id', () => {
    const fill = decodeThogammSwap(REAL_MON_USDC_FILL, BY_DIRECTION, 1_785_053_296_000, usdForToken)!;
    expect(fill).toMatchObject({
      id: `thogamm-${REAL_MON_USDC_FILL.transactionHash}-50`,
      venueId: 'thogamm',
      market: 'MON/USDC',
      side: 'sell',
      category: 'UNKNOWN',
      usd: 0.00021,
      baseAmount: 0.01,
      execPx: 0.021,
      txHash: REAL_MON_USDC_FILL.transactionHash,
      to: '0xd364…b4db',
      blockNumber: 90_433_928,
      ts: 1_785_053_296_000,
      markoutsBps: [null, null, null, null, null],
    });
  });

  it('skips an unknown pair or malformed amount without wedging the cursor', () => {
    expect(decodeThogammSwap({
      ...REAL_MON_USDC_FILL,
      args: { ...REAL_MON_USDC_FILL.args, tokenOut: TOKENS.USD1.address },
    }, BY_DIRECTION, 0, usdForToken)).toBeNull();
    expect(decodeThogammSwap({
      ...REAL_MON_USDC_FILL,
      args: { ...REAL_MON_USDC_FILL.args, amountOut: 0n },
    }, BY_DIRECTION, 0, usdForToken)).toBeNull();
    expect(decodeThogammSwap({
      ...REAL_MON_USDC_FILL,
      blockNumber: 'not-a-block',
    }, BY_DIRECTION, 0, usdForToken)).toBeNull();
  });
});
