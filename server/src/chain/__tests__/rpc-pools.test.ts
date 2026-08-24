import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError } from 'viem';
import type { NoteCode } from '@shared';
import { RpcBreaker, isAvailabilityFailure, isTransportFailure, type BreakerEndpoint } from '../failover.js';

/**
 * The two-pool split (config.ts: RPC pools). What matters here is not that two
 * clients exist, but that the DEFAULT is indistinguishable from the single-client
 * behavior it replaces — an unconfigured deployment must not silently acquire a
 * second endpoint list — and that a half-configured archive refuses to boot
 * rather than looking configured while doing nothing.
 *
 * Importing chain/rpc.js instantiates transports; it never touches the network.
 */

const ARCHIVE = 'https://archive.example/rpc/k';
const HOT = 'https://hot.example/rpc/k';

/** fresh module graph so config.ts re-reads the stubbed env. */
async function loadRpc() {
  vi.resetModules();
  return import('../rpc.js');
}

beforeEach(() => { vi.unstubAllEnvs(); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('RPC pool resolution', () => {
  it('shares ONE client when no archive is configured (pre-split behavior)', async () => {
    vi.stubEnv('RPC_HTTP_URL', HOT);
    const rpc = await loadRpc();
    expect(rpc.hasDedicatedArchive).toBe(false);
    // identity, not equality: the deep crawls must ride the very same breaker,
    // or an unconfigured deploy would quietly double its endpoint pools.
    expect(rpc.archiveClient).toBe(rpc.publicClient);
    expect(rpc.archiveRpcStatus()).toEqual(rpc.rpcStatus());
  });

  it('builds a SEPARATE pool once RPC_ARCHIVE_URL is set', async () => {
    vi.stubEnv('RPC_HTTP_URL', HOT);
    vi.stubEnv('RPC_ARCHIVE_URL', ARCHIVE);
    const rpc = await loadRpc();
    expect(rpc.hasDedicatedArchive).toBe(true);
    expect(rpc.archiveClient).not.toBe(rpc.publicClient);
    // distinct labels are what make a note readable — "primary unhealthy" is
    // ambiguous across two pools that both have a primary.
    expect(rpc.rpcStatus().active).toBe('primary');
    expect(rpc.archiveRpcStatus().active).toBe('archive');
  });

  it('probeArchiveChain is a no-op while the pools are shared', async () => {
    vi.stubEnv('RPC_HTTP_URL', HOT);
    const rpc = await loadRpc();
    // no network: probeChain would dial, probeArchiveChain must not.
    await expect(rpc.probeArchiveChain()).resolves.toEqual({ ok: true, block: 0 });
  });
});

describe('RPC pool config', () => {
  it('honors RPC_BACKUP_URLS as the pre-split alias for RPC_HTTP_BACKUP_URLS', async () => {
    vi.stubEnv('RPC_HTTP_URL', HOT);
    vi.stubEnv('RPC_BACKUP_URLS', 'https://old-backup.example/rpc');
    vi.resetModules();
    const { config } = await import('../../config.js');
    expect(config.rpcBackups).toEqual(['https://old-backup.example/rpc']);
  });

  it('prefers the new name when both are set', async () => {
    vi.stubEnv('RPC_HTTP_URL', HOT);
    vi.stubEnv('RPC_HTTP_BACKUP_URLS', 'https://new.example/rpc');
    vi.stubEnv('RPC_BACKUP_URLS', 'https://old.example/rpc');
    vi.resetModules();
    const { config } = await import('../../config.js');
    expect(config.rpcBackups).toEqual(['https://new.example/rpc']);
  });

  it('still lets an empty list opt out of backups entirely', async () => {
    vi.stubEnv('RPC_HTTP_URL', HOT);
    vi.stubEnv('RPC_HTTP_BACKUP_URLS', '');
    vi.resetModules();
    const { config } = await import('../../config.js');
    expect(config.rpcBackups).toEqual([]);
  });

  it('ships NO default archive backup — the public endpoint fails the contract', async () => {
    // rpc.monad.xyz serves headers/logs/receipts to block 0 but refuses
    // historical eth_getCode, which GasTracker.creationBlock() bisects. Failing
    // over to it would leave gas bootstrap retrying forever while the pool
    // reported itself healthy, so the archive pool defaults to no backup.
    vi.stubEnv('RPC_HTTP_URL', HOT);
    vi.stubEnv('RPC_ARCHIVE_URL', ARCHIVE);
    vi.resetModules();
    const { config } = await import('../../config.js');
    expect(config.rpcArchiveBackups).toEqual([]);
    expect(config.rpcBackups).toEqual(['https://rpc.monad.xyz']); // hot pool keeps its default
  });

  it('REFUSES to boot on archive backups with no archive primary', async () => {
    vi.stubEnv('RPC_HTTP_URL', HOT);
    vi.stubEnv('RPC_ARCHIVE_BACKUP_URLS', 'https://archive-backup.example/rpc');
    vi.resetModules();
    // a setting that silently does nothing is the failure mode this rejects:
    // the deep crawls would keep riding the hot pool while an operator believes
    // they have a fallback.
    await expect(import('../../config.js')).rejects.toThrow(/RPC_ARCHIVE_BACKUP_URLS is set but RPC_ARCHIVE_URL/);
  });
});

describe('exhausted pool recovery (PR #85 review)', () => {
  const ok = (label: string): BreakerEndpoint => ({
    label,
    request: async (a: { method: string }) => (a.method === 'eth_chainId' ? '0x8f' : '0x100'),
  });
  const flaky = (label: string, state: { dead: boolean }): BreakerEndpoint => ({
    label,
    request: async (a: { method: string }) => {
      if (state.dead) throw new HttpRequestError({ url: 'http://x', status: 502 });
      return a.method === 'eth_chainId' ? '0x8f' : '0x100';
    },
  });

  /** Drive failing traffic until the breaker reaches the post-wrap state, where
   *  it has cycled through every endpoint and sits back on index 0. Written as a
   *  search, not a fixed request count: the exact count depends on the failure
   *  threshold, and the state is TRANSIENT — the next advance leaves it again. */
  const driveToWrap = async (breaker: RpcBreaker): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      await breaker.request({ method: 'eth_blockNumber' }).catch(() => undefined);
      const st = breaker.status();
      if (st.down && !st.degraded) return true;
    }
    return false;
  };

  it('reports down WITHOUT degraded once every endpoint is exhausted', async () => {
    // The state the deep-crawl gate has to know about: the breaker wraps back to
    // index 0, so `degraded` reads false while nothing is actually serving.
    // Gating deep crawls on `degraded` alone would run them right through it.
    const state = { dead: true };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    breaker.attach([flaky('primary', state), flaky('backup-1', state)]);
    const reached = await driveToWrap(breaker);
    breaker.stop();
    expect(reached).toBe(true);
  });

  it('recovers from down via its own probe, with no consumer traffic', async () => {
    // A paused deep crawl sends nothing, so the pool must prove its own recovery
    // — otherwise the crawl waits on `down` and `down` waits on a request.
    const state = { dead: true };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    breaker.attach([flaky('primary', state), flaky('backup-1', state)]);
    const codes: NoteCode[] = [];
    breaker.subscribe((n) => codes.push(n.code));
    expect(await driveToWrap(breaker)).toBe(true);

    state.dead = false;          // endpoint comes back; nobody calls it
    await breaker.probeNow();    // the timer's body, driven directly
    breaker.stop();
    expect(breaker.status()).toMatchObject({ down: false, degraded: false });
    expect(codes).toContain('rpc.recovered');
  });

  it('recovers an exhausted pool on a backup while the primary stays down', async () => {
    const primary = { dead: true };
    const backup = { dead: true };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    breaker.attach([flaky('primary', primary), flaky('backup-1', backup)]);
    expect(await driveToWrap(breaker)).toBe(true);

    backup.dead = false;
    await breaker.probeNow();
    breaker.stop();
    expect(breaker.status()).toMatchObject({ active: 'backup-1', down: false, degraded: true });
  });

  it('reports down and self-probes when every endpoint is unreachable at boot', async () => {
    const state = { dead: true };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    breaker.attach([flaky('primary', state), flaky('backup-1', state)]);
    const result = await breaker.verify(143);
    breaker.stop();
    expect(result.ok).toBe(false);
    expect(breaker.status()).toMatchObject({ down: true, degraded: false });
  });

  it('flags a wrong-chain primary distinctly from an unreachable one', async () => {
    // The archive probe is non-fatal for an outage but MUST fail closed here:
    // a wrong-chain node answers successfully, so failover can never route away.
    const wrongChain: BreakerEndpoint = { label: 'archive', request: async () => '0x1' }; // chainId 1
    const b1 = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    b1.attach([wrongChain, ok('archive-backup-1')]);
    const wrong = await b1.verify(143);
    b1.stop();
    expect(wrong).toMatchObject({ ok: false, wrongChain: true });

    const unreachable: BreakerEndpoint = { label: 'archive', request: async () => { throw new Error('ECONNREFUSED'); } };
    const b2 = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    b2.attach([unreachable, ok('archive-backup-1')]);
    const down = await b2.verify(143);
    b2.stop();
    expect(down.ok).toBe(true);            // pre-positions onto the healthy backup
    expect(down.wrongChain).toBeUndefined(); // and is NOT a misconfiguration
  });

  it('never promotes a wrong-chain primary that was unreachable at boot', async () => {
    let primaryState: 'down' | 'wrong' = 'down';
    const primary: BreakerEndpoint = {
      label: 'archive',
      request: async (a) => {
        if (primaryState === 'down') throw new Error('offline');
        return a.method === 'eth_chainId' ? '0x1' : '0x100';
      },
    };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    breaker.attach([primary, ok('archive-backup-1')]);
    expect((await breaker.verify(143)).ok).toBe(true);
    expect(breaker.status().active).toBe('archive-backup-1');

    primaryState = 'wrong';
    await breaker.probeNow();
    const servedChain = await breaker.request({ method: 'eth_chainId' });
    breaker.stop();
    expect(servedChain).toBe('0x8f');
    expect(breaker.status()).toMatchObject({ active: 'archive-backup-1', degraded: true });
  });

  it('never serves a wrong-chain backup that was unreachable at boot', async () => {
    let primaryDown = false;
    let backupState: 'down' | 'wrong' = 'down';
    const backupMethods: string[] = [];
    const primary: BreakerEndpoint = {
      label: 'archive',
      request: async (a) => {
        if (primaryDown) throw new HttpRequestError({ url: 'http://x', status: 502 });
        return a.method === 'eth_chainId' ? '0x8f' : '0x100';
      },
    };
    const backup: BreakerEndpoint = {
      label: 'archive-backup-1',
      request: async (a) => {
        backupMethods.push(a.method);
        if (backupState === 'down') throw new Error('offline');
        return a.method === 'eth_chainId' ? '0x1' : '0x100';
      },
    };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    breaker.attach([primary, backup]);
    expect((await breaker.verify(143)).ok).toBe(true);

    primaryDown = true;
    backupState = 'wrong';
    for (let i = 0; i < 3; i++) {
      await breaker.request({ method: 'eth_getLogs' }).catch(() => undefined);
    }
    breaker.stop();
    expect(breaker.status()).toMatchObject({ active: 'archive', down: true });
    expect(backupMethods).not.toContain('eth_getLogs');
  });
});

describe('availability vs unreadability (PR #85 review)', () => {
  const http429 = () => new HttpRequestError({ url: 'http://x', status: 429 });
  const http502 = () => new HttpRequestError({ url: 'http://x', status: 502 });

  it('treats a 429 as an availability failure but NOT a breaker trip', () => {
    // The two predicates must disagree here, and that disagreement is the point:
    // a throttled endpoint is alive (do not bounce the indexer off it) yet tells
    // a crawl nothing about whether the requested blocks exist (do not consume
    // the range). Collapsing them either way reintroduces a real bug.
    expect(isTransportFailure(http429())).toBe(false);
    expect(isAvailabilityFailure(http429())).toBe(true);
  });

  it('still counts unreachable endpoints, and still ignores real RPC errors', () => {
    expect(isAvailabilityFailure(http502())).toBe(true);
    // a node that ANSWERS "I cannot serve this range" is evidence about the
    // range — crawls may consume it, which is what hole-skipping is for.
    expect(isAvailabilityFailure(new Error('error getting block header from triedb and archive'))).toBe(false);
    expect(isAvailabilityFailure(new Error('execution reverted'))).toBe(false);
  });

  it('lets adaptive chunkers handle HTTP 413 without failing over or holding', () => {
    const rangeTooLarge = new HttpRequestError({ url: 'http://x', status: 413 });
    expect(isTransportFailure(rangeTooLarge)).toBe(false);
    expect(isAvailabilityFailure(rangeTooLarge)).toBe(false);
  });
});

describe('breaker pool labelling', () => {
  const ok = (label: string): BreakerEndpoint => ({
    label,
    request: async (a: { method: string }) => (a.method === 'eth_chainId' ? '0x8f' : '0x100'), // 143
  });
  const dead = (label: string): BreakerEndpoint => ({
    label,
    request: async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); },
  });

  it('names the pool in every note so hot and archive incidents are distinguishable', async () => {
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000, pool: 'RPC archive' });
    breaker.attach([dead('archive'), ok('archive-backup-1')]);
    const msgs: string[] = [];
    breaker.subscribe((n) => msgs.push(n.msg));
    const res = await breaker.verify(143);
    breaker.stop();
    // the dead primary is unreachable (not wrong-chain), so boot pre-positions
    // onto the backup and says WHICH pool moved.
    expect(res.ok).toBe(true);
    expect(msgs.join(' ')).toContain('RPC archive primary unreachable');
    expect(msgs.join(' ')).not.toMatch(/https?:\/\//); // URLs embed keys
  });

  it('defaults to the plain "RPC" wording for the hot pool', async () => {
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    breaker.attach([dead('primary'), ok('backup-1')]);
    const msgs: string[] = [];
    breaker.subscribe((n) => msgs.push(n.msg));
    await breaker.verify(143);
    breaker.stop();
    expect(msgs.join(' ')).toContain('RPC primary unreachable');
    expect(msgs.join(' ')).not.toContain('archive');
  });
});
