// Hanji redeploys its FastQuoter every week or two, and the burn series only
// spans a cutover if the new destination is listed. A missed generation is
// SILENT — no throw, no note; the venue keeps trading while QUOTE_UPDATE_BURN
// flatlines to null (gen3 went 11 days that way, gen5 three, gen6+gen7
// fourteen). These lock down the two ways the list goes wrong: a generation
// dropped, or a look-alike added.
import { describe, expect, it } from 'vitest';
import { createHanjiAdapter } from '../hanji.js';
import { classifyGasSourceChange, gasSourcesSignature } from '../../gas.js';

/** Every generation, oldest first, as verified on-chain: each pushes
 *  updatePrices(uint256) (sel 0xae7e8d81) and answers owner() with
 *  0xA24D2aF7B9d58579225800B32111D71fb34643C9. */
const GENERATIONS = [
  '0xd637b38f8436fc4974ce9236d65888a1bac64160', // gen0
  '0x04fdeac24e4e57364b4f22844106583d88f747d7', // gen1
  '0x48cba27861983367c3fb063877b144a628e2b48b', // gen2
  '0x91855e7930044a8f13f10b336abf551f1f58ac7e', // gen3
  '0xeae24c729ee1a38554037e4ad25ef1e3c9e30be0', // gen4
  '0x103de0b5226a2a6d8b918d8192dc23248825bb55', // gen5
  '0xbb3f3cb75f3a652a3ee47c5cacceef794874e046', // gen6
  '0xf5b5f7f8ef84419c030dfc44771734810ea36d70', // gen7
];

/** Same selector, own rotating fleet — but owner() is 0x6792e60a… and it ran
 *  CONCURRENTLY with gen1 (2026-07-13 → 07-15). A selector-only hunt surfaces
 *  it; counting it would inflate Hanji's burn with a third party's. */
const NOT_HANJI = '0xc1ff9fefdd86735bb14286caa796f72d90f4b0fc';

const destinations = () => {
  const sources = createHanjiAdapter().gasSources?.() ?? [];
  return sources.flatMap((s) => (Array.isArray(s.address) ? s.address : [s.address])).map((a) => a.toLowerCase());
};

describe('hanji FastQuoter generations', () => {
  it('tracks every generation, in one blocks-mode source', () => {
    const sources = createHanjiAdapter().gasSources?.() ?? [];
    // blocks mode is load-bearing: updates emit no logs, so there is no event
    // to enumerate them with.
    expect(sources.map((s) => s.mode)).toEqual(['blocks']);
    expect(destinations()).toEqual(GENERATIONS);
  });

  it('excludes the same-selector contract owned by someone else', () => {
    expect(destinations()).not.toContain(NOT_HANJI);
  });

  it('lists each destination once — a repeat silently changes the fingerprint', () => {
    const addrs = destinations();
    expect(new Set(addrs).size).toBe(addrs.length);
    for (const a of addrs) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe('adding a generation rebuilds the minimum', () => {
  const sigNow = gasSourcesSignature(createHanjiAdapter().gasSources?.() ?? []);

  it('is case-insensitive — gen1 is checksummed in the source, the rest are not', () => {
    // tailBlocks matches receipts on a lowercased set; if the signature kept
    // case, a re-checksummed entry would read as a source change and wipe
    // history for nothing.
    expect(sigNow).toBe([...GENERATIONS].sort().join(','));
  });

  it('appending is a PARTIAL rebuild — earlier days survive', () => {
    const newest = GENERATIONS[GENERATIONS.length - 1];
    const before = [...GENERATIONS].filter((a) => a !== GENERATIONS[0] && a !== newest).sort().join(',');
    const change = classifyGasSourceChange(before, sigNow);
    // pure addition ⇒ rebuild from the earliest ADDED contract's creation day
    // (gen0, 2026-06-26), which is after Hanji's 2026-06-05 anchor. Dropping
    // any listed generation would make this 'full' and re-scan the lifetime.
    expect(change.kind).toBe('partial');
    expect(change.added.sort()).toEqual([GENERATIONS[0], newest].sort());
  });

  it('re-running with the same list is a no-op', () => {
    expect(classifyGasSourceChange(sigNow, sigNow).kind).toBe('none');
  });
});
