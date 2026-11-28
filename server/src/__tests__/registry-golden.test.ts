import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registryGolden } from '../registry-golden.js';

describe('registry golden answers', () => {
  it('match the file the Rust registry is tested against', () => {
    const file = JSON.parse(readFileSync(new URL('../../../service/crates/registry/tests/golden.json', import.meta.url), 'utf8'));
    // Stale? Run `npm -w server run registry:golden` and commit the file.
    expect(file).toEqual(registryGolden());
  });
});
