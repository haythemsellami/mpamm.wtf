// Writes every adapter's history-repair marker texts and first day of history
// to service/crates/history/tests/ts-specs.json, which the Rust planner's
// parity test checks its own definitions against (a migrated database adopts
// a repair only when the texts match). Run after adding a revision:
//   npm -w server run history:specs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/venues/registry.js';
import { revisionTargets } from '../src/datasource/live.js';

const out: Record<string, { fromUtc: string | null; specs: string[] }> = {};
for (const a of ADAPTERS) {
  const vid = a.venues()[0].id;
  out[vid] = {
    fromUtc: a.backfillFromUtc ?? null,
    specs: revisionTargets(vid, a.historyRevisions).map((t) => `${t.marker}=${t.spec}`),
  };
}
const file = fileURLToPath(new URL('../../service/crates/history/tests/ts-specs.json', import.meta.url));
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${file}`);
