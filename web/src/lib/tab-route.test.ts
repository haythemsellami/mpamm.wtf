import { describe, expect, it } from 'vitest';
import { pathForTab, tabFromPath, urlForTab } from './tab-route';

describe('tab routes', () => {
  it.each([
    ['/', 'exec'],
    ['/volume', 'volume'],
    ['/markouts', 'markouts'],
    ['/leaderboard', 'leaderboard'],
  ] as const)('maps %s to %s', (path, tab) => {
    expect(tabFromPath(path)).toBe(tab);
    expect(pathForTab(tab)).toBe(path);
  });

  it('normalizes trailing slashes and rejects unknown paths', () => {
    expect(tabFromPath('/volume/')).toBe('volume');
    expect(tabFromPath('/leaderboard///')).toBe('leaderboard');
    expect(tabFromPath('/unknown')).toBeNull();
  });

  it('preserves the current query and hash when building a tab URL', () => {
    expect(urlForTab('markouts', '?pair=MON%2FUSDC', '#outliers'))
      .toBe('/markouts?pair=MON%2FUSDC#outliers');
  });
});
