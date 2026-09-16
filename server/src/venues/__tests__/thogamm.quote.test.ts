// ThogAMM's quote view REVERTS when the maker is off, and the quote multicall
// runs with allowFailure — so the venue's disappearance from the grid carries
// no signal by itself. These lock down that the adapter names the cause.
import { describe, expect, it } from 'vitest';
import { TOKENS, ASSETS, pairOf } from '@shared';
import { createThogammAdapter } from '../thogamm.js';

/**
 * The real viem error a reverted `makerQuoteExactInput` leg carries, recorded
 * live at block 93,063,4xx while ThogAMM was paused: the decoded Error(string)
 * sits on `cause.reason`, one level under the execution error, and the
 * rendered message repeats it.
 */
const PAUSED_ERROR = Object.assign(
  new Error('The contract function "makerQuoteExactInput" reverted with the following reason:\nmaker: paused\n\nContract Call:\n  address:   0x80c74517BCC2D67fFE02D3ED886796272F647210'),
  { name: 'ContractFunctionExecutionError', cause: Object.assign(new Error('...'), { name: 'ContractFunctionRevertedError', reason: 'maker: paused' }) },
);
/** the same revert with no decoded `reason` — only the rendered message. */
const MESSAGE_ONLY_ERROR = new Error('The contract function "makerQuoteExactInput" reverted with the following reason:\nmaker: paused');

const failed = (error: unknown) => ({ status: 'failure' as const, error });

const LIVE_TOKEN_ADDRESSES = [
  TOKENS.USDC.address, TOKENS.AUSD.address, TOKENS.USDT0.address,
  TOKENS.WMON.address, TOKENS.WETH.address, TOKENS.WBTC.address, TOKENS.CBBTC.address,
  TOKENS.XAUT0.address,
];

/** ctx whose quote multicall reverts every leg, until `live` is flipped on. */
function stubCtx(notes: { code: string; msg: string }[], state: { live: boolean }, quoteReads?: { heads: number; args?: any }) {
  return {
    client: {
      getBlockNumber: async () => {
        if (quoteReads) quoteReads.heads++;
        return 93_063_374n;
      },
      readContract: async ({ functionName }: any) =>
        functionName === 'getPoolIds'
          ? ['0xce389e78282dedac7b18ba7f775b7602d2ab3ab171bbd6711eb0239be6ef4dcc']
          : LIVE_TOKEN_ADDRESSES,
      multicall: async (args: any) => {
        const { contracts } = args;
        if (quoteReads && contracts[0]?.functionName === 'makerQuoteExactInput') quoteReads.args = args;
        return contracts.map((c: any) =>
          // discovery asks for decimals; quoting asks for makerQuoteExactInput.
          c.functionName === 'decimals'
            ? { status: 'success', result: Object.values(TOKENS).find((t) => t.address.toLowerCase() === String(c.address).toLowerCase())!.decimals }
            : state.live
              ? { status: 'success', result: [1n, 93_063_374n] }
              : failed(PAUSED_ERROR));
      },
    },
    pricer: { pairMid: () => 0.0207, usdPerToken: () => 0.0207 },
    note: (code: string, msg: string) => { notes.push({ code, msg }); },
  } as any;
}

describe('ThogAMM quote block selection', () => {
  it('pins the multicall to the frame block without an adapter-local head read', async () => {
    const reads: { heads: number; args?: any } = { heads: 0 };
    const adapter = createThogammAdapter();
    const ctx = stubCtx([], { live: true }, reads);
    await adapter.discover!(ctx);
    reads.heads = 0;

    expect((await adapter.quote!(ctx, [100], 123n)).length).toBeGreaterThan(0);
    expect(reads.heads).toBe(0);
    expect(reads.args).toBeDefined();
    expect(reads.args).toHaveProperty('blockNumber', 123n);
    expect(reads.args).not.toHaveProperty('blockTag');
  });
});

describe('ThogAMM quote outage notes', () => {
  it('says the maker is paused instead of vanishing silently, once, then announces recovery', async () => {
    const notes: { code: string; msg: string }[] = [];
    const state = { live: false };
    const adapter = createThogammAdapter();
    const ctx = stubCtx(notes, state);
    await adapter.discover!(ctx);
    notes.length = 0;

    expect(await adapter.quote!(ctx, [100], 123n)).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0].code).toBe('venue.quote.unavailable');
    expect(notes[0].msg).toContain('maker: paused');
    // the note must distinguish the two causes it could be — that is its job.
    expect(notes[0].msg).toMatch(/venue disabled.*ABI drifted/);

    // Repeated block frames for one outage remain one event and one note.
    await adapter.quote!(ctx, [100], 123n);
    await adapter.quote!(ctx, [100], 123n);
    expect(notes).toHaveLength(1);

    // recovery is ANNOUNCED — an adapter cannot retract, so silence here would
    // leave a stale warning standing (the reference-starvation lesson, 6c3cf5b).
    state.live = true;
    const rows = await adapter.quote!(ctx, [100], 123n);
    expect(rows.length).toBeGreaterThan(0);
    expect(notes).toHaveLength(2);
    expect(notes[1].code).toBe('venue.quote.recovered');
    expect(notes[1].msg).toContain('maker: paused');

    // and a fresh outage is on the record again, not swallowed by the old one.
    state.live = false;
    await adapter.quote!(ctx, [100], 123n);
    expect(notes.map((n) => n.code)).toEqual(['venue.quote.unavailable', 'venue.quote.recovered', 'venue.quote.unavailable']);
  });
});

describe('ThogAMM XAUt markets (gold sizing + crypto-quoted terms)', () => {
  /** per-token USD prices. The stub's maker echoes the same ratio, so a
   *  correctly-sized leg lands at px == outUsd/inUsd EXACTLY — a decimals bug
   *  (XAUT0 is 6, not 18) or a wrong pair-terms mid shows up as px off by
   *  10^k or by the quote asset's whole value, not as a subtle drift. */
  const USD: Record<string, number> = {
    USDC: 1, AUSD: 1, USDT0: 1, USD1: 1,
    WMON: 0.0207, WETH: 3_500, WBTC: 118_000, CBBTC: 118_000, XAUT0: 4_350,
  };
  // registry KEY of a token address (symbols differ from keys: 'cbBTC' ≠ CBBTC)
  const keyOf = (addr: string) => Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === addr.toLowerCase())![0];
  const pricedCtx = () => ({
    client: {
      getBlockNumber: async () => 93_063_374n,
      readContract: async ({ functionName }: any) =>
        functionName === 'getPoolIds'
          ? ['0xce389e78282dedac7b18ba7f775b7602d2ab3ab171bbd6711eb0239be6ef4dcc']
          : LIVE_TOKEN_ADDRESSES,
      multicall: async ({ contracts }: any) => contracts.map((c: any) => {
        if (c.functionName === 'decimals') return { status: 'success', result: TOKENS[keyOf(c.address)].decimals };
        const [inAddr, outAddr, amountIn] = c.args as [string, string, bigint];
        const tin = TOKENS[keyOf(inAddr)], tout = TOKENS[keyOf(outAddr)];
        const humanIn = Number(amountIn) / 10 ** tin.decimals;
        // px = quote-per-base = usd(tokenIn)/usd(tokenOut): sell XAUt for $100 ⇒ $100 of USDC out
        const humanOut = humanIn * (USD[keyOf(inAddr)] / USD[keyOf(outAddr)]);
        return { status: 'success', result: [BigInt(Math.round(humanOut * 10 ** tout.decimals)), 93_063_374n] };
      }),
    },
    pricer: {
      usdPerToken: (key: string) => USD[key] ?? 0,
      pairMid: (market: string) => {
        const p = pairOf(market);
        if (!p) return 0;
        const quoteUsd = p.quoteKind === 'asset' ? USD[ASSETS[p.quote].token] : 1;
        return quoteUsd > 0 ? USD[ASSETS[p.base].token] / quoteUsd : 0;
      },
    },
    note: () => {},
  } as any);

  it('sizes and prices the gold market in USDC terms at 6-decimal precision', async () => {
    const adapter = createThogammAdapter();
    await adapter.discover!(pricedCtx());
    const rows = await adapter.quote!(pricedCtx(), [100], 123n, new Set(['XAUt/USDC']));
    expect(rows).toHaveLength(1);
    // tolerance = one 6-dec tick of the small XAUt leg (the stub's echo
    // rounds 0.0229885057… XAUt to 0.022989 — ~2.2e-5 relative, ~0.2bps)
    const rel = (x: number) => Math.abs(x - 4_350) / 4_350;
    expect(rel(rows[0].bidPx)).toBeLessThan(5e-5);
    expect(rel(rows[0].askPx)).toBeLessThan(5e-5);
    expect(Math.abs(rows[0].bidBps)).toBeLessThan(0.3);
    expect(Math.abs(rows[0].askBps)).toBeLessThan(0.3);
    expect(rows[0].oneSided).toBe(false);
  });

  it('prices a crypto-quoted gold pair in the quote asset\'s own terms', async () => {
    const adapter = createThogammAdapter();
    await adapter.discover!(pricedCtx());
    const rows = await adapter.quote!(pricedCtx(), [100], 123n, new Set(['XAUt/MON']));
    expect(rows).toHaveLength(1);
    // 4350 USD/XAUt ÷ 0.0207 USD/MON — MON per XAUt, not a USD number
    const rel = (x: number) => Math.abs(x - 4_350 / 0.0207) / (4_350 / 0.0207);
    expect(rel(rows[0].bidPx)).toBeLessThan(5e-5);
    expect(rel(rows[0].askPx)).toBeLessThan(5e-5);
  });
});
