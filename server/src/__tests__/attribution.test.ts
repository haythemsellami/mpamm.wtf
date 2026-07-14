import { describe, expect, it } from 'vitest';
import { FillAttributor, KNOWN_MEV, KNOWN_ROUTERS } from '../attribution.js';
import type { Fill } from '@shared';
import type { VenueAdapter } from '../venues/adapter.js';

/**
 * The attribution contract: only UNKNOWN fills are touched; tx.to against the
 * venue's entryPoints proves DIRECT (or the venue's own router brand), the
 * global registry brands aggregators, everything else stays honest UNKNOWN.
 * A lookup failure changes NOTHING, and one tx is fetched exactly once.
 */

const POOL = '0x00000000000000000000000000000000000000aa';
const VENUE_ROUTER = '0x00000000000000000000000000000000000000bb';
const RELAY = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f'; // in KNOWN_ROUTERS
const BOT = '0x00000000000000000000000000000000000000cc';
const TAKER = '0x1111111111111111111111111111111111111111';

function fakeAdapter(): VenueAdapter {
  return {
    venues: () => [{ id: 'fake', name: 'Fake', color: { light: '#000', dark: '#fff' }, kind: 'amm', role: 'venue' }],
    discover: async () => undefined,
    logSources: () => [],
    decode: () => [],
    entryPoints: () => [{ address: POOL }, { address: VENUE_ROUTER, router: 'Fake' }],
  } as VenueAdapter;
}

function fill(txHash: string, category: Fill['category'] = 'UNKNOWN', venueId = 'fake'): Fill {
  return {
    id: `f-${txHash}`, venueId, market: 'MON/USDC', side: 'buy', category,
    usd: 100, baseAmount: 1, execPx: 100, txHash, to: '0xdead…beef', pool: 'p',
    blockNumber: 1, ts: 1, markoutsBps: [null, null, null, null, null],
  };
}

function clientFor(routes: Record<string, string>, callLog: string[] = []) {
  return {
    getTransaction: async ({ hash }: { hash: string }) => {
      callLog.push(hash);
      const to = routes[hash];
      if (to === 'FAIL') throw new Error('rpc down');
      return { to, from: TAKER } as any;
    },
  };
}

describe('FillAttributor', () => {
  it('labels DIRECT when tx.to is the venue itself, and rewrites `to` to the initiator', async () => {
    const a = new FillAttributor(clientFor({ '0x1': POOL }) as any, [fakeAdapter()]);
    const f = fill('0x1');
    await a.attribute([f]);
    expect(f.category).toBe('DIRECT');
    expect(f.router).toBeUndefined();
    expect(f.to).toContain(TAKER.slice(2, 6));
  });

  it("labels the venue's own periphery with the venue brand", async () => {
    const a = new FillAttributor(clientFor({ '0x2': VENUE_ROUTER }) as any, [fakeAdapter()]);
    const f = fill('0x2');
    await a.attribute([f]);
    expect(f.category).toBe('ROUTER');
    expect(f.router).toBe('Fake');
  });

  it('brands known aggregators from the global registry', async () => {
    const a = new FillAttributor(clientFor({ '0x3': RELAY }) as any, [fakeAdapter()]);
    const f = fill('0x3');
    await a.attribute([f]);
    expect(f.category).toBe('ROUTER');
    expect(f.router).toBe('Relay');
  });

  it('classifies auction/bundle infrastructure as MEV, not ROUTER', async () => {
    const FASTLANE = '0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58'; // in KNOWN_MEV
    const a = new FillAttributor(clientFor({ '0x3m': FASTLANE }) as any, [fakeAdapter()]);
    const f = fill('0x3m');
    await a.attribute([f]);
    expect(f.category).toBe('MEV');
    expect(f.router).toBe('FastLane');
    expect(f.to).toContain(TAKER.slice(2, 6));
  });

  it('leaves unidentified intermediaries UNKNOWN (but still shows the real initiator)', async () => {
    const a = new FillAttributor(clientFor({ '0x4': BOT }) as any, [fakeAdapter()]);
    const f = fill('0x4');
    await a.attribute([f]);
    expect(f.category).toBe('UNKNOWN');
    expect(f.router).toBeUndefined();
    expect(f.to).toContain(TAKER.slice(2, 6));
  });

  it('never touches fills the adapter already attributed', async () => {
    const calls: string[] = [];
    const a = new FillAttributor(clientFor({ '0x5': RELAY }, calls) as any, [fakeAdapter()]);
    const f = fill('0x5', 'DIRECT');
    await a.attribute([f]);
    expect(f.category).toBe('DIRECT');
    expect(f.to).toBe('0xdead…beef');
    expect(calls).toHaveLength(0);
  });

  it('a lookup failure leaves the fill exactly as emitted, and never throws', async () => {
    const a = new FillAttributor(clientFor({ '0x6': 'FAIL' }) as any, [fakeAdapter()]);
    const f = fill('0x6');
    await a.attribute([f]);
    expect(f.category).toBe('UNKNOWN');
    expect(f.to).toBe('0xdead…beef');
  });

  it('fetches one tx once across fills and passes (cache)', async () => {
    const calls: string[] = [];
    const a = new FillAttributor(clientFor({ '0x7': RELAY }, calls) as any, [fakeAdapter()]);
    await a.attribute([fill('0x7'), fill('0x7')]); // multi-fill tx
    await a.attribute([fill('0x7')]);              // later pass, same tx
    expect(calls).toHaveLength(1);
  });

  it('an adapter without entryPoints still gets registry brands', async () => {
    const bare = { ...fakeAdapter(), entryPoints: undefined } as VenueAdapter;
    const a = new FillAttributor(clientFor({ '0x8': RELAY }) as any, [bare]);
    const f = fill('0x8');
    await a.attribute([f]);
    expect(f.router).toBe('Relay');
  });

  it('registry addresses are lowercased (lookup is case-insensitive on tx.to)', () => {
    for (const k of KNOWN_ROUTERS.keys()) expect(k).toBe(k.toLowerCase());
    for (const k of KNOWN_MEV.keys()) expect(k).toBe(k.toLowerCase());
  });

  it('no address sits in both registries (a contract is a router XOR auction infra)', () => {
    for (const k of KNOWN_MEV.keys()) expect(KNOWN_ROUTERS.has(k)).toBe(false);
  });
});
