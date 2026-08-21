import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import {
  THOGAMM_ADDRESS,
  createThogammAdapter,
  decodeThogammSwap,
  indexThogammMarkets,
  selectThogammPoolId,
  thogammMarketsForTokens,
  thogammRejectReason,
} from '../thogamm.js';
import type { VenueAdapter } from '../adapter.js';

/**
 * A real MakerSwapExecuted log — the one this adapter was originally written
 * against, and the only one that existed on-chain at the time. The event is
 * rare but NOT unique: a lifetime sweep on 2026-08-21 found a handful more,
 * against thousands of TakerTradeExecuted, which is why it stays decoded.
 * https://monadscan.com/tx/0xa7d17be22f83bb43b6fd983bdbf924a8ad5eb5eaf5ea1d89fa1572d4f9bc151f
 *
 * block 90,433,928 · log index 50 · 2026-07-26 08:08:16 UTC
 * 0.01 WMON in → 0.000210 USDC out, so realized px = 0.021 USDC/MON.
 *
 * Its legs are TAKER-indexed — `tokenIn` is the WMON the pool RECEIVED — which
 * is the reverse of the live event below. That is why it is still decoded and
 * still tested: it is the regression guard on the two orderings.
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

/**
 * Real TakerTradeExecuted logs — the event ThogAMM has actually landed every
 * fill on. Recorded 2026-08-21 from Monad mainnet; the fields below are the
 * raw log verbatim, and each amount was reconciled against the ERC-20
 * Transfers in the same transaction before being written down.
 *
 * These legs are POOL-indexed: `poolPays` LEAVES the pool (the taker receives
 * it) and `poolReceives` ENTERS it (the taker paid it).
 */

/**
 * https://monadscan.com/tx/0x646246f91428b77d7c6717a55eabe329ab82f59b2f5ca4941a411f9524b48c39
 * block 97,821,476 · log index 14 · 2026-08-21 05:06:51 UTC
 *
 * Pool paid out 53,523.589754466968941979 WMON and took in 1,416.923382 USDC
 * (both confirmed against the Transfer pair in the tx), so the TAKER bought
 * MON: px = 1416.923382 / 53523.589754466968941979 = 0.0264728…  USDC/MON.
 */
const REAL_TAKER_BUY = {
  address: THOGAMM_ADDRESS,
  eventName: 'TakerTradeExecuted',
  args: {
    poolPays: TOKENS.WMON.address,
    poolReceives: TOKENS.USDC.address,
    poolPaysAmount: 53_523_589_754_466_968_941_979n,
    poolReceivesAmount: 1_416_923_382n,
    word2: 0n,
    word3: 0n,
    word4: 1_413_927_162n,
    word5: 0n,
  },
  transactionHash: '0x646246f91428b77d7c6717a55eabe329ab82f59b2f5ca4941a411f9524b48c39',
  blockNumber: 97_821_476n,
  logIndex: 14,
};

/**
 * https://monadscan.com/tx/0x7980737212342014d1e44a405ab73242b7a99796dd20d5fbf26b258ded27ec15
 * block 97,815,169 · log index 13 · 2026-08-21 04:34:46 UTC
 *
 * The mirror image: pool paid out 1,404.778656 USDC for 53,571.908560824550149891
 * WMON, so the taker SOLD MON. Decoding this with the legacy event's ordering
 * would report a buy — which is exactly the bug this pair of fixtures guards.
 */
const REAL_TAKER_SELL = {
  address: THOGAMM_ADDRESS,
  eventName: 'TakerTradeExecuted',
  args: {
    poolPays: TOKENS.USDC.address,
    poolReceives: TOKENS.WMON.address,
    poolPaysAmount: 1_404_778_656n,
    poolReceivesAmount: 53_571_908_560_824_550_149_891n,
    word2: 0n,
    word3: 0n,
    word4: 53_566_572_047_013_838_350_581n,
    word5: 48_318_806_357_581_207_912n,
  },
  transactionHash: '0x7980737212342014d1e44a405ab73242b7a99796dd20d5fbf26b258ded27ec15',
  blockNumber: 97_815_169n,
  logIndex: 13,
};

/**
 * https://monadscan.com/tx/0x63d27e5a1cc853556b180f17d2c5b4e5706e1ea840a836b07d8513e57971d4bf
 * block 97,851,656 · log index 165 · 2026-08-21 07:40:33 UTC
 *
 * A second market, and an 18→6 decimal pair in the other direction:
 * 0.0786602563 WETH in for 187.253113 USDC out = 2380.53… USDC/ETH.
 */
const REAL_TAKER_ETH_SELL = {
  address: THOGAMM_ADDRESS,
  eventName: 'TakerTradeExecuted',
  args: {
    poolPays: TOKENS.USDC.address,
    poolReceives: TOKENS.WETH.address,
    poolPaysAmount: 187_253_113n,
    poolReceivesAmount: 78_660_256_300_000_000n,
    word2: 0n,
    word3: 0n,
    word4: 78_622_560_622_509_726n,
    word5: 0n,
  },
  transactionHash: '0x63d27e5a1cc853556b180f17d2c5b4e5706e1ea840a836b07d8513e57971d4bf',
  blockNumber: 97_851_656n,
  logIndex: 165,
};

/**
 * A real TradeFailed log (block 97,813,971 · log index 129) — the maker caught
 * the taker call reverting and re-emitted its raw data. The `reason` bytes are
 * a plain Error(string) carrying "taker: zero fill".
 */
const REAL_TRADE_FAILED = {
  address: THOGAMM_ADDRESS,
  eventName: 'TradeFailed',
  args: {
    tokenA: TOKENS.USDC.address,
    tokenB: TOKENS.WMON.address,
    amount: 1_596_719_276n,
    reason: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001074616b65723a207a65726f2066696c6c00000000000000000000000000000000' as const,
  },
  transactionHash: '0x9846e84d1f6ce1c3cf05c320f9d0a45092cd1e369ce024c54e1fe359f9c99882',
  blockNumber: 97_813_971n,
  logIndex: 129,
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

describe('decodeThogammSwap (live TakerTradeExecuted fixtures)', () => {
  it('reads the pool-indexed legs in taker terms — pool pays MON, so the taker BOUGHT', () => {
    const fill = decodeThogammSwap(REAL_TAKER_BUY, BY_DIRECTION, 1_787_288_811_000, usdForToken)!;
    expect(fill).toMatchObject({
      id: `thogamm-${REAL_TAKER_BUY.transactionHash}-14`,
      venueId: 'thogamm',
      market: 'MON/USDC',
      side: 'buy',
      category: 'UNKNOWN',
      // the stable leg is the USDC that ENTERED the pool — 1,416.923382, the
      // exact ERC-20 Transfer amount, not the 1,413.927162 in word4.
      usd: 1_416.923382,
      baseAmount: 53_523.58975446697,
      execPx: 0.026472876511085403,
      txHash: REAL_TAKER_BUY.transactionHash,
      blockNumber: 97_821_476,
      ts: 1_787_288_811_000,
      markoutsBps: [null, null, null, null, null],
    });
    // the live event carries no address at all — attribution fills `to` in
    // from tx.from downstream, exactly as it does for every other venue.
    expect(fill.to).toBe('0x');
  });

  it('reads the mirror trade on the same pair as a sell', () => {
    const fill = decodeThogammSwap(REAL_TAKER_SELL, BY_DIRECTION, 1_787_286_886_000, usdForToken)!;
    expect(fill).toMatchObject({
      id: `thogamm-${REAL_TAKER_SELL.transactionHash}-13`,
      market: 'MON/USDC',
      side: 'sell',
      usd: 1_404.778656,
      baseAmount: 53_571.90856082455,
      execPx: 0.026222299965382796,
      blockNumber: 97_815_169,
    });
  });

  it('is not fooled by the legacy ordering: the same two tokens give opposite sides', () => {
    const buy = decodeThogammSwap(REAL_TAKER_BUY, BY_DIRECTION, 0, usdForToken)!;
    const sell = decodeThogammSwap(REAL_TAKER_SELL, BY_DIRECTION, 0, usdForToken)!;
    expect([buy.side, sell.side]).toEqual(['buy', 'sell']);
    // and the legacy event, whose legs are taker-indexed, still reads as the
    // taker paying WMON — proving the two orderings are decoded separately.
    expect(decodeThogammSwap(REAL_MON_USDC_FILL, BY_DIRECTION, 0, usdForToken)!.side).toBe('sell');
  });

  it('decodes a second market across the opposite decimal order', () => {
    const fill = decodeThogammSwap(REAL_TAKER_ETH_SELL, BY_DIRECTION, 1_787_298_033_000, usdForToken)!;
    expect(fill).toMatchObject({
      market: 'ETH/USDC',
      side: 'sell',
      usd: 187.253113,
      baseAmount: 0.0786602563,
      execPx: 2_380.5301661596545,
      blockNumber: 97_851_656,
    });
  });

  it('skips a malformed live log without wedging the cursor', () => {
    expect(decodeThogammSwap({
      ...REAL_TAKER_BUY,
      args: { ...REAL_TAKER_BUY.args, poolReceivesAmount: 0n },
    }, BY_DIRECTION, 0, usdForToken)).toBeNull();
    expect(decodeThogammSwap({
      ...REAL_TAKER_BUY,
      args: { ...REAL_TAKER_BUY.args, poolReceives: TOKENS.USD1.address },
    }, BY_DIRECTION, 0, usdForToken)).toBeNull();
    // an event this adapter does not decode is not a fill
    expect(decodeThogammSwap(REAL_TRADE_FAILED, BY_DIRECTION, 0, usdForToken)).toBeNull();
  });
});

describe('thogammRejectReason', () => {
  it('reads the Error(string) ThogAMM caught, and never invents one otherwise', () => {
    expect(thogammRejectReason(REAL_TRADE_FAILED.args.reason)).toBe('taker: zero fill');
    expect(thogammRejectReason('0x')).toBe('no revert data');
    expect(thogammRejectReason('0xdeadbeef')).toBe('custom error 0xdeadbeef');
    expect(thogammRejectReason(undefined)).toBe('unreadable revert data');
    expect(thogammRejectReason('not hex')).toBe('unreadable revert data');
  });
});

/** Minimal ctx: discovery reads are stubbed to the live 7-token registry, so
 *  decode() can exercise the upgrade path with no network. `chain` is mutable
 *  so a test can advance the head and the maker's last posted block — the two
 *  inputs the fill-silence alarm compares. */
const stubCtx = (notes: string[], codes: string[] = [], chain = { head: 91_000_000n, posted: 91_000_000n }) => ({
  chain,
  client: {
    getBlockNumber: async () => chain.head,
    readContract: async ({ functionName }: any) =>
      functionName === 'getPoolIds'
        ? ['0xce389e78282dedac7b18ba7f775b7602d2ab3ab171bbd6711eb0239be6ef4dcc']
        : LIVE_TOKEN_ADDRESSES,
    multicall: async ({ contracts }: any) =>
      contracts.map((c: any) => (
        // discovery asks for decimals; quoting asks for makerQuoteExactInput,
        // whose second return value is the keeper's last posted block.
        c.functionName === 'decimals'
          ? {
            status: 'success',
            result: Object.values(TOKENS).find((t) => t.address.toLowerCase() === String(c.address).toLowerCase())!.decimals,
          }
          : { status: 'success', result: [1n, chain.posted] })),
  },
  pricer: {
    usdForToken: (key: string, amount: number) => usdForToken(key, amount),
    pairMid: () => 0.0207,
    usdPerToken: () => 0.0207,
  },
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
    await adapter.decode(ctx, { upgrades: [upgrade('0x127a5b18e3e96fc104f5eaf280dfe502dd3fd40a')], trades: [] } as any, () => 0, new Set());

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
      trades: [],
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
    await adapter.decode(ctx, { upgrades: [], trades: [REAL_MON_USDC_FILL] } as any, () => 1_785_053_296_000, new Set());
    expect(notes).toEqual([]);
  });
});

describe('ThogAMM fail-closed before discovery', () => {
  const decode = (adapter: VenueAdapter, ctx: any, logs: any) =>
    adapter.decode(ctx, logs, () => 1_785_053_296_000, new Set());

  it('holds the cursor on a real fill while the decode table is empty', async () => {
    const adapter = createThogammAdapter();
    await expect(decode(adapter, stubCtx([]), { upgrades: [], trades: [REAL_MON_USDC_FILL] }))
      .rejects.toThrow('ThogAMM discovery unavailable');
  });

  it('still holds after a discovery attempt has failed', async () => {
    const adapter = createThogammAdapter();
    const ctx = stubCtx([]);
    ctx.client.readContract = async () => { throw new Error('RPC unavailable'); };
    await expect(adapter.discover(ctx)).rejects.toThrow('RPC unavailable');
    await expect(decode(adapter, ctx, { upgrades: [], trades: [REAL_MON_USDC_FILL] }))
      .rejects.toThrow('ThogAMM discovery unavailable');
  });

  it('decodes the same fill once discovery has succeeded', async () => {
    const adapter = createThogammAdapter();
    const ctx = stubCtx([]);
    await adapter.discover(ctx);
    const fills = await decode(adapter, ctx, { upgrades: [], trades: [REAL_MON_USDC_FILL] });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ market: 'MON/USDC', side: 'sell', baseAmount: 0.01 });
  });

  it('lets an undiscovered range carrying no ThogAMM swap advance', async () => {
    const adapter = createThogammAdapter();
    // the sources are static and genuinely knowable, so the shared tail must
    // keep moving for every other venue while ThogAMM is undiscovered.
    expect(adapter.logSources()).toHaveLength(2);
    await expect(decode(adapter, stubCtx([]), { upgrades: [], trades: [] })).resolves.toEqual([]);
  });

  it('accepts a fill that arrives with the upgrade which repaired discovery', async () => {
    const adapter = createThogammAdapter();
    const upgrade = { address: THOGAMM_ADDRESS, eventName: 'Upgraded', args: { implementation: '0x127a5b18e3e96fc104f5eaf280dfe502dd3fd40a' }, blockNumber: 91_000_000n, logIndex: 1 };
    const fills = await decode(adapter, stubCtx([]), { upgrades: [upgrade], trades: [REAL_MON_USDC_FILL] });
    expect(fills).toHaveLength(1);
  });
});

describe('ThogAMM rejected takers', () => {
  const decode = (adapter: VenueAdapter, ctx: any, logs: any) =>
    adapter.decode(ctx, logs, () => 1_787_288_811_000, new Set());

  it('names the on-chain reason instead of dropping the refusal silently', async () => {
    const notes: string[] = [];
    const codes: string[] = [];
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes, codes);
    await adapter.discover(ctx);
    notes.length = 0; codes.length = 0;

    const fills = await decode(adapter, ctx, { upgrades: [], trades: [REAL_TRADE_FAILED] });
    expect(fills).toEqual([]);                       // a refusal is not volume
    expect(codes).toContain('venue.fills.rejected');
    expect(notes[0]).toContain('taker: zero fill');
  });

  it('reports once per distinct reason, not once per occurrence', async () => {
    const notes: string[] = [];
    const codes: string[] = [];
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes, codes);
    await adapter.discover(ctx);
    notes.length = 0; codes.length = 0;

    await decode(adapter, ctx, { upgrades: [], trades: [REAL_TRADE_FAILED, REAL_TRADE_FAILED] });
    await decode(adapter, ctx, { upgrades: [], trades: [REAL_TRADE_FAILED] });
    expect(codes.filter((c) => c === 'venue.fills.rejected')).toHaveLength(1);

    // a DIFFERENT reason is a new event and gets its own note
    await decode(adapter, ctx, {
      upgrades: [],
      trades: [{ ...REAL_TRADE_FAILED, args: { ...REAL_TRADE_FAILED.args, reason: '0xdeadbeef' } }],
    });
    expect(codes.filter((c) => c === 'venue.fills.rejected')).toHaveLength(2);
    expect(notes[1]).toContain('custom error 0xdeadbeef');
  });

  it('lets an undiscovered range carrying only a refusal advance', async () => {
    // there is nothing here discovery could have decoded, so holding the
    // shared tail on it would stall every venue for no gain.
    const adapter = createThogammAdapter();
    await expect(decode(adapter, stubCtx([]), { upgrades: [], trades: [REAL_TRADE_FAILED] }))
      .resolves.toEqual([]);
  });
});

describe('ThogAMM fill-silence alarm', () => {
  // the head at which the live fixtures land, and a day of 400ms blocks before it
  const FILL_BLOCK = 97_821_476n;
  const DAY = 216_000n;

  const armed = async (notes: string[], codes: string[]) => {
    const chain = { head: FILL_BLOCK - DAY, posted: FILL_BLOCK - DAY };
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes, codes, chain);
    await adapter.discover(ctx);          // watches from here
    await adapter.quote!(ctx, [100]);     // and learns the keeper is posting
    notes.length = 0; codes.length = 0;
    return { adapter, ctx, chain };
  };

  it('reports a day of no fills while the keeper is still posting quotes', async () => {
    const notes: string[] = [], codes: string[] = [];
    const { adapter, ctx, chain } = await armed(notes, codes);

    chain.head = FILL_BLOCK;
    chain.posted = FILL_BLOCK;            // still quoting
    await adapter.quote!(ctx, [100]);
    await adapter.discover(ctx);

    expect(codes).toContain('venue.fills.silent');
    const note = notes.find((n) => n.includes('no fill decoded'))!;
    expect(note).toContain('216000 blocks');
    expect(note).toContain('drifted');

    // and it says it once, not on every discovery pass
    codes.length = 0;
    await adapter.discover(ctx);
    expect(codes).not.toContain('venue.fills.silent');
  });

  it('stays quiet when the maker itself has gone dark — that silence is explained', async () => {
    const notes: string[] = [], codes: string[] = [];
    const { adapter, ctx, chain } = await armed(notes, codes);

    chain.head = FILL_BLOCK;              // a day on, but the keeper stopped
    await adapter.discover(ctx);          // posting back where it was armed

    expect(codes).not.toContain('venue.fills.silent');
  });

  it('stays quiet while fills are still landing, and rearms after one does', async () => {
    const notes: string[] = [], codes: string[] = [];
    const { adapter, ctx, chain } = await armed(notes, codes);

    chain.head = FILL_BLOCK;
    chain.posted = FILL_BLOCK;
    const fills = await adapter.decode(ctx, { upgrades: [], trades: [REAL_TAKER_BUY] } as any, () => 1_787_288_811_000, new Set());
    expect(fills).toHaveLength(1);
    await adapter.quote!(ctx, [100]);
    await adapter.discover(ctx);
    expect(codes).not.toContain('venue.fills.silent');

    // a day after THAT fill, with nothing since, it fires again
    chain.head = FILL_BLOCK + DAY;
    chain.posted = FILL_BLOCK + DAY;
    await adapter.quote!(ctx, [100]);
    await adapter.discover(ctx);
    expect(codes).toContain('venue.fills.silent');
  });

  it('does not fire on a backfilled historical fill — the baseline is boot, not history', async () => {
    const notes: string[] = [], codes: string[] = [];
    const chain = { head: FILL_BLOCK, posted: FILL_BLOCK };
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes, codes, chain);
    await adapter.discover(ctx);
    await adapter.quote!(ctx, [100]);
    codes.length = 0;

    // the venue-lifetime backfill replays July through the same decode()
    await adapter.decode(ctx, { upgrades: [], trades: [REAL_MON_USDC_FILL] } as any, () => 0, new Set());
    await adapter.discover(ctx);
    expect(codes).not.toContain('venue.fills.silent');
  });
});
