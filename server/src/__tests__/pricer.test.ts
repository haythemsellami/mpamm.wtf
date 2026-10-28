// UsdPricer splits two jobs that used to share one price. Sizing and the bps
// anchor need a LIVE price: no live book, no quote. Valuing a fill that already
// settled on-chain must not fail for want of one, because decode throwing holds
// the shared tail for every venue. A Kraken xStock in its 24/5 closure is the
// case: its last good price values the fill, and nothing else.
import { describe, expect, it } from 'vitest';
import { UsdPricer } from '../pricer.js';

const closed = (key: string) => (key === 'SPYx' ? 0 : key === 'MON' ? 0.02 : 0);
const settled = (key: string) => (key === 'SPYx' ? 770 : closed(key));

describe('UsdPricer settled-fill valuation', () => {
  it('values a settled fill at the last good price while the market is closed', () => {
    const p = new UsdPricer(closed, undefined, settled);
    expect(p.usdForToken('SPYX', 2)).toBe(1540);
  });

  it('never sizes or anchors with it', () => {
    const p = new UsdPricer(closed, () => 0, settled);
    expect(p.usdPerToken('SPYX')).toBe(0);
    expect(p.tokenForUsd('SPYX', 1000)).toBe(0);
    expect(p.pairMid('SPYx/USDC')).toBe(0);
  });

  it('leaves stables and live assets unchanged, and unknown tokens at 0', () => {
    const p = new UsdPricer(closed, undefined, settled);
    expect(p.usdForToken('USDC', 12.5)).toBe(12.5);
    expect(p.usdForToken('WMON', 100)).toBe(2);
    expect(p.usdForToken('NOPE', 100)).toBe(0);
  });

  it('without a settled source, values exactly as before', () => {
    const p = new UsdPricer(closed);
    expect(p.usdForToken('SPYX', 2)).toBe(0);
    expect(p.usdForToken('USDC', 12.5)).toBe(12.5);
    expect(p.usdForToken('WMON', 100)).toBe(2);
  });
});
