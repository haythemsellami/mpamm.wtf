import { afterEach, describe, expect, it } from 'vitest';
import { HttpRequestError, TimeoutError } from 'viem';
import type { NoteCode } from '@shared';
import { RpcBreaker, isTransportFailure, type BreakerEndpoint } from '../failover.js';

/**
 * The breaker is pure logic over injected request fns — no network, no viem
 * client. What these tests lock down: the failure CLASSIFIER (JSON-RPC errors
 * and 429 must never trip a switch), threshold + transparent retry semantics,
 * burst dedup (one bad batch = one advance), probe-based snap-back, and the
 * boot verify()'s wrong-chain / unreachable-primary policies.
 */

const http502 = () => new HttpRequestError({ url: 'http://x', status: 502 });
const httpNet = () => new HttpRequestError({ url: 'http://x' }); // network/DNS — no status
const http429 = () => new HttpRequestError({ url: 'http://x', status: 429 });
const timeout = () => new TimeoutError({ body: { method: 'eth_blockNumber' }, url: 'http://x' });

/** endpoint whose behavior is a mutable script: 'ok' | an Error factory. */
function fakeEndpoint(label: string, behavior: { mode: 'ok' | (() => Error) }): BreakerEndpoint & { calls: string[] } {
  const ep = {
    label,
    calls: [] as string[],
    request: async (args: { method: string }) => {
      ep.calls.push(args.method);
      if (behavior.mode === 'ok') {
        if (args.method === 'eth_chainId') return '0x8f'; // 143
        return '0x100';
      }
      throw behavior.mode();
    },
  };
  return ep;
}

function build(behaviors: Array<{ mode: 'ok' | (() => Error) }>, labels?: string[]) {
  const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 }); // timer irrelevant — probeNow() driven
  const endpoints = behaviors.map((b, i) => fakeEndpoint(labels?.[i] ?? (i === 0 ? 'primary' : `backup-${i}`), b));
  breaker.attach(endpoints);
  // events carry the note code the transition IS, so a consumer filters on the
  // code and never on the wording (server/src/notes.ts).
  const events: string[] = [];
  const codes: NoteCode[] = [];
  breaker.subscribe((n) => { events.push(n.msg); codes.push(n.code); });
  return { breaker, endpoints, events, codes };
}

let cleanup: RpcBreaker[] = [];
afterEach(() => { for (const b of cleanup) b.stop(); cleanup = []; });
const track = <T extends { breaker: RpcBreaker }>(x: T): T => { cleanup.push(x.breaker); return x; };

describe('isTransportFailure', () => {
  it('counts 5xx, network errors and timeouts; never JSON-RPC errors or 429', () => {
    expect(isTransportFailure(http502())).toBe(true);
    expect(isTransportFailure(httpNet())).toBe(true);
    expect(isTransportFailure(timeout())).toBe(true);
    expect(isTransportFailure(http429())).toBe(false);
    expect(isTransportFailure(new Error('execution reverted'))).toBe(false);
    expect(isTransportFailure(new Error('block range too large'))).toBe(false);
  });
});

describe('RpcBreaker failover', () => {
  it('serves from the primary and stays there below the failure threshold', async () => {
    const primary = { mode: http502() ? (() => http502()) : 'ok' } as { mode: 'ok' | (() => Error) };
    primary.mode = () => http502();
    const { breaker } = track(build([primary, { mode: 'ok' }]));
    await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    expect(breaker.status()).toMatchObject({ active: 'primary', degraded: false });
    primary.mode = 'ok'; // success resets the streak
    await breaker.request({ method: 'eth_blockNumber' });
    primary.mode = () => http502();
    await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    expect(breaker.status().degraded).toBe(false);
  });

  it('advances after the threshold and transparently serves that request from the backup', async () => {
    const { breaker, endpoints, events, codes } = track(build([{ mode: () => http502() }, { mode: 'ok' }]));
    await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    // third failure crosses the threshold — the SAME request retries on backup-1 and succeeds.
    const res = await breaker.request({ method: 'eth_blockNumber' });
    expect(res).toBe('0x100');
    expect(breaker.status()).toMatchObject({ active: 'backup-1', degraded: true, down: false });
    expect(breaker.status().degradedSinceTs).toBeTypeOf('number');
    expect(events.filter((e) => e.includes('failover'))).toHaveLength(1);
    expect(codes).toEqual(['rpc.failover']);
    expect(endpoints[1].calls.length).toBeGreaterThan(0);
    // URLs must never leak into events.
    expect(events.join(' ')).not.toMatch(/https?:\/\//);
  });

  it('never advances on JSON-RPC-level errors or 429', async () => {
    const primary: { mode: 'ok' | (() => Error) } = { mode: () => new Error('execution reverted') };
    const { breaker } = track(build([primary, { mode: 'ok' }]));
    for (let i = 0; i < 5; i++) await expect(breaker.request({ method: 'eth_call' })).rejects.toThrow('reverted');
    primary.mode = () => http429();
    for (let i = 0; i < 5; i++) await expect(breaker.request({ method: 'eth_call' })).rejects.toThrow();
    expect(breaker.status()).toMatchObject({ active: 'primary', degraded: false });
  });

  it('a concurrent burst of failures advances once, not once per request', async () => {
    const { breaker, events } = track(build([{ mode: () => http502() }, { mode: 'ok' }, { mode: 'ok' }]));
    const burst = await Promise.allSettled(
      Array.from({ length: 6 }, () => breaker.request({ method: 'eth_blockNumber' })),
    );
    expect(events.filter((e) => e.includes('failover'))).toHaveLength(1);
    expect(breaker.status().active).toBe('backup-1');
    // late arrivals of the burst are served by the backup, not failed.
    expect(burst.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('marks down when every endpoint fails, clears on any success', async () => {
    const backup: { mode: 'ok' | (() => Error) } = { mode: () => timeout() };
    const { breaker, events, codes } = track(build([{ mode: () => http502() }, backup]));
    for (let i = 0; i < 8; i++) await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    expect(breaker.status().down).toBe(true);
    expect(events.some((e) => e.includes('unreachable'))).toBe(true);
    expect(codes).toContain('rpc.down');
    backup.mode = 'ok';
    // keep requesting — rotation lands on the healthy backup again.
    let ok = false;
    for (let i = 0; i < 8 && !ok; i++) ok = await breaker.request({ method: 'eth_blockNumber' }).then(() => true, () => false);
    expect(ok).toBe(true);
    expect(breaker.status().down).toBe(false);
    expect(events.some((e) => e.includes('serving again'))).toBe(true);
    expect(codes).toContain('rpc.recovered');
  });

  it('goes down (and back up) with a single endpoint and no backups', async () => {
    const only: { mode: 'ok' | (() => Error) } = { mode: () => http502() };
    const { breaker, events } = track(build([only]));
    for (let i = 0; i < 4; i++) await expect(breaker.request({ method: 'eth_blockNumber' })).rejects.toThrow();
    expect(breaker.status()).toMatchObject({ active: 'primary', degraded: false, down: true });
    expect(events.some((e) => e.includes('no backups configured'))).toBe(true);
    only.mode = 'ok';
    await breaker.request({ method: 'eth_blockNumber' });
    expect(breaker.status().down).toBe(false);
  });

  it('snaps back to the primary after two consecutive healthy probes', async () => {
    const primary: { mode: 'ok' | (() => Error) } = { mode: () => http502() };
    const { breaker, events } = track(build([primary, { mode: 'ok' }]));
    for (let i = 0; i < 3; i++) await breaker.request({ method: 'eth_blockNumber' }).catch(() => undefined);
    expect(breaker.status().active).toBe('backup-1');

    await breaker.probeNow();               // primary still down
    primary.mode = 'ok';
    await breaker.probeNow();               // healthy #1 — not yet
    expect(breaker.status().active).toBe('backup-1');
    await breaker.probeNow();               // healthy #2 — snap back
    expect(breaker.status()).toMatchObject({ active: 'primary', degraded: false });
    expect(breaker.status().degradedSinceTs).toBeUndefined();
    expect(events.some((e) => e.includes('recovered'))).toBe(true);
  });

  it('a failed probe resets the recovery streak', async () => {
    const primary: { mode: 'ok' | (() => Error) } = { mode: () => http502() };
    const { breaker } = track(build([primary, { mode: 'ok' }]));
    for (let i = 0; i < 3; i++) await breaker.request({ method: 'eth_blockNumber' }).catch(() => undefined);
    primary.mode = 'ok';
    await breaker.probeNow();               // healthy #1
    primary.mode = () => http502();
    await breaker.probeNow();               // fails — streak resets
    primary.mode = 'ok';
    await breaker.probeNow();               // healthy #1 again
    expect(breaker.status().active).toBe('backup-1');
    await breaker.probeNow();               // healthy #2 — now it recovers
    expect(breaker.status().active).toBe('primary');
  });
});

describe('RpcBreaker.verify (boot)', () => {
  it('passes with every endpoint healthy and stays on the primary', async () => {
    const { breaker } = track(build([{ mode: 'ok' }, { mode: 'ok' }]));
    const res = await breaker.verify(143);
    expect(res.ok).toBe(true);
    expect(res.block).toBe(256);
    expect(breaker.status()).toMatchObject({ active: 'primary', degraded: false });
  });

  it('drops a wrong-chain backup loudly and keeps serving', async () => {
    const wrongChain = {
      label: 'backup-1',
      request: async (args: { method: string }) => (args.method === 'eth_chainId' ? '0x1' : '0x100'),
    };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    cleanup.push(breaker);
    const good = fakeEndpoint('primary', { mode: 'ok' });
    breaker.attach([good, wrongChain]);
    const events: string[] = [];
    breaker.subscribe((n) => events.push(n.msg));
    const res = await breaker.verify(143);
    expect(res.ok).toBe(true);
    expect(events.some((e) => e.includes('dropped at boot'))).toBe(true);
  });

  it('is fatal when the PRIMARY is on the wrong chain', async () => {
    const wrong = {
      label: 'primary',
      request: async (args: { method: string }) => (args.method === 'eth_chainId' ? '0x1' : '0x100'),
    };
    const breaker = new RpcBreaker({ probeIntervalMs: 3_600_000 });
    cleanup.push(breaker);
    breaker.attach([wrong, fakeEndpoint('backup-1', { mode: 'ok' })]);
    const res = await breaker.verify(143);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/wrong chain/);
  });

  it('starts degraded on the first healthy backup when the primary is unreachable', async () => {
    const { breaker, events } = track(build([{ mode: () => http502() }, { mode: 'ok' }]));
    const res = await breaker.verify(143);
    expect(res.ok).toBe(true);
    expect(breaker.status()).toMatchObject({ active: 'backup-1', degraded: true });
    expect(events.some((e) => e.includes('primary unreachable at boot'))).toBe(true);
  });

  it('fails boot when nothing is reachable', async () => {
    const { breaker } = track(build([{ mode: () => http502() }, { mode: () => timeout() }]));
    const res = await breaker.verify(143);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no reachable RPC/);
  });
});
