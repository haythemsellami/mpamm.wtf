// Metric fill decode, both generations, on REAL recorded logs
// (fixtures/metric.json — raw eth_getLogs topics/data). Every expected number
// below was cross-checked against the same tx's ERC-20 Transfer logs: the
// pool-side transfers equal the Swap's deltas exactly, and their direction
// fixes the sign convention (positive = the pool gained the token).
import { readFileSync } from 'node:fs';
import { decodeEventLog } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import { createMetricAdapter } from '../metric.js';
import { metricV0PoolAbi } from '../metric-v0.js';
import { V1_FACTORY, metricV1FactoryAbi, metricV1PoolAbi, unpackAmountDeltas } from '../metric-v1.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/metric.json', import.meta.url), 'utf8'));

/** a raw log as the core hands it to decode(): viem-decoded args, bigint block, numeric index */
const asCoreLog = (raw: any, abi: readonly unknown[]) => ({
  ...raw,
  blockNumber: BigInt(raw.blockNumber),
  logIndex: Number(raw.logIndex),
  args: (decodeEventLog({ abi: abi as any, data: raw.data, topics: raw.topics }) as any).args,
});
const tsOf = (bn: bigint) => {
  const hit = [...FX.v0Swaps, ...FX.v1Swaps, ...FX.v1WantxSwaps].find((l: any) => BigInt(l.blockNumber) === bn);
  if (!hit) throw new Error(`no fixture timestamp for ${bn}`);
  return hit.blockTimestamp * 1000;
};

const WMON_POOL = '0xe6831acf980c2dfc5ae993f06b198d872fddf515';
const AUSD_POOL = '0x94d5e3543a39c0ec1171f14a45100bd62bee49bc';
/** minimal chain stub: the v1 factory lists the two pools the fixtures touch */
const ctx = {
  client: {
    readContract: async () => 3n,
    multicall: async ({ contracts, allowFailure }: any) => {
      const out = contracts.map((c: any) => {
        if (c.functionName === 'idxToPool') return { status: 'success', result: [WMON_POOL, AUSD_POOL][Number(c.args[0]) - 1] };
        if (c.functionName === 'getImmutables') {
          const ausd = String(c.address).toLowerCase() === AUSD_POOL;
          return { status: 'success', result: { factory: V1_FACTORY, token0: ausd ? TOKENS.AUSD.address : TOKENS.WMON.address, token1: TOKENS.USDC.address, immutablePriceProvider: '0x' + 'b'.repeat(40) } };
        }
        if (c.functionName === 'priceProvider') return { status: 'success', result: '0x' + 'b'.repeat(40) };
        return { status: 'failure' };
      });
      return allowFailure === false ? out.map((r: any) => r.result) : out;
    },
  },
  note: () => {},
} as any;

async function decodeAll() {
  const a = createMetricAdapter();
  await a.discover(ctx);
  const keyOf = (prefix: string) => a.logSources().find((s) => s.key.startsWith(prefix))!.key;
  const bundle = {
    'v0:swap': FX.v0Swaps.map((l: any) => asCoreLog(l, metricV0PoolAbi)),
    [keyOf('v1:swap@')]: FX.v1Swaps.map((l: any) => asCoreLog(l, metricV1PoolAbi)),
    'v1:poolCreated': [],
  };
  return a.decode(ctx, bundle, tsOf, new Set());
}

describe('Metric v1 Swap decode (packed deltas)', () => {
  it('unpacks Packed2Int128 as token0 = high, token1 = low, both sign-extended', () => {
    const raw = FX.v1Swaps[0];
    const args = (decodeEventLog({ abi: metricV1PoolAbi, data: raw.data, topics: raw.topics }) as any).args;
    expect(unpackAmountDeltas(args.amountDeltas)).toEqual([359_625_382_330_000_000_000n, -12_031_717n]);
  });

  it('the first v1 swap: a SELL of 359.625 WMON for 12.031717 USDC (tx 0x37cb97f4…)', async () => {
    const f = (await decodeAll()).find((x) => x.txHash === FX.v1Swaps[0].transactionHash)!;
    expect(f).toMatchObject({
      id: `metric-${FX.v1Swaps[0].transactionHash}-97`,
      venueId: 'metric', market: 'MON/USDC', side: 'sell', category: 'UNKNOWN',
      blockNumber: 110474867, pool: 'metric 0xe6831a',
    });
    expect(f.usd).toBeCloseTo(12.031717, 9);
    expect(f.baseAmount).toBeCloseTo(359.62538233, 9);
    expect(f.execPx).toBeCloseTo(12.031717 / 359.62538233, 12);
    expect(f.ts).toBe(FX.v1Swaps[0].blockTimestamp * 1000);
  });

  it('a BUY inside a multi-swap tx: 721.762571 USDC in, 29761.3677 WMON out (tx 0xb3c235dc…, log 10)', async () => {
    const f = (await decodeAll()).find((x) => x.txHash === FX.v1Swaps[1].transactionHash)!;
    expect(f).toMatchObject({ id: `metric-${FX.v1Swaps[1].transactionHash}-10`, side: 'buy', market: 'MON/USDC' });
    expect(f.usd).toBeCloseTo(721.762571, 9);
    expect(f.baseAmount).toBeCloseTo(29761.367737552755, 9);
  });

  it('drops the AUSD/USDC pool: stable/stable is not a benchmarkable market', async () => {
    const fills = await decodeAll();
    expect(fills.some((x) => x.txHash === FX.v1Swaps[2].transactionHash)).toBe(false);
  });
});

// v1 pool #11, the first pool with a share-wrapper base. Hand-checked from the
// raw amountDeltas words: 0xfff…f50cc76ce6cae5 | 0x…493e0 is −3082174078727451
// wei of wANTx and +300000 of USDC, and the tx's pool-side Transfers are the
// same two numbers (wANTx out, USDC in); the second swap is the mirror.
describe('Metric v1 wANTx/USDC decode (18-decimal share wrapper, real logs)', () => {
  const WANTX_POOL = '0x035c19f38b2c391067e5aa9ade3644c9171fb71c';
  const SHARES = 0.003082174078727451;
  const ctx11 = {
    client: {
      readContract: async () => 2n,
      multicall: async ({ contracts, allowFailure }: any) => {
        const out = contracts.map((c: any) => {
          if (c.functionName === 'idxToPool') return { status: 'success', result: WANTX_POOL };
          if (c.functionName === 'getImmutables') return { status: 'success', result: { factory: V1_FACTORY, token0: TOKENS.WANTX.address, token1: TOKENS.USDC.address, immutablePriceProvider: '0x' + '0'.repeat(40) } };
          if (c.functionName === 'priceProvider') return { status: 'success', result: '0x' + 'b'.repeat(40) };
          return { status: 'failure' };
        });
        return allowFailure === false ? out.map((r: any) => r.result) : out;
      },
    },
    note: () => {},
  } as any;
  const decode11 = async () => {
    const a = createMetricAdapter();
    await a.discover(ctx11);
    const key = a.logSources().find((s) => s.key.startsWith('v1:swap@'))!.key;
    return a.decode(ctx11, { 'v0:swap': [], [key]: FX.v1WantxSwaps.map((l: any) => asCoreLog(l, metricV1PoolAbi)), 'v1:poolCreated': [] }, tsOf, new Set());
  };

  it('unpacks both swaps to the wei: the same shares out, then back in', () => {
    const deltas = FX.v1WantxSwaps.map((raw: any) => unpackAmountDeltas((decodeEventLog({ abi: metricV1PoolAbi, data: raw.data, topics: raw.topics }) as any).args.amountDeltas));
    expect(deltas).toEqual([[-3_082_174_078_727_451n, 300_000n], [3_082_174_078_727_451n, -298_325n]]);
  });

  it('the first swap: a BUY of 0.003082174078727451 wANTx for 0.30 USDC (tx 0xc9f4c9e0…)', async () => {
    const f = (await decode11()).find((x) => x.txHash === FX.v1WantxSwaps[0].transactionHash)!;
    expect(f).toMatchObject({
      id: `metric-${FX.v1WantxSwaps[0].transactionHash}-236`,
      venueId: 'metric', market: 'wANTx/USDC', side: 'buy', category: 'UNKNOWN',
      blockNumber: 123648251, pool: 'metric 0x035c19', ts: 1795111313000,
    });
    expect(f.usd).toBeCloseTo(0.3, 12);
    expect(f.baseAmount).toBeCloseTo(SHARES, 18);
    expect(f.execPx).toBeCloseTo(97.33389236, 6);      // USDC per wANTx; Kraken's ANTx/USD traded ~$97 that hour
  });

  it('the round trip back: a SELL of the same shares for 0.298325 USDC (tx 0x9fa00001…, log 167)', async () => {
    const f = (await decode11()).find((x) => x.txHash === FX.v1WantxSwaps[1].transactionHash)!;
    expect(f).toMatchObject({ id: `metric-${FX.v1WantxSwaps[1].transactionHash}-167`, market: 'wANTx/USDC', side: 'sell', blockNumber: 123648272 });
    expect(f.usd).toBeCloseTo(0.298325, 12);
    expect(f.baseAmount).toBeCloseTo(SHARES, 18);
    expect(f.execPx).toBeCloseTo(0.298325 / SHARES, 9);
  });

  it('counts both fills with no reference at all (this ctx has no pricer): parity gates the reference, never fills', async () => {
    expect((await decode11()).map((f) => f.market)).toEqual(['wANTx/USDC', 'wANTx/USDC']);
  });
});

describe('Metric v0 Swap decode (retired generation stays replayable)', () => {
  it('the last v0 swap: a BUY of 0.00007887 WBTC for 6.667031 USDC (8-decimal base)', async () => {
    const f = (await decodeAll()).find((x) => x.txHash === FX.v0Swaps[0].transactionHash)!;
    // pool label in the checksum spelling the pre-split adapter stored
    expect(f).toMatchObject({ id: `metric-${FX.v0Swaps[0].transactionHash}-173`, venueId: 'metric', market: 'BTC/USDC', side: 'buy', blockNumber: 108406568, pool: 'metric 0x2D82AC' });
    expect(f.baseAmount).toBeCloseTo(0.00007887, 12);
    expect(f.usd).toBeCloseTo(6.667031, 9);
    expect(f.execPx).toBeCloseTo(6.667031 / 0.00007887, 6);
  });

  it('ids are generation-free: the same tx/log yields the id it had before the split', async () => {
    const ids = (await decodeAll()).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^metric-0x[0-9a-f]{64}-\d+$/);
  });
});

describe('Metric v1 PoolCreated (real log)', () => {
  it('decodes poolAddress from the recorded #6 creation — the event signature matches the chain', () => {
    const raw = FX.v1PoolCreated;
    const args = (decodeEventLog({ abi: metricV1FactoryAbi, data: raw.data, topics: raw.topics }) as any).args;
    expect(String(args.poolAddress).toLowerCase()).toBe(WMON_POOL);
    expect(raw.address).toBe(V1_FACTORY);
  });
});
