import type { LogSource, VenueAdapter } from '../venues/adapter.js';

/**
 * Gate for the one-time history seeds (volume backfill, markout onboarding).
 *
 * The subtle case is an EMPTY source list from a discovered adapter: for a
 * fill-landing venue (role 'venue') that means its pools are quarantined RIGHT
 * NOW (paused / failed a behavioral gate mid-boot), not "this venue never has
 * fills" — stamping the done-flag there permanently skips the venue-lifetime
 * seed even though the pools self-heal minutes later. So: 'venue' + empty ⇒
 * DEFER (retried until sources appear); only a venue that cannot land fills by
 * design (quote-only baseline) ⇒ SKIP (callers stamp the done-flag once).
 */
export type SeedDecision =
  | { action: 'run'; all: LogSource[]; fills: LogSource[] }
  | { action: 'defer'; reason: string }
  | { action: 'skip' };

export function seedSources(a: VenueAdapter): SeedDecision {
  let all: LogSource[];
  try { all = a.logSources(); }
  catch { return { action: 'defer', reason: 'pools not discovered yet' }; }
  const fills = all.filter((s) => (s.kind ?? 'fills') === 'fills');
  if (!fills.length) {
    return a.venues()[0]?.role === 'venue'
      ? { action: 'defer', reason: 'no fill sources exposed (pools quarantined?)' }
      : { action: 'skip' };
  }
  return { action: 'run', all, fills };
}
