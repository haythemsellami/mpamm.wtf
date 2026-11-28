import { describe, expect, it } from 'vitest';
import { FillAttributor, KNOWN_MEV, KNOWN_MEV_OPERATORS, KNOWN_ROUTERS } from '../attribution.js';
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

/** One representative address per brand added from the Monad flow registry
 *  (monad-crypto/protocols, code-checked on 143). The full set is registered
 *  by construction; its count is locked below. */
const FLOW_ROUTERS: ReadonlyArray<readonly [brand: string, entry: string]> = [
  ['0x', '0x031d28683ffc9936903a31670bc618b8bc9b65dd'],
  ['1inch', '0x111111125421ca6dc452d289314280a0f8842a65'],
  ['Across', '0xd2ecb3afe598b746f8123cae365a598da831a449'],
  ['Bitget', '0x3e95a025efc7f93bf4efcbea40297f97d421a274'],
  ['Bungee', '0x01d8a85adb82408e14bc242ed43fbad0ca2f94cb'],
  ['CoW Protocol', '0x9008d19f58aabd9ed0d60971565aa8510560ab41'],
  ['Dirol', '0x646462f4d0168a94fe1884c8ae82148a3618a18d'],
  ['Eisen', '0x787c474b8a86354d0f5f19fb599a5fc7662a265f'],
  ['Enso', '0xcfbaa9cfce952ca4f4069874ff1df8c05e37a3c7'],
  ['FastLane Atlas', '0x2da28fedc4643c787cb5c5e84fa6aadb596875e8'],
  ['Fibrous', '0x274602a953847d807231d2370072f5f4e4594b44'],
  ['Fly', '0x20f6ee51340adeed01a59b0e65cb3703f3dc860c'],
  ['GMGN', '0xc9ca80b5ea956afa98627963d1880033545d108e'],
  ['Garden', '0x5fa58e4e89c85b8d678ade970bd6afd4311af17e'],
  ['Kuru', '0xbddf3556701b7ecca5d69416cffd7f86d37e52b3'],
  ['KyberSwap', '0x8f10b468b06c6fd214b65f87778827f7d113f996'],
  ['LI.FI', '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37'],
  ['Mayan', '0x337685fdab40d39bd02028545a4ffa7d287cc3e2'],
  ['Monorail', '0xa68a7f0601effdc65c64d9c47ca1b18d96b4352c'],
  ['OKX', '0x6088d94c5a40cecd3ae2d4e0710ca687b91c61d0'],
  ['OpenOcean', '0x6352a56caadc4f1e25cd6c75970fa768a3304e64'],
  ['Orbiter', '0x70f6060fc8b01b56869feba8361df468f98c2900'],
  ['Rango', '0x69460570c93f9de5e2edbc3052bf10125f0ca22d'],
  ['Relay', '0x3ec130b627944cad9b2750300ecb0a695da522b6'],
  ['Rubic', '0x3335733c454805df6a77f825f266e136fb4a3333'],
  ['Squid', '0x073e81d92bd8b39562106819d12346240606f04a'],
  ['SushiSwap', '0xac4c6e212a361c968f1725b4d055b47e63f80b75'],
  ['Symbiosis', '0x292fc50e4eb66c3f6514b9e402dbc25961824d62'],
  ['Uniswap', '0x000000000ac008f7e07210cfb6648e40249232c2'],
  ['de1', '0x07749429d3d9047a966b28a489500325bac9f1b6'],
  ['deBridge', '0x43de2d77bf8027e25dbd179b491e8d64f38398aa'],
];

/** Every searcher executor added from the 7d census (2026-11-27), one brand
 *  each; exercised so a typo in any address fails here. */
const FLOW_SEARCHERS: ReadonlyArray<readonly [brand: string, entry: string]> = [
  ['Searcher 0x050f', '0x050fa056bf556c023915e65392e136e7630ed860'],
  ['Searcher 0x1b5e', '0x1b5e936dff9970057f2ba38bbdc5800e813634d7'],
  ['Searcher 0x2395', '0x2395034803fa2e78ec5c9ad107f20f989146bc0e'],
  ['Searcher 0x30e1', '0x30e179eff56cb405a476e963c642e6746204cf82'],
  ['Searcher 0x3c4b', '0x3c4b206510d04b0fe932dccb2de30ee0312b81d0'],
  ['Searcher 0x488d', '0x488dce3e3a087cec37ce1b8ff79e2dea91d831fb'],
  ['Searcher 0x4a25', '0x4a250d3db1aa30a061f75433769bbb6ebac17262'],
  ['Searcher 0x5188', '0x5188cf6c51b046d6778d85b58f407e77ee754034'],
  ['Searcher 0x532b', '0x532bb4886cbd96e17294b048dd56a499a4587705'],
  ['Searcher 0x54cc', '0x54cce99ab9c2290a0a3cb4a9a6218100f5fb1b23'],
  ['Searcher 0x5ac9', '0x5ac9bc14376bf2727c6211960cf3cec1e2f295bd'],
  ['Searcher 0x61f3', '0x61f37dc3b53a4b9bd121f9d727ca01d964dcd5ac'],
  ['Searcher 0x62c2', '0x62c2de45a39a8a4be53d0433518819e9306b12b0'],
  ['Searcher 0x6911', '0x69113d5f5456b141390f188553cc4a36b782a72f'],
  ['Searcher 0x7ca8', '0x7ca8f00499ade0e520fddf9d91254d0f9cd01bb2'],
  ['Searcher 0x890e', '0x890e810cfd67e71d0fec1497b66c7876c0c78bbf'],
  ['Searcher 0x8d4b', '0x8d4b514ce9cfa3cfebee95e8194b3f42d8fa2b98'],
  ['Searcher 0x936c', '0x936c442645242accaed3ffe0f203921876061cb3'],
  ['Searcher 0x9b8c', '0x9b8c84c6ddc3488d89913ab92130f76c5d3f736e'],
  ['Searcher 0xa1ae', '0xa1aebf28f592a2bac83e12eb7d8bc0684dfb993d'],
  ['Searcher 0xaf40', '0xaf400cc399b47a0d9cbe219e84fb377334678934'],
  ['Searcher 0xb078', '0xb07838cd5b17d0be026efc66d9735739a827c962'],
  ['Searcher 0xb61e', '0xb61e5b77cb96d93075d0779ea1e7c9f988d1490a'],
  ['Searcher 0xc44b', '0xc44bc3187cd5084bac87af0710ccb3e52041a70d'],
  ['Searcher 0xcacc', '0xcacc0490661882cf9cb0c60bfe52cf5d662a608f'],
  ['Searcher 0xd8de', '0xd8de03d6460ed4d700592d47a800626e003b29a9'],
  ['Searcher 0xdd8b', '0xdd8b12a1e5d0666ca86046f207a297883d4a417d'],
  ['Searcher 0xdee5', '0xdee5b434f36a7fa0198126e15577524f24ce9556'],
  ['Searcher 0xdf06', '0xdf06acde6339651625a15746b4ebd0f3083d180f'],
  ['Searcher 0xe014', '0xe01496b1741e97c14f1eccb2c62593b51fb7b740'],
  ['Searcher 0xfff2', '0xfff2debbf1f650d2204999d6652156a3af3f47fd'],
];

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

  it('brands a known searcher executor (Kubera) as MEV', async () => {
    const KUBERA = '0x415669455d93b755efe7f20ef6f1dbdce7f68f7d'; // in KNOWN_MEV
    const a = new FillAttributor(clientFor({ '0x3k': KUBERA }) as any, [fakeAdapter()]);
    const f = fill('0x3k');
    await a.attribute([f]);
    expect(f.category).toBe('MEV');
    expect(f.router).toBe('Kubera');
  });

  it('falls back to the OPERATOR wallet (tx.from) when tx.to is an unknown contract', async () => {
    const OPERATOR = '0x256efafed786d24163bedf15d583ea5dbdb4757c'; // in KNOWN_MEV_OPERATORS
    const client = {
      getTransaction: async () => ({ to: BOT, from: OPERATOR }) as any, // rotated executor
    };
    const a = new FillAttributor(client as any, [fakeAdapter()]);
    const f = fill('0x3o');
    await a.attribute([f]);
    expect(f.category).toBe('MEV');
    expect(f.router).toBe('Kubera');
  });

  it('a tx.to match always wins over the operator fallback', async () => {
    const OPERATOR = '0x256efafed786d24163bedf15d583ea5dbdb4757c';
    const FASTLANE = '0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58';
    const client = { getTransaction: async () => ({ to: FASTLANE, from: OPERATOR }) as any };
    const a = new FillAttributor(client as any, [fakeAdapter()]);
    const f = fill('0x3w');
    await a.attribute([f]);
    expect(f.router).toBe('FastLane'); // the wrapper entered through, not the wallet
  });

  it('labels ERC-4337 EntryPoint flow as routed user flow', async () => {
    const ENTRYPOINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
    const a = new FillAttributor(clientFor({ '0x3e': ENTRYPOINT }) as any, [fakeAdapter()]);
    const f = fill('0x3e');
    await a.attribute([f]);
    expect(f.category).toBe('ROUTER');
    expect(f.router).toBe('ERC-4337');
  });

  // Addresses from Moose's deployment manifest. Real Moose fills (e.g. tx
  // 0x5585a42d…, ThogAMM MON/USDT0) are user EOAs sending handleOps straight to
  // the entry point; a direct aggregator call must label the same way.
  it.each([
    ['MooseEntryPoint proxy', '0xbd267094d3b410b33f49e8f6ba8b106672746490'],
    ['MooseAggregator proxy', '0xd1b844a2443704bcb2f737a7434513437438b65e'],
  ])('labels Moose Trade flow entering via the %s as routed flow', async (_name, entry) => {
    const a = new FillAttributor(clientFor({ '0x3f': entry }) as any, [fakeAdapter()]);
    const f = fill('0x3f');
    await a.attribute([f]);
    expect(f.category).toBe('ROUTER');
    expect(f.router).toBe('Moose Trade');
    expect(f.to).toContain(TAKER.slice(2, 6)); // the user, not the Moose contract
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

  it('asks the given clients in order, and only falls to the next for a tx the first cannot find', async () => {
    // a gap-fill read from the archive pool: the hot node may have pruned the tx
    const archiveCalls: string[] = [], hotCalls: string[] = [];
    const archive = clientFor({ '0x9': POOL, '0xa': 'FAIL' }, archiveCalls);
    const hot = clientFor({ '0x9': RELAY, '0xa': RELAY }, hotCalls);
    const a = new FillAttributor(hot as any, [fakeAdapter()]);
    const found = fill('0x9'), pruned = fill('0xa');
    await a.attribute([found, pruned], [archive as any, hot as any]);
    expect(found.category).toBe('DIRECT');   // the archive's answer, not the hot client's
    expect(pruned.router).toBe('Relay');     // the archive failed twice, the hot client answered
    expect(archiveCalls).toEqual(['0x9', '0xa', '0xa']);
    expect(hotCalls).toEqual(['0xa']);
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
    for (const k of KNOWN_MEV_OPERATORS.keys()) expect(k).toBe(k.toLowerCase());
  });

  it('no address sits in both registries (a contract is a router XOR auction infra)', () => {
    for (const k of KNOWN_MEV.keys()) expect(KNOWN_ROUTERS.has(k)).toBe(false);
    for (const k of KNOWN_MEV_OPERATORS.keys()) {
      expect(KNOWN_ROUTERS.has(k)).toBe(false);
      expect(KNOWN_MEV.has(k)).toBe(false);
    }
  });

  // One case per brand added — representative address through the attributor.
  it.each(FLOW_ROUTERS)('brands newly-listed Monad router %s (%s)', async (brand, entry) => {
    const a = new FillAttributor(clientFor({ '0xr': entry }) as any, [fakeAdapter()]);
    const f = fill('0xr');
    await a.attribute([f]);
    expect(f.category).toBe('ROUTER');
    expect(f.router).toBe(brand);
    expect(f.to).toContain(TAKER.slice(2, 6));
  });

  it.each(FLOW_SEARCHERS)('brands newly-listed Monad searcher %s (%s) as MEV', async (brand, entry) => {
    const a = new FillAttributor(clientFor({ '0xs': entry }) as any, [fakeAdapter()]);
    const f = fill('0xs');
    await a.attribute([f]);
    expect(f.category).toBe('MEV');
    expect(f.router).toBe(brand);
  });

  it('registers the full vetted Monad flow set', () => {
    // 11 seed routers + 86 vetted routers/solvers; 5 seed MEV + 31 searcher executors
    expect(KNOWN_ROUTERS.size).toBe(97);
    expect(KNOWN_MEV.size).toBe(36);
    // every representative is on one of the two maps (disjointness is locked above)
    for (const [, entry] of [...FLOW_ROUTERS, ...FLOW_SEARCHERS]) {
      expect(KNOWN_ROUTERS.has(entry) || KNOWN_MEV.has(entry)).toBe(true);
    }
  });

  it('keeps out the two contracts the sources list but the chain contradicts', () => {
    // ThogAMM's proxy is also TAKERBOT's taker side: tx.to == proxy on another
    // venue's fill is the operator's own trade. 0xb995… is a user-wallet fleet.
    const THOGAMM = '0x80c74517bcc2d67ffe02d3ed886796272f647210';
    const WALLET_FLEET = '0xb995eadd54ffd519decc1e2ead64781245d474cd';
    for (const m of [KNOWN_ROUTERS, KNOWN_MEV, KNOWN_MEV_OPERATORS]) {
      expect(m.has(THOGAMM)).toBe(false);
      expect(m.has(WALLET_FLEET)).toBe(false);
    }
  });
});
