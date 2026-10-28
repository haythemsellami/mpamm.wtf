// ThogAMM's quote-update burn is its keeper's pushes to the proxy. The
// 2026-10-22 upgrade (impl 0x709ba375…) replaced the two named push events with
// MakerPageUpdated, and a series keyed only on the old pair matched nothing
// from then on: the gas chart dropped ThogAMM after 10-22. These pin both
// generations of the push event, two real post-upgrade pushes, and the
// one-time rebuild.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeEventLog, toEventSelector } from 'viem';
import { createThogammAdapter, THOGAMM_ADDRESS } from '../thogamm.js';

/** Real pushes, one per keeper path (fixtures/thogamm-params-pushed.json). */
const FX = JSON.parse(readFileSync(new URL('./fixtures/thogamm-params-pushed.json', import.meta.url), 'utf8'));
const PROXY = THOGAMM_ADDRESS.toLowerCase();

/** every topic0 the declared sources match — named events by selector, raw ones as given */
function sourceTopics(): Set<string> {
  const out = new Set<string>();
  for (const s of createThogammAdapter().gasSources?.() ?? []) {
    if (s.mode !== 'logs') continue;
    if (s.topic0) out.add(s.topic0);
    for (const e of s.events ?? []) out.add(toEventSelector(e as any));
  }
  return out;
}

describe('thogamm quote-update gas', () => {
  const sources = createThogammAdapter().gasSources?.() ?? [];

  it('tracks only the proxy, in logs mode', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.mode).toBe('logs');
      expect(String(s.address).toLowerCase()).toBe(PROXY);
    }
  });

  it('keeps the pre-upgrade events, so a rebuild still reads 2026-10-22 before 22:21 UTC', () => {
    const topics = sourceTopics();
    expect(topics.has('0x4297642da60dca19aa6bb6cee38e85c2c07cb520fe9513b94877a68ed0a61962')).toBe(true); // MakerPricesPushed
    expect(topics.has('0x48557a4086bd92501827d61122791730229612ecfc969f5a6c7bd857602db263')).toBe(true); // MakerRiskParamsPushed
  });

  it('matches both post-upgrade keeper paths with exactly one log each', () => {
    const topics = sourceTopics();
    expect(FX.pushes.map((p: any) => p.selector)).toEqual(['0x59558d29', '0x4cb2db39']);
    for (const p of FX.pushes) {
      expect(p.to).toBe(PROXY);
      expect(p.status).toBe('success');
      const hits = p.logs.filter((l: any) => l.address === PROXY && topics.has(l.topics[0]));
      expect(hits).toHaveLength(1);
      const abi = sources.flatMap((s) => s.mode === 'logs' ? s.events ?? [] : []);
      const decoded = decodeEventLog({ abi, data: hits[0].data, topics: hits[0].topics, strict: true }) as any;
      expect(decoded.eventName).toBe('MakerPageUpdated');
      expect(decoded.args.lane).toBe(Number(BigInt(hits[0].topics[1])));
    }
    // the indexed word is the push kind: 1 prices, 2 risk params
    expect(FX.pushes.map((p: any) => BigInt(p.logs[0].topics[1]))).toEqual([1n, 2n]);
  });

  it('hand-checked cost at 112 gwei: 58,215 gas = 0.00652008 MON, 118,481 gas = 0.013269872 MON', () => {
    const mon = FX.pushes.map((p: any) => {
      expect(BigInt(p.gasUsed)).toBe(BigInt(p.gasLimit)); // Monad charges the full limit
      return Number(BigInt(p.gasUsed) * BigInt(p.effectiveGasPrice)) / 1e18;
    });
    expect(mon[0]).toBeCloseTo(0.00652008, 12);
    expect(mon[1]).toBeCloseTo(0.013269872, 12);
  });
});

describe('thogamm gas revision', () => {
  it('rebuilds once from the upgrade day; earlier days were counted correctly', () => {
    expect(createThogammAdapter().gasRevisions).toEqual([{ id: 'params-pushed-topic', from: '2026-10-22' }]);
  });
});
