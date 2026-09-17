import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, type PublicClient } from 'viem';
import { TOKENS } from '@shared';
import { metricBatchQuote } from '../metric-quote-batch.js';
import { createMetricAdapter, ROUTER, SEED_POOLS } from '../metric.js';
import type { AdapterContext } from '../adapter.js';

const abi = parseAbiParameters('(bool success, int128 amount0Delta, int128 amount1Delta)[]');
const provider = '0x1111111111111111111111111111111111111111';
const result = (buy: boolean) => ({ success: true, amount0Delta: (buy ? -1n : 1n) * 100n * 10n ** 18n, amount1Delta: (buy ? 1n : -1n) * 100_000_000n });
const contractResult = (c: any) => {
  if (c.functionName === 'getImmutables') return { status: 'success', result: [ROUTER, provider, TOKENS.WMON.address, TOKENS.USDC.address, 0n, 0n, 0n, false, 0n, 0n, 0, 0, 0n, 0n] };
  if (c.functionName === 'balanceOf') return { status: 'success', result: 10n ** 24n };
  if (c.functionName === 'getBidAndAskPrice') return { status: 'success', result: [100n, 101n] };
  if (c.functionName === 'quoteSwap') { const r = result(!c.args[1]); return { status: 'success', result: [r.amount0Delta, r.amount1Delta] }; }
  return { status: 'failure' };
};
const contextFor = (call: unknown, multicall: unknown) => ({
  config: { metricBatchQuote: true }, client: { call, multicall, getBlockNumber: async () => 123n },
  getLogs: async () => [], note: () => {}, pricer: { pairMid: () => 1, tokenForUsd: (_token: string, usd: number) => usd },
}) as unknown as AdapterContext;

describe('Metric read-only helper', () => {
  it('preserves signed deltas, per-leg failures and the requested block', async () => {
    const call = vi.fn(async (_request: unknown) => ({ data: encodeAbiParameters(abi, [[result(true), { success: false, amount0Delta: 0n, amount1Delta: 0n }]]) }));
    const actual = await metricBatchQuote({ call } as unknown as PublicClient, ROUTER, [{ pool: SEED_POOLS[0], provider, legs: [
      { zeroForOne: false, amount: 100_000_000n, limit: (1n << 128n) - 1n }, { zeroForOne: true, amount: 100n * 10n ** 18n, limit: 1n },
    ] }], 123n);
    expect(actual).toEqual([{ status: 'success', result: [-100n * 10n ** 18n, 100_000_000n] }, { status: 'failure' }]);
    expect(call.mock.calls[0][0]).toMatchObject({ blockNumber: 123n });
    expect(call.mock.calls[0][0]).not.toHaveProperty('to');
  });

  it('falls back to the original quote path and cools down unsupported providers', async () => {
    const call = vi.fn(async () => { throw new Error('creation calls unsupported'); });
    const multicall = vi.fn(async ({ contracts }: any) => contracts.map(contractResult));
    const context = contextFor(call, multicall);
    const adapter = createMetricAdapter(); await adapter.discover(context);
    const first = await adapter.quote!(context, [100], 123n, new Set(['MON/USDC']));
    const second = await adapter.quote!(context, [100], 124n, new Set(['MON/USDC']));
    expect(call).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ bidPx: 1, askPx: 1, filledFull: true });
    expect(second.map(({ ts, ...row }) => row)).toEqual(first.map(({ ts, ...row }) => row));
    expect(multicall.mock.calls.filter(([arg]) => arg.contracts[0]?.functionName === 'quoteSwap').map(([arg]) => arg.blockNumber)).toEqual([123n, 124n]);
  });

  it.each(['getBidAndAskPrice', 'quoteSwap'])('does not commit a cooldown when canceled during fallback %s', async (stage) => {
    const call = vi.fn(async () => { throw new Error('creation calls unsupported'); });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let hold = false;
    const multicall = vi.fn(async ({ contracts }: any) => {
      if (hold && contracts[0]?.functionName === stage) { entered(); await held; }
      return contracts.map(contractResult);
    });
    const context = contextFor(call, multicall);
    const adapter = createMetricAdapter(); await adapter.discover(context);
    hold = true;
    const controller = new AbortController();
    const pending = adapter.quote!({ ...context, quoteSignal: controller.signal }, [100], 123n, new Set(['MON/USDC']));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waiting;
    controller.abort(); release();
    await rejected;
    hold = false;
    expect(await adapter.quote!(context, [100], 124n, new Set(['MON/USDC']))).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(2);
    await adapter.quote!(context, [100], 125n, new Set(['MON/USDC']));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not commit a cooldown when the fallback rejects', async () => {
    const call = vi.fn(async () => { throw new Error('creation calls unsupported'); });
    let fail = false;
    const multicall = vi.fn(async ({ contracts }: any) => {
      if (fail) throw new Error('fallback unavailable');
      return contracts.map(contractResult);
    });
    const context = contextFor(call, multicall);
    const adapter = createMetricAdapter(); await adapter.discover(context);
    fail = true;
    await expect(adapter.quote!(context, [100], 123n, new Set(['MON/USDC']))).rejects.toThrow('fallback unavailable');
    fail = false;
    expect(await adapter.quote!(context, [100], 124n, new Set(['MON/USDC']))).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
