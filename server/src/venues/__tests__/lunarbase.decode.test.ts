import { describe, expect, it } from 'vitest';
import {
  LUNARBASE_POOLS,
  applyLunarbaseStateLogs,
  decodeLunarbaseSwap,
  lunarbaseQuoteDirection,
  quoteLunarbaseLeg,
  type LunarbaseCachedPool,
} from '../lunarbase.js';

/**
 * Real Monad SwapExecuted fixtures covering both MON swap directions.
 * Expected amounts are independently scaled from raw event integers; no RPC is
 * used in tests. `recipient` is not the caller and cannot prove attribution.
 */

const TS = 1_783_679_000_000;
const [MON_POOL] = LUNARBASE_POOLS;

const MON_SELL = {
  address: MON_POOL.pool.toLowerCase(),
  args: {
    recipient: '0xfb78Fcae443eB423b59B8C186518c5dF94416344',
    xToY: true,
    dx: 9_923_973_000_000_000_000_000n,
    dy: 225_999_389n,
    fee: 31_566n,
  },
  blockNumber: 86_807_396n,
  transactionHash: '0x75879d7d4fb3fc6380e1ca16404765853d4d693adaebb0d1f7d5e524daad342c',
  logIndex: 102,
};

const MON_BUY = {
  address: MON_POOL.pool.toLowerCase(),
  args: {
    recipient: '0xfb78Fcae443eB423b59B8C186518c5dF94416344',
    xToY: false,
    dx: 14_593_103_441_529_868_288_115n,
    dy: 328_865_790n,
    fee: 12_626_737_983_444_994_440n,
  },
  blockNumber: 86_798_698n,
  transactionHash: '0x5cbc98f4a7aa9abe704656a7dbce129bc189ecb611d97988666cc2af0b271338',
  logIndex: 17,
};

describe('decodeLunarbaseSwap (real Monad fixtures)', () => {
  it('decodes MON X→Y as a base sell with 18/6 decimals', () => {
    const fill = decodeLunarbaseSwap(MON_SELL, MON_POOL, TS)!;
    expect(fill.side).toBe('sell');
    expect(fill.market).toBe('MON/USDC');
    expect(fill.baseAmount).toBeCloseTo(9_923.973, 12);
    expect(fill.usd).toBeCloseTo(225.999389, 9);
    expect(fill.execPx).toBeCloseTo(0.022773075763104153, 15);
    expect(fill.id).toBe(`lunarbase-${MON_SELL.transactionHash}-102`);
  });

  it('decodes MON Y→X as a base buy', () => {
    const fill = decodeLunarbaseSwap(MON_BUY, MON_POOL, TS)!;
    expect(fill.side).toBe('buy');
    expect(fill.baseAmount).toBeCloseTo(14_593.103441529868, 9);
    expect(fill.usd).toBeCloseTo(328.86579, 9);
    expect(fill.execPx).toBeCloseTo(0.022535699230644482, 15);
    expect(fill.id).toBe(`lunarbase-${MON_BUY.transactionHash}-17`);
  });

  it('does not invent attribution from the recipient field', () => {
    const fill = decodeLunarbaseSwap(MON_SELL, MON_POOL, TS)!;
    expect(fill.category).toBe('UNKNOWN');
    expect(fill.to).toBe('0xfb78…6344');
    expect(fill.markoutsBps).toEqual([null, null, null, null, null]);
  });

  it('skips unknown pools and malformed logs locally', () => {
    expect(decodeLunarbaseSwap({ ...MON_SELL, address: '0x0000000000000000000000000000000000000001' }, MON_POOL, TS)).toBeNull();
    expect(decodeLunarbaseSwap({ ...MON_SELL, args: { xToY: true } }, MON_POOL, TS)).toBeNull();
  });
});

function cachedPool(): LunarbaseCachedPool {
  return {
    ...MON_POOL,
    baseDec: 0,
    stableDec: 0,
    snapshot: {
      blockNumber: 100n,
      implementation: '0x0000000000000000000000000000000000000010',
      anchorPrice: 1n << 96n,
      feeAskX24: 0,
      feeBidX24: 0,
      latestUpdateBlock: 100n,
      reserveX: 1_000_000n,
      reserveY: 1_000_000n,
      concentrationK: 4_000,
      blockDelay: 10n,
      paused: false,
      blacklistFeeMultiplier: 100n,
      whitelistProbe: true,
    },
    lastApplied: { blockNumber: 100n, logIndex: Number.MAX_SAFE_INTEGER },
    needsRediscovery: false,
  };
}

describe('Lunarbase pool quoter', () => {
  it('pins the call to the snapshot block and the whitelisted aggregator route', async () => {
    const requests: any[] = [];
    const leg = await quoteLunarbaseLeg({
      client: {
        readContract: async (request: any) => {
          requests.push(request);
          return [90n, 0n, 10n];
        },
      },
    } as any, cachedPool(), 'sell', 100n, 123n);

    expect(leg).toEqual({ px: 0.9, feeBps: 1_000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      functionName: 'quoteXToY',
      args: [100n],
      account: '0x0000000000000000000000000000000000000000',
      blockNumber: 123n,
    });
  });
});

describe('Lunarbase monotonic state cache', () => {
  it('applies an absolute Sync once without mutating the input', () => {
    const initial = cachedPool();
    const sync = {
      address: initial.pool,
      eventName: 'Sync',
      args: { reserveX: 1_000_000n, reserveY: 2_000_000n },
      blockNumber: 101n,
      logIndex: 2,
    };
    const once = applyLunarbaseStateLogs(new Map([[initial.pool.toLowerCase(), initial]]), [sync]);
    const updated = once.get(initial.pool.toLowerCase())!;
    expect(updated.snapshot.reserveY).toBe(2_000_000n);
    expect(initial.snapshot.reserveY).toBe(1_000_000n); // staged, then committed

    const twice = applyLunarbaseStateLogs(once, [sync]);
    expect(twice.get(initial.pool.toLowerCase())!.snapshot).toEqual(updated.snapshot);
  });

  it('never lets historical state logs roll a pinned snapshot backwards', () => {
    const initial = cachedPool();
    const oldSync = {
      address: initial.pool,
      eventName: 'Sync',
      args: { reserveX: 1n, reserveY: 1n },
      blockNumber: 99n,
      logIndex: 9,
    };
    const staged = applyLunarbaseStateLogs(new Map([[initial.pool.toLowerCase(), initial]]), [oldSync]);
    expect(staged.get(initial.pool.toLowerCase())!.snapshot.reserveX).toBe(1_000_000n);
  });

  it('sorts state events and invalidates the cache on an upgrade', () => {
    const initial = cachedPool();
    const logs = [
      { address: initial.pool, eventName: 'Upgraded', args: {}, blockNumber: 104n, logIndex: 4 },
      { address: initial.pool, eventName: 'Paused', args: {}, blockNumber: 103n, logIndex: 3 },
      {
        address: initial.pool,
        eventName: 'StateUpdated',
        args: { anchorPrice: (1n << 96n) + 7n, feeAskX24: 10, feeBidX24: 20 },
        blockNumber: 102n,
        logIndex: 2,
      },
    ];
    const staged = applyLunarbaseStateLogs(new Map([[initial.pool.toLowerCase(), initial]]), logs);
    const updated = staged.get(initial.pool.toLowerCase())!;
    expect(updated.snapshot.anchorPrice).toBe((1n << 96n) + 7n);
    expect(updated.snapshot.feeAskX24).toBe(10);
    expect(updated.snapshot.feeBidX24).toBe(20);
    expect(updated.snapshot.paused).toBe(true);
    expect(updated.needsRediscovery).toBe(true);
    expect(updated.lastApplied).toEqual({ blockNumber: 104n, logIndex: 4 });
  });
});

describe('Lunarbase production pool configuration', () => {
  it('lists only MON/USDC while cbBTC/USDC remains test-only', () => {
    expect(LUNARBASE_POOLS.map((pool) => pool.market)).toEqual(['MON/USDC']);
  });

  it('maps MON directions to the pool quoter', () => {
    expect(lunarbaseQuoteDirection(MON_POOL, 'sell')).toBe('quoteXToY');
    expect(lunarbaseQuoteDirection(MON_POOL, 'buy')).toBe('quoteYToX');
  });
});
