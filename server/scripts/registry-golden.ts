// Writes today's registry helpers' answers to service/crates/registry/tests/golden.json,
// which the Rust registry's parity test checks itself against. Run after
// editing shared/registry.json or a helper in shared/src/index.ts:
//   npm -w server run registry:golden
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registryGolden } from '../src/registry-golden.js';

const out = fileURLToPath(new URL('../../service/crates/registry/tests/golden.json', import.meta.url));
writeFileSync(out, JSON.stringify(registryGolden()) + '\n');
console.log(`wrote ${out}`);
