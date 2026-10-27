import { describe, expect, it } from 'vitest';
import { parseEventLogs } from 'viem';
import { TOKENS } from '@shared';
import { WOOPP, createWoofiAdapter, decodeWoofiSwap, readObservedOracles, woofiMarketFor, woofiMarkets } from '../woofi.js';
import type { AdapterState } from '../adapter.js';

/**
 * Fixture-based tests — REAL logs recorded from WOOFi's WooPPV2 on Monad
 * mainnet, expected values computed independently from the raw integers.
 * Each fill was hand-verified against its own ERC-20 Transfer logs (the
 * pool's in/out legs match fromAmount/toAmount to the wei) and the first
 * against monadscan's token-transfer view. No network.
 */

/** A raw log as eth_getLogs returns it, decoded below through the adapter's
 *  OWN declared events — so topic0 and the field layout are locked too. */
interface RawLog { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}`; transactionHash: `0x${string}`; blockNumber: bigint; logIndex: number }

/**
 * https://monadscan.com/tx/0x7631f8b8f959140c6a922eea2582fab9d3d4a8a5138c04e7dcba7a7a9084d0fa
 * block 117,035,771 · log 49 · 2026-10-27 11:59:10 UTC
 * Transfers: 0.998822850599321984 WETH → pool (log 47), 2,309.494943 USDC
 * pool → taker (log 48). The taker SOLD ETH at 2,312.2168 USDC/ETH.
 */
const SELL_ETH: RawLog = {
  topics: [
    '0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469',
    '0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242',
    '0x000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603',
    '0x0000000000000000000000005f500b990de962f56ae335d36df8e797d6a6aa52',
  ],
  data: '0x0000000000000000000000000000000000000000000000000ddc8817338401800000000000000000000000000000000000000000000000000000000089a8189f0000000000000000000000005f500b990de962f56ae335d36df8e797d6a6aa5200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000089a8189f0000000000000000000000000000000000000000000000000000000000000000',
  transactionHash: '0x7631f8b8f959140c6a922eea2582fab9d3d4a8a5138c04e7dcba7a7a9084d0fa',
  blockNumber: 117_035_771n,
  logIndex: 49,
};
const SELL_ETH_TS = 1_793_102_350_000;

/**
 * https://monadscan.com/tx/0x848dc895e1399a57242fc2e7fd3bb5ab60bb311d0eb9b0bfe813c9ace9f6cd7e
 * block 117,049,738 · log 62 · 2026-10-27 13:09:57 UTC
 * Transfers: 1,797.618155 USDC → pool (log 60), 0.772387288110366777 WETH
 * pool → taker (log 61). The taker BOUGHT ETH at 2,327.3533 USDC/ETH.
 */
const BUY_ETH: RawLog = {
  topics: [
    '0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469',
    '0x000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603',
    '0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242',
    '0x0000000000000000000000007db99f225af7a1a21b7b6468ed28f4bc60fbe937',
  ],
  data: '0x000000000000000000000000000000000000000000000000000000006b2579eb0000000000000000000000000000000000000000000000000ab8122570d880390000000000000000000000007db99f225af7a1a21b7b6468ed28f4bc60fbe9370000000000000000000000007db99f225af7a1a21b7b6468ed28f4bc60fbe937000000000000000000000000000000000000000000000000000000006b2579eb0000000000000000000000000000000000000000000000000000000000000000',
  transactionHash: '0x848dc895e1399a57242fc2e7fd3bb5ab60bb311d0eb9b0bfe813c9ace9f6cd7e',
  blockNumber: 117_049_738n,
  logIndex: 62,
};
const BUY_ETH_TS = 1_793_106_597_000;

/**
 * BASE→BASE, entered through WooRouterV2 (the event's `from`):
 * https://monadscan.com/tx/0x8f233278f958a1cb07ba0da31bce7170b3c874f02fd863ac33e60ebbbe04c550
 * block 117,033,565 · log 40 · 2026-10-27 11:48:04 UTC
 * Transfers: 0.088966323477787031 WETH → pool (log 38), 0.00257794 cbBTC
 * pool → taker (log 39) — and NO USDC transfer: the pool routes through USDC
 * internally. swapVol = 205.747543 USDC = 0.0889663 ETH × $2,312.65, in line
 * with the ETH fill above 11 minutes later. The taker BOUGHT cbBTC with ETH:
 * market cbBTC/ETH at 34.5106 ETH/cbBTC.
 */
const WETH_TO_CBBTC: RawLog = {
  topics: [
    '0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469',
    '0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242',
    '0x000000000000000000000000d18b7ec58cdf4876f6afebd3ed1730e4ce10414b',
    '0x000000000000000000000000fb78fcae443eb423b59b8c186518c5df94416344',
  ],
  data: '0x000000000000000000000000000000000000000000000000013c12665bddb197000000000000000000000000000000000000000000000000000000000003ef020000000000000000000000004c4af8dbc524681930a27b2f1af5bcc8062e6fb70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c4375570000000000000000000000000000000000000000000000000000000000000000',
  transactionHash: '0x8f233278f958a1cb07ba0da31bce7170b3c874f02fd863ac33e60ebbbe04c550',
  blockNumber: 117_033_565n,
  logIndex: 40,
};
const WETH_TO_CBBTC_TS = 1_793_101_684_000;

/**
 * A FEE-PAYING sale from before the May 2026 pause (feeRate 25 = 2.5bps):
 * https://monadscan.com/tx/0x17a113f132fe96759540bafcfeb8cc8fa1b34eb6a25f905ab45148fc39cbd0f6
 * block 70,002,987 · log 11 · 2026-04-23 12:52:59 UTC
 * Transfers: 0.084493961090921926 WETH → pool (log 9), 196.689101 USDC pool →
 * taker (log 10) = swapVol 196.738285 − swapFee 0.049184. The fill is what
 * the taker received, net of the fee, like every venue's stable leg.
 */
const FEE_SELL_ETH: RawLog = {
  topics: [
    '0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469',
    '0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242',
    '0x000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603',
    '0x000000000000000000000000243e55d3233a2af3a8d92b1762296a5ad2c207a7',
  ],
  data: '0x000000000000000000000000000000000000000000000000012c2ecf587d75c6000000000000000000000000000000000000000000000000000000000bb93ccd0000000000000000000000004c4af8dbc524681930a27b2f1af5bcc8062e6fb7000000000000000000000000243e55d3233a2af3a8d92b1762296a5ad2c207a7000000000000000000000000000000000000000000000000000000000bb9fced000000000000000000000000000000000000000000000000000000000000c020',
  transactionHash: '0x17a113f132fe96759540bafcfeb8cc8fa1b34eb6a25f905ab45148fc39cbd0f6',
  blockNumber: 70_002_987n,
  logIndex: 11,
};

/** The proxy's only Upgraded, emitted in its creation tx (block 38,315,208):
 *  the implementation the adapter's ABIs were verified against. */
const CREATION_UPGRADE: RawLog = {
  topics: [
    '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
    '0x0000000000000000000000006aebc663dd6b8de86129e671baf68586fb0c8fcc',
  ],
  data: '0x',
  transactionHash: '0x816f6058d9826fa532fc2252bece0fbf201a671dfcba6b31bfa8f54b98ac857a',
  blockNumber: 38_315_208n,
  logIndex: 1,
};

/** Decode raw logs exactly as the core's getLogs does: with the adapter's
 *  declared events, viem-parsed into { eventName, args }. */
function parse(...raw: RawLog[]): any[] {
  const events = createWoofiAdapter().logSources()[0].events as any[];
  return parseEventLogs({
    abi: events,
    logs: raw.map((l) => ({ ...l, address: WOOPP, blockHash: null, transactionIndex: 0, removed: false })) as any,
  });
}

describe('WOOFi log source', () => {
  it('is one static source carrying fills and upgrades, with no discovery to wait on', () => {
    const sources = createWoofiAdapter().logSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ key: 'pool', address: WOOPP, kind: 'fills' });
    expect(sources[0].events.map((e: any) => e.name)).toEqual(['WooSwap', 'Upgraded']);
  });

  it("decodes the recorded logs through the adapter's own ABI", () => {
    const [sell, buy, b2b, upgrade] = parse(SELL_ETH, BUY_ETH, WETH_TO_CBBTC, CREATION_UPGRADE);
    expect(sell.eventName).toBe('WooSwap');
    expect(sell.args).toMatchObject({
      fromToken: '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242',
      toToken: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      fromAmount: 998_822_850_599_321_984n,
      toAmount: 2_309_494_943n,
      swapVol: 2_309_494_943n,
      swapFee: 0n,
    });
    expect(buy.args).toMatchObject({ fromAmount: 1_797_618_155n, toAmount: 772_387_288_110_366_777n });
    expect(b2b.args).toMatchObject({
      fromAmount: 88_966_323_477_787_031n,
      toAmount: 257_794n,
      from: '0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7', // WooRouterV2
      swapVol: 205_747_543n,
    });
    expect(upgrade).toMatchObject({ eventName: 'Upgraded', args: { implementation: '0x6AEBC663DD6B8De86129E671bAf68586fb0c8fcC' } });
  });
});

describe('decodeWoofiSwap (real Monad fixtures)', () => {
  const [sell, buy, b2b] = parse(SELL_ETH, BUY_ETH, WETH_TO_CBBTC);

  it('decodes a base→USDC sale from the USDC leg actually paid', () => {
    expect(decodeWoofiSwap(sell, SELL_ETH_TS)).toEqual({
      id: 'woofi-0x7631f8b8f959140c6a922eea2582fab9d3d4a8a5138c04e7dcba7a7a9084d0fa-49',
      venueId: 'woofi',
      market: 'ETH/USDC',
      side: 'sell',
      category: 'UNKNOWN',
      usd: 2309.494943,
      baseAmount: 0.998822850599321984,
      execPx: 2309.494943 / 0.998822850599321984,
      txHash: SELL_ETH.transactionHash,
      to: '0x5F50…aA52',
      pool: 'woofi 0x5520385b',
      blockNumber: 117_035_771,
      ts: SELL_ETH_TS,
      markoutsBps: [null, null, null, null, null],
    });
    expect(decodeWoofiSwap(sell, SELL_ETH_TS)!.execPx).toBeCloseTo(2312.2168, 3);
  });

  it('decodes a USDC→base purchase', () => {
    const fill = decodeWoofiSwap(buy, BUY_ETH_TS)!;
    expect(fill).toMatchObject({
      id: 'woofi-0x848dc895e1399a57242fc2e7fd3bb5ab60bb311d0eb9b0bfe813c9ace9f6cd7e-62',
      market: 'ETH/USDC',
      side: 'buy',
      usd: 1797.618155,
      blockNumber: 117_049_738,
    });
    // 18 decimals do not fit a double: equal to the last representable digit
    expect(fill.baseAmount).toBeCloseTo(0.772387288110366777, 15);
    expect(fill.execPx).toBeCloseTo(1797.618155 / 0.772387288110366777, 9);
    expect(fill.execPx).toBeCloseTo(2327.3533, 3);
  });

  it('books a fee-paying sale at the USDC the taker received, not the gross swapVol', () => {
    const [fee] = parse(FEE_SELL_ETH);
    expect(fee.args).toMatchObject({ toAmount: 196_689_101n, swapVol: 196_738_285n, swapFee: 49_184n });
    const fill = decodeWoofiSwap(fee, 1_776_948_779_000)!;
    expect(fill).toMatchObject({ market: 'ETH/USDC', side: 'sell', usd: 196.689101, blockNumber: 70_002_987 });
    expect(fill.baseAmount).toBeCloseTo(0.084493961090921926, 15);
    expect(fill.execPx).toBeCloseTo(196.689101 / 0.084493961090921926, 9);
  });

  it('prices a base→base swap in pair terms, with swapVol as its USD notional', () => {
    const fill = decodeWoofiSwap(b2b, WETH_TO_CBBTC_TS)!;
    expect(fill).toMatchObject({
      id: 'woofi-0x8f233278f958a1cb07ba0da31bce7170b3c874f02fd863ac33e60ebbbe04c550-40',
      market: 'cbBTC/ETH',
      side: 'buy', // ETH (the pair's quote) in, cbBTC (its base) out
      usd: 205.747543,
      baseAmount: 0.00257794,
      execPx: 0.088966323477787031 / 0.00257794,
      to: '0xfb78…6344',
    });
    expect(fill.execPx).toBeCloseTo(34.5106, 3);
  });

  it('skips unregistered pairs and malformed logs without wedging the cursor', () => {
    const swap = (patch: Record<string, unknown>) => ({ ...sell, args: { ...sell.args, ...patch } });
    // stable↔stable has no base asset to benchmark
    expect(decodeWoofiSwap(swap({ fromToken: TOKENS.USDC.address, toToken: TOKENS.USDT0.address }), 0)).toBeNull();
    // a token the registry doesn't know
    expect(decodeWoofiSwap(swap({ fromToken: '0x1111111111111111111111111111111111111111' }), 0)).toBeNull();
    expect(decodeWoofiSwap(swap({ toAmount: 0n }), 0)).toBeNull();
    expect(decodeWoofiSwap({ ...sell, address: '0x0000000000000000000000000000000000000001' }, 0)).toBeNull();
    expect(decodeWoofiSwap({ ...sell, blockNumber: 'not-a-block' }, 0)).toBeNull();
    expect(decodeWoofiSwap({ ...sell, eventName: 'Upgraded' }, 0)).toBeNull();
  });
});

describe('WOOFi registered-market table', () => {
  it('covers every pair the pool can trade among its listed tokens', () => {
    const { USDC, WETH, WBTC, CBBTC, WMON } = TOKENS;
    const cases: Array<[string, string, string, string]> = [
      [WMON.address, USDC.address, 'MON/USDC', 'WMON'],
      [WETH.address, USDC.address, 'ETH/USDC', 'WETH'],
      [WBTC.address, USDC.address, 'BTC/USDC', 'WBTC'],
      [CBBTC.address, USDC.address, 'cbBTC/USDC', 'cbBTC'],
      [WMON.address, WETH.address, 'MON/ETH', 'WMON'],
      [WBTC.address, WMON.address, 'BTC/MON', 'WBTC'],
      [WBTC.address, WETH.address, 'BTC/ETH', 'WBTC'],
      [CBBTC.address, WMON.address, 'cbBTC/MON', 'cbBTC'],
      [CBBTC.address, WETH.address, 'cbBTC/ETH', 'cbBTC'],
      [WBTC.address, CBBTC.address, 'WBTC/cbBTC', 'WBTC'],
    ];
    for (const [a, b, market, base] of cases) {
      // direction never changes the market or which leg is the base
      for (const m of [woofiMarketFor(a, b), woofiMarketFor(b.toUpperCase().replace('0X', '0x'), a)]) {
        expect(m?.market).toBe(market);
        expect(m?.base.symbol).toBe(base);
      }
    }
  });

  it('never resolves native MON, and leaves unregistered crosses out', () => {
    for (const m of woofiMarkets().values()) {
      expect(m.base.address).not.toBe(TOKENS.MON.address);
      expect(m.quote.address).not.toBe(TOKENS.MON.address);
    }
    // XAUt0↔WBTC is unlisted in @shared PAIRS (quote-leg wrap basis)
    expect(woofiMarketFor(TOKENS.XAUT0.address, TOKENS.WBTC.address)).toBeUndefined();
  });
});

/** Live pool state recorded 2026-10-27 (tokenInfos / decimalInfo): WETH,
 *  WBTC, cbBTC and WMON listed with a $50k notional cap and feeRate 0; every
 *  other registry token answers all-zero. */
const LISTED: Record<string, { info: readonly [bigint, number, bigint, bigint, bigint]; baseDec: bigint }> = {
  [TOKENS.WETH.address]: { info: [8_004_490_605_724_049_167n, 0, 3_000_000_000_000_000n, 50_000_000_000n, 35_000_000_000_000_000_000n], baseDec: 10n ** 18n },
  [TOKENS.WBTC.address]: { info: [20_312_636n, 0, 3_000_000_000_000_000n, 50_000_000_000n, 100_000_000n], baseDec: 10n ** 8n },
  [TOKENS.CBBTC.address]: { info: [23_306_402n, 0, 3_000_000_000_000_000n, 50_000_000_000n, 100_000_000n], baseDec: 10n ** 8n },
  [TOKENS.WMON.address]: { info: [7_469_665_454_689_604_709_395n, 0, 5_000_000_000_000_000n, 50_000_000_000n, 3_000_000_000_000_000_000_000_000n], baseDec: 10n ** 18n },
};

/** Real `query` answers at block 117,080,000 for the legs a $100 quote asks
 *  with the stub prices below (WETH $2,300, cbBTC $80,000), keyed
 *  from:to:amountIn. The $100k legs reverted CapExceeded() (0xa4875a49). */
const QUERY_AT_117080000: Record<string, bigint> = {
  [`${TOKENS.WETH.address}:${TOKENS.USDC.address}:43478260869565216`]: 101_902_344n,
  [`${TOKENS.USDC.address}:${TOKENS.WETH.address}:100000000`]: 42_607_541_765_923_511n,
  [`${TOKENS.CBBTC.address}:${TOKENS.WETH.address}:125000`]: 42_852_485_200_236_352n,
  [`${TOKENS.WETH.address}:${TOKENS.CBBTC.address}:43478260869565216`]: 126_649n,
};
const CAP_EXCEEDED = Object.assign(new Error('The contract function "query" reverted with the following signature:\n0xa4875a49'), { name: 'ContractFunctionExecutionError' });

const PRICES: Record<string, number> = { USDC: 1, WETH: 2300, CBBTC: 80_000, WBTC: 80_000, WMON: 0.02 };
function stubCtx(opts: { notes?: Array<{ code: string; msg: string }>; quoteToken?: string; oracle?: string; queryLive?: boolean; multicalls?: any[]; state?: AdapterState } = {}) {
  const lower = (a: string) => a.toLowerCase();
  const listed = new Map(Object.entries(LISTED).map(([a, v]) => [lower(a), v]));
  const recorded = new Map(Object.entries(QUERY_AT_117080000).map(([k, v]) => [lower(k), v]));
  return {
    client: {
      getBlockNumber: async () => 117_080_000n,
      readContract: async ({ functionName }: any) =>
        functionName === 'quoteToken' ? (opts.quoteToken ?? TOKENS.USDC.address)
          : functionName === 'wooracle' ? (opts.oracle ?? '0xf9b0c8Ee13AE2fC0665764ecbdB417685dEa8081')
            : undefined,
      multicall: async (args: any) => {
        opts.multicalls?.push(args);
        return args.contracts.map((c: any) => {
          const token = lower(String(c.args[0]));
          if (c.functionName === 'tokenInfos') return { status: 'success', result: listed.get(token)?.info ?? [0n, 0, 0n, 0n, 0n] };
          if (c.functionName === 'decimalInfo') return { status: 'success', result: [100_000_000n, 1_000_000n, listed.get(token)?.baseDec ?? 0n] };
          const out = opts.queryLive === false ? undefined : recorded.get(lower(c.args.join(':')));
          return out !== undefined ? { status: 'success', result: out } : { status: 'failure', error: CAP_EXCEEDED };
        });
      },
    },
    pricer: {
      pairMid: (m: string) => (m === 'ETH/USDC' ? 2300 : m === 'cbBTC/ETH' ? 80_000 / 2300 : 0),
      usdPerToken: (k: string) => PRICES[k] ?? 0,
      tokenForUsd: (k: string, usd: number) => usd / PRICES[k],
    },
    note: (code: string, msg: string) => { opts.notes?.push({ code, msg }); },
    state: opts.state,
  } as any;
}

describe('WOOFi discovery', () => {
  it('lists the 10 registered markets its four live base tokens span, fee read on-chain', async () => {
    const adapter = createWoofiAdapter();
    const notes: Array<{ code: string; msg: string }> = [];
    await adapter.discover(stubCtx({ notes }));
    expect([...adapter.quoteMarkets!()].sort()).toEqual([
      'BTC/ETH', 'BTC/MON', 'BTC/USDC', 'ETH/USDC', 'MON/ETH', 'MON/USDC', 'WBTC/cbBTC', 'cbBTC/ETH', 'cbBTC/MON', 'cbBTC/USDC',
    ]);
    expect(notes).toEqual([{ code: 'venue.discovery', msg: expect.stringContaining('10 registered market(s) across 4 listed base token(s)') }]);
  });

  it('fails loud on a quote token that is not USDC — swapVol would be mis-scaled', async () => {
    await expect(createWoofiAdapter().discover(stubCtx({ quoteToken: TOKENS.USDT0.address }))).rejects.toThrow('not USDC');
  });

  it('holds the gas cursor until the oracle is read, then keeps every oracle it has priced from', async () => {
    const adapter = createWoofiAdapter();
    expect(() => adapter.gasSources!()).toThrow('not resolved');
    await adapter.discover(stubCtx());
    expect(adapter.gasSources!()).toEqual([{
      mode: 'blocks',
      address: ['0x2a375567f5e13f6bd74fda7627df3b1af6bfa5a6', '0xf9b0c8ee13ae2fc0665764ecbdb417685dea8081'],
    }]);
  });

  it('adds a rotated-in oracle (a pure addition) and says so', async () => {
    const adapter = createWoofiAdapter();
    const notes: Array<{ code: string; msg: string }> = [];
    await adapter.discover(stubCtx({ notes, oracle: '0x00000000000000000000000000000000000000AA' }));
    expect(adapter.gasSources!()[0].address).toEqual([
      '0x2a375567f5e13f6bd74fda7627df3b1af6bfa5a6',
      '0xf9b0c8ee13ae2fc0665764ecbdb417685dea8081',
      '0x00000000000000000000000000000000000000aa',
    ]);
    expect(notes.map((n) => n.code)).toContain('venue.upgraded');
  });

  // ctx.state as the live indexer provides it: durable across adapter
  // instances (restarts), with a set that resolves after commit.
  const memoryState = (): AdapterState & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, get: (k) => data.get(k), set: async (k, v) => { data.set(k, v); } };
  };
  const A = '0x00000000000000000000000000000000000000aa';
  const B = '0x00000000000000000000000000000000000000bb';
  const KNOWN = ['0x2a375567f5e13f6bd74fda7627df3b1af6bfa5a6', '0xf9b0c8ee13ae2fc0665764ecbdb417685dea8081'];

  it('keeps every oracle across successive rotations and a restart — the gas set only grows', async () => {
    const state = memoryState();
    const before = createWoofiAdapter();
    await before.discover(stubCtx({ state, oracle: A }));
    await before.discover(stubCtx({ state, oracle: B })); // A rotated out
    expect(before.gasSources!()[0].address).toEqual([...KNOWN, A, B]);

    // restart after the rotation: A is no longer live and not pinned, yet
    // dropping it would rebuild the series without its burn.
    const after = createWoofiAdapter();
    await after.discover(stubCtx({ state, oracle: B }));
    expect(after.gasSources!()[0].address).toEqual([...KNOWN, A, B]);
    expect(readObservedOracles(state.data.get('observed_wooracles'))).toEqual([A, B]);
  });

  it('holds the gas cursor on the old set when the new oracle cannot be persisted', async () => {
    const state = memoryState();
    const adapter = createWoofiAdapter();
    await adapter.discover(stubCtx({ state }));
    state.set = async () => { throw new Error('disk full'); };
    await expect(adapter.discover(stubCtx({ state, oracle: A }))).rejects.toThrow('disk full');
    expect(adapter.gasSources!()[0].address).toEqual(KNOWN);

    const fresh = createWoofiAdapter();
    await expect(fresh.discover(stubCtx({ state, oracle: A }))).rejects.toThrow('disk full');
    expect(() => fresh.gasSources!()).toThrow('not resolved');
  });

  it('refuses unreadable persisted state rather than shrinking the set', async () => {
    expect(readObservedOracles(undefined)).toEqual([]);
    expect(() => readObservedOracles('not json')).toThrow('unreadable');
    expect(() => readObservedOracles('["0xAA"]')).toThrow('unreadable');
    const state = memoryState();
    state.data.set('observed_wooracles', '{');
    const adapter = createWoofiAdapter();
    await expect(adapter.discover(stubCtx({ state }))).rejects.toThrow('unreadable');
    expect(() => adapter.gasSources!()).toThrow('not resolved');
  });
});

describe('WOOFi quotes (real query answers)', () => {
  it('turns executable query outputs into pair-terms bid/ask and drops sizes past the caps', async () => {
    const adapter = createWoofiAdapter();
    const multicalls: any[] = [];
    const ctx = stubCtx({ multicalls });
    await adapter.discover(ctx);
    const rows = await adapter.quote!(ctx, [100, 100_000], 117_080_000n, new Set(['ETH/USDC', 'cbBTC/ETH']));
    // pinned to the frame's block
    expect(multicalls.at(-1)).toHaveProperty('blockNumber', 117_080_000n);
    expect(rows.map((r) => `${r.market}@${r.sizeUsd}`).sort()).toEqual(['ETH/USDC@100', 'cbBTC/ETH@100']);

    const eth = rows.find((r) => r.market === 'ETH/USDC')!;
    expect(eth.bidPx).toBeCloseTo(101.902344 / 0.043478260869565216, 6);   // 2343.754
    expect(eth.askPx).toBeCloseTo(100 / 0.042607541765923511, 6);           // 2347.007
    expect(eth.bidBps).toBeCloseTo((eth.bidPx / 2300 - 1) * 1e4, 9);
    expect(eth.spreadBps).toBeCloseTo((eth.askPx - eth.bidPx) / 2300 * 1e4, 9);
    expect(eth).toMatchObject({ venueId: 'woofi', filledFull: true, feeBps: 0 });
    expect(eth.oneSided).toBeUndefined();

    const cross = rows.find((r) => r.market === 'cbBTC/ETH')!;
    expect(cross.bidPx).toBeCloseTo(0.042852485200236352 / 0.00125, 9);    // ETH per cbBTC
    expect(cross.askPx).toBeCloseTo(0.043478260869565216 / 0.00126649, 9);
    expect(cross.askPx).toBeGreaterThan(cross.bidPx);
  });

  it('keeps a half-market as one-sided', async () => {
    const adapter = createWoofiAdapter();
    const ctx = stubCtx();
    await adapter.discover(ctx);
    const base = ctx.client.multicall;
    // the pool runs out of WETH to pay: every buy leg reverts
    ctx.client.multicall = async (args: any) => (await base(args)).map((r: any, i: number) =>
      String(args.contracts[i].args[0]).toLowerCase() === TOKENS.USDC.address ? { status: 'failure', error: CAP_EXCEEDED } : r);
    const [row] = await adapter.quote!(ctx, [100], 117_080_000n, new Set(['ETH/USDC']));
    expect(row).toMatchObject({ market: 'ETH/USDC', oneSided: true, askPx: 0 });
    expect(row.bidPx).toBeGreaterThan(0);
  });

  it('names an outage instead of vanishing when every leg reverts', async () => {
    const adapter = createWoofiAdapter();
    const notes: Array<{ code: string; msg: string }> = [];
    const ctx = stubCtx({ notes, queryLive: false });
    await adapter.discover(ctx);
    expect(await adapter.quote!(ctx, [100], 117_080_000n)).toEqual([]);
    expect(notes.map((n) => n.code)).toContain('venue.quote.unavailable');
  });
});

describe('WOOFi decode and proxy upgrades', () => {
  it('decodes fills with no discovery at all — the swap names its own tokens', async () => {
    const fills = await createWoofiAdapter().decode(stubCtx(), { pool: parse(SELL_ETH, WETH_TO_CBBTC) }, () => 1, new Set());
    expect(fills.map((f) => f.market)).toEqual(['ETH/USDC', 'cbBTC/ETH']);
  });

  it('stays silent on the implementation it was verified against', async () => {
    const notes: Array<{ code: string; msg: string }> = [];
    const fills = await createWoofiAdapter().decode(stubCtx({ notes }), { pool: parse(CREATION_UPGRADE, SELL_ETH) }, () => 1, new Set());
    expect(fills).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it('announces any other implementation and re-reads the layout', async () => {
    const notes: Array<{ code: string; msg: string }> = [];
    const upgrade = { ...parse(CREATION_UPGRADE)[0], args: { implementation: '0x127a5b18e3e96fc104f5eaf280dfe502dd3fd40a' } };
    const fills = await createWoofiAdapter().decode(stubCtx({ notes }), { pool: [upgrade, ...parse(SELL_ETH)] }, () => 1, new Set());
    expect(fills).toHaveLength(1);
    expect(notes.filter((n) => n.code === 'venue.upgraded')).toEqual([{ code: 'venue.upgraded', msg: expect.stringContaining('0x127a…d40a') }]);
    expect(notes.some((n) => n.code === 'venue.discovery')).toBe(true);
  });

  it('holds the cursor when an upgrade changed the quote token', async () => {
    const upgrade = { ...parse(CREATION_UPGRADE)[0], args: { implementation: '0x127a5b18e3e96fc104f5eaf280dfe502dd3fd40a' } };
    await expect(createWoofiAdapter().decode(stubCtx({ quoteToken: TOKENS.USDT0.address }), { pool: [upgrade, ...parse(SELL_ETH)] }, () => 1, new Set()))
      .rejects.toThrow('not USDC');
  });
});
