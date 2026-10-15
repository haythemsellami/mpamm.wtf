// Hanji redeploys its FastQuoter every week or two, and the burn series only
// spans a cutover if the new destination is listed. A missed generation is
// SILENT — no throw, no note; the venue keeps trading while QUOTE_UPDATE_BURN
// flatlines to null (gen3 went 11 days that way, gen5 three, gen6+gen7
// fourteen, gen8 eight). These lock down the two ways the list goes wrong: a
// generation dropped, or a look-alike added — plus the FastLane relay route
// and the concurrent XAUt0/USDC quoter, whose misses are just as silent.
import { describe, expect, it } from 'vitest';
import { createHanjiAdapter } from '../hanji.js';
import { readFileSync } from 'node:fs';
import { classifyGasSourceChange, gasSourcesSignature, relayedTxHashes } from '../../gas.js';

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
  '0x125f12a1938b97f11fdc35b1a5fb4d5217cda50b', // gen8 — first with fastLaneCall
];
const GEN8 = GENERATIONS[8];
/** Not a generation: Hanji's XAUt0/USDC book's own quoter, live beside gen8
 *  since 2026-09-21 (same owner, same fleet, same two push routes). */
const XAUT = '0x1fb37a1e6dc03a523bba106cb25e398e8608a010';
const HANDLER = '0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58';

/** Same selector, own rotating fleet — but owner() is 0x6792e60a… and it ran
 *  CONCURRENTLY with gen1 (2026-07-13 → 07-15). A selector-only hunt surfaces
 *  it; counting it would inflate Hanji's burn with a third party's. */
const NOT_HANJI = '0xc1ff9fefdd86735bb14286caa796f72d90f4b0fc';

const destinations = () => {
  const sources = createHanjiAdapter().gasSources?.() ?? [];
  return sources.flatMap((s) => (Array.isArray(s.address) ? s.address : [s.address])).map((a) => a.toLowerCase());
};

describe('hanji FastQuoter generations', () => {
  it('tracks every generation plus the XAUt0/USDC quoter, in blocks mode', () => {
    const sources = createHanjiAdapter().gasSources?.() ?? [];
    // blocks mode is load-bearing: updates emit no logs, so there is no event
    // to enumerate them with.
    expect(sources.every((s) => s.mode === 'blocks')).toBe(true);
    expect(destinations()).toEqual([...GENERATIONS, XAUT]);
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
  const RELAY_TOKEN = `${GEN8}@${HANDLER}:0x0c7abd22:5`;
  const XAUT_RELAY_TOKEN = `${XAUT}@${HANDLER}:0x0c7abd22:5`;
  /** what production fingerprinted before the XAUt quoter was listed */
  const SIG_BEFORE_XAUT = [...GENERATIONS, RELAY_TOKEN].sort().join(',');

  it('is case-insensitive — gen1 is checksummed in the source, the rest are not', () => {
    // tailBlocks matches receipts on a lowercased set; if the signature kept
    // case, a re-checksummed entry would read as a source change and wipe
    // history for nothing.
    expect(sigNow).toBe([...GENERATIONS, XAUT, RELAY_TOKEN, XAUT_RELAY_TOKEN].sort().join(','));
  });

  it('the gen8 + FastLane migration rebuilds from gen8 alone, not the lifetime', () => {
    // the deploy that added gen8 AND its relay route: both tokens name gen8,
    // so the rebuild is bounded by gen8's creation day (2026-09-21).
    const prev = GENERATIONS.slice(0, 8).sort().join(',');
    const atGen8 = SIG_BEFORE_XAUT;
    expect(classifyGasSourceChange(prev, atGen8)).toEqual({ kind: 'partial', added: [GEN8] });
  });

  it('adding the XAUt0/USDC quoter rebuilds from its own creation day, not the lifetime', () => {
    // its direct and relay tokens both name it, so the rebuild is bounded by
    // its creation (2026-09-21 18:16 UTC) — the days before keep their rows.
    expect(classifyGasSourceChange(SIG_BEFORE_XAUT, sigNow)).toEqual({ kind: 'partial', added: [XAUT] });
  });

  it('appending is a PARTIAL rebuild — earlier days survive', () => {
    const newest = GENERATIONS[GENERATIONS.length - 1];
    const before = [...GENERATIONS.filter((a) => a !== GENERATIONS[0] && a !== newest), XAUT, XAUT_RELAY_TOKEN].sort().join(',');
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

/** Real FastLane AuctionHandler txs (fixtures/hanji-fastlane.json, hanji-xaut-quoter.json). */
const FX = JSON.parse(readFileSync(new URL('./fixtures/hanji-fastlane.json', import.meta.url), 'utf8'));
const FXX = JSON.parse(readFileSync(new URL('./fixtures/hanji-xaut-quoter.json', import.meta.url), 'utf8'));

describe('hanji FastLane relay route', () => {
  const sources = createHanjiAdapter().gasSources?.() ?? [];
  const relaySources = sources.filter((s) => s.mode === 'blocks' && s.relays?.length);
  // the tracker's own normalisation (gas.ts tailVenue) — relays bind to their source's targets
  const relays = relaySources.flatMap((s) => (s.mode === 'blocks' ? s.relays ?? [] : []).map((r) => ({
    to: r.address.toLowerCase(), selector: r.selector.toLowerCase(), word: r.targetWord,
    targets: new Set((Array.isArray(s.address) ? s.address : [s.address]).map((a) => a.toLowerCase())),
  })));

  it('is scoped to gen8+ — gen0-7 bytecode has no fastLaneCall, so they can never be the searcher', () => {
    expect(relaySources).toHaveLength(1);
    expect((relaySources[0].address as string[]).map((a) => a.toLowerCase())).toEqual([GEN8, XAUT]);
  });

  it('counts the XAUt0/USDC quoter on both routes — relayed bids (reverted too) and direct pushes', () => {
    const hit = relayedTxHashes([FXX.xok, FXX.xrev, FXX.xdirect, FX.other], relays);
    expect([...hit].sort()).toEqual([FXX.xok.hash, FXX.xrev.hash].sort());
    expect(FXX.xrev.status).toBe('0x0');
    // a direct push is matched by tx.to — the tracker's target set is every
    // source's addresses (gas.ts tailVenue)
    expect(FXX.xdirect.to).toBe(XAUT);
    expect(destinations()).toContain(FXX.xdirect.to);
  });

  it('counts bids naming gen8 — including a REVERTED one, which is log-less but still pays the limit', () => {
    const hit = relayedTxHashes([FX.g8ok, FX.g8rev, FX.other, FX.direct], relays);
    expect([...hit].sort()).toEqual([FX.g8ok.hash, FX.g8rev.hash].sort());
    expect(FX.g8rev.status).toBe('0x0');
  });

  it("never counts another searcher's bid on the shared handler", () => {
    expect(FX.other.to).toBe(HANDLER);
    expect(relayedTxHashes([FX.other], relays).size).toBe(0);
  });

  it('hand-checked cost: 226,000 × 100.01 gwei = 0.0226 MON per routed push (~5× a direct one)', () => {
    const mon = (t: any) => Number(BigInt(t.gasUsed) * BigInt(t.effectiveGasPrice)) / 1e18;
    expect(mon(FX.g8ok)).toBeCloseTo(0.02260226, 8);
    expect(mon(FX.direct)).toBeCloseTo(0.00464175, 8);
  });
});
