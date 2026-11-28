import { describe, expect, it } from 'vitest';
import { timingSummary, type FrameTiming } from './frame-timing';

const s = (proposalTs: number | undefined, receivedAt: number, drawnAt: number, paintOpportunityAt?: number): FrameTiming =>
  ({ block: 1, revision: 0, ts: 0, proposalTs, receivedAt, decodedAt: receivedAt, drawnAt, paintOpportunityAt });

describe('timing summary', () => {
  it('reports each hop over painted samples only', () => {
    const list = [
      s(1_000, 1_100, 1_105, 1_110),
      s(2_000, 2_150, 2_152, 2_160),
      s(3_000, 3_090, 3_091, 3_100),
      s(4_000, 4_120, 4_121), // drawn, not painted yet
    ];
    const t = timingSummary(list);
    expect(t['proposal → paint']).toEqual({ p50: 110, p90: 160, n: 3 });
    expect(t['receive → paint']).toEqual({ p50: 10, p90: 10, n: 3 });
    expect(t['receive → draw']?.n).toBe(3);
  });

  it('has no proposal hop without a proposal time (today\'s producer)', () => {
    const t = timingSummary([s(undefined, 10, 12, 20)]);
    expect(t['proposal → paint']).toBeNull();
    expect(t['receive → paint']).toEqual({ p50: 10, p90: 10, n: 1 });
  });
});
