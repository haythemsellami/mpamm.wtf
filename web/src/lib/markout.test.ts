import { describe, expect, it } from 'vitest';
import { avgMarkoutBps } from './markout';

describe('avgMarkoutBps', () => {
  it('renormalizes PnL by notional, so it agrees with the POOL PNL column', () => {
    // Σ(bps × usd / 1e4) over $31.2M at +0.3768 bps — real Hanji T+0 shape.
    expect(avgMarkoutBps(1176.06, 31_210_599)).toBeCloseTo(0.3768, 4);
    expect(avgMarkoutBps(-2043.42, 18_538_022)).toBeCloseTo(-1.1023, 4);
  });

  it('carries the sign of the PnL it is derived from', () => {
    expect(Math.sign(avgMarkoutBps(-500, 1_000_000))).toBe(-1);
    expect(Math.sign(avgMarkoutBps(500, 1_000_000))).toBe(1);
    // MAKER view is a pure flip of both inputs' numerator — same magnitude.
    expect(avgMarkoutBps(-1176.06, 31_210_599)).toBeCloseTo(-avgMarkoutBps(1176.06, 31_210_599), 12);
  });

  it('is a real mean: one large fill outweighs many small ones', () => {
    // +10bps on $1k (=+$1) vs -1bps on $100k (=-$10) → net -$9 over $101k.
    expect(avgMarkoutBps(1 - 10, 101_000)).toBeCloseTo(-0.891, 3);
  });

  it('returns 0 rather than Infinity/NaN when a row has no volume', () => {
    // reachable: a group whose fills all lack a realized markout at this horizon.
    expect(avgMarkoutBps(0, 0)).toBe(0);
    expect(avgMarkoutBps(5, 0)).toBe(0);
    expect(avgMarkoutBps(NaN, 1000)).toBe(0);
    expect(avgMarkoutBps(1, Infinity)).toBe(0);
  });
});
