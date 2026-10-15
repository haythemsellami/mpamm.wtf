// Capricorn's quote-update burn is its keeper's pushes to its own price feed.
// The feed is one hop behind the PricingEngine → OracleRegistry chain, and an
// earlier build stopped at that chain: both of its contracts receive no update
// txs, so the venue was declared not self-funded and the gas chart showed no
// Capricorn series at all. These pin the destination, its event and the cost
// of one real push.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCapricornAdapter } from '../capricorn.js';

/** A real push (fixtures/capricorn-feed-push.json). */
const FX = JSON.parse(readFileSync(new URL('./fixtures/capricorn-feed-push.json', import.meta.url), 'utf8'));
const FEED = '0x7ddf62c41e9b3fbfd5ac77ae7f387fd91487ba8a';

describe('capricorn quote-update gas', () => {
  const sources = createCapricornAdapter().gasSources?.() ?? [];

  it('tracks the push feed in logs mode, keyed by the push event topic', () => {
    expect(sources).toHaveLength(1);
    const [s] = sources;
    expect(s.mode).toBe('logs');
    expect(String(s.address).toLowerCase()).toBe(FEED);
    // unverified contract: only the hash is known, so the raw-topic path
    if (s.mode === 'logs') expect(s.topic0).toBe(FX.logs[0].topics[0]);
  });

  it('matches a real push: the feed emits exactly one log with that topic', () => {
    expect(FX.to).toBe(FEED);
    expect(FX.status).toBe('success');
    const hits = FX.logs.filter((l: any) => l.address === FEED && sources.some((s) => s.mode === 'logs' && l.topics[0] === s.topic0));
    expect(hits).toHaveLength(1);
  });

  it('hand-checked cost: 99,650 × 102 gwei = 0.0101643 MON per push (Monad charges the full limit)', () => {
    expect(BigInt(FX.gasUsed)).toBe(BigInt(FX.gasLimit));
    expect(Number(BigInt(FX.gasUsed) * BigInt(FX.effectiveGasPrice)) / 1e18).toBeCloseTo(0.0101643, 10);
  });
});

describe('capricorn gas revision', () => {
  it('rebuilds the lifetime once, after the scan that skipped chunks it could not price', () => {
    // no `from`: the skipped chunks span April–August, from the series anchor on
    expect(createCapricornAdapter().gasRevisions).toEqual([{ id: 'receipts-by-block' }]);
  });
});
