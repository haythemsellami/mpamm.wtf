// pairFor(base, quote) returns the FIRST matching pair, which the registry
// treats as the canonical-token pair; token-specific crosses (cbBTC, an
// alternative BTC wrapper) are referenced by symbol. A cbBTC pair listed ahead
// of its WBTC twin would make pairFor book WBTC flow under cbBTC's parity
// reference, dropping the WBTCBTC basis.
import { describe, expect, it } from 'vitest';
import { PAIRS, pairFor } from '@shared';

describe('pairFor resolves the canonical-token pair', () => {
  it('never lets a cbBTC cross shadow its WBTC twin', () => {
    const groups = new Map<string, string[]>();
    for (const p of PAIRS) groups.set(`${p.base}|${p.quote}`, [...(groups.get(`${p.base}|${p.quote}`) ?? []), p.symbol]);
    for (const [key, symbols] of groups) {
      const [base, quote] = key.split('|');
      if (symbols.every((s) => s.includes('cbBTC'))) continue;   // no canonical twin (WBTC/cbBTC)
      expect(pairFor(base, quote)!.symbol, key).not.toContain('cbBTC');
    }
  });

  it('resolves XAUt and every xStock against BTC to the WBTC pair', () => {
    for (const base of ['XAUt', 'SPYx', 'QQQx', 'EWYx', 'NVDAx', 'TSLAx']) {
      expect(pairFor(base, 'BTC')).toMatchObject({ symbol: `${base}/BTC`, quoteWrapBasisSymbol: 'WBTCBTC' });
    }
  });
});
