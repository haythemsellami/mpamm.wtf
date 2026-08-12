// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider, useDashboard, type Tab } from './store';

vi.mock('./lib/api', () => {
  const pending = () => new Promise<never>(() => {});
  return {
    fetchMarkets: vi.fn(pending),
    fetchFills: vi.fn(pending),
    fetchLeaderboard: vi.fn(pending),
    fetchGas: vi.fn(pending),
    fetchQuoteHistory: vi.fn(pending),
    connectStream: vi.fn(() => () => {}),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;

function Probe({ renders }: { renders?: Tab[] }) {
  const dashboard = useDashboard();
  renders?.push(dashboard.tab);
  return (
    <div>
      <output data-tab>{dashboard.tab}</output>
      <button type="button" data-select="leaderboard" onClick={() => dashboard.set('tab', 'leaderboard')}>leaderboard</button>
    </div>
  );
}

async function mount(renders?: Tab[]) {
  root = createRoot(container);
  await act(async () => {
    root!.render(<StrictMode><DashboardProvider><Probe renders={renders} /></DashboardProvider></StrictMode>);
  });
}

function selectedTab(): string | null {
  return container.querySelector('[data-tab]')?.textContent ?? null;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  document.body.replaceChildren();
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  vi.clearAllMocks();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('dashboard tab routing', () => {
  it('selects a direct deep link on the first render', async () => {
    window.history.replaceState(null, '', '/markouts?pair=MON%2FUSDC#tape');
    const renders: Tab[] = [];

    await mount(renders);

    expect(renders[0]).toBe('markouts');
    expect(selectedTab()).toBe('markouts');
  });

  it.each([
    ['/volume///?pair=MON%2FUSDC#chart', '/volume?pair=MON%2FUSDC#chart', 'volume'],
    ['/unknown?pair=MON%2FUSDC#chart', '/?pair=MON%2FUSDC#chart', 'exec'],
  ] as const)('canonicalizes %s without dropping the query or hash', async (input, expected, tab) => {
    window.history.replaceState({ source: 'test' }, '', input);
    const replace = vi.spyOn(window.history, 'replaceState');

    await mount();

    expect(selectedTab()).toBe(tab);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(expected);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith({ source: 'test' }, '', expected);
  });

  it('pushes a route when tab state changes', async () => {
    window.history.replaceState(null, '', '/?pair=MON%2FUSDC#tape');
    const push = vi.spyOn(window.history, 'pushState');
    await mount();

    await act(async () => {
      (container.querySelector('[data-select="leaderboard"]') as HTMLButtonElement).click();
    });

    expect(selectedTab()).toBe('leaderboard');
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(null, '', '/leaderboard?pair=MON%2FUSDC#tape');
  });

  it('restores tab state on popstate without pushing another route', async () => {
    window.history.replaceState(null, '', '/volume?pair=MON%2FUSDC#chart');
    const push = vi.spyOn(window.history, 'pushState');
    await mount();

    window.history.replaceState(null, '', '/markouts?pair=MON%2FUSDC#tape');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));

    expect(selectedTab()).toBe('markouts');
    expect(push).not.toHaveBeenCalled();
  });
});
