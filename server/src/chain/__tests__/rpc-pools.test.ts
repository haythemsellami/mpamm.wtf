import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcBreaker, type BreakerEndpoint } from '../failover.js';

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
