import { describe, expect, it } from 'vitest';
import type { QuoteRow, QuoteSnapshot } from '@shared';
import { LATE_MAX_BLOCKS, trackLate } from './late-venues';

const row = (venueId: string, market = 'MON/USDC'): QuoteRow => ({
  venueId, market, sizeUsd: 1000, bidBps: -2, askBps: 2, bidPx: 1, askPx: 1, spreadBps: 4,
  filledFull: true, feeBps: 0,
} as QuoteRow);
const frame = (block: number, venues: string[], market = 'MON/USDC'): QuoteSnapshot =>
  ({ block, monUsd: 0.02, ts: block, rows: venues.map((v) => row(v, market)) });

describe('late venues', () => {
  it('keeps a venue that missed a block, labelled with its age, for up to 3 blocks', () => {
    let s = trackLate(null, frame(10, ['poe', 'hanji']), 'MON/USDC', 1000);
    expect(s.late).toEqual([]);
    for (const age of [1, 2, LATE_MAX_BLOCKS]) {
      s = trackLate(s.state, frame(10 + age, ['poe']), 'MON/USDC', 1000);
      expect(s.late.map((l) => [l.venueId, l.age, l.block])).toEqual([['hanji', age, 10]]);
    }
    s = trackLate(s.state, frame(14, ['poe']), 'MON/USDC', 1000);
    expect(s.late).toEqual([]);
    // Gone for good until it quotes again.
    s = trackLate(s.state, frame(15, ['poe']), 'MON/USDC', 1000);
    expect(s.late).toEqual([]);
  });

  it('a venue that quotes again is fresh at once', () => {
    let s = trackLate(null, frame(10, ['poe', 'hanji']), 'MON/USDC', 1000);
    s = trackLate(s.state, frame(11, ['poe']), 'MON/USDC', 1000);
    s = trackLate(s.state, frame(12, ['poe', 'hanji']), 'MON/USDC', 1000);
    expect(s.late).toEqual([]);
  });

  it('a replacement frame at the same height is not lateness', () => {
    let s = trackLate(null, frame(10, ['poe', 'hanji']), 'MON/USDC', 1000);
    s = trackLate(s.state, frame(10, ['poe']), 'MON/USDC', 1000);
    expect(s.late).toEqual([]);
  });

  it('another market or size starts over', () => {
    let s = trackLate(null, frame(10, ['poe', 'hanji']), 'MON/USDC', 1000);
    s = trackLate(s.state, frame(11, ['poe'], 'BTC/USDC'), 'BTC/USDC', 1000);
    expect(s.late).toEqual([]);
    s = trackLate(s.state, frame(12, ['poe'], 'BTC/USDC'), 'BTC/USDC', 10_000);
    expect(s.late).toEqual([]);
  });
});
