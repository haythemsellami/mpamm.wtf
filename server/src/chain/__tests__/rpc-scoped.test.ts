import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('scoped quote client through the actual HTTP transport', () => {
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
