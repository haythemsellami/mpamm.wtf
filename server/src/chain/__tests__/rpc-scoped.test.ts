import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi } from 'viem';
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
  it('keeps depth rows identical while reducing Multicall chunks and pinning every request to the proposal', async () => {
    const hash = `0x${'a'.repeat(64)}` as `0x${string}`;
    const calls: any[] = [];
    const abi = parseAbi(['function value(uint256 index) view returns (uint256)']);
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const response = (call: any) => {
        let result: any = call.method === 'eth_chainId' ? '0x8f' : '0x7b';
        if (call.method === 'eth_call') {
          calls.push(call);
          const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.params[0].data });
          const contracts = decoded.args![0] as readonly { callData: `0x${string}` }[];
          result = encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: contracts.map((contract) => {
            const { args } = decodeFunctionData({ abi, data: contract.callData });
            return { success: true, returnData: encodeFunctionResult({ abi, functionName: 'value', result: args[0] }) };
          }) });
        }
        return { jsonrpc: '2.0', id: call.id, result };
      };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(body) ? body.map(response) : response(body)));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      vi.stubEnv('RPC_HTTP_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      vi.stubEnv('RPC_HTTP_BACKUP_URLS', ''); vi.stubEnv('RPC_ARCHIVE_URL', '');
      const { scopedQuoteClient, scopedDepthClient, probeChain } = await import('../rpc.js');
      expect((await probeChain()).ok).toBe(true);
      const signal = new AbortController().signal;
      const contracts = Array.from({ length: 150 }, (_, i) => ({ address: '0x0000000000000000000000000000000000000001' as const, abi, functionName: 'value' as const, args: [BigInt(i)] as const }));
      const original = await scopedQuoteClient('old-depth', signal, undefined, true).multicall({ contracts, blockNumber: 123n });
      const oldRequests = calls.length; calls.length = 0;
      const pinned = await scopedDepthClient('new-depth', signal, { number: 123n, hash, generation: 0 }).multicall({ contracts, blockNumber: 123n });
      expect(pinned).toEqual(original);
      expect(pinned).toHaveLength(150);
      expect(calls.length).toBeLessThan(oldRequests);
      expect(calls.every((call) => call.params[1]?.blockHash === hash)).toBe(true);
    } finally {
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a late quote after the head lane moves to a backup', async () => {
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const called = new Promise<void>((resolve) => { started = resolve; });
    let failed = false;
    const makeServer = (primary: boolean) => createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const requests = Array.isArray(body) ? body : [body];
      if (primary && failed && requests.some((r) => r.method === 'eth_blockNumber')) { res.writeHead(503); res.end(); return; }
      const replies = await Promise.all(requests.map(async (call) => {
        if (primary && call.method === 'eth_call') { started(); await held; }
        return { jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? '0x8f' : call.method === 'eth_call' ? '0x1234' : '0x7b' };
      }));
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    });
    const servers = [makeServer(true), makeServer(false)];
    for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    try {
      const urls = servers.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      vi.stubEnv('RPC_HTTP_URL', urls[0]); vi.stubEnv('RPC_HTTP_BACKUP_URLS', ` , ${urls[1]}`); vi.stubEnv('RPC_ARCHIVE_URL', '');
      vi.stubEnv('RPC_WS_BACKUP_URLS', 'wss://discard.example/ws, wss://backup.example/ws');
      const { scopedQuoteClient, headClient, probeChain, rpcGeneration, hotHeadEndpoint } = await import('../rpc.js');
      await probeChain();
      const block = { number: 123n, hash: `0x${'a'.repeat(64)}` as const, generation: rpcGeneration() };
      const client = scopedQuoteClient('old', new AbortController().signal, block);
      const pending = client.call({ data: '0xabcd', blockNumber: 123n });
      const rejection = expect(pending).rejects.toThrow('RPC pool changed');
      await called; failed = true;
      for (let i = 0; i < 3; i++) await headClient.getBlockNumber().catch(() => {});
      expect(rpcGeneration()).toBeGreaterThan(block.generation);
      expect(hotHeadEndpoint().wsUrl).toBe('wss://backup.example/ws');
      release(); await rejection;
      await expect(client.call({ data: '0xabcd', blockNumber: 123n })).rejects.toThrow('RPC pool changed');
    } finally {
      release();
      for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  });

});
