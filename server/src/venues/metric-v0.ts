import { parseAbi } from 'viem';
import type { Fill } from '@shared';
import type { AdapterContext, LogBundle } from './adapter.js';
import type { VenueGeneration } from './generations.js';
import { admitMetricPool, metricFill, type MetricPool } from './metric-shared.js';

/**
 * Metric v0 — the RETIRED first deployment (factory 0xe22F9fc0…, Router
 * 0xaF9ADa6b…; ABIs @nradko/metric-omm-sdk-v0). Kept for one reason: its
 * swaps are Metric's history from 2026-03-30 to 2026-09-27, and a lifetime
 * replay (BACKFILL_RESET=metric, a fresh DB) must be able to decode them
 * again. So it is decode-only and costs no RPC: no discovery, no quoting, and
 * its swap source is BOUNDED at the last v0 swap, so the core never fetches it
 * past that block (adapter.ts sourceSpan).
 *
 * Retirement, verified on-chain 2026-10-12: Metric's operator pulled the pools'
 * liquidity on 2026-09-30, the push oracle's last update was block 108407309
 * (2026-09-27), and the last Swap on any of the eight pools below is block
 * 108406568 (tx 0x1311eb38…, WBTC/USDC). A topic-only scan for the v0 Swap and
 * PoolCreated signatures from 109.4M to 112.77M found no emitter at all.
 *
 * Not tracked any more: a THIRD PARTY's new v0 pool. The v0 factory stays
 * permissionless on-chain, but nobody runs liquidity there and following it
 * would keep a forever getLogs alive for an abandoned contract.
 */

/** Last block with a v0 Swap — the swap source's span ends here. */
export const V0_LAST_SWAP_BLOCK = 108_406_568n;

/** The v0 push oracle the providers read (blocks mode, no logs). It went quiet
 *  with the pools, but STAYS a gas destination: dropping it from the set would
 *  classify as a removal and rebuild Metric's whole gas history without its
 *  share (gas.ts classifyGasSourceChange). An inert destination costs nothing
 *  in blocks mode — the sampled receipts are fetched for the live oracle anyway. */
export const V0_PUSH_ORACLE = '0x681e908b8ab57c49c74d770f369754ccc3e1ae09' as const;

/** Every pool the v0 factory ever created (its eight PoolCreated, blocks
 *  64911692 → 98326258), with the token layout getImmutables reports. Static
 *  because immutables are immutable and the factory is retired: there is no
 *  discovery left to do. All eight are base/USDC with the base as token0.
 *  Casing is DELIBERATE: the three funded seeds keep the checksum spelling the
 *  live adapter used, so a re-decoded fill's `pool` label (`metric 0xFA32f9`)
 *  is byte-identical to the stored one — analytics groups on that label. */
const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
const WBTC = '0x0555e30da8f98308edb960aa94c0db47230d2b9c';
const WETH = '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242';
const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
export const V0_POOLS: readonly { pool: `0x${string}`; token0: string; token1: string; priceProvider: string }[] = [
  { pool: '0x7e4d6287b0a36822bb454dff8500562ecde2d937', token0: WBTC, token1: USDC, priceProvider: '0x3a911762cf640b482e72fe53462419798c9ed591' },
  { pool: '0x2D82AC42334b394A9a8d8f097d61DC1c6B065Fd8', token0: WBTC, token1: USDC, priceProvider: '0x3a911762cf640b482e72fe53462419798c9ed591' }, // funded WBTC/USDC
  { pool: '0x3826750cbd476de7e15f71357a5c1c57c1b75e53', token0: WMON, token1: USDC, priceProvider: '0xf034c1d706e0939e6a5c64ea0fa98620b34964cf' },
  { pool: '0xFA32f9ec28787d1F9C5BA5c39e54e59984FEF3f0', token0: WMON, token1: USDC, priceProvider: '0xeafd2cde852fce3d00c743b46dcdec41e8168021' }, // funded WMON/USDC
  { pool: '0xe3eedcd6be6c8ebd37861deed30a99a12e984948', token0: WMON, token1: USDC, priceProvider: '0x3a911762cf640b482e72fe53462419798c9ed591' },
  { pool: '0x4e3613b28d00e83c85d616760a847f1a1411d9c4', token0: WETH, token1: USDC, priceProvider: '0x6f3ad3ff7e95f08fe852d46ec8170b4aab225ef8' },
  { pool: '0x354D92279cA0190fF275095fE6A2a6989BAa66Fb', token0: WETH, token1: USDC, priceProvider: '0x6f3ad3ff7e95f08fe852d46ec8170b4aab225ef8' }, // funded WETH/USDC
  { pool: '0x5357bf9863320e8fc0c10c97896c0aed070aab9f', token0: WMON, token1: USDC, priceProvider: '0xeafd2cde852fce3d00c743b46dcdec41e8168021' }, // WMON/USDC #2 (2026-08-22)
];

export const metricV0PoolAbi = parseAbi([
  'event Swap(address sender, address recipient, bool exactInput, int128 amount0Delta, int128 amount1Delta, int16 newTick, uint104 newPositionInBin)',
]);
const swapEvent = metricV0PoolAbi.find((x) => x.type === 'event' && x.name === 'Swap')!;

export function createMetricV0Generation(): VenueGeneration {
  // Admission is the same structural rule as v1 (registered base/stable pair),
  // applied once to the static table. A pool that fails it never traded a
  // market we report, so it is simply not tailed.
  const pools: MetricPool[] = V0_POOLS.flatMap((p) => {
    const verdict = admitMetricPool(p.pool, p);
    return verdict.ok ? [verdict.value] : [];
  });
  const byAddr = new Map(pools.map((p) => [p.pool.toLowerCase(), p]));

  return {
    discover: async () => {},
    logSources: () => [{ key: 'swap', address: pools.map((p) => p.pool), events: [swapEvent], kind: 'fills' as const, untilBlock: V0_LAST_SWAP_BLOCK }],
    // the 30-day markout onboarding still labels v0 fills, so the pools stay
    // DIRECT entry points while any of them can be in that window
    entryPoints: () => pools.map((p) => ({ address: p.pool })),
    gasSources: () => [{ mode: 'blocks' as const, address: [V0_PUSH_ORACLE] }],
    decode(_ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number): Fill[] {
      const out: Fill[] = [];
      for (const l of logs.swap ?? []) {
        const p = byAddr.get(String(l.address).toLowerCase());
        const a = l.args;
        if (!p || !a || a.amount0Delta === undefined || a.amount1Delta === undefined) continue;
        const f = metricFill(p, BigInt(a.amount0Delta), BigInt(a.amount1Delta), l, a.recipient, tsOf);
        if (f) out.push(f);
      }
      return out;
    },
  };
}
