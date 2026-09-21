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
  dashboard.quotes = { ...dashboard.quotes, block: 103, ts: Date.now() };
  await act(async () => root.render(<TopBar />));
  expect(container.textContent).not.toContain('STALE');
});
it('uses the state block on pages that do not subscribe to quotes', async () => {
  dashboard.tab = 'volume'; await act(async () => root.render(<TopBar />));
  expect(container.textContent).toContain('BLOCK 99');
  expect(container.querySelector('[data-quote-block]')).toBeNull();
});
