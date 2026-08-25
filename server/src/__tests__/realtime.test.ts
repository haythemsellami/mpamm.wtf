import { describe, expect, it } from 'vitest';
import { captureReferenceFrame, realtimeCoverage } from '../datasource/live.js';

describe('realtime quote coverage', () => {
  it('counts missing block numbers and a newer observed head', () => {
    const now = 100_000;
    const result = realtimeCoverage([
      { block: 101, emittedAt: now - 900, coalescedBlocks: 0 },
      { block: 102, emittedAt: now - 600, coalescedBlocks: 0 },
      { block: 104, emittedAt: now - 300, coalescedBlocks: 1 },
    ], 105, now);

    expect(result.coveragePct60s).toBe(60);
    expect(result.coalescedBlocks60s).toBe(1);
  });

  it('dedupes frames and excludes samples outside the wall-time window', () => {
    const now = 100_000;
    const result = realtimeCoverage([
      { block: 99, emittedAt: now - 60_001, coalescedBlocks: 8 },
      { block: 100, emittedAt: now - 500, coalescedBlocks: 0 },
      { block: 100, emittedAt: now - 400, coalescedBlocks: 0 },
      { block: 101, emittedAt: now - 100, coalescedBlocks: 0 },
    ], 101, now);

    expect(result.coveragePct60s).toBe(100);
    expect(result.coalescedBlocks60s).toBe(0);
  });
});

describe('frame reference capture', () => {
  it('keeps adapter pricing immutable after the live reference moves', () => {
    let assetUsd = 2;
    let pairMid = 3;
    const references = {
      assetUsd: () => assetUsd,
      midForPair: () => pairMid,
      quote: () => [],
    };

    const frame = captureReferenceFrame(references, [100]);
    assetUsd = 20;
    pairMid = 30;

    expect(frame.monUsd).toBe(2);
    expect(frame.pricer.pairMid('MON/USDC')).toBe(3);
    expect(frame.assetPrices.get('MON')).toBe(2);
  });
});
