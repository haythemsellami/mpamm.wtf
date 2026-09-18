import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('scoped quote client through the actual HTTP transport', () => {
  it('returns an isolated head while a simultaneously scheduled log request remains held', async () => {
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const logStarted = new Promise<void>((resolve) => { started = resolve; });
    const batches: string[][] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const requests = Array.isArray(body) ? body : [body];
      batches.push(requests.map((call) => call.method));
      const responses = await Promise.all(requests.map(async (call) => {
        if (call.method === 'eth_getLogs') { started(); await held; }
        return { jsonrpc: '2.0', id: call.id, result: call.method === 'eth_getLogs' ? [] : call.method === 'eth_chainId' ? '0x8f' : '0x7b' };
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const pending: Promise<unknown>[] = [];
    try {
      vi.stubEnv('RPC_HTTP_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      vi.stubEnv('RPC_HTTP_BACKUP_URLS', ''); vi.stubEnv('RPC_ARCHIVE_URL', '');
      const { publicClient, headClient, probeChain } = await import('../rpc.js');
      expect((await probeChain()).ok).toBe(true);
      let logsSettled = false, head: bigint | undefined;
      pending.push(publicClient.getLogs({ fromBlock: 1n, toBlock: 1n }).then(() => { logsSettled = true; }));
      pending.push(headClient.getBlockNumber().then((value) => { head = value; }));
      await logStarted;
      await vi.waitFor(() => expect(head).toBe(123n));
      expect(logsSettled).toBe(false);
      expect(batches.some((batch) => batch.includes('eth_getLogs') && batch.includes('eth_blockNumber'))).toBe(false);
    } finally {
      release(); await Promise.allSettled(pending); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['off', 'on'])('preserves the key, cancellation and pinned block with batching %s', async (batch) => {
    const calls: Array<{ method: string; params?: any[] }> = [];
    let signalRequest!: () => void;
    const slowStarted = new Promise<void>((resolve) => { signalRequest = resolve; });
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const requests = Array.isArray(body) ? body : [body];
      const responses = await Promise.all(requests.map(async (call) => {
        calls.push(call);
        if (call.params?.[0]?.data === '0xdead') { signalRequest(); await slow; }
        return { jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? '0x8f' : call.method === 'eth_blockNumber' ? '0x7b' : '0x1234' };
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      vi.stubEnv('RPC_HTTP_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      vi.stubEnv('RPC_HTTP_BACKUP_URLS', ''); vi.stubEnv('RPC_ARCHIVE_URL', '');
      vi.stubEnv('QUOTE_HTTP_BATCH', batch);
      const { scopedQuoteClient, probeChain, rpcStatus, rpcGeneration } = await import('../rpc.js');
      expect((await probeChain()).ok).toBe(true);
      const controller = new AbortController();
      const client = scopedQuoteClient('venue-123', controller.signal);
      await expect(client.call({ data: '0x1234', blockNumber: 123n })).resolves.toMatchObject({ data: '0x1234' });
      expect(calls.find((call) => call.method === 'eth_call')?.params?.[1]).toBe('0x7b');
      const generation = rpcGeneration();
      const pending = client.call({ data: '0xdead', blockNumber: 124n });
      const failure = expect(pending).rejects.toThrow('expired frame');
      await slowStarted;
      controller.abort(new Error('expired frame'));
      await failure;
      const count = calls.length;
      await expect(client.call({ data: '0x1234', blockNumber: 125n })).rejects.toThrow('expired frame');
      expect(calls).toHaveLength(count);
      expect(rpcGeneration()).toBe(generation);
      expect(rpcStatus()).toMatchObject({ active: 'primary', degraded: false, down: false });
    } finally {
      release(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
