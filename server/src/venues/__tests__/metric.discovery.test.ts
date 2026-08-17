// Metric is permissionless infra: anyone can deploy a pool on it and plug in
// their own pricing. These cover the three things that has to get right —
// admitting only benchmarkable pools, quoting only funded ones, and counting
// EVERY push oracle for burn (the old single-oracle rule would have silently
// stalled gas tracking the day a second curator went live).
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import {
  admitMetricPool,
  createMetricAdapter,
  isMetricPoolLive,
  metricPoolLiveness,
} from '../metric.js';

const A = (s: string) => s as `0x${string}`;
const POOL = A('0x00000000000000000000000000000000000000p1'.replace('p1', 'a1'));
const PROVIDER = A('0x00000000000000000000000000000000000000b1');
/** getImmutables tuple: [factory, priceProvider, token0, token1, …] */
const imm = (t0: string, t1: string, provider = PROVIDER) => [A('0x' + '0'.repeat(40)), provider, t0, t1, 0n, 0n, 0n, false, 0n, 0n, 0, 0, 0n, 0n] as const;

describe('admitMetricPool (structural admission)', () => {
  it('admits a base/stable pool on a registered pair', () => {
    const r = admitMetricPool(POOL, imm(TOKENS.WMON.address, TOKENS.USDC.address));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.market).toBe('MON/USDC');
      expect(r.value.baseIsToken0).toBe(true);
      expect(r.value.priceProvider).toBe(PROVIDER);
      expect(r.value.stableSym).toBe('USDC');
    }
  });

  it('handles either token ordering', () => {
    const r = admitMetricPool(POOL, imm(TOKENS.USDC.address, TOKENS.WETH.address));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.market).toBe('ETH/USDC'); expect(r.value.baseIsToken0).toBe(false); }
  });

  it('rejects an unresolved pool (getImmutables reverted)', () => {
    const r = admitMetricPool(POOL, null);
    expect(r).toMatchObject({ ok: false, reason: 'unresolved' });
  });

  it('rejects stable/stable and base/base pools', () => {
    expect(admitMetricPool(POOL, imm(TOKENS.USDC.address, TOKENS.USDT0.address))).toMatchObject({ reason: 'not-base-stable' });
    expect(admitMetricPool(POOL, imm(TOKENS.WMON.address, TOKENS.WETH.address))).toMatchObject({ reason: 'not-base-stable' });
  });

  it('rejects a pool whose tokens we do not track at all — the permissionless junk case', () => {
    const rando = '0x1111111111111111111111111111111111111111';
    expect(admitMetricPool(POOL, imm(rando, TOKENS.USDC.address))).toMatchObject({ ok: false, reason: 'not-base-stable' });
    expect(admitMetricPool(POOL, imm(rando, '0x2222222222222222222222222222222222222222'))).toMatchObject({ ok: false });
  });

  it('is case-insensitive about token addresses (events and calls disagree on casing)', () => {
    const r = admitMetricPool(POOL, imm(TOKENS.WMON.address.toUpperCase().replace('0X', '0x'), TOKENS.USDC.address));
    expect(r.ok).toBe(true);
  });
});

describe('isMetricPoolLive (liveness gate)', () => {
  it('passes a funded pool quoting both sides', () => {
    expect(isMetricPoolLive(1n, 1n, 100n, 101n)).toBe(true);
  });

  it('rejects the empty shells — 4 of the 7 pools on chain today hold nothing', () => {
    expect(isMetricPoolLive(0n, 0n, 100n, 101n)).toBe(false);
  });

  it('rejects one-sided inventory (cannot quote both directions)', () => {
    expect(isMetricPoolLive(1n, 0n, 100n, 101n)).toBe(false);
    expect(isMetricPoolLive(0n, 1n, 100n, 101n)).toBe(false);
  });

  it('rejects a funded pool whose provider has no price', () => {
    expect(isMetricPoolLive(1n, 1n, 0n, 0n)).toBe(false);
    expect(isMetricPoolLive(1n, 1n, 100n, 0n)).toBe(false);
  });

  it('rejects when any probe failed — never guess liveness', () => {
    expect(isMetricPoolLive(null, 1n, 100n, 101n)).toBe(false);
    expect(isMetricPoolLive(1n, 1n, null, 101n)).toBe(false);
  });
});

// ── adapter-level: discovery + gas, against a stubbed chain ──────────────────
const SEEDS = [
  '0xFA32f9ec28787d1F9C5BA5c39e54e59984FEF3f0',
  '0x2D82AC42334b394A9a8d8f097d61DC1c6B065Fd8',
  '0x354D92279cA0190fF275095fE6A2a6989BAa66Fb',
].map((s) => s.toLowerCase());
const ORACLE_A = '0x681e908b8ab57c49c74d770f369754ccc3e1ae09';
const ORACLE_B = '0xaaaa0000000000000000000000000000000000bb';

interface StubOpts {
  head?: bigint;
  createdPools?: { pool: string }[];
  oracleOf?: (provider: string) => string | null;   // null ⇒ that provider read fails
  balances?: (pool: string) => [bigint, bigint];
  oracleCount?: (oracle: string) => number;
  logsThrow?: boolean;
  /** oracle probe reverts — pools stay ADMITTED but drop out of `live`. */
  priceFails?: boolean;
}
const stub = (notes: string[], o: StubOpts = {}) => {
  const tokenOf: Record<string, [string, string]> = {
    [SEEDS[0]]: [TOKENS.WMON.address, TOKENS.USDC.address],
    [SEEDS[1]]: [TOKENS.WBTC.address, TOKENS.USDC.address],
    [SEEDS[2]]: [TOKENS.WETH.address, TOKENS.USDC.address],
  };
  const providerFor = (pool: string) => '0xprov' + pool.slice(6);
  return {
    client: {
      getBlockNumber: async () => o.head ?? 1_000_000n,
      multicall: async ({ contracts }: any) => contracts.map((c: any) => {
        if (c.functionName === 'getImmutables') {
          const p = String(c.address).toLowerCase();
          const t = tokenOf[p] ?? [TOKENS.WMON.address, TOKENS.USDC.address];
          return { status: 'success', result: [A('0x' + '0'.repeat(40)), providerFor(p), t[0], t[1], 0n, 0n, 0n, false, 0n, 0n, 0, 0, 0n, 0n] };
        }
        if (c.functionName === 'balanceOf') {
          const pool = String(c.args[0]).toLowerCase();
          const [b0, b1] = o.balances ? o.balances(pool) : [1_000n, 1_000n];
          // two balanceOf calls per pool, in order base then stable
          return { status: 'success', result: c.__side === 1 ? b1 : b0 };
        }
        if (c.functionName === 'getBidAndAskPrice') return o.priceFails ? { status: 'failure' } : { status: 'success', result: [100n, 101n] };
        if (c.functionName === 'offchainOracle') {
          const or = o.oracleOf ? o.oracleOf(String(c.address)) : ORACLE_A;
          return or === null ? { status: 'failure' } : { status: 'success', result: or };
        }
        if (c.functionName === 'offchainFeedId') return { status: 'success', result: '0xfeed' + String(c.address).slice(-8) };
        return { status: 'failure' };
      }),
      readContract: async ({ functionName, address }: any) => {
        if (functionName === 'getOracleCount') return BigInt(o.oracleCount ? o.oracleCount(String(address).toLowerCase()) : 3);
        throw new Error('unexpected readContract ' + functionName);
      },
    },
    getLogs: async () => {
      if (o.logsThrow) throw new Error('rpc down');
      return (o.createdPools ?? []).map((c) => ({ args: { pool: c.pool } }));
    },
    pricer: { pairMid: () => 1, usdPerToken: () => 1, usdForToken: () => 1, tokenForUsd: () => 1, assetUsd: () => 1 },
    note: (_code: string, m: string) => notes.push(m),
  } as any;
};

describe('Metric permissionless discovery', () => {
  it('tails the factory even before any pool is live, so a new deployment can reach us', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    await a.discover(stub(notes, { balances: () => [0n, 0n] }));   // every pool unfunded
    const keys = a.logSources().map((s) => s.key);
    expect(keys).toContain('poolCreated');
    const factory = a.logSources().find((s) => s.key === 'poolCreated')!;
    expect(factory.kind).toBe('state');   // a missed PoolCreated breaks later decodes
  });

  it('admits a factory-announced pool and quotes it once funded', async () => {
    const notes: string[] = [];
    const NEW = '0xcccc000000000000000000000000000000000001';
    const a = createMetricAdapter();
    // pass 1 anchors the scan cursor at head (no history backscan); pass 2 sees
    // the new PoolCreated in the forward range.
    await a.discover(stub(notes, {}));
    await a.discover(stub(notes, { head: 1_000_500n, createdPools: [{ pool: NEW }] }));
    const swap = a.logSources().find((s) => s.key === 'swap')!;
    expect(swap.address).toContain(NEW);              // tailed for fills
    expect(notes.some((n) => /announced 1 new pool/.test(n))).toBe(true);
  });

  it('does NOT quote an unfunded shell, but DOES tail it', async () => {
    // Tailing is keyed on admission, quoting on liveness (issue #61). An
    // unfunded pool cannot trade today, but it can be funded and traded well
    // before the next 10-minute rediscovery — and tailing it costs one more
    // address in a single getLogs filter.
    const notes: string[] = [];
    const NEW = '0xcccc000000000000000000000000000000000002';
    const a = createMetricAdapter();
    const balances = (p: string) => (p === NEW ? [0n, 0n] as [bigint, bigint] : [1_000n, 1_000n] as [bigint, bigint]);
    await a.discover(stub(notes, { balances }));
    const ctx = stub(notes, { head: 1_000_500n, createdPools: [{ pool: NEW }], balances });
    await a.discover(ctx);
    const swap = a.logSources().find((s) => s.key === 'swap')!;
    expect(swap.address).toContain(NEW);                       // tailed
    // …but excluded from the live set, so it is never quoted: 3 seeds live, 1 shell.
    expect(notes.some((n) => /Metric: 3 live base\/stable pool\(s\) \(\+1 unfunded; not quoted\)/.test(n))).toBe(true);
  });

  it('survives a factory scan failure — seeds still resolve', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    await a.discover(stub(notes, { logsThrow: true }));
    const swap = a.logSources().find((s) => s.key === 'swap')!;
    expect((swap.address as string[]).length).toBe(SEEDS.length);
  });
});

describe('Metric gas attribution (multi-oracle)', () => {
  it('single shared oracle — one destination', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([]));
    expect(a.gasSources!()).toEqual([{ mode: 'blocks', address: [ORACLE_A] }]);
  });

  it('MULTIPLE oracles are all counted — the curator case that used to stall burn', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    let n = 0;
    await a.discover(stub(notes, { oracleOf: () => (n++ % 2 === 0 ? ORACLE_A : ORACLE_B) }));
    const src = a.gasSources!()[0] as any;
    expect(src.mode).toBe('blocks');
    expect([...src.address].sort()).toEqual([ORACLE_A, ORACLE_B].sort());
  });

  it('destination list is sorted + deduped, so the tracker fingerprint is stable', async () => {
    const a1 = createMetricAdapter(); await a1.discover(stub([], { oracleOf: () => ORACLE_B }));
    const a2 = createMetricAdapter(); await a2.discover(stub([], { oracleOf: () => ORACLE_B }));
    expect((a1.gasSources!()[0] as any).address).toEqual((a2.gasSources!()[0] as any).address);
    expect((a1.gasSources!()[0] as any).address).toEqual([ORACLE_B]);   // deduped across 3 pools
  });

  it('ONE unreadable provider no longer blanks every oracle (the old failure)', async () => {
    const a = createMetricAdapter();
    let i = 0;
    await a.discover(stub([], { oracleOf: () => (i++ === 0 ? null : ORACLE_A) }));
    expect((a.gasSources!()[0] as any).address).toEqual([ORACLE_A]);
  });

  it('throws only when NO oracle resolves — fail closed holds the gas cursor', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([], { oracleOf: () => null }));
    expect(() => a.gasSources!()).toThrow(/not resolved/);
  });

  it('notes multi-tenancy when an oracle serves more feeds than Metric uses', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    await a.discover(stub(notes, { oracleCount: () => 12 }));
    expect(notes.some((n) => /serves 12 feed\(s\) but Metric uses/.test(n))).toBe(true);
    expect(a.gasSources!()).toHaveLength(1);   // still tracked, just flagged
  });

  it('stays silent when the oracle serves exactly Metric feeds', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    await a.discover(stub(notes, { oracleCount: () => 3 }));
    expect(notes.some((n) => /overcount/.test(n))).toBe(false);
  });
});

describe('an unquotable pool still trades (issue #61)', () => {
  // Metric's router takes bid/ask as CALL PARAMETERS, so a dead PriceProvider
  // stops us quoting but not an aggregator swapping. On 2026-08-14 the oracle
  // began reverting at 05:43 UTC and the pools executed 141 more swaps over the
  // next 6.7h — every one invisible to us, because the fills source had gone.
  it('keeps tailing admitted pools when the oracle probe reverts', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    await a.discover(stub(notes, { priceFails: true }));

    expect(notes.some((n) => /0 live/.test(n))).toBe(true);      // nothing quotable…
    const swap = a.logSources().find((s) => s.key === 'swap');
    expect(swap).toBeDefined();                                   // …but still tailed
    expect(swap!.kind).toBe('fills');
    expect((swap!.address as string[]).length).toBe(SEEDS.length);
  });

  it('quotes nothing while unquotable — liveness still gates the quote path', async () => {
    const a = createMetricAdapter();
    const ctx = stub([], { priceFails: true });
    await a.discover(ctx);
    expect(await a.quote!(ctx, [100])).toEqual([]);
  });

  it('DECODES a swap from a pool that never passed liveness', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    const ctx = stub(notes, { priceFails: true });
    await a.discover(ctx);

    // WMON/USDC seed: base=token0, 1 WMON out against 2 USDC in.
    const log = {
      address: SEEDS[0],
      args: { amount0Delta: -1_000_000_000_000_000_000n, amount1Delta: 2_000_000n, recipient: '0x' + '1'.repeat(40) },
      transactionHash: '0x' + 'a'.repeat(64),
      blockNumber: 1n,
      logIndex: 0,
    };
    const fills = await a.decode(ctx, { swap: [log] } as any, () => 1_760_000_000_000, new Set());
    expect(fills).toHaveLength(1);
    expect(fills[0].venueId).toBe('metric');
    expect(fills[0].usd).toBeCloseTo(2, 9);
    expect(fills[0].baseAmount).toBeCloseTo(1, 9);
  });
});

describe('liveness carries a REASON, not just a verdict (issue #58)', () => {
  it('separates the three causes a bare boolean used to flatten', () => {
    expect(metricPoolLiveness(1n, 1n, 100n, 101n)).toBe('live');
    expect(metricPoolLiveness(0n, 1n, 100n, 101n)).toBe('unfunded');    // curator's empty shell
    expect(metricPoolLiveness(1n, 1n, 0n, 101n)).toBe('no-price');      // FUNDED, oracle silent
    expect(metricPoolLiveness(1n, 1n, null, 101n)).toBe('no-price');    // provider REVERTED
  });

  it('treats a missing price as a revert, because the reads share one allowFailure multicall', () => {
    // a transport failure kills the whole multicall before liveness runs, so a
    // per-entry failure means the contract refused — which is the venue's state,
    // not ours. Exactly Metric since 2026-08-14.
    expect(metricPoolLiveness(1n, 1n, null, null)).toBe('no-price');
    // an unreadable BALANCE is different: funding is then simply unknown.
    expect(metricPoolLiveness(null, 0n, 0n, 0n)).toBe('unreadable');
  });

  it('names the real cause in the discovery note instead of calling it unfunded', async () => {
    const notes: string[] = [];
    // funded on both sides, but the oracle probe fails — exactly Metric since 2026-08-14
    await createMetricAdapter().discover(stub(notes, { priceFails: true }));
    expect(notes.some((n) => /funded but no oracle price/.test(n))).toBe(true);
    expect(notes.some((n) => /unfunded/.test(n))).toBe(false);
  });

  it('raises funded-but-unpriceable as a WARN, with the fact that it can still trade', async () => {
    const seen: { code: string; msg: string }[] = [];
    const ctx = stub([], { priceFails: true });
    ctx.note = (code: string, msg: string) => seen.push({ code, msg });
    await createMetricAdapter().discover(ctx);
    const warn = seen.find((n) => n.code === 'venue.quote.unavailable');
    expect(warn).toBeDefined();
    expect(warn!.msg).toMatch(/PriceProvider is not answering/);
    expect(warn!.msg).toMatch(/can still trade/);
  });

  it('stays quiet when the pools are merely empty — a shell is not a degradation', async () => {
    const seen: { code: string; msg: string }[] = [];
    const ctx = stub([], { balances: () => [0n, 0n] });
    ctx.note = (code: string, msg: string) => seen.push({ code, msg });
    await createMetricAdapter().discover(ctx);
    expect(seen.some((n) => n.code === 'venue.quote.unavailable')).toBe(false);
    expect(seen.some((n) => /unfunded/.test(n.msg))).toBe(true);
  });
});
