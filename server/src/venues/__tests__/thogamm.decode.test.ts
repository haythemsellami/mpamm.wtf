import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import {
  THOGAMM_ADDRESS,
  createThogammAdapter,
  decodeThogammSwap,
  indexThogammMarkets,
  selectThogammPoolId,
  thogammMarketsForTokens,
} from '../thogamm.js';
import type { VenueAdapter } from '../adapter.js';

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

describe('ThogAMM pool discovery', () => {
  it('follows a sole rotated id and rejects zero or multiple pools', () => {
    const v1 = '0xce389e78282dedac7b18ba7f775b7602d2ab3ab171bbd6711eb0239be6ef4dcc' as const;
    const v2 = '0x2222222222222222222222222222222222222222222222222222222222222222' as const;
    expect(selectThogammPoolId([v1])).toBe(v1);
    expect(selectThogammPoolId([v2])).toBe(v2);
    expect(() => selectThogammPoolId([])).toThrow('expected exactly one pool id, got 0');
    expect(() => selectThogammPoolId([v1, v2])).toThrow('expected exactly one pool id, got 2');
  });
});

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

/** Minimal ctx: discovery reads are stubbed to the live 7-token registry, so
 *  decode() can exercise the upgrade path with no network. */
const stubCtx = (notes: string[], codes: string[] = []) => ({
  client: {
    getBlockNumber: async () => 91_000_000n,
    readContract: async ({ functionName }: any) =>
      functionName === 'getPoolIds'
        ? ['0xce389e78282dedac7b18ba7f775b7602d2ab3ab171bbd6711eb0239be6ef4dcc']
        : LIVE_TOKEN_ADDRESSES,
    multicall: async ({ contracts }: any) =>
      contracts.map((c: any) => ({
        status: 'success',
        result: Object.values(TOKENS).find((t) => t.address.toLowerCase() === String(c.address).toLowerCase())!.decimals,
      })),
  },
  pricer: { usdForToken: (key: string, amount: number) => usdForToken(key, amount) },
  note: (code: string, m: string) => { codes.push(code); notes.push(m); },
}) as any;

describe('ThogAMM proxy upgrades', () => {
  it('announces every upgrade loudly — an ABI shift would silence fills otherwise', async () => {
    const notes: string[] = [];
    const codes: string[] = [];
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes, codes);
    await adapter.discover(ctx);
    notes.length = 0;

    const upgrade = (impl: string) => ({ address: THOGAMM_ADDRESS, eventName: 'Upgraded', args: { implementation: impl }, blockNumber: 91_000_000n, logIndex: 1, transactionHash: `0x${'a'.repeat(64)}` });
    await adapter.decode(ctx, { upgrades: [upgrade('0x127a5b18e3e96fc104f5eaf280dfe502dd3fd40a')], swaps: [] } as any, () => 0, new Set());

    expect(notes.filter((n) => n.includes('proxy upgraded'))).toHaveLength(1);
    expect(notes[0]).toContain('0x127a…d40a');
    expect(notes[0]).toContain('re-verify');
    // classified at the emit site — a consumer filters on the code, not the wording.
    expect(codes).toContain('venue.upgraded');
    // discovery re-ran (the token registry can change with the implementation)
    expect(notes.some((n) => n.includes('registered market(s)'))).toBe(true);
  });

  it('notes each implementation in a multi-upgrade range, and tolerates a malformed arg', async () => {
    const notes: string[] = [];
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes);
    await adapter.discover(ctx);
    notes.length = 0;

    await adapter.decode(ctx, {
      upgrades: [
        { address: THOGAMM_ADDRESS, eventName: 'Upgraded', args: { implementation: '0xaea051d2d7c0f4a5b6d3e2f1a0b9c8d7e6f5a4b3' }, blockNumber: 1n, logIndex: 0 },
        { address: THOGAMM_ADDRESS, eventName: 'Upgraded', args: {}, blockNumber: 2n, logIndex: 0 },
      ],
      swaps: [],
    } as any, () => 0, new Set());

    const upgradeNotes = notes.filter((n) => n.includes('proxy upgraded'));
    expect(upgradeNotes).toHaveLength(2);
    expect(upgradeNotes[0]).toContain('0xaea0…a4b3');
    expect(upgradeNotes[1]).toContain('an unreadable implementation');
  });

  it('stays silent when no upgrade is in the range', async () => {
    const notes: string[] = [];
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes);
    await adapter.discover(ctx);
    notes.length = 0;
    await adapter.decode(ctx, { upgrades: [], swaps: [REAL_MON_USDC_FILL] } as any, () => 1_785_053_296_000, new Set());
    expect(notes).toEqual([]);
  });
});

describe('ThogAMM fail-closed before discovery', () => {
  const decode = (adapter: VenueAdapter, ctx: any, logs: any) =>
    adapter.decode(ctx, logs, () => 1_785_053_296_000, new Set());

  it('holds the cursor on a real fill while the decode table is empty', async () => {
    const adapter = createThogammAdapter();
    await expect(decode(adapter, stubCtx([]), { upgrades: [], swaps: [REAL_MON_USDC_FILL] }))
      .rejects.toThrow('ThogAMM discovery unavailable');
  });

  it('still holds after a discovery attempt has failed', async () => {
    const adapter = createThogammAdapter();
    const ctx = stubCtx([]);
    ctx.client.readContract = async () => { throw new Error('RPC unavailable'); };
    await expect(adapter.discover(ctx)).rejects.toThrow('RPC unavailable');
    await expect(decode(adapter, ctx, { upgrades: [], swaps: [REAL_MON_USDC_FILL] }))
      .rejects.toThrow('ThogAMM discovery unavailable');
  });

  it('decodes the same fill once discovery has succeeded', async () => {
    const adapter = createThogammAdapter();
    const ctx = stubCtx([]);
    await adapter.discover(ctx);
    const fills = await decode(adapter, ctx, { upgrades: [], swaps: [REAL_MON_USDC_FILL] });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ market: 'MON/USDC', side: 'sell', baseAmount: 0.01 });
  });

  it('lets an undiscovered range carrying no ThogAMM swap advance', async () => {
    const adapter = createThogammAdapter();
    // the sources are static and genuinely knowable, so the shared tail must
    // keep moving for every other venue while ThogAMM is undiscovered.
    expect(adapter.logSources()).toHaveLength(2);
    await expect(decode(adapter, stubCtx([]), { upgrades: [], swaps: [] })).resolves.toEqual([]);
  });

  it('accepts a fill that arrives with the upgrade which repaired discovery', async () => {
    const adapter = createThogammAdapter();
    const upgrade = { address: THOGAMM_ADDRESS, eventName: 'Upgraded', args: { implementation: '0x127a5b18e3e96fc104f5eaf280dfe502dd3fd40a' }, blockNumber: 91_000_000n, logIndex: 1 };
    const fills = await decode(adapter, stubCtx([]), { upgrades: [upgrade], swaps: [REAL_MON_USDC_FILL] });
    expect(fills).toHaveLength(1);
  });
});
