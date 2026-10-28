import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeEventLog } from 'viem';
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
import { UsdPricer } from '../../pricer.js';

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

/** ThogAMM's live on-chain registry as of 2026-09-15 (getTokens on pool
 *  0xce389e78…): 8 tokens, 56 directed markets. XAUt0 joined via the
 *  implementation upgrade that preceded the RPC's retention window. */
const LIVE_TOKEN_ADDRESSES = [
  TOKENS.USDC.address,
  TOKENS.AUSD.address,
  TOKENS.USDT0.address,
  TOKENS.WMON.address,
  TOKENS.WETH.address,
  TOKENS.WBTC.address,
  TOKENS.CBBTC.address,
  TOKENS.XAUT0.address,
];
const MARKETS = thogammMarketsForTokens(LIVE_TOKEN_ADDRESSES);
const BY_DIRECTION = indexThogammMarkets(MARKETS);
const usdForToken = (tokenKey: string, amount: number) => {
  if (TOKENS[tokenKey]?.stable) return amount;
  const px: Record<string, number> = { WMON: 0.021, WETH: 3_800, WBTC: 118_000, CBBTC: 118_000, XAUT0: 4_350 };
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
      'XAUt/USDC',
      'XAUt/USDT0',
      'XAUt/AUSD',
      'XAUt/MON',
      'XAUt/ETH',
      'XAUt/cbBTC',
      'XAUt/BTC',
    ]);
    expect(MARKETS).toHaveLength(25);
    expect(new Set(MARKETS.flatMap((market) => [market.base.address, market.quote.address]))).toEqual(new Set(LIVE_TOKEN_ADDRESSES));
    expect(BY_DIRECTION.size).toBe(50);
  });

  it('does not advertise pairs for a token absent from the on-chain registry', () => {
    const withoutXaut = thogammMarketsForTokens(LIVE_TOKEN_ADDRESSES.filter((address) => address !== TOKENS.XAUT0.address));
    expect(withoutXaut.some((market) => market.market.includes('XAUt'))).toBe(false);
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

/** Minimal ctx: discovery reads are stubbed to the live 8-token registry, so
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
    expect(adapter.logSources()).toHaveLength(3);
    await expect(decode(adapter, stubCtx([]), { upgrades: [], swaps: [] })).resolves.toEqual([]);
  });

  it('accepts a fill that arrives with the upgrade which repaired discovery', async () => {
    const adapter = createThogammAdapter();
    const upgrade = { address: THOGAMM_ADDRESS, eventName: 'Upgraded', args: { implementation: '0x127a5b18e3e96fc104f5eaf280dfe502dd3fd40a' }, blockNumber: 91_000_000n, logIndex: 1 };
    const fills = await decode(adapter, stubCtx([]), { upgrades: [upgrade], swaps: [REAL_MON_USDC_FILL] });
    expect(fills).toHaveLength(1);
  });
});

describe('ThogAMM mutable registry and xStocks', () => {
  const stockKeys = ['SPYX', 'QQQX', 'EWYX', 'NVDAX', 'TSLAX'];
  const current = [...LIVE_TOKEN_ADDRESSES, ...stockKeys.map((k) => TOKENS[k].address)];
  it('covers all 75 non-stable crosses in the 13-token registry without duplicates', () => {
    const markets = thogammMarketsForTokens(current);
    expect(markets).toHaveLength(75);
    expect(indexThogammMarkets(markets).size).toBe(150);
    expect(markets.filter((m) => stockKeys.includes(m.baseKey))).toHaveLength(50);
    for (const m of markets) if (stockKeys.includes(m.baseKey)) expect(m.base.decimals).toBe(18);
  });
  /**
   * The first real xStock fill, recorded (fixtures/thogamm-xstock-fill.json):
   * https://monadscan.com/tx/0xc999c572f634eb3e5f35d21785a52fe441fe540092c6b8b0ac3ac911df703efc
   * block 117,225,577 · log 58 · 2026-10-28 04:01:21 UTC. 1e-6 WMON in,
   * 28,143,588 raw SPYx (18 decimals) out: 35,532 MON per SPYx, about $775 at
   * that hour's MON, against Kraken's ~$770. A dust trade, but real units.
   */
  it('decodes the first real xStock fill from its recorded log, with the ABI the adapter subscribes with', () => {
    const fx = JSON.parse(readFileSync(new URL('./fixtures/thogamm-xstock-fill.json', import.meta.url), 'utf8'));
    const swaps = createThogammAdapter().logSources().find((s) => s.key === 'swaps')!;
    const decoded = decodeEventLog({ abi: swaps.events as any, data: fx.log.data, topics: fx.log.topics, strict: true }) as any;
    expect(decoded.eventName).toBe('MakerSwapExecuted');
    expect(decoded.args.amountIn).toBe(1_000_000_000_000n);
    expect(decoded.args.amountOut).toBe(28_143_588n);
    // the event's amounts are what actually moved: the tx's ERC-20 Transfers in/out of the proxy
    const moved = (token: string) => BigInt(fx.transfers.find((t: any) => t.token === token.toLowerCase()).value);
    expect(moved(TOKENS.WMON.address)).toBe(decoded.args.amountIn);
    expect(moved(TOKENS.SPYX.address)).toBe(decoded.args.amountOut);

    const log = { ...fx.log, ...decoded, transactionHash: fx.transactionHash, blockNumber: BigInt(fx.blockNumber) };
    const fill = decodeThogammSwap(log, indexThogammMarkets(thogammMarketsForTokens(current)), fx.timestamp * 1000, usdForToken)!;
    expect(fill).toMatchObject({
      id: `thogamm-${fx.transactionHash}-58`, market: 'SPYx/MON', side: 'buy',
      blockNumber: 117_225_577, ts: Date.parse('2026-10-28T04:01:21Z'),
    });
    expect(fill.baseAmount).toBeCloseTo(28_143_588 / 1e18, 25);
    expect(fill.execPx).toBeCloseTo(1e-6 / (28_143_588 / 1e18), 6);   // MON per SPYx
    expect(fill.execPx * 0.0218).toBeGreaterThan(700);                  // ≈ $775: 18-decimal units hold
    expect(fill.execPx * 0.0218).toBeLessThan(850);
    expect(fill.usd).toBeCloseTo(1e-6 * 0.021, 15);                     // its MON leg, at the stub price
  });
  it('decodes rebased xStock event units without applying an issuer multiplier again', () => {
    // Constructed precision case, not a recorded on-chain fill. The real-log
    // decoding fixture above tests the same unchanged MakerSwapExecuted ABI.
    const log = { ...REAL_MON_USDC_FILL, args: { ...REAL_MON_USDC_FILL.args,
      tokenIn: TOKENS.SPYX.address, tokenOut: TOKENS.USDC.address,
      amountIn: 1_234_567_890_123_456_789n, amountOut: 950_617_275n,
    } };
    const fill = decodeThogammSwap(log, indexThogammMarkets(thogammMarketsForTokens(current)), 0, usdForToken)!;
    expect(fill.market).toBe('SPYx/USDC'); expect(fill.side).toBe('sell');
    expect(fill.baseAmount).toBeCloseTo(1.234567890123456789, 14);
    expect(fill.usd).toBe(950.617275);
    expect(fill.execPx).toBeCloseTo(950.617275 / 1.234567890123456789, 10);
  });
  // Both legs of an xStock/xStock fill price from Kraken alone. A closed
  // market must value it at its last good price, not throw: a decode throw
  // holds the shared tail for every venue until Kraken reopens.
  it('values an xStock/xStock fill while Kraken is closed, and holds only if Kraken never answered', () => {
    const markets = indexThogammMarkets(thogammMarketsForTokens(current));
    const log = { ...REAL_MON_USDC_FILL, args: { ...REAL_MON_USDC_FILL.args,
      tokenIn: TOKENS.QQQX.address, tokenOut: TOKENS.SPYX.address,
      amountIn: 2_000_000_000_000_000_000n, amountOut: 1_000_000_000_000_000_000n,
    } };
    const closed = new UsdPricer(() => 0, undefined, (key) => (key === 'SPYx' ? 770 : key === 'QQQx' ? 720 : 0));
    const fill = decodeThogammSwap(log, markets, 0, (k, a) => closed.usdForToken(k, a))!;
    expect(fill.market).toBe('QQQx/SPYx');
    expect(fill.usd).toBe(770);
    const silent = new UsdPricer(() => 0, undefined, () => 0);
    expect(() => decodeThogammSwap(log, markets, 0, (k, a) => silent.usdForToken(k, a))).toThrow('no USD price for either fill leg');
  });
  it('refreshes on registry events, stops quoting retired tokens, and retains their historical decode table', async () => {
    const adapter = createThogammAdapter(), ctx = stubCtx([]);
    let addresses = LIVE_TOKEN_ADDRESSES;
    ctx.client.readContract = async ({ functionName }: any) => functionName === 'getPoolIds' ? [`0x${'1'.repeat(64)}`] : addresses;
    await adapter.discover(ctx);
    expect(adapter.quoteMarkets?.()).not.toContain('SPYx/USDC');
    addresses = current;
    await adapter.decode(ctx, { registry: [{ eventName: 'MakerTokenAdded' }] } as any, () => 0, new Set());
    expect(adapter.quoteMarkets?.()).toContain('SPYx/USDC');
    addresses = current.filter((a) => a !== TOKENS.WMON.address);
    const fills = await adapter.decode(ctx, { registry: [{ eventName: 'MakerTokenRetired' }], swaps: [REAL_MON_USDC_FILL] } as any, () => 0, new Set());
    expect(adapter.quoteMarkets?.()).not.toContain('MON/USDC');
    expect(fills).toHaveLength(1);
    ctx.client.readContract = async () => { throw new Error('registry RPC failed'); };
    await expect(adapter.decode(ctx, { registry: [{}], swaps: [REAL_MON_USDC_FILL] } as any, () => 0, new Set())).rejects.toThrow('registry RPC failed');
  });
  it('replays only newly tracked markets and preserves the existing gas repair', () => {
    const adapter = createThogammAdapter(), revisions = adapter.historyRevisions!;
    expect(revisions[0]).toMatchObject({ source: 'markets', from: '2026-10-26' });
    expect(revisions[0].markets).toHaveLength(50);
    // from the first on-chain XAUt0<->WBTC swap (block 101,922,564, 2026-09-04)
    expect(revisions[1]).toMatchObject({ source: 'markets', from: '2026-09-04', markets: ['XAUt/BTC'] });
    expect(adapter.gasRevisions).toEqual([{ id: 'params-pushed-topic', from: '2026-10-22' }]);
  });
});
