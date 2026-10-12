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
  const hit = [...FX.v0Swaps, ...FX.v1Swaps].find((l: any) => BigInt(l.blockNumber) === bn);
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
