// Capricorn's quotability gate is a DEGRADATION report, not lifecycle: a pool
// that trades but will not price is exactly what the core's went-dark backstop
// cannot explain on its own. What that costs if it is only ever raised is a
// `warn` that outlives the outage — the pool prices again and the window still
// says it does not (#70).
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import { createCapricornAdapter } from '../capricorn.js';

const A = (s: string) => s as `0x${string}`;

/** a stubbed chain where every admitted pool is unpaused, and `quotes` decides
 *  whether `quoteExactIn` answers — the one condition the note is about. */
const ctxWith = (quotes: boolean, rec: { code: string; msg: string }[]) => ({
  client: {
    getBlockNumber: async () => 1_000_000n,
    multicall: async ({ contracts }: any) => contracts.map((c: any) => {
      if (c.functionName === 'getTokens') return { status: 'success', result: [TOKENS.WMON.address, TOKENS.USDC.address] };
      if (c.functionName === 'feeBps') return { status: 'success', result: 5n };
      if (c.functionName === 'paused') return { status: 'success', result: false };
      if (c.functionName === 'quoteExactIn') return { status: 'success', result: quotes ? 10n ** 18n : 0n };
      return { status: 'failure' };
    }),
    readContract: async () => 0n,
  },
  getLogs: async () => [],
  pricer: { pairMid: () => 1, usdPerToken: () => 1, usdForToken: () => 1, tokenForUsd: () => 1, assetUsd: () => 1 },
  note: (code: string, msg: string) => rec.push({ code, msg }),
  config: { sizesUsd: [100] },
}) as any;

const quoteCodes = (rec: { code: string }[]) => rec.filter((n) => n.code.startsWith('venue.quote.')).map((n) => n.code);

describe('Capricorn unquotable-pool note announces its own recovery', () => {
  it('warns while the pools will not price, announces once when they do, then stays quiet', async () => {
    const a = createCapricornAdapter();

    const dark: { code: string; msg: string }[] = [];
    await a.discover(ctxWith(false, dark));
    expect(quoteCodes(dark)).toEqual(['venue.quote.unavailable']);
    expect(dark[dark.length - 1].msg).toMatch(/unpaused pool\(s\) are not returning a quote/);

    const healed: { code: string; msg: string }[] = [];
    await a.discover(ctxWith(true, healed));
    expect(quoteCodes(healed)).toEqual(['venue.quote.recovered']);
    expect(healed.find((n) => n.code === 'venue.quote.recovered')!.msg)
      .toBe('Capricorn pAMM: every unpaused pool is quoting again');

    const quiet: { code: string; msg: string }[] = [];
    await a.discover(ctxWith(true, quiet));
    expect(quoteCodes(quiet)).toEqual([]);
  });

  it('says nothing about a venue that was never degraded', async () => {
    const a = createCapricornAdapter();
    const healthy: { code: string; msg: string }[] = [];
    await a.discover(ctxWith(true, healthy));
    expect(quoteCodes(healthy)).toEqual([]);
  });
});
