// BTR quote() on RECORDED getSwapQuote results (fixtures/btr-quotes.json — raw
// eth_call return data from pool v2 at block 122,736,377, and the raw revert
// of a leg it refused). The stub answers a leg only with what the pool
// answered for exactly that (tokenIn, tokenOut, amountIn); a leg the adapter
// sized any other way has no recording and fails the test, so the input
// decimals are checked by the lookup itself.
//
// Hand check from the tuples (amountOut is net of protoFee, lpFee and covToll):
//   MON/USDC $100   sell 6400 WMON -> 97.286130 USDC            bid 0.0152009578125
//                   buy 100 USDC -> 6565.395285784463596801 WMON ask 0.0152313753624
//                   fee (8919+80277)/(97286130+8919+80277)       9.160 bps each side
//   BTC/USDC $100   sell 0.0015625 WBTC -> 100.171583 USDC       bid 64109.81312
//                   buy 100 USDC -> 0.00155757 WBTC              ask 64202.57195503
//                   fee 6.115 bps (sell), 6.159 bps (buy)        mean 6.137
//   MON/USDC $15.5k sell 992,000 WMON reverts 0xb8edb9ac (past the pool's cover)
//                   buy 15,500 USDC -> 914138.187019147875 WMON  ask 0.0169558609629
import { readFileSync } from 'node:fs';
import { decodeFunctionResult } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import { BTR_POOL, createBtrAdapter } from '../btr.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/btr-quotes.json', import.meta.url), 'utf8'));
const RECORDED_BLOCK = BigInt(FX.blockNumber);

/** USD sizing prices under which the recorded legs are exact token amounts:
 *  $100 is 6,400 WMON and 0.0015625 WBTC. */
const USD: Record<string, number> = { USDC: 1, WMON: 1 / 64, WBTC: 64_000 };
/** the pair-terms reference mids the bps are anchored to (the pool's own marks
 *  at that block were 0.0152157 and 64,154.40). */
const MID: Record<string, number> = { 'MON/USDC': 0.0152, 'BTC/USDC': 64_150 };
const LISTED = ['USDC', 'WMON', 'WBTC'];

const legKey = (tokenIn: string, tokenOut: string, amountIn: bigint) => `${tokenIn.toLowerCase()}>${tokenOut.toLowerCase()}:${amountIn}`;
const RECORDED = new Map<string, any>(FX.legs.map((l: any) => [legKey(l.tokenIn, l.tokenOut, BigInt(l.amountIn)), l]));

interface Seen { heads: number; quoteCalls: any[]; notes: Array<{ code: string; msg: string }> }

/** A ctx whose pool is the recording. Results are decoded with the ABI the
 *  adapter itself sent, so a drift in its getSwapQuote tuple fails here; a
 *  refused leg carries the error shape viem's allowFailure multicall gave. */
function stubCtx(seen: Seen): any {
  return {
    note: (code: string, msg: string) => { seen.notes.push({ code, msg }); },
    client: {
      getBlockNumber: async () => { seen.heads++; return RECORDED_BLOCK; },
      multicall: async (args: any) => {
        if (args.contracts[0]?.functionName === 'getSwapQuote') seen.quoteCalls.push(args);
        return args.contracts.map((c: any) => {
          if (c.functionName !== 'getSwapQuote') {
            // discovery: USDC, WMON and WBTC are listed and swap-enabled, the rest read back zeroed
            const key = Object.keys(TOKENS).find((k) => TOKENS[k].address.toLowerCase() === String(c.args[0]).toLowerCase())!;
            const listed = LISTED.includes(key);
            return { status: 'success', result: c.functionName === 'getRiskFlags' ? (listed ? 16 : 0) : { decimals: listed ? TOKENS[key].decimals : 0 } };
          }
          const leg = RECORDED.get(legKey(c.args[0], c.args[1], c.args[2]));
          if (!leg) throw new Error(`no recorded getSwapQuote for ${c.args.join(', ')}`);
          if (leg.returnData) return { status: 'success', result: decodeFunctionResult({ abi: c.abi, functionName: 'getSwapQuote', data: leg.returnData }) };
          return {
            status: 'failure',
            error: Object.assign(new Error(leg.viemError.shortMessage), {
              name: leg.viemError.name,
              cause: Object.assign(new Error('execution reverted'), { name: leg.viemError.causeName, raw: leg.revertData }),
            }),
          };
        });
      },
    },
    pricer: {
      pairMid: (market: string) => MID[market] ?? 0,
      usdPerToken: (key: string) => USD[key] ?? 0,
      tokenForUsd: (key: string, usd: number) => (USD[key] ? usd / USD[key] : 0),
    },
  };
}

/** a discovered adapter and the record of what quote() then asked the chain */
async function discovered() {
  const seen: Seen = { heads: 0, quoteCalls: [], notes: [] };
  const adapter = createBtrAdapter();
  const ctx = stubCtx(seen);
  await adapter.discover(ctx);
  seen.heads = 0;
  seen.notes.length = 0;
  return { adapter, ctx, seen };
}
const only = (market: string) => new Set([market]);
const bps = (px: number, mid: number) => (px / mid - 1) * 1e4;

describe('BTR quote (recorded getSwapQuote)', () => {
  it('prices both sides of an 18-decimal base against a 6-decimal quote', async () => {
    const { adapter, ctx, seen } = await discovered();
    const rows = await adapter.quote!(ctx, [100], RECORDED_BLOCK, only('MON/USDC'));

    // each side is sized in its INPUT token's own units: $100 of WMON, then $100 of USDC
    expect(seen.quoteCalls).toHaveLength(1);
    expect(seen.quoteCalls[0].contracts.map((c: any) => [c.address, c.functionName, ...c.args])).toEqual([
      [BTR_POOL, 'getSwapQuote', TOKENS.WMON.address, TOKENS.USDC.address, 6_400n * 10n ** 18n],
      [BTR_POOL, 'getSwapQuote', TOKENS.USDC.address, TOKENS.WMON.address, 100_000_000n],
    ]);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ venueId: 'btr', market: 'MON/USDC', sizeUsd: 100, filledFull: true });
    expect(row.oneSided).toBeUndefined();
    // sell: USDC out (6 decimals) per WMON in (18); buy: USDC in per WMON out
    expect(row.bidPx).toBeCloseTo(97.28613 / 6400, 12);
    expect(row.bidPx).toBeCloseTo(0.0152009578125, 12);
    expect(row.askPx).toBeCloseTo(0.015231375362352, 12);
    expect(row.bidBps).toBeCloseTo(bps(0.0152009578125, 0.0152), 6);   //  +0.63
    expect(row.askBps).toBeCloseTo(bps(0.015231375362352, 0.0152), 6); // +20.64
    expect(row.spreadBps).toBeCloseTo(20.011546, 4);
  });

  it('prices an 8-decimal base in both directions', async () => {
    const { adapter, ctx } = await discovered();
    const [row] = await adapter.quote!(ctx, [100], RECORDED_BLOCK, only('BTC/USDC'));
    expect(row).toMatchObject({ market: 'BTC/USDC', sizeUsd: 100, filledFull: true });
    // 156,250 sats in -> 100.171583 USDC; 100 USDC in -> 155,757 sats
    expect(row.bidPx).toBeCloseTo(64_109.81312, 6);
    expect(row.askPx).toBeCloseTo(64_202.571955, 5);
    expect(row.bidBps).toBeCloseTo(bps(64_109.81312, 64_150), 6);  // -6.26
    expect(row.askBps).toBeCloseTo(bps(64_202.571955, 64_150), 5); // +8.20
    expect(row.spreadBps).toBeCloseTo(14.459678, 4);
  });

  it('takes the fee over the GROSS output, per leg, and averages the two sides', async () => {
    const { adapter, ctx } = await discovered();
    const [mon] = await adapter.quote!(ctx, [100], RECORDED_BLOCK, only('MON/USDC'));
    const [btc] = await adapter.quote!(ctx, [100], RECORDED_BLOCK, only('BTC/USDC'));
    // (protoFee + lpFee) / (amountOut + protoFee + lpFee), in tokenOut units.
    // Over the NET amountOut these would read 9.168 and 6.1405 instead.
    expect(mon.feeBps).toBeCloseTo(9.16, 3);
    expect(btc.feeBps).toBeCloseTo((6.115 + 6.159) / 2, 3);
  });

  it('pins the multicall to the frame block without a head read of its own', async () => {
    const { adapter, ctx, seen } = await discovered();
    expect((await adapter.quote!(ctx, [100], 123n, only('MON/USDC'))).length).toBe(1);
    expect(seen.heads).toBe(0);
    expect(seen.quoteCalls).toHaveLength(1);
    expect(seen.quoteCalls[0]).toHaveProperty('blockNumber', 123n);
    expect(seen.quoteCalls[0]).not.toHaveProperty('blockTag');
    expect(seen.quoteCalls[0]).toHaveProperty('allowFailure', true);
  });

  it('keeps the surviving side as a one-sided row when the pool refuses the other', async () => {
    const { adapter, ctx, seen } = await discovered();
    const rows = await adapter.quote!(ctx, [FX.oneSidedSizeUsd], RECORDED_BLOCK, only('MON/USDC'));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ market: 'MON/USDC', sizeUsd: 15_500, oneSided: true, bidPx: 0, bidBps: 0, spreadBps: 0 });
    // 15,500 USDC in -> 914,138.187 WMON out: the size-dependent toll puts it far off mid
    expect(row.askPx).toBeCloseTo(0.016955860962928, 12);
    expect(row.askBps).toBeCloseTo(bps(0.016955860962928, 0.0152), 6); // +1155.17
    expect(row.feeBps).toBeCloseTo(9.16, 3);
    // one refused leg is a thin side, not a venue outage: nothing is announced
    expect(seen.notes).toEqual([]);
  });
});
