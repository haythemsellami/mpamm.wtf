// Two ways a logs-mode gas series ends up wrong under an unchanged destination
// set, and the repair for each:
//  - the archive answers "not found" for an OLD tx's receipt by hash while
//    still serving its block's receipts (devcore, 2026-10-15: below roughly
//    block 90-105M). The tail must price the tx from eth_getBlockReceipts, or
//    a deep scan skips every chunk it cannot price (Capricorn's first lifetime
//    scan lost April–August that way).
//  - a series already accrued with such holes is rebuilt by a GasRevision,
//    applied once per database.
// Runs the REAL pass() against stubbed clients — no network; the one archive
// lookup (blockAtOrAfter) is mocked.
import { describe, expect, it, vi } from 'vitest';
import { TransactionReceiptNotFoundError } from 'viem';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GasTracker, gasSourcesSignature } from '../gas.js';
import { VolumeStore } from '../db.js';
import type { GasRevision, GasSource, VenueAdapter } from '../venues/adapter.js';

const SEEDED_BLOCK = 1_000n;
vi.mock('../chain/rpc.js', () => ({ blockAtOrAfter: vi.fn(async () => SEEDED_BLOCK) }));

const DAY0 = 1_750_000_000; // 2025-06-15 — every log buckets into one UTC day
const DAY0_UTC = '2025-06-15';
const FEED = '0x00000000000000000000000000000000000000dd' as `0x${string}`;
const TOPIC = '0x8888888888888888888888888888888888888888888888888888888888888888' as `0x${string}`;
const SOURCES: GasSource[] = [{ mode: 'logs', address: FEED, topic0: TOPIC }];

const freshStore = () => {
  const path = join(tmpdir(), `gas-rcpt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { store: new VolumeStore(path), path };
};
const seed = (store: VolumeStore, cursor: bigint | null) => {
  store.setMeta('gas_cov_epoch', '2');
  store.setMeta('gas_srcs_v', gasSourcesSignature(SOURCES));
  store.setMeta('gas_from_v', '2025-01-01');
  if (cursor !== null) store.setMeta('gas_cursor_v', String(cursor));
};
const adapterWith = (gasRevisions?: GasRevision[]) => ({
  venues: () => [{ id: 'v', name: 'v', color: { light: '#000', dark: '#fff' }, kind: 'amm', role: 'venue', sinceUtc: '2025-01-01' }],
  discover: async () => {},
  logSources: () => [],
  decode: () => [],
  gasSources: () => SOURCES,
  ...(gasRevisions ? { gasRevisions } : {}),
}) as unknown as VenueAdapter;

/** one update tx per 800-block chunk, at the chunk's first block */
const logsFor = (params: any) => {
  const from = BigInt(params[0].fromBlock);
  return [{ transactionHash: `0x${from.toString(16).padStart(64, '0')}`, blockNumber: `0x${from.toString(16)}` }];
};

describe('logs-mode receipts: by hash, else by block', () => {
  const START = 2_000_000n;

  it('prices an old tx from its block receipts when the hash lookup says "not found"', async () => {
    const { store, path } = freshStore();
    seed(store, START);
    const calls = { byBlock: 0 };
    const client: any = {
      getBlockNumber: async () => START + 1_599n + 5n, // two 800-block chunks (head = raw − 5)
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      getTransactionReceipt: async ({ hash }: any) => { throw new TransactionReceiptNotFoundError({ hash }); },
      request: async ({ method, params }: any) => {
        if (method === 'eth_getLogs') return logsFor(params);
        if (method === 'eth_getBlockReceipts') {
          calls.byBlock++;
          const bn = BigInt(params[0]);
          return [
            { transactionHash: `0x${'e'.repeat(64)}`, gasUsed: '0x1', effectiveGasPrice: '0x1' }, // another tx in the block
            { transactionHash: `0x${bn.toString(16).padStart(64, '0')}`, gasUsed: '0x18542', effectiveGasPrice: '0x17bfac7c00' }, // 99,650 × 102 gwei
          ];
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const notes: string[] = [];
    const tracker = new GasTracker(client, store, [adapterWith()], (code) => { notes.push(code); }, () => false, 10);
    await (tracker as any).pass();
    tracker.stop();

    expect(calls.byBlock).toBe(2);
    expect(notes).not.toContain('gas.range.skipped');
    const day = store.gasDays('2099-01-01').find((d) => d.utcDay === DAY0_UTC)?.byVenue['v'];
    expect(day?.txs).toBe(2);
    expect(day?.mon).toBeCloseTo(2 * 0.0101643, 10);
    unlinkSync(path);
  });

  it('sums every concurrent receipt in a chunk — none overwrites another', async () => {
    // several updates per chunk, receipts resolving out of order: the sum must
    // be exact (an `x += await` here once lost ~30% of a deep day's MON)
    const { store, path } = freshStore();
    seed(store, START);
    const client: any = {
      getBlockNumber: async () => START + 799n + 5n, // one chunk
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      getTransactionReceipt: async ({ hash }: any) => { throw new TransactionReceiptNotFoundError({ hash }); },
      request: async ({ method, params }: any) => {
        if (method === 'eth_getLogs') {
          return [1n, 2n, 3n, 4n, 5n].map((i) => ({ transactionHash: `0x${i.toString(16).padStart(64, '0')}`, blockNumber: `0x${(START + i).toString(16)}` }));
        }
        if (method === 'eth_getBlockReceipts') {
          const i = BigInt(params[0]) - START;
          await new Promise((r) => setTimeout(r, Number(6n - i) * 5)); // later txs answer first
          return [{ transactionHash: `0x${i.toString(16).padStart(64, '0')}`, gasUsed: '0x18542', effectiveGasPrice: '0x17bfac7c00' }];
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const tracker = new GasTracker(client, store, [adapterWith()], () => {}, () => false, 10);
    await (tracker as any).pass();
    tracker.stop();
    const day = store.gasDays('2099-01-01').find((d) => d.utcDay === DAY0_UTC)?.byVenue['v'];
    expect(day?.txs).toBe(5);
    expect(day?.mon).toBeCloseTo(5 * 0.0101643, 10);
    unlinkSync(path);
  });

  it('keeps the hash lookup on the hot path, and never masks other receipt errors', async () => {
    const { store, path } = freshStore();
    seed(store, START);
    const calls = { byBlock: 0, byHash: 0 };
    const client: any = {
      getBlockNumber: async () => START + 799n + 5n, // one chunk
      getBlock: async () => ({ timestamp: BigInt(DAY0) }),
      getTransactionReceipt: async () => { calls.byHash++; throw new Error('boom'); },
      request: async ({ method, params }: any) => {
        if (method === 'eth_getLogs') return logsFor(params);
        if (method === 'eth_getBlockReceipts') { calls.byBlock++; return []; }
        throw new Error(`unexpected ${method}`);
      },
    };
    const notes: string[] = [];
    const tracker = new GasTracker(client, store, [adapterWith()], (code) => { notes.push(code); }, () => false, 10);
    await (tracker as any).pass();
    tracker.stop();

    expect(calls.byHash).toBe(3); // the existing 3 retries
    expect(calls.byBlock).toBe(0); // only "not found" falls back
    expect(notes).toContain('gas.range.skipped'); // unchanged: loud undercount, never a stall
    unlinkSync(path);
  }, 20_000);
});

describe('gas revisions', () => {
  const quietClient = (head: bigint): any => ({
    getBlockNumber: async () => head + 5n,
    getBlock: async () => ({ timestamp: BigInt(DAY0) }),
    getTransactionReceipt: async () => ({ gasUsed: 1n, effectiveGasPrice: 1n }),
    request: async ({ method }: any) => {
      if (method === 'eth_getLogs') return [];
      throw new Error(`unexpected ${method}`);
    },
  });
  const rows = (store: VolumeStore) => store.gasDays('2099-01-01').filter((d) => d.byVenue['v']).map((d) => d.utcDay);
  const withHistory = (store: VolumeStore) => {
    store.applyGas([
      { utcDay: '2025-02-01', venueId: 'v', mon: 1, txs: 10 },
      { utcDay: '2025-03-01', venueId: 'v', mon: 2, txs: 20 },
    ], 'gas_cursor_v', '9000');
  };

  it('a lifetime revision wipes the series once and re-scans from sinceUtc', async () => {
    const { store, path } = freshStore();
    seed(store, 9_000n);
    withHistory(store);
    const notes: string[] = [];
    const tracker = new GasTracker(quietClient(10_000n), store, [adapterWith([{ id: 'r1' }])], (code, msg) => { notes.push(`${code} ${msg}`); }, () => false, 1);

    await (tracker as any).pass();
    clearTimeout((tracker as any).timer);
    expect(notes).toContain("gas.series.reset v: gas revision 'r1' — rebuilding from 2025-01-01");
    expect(rows(store)).toEqual([]);
    expect(store.getMeta('gas_rev_v_r1')).toBeTruthy();
    expect(store.getMeta('gas_from_v')).toBe('2025-01-01');
    expect(BigInt(store.getMeta('gas_cursor_v')!)).toBe(SEEDED_BLOCK + 800n); // re-seeded, then one slice

    await (tracker as any).pass(); // applied once: the next pass only continues the scan
    tracker.stop();
    expect(notes.filter((n) => n.includes("revision 'r1'"))).toHaveLength(1);
    expect(BigInt(store.getMeta('gas_cursor_v')!)).toBe(SEEDED_BLOCK + 1_600n);
    unlinkSync(path);
  });

  it('a revision with `from` keeps the days before it', async () => {
    const { store, path } = freshStore();
    seed(store, 9_000n);
    withHistory(store);
    const notes: string[] = [];
    const tracker = new GasTracker(quietClient(10_000n), store, [adapterWith([{ id: 'r2', from: '2025-02-15' }])], (code, msg) => { notes.push(`${code} ${msg}`); }, () => false, 1);

    await (tracker as any).pass();
    tracker.stop();
    expect(notes).toContain("gas.series.reset v: gas revision 'r2' — rebuilding from 2025-02-15");
    expect(rows(store)).toEqual(['2025-02-01']);
    expect(store.getMeta('gas_from_v')).toBe('2025-01-01'); // the series anchor never moves
    expect(BigInt(store.getMeta('gas_cursor_v')!)).toBe(SEEDED_BLOCK + 800n);
    unlinkSync(path);
  });

  it('a venue whose scan has not started is only marked applied', async () => {
    const { store, path } = freshStore();
    seed(store, null);
    const notes: string[] = [];
    const tracker = new GasTracker(quietClient(10_000n), store, [adapterWith([{ id: 'r3' }])], (code) => { notes.push(code); }, () => false, 1);

    await (tracker as any).pass();
    tracker.stop();
    expect(notes).not.toContain('gas.series.reset');
    expect(notes).toContain('gas.scan.start');
    expect(store.getMeta('gas_rev_v_r3')).toBeTruthy();
    unlinkSync(path);
  });
});
