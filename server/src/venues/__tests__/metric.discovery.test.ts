// Metric is permissionless infra: anyone can deploy a pool on it and plug in
// their own pricing. These cover what that has to get right — admitting only
// benchmarkable pools, quoting only funded ones, counting every oracle the
// providers read for burn — plus the generation split: v1 (live) discovers,
// quotes and tails; v0 (retired) costs nothing live and stays decodable.
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import { createMetricAdapter } from '../metric.js';
import { admitMetricPool, isMetricPoolLive, metricPoolLiveness } from '../metric-shared.js';
import { V0_LAST_SWAP_BLOCK, V0_POOLS, V0_PUSH_ORACLE } from '../metric-v0.js';
import { V1_FACTORY, V1_FACTORY_BLOCK, V1_SIMPLE_ROUTER } from '../metric-v1.js';
import { sourceSpan } from '../adapter.js';
import { classifyGasSourceChange, gasSourcesSignature } from '../../gas.js';

const A = (s: string) => s as `0x${string}`;
const POOL = A('0x00000000000000000000000000000000000000a1');
const PROVIDER = '0x00000000000000000000000000000000000000b1';
const im = (token0: string, token1: string, priceProvider = PROVIDER) => ({ token0, token1, priceProvider });

describe('admitMetricPool (structural admission)', () => {
  it('admits a base/stable pool on a registered pair', () => {
    const r = admitMetricPool(POOL, im(TOKENS.WMON.address, TOKENS.USDC.address));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.market).toBe('MON/USDC');
      expect(r.value.baseIsToken0).toBe(true);
      expect(r.value.priceProvider).toBe(PROVIDER);
      expect(r.value.stableSym).toBe('USDC');
    }
  });

  it('handles either token ordering', () => {
    const r = admitMetricPool(POOL, im(TOKENS.USDC.address, TOKENS.WETH.address));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.market).toBe('ETH/USDC'); expect(r.value.baseIsToken0).toBe(false); }
  });

  it('rejects an unresolved pool (getImmutables reverted)', () => {
    expect(admitMetricPool(POOL, null)).toMatchObject({ ok: false, reason: 'unresolved' });
  });

  it('rejects stable/stable and base/base pools — the live AUSD/USDC v1 pool is the former', () => {
    expect(admitMetricPool(POOL, im(TOKENS.AUSD.address, TOKENS.USDC.address))).toMatchObject({ reason: 'not-base-stable' });
    expect(admitMetricPool(POOL, im(TOKENS.WMON.address, TOKENS.WETH.address))).toMatchObject({ reason: 'not-base-stable' });
  });

  it('rejects a pool whose tokens we do not track at all — the permissionless junk case', () => {
    const rando = '0x1111111111111111111111111111111111111111';
    expect(admitMetricPool(POOL, im(rando, TOKENS.USDC.address))).toMatchObject({ ok: false, reason: 'not-base-stable' });
    expect(admitMetricPool(POOL, im(rando, '0x2222222222222222222222222222222222222222'))).toMatchObject({ ok: false });
  });

  it('is case-insensitive about token addresses (events and calls disagree on casing)', () => {
    expect(admitMetricPool(POOL, im(TOKENS.WMON.address.toUpperCase().replace('0X', '0x'), TOKENS.USDC.address)).ok).toBe(true);
  });
});

describe('isMetricPoolLive (liveness gate)', () => {
  it('passes a funded pool quoting both sides', () => {
    expect(isMetricPoolLive(1n, 1n, 100n, 101n)).toBe(true);
  });

  it('rejects empty shells and one-sided inventory', () => {
    expect(isMetricPoolLive(0n, 0n, 100n, 101n)).toBe(false);
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

  it('separates the three causes a bare boolean used to flatten (issue #58)', () => {
    expect(metricPoolLiveness(0n, 0n, 100n, 101n)).toBe('unfunded');
    expect(metricPoolLiveness(1n, 1n, null, null)).toBe('no-price');
    expect(metricPoolLiveness(null, 1n, 100n, 101n)).toBe('unreadable');
  });
});

// ── v1 generation, against a stubbed chain ───────────────────────────────────
const P = {
  wmon: '0xe6831acf980c2dfc5ae993f06b198d872fddf515',   // #6, funded
  weth: '0x22fcd163a8a317047ae64194baaa4c3857251e5f',   // #7, empty shell
  ausd: '0x94d5e3543a39c0ec1171f14a45100bd62bee49bc',   // #9, stable/stable
};
const ORACLE = '0x30a88bf894d1b806125a23ebf23d715496fd7102';
const ORACLE_B = '0xaaaa0000000000000000000000000000000000bb';

interface StubOpts {
  /** factory pool list, in index order (index 1 = first). */
  pools?: string[];
  tokens?: Record<string, [string, string]>;
  balances?: (pool: string) => [bigint, bigint];
  /** the pool's own price read reverts (oracle refused). */
  priceFails?: boolean;
  /** getImmutables reverts for these pools. */
  unresolved?: (pool: string) => boolean;
  /** the DataProvider's current-provider read fails for these pools. */
  providerFails?: (pool: string) => boolean;
  /** the pool's CURRENT provider differs from the one it was created with. */
  currentProvider?: (pool: string) => string;
  oracleOf?: (provider: string) => string | null;
  /** quoter: [amountIn used, amountOut] per call (default: full fill at 1:1). */
  quote?: (args: readonly unknown[]) => { status: 'success'; result: [bigint, bigint] } | { status: 'failure'; error?: Error };
}
const stub = (notes: string[], o: StubOpts = {}) => {
  const list = o.pools ?? [P.wmon, P.weth, P.ausd];
  const tokenOf: Record<string, [string, string]> = {
    [P.wmon]: [TOKENS.WMON.address, TOKENS.USDC.address],
    [P.weth]: [TOKENS.WETH.address, TOKENS.USDC.address],
    [P.ausd]: [TOKENS.AUSD.address, TOKENS.USDC.address],
    ...o.tokens,
  };
  const calls: any[] = [];
  return {
    calls,
    client: {
      readContract: async ({ functionName }: any) => {
        if (functionName === 'nextPoolIdx') return BigInt(list.length + 1);
        throw new Error('unexpected readContract ' + functionName);
      },
      multicall: async ({ contracts, allowFailure }: any) => {
        calls.push(...contracts);
        const out = contracts.map((c: any) => {
          const addr = String(c.address).toLowerCase();
          switch (c.functionName) {
            case 'idxToPool': return { status: 'success', result: list[Number(c.args[0]) - 1] ?? '0x0000000000000000000000000000000000000000' };
            case 'getImmutables': {
              if (o.unresolved?.(addr)) return { status: 'failure' };
              const t = tokenOf[addr] ?? [TOKENS.WMON.address, TOKENS.USDC.address];
              return { status: 'success', result: { factory: V1_FACTORY, token0: t[0], token1: t[1], immutablePriceProvider: '0xprov' + addr.slice(6) } };
            }
            case 'priceProvider': {
              const pool = String(c.args[0]).toLowerCase();
              if (o.providerFails?.(pool)) return { status: 'failure' };
              return { status: 'success', result: o.currentProvider?.(pool) ?? '0xprov' + pool.slice(6) };
            }
            case 'balanceOf': {
              const pool = String(c.args[0]).toLowerCase();
              const [b0] = o.balances ? o.balances(pool) : [1_000n, 1_000n];
              return { status: 'success', result: b0 };
            }
            case 'getSellAndBuyPrices': return o.priceFails ? { status: 'failure' } : { status: 'success', result: [100n, 101n] };
            case 'offchainOracle': {
              const or = o.oracleOf ? o.oracleOf(addr) : ORACLE;
              return or === null ? { status: 'failure' } : { status: 'success', result: or };
            }
            case 'quoteLiveExactInSingle': return o.quote ? o.quote(c.args) : { status: 'success', result: [c.args[3], c.args[3]] };
            default: return { status: 'failure' };
          }
        });
        return allowFailure === false ? out.map((r: any) => r.result) : out;
      },
    },
    pricer: { pairMid: () => 1, usdPerToken: () => 1, usdForToken: () => 1, tokenForUsd: () => 1, assetUsd: () => 1 },
    note: (_code: string, m: string) => notes.push(m),
  } as any;
};
const swapSource = (a: ReturnType<typeof createMetricAdapter>) => a.logSources().find((s) => s.key.startsWith('v1:swap'))!;

describe('Metric v1 discovery (factory enumeration)', () => {
  it('admits every registered base/stable pool the factory lists — funded or not — and drops stable/stable', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([], { balances: (p) => (p === P.wmon ? [1_000n, 1_000n] : [0n, 0n]) }));
    expect((swapSource(a).address as string[]).map((x) => x.toLowerCase()).sort()).toEqual([P.weth, P.wmon].sort());
    expect([...a.quoteMarkets!()].sort()).toEqual(['ETH/USDC', 'MON/USDC']);
  });

  it('holds (throws) until the first discovery succeeds — logSources is the fail-closed gate', async () => {
    const a = createMetricAdapter();
    expect(() => a.logSources()).toThrow(/discovery unavailable/);
    await expect(a.discover(stub([], { unresolved: (p) => p === P.wmon }))).rejects.toThrow(/getImmutables failed/);
    expect(() => a.logSources()).toThrow(/discovery unavailable/);
  });

  it('never silently drops a factory pool whose immutables did not answer — and keeps the last good state', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([], { pools: [P.wmon] }));
    // pool #2 appears but its read fails: the pass throws, the WMON pool stays tailed
    await expect(a.discover(stub([], { pools: [P.wmon, P.weth], unresolved: (p) => p === P.weth }))).rejects.toThrow();
    expect((swapSource(a).address as string[]).map((x) => x.toLowerCase())).toEqual([P.wmon]);
    // healed on the next pass
    await a.discover(stub([], { pools: [P.wmon, P.weth] }));
    expect((swapSource(a).address as string[]).map((x) => x.toLowerCase()).sort()).toEqual([P.weth, P.wmon].sort());
  });

  it('fails the pass (keeps the last good state) when the current-provider read fails — never falls back to the creation-time provider', async () => {
    const a = createMetricAdapter();
    const ROTATED = '0x' + 'c'.repeat(40);
    await a.discover(stub([], { currentProvider: () => ROTATED, oracleOf: (prov) => (prov === ROTATED ? ORACLE : ORACLE_B) }));
    await expect(a.discover(stub([], { providerFails: (p) => p === P.wmon, oracleOf: (prov) => (prov === ROTATED ? ORACLE : ORACLE_B) }))).rejects.toThrow(/priceProvider read failed/);
    // the obsolete provider's oracle never entered the gas destinations
    expect(a.gasSources!().flatMap((s) => s.address as string[])).not.toContain(ORACLE_B);
    expect((swapSource(a).address as string[]).map((x) => x.toLowerCase())).toContain(P.wmon);
  });

  it('only reads factory indices it has not read before', async () => {
    const a = createMetricAdapter();
    const first = stub([], { pools: [P.wmon] });
    await a.discover(first);
    const second = stub([], { pools: [P.wmon, P.weth] });
    await a.discover(second);
    const idx = second.calls.filter((c: any) => c.functionName === 'idxToPool').map((c: any) => c.args[0]);
    expect(idx).toEqual([2n]);
    // immutables are cached: only the new pool is resolved
    expect(second.calls.filter((c: any) => c.functionName === 'getImmutables').map((c: any) => String(c.address).toLowerCase())).toEqual([P.weth]);
  });

  it('tails the factory even with no admitted pool, so a new deployment can reach us', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([], { pools: [P.ausd] }));
    const keys = a.logSources().map((s) => s.key);
    expect(keys).toContain('v1:poolCreated');
    expect(keys.some((k) => k.startsWith('v1:swap'))).toBe(false);
    const factory = a.logSources().find((s) => s.key === 'v1:poolCreated')!;
    expect(factory.kind).toBe('state');
  });

  it('bounds every v1 source at the factory creation block — the lifetime replay skips them before it', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([]));
    for (const s of a.logSources().filter((x) => x.key.startsWith('v1:'))) expect(s.fromBlock).toBe(V1_FACTORY_BLOCK);
  });

  it('keeps tailing a funded pool whose oracle stopped answering, but does not quote it (issue #61)', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    const ctx = stub(notes, { priceFails: true });
    await a.discover(ctx);
    expect((swapSource(a).address as string[]).map((x) => x.toLowerCase())).toContain(P.wmon);
    expect(await a.quote!(ctx, [100], 1n)).toEqual([]);
    expect(notes.some((n) => /funded pool\(s\) have no oracle price/.test(n))).toBe(true);
  });

  it('announces recovery once the price is back', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    await a.discover(stub(notes, { priceFails: true }));
    await a.discover(stub(notes));
    expect(notes.some((n) => /Metric quoting again/.test(n))).toBe(true);
  });

  it('raises the SAME outage again after a recovery, repeatable, and stays quiet while it persists', async () => {
    const seen: { code: string; msg: string; repeatable?: boolean }[] = [];
    const a = createMetricAdapter();
    const ctx = (o: StubOpts) => ({ ...stub([], o), note: (code: string, msg: string, opts?: { repeatable?: boolean }) => seen.push({ code, msg, repeatable: opts?.repeatable }) });
    await a.discover(ctx({ priceFails: true }));
    await a.discover(ctx({ priceFails: true }));    // still down: latched, no second warning
    await a.discover(ctx({}));                      // healed
    await a.discover(ctx({ priceFails: true }));    // the same outage returns
    const transitions = seen.filter((n) => n.code === 'venue.quote.unavailable' || n.code === 'venue.quote.recovered');
    expect(transitions.map((n) => n.code)).toEqual(['venue.quote.unavailable', 'venue.quote.recovered', 'venue.quote.unavailable']);
    expect(transitions.every((n) => n.repeatable)).toBe(true);
    expect(transitions[0].msg).toBe(transitions[2].msg);   // verbatim repeat — only `repeatable` gets it past the core's dedupe
  });

  it('declares its pools DIRECT and its SimpleRouter as Metric periphery', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([]));
    const eps = a.entryPoints!();
    expect(eps).toContainEqual({ address: V1_SIMPLE_ROUTER, router: 'Metric' });
    expect(eps.map((e) => e.address.toLowerCase())).toContain(P.wmon);
  });
});

describe('Metric v1 quotes', () => {
  it('quotes both sides of every live pool at the pinned block, sized in pair terms', async () => {
    const a = createMetricAdapter();
    // buy: 100 USDC in → 98 WMON out (ask 1/0.98); sell: 100 WMON in → 99 USDC out (bid 0.99)
    const q = stub([], {
      balances: (p) => (p === P.wmon ? [1_000n, 1_000n] : [0n, 0n]),
      quote: (args) => {
        const zeroForOne = args[2] as boolean;
        const amountIn = args[3] as bigint;
        // WMON is token0: zeroForOne = selling WMON
        if (zeroForOne) return { status: 'success', result: [amountIn, (amountIn * 99n) / 100n / 10n ** 12n] };
        return { status: 'success', result: [amountIn, (amountIn * 98n / 100n) * 10n ** 12n] };
      },
    });
    await a.discover(q);
    const blocks: unknown[] = [];
    const inner = q.client.multicall;
    q.client.multicall = async (args: any) => { blocks.push(args.blockNumber); return inner(args); };
    const rows = await a.quote!(q, [100], 777n);
    expect(blocks).toEqual([777n]);   // one multicall, at the frame's block
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ venueId: 'metric', market: 'MON/USDC', sizeUsd: 100, filledFull: true });
    expect(rows[0].askPx).toBeCloseTo(1 / 0.98, 9);
    expect(rows[0].bidPx).toBeCloseTo(0.99, 9);
    const legs = q.calls.filter((c: any) => c.functionName === 'quoteLiveExactInSingle');
    // buy leg: USDC (token1) in → zeroForOne=false, no upper bound; sell leg: WMON in → zeroForOne=true, floor 0
    expect(legs.map((c: any) => [c.args[2], c.args[4]])).toEqual([[false, (1n << 128n) - 1n], [true, 0n]]);
  });

  it('marks a size the pool cannot absorb as not filled full', async () => {
    const a = createMetricAdapter();
    const q = stub([], {
      balances: (p) => (p === P.wmon ? [1_000n, 1_000n] : [0n, 0n]),
      quote: (args) => ({ status: 'success', result: [(args[3] as bigint) / 2n, (args[3] as bigint) / 2n] }),
    });
    await a.discover(q);
    const [row] = await a.quote!(q, [100], 1n);
    expect(row.filledFull).toBe(false);
  });

  it('reports a venue-wide outage when every leg reverts, instead of going dark silently', async () => {
    const notes: string[] = [];
    const a = createMetricAdapter();
    const q = stub(notes, { balances: (p) => (p === P.wmon ? [1_000n, 1_000n] : [0n, 0n]), quote: () => ({ status: 'failure', error: new Error('oracle: not attributed') }) });
    await a.discover(q);
    expect(await a.quote!(q, [100], 1n)).toEqual([]);
    expect(notes.some((n) => /Metric/.test(n) && /fail/i.test(n))).toBe(true);
  });
});

describe('Metric gas attribution (both generations, one block walk)', () => {
  it('declares the retired v0 oracle AND the v1 oracle — dropping v0 would rebuild the lifetime series', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([]));
    const srcs = a.gasSources!();
    expect(srcs.every((s) => s.mode === 'blocks')).toBe(true);
    expect(srcs.flatMap((s) => s.address as string[]).sort()).toEqual([ORACLE, V0_PUSH_ORACLE].sort());
  });

  it('the deployed fingerprint (v0 oracle only) upgrades as a pure ADDITION — a partial rebuild, not a lifetime one', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([]));
    const change = classifyGasSourceChange(V0_PUSH_ORACLE, gasSourcesSignature(a.gasSources!()));
    expect(change).toEqual({ kind: 'partial', added: [ORACLE] });
  });

  it('throws (holds the gas cursor) until a v1 oracle resolves — never a partial set', async () => {
    const a = createMetricAdapter();
    expect(() => a.gasSources!()).toThrow(/not resolved/);
    await a.discover(stub([], { oracleOf: () => null }));
    expect(() => a.gasSources!()).toThrow(/not resolved/);
  });

  it('never shrinks: an oracle seen once stays, even when its pool is drained or its read fails later', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([], { oracleOf: (prov) => (prov.endsWith(P.weth.slice(6)) ? ORACLE_B : ORACLE) }));
    await a.discover(stub([], { oracleOf: (prov) => (prov.endsWith(P.weth.slice(6)) ? null : ORACLE), balances: () => [0n, 0n] }));
    expect(a.gasSources!().flatMap((s) => s.address as string[])).toEqual(expect.arrayContaining([ORACLE, ORACLE_B, V0_PUSH_ORACLE]));
  });
});

describe('Metric v0 (retired generation)', () => {
  it('tails all eight v0 pools, bounded at the last v0 swap — the live tail never fetches them', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([]));
    const v0 = a.logSources().filter((s) => s.key.startsWith('v0:'));
    expect(v0).toHaveLength(1);
    expect((v0[0].address as string[]).sort()).toEqual(V0_POOLS.map((p) => p.pool).sort());
    expect(v0[0].untilBlock).toBe(V0_LAST_SWAP_BLOCK);
    expect(sourceSpan(v0[0], 112_000_000n, 112_000_999n)).toBeNull();                 // today's tail: no fetch
    expect(sourceSpan(v0[0], 108_406_000n, 108_406_999n)).toEqual({ from: 108_406_000n, to: V0_LAST_SWAP_BLOCK });
  });

  it('makes no RPC call of its own: discovery does not touch the chain for v0', async () => {
    const a = createMetricAdapter();
    const ctx = stub([]);
    await a.discover(ctx);
    const v0Addrs = new Set<string>(V0_POOLS.map((p) => p.pool.toLowerCase()));
    expect(ctx.calls.some((c: any) => v0Addrs.has(String(c.address).toLowerCase()))).toBe(false);
  });
});

describe('a v1 pool announced mid-range forces that range to be re-read', () => {
  const created = (pool: string) => ({ args: { poolAddress: pool }, blockNumber: 110n });
  const swapLog = (pool: string) => ({
    address: pool, blockNumber: 150n, transactionHash: '0x' + '2'.repeat(64), logIndex: 3,
    // pool gained 2 USDC (token1), paid out 1 WMON (token0): a buy
    args: { recipient: '0x' + '3'.repeat(40), amountDeltas: ((-(10n ** 18n)) & ((1n << 128n) - 1n)) << 128n | 2_000_000n },
  });
  const bundleFor = (a: ReturnType<typeof createMetricAdapter>, logs: Record<string, any[]>) =>
    Object.fromEntries(a.logSources().map((s) => [s.key, logs[s.key.replace(/swap@\d+$/, 'swap')] ?? []]));

  it('throws (holds the cursor) when the announced pool was not in the swap query, then counts its swap on the retry', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([], { pools: [P.wmon] }));
    const NEW = P.weth;
    const first = bundleFor(a, { 'v1:poolCreated': [created(NEW)], 'v1:swap': [] });
    const ctx = stub([], { pools: [P.wmon, NEW] });
    await expect(a.decode(ctx, first, () => 1, new Set())).rejects.toThrow(/admitted after this range's swap query/);
    // the retry re-snapshots logSources(), which now carries NEW
    const second = bundleFor(a, { 'v1:poolCreated': [created(NEW)], 'v1:swap': [swapLog(NEW)] });
    const fills = await a.decode(ctx, second, () => 1, new Set());
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ venueId: 'metric', market: 'ETH/USDC', side: 'buy', usd: 2 });
  });

  it('does not retry a range whose swap query already covered the pool', async () => {
    const a = createMetricAdapter();
    await a.discover(stub([], { pools: [P.wmon] }));
    const b = bundleFor(a, { 'v1:swap': [swapLog(P.wmon)] });
    await expect(a.decode(stub([]), b, () => 1, new Set())).resolves.toHaveLength(1);
  });
});
