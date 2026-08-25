import { describe, expect, it } from 'vitest';
import { computeLeaderboard, type LbFill } from '../analytics.js';

const fill = (id: string, market: string): LbFill => ({
  id,
  ts: 1_780_000_000_000,
  venueId: 'hanji',
  market,
  category: 'UNKNOWN',
  pool: 'lob 0xAC652E',
  to: '0xrouter',
  usd: 1_000,
  markoutsBps: [1, 2, 3, 4, 5],
});

const aggregate = (rows: LbFill[]) => {
  const makePass = () => {
    let done = false;
    return () => {
      if (done) return [];
      done = true;
      return rows;
    };
  };
  return computeLeaderboard(makePass, 1, 1_780_000_001_000, () => []);
};

describe('pool leaderboard metadata', () => {
  it('carries an unambiguous venue and market beside the stable pool key', async () => {
    const res = await aggregate([fill('a', 'ETH/USDC'), fill('b', 'ETH/USDC')]);
    expect(res.groups.pool['0'][0]).toMatchObject({
      key: 'lob 0xAC652E',
      venueId: 'hanji',
      market: 'ETH/USDC',
    });
  });

  it('omits market when one pool key serves multiple markets', async () => {
    const res = await aggregate([fill('a', 'ETH/USDC'), fill('b', 'MON/USDC')]);
    expect(res.groups.pool['0'][0]).toMatchObject({ key: 'lob 0xAC652E', venueId: 'hanji' });
    expect(res.groups.pool['0'][0].market).toBeUndefined();
  });
});
