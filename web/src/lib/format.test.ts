import { describe, expect, it } from 'vitest';
import { fmtAmt, fmtAmtFull, fmtPx } from './format';

/**
 * With the token's decimals, an amount is rendered EXACTLY as it traded —
 * on-chain amounts are integers of 10^-decimals, so the true value never has
 * more fractional digits than that. Every raw value below was decoded from a
 * real Monad log.
 */
describe('fmtAmt — exact to the token when decimals are known', () => {
  it('prints an 8dp token exactly, not rounded to significant digits', () => {
    expect(fmtAmt(0.07285608, 8)).toBe('0.07285608'); // 7285608 sats of cbBTC
    expect(fmtAmt(0.19710391, 8)).toBe('0.19710391'); // 19710391 sats
    expect(fmtAmt(0.079153, 8)).toBe('0.079153');     // trailing zeros trimmed
  });

  it('prints a 6dp stable exactly', () => {
    expect(fmtAmt(329.321994, 6)).toBe('329.321994'); // the Capricorn USDC leg
  });

  it('strips IEEE noise instead of printing it as precision', () => {
    // These doubles print their own binary residue via String(); the true
    // on-chain amounts are 3.3335 and 7.4387 ETH.
    expect(String(3.3335000000000004)).toContain('0000000000');
    expect(fmtAmt(3.3335000000000004, 18)).toBe('3.3335');
    expect(fmtAmt(7.438700000000001, 18)).toBe('7.4387');
  });

  it('recovers an 18dp amount that still fits a double', () => {
    expect(fmtAmt(6.504111526424, 18)).toBe('6.504111526424');
  });

  it('keeps the visibly-approximate k/M form above 1k', () => {
    // "445.20k" cannot be misread as exact the way "0.07286" can; the full
    // figure travels in the tooltip instead of widening every row.
    expect(fmtAmt(445_198.1025903733, 18)).toBe('445.20k');
    expect(fmtAmtFull(445_198.1025903733, 18)).toBe('445198.102590373');
  });

  it('falls back to significant digits when decimals are unknown', () => {
    expect(fmtAmt(0.0000147058)).toBe('0.00001471');
  });
});

/**
 * Amount/price formatting is scale-sensitive on this dashboard: token unit
 * values span 3.1 million to one (MON ~$0.02 vs cbBTC ~$68k), and the whole
 * point of the numbers is basis points. Every magnitude below was measured off
 * the live API (leaderboard fills + the quote matrix) rather than invented.
 */

describe('fmtAmt — significant digits, not decimal places', () => {
  it('keeps the k/M compaction above 1000', () => {
    expect(fmtAmt(454_545.45)).toBe('454.55k');
    expect(fmtAmt(2_370_000)).toBe('2.37M');
    expect(fmtAmt(4_545.45)).toBe('4.55k');
  });

  it('leaves the common rows exactly as they were (≥0.1 is unchanged)', () => {
    expect(fmtAmt(0.19710391)).toBe('0.1971'); // the real cbBTC/ETH fill
    expect(fmtAmt(454.5454545)).toBe('454.5455');
    expect(fmtAmt(45.45454545)).toBe('45.4545');
  });

  it('no longer rounds a small-unit token to zero', () => {
    // $1 of cbBTC. The old fixed 4dp rendered this as "0.0000".
    expect(fmtAmt(0.0000147058)).toBe('0.00001471');
    // $10 of cbBTC — was "0.0001", one significant digit.
    expect(fmtAmt(0.000147058)).toBe('0.0001471');
    // $100 of cbBTC — was "0.0015".
    expect(fmtAmt(0.001470588)).toBe('0.001471');
  });

  it('holds 4 significant digits down to 1e-5 (a sub-cent BTC amount)', () => {
    for (const x of [0.5, 0.05, 0.005, 0.0005, 0.00005]) {
      const sig = fmtAmt(x).replace(/^0\.0*/, '').replace('.', '');
      expect(sig.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('renders every amount that can exist on-chain, down to one satoshi', () => {
    // 8dp is the finest resolution any tracked token has (WBTC/cbBTC), so the
    // cap is exactly the representable floor: 1e-8 still shows, and precision
    // only tapers below it — where no real balance can land.
    expect(fmtAmt(0.00000001)).toBe('0.00000001'); // 1 sat of cbBTC
    expect(fmtAmt(0.000005)).toBe('0.00000500');
    expect(fmtAmt(0.000000001234).split('.')[1].length).toBe(8);
  });

  it('handles the degenerate inputs without emitting NaN', () => {
    expect(fmtAmt(0)).toBe('0');
    expect(fmtAmt(Number.NaN)).toBe('—');
    expect(fmtAmt(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('fmtPx — resolves finer than the basis point being measured', () => {
  it('fixes the markets the old toFixed(5) degraded', () => {
    // MON/USDC is ~70% of all leaderboard fills. toFixed(5) gave "0.02122",
    // a ±2.4bps rounding on the very number the dashboard exists to measure.
    expect(fmtPx(0.021215136214997776)).toBe('0.0212151');
    // MON/ETH collapsed to "0.00001" — one significant digit.
    expect(fmtPx(0.00001119777994417908)).toBe('0.0000111978');
  });

  it('keeps large prices narrow enough not to clip a cell or axis gutter', () => {
    expect(fmtPx(2010.491711114444)).toBe('2010.49');
    expect(fmtPx(63186.19961340694)).toBe('63186.20');
    expect(fmtPx(3071010.5)).toBe('3071010.50');
  });

  it('mid-range prices keep six significant digits', () => {
    expect(fmtPx(32.998389156379496)).toBe('32.9984');
  });

  it('resolves better than 0.1bp on every tracked market magnitude', () => {
    for (const px of [0.00001119777994, 0.021215136215, 32.998389156, 2010.4917111, 63186.199613]) {
      const shown = Number(fmtPx(px));
      // the rounding error the display introduces, in bps
      const errBps = (Math.abs(shown - px) / px) * 1e4;
      expect(errBps).toBeLessThan(0.1);
    }
  });

  it('handles the degenerate inputs without emitting NaN', () => {
    expect(fmtPx(0)).toBe('0');
    expect(fmtPx(Number.NaN)).toBe('—');
  });
});

/**
 * The quote chart derives tick decimals from the STEP between gridlines, so
 * ticks are always distinguishable. This mirrors that rule (QuoteCanvas keeps
 * it inline against the canvas context) and pins the case that was broken:
 * MON/ETH rendered all five gridlines as "0.00001".
 */
const tickLabels = (mn: number, mx: number, GRID = 4) => {
  const dp = Math.min(10, Math.max(0, -Math.floor(Math.log10((mx - mn) / GRID))));
  return Array.from({ length: GRID + 1 }, (_, g) => (mn + (mx - mn) * (g / GRID)).toFixed(dp));
};

describe('quote-chart tick precision', () => {
  it('gives MON/ETH five DISTINCT gridlines (all were "0.00001")', () => {
    const labels = tickLabels(0.0000111, 0.0000113); // the live MON/ETH band
    expect(new Set(labels).size).toBe(5);
  });

  it('does not over-precision a large-price axis', () => {
    const labels = tickLabels(68208, 68310); // the live BTC/AUSD band
    expect(new Set(labels).size).toBe(5);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(9);
  });

  it('keeps ticks distinct across every live market band', () => {
    const bands: [number, number][] = [
      [0.02204, 0.02222],   // MON/AUSD
      [0.02152, 0.02274],   // MON/USDC
      [32.708, 32.742],     // BTC/ETH
      [2083.9, 2087.9],     // ETH/AUSD
      [3082868, 3088146],   // BTC/MON
    ];
    for (const [mn, mx] of bands) expect(new Set(tickLabels(mn, mx)).size).toBe(5);
  });
});
