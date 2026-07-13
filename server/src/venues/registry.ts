import type { VenueMeta } from '@shared';
import type { VenueAdapter, ReferenceRegistry } from './adapter.js';
import { createPoeAdapter } from './poe.js';
import { createCloberVaultAdapter } from './clober.js';
import { createMetricAdapter } from './metric.js';
import { createHanjiAdapter } from './hanji.js';
import { createLunarbaseAdapter } from './lunarbase.js';
import { createUniswapAdapter } from './uniswap.js';
import { createReferenceRegistry } from './reference.js';

/**
 * The venue registry — the ONE place venues are wired in.
 *
 * This dashboard is dedicated to propAMM-style venues (oracle/MM-priced), not
 * passive curve DEXes or raw CLOBs. To plug in a protocol: drop an adapter file
 * next to poe.ts / metric.ts, then add one line to ADAPTERS below. Nothing else
 * in the core changes — the indexer, DB, API and frontend are all venue-agnostic
 * and read everything (name, color, output) from the adapter. See docs/adapters.md.
 */
const ALL_ADAPTERS: VenueAdapter[] = [
  createPoeAdapter(),
  createCloberVaultAdapter(),
  createMetricAdapter(),
  createHanjiAdapter(),
  createLunarbaseAdapter(),
  createUniswapAdapter(), // baseline (quote-only) — the standard-DEX band
];

/** VENUES=id[,id] runs a SUBSET of the registry — the adapter-development loop
 *  (docs/adapters.md): a contributor exercises just their venue against the
 *  chain without paying for everyone else's polling/backfills. References stay
 *  on regardless (the Execution comparison needs them). An unknown id fails
 *  loud — a typo must not silently run the full registry. */
function filterAdapters(all: VenueAdapter[]): VenueAdapter[] {
  const want = (process.env.VENUES ?? '').trim();
  if (!want) return all;
  const ids = new Set(want.split(',').map((s) => s.trim()).filter(Boolean));
  const known = new Set(all.flatMap((a) => a.venues().map((v) => v.id)));
  for (const id of ids) if (!known.has(id)) throw new Error(`VENUES: unknown venue id '${id}' (known: ${[...known].join(', ')})`);
  return all.filter((a) => a.venues().some((v) => ids.has(v.id)));
}

export const ADAPTERS: VenueAdapter[] = filterAdapters(ALL_ADAPTERS);

/** The CEX reference registry — the markout + Execution benchmarks, routed per
 *  base asset (Bybit for MON, Binance for BTC/ETH). At least one, all reference. */
export const REFERENCES: ReferenceRegistry = createReferenceRegistry();

/** Every venue's metadata (all adapters' venues + every CEX reference) — served to
 *  the frontend so it renders venues purely from this, with nothing hardcoded. */
export function venueMeta(): VenueMeta[] {
  return [...ADAPTERS.flatMap((a) => a.venues()), ...REFERENCES.metas()];
}

/** The set of ACTIVE venue ids (VENUES-filtered adapters + references). */
export function venueIds(): Set<string> {
  return new Set(venueMeta().map((v) => v.id));
}

/** Every venue id in the CODE registry, ignoring the VENUES runtime filter.
 *  DB reconciliation prunes against THIS set: a venue is "removed" only when
 *  it leaves the code, never because a dev loop filtered it out for a boot —
 *  pruning on the filtered set would silently delete the other venues'
 *  volume/fills/gas history. */
export function allVenueIds(): Set<string> {
  return new Set([...ALL_ADAPTERS.flatMap((a) => a.venues().map((v) => v.id)), ...REFERENCES.metas().map((v) => v.id)]);
}

/**
 * Fail loud on a misconfigured registry — a plugin whose id collides with
 * another's would silently MERGE two venues' data, and a malformed id would
 * break the DB key / frontend lookup. Call once at startup (live + sim).
 */
export function validateRegistry(): void {
  const metas = venueMeta();
  const adapterRefs = ADAPTERS.flatMap((a) => a.venues()).filter((v) => v.role === 'reference');
  if (adapterRefs.length) {
    throw new Error(`venue registry: adapter venue '${adapterRefs[0].id}' has role 'reference' — CEX benchmarks belong in the reference registry`);
  }
  // 'baseline' adapters are quote-only comparisons (e.g. Uniswap v4): they may
  // not produce fills — a fill would flow into volume/markout stores no UI reads.
  const baselineIds = new Set(ADAPTERS.flatMap((a) => a.venues()).filter((v) => v.role === 'baseline').map((v) => v.id));
  for (const a of ADAPTERS) {
    const ids = a.venues().map((v) => v.id);
    if (ids.some((id) => baselineIds.has(id)) && a.logSources().length > 0) {
      throw new Error(`venue registry: baseline venue '${ids[0]}' declares log sources — baselines are quote-only`);
    }
  }
  const seen = new Set<string>();
  for (const v of metas) {
    if (!v.id || !/^[a-z0-9][a-z0-9-]*$/.test(v.id)) {
      throw new Error(`venue registry: invalid id ${JSON.stringify(v.id)} for "${v.name}" — use lowercase kebab-case`);
    }
    if (seen.has(v.id)) throw new Error(`venue registry: duplicate venue id '${v.id}' — ids must be unique across every adapter + reference`);
    seen.add(v.id);
  }
  const refs = metas.filter((v) => v.role === 'reference');
  if (refs.length < 1) throw new Error('venue registry: expected at least one reference (CEX) venue, found 0');
}
