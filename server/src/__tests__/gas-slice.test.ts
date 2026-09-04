// Time-slice semantics of the gas tails (gas.ts): a deep rebuild must yield
// after `sliceChunks` iterations with its partial work + cursor committed, and
// the next pass must resume exactly where it stopped. Runs the REAL pass()
// against a stubbed client — no network.
import { describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GasTracker } from '../gas.js';
import { VolumeStore } from '../db.js';
import type { VenueAdapter } from '../venues/adapter.js';

const DAY0 = 1_750_000_000; // fixed timestamp → single UTC day buckets
const freshStore = () => {
  const path = join(tmpdir(), `gas-slice-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { store: new VolumeStore(path), path };
};
// seed so tailVenue goes STRAIGHT to the tail loop: epoch current, sig matches,
// cursor present (skips blockAtOrAfter/bootstrap — those hit real RPC).
const seed = (store: VolumeStore, vid: string, sig: string, cursor: bigint) => {
  store.setMeta('gas_cov_epoch', '2');
  store.setMeta(`gas_srcs_${vid}`, sig);
  store.setMeta(`gas_cursor_${vid}`, String(cursor));
  store.setMeta(`gas_from_${vid}`, '2026-01-01');
};
const venueMeta = (id: string) => ({
  id, name: id, color: { light: '#000', dark: '#fff' }, kind: 'amm' as const, role: 'venue' as const, sinceUtc: '2026-01-01',
});

describe('blocks-mode time slice', () => {
  const TARGET = '0x00000000000000000000000000000000000000aa';
  const START = 1_000_000n;
  const HEAD_RAW = START + 10_000n + 5n; // tail head = HEAD_RAW-5 → 10 strides of 1000

  const makeTracker = (store: VolumeStore, slice: number, calls: { receipts: number }) => {
    const client: any = {
      getBlockNumber: async () => HEAD_RAW,
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      request: async ({ method }: { method: string }) => {
        if (method !== 'eth_getBlockReceipts') throw new Error(`unexpected ${method}`);
        calls.receipts++;
        return [
          { to: TARGET, gasUsed: '0x7530', effectiveGasPrice: '0x3b9aca00' },  // 30000 × 1 gwei
          { to: '0x00000000000000000000000000000000000000bb', gasUsed: '0x7530', effectiveGasPrice: '0x3b9aca00' },
        ];
      },
    };
    const adapter = {
      venues: () => [venueMeta('sliced')],
      discover: async () => {},
      logSources: () => [],
      decode: () => [],
      gasSources: () => [{ mode: 'blocks' as const, address: TARGET as `0x${string}` }],
    } as unknown as VenueAdapter;
    return new GasTracker(client, store, [adapter], () => {}, () => false, slice);
  };

  it('stops after the budget, commits partial rows + cursor, and the next pass resumes', async () => {
    const { store, path } = freshStore();
    seed(store, 'sliced', TARGET, START);
    const calls = { receipts: 0 };
    const tracker = makeTracker(store, 3, calls);

    await (tracker as any).pass();
    clearTimeout((tracker as any).timer); // NOT stop() — that would halt pass 2
    expect(calls.receipts).toBe(3); // exactly one slice, not the full 11 strides
    expect(store.getMeta('gas_cursor_sliced')).toBe(String(START + 3_000n));
    const day = store.gasDays('2099-01-01').find((d) => d.byVenue['sliced']);
    // 1 matching tx per sampled block × segLen 1000 × 3 segments, scaled cost
    expect(day?.byVenue['sliced']?.txs).toBe(3000);
    expect(day?.byVenue['sliced']?.mon).toBeCloseTo(0.00003 * 1000 * 3, 9);

    await (tracker as any).pass(); // second slice resumes from the stored cursor
    tracker.stop();
    expect(calls.receipts).toBe(6);
    expect(store.getMeta('gas_cursor_sliced')).toBe(String(START + 6_000n));
    unlinkSync(path);
  });

  it('a budget larger than the remaining work completes the tail to head (no behavior change when caught up)', async () => {
    const { store, path } = freshStore();
    seed(store, 'sliced', TARGET, START);
    const calls = { receipts: 0 };
    const tracker = makeTracker(store, 9_999, calls);
    await (tracker as any).pass();
    tracker.stop();
    expect(calls.receipts).toBe(11); // all strides in one pass (10 full + head's partial)
    expect(BigInt(store.getMeta('gas_cursor_sliced')!)).toBeGreaterThan(HEAD_RAW - 5n);
    unlinkSync(path);
  });

  it('venues after a sliced one still run within the SAME pass (no starvation)', async () => {
    const { store, path } = freshStore();
    seed(store, 'deep', TARGET, START);
    seed(store, 'fresh', '0x00000000000000000000000000000000000000cc', HEAD_RAW - 6n); // caught up
    const calls = { receipts: 0 };
    const client: any = {
      getBlockNumber: async () => HEAD_RAW,
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      request: async () => { calls.receipts++; return []; },
    };
    const mk = (id: string, addr: string): VenueAdapter => ({
      venues: () => [venueMeta(id)],
      discover: async () => {},
      logSources: () => [],
      decode: () => [],
      gasSources: () => [{ mode: 'blocks' as const, address: addr as `0x${string}` }],
    }) as unknown as VenueAdapter;
    const tracker = new GasTracker(client, store, [mk('deep', TARGET), mk('fresh', '0x00000000000000000000000000000000000000cc')], () => {}, () => false, 2);
    await (tracker as any).pass();
    tracker.stop();
    // deep venue advanced by its slice; fresh venue STILL tailed to head in the same pass
    expect(store.getMeta('gas_cursor_deep')).toBe(String(START + 2_000n));
    expect(BigInt(store.getMeta('gas_cursor_fresh')!)).toBeGreaterThan(HEAD_RAW - 6n);
    unlinkSync(path);
  });
});

describe('logs-mode time slice', () => {
  const STRAT = '0x00000000000000000000000000000000000000dd';
  const TOPIC = '0x8888888888888888888888888888888888888888888888888888888888888888';
  const START = 2_000_000n;

  it('yields after the budget with cursor persisted, resumes next pass', async () => {
    const { store, path } = freshStore();
    seed(store, 'lg', STRAT, START);
    let chunkCalls = 0;
    const client: any = {
      getBlockNumber: async () => START + 80_000n, // many 800-block chunks ahead
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      getTransactionReceipt: async () => ({ gasUsed: 30_000n, effectiveGasPrice: 1_000_000_000n }),
      request: async ({ method, params }: any) => {
        if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
        chunkCalls++;
        const from = BigInt(params[0].fromBlock);
        return [{ transactionHash: `0xt${from.toString(16)}`, blockNumber: `0x${from.toString(16)}` }];
      },
    };
    const adapter = {
      venues: () => [venueMeta('lg')],
      discover: async () => {},
      logSources: () => [],
      decode: () => [],
      gasSources: () => [{ mode: 'logs' as const, address: STRAT as `0x${string}`, topic0: TOPIC as `0x${string}` }],
    } as unknown as VenueAdapter;
    const tracker = new GasTracker(client, store, [adapter], () => {}, () => false, 2);

    await (tracker as any).pass();
    clearTimeout((tracker as any).timer); // NOT stop() — pass 2 must still run
    expect(chunkCalls).toBe(2); // exactly the slice
    const c1 = BigInt(store.getMeta('gas_cursor_lg')!);
    expect(c1).toBe(START + 1_600n); // 2 × backfillChunk(800)
    const day = store.gasDays('2099-01-01').find((d) => d.byVenue['lg']);
    expect(day?.byVenue['lg']?.txs).toBe(2); // one update tx per chunk, exact counts

    await (tracker as any).pass();
    tracker.stop();
    expect(BigInt(store.getMeta('gas_cursor_lg')!)).toBe(START + 3_200n);
    unlinkSync(path);
  });

  // The MON figure is a strided receipt SAMPLE in logs mode too (gas.ts
  // header): a logs venue served without ≈ read as exact while ThogAMM's
  // heavy-tailed push costs were ~5-10% off. Counts stay exact and unmarked.
  it('marks a logs-mode venue approx (≈) once its sources resolve, and persists it', async () => {
    const { store, path } = freshStore();
    seed(store, 'lg', STRAT, START);
    const client: any = {
      getBlockNumber: async () => START + 2_000n,
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      getTransactionReceipt: async () => ({ gasUsed: 30_000n, effectiveGasPrice: 1_000_000_000n }),
      request: async ({ method, params }: any) => {
        if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
        const from = BigInt(params[0].fromBlock);
        return [{ transactionHash: `0xt${from.toString(16)}`, blockNumber: `0x${from.toString(16)}` }];
      },
    };
    const adapter = {
      venues: () => [venueMeta('lg')],
      discover: async () => {},
      logSources: () => [],
      decode: () => [],
      gasSources: () => [{ mode: 'logs' as const, address: STRAT as `0x${string}`, topic0: TOPIC as `0x${string}` }],
    } as unknown as VenueAdapter;
    const tracker = new GasTracker(client, store, [adapter], () => {}, () => false, 2);
    expect(tracker.approxVenueIds()).toEqual([]); // nothing resolved yet

    await (tracker as any).pass();
    tracker.stop();
    expect(tracker.approxVenueIds()).toEqual(['lg']);
    expect(store.getMeta('gas_approx_lg')).toBe('1'); // sticky across restarts
    // a fresh tracker over the same store carries the marker before any pass
    const again = new GasTracker(client, store, [adapter], () => {}, () => false, 2);
    expect(again.approxVenueIds()).toEqual(['lg']);
    unlinkSync(path);
  });
});

describe('archive availability cursor holds', () => {
  const STRAT = '0x00000000000000000000000000000000000000ee';
  const TOPIC = '0x9999999999999999999999999999999999999999999999999999999999999999';
  const START = 3_000_000n;

  it.each(['logs', 'timestamp', 'receipt'] as const)('holds a logs-mode chunk when %s is unavailable, then resumes', async (stage) => {
    const { store, path } = freshStore();
    seed(store, 'held-logs', STRAT, START);
    let unavailable = true;
    const denied = () => new HttpRequestError({ url: 'http://x', status: 429 });
    const client: any = {
      getBlockNumber: async () => START + 804n, // finalized head = START+799: one 800-block chunk
      getBlock: async () => {
        if (unavailable && stage === 'timestamp') throw denied();
        return { timestamp: BigInt(DAY0) };
      },
      getTransactionReceipt: async () => {
        if (unavailable && stage === 'receipt') throw denied();
        return { gasUsed: 30_000n, effectiveGasPrice: 1_000_000_000n };
      },
      request: async ({ method }: { method: string }) => {
        if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
        if (unavailable && stage === 'logs') throw denied();
        return [{ transactionHash: '0xabc', blockNumber: `0x${START.toString(16)}` }];
      },
    };
    const adapter = {
      venues: () => [venueMeta('held-logs')],
      discover: async () => {},
      logSources: () => [],
      decode: () => [],
      gasSources: () => [{ mode: 'logs' as const, address: STRAT as `0x${string}`, topic0: TOPIC as `0x${string}` }],
    } as unknown as VenueAdapter;
    const tracker = new GasTracker(client, store, [adapter], () => {}, () => false, 1);

    await (tracker as any).pass();
    clearTimeout((tracker as any).timer);
    expect(store.getMeta('gas_cursor_held-logs')).toBe(String(START));
    expect(store.gasDays('2099-01-01').some((d) => d.byVenue['held-logs'])).toBe(false);

    unavailable = false;
    await (tracker as any).pass();
    tracker.stop();
    expect(store.getMeta('gas_cursor_held-logs')).toBe(String(START + 800n));
    expect(store.gasDays('2099-01-01').some((d) => d.byVenue['held-logs'])).toBe(true);
    unlinkSync(path);
  });

  it('holds a blocks-mode segment on a 5xx, then resumes without losing it', async () => {
    const { store, path } = freshStore();
    seed(store, 'held-blocks', STRAT, START);
    let unavailable = true;
    const client: any = {
      getBlockNumber: async () => START + 1_004n, // finalized head = START+999: one stride
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      request: async ({ method }: { method: string }) => {
        if (method !== 'eth_getBlockReceipts') throw new Error(`unexpected ${method}`);
        if (unavailable) throw new HttpRequestError({ url: 'http://x', status: 502 });
        return [{ to: STRAT, gasUsed: '0x7530', effectiveGasPrice: '0x3b9aca00' }];
      },
    };
    const adapter = {
      venues: () => [venueMeta('held-blocks')],
      discover: async () => {},
      logSources: () => [],
      decode: () => [],
      gasSources: () => [{ mode: 'blocks' as const, address: STRAT as `0x${string}` }],
    } as unknown as VenueAdapter;
    const tracker = new GasTracker(client, store, [adapter], () => {}, () => false, 1);

    await (tracker as any).pass();
    clearTimeout((tracker as any).timer);
    expect(store.getMeta('gas_cursor_held-blocks')).toBe(String(START));
    expect(store.gasDays('2099-01-01').some((d) => d.byVenue['held-blocks'])).toBe(false);

    unavailable = false;
    await (tracker as any).pass();
    tracker.stop();
    expect(store.getMeta('gas_cursor_held-blocks')).toBe(String(START + 1_000n));
    expect(store.gasDays('2099-01-01').some((d) => d.byVenue['held-blocks'])).toBe(true);
    unlinkSync(path);
  });

  it.each(['success', 'hole'] as const)('discards a logs-mode %s completed after transparent failover', async (outcome) => {
    const { store, path } = freshStore();
    const vid = `failover-${outcome}`;
    seed(store, vid, STRAT, START);
    let degraded = false;
    let first = true;
    const client: any = {
      getBlockNumber: async () => START + 804n,
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      getTransactionReceipt: async () => ({ gasUsed: 30_000n, effectiveGasPrice: 1_000_000_000n }),
      request: async ({ method }: { method: string }) => {
        if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
        if (first) {
          first = false;
          degraded = true;
          if (outcome === 'hole') throw new Error('error getting block header from triedb and archive');
        }
        return [{ transactionHash: '0xabc', blockNumber: `0x${START.toString(16)}` }];
      },
    };
    const adapter = {
      venues: () => [venueMeta(vid)],
      discover: async () => {},
      logSources: () => [],
      decode: () => [],
      gasSources: () => [{ mode: 'logs' as const, address: STRAT as `0x${string}`, topic0: TOPIC as `0x${string}` }],
    } as unknown as VenueAdapter;
    const tracker = new GasTracker(client, store, [adapter], () => {}, () => degraded, 1);

    await (tracker as any).pass();
    clearTimeout((tracker as any).timer);
    expect(store.getMeta(`gas_cursor_${vid}`)).toBe(String(START));
    expect(store.gasDays('2099-01-01').some((d) => d.byVenue[vid])).toBe(false);

    degraded = false;
    await (tracker as any).pass();
    tracker.stop();
    expect(store.getMeta(`gas_cursor_${vid}`)).toBe(String(START + 800n));
    expect(store.gasDays('2099-01-01').some((d) => d.byVenue[vid])).toBe(true);
    unlinkSync(path);
  });
});
