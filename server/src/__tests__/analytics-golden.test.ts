import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyticsGolden } from '../analytics-golden.js';

describe('analytics golden answers', () => {
  it('match the file the Rust aggregations are tested against', async () => {
    const file = JSON.parse(readFileSync(new URL('../../../service/crates/analytics/tests/golden.json', import.meta.url), 'utf8'));
    // Through JSON, as the file was written: −0 becomes 0 and undefined fields drop.
    const fresh = JSON.parse(JSON.stringify(await analyticsGolden()));
    // Stale? Run `npm -w server run analytics:golden` and commit the file.
    expect(file).toEqual(fresh);
  });
});
