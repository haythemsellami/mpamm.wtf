import { describe, expect, it } from 'vitest';
import { createUniswapAdapter } from '../uniswap.js';

describe('Uniswap discovered catalog', () => {
  it('retains admitted markets when discovery temporarily cannot read any pool', async () => {
    let unavailable = false;
    const ctx: any = { note: () => {}, client: { multicall: async ({ contracts }: any) => contracts.map((c: any) =>
      unavailable ? { status: 'failure' } : { status: 'success', result: c.functionName === 'getSlot0' ? [1n, 0, 0, 0] : 1n }) } };
    const adapter = createUniswapAdapter();
    await adapter.discover(ctx);
    const markets = adapter.quoteMarkets!(); expect(markets.length).toBeGreaterThan(0);
    unavailable = true;
    await adapter.discover(ctx);
    expect(adapter.quoteMarkets!()).toEqual(markets);
    expect(await adapter.quote!(ctx, [100], 123n)).toEqual([]);
    unavailable = false;
    await adapter.discover(ctx);
    expect(adapter.quoteMarkets!()).toEqual(markets);
  });
});
