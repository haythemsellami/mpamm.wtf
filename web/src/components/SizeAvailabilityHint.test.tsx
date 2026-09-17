// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepthSnapshot, QuoteSnapshot, VenueMeta } from '@shared';
import { connectLiveDepth } from '../lib/api';
import { SizeAvailabilityHint } from './SizeAvailabilityHint';

vi.mock('../lib/api', () => ({ connectLiveDepth: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, receive: (depth: DepthSnapshot) => void;
const venue: VenueMeta = { id: 'venue', name: 'Venue', kind: 'amm', role: 'venue', color: { light: '#000', dark: '#fff' } };
const quotes: QuoteSnapshot = { block: 1, monUsd: 1, ts: 1, rows: [{ venueId: 'reference', market: 'MON/USDC', sizeUsd: 1000,
  bidPx: 1, askPx: 1, bidBps: 0, askBps: 0, spreadBps: 0, feeBps: 0, filledFull: true, ts: 1 }] };
const depth = (ts = Date.now()): DepthSnapshot => ({ market: 'MON/USDC', asOfBlock: 1, ts, refMid: 1,
  venues: [{ venueId: 'venue', maxNotional: 100, points: [{ notional: 100, bidBps: 1 }] }] });
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(connectLiveDepth).mockImplementation((_market, callback) => { receive = callback; return () => {}; });
  await act(async () => root.render(<SizeAvailabilityHint market="MON/USDC" size={1000} venues={[venue]} quotes={quotes} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('depth availability freshness', () => {
  it('expires without another quote, depth message or parent render', async () => {
    await act(async () => receive(depth(Date.now() - 4_000)));
    expect(container.textContent).toContain('Venue has no $1k quote');
    await act(async () => vi.advanceTimersByTimeAsync(1_001));
    expect(container.textContent).toBe('');
  });

  it('renews the expiry when a fresh depth snapshot arrives', async () => {
    await act(async () => receive(depth()));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    await act(async () => receive(depth()));
    await act(async () => vi.advanceTimersByTimeAsync(1_001));
    expect(container.textContent).toContain('Venue has no $1k quote');
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(container.textContent).toBe('');
  });
});
