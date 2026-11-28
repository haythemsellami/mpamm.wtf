import { KNOWN_MEV, KNOWN_MEV_OPERATORS, KNOWN_ROUTERS } from './attribution.js';

/** The attribution tables as the Rust service reads them (address → brand,
 *  sorted by address so the file diffs cleanly). */
export function attributionTables() {
  const sorted = (m: ReadonlyMap<string, string>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { routers: sorted(KNOWN_ROUTERS), mev: sorted(KNOWN_MEV), operators: sorted(KNOWN_MEV_OPERATORS) };
}
