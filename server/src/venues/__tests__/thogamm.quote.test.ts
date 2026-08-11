// ThogAMM's quote view REVERTS when the maker is off, and the quote multicall
// runs with allowFailure — so the venue's disappearance from the grid carries
// no signal by itself. These lock down that the adapter names the cause.
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
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
  it('quotes from latest state without a preflight head read or historical pin', async () => {
    const reads: { heads: number; args?: any } = { heads: 0 };
    const adapter = createThogammAdapter();
    const ctx = stubCtx([], { live: true }, reads);
    await adapter.discover!(ctx);
    reads.heads = 0;

    expect((await adapter.quote!(ctx, [100])).length).toBeGreaterThan(0);
    expect(reads.heads).toBe(0);
    expect(reads.args).toBeDefined();
    expect(reads.args).not.toHaveProperty('blockNumber');
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

    expect(await adapter.quote!(ctx, [100])).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0].code).toBe('venue.quote.unavailable');
    expect(notes[0].msg).toContain('maker: paused');
    // the note must distinguish the two causes it could be — that is its job.
    expect(notes[0].msg).toMatch(/venue disabled.*ABI drifted/);

    // the quote loop runs every 500ms: one event, one note.
    await adapter.quote!(ctx, [100]);
    await adapter.quote!(ctx, [100]);
    expect(notes).toHaveLength(1);

    // recovery is ANNOUNCED — an adapter cannot retract, so silence here would
    // leave a stale warning standing (the reference-starvation lesson, 6c3cf5b).
    state.live = true;
    const rows = await adapter.quote!(ctx, [100]);
    expect(rows.length).toBeGreaterThan(0);
    expect(notes).toHaveLength(2);
    expect(notes[1].code).toBe('venue.quote.recovered');
    expect(notes[1].msg).toContain('maker: paused');

    // and a fresh outage is on the record again, not swallowed by the old one.
    state.live = false;
    await adapter.quote!(ctx, [100]);
    expect(notes.map((n) => n.code)).toEqual(['venue.quote.unavailable', 'venue.quote.recovered', 'venue.quote.unavailable']);
  });
});
