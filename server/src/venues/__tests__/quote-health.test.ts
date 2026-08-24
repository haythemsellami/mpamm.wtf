// Adapter-side quote-outage reporting (venues/quote-health.ts): dig the shared
// revert reason out of an allowFailure multicall so a venue that leaves the
// grid says WHY, instead of reading as an adapter we broke.
import { describe, expect, it } from 'vitest';
import { createQuoteOutageReporter, quoteOutageReason } from '../quote-health.js';

/**
 * The real viem error a reverted leg carries, recorded live from ThogAMM while
 * it was paused (2026-08-04): the decoded Error(string) sits on `cause.reason`,
 * one level under the execution error, and the rendered message repeats it.
 */
const PAUSED_ERROR = Object.assign(
  new Error('The contract function "makerQuoteExactInput" reverted with the following reason:\nmaker: paused\n\nContract Call:\n  address:   0x80c74517BCC2D67fFE02D3ED886796272F647210'),
  { name: 'ContractFunctionExecutionError', cause: Object.assign(new Error('...'), { name: 'ContractFunctionRevertedError', reason: 'maker: paused' }) },
);
/** the same revert with no decoded `reason` — only the rendered message. */
const MESSAGE_ONLY_ERROR = new Error('The contract function "makerQuoteExactInput" reverted with the following reason:\nmaker: paused');

const failed = (error: unknown) => ({ status: 'failure' as const, error });
const ok = { status: 'success' as const };

describe('quoteOutageReason', () => {
  it('names the shared revert reason when every leg fails', () => {
    expect(quoteOutageReason([failed(PAUSED_ERROR), failed(PAUSED_ERROR)])).toBe('maker: paused');
  });

  it('reads the reason off the rendered message when viem did not decode one', () => {
    expect(quoteOutageReason([failed(MESSAGE_ONLY_ERROR)])).toBe('maker: paused');
  });

  it('takes ONLY the reason line, not the Contract Call sections viem appends', () => {
    // `.` does not cross newlines, so the fallback stops at end-of-line — the
    // note can never bloat with addresses/args. Pinned because it is a silent
    // property of the regex, not something the code says out loud.
    const noisy = new Error([
      'The contract function "makerQuoteExactInput" reverted with the following reason:',
      'maker: paused',
      '',
      'Contract Call:',
      '  address:   0x80c74517BCC2D67fFE02D3ED886796272F647210',
      '  function:  makerQuoteExactInput(address tokenIn, address tokenOut, uint256 amountIn)',
      '  args:      (0x3bd359…, 0x754704…, 48000000000000000000)',
    ].join('\n'));
    expect(quoteOutageReason([failed(noisy)])).toBe('maker: paused');
  });

  it('is silent while ANY leg still quotes — one quiet market is not an outage', () => {
    expect(quoteOutageReason([failed(PAUSED_ERROR), ok])).toBeNull();
    expect(quoteOutageReason([])).toBeNull(); // references cold: not the venue's fault
  });

  it('reports the DOMINANT reason, and falls back rather than throwing on an opaque error', () => {
    expect(quoteOutageReason([failed(PAUSED_ERROR), failed(PAUSED_ERROR), failed(new Error('socket hang up'))]))
      .toBe('maker: paused');
    expect(quoteOutageReason([failed(undefined)])).toBe('call failed');
    expect(quoteOutageReason([failed({ cause: { cause: null } })])).toBe('call failed');
  });
});

describe('createQuoteOutageReporter', () => {
  const stub = () => {
    const notes: { code: string; msg: string }[] = [];
    return { notes, ctx: { note: (code: string, msg: string) => { notes.push({ code, msg }); } } as any };
  };

  it('notes once per distinct reason, announces recovery, and re-arms', () => {
    const { notes, ctx } = stub();
    const report = createQuoteOutageReporter('Metric');

    // Block-triggered quoting must not turn one event into a stream of notes.
    expect(report(ctx, [failed(PAUSED_ERROR)])).toBe(true);
    expect(report(ctx, [failed(PAUSED_ERROR)])).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ code: 'venue.quote.unavailable' });
    expect(notes[0].msg).toContain('maker: paused');

    // a CHANGED reason is a different event and earns its own note.
    report(ctx, [failed(new Error('reverted with the following reason:\noracle stale'))]);
    expect(notes).toHaveLength(2);
    expect(notes[1].msg).toContain('oracle stale');

    // recovery is ANNOUNCED — an adapter can only append, so silence here would
    // leave a stale warning standing (the reference-starvation lesson, 6c3cf5b).
    expect(report(ctx, [ok])).toBe(false);
    expect(notes).toHaveLength(3);
    expect(notes[2].code).toBe('venue.quote.recovered');
    expect(notes[2].msg).toContain('oracle stale');

    // and a fresh outage is on the record again, not swallowed by the old one.
    report(ctx, [failed(PAUSED_ERROR)]);
    expect(notes.map((n) => n.code)).toEqual([
      'venue.quote.unavailable', 'venue.quote.unavailable', 'venue.quote.recovered', 'venue.quote.unavailable',
    ]);
  });

  it('stays silent on an empty round — no calls is not an outage', () => {
    const { notes, ctx } = stub();
    const report = createQuoteOutageReporter('POE');
    expect(report(ctx, [])).toBe(false);
    expect(notes).toEqual([]);
  });
});
