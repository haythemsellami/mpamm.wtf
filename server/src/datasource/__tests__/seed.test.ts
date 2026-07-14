import { describe, expect, it } from 'vitest';
import { seedSources } from '../seed.js';
import type { LogSource, VenueAdapter } from '../../venues/adapter.js';

/**
 * Regression contract for the seed gate: a fill-landing venue whose adapter
 * exposes NO sources right now (pools quarantined at boot, or discovery not
 * run yet) must be DEFERRED — never treated as "done", which would permanently
 * skip its venue-lifetime history seed. Only a venue that cannot land fills by
 * design (quote-only baseline) may be skipped for good.
 */

function adapter(role: 'venue' | 'baseline', logSources: () => LogSource[]): VenueAdapter {
  return {
    venues: () => [{
      id: 'fake', name: 'Fake', color: { light: '#000000', dark: '#ffffff' },
      kind: 'amm', role,
    }],
    backfillFromUtc: '2026-04-30',
    discover: async () => undefined,
    quote: async () => [],
    logSources,
    decode: () => [],
  } as VenueAdapter;
}

const FILLS: LogSource = { key: 'swap', address: '0x0000000000000000000000000000000000000001', events: [], kind: 'fills' };
const STATE: LogSource = { key: 'state', address: '0x0000000000000000000000000000000000000001', events: [], kind: 'state' };

describe('seedSources', () => {
  it('defers while discovery has not run (logSources throws)', () => {
    const d = seedSources(adapter('venue', () => { throw new Error('Fake discovery unavailable'); }));
    expect(d).toEqual({ action: 'defer', reason: 'pools not discovered yet' });
  });

  it('DEFERS a fill-landing venue whose sources are empty (quarantined pools) — never done', () => {
    const d = seedSources(adapter('venue', () => []));
    expect(d.action).toBe('defer');
  });

  it('defers a fill-landing venue exposing only non-fill sources', () => {
    const d = seedSources(adapter('venue', () => [STATE]));
    expect(d.action).toBe('defer');
  });

  it('skips (permanently) a quote-only baseline with no fill sources', () => {
    expect(seedSources(adapter('baseline', () => []))).toEqual({ action: 'skip' });
  });

  it('runs with the full and fills-only source lists when fills exist', () => {
    const d = seedSources(adapter('venue', () => [FILLS, STATE]));
    expect(d).toEqual({ action: 'run', all: [FILLS, STATE], fills: [FILLS] });
  });

  it('treats a source without an explicit kind as fills', () => {
    const bare = { key: 'swap', address: FILLS.address, events: [] } as LogSource;
    const d = seedSources(adapter('venue', () => [bare]));
    expect(d.action).toBe('run');
  });

  it('recovers: quarantined at boot, seedable once the pools re-validate', () => {
    let sources: LogSource[] = [];
    const a = adapter('venue', () => sources);
    expect(seedSources(a).action).toBe('defer');   // boot: all pools quarantined
    sources = [FILLS, STATE];                       // pools self-heal
    const d = seedSources(a);
    expect(d.action).toBe('run');                   // next pass seeds
  });
});
