// Writes today's leaderboard and markout-curve answers over a synthetic window
// to service/crates/analytics/tests/golden.json, which the Rust aggregations'
// parity test checks itself against. Run after changing analytics.ts,
// markout-curves.ts, a helper they use in shared/src/index.ts, or the window
// in src/analytics-golden.ts:
//   npm -w server run analytics:golden
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyticsGolden } from '../src/analytics-golden.js';

const out = fileURLToPath(new URL('../../service/crates/analytics/tests/golden.json', import.meta.url));
writeFileSync(out, JSON.stringify(await analyticsGolden()) + '\n');
console.log(`wrote ${out}`);
