import { describe, expect, it } from 'vitest';
import type { VenueMeta } from '@shared';
import { poolLeaderboardLabel } from './leaderboard-pool';

const venues: Record<string, VenueMeta> = {
  hanji: {
    id: 'hanji',
    name: 'Hanji pAMM Vault',
    color: { light: '#A21CAF', dark: '#C026D3' },
    kind: 'clob',
    role: 'venue',
  },
};

describe('poolLeaderboardLabel', () => {
  it('renders venue, market, and short contract without the technical prefix', () => {
    expect(poolLeaderboardLabel({
      key: 'lob 0xAC652E', venueId: 'hanji', market: 'ETH/USDC',
    }, venues)).toBe('Hanji pAMM Vault · ETH/USDC · 0xAC652E');
  });

  it('keeps the stable pool key when venue metadata is unavailable', () => {
    expect(poolLeaderboardLabel({ key: 'lob 0xAC652E' }, venues)).toBe('lob 0xAC652E');
  });

  it('does not claim a market for a multi-market pool', () => {
    expect(poolLeaderboardLabel({ key: 'book 59548856', venueId: 'hanji' }, venues))
      .toBe('Hanji pAMM Vault · book 59548856');
  });
});
