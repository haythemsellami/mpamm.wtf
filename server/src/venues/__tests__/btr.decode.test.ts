// BTR `Swapped` decode on recorded Monad mainnet logs (fixtures/btr-swapped.json).
// The three swaps are the retired pool's: pool v2 has not swapped yet and emits
// the same event. Hand check from the raw `amounts` word (amountIn = low 128
// bits, amountOut = high 128), each half equal to the ERC-20 transfer into or
// out of the pool in the same tx:
//   buy    168.286102 USDC in, 4923.169136709459298021 WMON out => 0.034182
//   sell   4786.444594106445540380 WMON in, 164.518345 USDC out => 0.034372
//   cross  0.00479999 WBTC in, 0.00479561 cbBTC out             => 0.999087
import { readFileSync } from 'node:fs';
import { decodeEventLog } from 'viem';
import { describe, expect, it } from 'vitest';
import { NATIVE_MON, TOKENS } from '@shared';
import { BTR_POOL, BTR_RETIRED_POOL, btrMarkets, createBtrAdapter, decodeBtrSwap } from '../btr.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/btr-swapped.json', import.meta.url), 'utf8'));
/** the adapter's own declared events, so a drift in its ABI fails here */
const abi = createBtrAdapter().logSources()[0].events as any[];

/** a raw log as the core hands it to decode(): viem-decoded args, bigint block, numeric index. */
const asCoreLog = (raw: any) => ({
  ...raw,
  blockNumber: BigInt(raw.blockNumber),
  logIndex: Number(raw.logIndex),
  ...(decodeEventLog({ abi, data: raw.data, topics: raw.topics }) as any),
});
const tsOfLog = (raw: any) => Number(raw.blockTimestamp) * 1000;
const BTC_USD = 110_000;
/** stables at $1, both BTC wrappers at one fixed price, nothing else priced */
const usdForToken = (key: string, amount: number) =>
  TOKENS[key].stable ? amount : key === 'WBTC' || key === 'CBBTC' ? amount * BTC_USD : 0;

describe('BTR sources', () => {
  it('is one static log source carrying both pools, fills and upgrades', () => {
    const sources = createBtrAdapter().logSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ key: 'pool', address: [BTR_POOL, BTR_RETIRED_POOL], kind: 'fills' });
    expect(sources[0].events.map((e: any) => e.name)).toEqual(['Swapped', 'Upgraded']);
  });

  it("declares the pools as direct entry and BTR's executors as its own periphery", () => {
    const entries = createBtrAdapter().entryPoints!();
    expect(entries.filter((e) => !e.router).map((e) => e.address)).toEqual([BTR_POOL, BTR_RETIRED_POOL]);
    const periphery = entries.filter((e) => e.router);
    expect(periphery).toHaveLength(3);
    expect(periphery.every((e) => e.router === 'BTR' && /^0xbbbbbbb[0-9a-f]{33}$/.test(e.address))).toBe(true);
  });

  it('samples every known implementation for gas: marks are pushed to the implementation, not the proxy', () => {
    const [source] = createBtrAdapter().gasSources!();
    expect(source.mode).toBe('blocks');
    // pool v2's, as its recorded creation Upgraded names it, and the retired pool's
    expect(source.address).toContain(asCoreLog(FX.upgraded).args.implementation.toLowerCase());
    expect(source.address).toContain('0x154be75fff18c9dfdd15d7f902b64a7b93b2a638');
  });
});

describe('BTR Swapped decode (recorded Monad logs)', () => {
  const [buyLog, sellLog, crossLog] = FX.logs.map(asCoreLog);
  const [buyTs, sellTs, crossTs] = FX.logs.map(tsOfLog);

  it('USDC -> WMON is a buy of MON/USDC', () => {
    const f = decodeBtrSwap(buyLog, buyTs, usdForToken)!;
    expect(f.id).toBe('btr-0xd2beaa33c6b80fc3a1b0aae5ffdb0bfdcdd878024889828aa213f10003753922-182');
    expect(f.venueId).toBe('btr');
    expect(f.market).toBe('MON/USDC');
    expect(f.side).toBe('buy');
    expect(f.category).toBe('UNKNOWN');
    expect(f.usd).toBeCloseTo(168.286102, 9);
    expect(f.baseAmount).toBeCloseTo(4923.169136709459, 9);
    expect(f.execPx).toBeCloseTo(168.286102 / 4923.169136709459, 12);
    expect(f.blockNumber).toBe(109_923_373);
    expect(f.ts).toBe(1_790_952_940_000);
    expect(f.pool).toBe('btr 0xbbbbbbb0');
  });

  it('WMON -> USDC is a sell of MON/USDC', () => {
    const f = decodeBtrSwap(sellLog, sellTs, usdForToken)!;
    expect(f.id).toBe('btr-0x58a335d8bdd1cd76c35a5263307a9fd0cbb34190c183505e7053263dc96d34a5-12');
    expect(f.market).toBe('MON/USDC');
    expect(f.side).toBe('sell');
    expect(f.usd).toBeCloseTo(164.518345, 9);
    expect(f.baseAmount).toBeCloseTo(4786.444594106445, 9);
    expect(f.execPx).toBeCloseTo(164.518345 / 4786.444594106445, 12);
    expect(f.blockNumber).toBe(109_894_477);
  });

  it('a spoke-to-spoke swap is ONE event on the registered cross, valued off its quote leg', () => {
    const f = decodeBtrSwap(crossLog, crossTs, usdForToken)!;
    expect(f.market).toBe('WBTC/cbBTC');
    expect(f.side).toBe('sell');
    expect(f.baseAmount).toBeCloseTo(0.00479999, 12);
    expect(f.execPx).toBeCloseTo(0.00479561 / 0.00479999, 12);
    expect(f.usd).toBeCloseTo(0.00479561 * BTC_USD, 9);
  });

  it('decodes the same event from pool v2', () => {
    const f = decodeBtrSwap({ ...buyLog, address: BTR_POOL }, buyTs, usdForToken)!;
    expect(f.market).toBe('MON/USDC');
    expect(f.usd).toBeCloseTo(168.286102, 9);
    expect(f.pool).toBe('btr 0xbbbbbbbd');
  });

  it('drops logs from another address, a same-token pair, and malformed amounts', () => {
    expect(decodeBtrSwap({ ...buyLog, address: '0x' + '1'.repeat(40) }, buyTs, usdForToken)).toBeNull();
    expect(decodeBtrSwap({ ...buyLog, args: { ...buyLog.args, tokenOut: TOKENS.USDT0.address, tokenIn: TOKENS.USDT0.address } }, buyTs, usdForToken)).toBeNull();
    expect(decodeBtrSwap({ ...buyLog, args: { ...buyLog.args, amounts: 5n } }, buyTs, usdForToken)).toBeNull();
  });

  it('throws only when no leg can be priced', () => {
    expect(() => decodeBtrSwap(buyLog, buyTs, () => 0)).toThrow(/no USD price/);
  });
});

describe('BTR decode()', () => {
  const swaps = FX.logs.map(asCoreLog);
  const upgrade = asCoreLog(FX.upgraded);
  const tsOf = () => 1_790_952_940_000;
  /** decode() must never read the chain — a failed read there holds the shared
   *  cursor for every venue — so any client call fails the test. */
  const stubCtx = (notes: Array<{ code: string; msg: string }>): any => ({
    note: (code: string, msg: string) => notes.push({ code, msg }),
    client: new Proxy({}, { get: (_t, method) => () => { throw new Error(`decode() read the chain: ${String(method)}`); } }),
    pricer: { usdForToken },
  });

  it('passes over the recorded Upgraded: a known implementation', async () => {
    const notes: Array<{ code: string; msg: string }> = [];
    const out = await createBtrAdapter().decode(stubCtx(notes), { pool: [upgrade, ...swaps] }, tsOf, new Set());
    expect(out.map((f) => f.side)).toEqual(['buy', 'sell', 'sell']);
    expect(notes).toEqual([]);
  });

  it('announces an unknown implementation, keeps the fills around it and reads nothing', async () => {
    const notes: Array<{ code: string; msg: string }> = [];
    const foreign = { ...upgrade, args: { implementation: '0x' + '12'.repeat(20) } };
    const out = await createBtrAdapter().decode(stubCtx(notes), { pool: [swaps[0], foreign, swaps[1]] }, tsOf, new Set());
    expect(out.map((f) => f.side)).toEqual(['buy', 'sell']);
    expect(notes).toEqual([{ code: 'venue.upgraded', msg: expect.stringContaining('proxy 0xbbbb…e0c6 upgraded to 0x1212…1212') }]);
  });
});

describe('BTR discovery', () => {
  /** getAsset / getRiskFlags for every token discovery probes. `listed` keys
   *  answer with their registry decimals and the swap-enabled flag unless
   *  overridden; every other token reads back zeroed, which is what the pool
   *  returns for an asset it does not list (it does not revert). */
  const ctxWith = (listed: Record<string, { decimals?: number; flags?: number }>): any => ({
    note: () => {},
    client: {
      getBlockNumber: async () => 122_651_468n,
      multicall: async ({ contracts }: any) => contracts.map((c: any) => {
        const key = Object.keys(TOKENS).find((k) => TOKENS[k].address.toLowerCase() === String(c.args[0]).toLowerCase())!;
        const asset = listed[key];
        if (c.functionName === 'getRiskFlags') return { status: 'success', result: asset ? asset.flags ?? 16 : 0 };
        return { status: 'success', result: { decimals: asset ? asset.decimals ?? TOKENS[key].decimals : 0 } };
      }),
    },
  });

  it('skips assets the pool does not list instead of failing the venue', async () => {
    const a = createBtrAdapter();
    await a.discover(ctxWith({ USDC: {}, WMON: {}, WETH: {} }));
    expect([...a.quoteMarkets!()].sort()).toEqual(['ETH/USDC', 'MON/ETH', 'MON/USDC']);
  });

  it('picks up a registered token the pool lists later, with no edit to the adapter', async () => {
    const a = createBtrAdapter();
    await a.discover(ctxWith({ USDC: {}, WMON: {}, USD1: {} }));
    expect(a.quoteMarkets!()).toContain('MON/USD1');
  });

  it('leaves a listed asset without the swap-enabled flag unquoted', async () => {
    const a = createBtrAdapter();
    await a.discover(ctxWith({ USDC: {}, WMON: {}, WETH: { flags: 32 } }));
    expect([...a.quoteMarkets!()]).toEqual(['MON/USDC']);
  });

  it('still fails loud when a LISTED asset disagrees with the registry on decimals', async () => {
    await expect(createBtrAdapter().discover(ctxWith({ USDC: {}, WMON: { decimals: 8 } }))).rejects.toThrow(/WMON decimals mismatch/);
  });
});

describe('BTR market table', () => {
  it('maps every registered ERC-20 pair, with no listing filter', () => {
    const markets = [...btrMarkets().values()];
    const symbols = markets.map((m) => m.market);
    expect(symbols).toContain('MON/USDC');
    expect(symbols).toContain('WBTC/cbBTC');
    // not a pool asset today: its swaps decode the day it becomes one
    expect(symbols).toContain('SPYx/USDC');
    for (const m of markets) {
      expect(m.base.address).not.toBe(NATIVE_MON);
      expect(m.quote.address).not.toBe(NATIVE_MON);
    }
  });
});
