// Lossless archive retry semantics for the REAL volume and onboarding loops.
// Each case pauses one private scan at an injected 429, proves its persisted
// cursor/done marker did not move, then restores the endpoint and proves the
// exact same range completes. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError } from 'viem';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VenueAdapter, LogSource } from '../venues/adapter.js';

const START = 4_000_000n;
const VID = 'cursor-hold';
const ADDRESS = '0x00000000000000000000000000000000000000f1' as const;
const CLOSED_TS = BigInt(Math.floor(Date.parse('2026-08-23T12:00:00Z') / 1000));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

type Failure = 'logs' | 'timestamp' | 'failover-success' | 'failover-hole' | 'none';

async function setup(failure: Failure, readDelayMs = 0) {
  const path = join(tmpdir(), `history-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  vi.stubEnv('DB_PATH', path);
  vi.stubEnv('BACKFILL_CHUNK', '1');
  vi.stubEnv('GETLOGS_CHUNK', '1');
  vi.stubEnv('GETLOGS_MIN_CHUNK', '1');
  vi.stubEnv('BACKFILL_MERGE_EVERY', '1');
  vi.stubEnv('BACKFILL_PACE_MS', '0');
  vi.resetModules();

  let failing = true;
  let degraded = false;
  const archiveClient: any = {
    getLogs: async () => {
      if (readDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, readDelayMs));
      if (failing && failure === 'logs') throw new HttpRequestError({ url: 'http://x', status: 429 });
      if (failing && failure.startsWith('failover-')) {
        degraded = true;
        if (failure === 'failover-hole') throw new Error('error getting block header from triedb and archive');
      }
      return failure === 'timestamp'
        ? [{ blockNumber: START, transactionHash: '0xabc', logIndex: 0 }]
        : [];
    },
    getBlock: async () => {
      if (failing && failure === 'timestamp') throw new HttpRequestError({ url: 'http://x', status: 429 });
      return { timestamp: CLOSED_TS };
    },
    getBlockNumber: async () => START,
  };
  const primaryStatus = () => ({ active: degraded ? 'archive-backup-1' : 'archive', degraded, down: false });
  vi.doMock('../chain/rpc.js', () => ({
    publicClient: {},
    archiveClient,
    getLogsChunked: vi.fn(),
    probeChain: vi.fn(),
    probeArchiveChain: vi.fn(),
    blockAtOrAfter: vi.fn(async () => START),
    onRpcEvent: vi.fn(),
    onArchiveRpcEvent: vi.fn(),
    rpcStatus: primaryStatus,
    rpcGeneration: () => 0,
    archiveRpcStatus: primaryStatus,
    archiveRpcGeneration: () => 0,
    hasDedicatedArchive: true,
  }));

  const { LiveDataSource } = await import('../datasource/live.js');
  const source = new LiveDataSource() as any;
  const adapter = {
    venues: () => [{
      id: VID,
      name: VID,
      color: { light: '#000', dark: '#fff' },
      kind: 'amm' as const,
      role: 'venue' as const,
      sinceUtc: '2026-08-01',
    }],
    backfillFromUtc: '2026-08-01',
    discover: async () => {},
    logSources: () => [],
    decode: async () => [],
  } as unknown as VenueAdapter;
  const sources: LogSource[] = [{ key: 'fills', address: ADDRESS, events: [] }];
  return { source, adapter, sources, path, recover: () => { failing = false; degraded = false; } };
}

describe('history cursor holds', () => {
  it.each(['volume', 'markout'] as const)(
    '%s holds and resumes when getLogs is throttled',
    async (stage) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-08-24T12:00:00Z'));
      const { source, adapter, sources, path, recover } = await setup('logs');
      const cursorKey = stage === 'volume' ? `backfill_cursor_${VID}` : `mkfill_cursor_${VID}`;
      const doneKey = stage === 'volume' ? `backfill_done_${VID}` : `mkfill_done_${VID}`;
      source.store.setMeta(cursorKey, String(START));
      const before = source.store.getMeta(cursorKey);
      const run = stage === 'volume'
        ? source.backfillAdapter(adapter, VID, VID, '2026-08-01', sources, Date.parse('2026-08-24T12:00:00Z'), START)
        : source.backfillRecentFills(adapter, VID, VID, sources, Date.parse('2026-08-24T12:00:00Z'), START);

      await vi.advanceTimersByTimeAsync(0);
      expect(source.store.getMeta(cursorKey)).toBe(before);
      expect(source.store.getMeta(doneKey)).not.toBe('1');

      recover();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.runAllTimersAsync();
      await run;
      expect(source.store.getMeta(cursorKey)).toBe(String(START + 1n));
      expect(source.store.getMeta(doneKey)).toBe('1');
      source.store.close();
      unlinkSync(path);
    },
  );

  it.each(['volume', 'markout'] as const)(
    '%s holds and resumes when a block timestamp is throttled',
    async (stage) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-08-24T12:00:00Z'));
      const { source, adapter, sources, path, recover } = await setup('timestamp');
      const cursorKey = stage === 'volume' ? `backfill_cursor_${VID}` : `mkfill_cursor_${VID}`;
      const doneKey = stage === 'volume' ? `backfill_done_${VID}` : `mkfill_done_${VID}`;
      const before = source.store.getMeta(cursorKey);
      const run = stage === 'volume'
        ? source.backfillAdapter(adapter, VID, VID, '2026-08-01', sources, Date.parse('2026-08-24T12:00:00Z'), START)
        : source.backfillRecentFills(adapter, VID, VID, sources, Date.parse('2026-08-24T12:00:00Z'), START);

      await vi.advanceTimersByTimeAsync(0);
      expect(source.store.getMeta(cursorKey)).toBe(before);
      expect(source.store.getMeta(doneKey)).not.toBe('1');

      recover();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.runAllTimersAsync();
      await run;
      expect(source.store.getMeta(cursorKey)).toBe(String(START + 1n));
      expect(source.store.getMeta(doneKey)).toBe('1');
      source.store.close();
      unlinkSync(path);
    },
  );

  it.each([
    ['volume', 'failover-success'],
    ['volume', 'failover-hole'],
    ['markout', 'failover-success'],
    ['markout', 'failover-hole'],
  ] as const)(
    '%s discards a %s result and resumes on the primary',
    async (stage, failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-08-24T12:00:00Z'));
      const { source, adapter, sources, path, recover } = await setup(failure);
      const cursorKey = stage === 'volume' ? `backfill_cursor_${VID}` : `mkfill_cursor_${VID}`;
      const doneKey = stage === 'volume' ? `backfill_done_${VID}` : `mkfill_done_${VID}`;
      source.store.setMeta(cursorKey, String(START));
      const run = stage === 'volume'
        ? source.backfillAdapter(adapter, VID, VID, '2026-08-01', sources, Date.parse('2026-08-24T12:00:00Z'), START)
        : source.backfillRecentFills(adapter, VID, VID, sources, Date.parse('2026-08-24T12:00:00Z'), START);

      await vi.advanceTimersByTimeAsync(0);
      expect(source.store.getMeta(cursorKey)).toBe(String(START));
      expect(source.store.getMeta(doneKey)).not.toBe('1');

      recover();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.runAllTimersAsync();
      await run;
      expect(source.store.getMeta(cursorKey)).toBe(String(START + 1n));
      expect(source.store.getMeta(doneKey)).toBe('1');
      source.store.close();
      unlinkSync(path);
    },
  );

  it.each(['volume', 'markout'] as const)(
    '%s persists its resumable cursor but never marks done after UTC rollover',
    async (stage) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-08-24T23:59:59.900Z'));
      const { source, adapter, sources, path } = await setup('none', 200);
      const cursorKey = stage === 'volume' ? `backfill_cursor_${VID}` : `mkfill_cursor_${VID}`;
      const doneKey = stage === 'volume' ? `backfill_done_${VID}` : `mkfill_done_${VID}`;
      const run = stage === 'volume'
        ? source.backfillAdapter(adapter, VID, VID, '2026-08-01', sources, Date.parse('2026-08-24T23:59:59.900Z'), START)
        : source.backfillRecentFills(adapter, VID, VID, sources, Date.parse('2026-08-24T23:59:59.900Z'), START);
      const rejected = expect(run).rejects.toThrow(/crossed UTC midnight/);

      await vi.advanceTimersByTimeAsync(200);
      await vi.runAllTimersAsync();
      await rejected;
      expect(source.store.getMeta(cursorKey)).toBe(String(START + 1n));
      expect(source.store.getMeta(doneKey)).not.toBe('1');
      source.store.close();
      unlinkSync(path);
    },
  );
});
