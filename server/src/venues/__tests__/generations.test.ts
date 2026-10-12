// composeGenerations: one venue over several contract generations. The
// composer must stay invisible to the core — namespaced keys in, each
// generation's own bundle out — and must never let a partial view escape
// (a missing source or a partial gas set is how history silently goes wrong).
import { describe, expect, it, vi } from 'vitest';
import { composeGenerations, type VenueGeneration } from '../generations.js';

const META = { id: 'v', name: 'V', color: { light: '#000', dark: '#fff' }, kind: 'amm' as const, role: 'venue' as const };
const gen = (over: Partial<VenueGeneration> = {}): VenueGeneration => ({
  discover: vi.fn(async () => {}),
  logSources: () => [{ key: 'swap', address: '0x0000000000000000000000000000000000000001', events: [] }],
  decode: vi.fn(async () => []),
  ...over,
});

describe('composeGenerations', () => {
  it('namespaces each generation’s source keys and keeps their spans', () => {
    const a = composeGenerations(META, {}, {
      old: gen({ logSources: () => [{ key: 'swap', address: '0x01', events: [], untilBlock: 10n }] as any }),
      new: gen(),
    });
    expect(a.logSources().map((s) => [s.key, s.untilBlock])).toEqual([['old:swap', 10n], ['new:swap', undefined]]);
  });

  it('hands each generation exactly its own logs and failed keys, un-prefixed', async () => {
    const oldGen = gen();
    const newGen = gen();
    const a = composeGenerations(META, {}, { old: oldGen, new: newGen });
    await a.decode({} as any, { 'old:swap': [1], 'new:swap': [2], 'new:attr': [] }, () => 0, new Set(['new:attr']));
    expect(oldGen.decode).toHaveBeenCalledWith({}, { swap: [1] }, expect.any(Function), new Set());
    expect(newGen.decode).toHaveBeenCalledWith({}, { swap: [2], attr: [] }, expect.any(Function), new Set(['attr']));
  });

  it('skips a generation whose sources the caller did not fetch (the fills-only volume replay)', async () => {
    const oldGen = gen();
    const a = composeGenerations(META, {}, { old: oldGen, new: gen() });
    await a.decode({} as any, { 'new:swap': [] }, () => 0, new Set());
    expect(oldGen.decode).not.toHaveBeenCalled();
  });

  it('propagates a logSources() throw from ANY generation — the fail-closed gate', () => {
    const a = composeGenerations(META, {}, { old: gen(), new: gen({ logSources: () => { throw new Error('not discovered'); } }) });
    expect(() => a.logSources()).toThrow('not discovered');
  });

  it('runs every discover() even when one fails, then surfaces the failure', async () => {
    const ok = gen();
    const a = composeGenerations(META, {}, { bad: gen({ discover: async () => { throw new Error('rpc'); } }), ok });
    await expect(a.discover({} as any)).rejects.toThrow('rpc');
    expect(ok.discover).toHaveBeenCalled();
  });

  it('declares gasSources only when some generation burns gas, and never returns a partial set', () => {
    expect(composeGenerations(META, {}, { a: gen(), b: gen() }).gasSources).toBeUndefined();
    const a = composeGenerations(META, {}, {
      old: gen({ gasSources: () => [{ mode: 'blocks', address: ['0x01'] }] as any }),
      new: gen({ gasSources: () => { throw new Error('oracle unresolved'); } }),
    });
    expect(() => a.gasSources!()).toThrow('oracle unresolved');
  });

  it('concatenates quotes and quote coverage across generations', async () => {
    const row = { venueId: 'v', market: 'MON/USDC' } as any;
    const a = composeGenerations(META, { backfillFromUtc: '2026-01-01' }, {
      old: gen(),
      new: gen({ quote: async () => [row], quoteMarkets: () => ['MON/USDC'] }),
    });
    expect(await a.quote!({} as any, [100], 1n)).toEqual([row]);
    expect(a.quoteMarkets!()).toEqual(['MON/USDC']);
    expect(a.backfillFromUtc).toBe('2026-01-01');
    expect(a.venues()).toEqual([META]);
  });
});
