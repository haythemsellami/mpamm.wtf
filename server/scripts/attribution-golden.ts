// Writes today's attribution tables (KNOWN_ROUTERS, KNOWN_MEV,
// KNOWN_MEV_OPERATORS) to service/crates/registry/attribution.json, which the
// Rust attribution reads as its own tables: one source of truth until the
// switch-over. Run after editing server/src/attribution.ts:
//   npm -w server run attribution:golden
// (server/src/__tests__/attribution-golden.test.ts fails while it is stale.)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attributionTables } from '../src/attribution-golden.js';

const out = fileURLToPath(new URL('../../service/crates/registry/attribution.json', import.meta.url));
writeFileSync(out, JSON.stringify(attributionTables(), null, 1) + '\n');
console.log(`wrote ${out}`);
