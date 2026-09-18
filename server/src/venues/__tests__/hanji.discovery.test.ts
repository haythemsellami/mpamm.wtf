import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createHanjiAdapter } from '../hanji.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/hanji-config.json', import.meta.url), 'utf8')) as {
  block: number; markets: Array<{ market: string; address: string; result: string[] }>;
};
const configRows = new Map(fixture.markets.map((market) => [market.address.toLowerCase(), market.result.map((value, index) =>
  [2, 3, 6, 7].includes(index) ? value : BigInt(value))]));
type Failure = 'partial' | 'empty' | 'tokens' | 'transport';
function context() {
  let failure: Failure | undefined;
  const multicall = vi.fn(async ({ contracts }: any) => {
    if (contracts[0]?.functionName !== 'getConfig') return contracts.map(() => ({ status: 'success', result: [[], [], [], []] }));
    if (failure === 'transport') throw new Error('transport unavailable');
    if (failure === 'empty') return [];
    return contracts.map((contract: any, index: number) => {
      if (failure === 'partial' && index === 2) return { status: 'failure', error: new Error('one market unavailable') };
      const result = [...configRows.get(contract.address.toLowerCase())!];
      if (failure === 'tokens' && index === 2) result[2] = '0x0000000000000000000000000000000000000000';
      return { status: 'success', result };
    });
  });
  return { ctx: { client: { multicall }, note: vi.fn(), pricer: { pairMid: () => 0 } } as any,
    fail: (mode?: Failure) => { failure = mode; }, multicall };
}

describe('Hanji discovery commits a complete validated set', () => {
  it.each<Failure>(['partial', 'empty', 'tokens', 'transport'])('preserves every admitted market and fill source after %s discovery failure', async (failure) => {
    const adapter = createHanjiAdapter(), { ctx, fail, multicall } = context();
    await adapter.discover(ctx);
    const markets = fixture.markets.map((market) => market.market);
    const sources = adapter.logSources();
    expect(adapter.quoteMarkets!()).toEqual(markets);
    expect(sources[0].address).toEqual(fixture.markets.map((market) => market.address));
    fail(failure);
    await expect(adapter.discover(ctx)).rejects.toThrow();
    expect(adapter.quoteMarkets!()).toEqual(markets);
    expect(adapter.logSources()).toEqual(sources);
    await adapter.quote!(ctx, [100], BigInt(fixture.block), new Set([markets[2]]));
    const request = multicall.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ blockNumber: BigInt(fixture.block) });
    expect(request.contracts).toHaveLength(1);
    expect(request.contracts[0].args[0]).toBe(adapter.entryPoints!()[2].address);
    fail(); await adapter.discover(ctx);
    expect(adapter.quoteMarkets!()).toEqual(markets);
    expect(adapter.logSources()).toEqual(sources);
  });

  it('does not admit a partial first discovery, then recovers all registered markets', async () => {
    const adapter = createHanjiAdapter(), { ctx, fail } = context();
    fail('partial');
    await expect(adapter.discover(ctx)).rejects.toThrow('Hanji getConfig failed');
    expect(adapter.quoteMarkets!()).toEqual([]);
    expect(() => adapter.logSources()).toThrow('Hanji discovery unavailable');
    fail(); await adapter.discover(ctx);
    expect(adapter.quoteMarkets!()).toEqual(fixture.markets.map((market) => market.market));
    expect(adapter.logSources()[0].address).toHaveLength(6);
  });
});
