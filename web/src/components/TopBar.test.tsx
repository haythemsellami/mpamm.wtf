// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
const { dashboard } = vi.hoisted(() => ({ dashboard: { tab: 'exec', quotes: { block: 101, monUsd: 1, ts: 0 },
  state: { block: 99, monUsd: 1, source: 'sim' }, conn: 'live', theme: 'dark', toggleTheme: () => {}, set: () => {} } }));
vi.mock('../store', () => ({ useDashboard: () => dashboard }));
vi.mock('../lib/viewport', () => ({ useViewport: () => ({ mobile: false, tablet: false }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); dashboard.tab = 'exec'; dashboard.quotes = { block: 101, monUsd: 1, ts: Date.now() };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
it('advances with quotes while the slower state snapshot remains unchanged, and ages a stalled frame', async () => {
  await act(async () => root.render(<TopBar />));
  expect(container.querySelector('[data-quote-block]')?.textContent).toBe('101');
  await act(async () => vi.advanceTimersByTimeAsync(300));
  dashboard.quotes = { ...dashboard.quotes, block: 102, ts: Date.now() };
  await act(async () => root.render(<TopBar />));
  expect(container.querySelector('[data-quote-block]')?.textContent).toBe('102');
  await act(async () => vi.advanceTimersByTimeAsync(1_500));
  expect(container.textContent).toContain('STALE');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('no new block for 1s · last block 102');
  expect(container.querySelector('[data-commit-state]')).toBeNull();
  dashboard.quotes = { ...dashboard.quotes, block: 103, ts: Date.now() };
  await act(async () => root.render(<TopBar />));
  expect(container.textContent).not.toContain('STALE');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[data-commit-state]')?.getAttribute('data-commit-state')).toBe('proposed');
});

it('stalls after 1 s by this browser\'s clock, whatever the server stamped', async () => {
  // A server clock far ahead of the viewer's must not hide a stall, nor fake one.
  dashboard.quotes = { block: 200, monUsd: 1, ts: Date.now() + 3_600_000 };
  await act(async () => root.render(<TopBar />));
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(container.textContent).not.toContain('STALE');
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(container.textContent).toContain('STALE');
});
it('uses the state block on pages that do not subscribe to quotes', async () => {
  dashboard.tab = 'volume'; await act(async () => root.render(<TopBar />));
  expect(container.textContent).toContain('BLOCK 99');
  expect(container.querySelector('[data-quote-block]')).toBeNull();
});
