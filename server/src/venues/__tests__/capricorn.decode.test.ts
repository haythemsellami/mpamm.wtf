import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import { admitCapricornPool, createCapricornAdapter, decodeCapricornSwap } from '../capricorn.js';

/**
 * Fixture-based decode tests — REAL `Swap` logs captured from Monad mainnet on
 * Capricorn's USDC/WMON PAMM pool (0x63093325…e4df), with the expected values
 * computed independently of the adapter (plain decimal math off the raw ints).
 * No network — fixtures only.
 *
 * The pool is token0 = USDC (6dp), token1 = WMON (18dp), so the BASE is token1
 * and the deltas are POOL-SIGNED: the leg the pool received is positive.
 *
 * Both fixtures were hand-verified against the pool's own reserve fields (the
 * event carries reserve0/reserve1 after the swap, so consecutive fills chain
 * exactly) and against the OracleRegistry price at the same block.
 */

/** The admitted USDC/WMON pool, exactly as discovery builds it on-chain. */
const POOL = {
  pool: '0x63093325c05cd32b18034d3ea29199fb7098e4df' as const,
  market: 'MON/USDC',
  baseIsToken0: false,
  baseToken: 'WMON',
  baseDec: 18,
  baseAddr: TOKENS.WMON.address,
  stableSym: 'USDC',
  stableDec: 6,
  stableAddr: TOKENS.USDC.address,
  feeBps: 50,
};

/**
 * https://monadscan.com/tx/0x98f5609adb8bc67ad138e5951f9a4e58c020b60fb8668f69fc991ac02b07100f
 * block 96,643,765 · log index 83 · 2026-08-17 01:22:59 UTC
 * Pool RECEIVED 163.862325 USDC and PAID OUT 8,121.006 WMON ⇒ the taker BOUGHT
 * MON at 0.0201776 USDC/MON.
 */
const BUY_LOG = {
  address: POOL.pool,
  args: {
    sender: '0xffaf66457deb4076ca5b4beafd4ef791663c2140',
    recipient: '0xffaf66457deb4076ca5b4beafd4ef791663c2140',
    amount0: 163_862_325n,
    amount1: -8_121_006_003_488_566_394_178n,
    reserve0: 1_232_092_307n,
    reserve1: 39_642_009_007_025_830_713_689n,
  },
  transactionHash: '0x98f5609adb8bc67ad138e5951f9a4e58c020b60fb8668f69fc991ac02b07100f',
  blockNumber: 96_643_765n,
  logIndex: 83,
};

/**
 * https://monadscan.com/tx/0x0aecc3fde34a0b1802608b3f1eb0717da4f12456206d0da26b21b437c64d257a
 * block 97,390,883 · log index 74 · 2026-08-19 16:40:56 UTC
 * Pool PAID OUT 329.321994 USDC and RECEIVED 14,718.074 WMON ⇒ the taker SOLD
 * MON at 0.0223753 USDC/MON. The OracleRegistry read 44.3959 WMON/USDC at that
 * block ($0.022525/MON), so the fill landed 66.4bps inside the oracle mid
 * against the pool's on-chain 50bps fee — the sign sanity-check for `side`.
 */
const SELL_LOG = {
  address: POOL.pool,
  args: {
    sender: '0xffaf66457deb4076ca5b4beafd4ef791663c2140',
    recipient: '0xffaf66457deb4076ca5b4beafd4ef791663c2140',
    amount0: -329_321_994n,
    amount1: 14_718_074_205_856_226_608_005n,
    reserve0: 715_967_554n,
    reserve1: 62_372_409_809_966_363_178_656n,
  },
  transactionHash: '0x0aecc3fde34a0b1802608b3f1eb0717da4f12456206d0da26b21b437c64d257a',
  blockNumber: 97_390_883n,
  logIndex: 74,
};

const TS = 1_787_157_656_000;

describe('decodeCapricornSwap — taker BUYS the base (real log)', () => {
  const fill = decodeCapricornSwap(BUY_LOG, POOL, TS)!;

  it('decodes the fill', () => {
    expect(fill).not.toBeNull();
  });

  it('usd = |USDC leg| / 10^6 (the stable leg is exact at $1)', () => {
    expect(fill.usd).toBeCloseTo(163.862325, 6);
  });

  it('baseAmount = |WMON leg| / 10^18 (18dp base, not the 6dp stable)', () => {
    expect(fill.baseAmount).toBeCloseTo(8121.006003488566, 9);
  });

  it('execPx = usd / baseAmount, realized stable-per-base', () => {
    expect(fill.execPx).toBeCloseTo(0.0201775894426884, 12);
  });

  it('pool RECEIVED the stable and paid out base ⇒ taker bought', () => {
    expect(fill.side).toBe('buy');
    expect(fill.market).toBe('MON/USDC');
  });

  it('deterministic id (txHash-logIndex) so re-tails dedupe', () => {
    expect(fill.id).toBe('capricorn-0x98f5609adb8bc67ad138e5951f9a4e58c020b60fb8668f69fc991ac02b07100f-83');
    expect(fill.venueId).toBe('capricorn');
    expect(fill.blockNumber).toBe(96_643_765);
    expect(fill.ts).toBe(TS);
  });

  it('attribution is left to the core — never guessed here', () => {
    expect(fill.category).toBe('UNKNOWN');
  });

  it('markouts start null — the core ages them vs the reference', () => {
    expect(fill.markoutsBps).toEqual([null, null, null, null, null]);
  });
});

describe('decodeCapricornSwap — taker SELLS the base (real log)', () => {
  const fill = decodeCapricornSwap(SELL_LOG, POOL, TS)!;

  it('usd / baseAmount / execPx come out of the opposite-signed legs', () => {
    expect(fill.usd).toBeCloseTo(329.321994, 6);
    expect(fill.baseAmount).toBeCloseTo(14718.074205856226, 9);
    expect(fill.execPx).toBeCloseTo(0.022375345401436073, 12);
  });

  it('pool GAINED base ⇒ taker sold', () => {
    expect(fill.side).toBe('sell');
  });

  it('the realized price sits inside the oracle mid by more than the fee', () => {
    // oracle mid at block 97,390,883 = 1 / 44.3959 WMON-per-USDC
    const mid = 1 / 44.3959;
    const bps = (fill.execPx / mid - 1) * 1e4;
    expect(bps).toBeLessThan(-POOL.feeBps); // taker sold below mid, fee-inclusive
    expect(bps).toBeGreaterThan(-200);      // and not absurdly far — a scaling bug
  });
});

describe('decodeCapricornSwap — refuses to invent fills', () => {
  it('an unknown pool decodes to null, never a bad fill', () => {
    expect(decodeCapricornSwap(BUY_LOG, undefined, TS)).toBeNull();
  });

  it('a zero leg decodes to null', () => {
    expect(decodeCapricornSwap({ ...BUY_LOG, args: { ...BUY_LOG.args, amount1: 0n } }, POOL, TS)).toBeNull();
  });

  it('same-signed legs are not a trade (donation/skim shape) ⇒ null', () => {
    const bad = { ...BUY_LOG, args: { ...BUY_LOG.args, amount1: 8_121_006_003_488_566_394_178n } };
    expect(decodeCapricornSwap(bad, POOL, TS)).toBeNull();
  });

  it('a log with no args decodes to null instead of throwing', () => {
    expect(decodeCapricornSwap({ ...BUY_LOG, args: undefined }, POOL, TS)).toBeNull();
  });
});

describe('admitCapricornPool — only registered base/stable pairs', () => {
  const POOL_ADDR = '0x63093325c05cd32b18034d3ea29199fb7098e4df' as const;

  it('admits the real USDC/WMON pool with the base on token1', () => {
    const r = admitCapricornPool(POOL_ADDR, [TOKENS.USDC.address, TOKENS.WMON.address], 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.market).toBe('MON/USDC');
    expect(r.value.baseIsToken0).toBe(false);
    expect(r.value.baseDec).toBe(18);
    expect(r.value.stableDec).toBe(6);
    expect(r.value.feeBps).toBe(50);
  });

  it('admits the AUSD/WMON pool (base on token1, AUSD is a registered stable)', () => {
    const r = admitCapricornPool('0x91c483fbe8feef4dad525781e6d65d2e668b3a47', [TOKENS.AUSD.address, TOKENS.WMON.address], 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.market).toBe('MON/AUSD');
    expect(r.value.stableSym).toBe('AUSD');
  });

  it('tracks which side the base is on when the order is flipped', () => {
    const r = admitCapricornPool(POOL_ADDR, [TOKENS.WMON.address, TOKENS.USDC.address], 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.baseIsToken0).toBe(true);
    expect(r.value.baseDec).toBe(18);
  });

  it('rejects a stable/stable pool — no base asset to benchmark', () => {
    const r = admitCapricornPool(POOL_ADDR, [TOKENS.USDC.address, TOKENS.AUSD.address], 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-base-stable');
  });

  it('rejects an unresolved read rather than guessing a layout', () => {
    expect(admitCapricornPool(POOL_ADDR, null, 50)).toMatchObject({ ok: false, reason: 'unresolved' });
    expect(admitCapricornPool(POOL_ADDR, [TOKENS.USDC.address, TOKENS.WMON.address], null)).toMatchObject({ ok: false, reason: 'unresolved' });
  });

  it('rejects a pool whose non-stable side is not a tracked asset', () => {
    const r = admitCapricornPool(POOL_ADDR, [TOKENS.USDC.address, '0x000000000000000000000000000000000000dead'], 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-base-stable');
  });
});

/**
 * The factory keys pools on (token0, token1, feeBps), so MORE THAN ONE fee tier
 * of the same pair is the designed shape — even though only two pools (on two
 * different markets) exist today. These lock the aggregation down before that
 * happens: a second pool on a market must not make the published row depend on
 * multicall ordering.
 */
const SEED_USDC = '0x63093325c05cd32b18034d3ea29199fb7098e4df';
const SEED_AUSD = '0x91c483fbe8feef4dad525781e6d65d2e668b3a47';
/** a second MON/USDC pool, as a later PoolCreated would deliver it. */
const NEW_USDC = '0x00000000000000000000000000000000000000aa';

/** per-pool quote answers, in raw output units, keyed by pool address. */
const QUOTES: Record<string, { buyOut: bigint; sellOut: bigint }> = {
  // mid is 0.02 stable/base, so 100 USDC buys 5000 base AT mid.
  [SEED_USDC]: { buyOut: 4_950n * 10n ** 18n, sellOut: 99_500_000n },   // ask 0.020202 (worse) · bid 0.0199 (better)
  [NEW_USDC]: { buyOut: 5_000n * 10n ** 18n, sellOut: 99_000_000n },    // ask 0.02     (better) · bid 0.0198 (worse)
  [SEED_AUSD]: { buyOut: 5_000n * 10n ** 18n, sellOut: 99_000_000n },
};
const FEES: Record<string, bigint> = { [SEED_USDC]: 50n, [NEW_USDC]: 30n, [SEED_AUSD]: 50n };
const TOKENS_OF: Record<string, readonly [string, string]> = {
  [SEED_USDC]: [TOKENS.USDC.address, TOKENS.WMON.address],
  [NEW_USDC]: [TOKENS.USDC.address, TOKENS.WMON.address],
  [SEED_AUSD]: [TOKENS.AUSD.address, TOKENS.WMON.address],
};

function quoteStubCtx(notes: { code: string; msg: string }[] = []) {
  const ok = (result: unknown) => ({ status: 'success' as const, result });
  return {
    client: {
      multicall: async ({ contracts }: any) => {
        // discovery phase 2 interleaves paused + a probe quote; phase 1 is
        // getTokens + feeBps; anything else is the real quote pass.
        const isLivenessPass = contracts.some((c: any) => c.functionName === 'paused');
        return contracts.map((c: any) => {
          const addr = String(c.address).toLowerCase();
          if (c.functionName === 'getTokens') return ok(TOKENS_OF[addr]);
          if (c.functionName === 'feeBps') return ok(FEES[addr]);
          if (c.functionName === 'paused') return ok(false);
          if (c.functionName === 'quoteExactIn') {
            const q = QUOTES[addr];
            if (!q) return { status: 'failure' as const, error: new Error('unknown pool') };
            if (isLivenessPass) return ok(q.buyOut); // probe only needs to be > 0
            const tokenIn = String(c.args[0]).toLowerCase();
            const buying = tokenIn !== TOKENS.WMON.address.toLowerCase();
            return ok(buying ? q.buyOut : q.sellOut);
          }
          return { status: 'failure' as const, error: new Error(`unexpected ${c.functionName}`) };
        });
      },
    },
    pricer: {
      pairMid: () => 0.02,
      tokenForUsd: (_t: string, usd: number) => usd / 0.02, // 100 USD → 5000 base
      usdPerToken: () => 0.02,
    },
    note: (code: string, msg: string) => { notes.push({ code, msg }); },
  } as any;
}

describe('Capricorn quote aggregation across pools on one market', () => {
  it('takes the BEST price per side, not whichever leg multicall returned last', async () => {
    const adapter = createCapricornAdapter();
    const ctx = quoteStubCtx();
    await adapter.discover(ctx);

    // a second MON/USDC pool arrives through the factory mid-run
    await adapter.decode(ctx, { poolCreated: [{ args: { pool: NEW_USDC } }], swap: [] }, () => 0, new Set());

    const rows = await adapter.quote!(ctx, [100]);
    const row = rows.find((r) => r.market === 'MON/USDC')!;
    expect(row).toBeDefined();
    // cheapest ask wins (the NEW pool), richest bid wins (the SEED pool)
    expect(row.askPx).toBeCloseTo(0.02, 9);
    expect(row.bidPx).toBeCloseTo(0.0199, 9);
    expect(row.askBps).toBeCloseTo(0, 6);
    expect(row.bidBps).toBeCloseTo(-50, 6);
    expect(row.spreadBps).toBeCloseTo(50, 6);
    // a row assembled from two pools carries the WORSE fee of the two
    expect(row.feeBps).toBe(50);
    expect(row.oneSided).toBeUndefined();
  });

  it('is order-independent — the same rows whichever pool is seen first', async () => {
    const a = createCapricornAdapter();
    const ctxA = quoteStubCtx();
    await a.discover(ctxA);
    await a.decode(ctxA, { poolCreated: [{ args: { pool: NEW_USDC } }], swap: [] }, () => 0, new Set());
    const first = (await a.quote!(ctxA, [100])).find((r) => r.market === 'MON/USDC')!;

    // same pools, reversed discovery order (the new pool admitted before the seed's refresh)
    const b = createCapricornAdapter();
    const ctxB = quoteStubCtx();
    await b.decode(ctxB, { poolCreated: [{ args: { pool: NEW_USDC } }], swap: [] }, () => 0, new Set());
    await b.discover(ctxB);
    const second = (await b.quote!(ctxB, [100])).find((r) => r.market === 'MON/USDC')!;

    expect(second.askPx).toBeCloseTo(first.askPx, 12);
    expect(second.bidPx).toBeCloseTo(first.bidPx, 12);
    expect(second.feeBps).toBe(first.feeBps);
  });
});
