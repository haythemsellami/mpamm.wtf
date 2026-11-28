import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attributionTables } from '../attribution-golden.js';

describe('the Rust service reads these attribution tables', () => {
  it('service/crates/registry/attribution.json is current (npm -w server run attribution:golden)', () => {
    const file = fileURLToPath(new URL('../../../service/crates/registry/attribution.json', import.meta.url));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(attributionTables());
  });
});
