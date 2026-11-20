// A share-wrapper pair (wANTx/USDC) is benchmarked against the UNDERLYING's
// book at one underlying per share. These cover the one place that fact is
// checked: what counts as parity, what a failed or stale read does, and the
// notes around it. The registry and adapter ends are in
// venues/__tests__/reference.xstocks.test.ts and metric.discovery.test.ts.
import { describe, expect, it } from 'vitest';
import { PAIRS, TOKENS, pairOf } from '@shared';
import {
  WRAPPER_PARITY_MAX_AGE_MS, WrapperParity, createParityReporter, parityWrappersOf, wrapperAtParity,
} from '../wrapper-parity.js';

const ONE = 10n ** 18n;
const DRIFT = 1_003_456_000_000_000_000n;   // what wQQQx read on 2026-11-09
const WANTX = pairOf('wANTx/USDC')!;
const MON = pairOf('MON/USDC')!;
const clock = () => { const c = { t: 1_800_000_000_000 }; return { c, now: () => c.t }; };
/** a client whose wrapper answers `answer()` (null = that call fails, 'throw' = the request does) */
const reader = (answer: () => bigint | null | 'throw') => {
  const calls: any[] = [];
  return {
    calls,
    multicall: async ({ contracts }: any) => {
      calls.push(...contracts);
      const a = answer();
      if (a === 'throw') throw new Error('HTTP 429');
      return contracts.map(() => (a === null ? { status: 'failure' as const } : { status: 'success' as const, result: a }));
    },
  };
};

describe('wrapperAtParity', () => {
  it('holds at exactly one underlying per share — wANTx as read on 2026-11-20', () => {
    expect(wrapperAtParity(ONE, 18)).toBe(true);
  });
  it('tolerates the wei of rounding a rebasing underlying leaves, in either direction', () => {
    expect(wrapperAtParity(ONE - 1n, 18)).toBe(true);
    expect(wrapperAtParity(ONE + 10n ** 13n, 18)).toBe(true);    // 0.1 bp: the edge of the band
  });
  it('fails on a real rebase and just past the band', () => {
    expect(wrapperAtParity(DRIFT, 18)).toBe(false);
    expect(wrapperAtParity(ONE + 10n ** 13n + 1n, 18)).toBe(false);
    expect(wrapperAtParity(ONE / 2n, 18)).toBe(false);
  });
});

describe('which pairs are gated', () => {
  it('only a pair that trades a parityWrapper token — today wANTx/USDC alone', () => {
    expect(parityWrappersOf(WANTX)).toEqual(['WANTX']);
    expect(PAIRS.filter((p) => parityWrappersOf(p).length).map((p) => p.symbol)).toEqual(['wANTx/USDC']);
    expect(new WrapperParity().tokens()).toEqual(['WANTX']);
  });
  it('never a pair without one, read or not: cbBTC is parity by redemption, not by a rate', () => {
    const parity = new WrapperParity();
    for (const symbol of ['MON/USDC', 'cbBTC/USDC', 'SPYx/USDC', 'BTC/USDC']) expect(parity.valid(pairOf(symbol)!)).toBe(true);
  });
});

describe('WrapperParity: fail closed, but not on one dropped read', () => {
  it('has no reference before the first read', () => {
    const parity = new WrapperParity();
    expect(parity.valid(WANTX)).toBe(false);
    expect(parity.why(WANTX)).toBe('wANTx has not answered convertToAssets');
  });

  it('reads convertToAssets(1 share) of the wrapper itself, and stands at exactly one underlying', async () => {
    const parity = new WrapperParity();
    const r = reader(() => ONE);
    await parity.refresh(r);
    expect(r.calls.map((c) => [c.address, c.functionName, c.args[0]])).toEqual([[TOKENS.WANTX.address, 'convertToAssets', ONE]]);
    expect(parity.why(WANTX)).toBeNull();
  });

  it('has no reference once the rate leaves one, and says what it read', async () => {
    const parity = new WrapperParity();
    await parity.refresh(reader(() => ONE));
    await parity.refresh(reader(() => DRIFT));
    expect(parity.why(WANTX)).toBe('1 wANTx = 1.003456 underlying');
    expect(parity.valid(MON)).toBe(true);
  });

  it('keeps the last answer through failed reads, whether the call or the whole request failed', async () => {
    const { c, now } = clock();
    const parity = new WrapperParity(now);
    await parity.refresh(reader(() => ONE));
    c.t += 60_000; await parity.refresh(reader(() => null));
    c.t += 60_000; await parity.refresh(reader(() => 'throw'));
    expect(parity.valid(WANTX)).toBe(true);
  });

  it('a failed read never revives an off-parity verdict either', async () => {
    const { c, now } = clock();
    const parity = new WrapperParity(now);
    await parity.refresh(reader(() => DRIFT));
    c.t += 60_000; await parity.refresh(reader(() => null));
    expect(parity.why(WANTX)).toBe('1 wANTx = 1.003456 underlying');
  });

  it('expires a good answer that nothing has confirmed for too long, and recovers on the next read', async () => {
    const { c, now } = clock();
    const parity = new WrapperParity(now);
    await parity.refresh(reader(() => ONE));
    c.t += WRAPPER_PARITY_MAX_AGE_MS;
    await parity.refresh(reader(() => 'throw'));
    expect(parity.valid(WANTX)).toBe(true);                 // exactly at the limit
    c.t += 1;
    expect(parity.why(WANTX)).toBe('wANTx has not answered convertToAssets');
    await parity.refresh(reader(() => ONE));
    expect(parity.valid(WANTX)).toBe(true);
  });
});

describe('parity notes', () => {
  const setup = () => {
    const state: { why: string | null } = { why: null };
    const log: string[] = [];
    const dropped: string[] = [];
    const report = createParityReporter({ why: (pair) => (pair.symbol === 'wANTx/USDC' ? state.why : null) }, {
      warn: (m) => log.push(`warn ${m}`), clear: (m) => log.push(`clear ${m}`), announce: (m) => log.push(`announce ${m}`),
      unreferenced: (market) => dropped.push(market),
    });
    return { state, log, dropped, report };
  };

  it('says nothing while the reference stands', () => {
    const { log, dropped, report } = setup();
    report(); report();
    expect(log).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('warns once for the episode, names the rate, and tells the caller to drop the pair’s samples every time', () => {
    const { state, log, dropped, report } = setup();
    state.why = '1 wANTx = 1.003456 underlying';
    report(); report(); report();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^warn wANTx\/USDC has no reference — 1 wANTx = 1\.003456 underlying/);
    expect(log[0]).toMatch(/No venue is quoted on it and its fills are not marked out \(they are still counted\)/);
    expect(dropped).toEqual(['wANTx/USDC', 'wANTx/USDC', 'wANTx/USDC']);
  });

  it('retracts the exact warning and announces the return only when the RATE is back', () => {
    const { state, log, report } = setup();
    state.why = '1 wANTx = 1.003456 underlying';
    report();
    const warned = log[0].slice('warn '.length);
    // a read that failed in between is not a return to parity
    report();
    expect(log).toHaveLength(1);
    state.why = null;
    report(); report();
    expect(log.slice(1)).toEqual([`clear ${warned}`, 'announce wANTx/USDC has its kraken reference again — the wrapper is back at one underlying per share']);
  });

  it('a changed cause replaces the line instead of stacking a second one', () => {
    const { state, log, report } = setup();
    state.why = 'wANTx has not answered convertToAssets';
    report();
    state.why = '1 wANTx = 1.003456 underlying';
    report();
    expect(log.map((l) => l.split(' ')[0])).toEqual(['warn', 'clear', 'warn']);
    expect(log[1].slice('clear '.length)).toBe(log[0].slice('warn '.length));
  });
});
