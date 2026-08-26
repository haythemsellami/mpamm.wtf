// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DepthSnapshot } from '@shared';
import { connectDepth } from './api';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close(): void { this.closed = true; }
  emit(data: string): void { this.onmessage?.(new MessageEvent('message', { data })); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe('connectDepth', () => {
  it('opens one market-scoped stream, validates events and closes cleanly', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onSnapshot = vi.fn();
    const dispose = connectDepth('MON/USDC', onSnapshot);
    const stream = FakeEventSource.instances[0];
    const snapshot = { market: 'MON/USDC', asOfBlock: 12, ts: 34, refMid: 1, venues: [] } satisfies DepthSnapshot;

    expect(stream.url).toBe('/api/depth/stream?market=MON%2FUSDC');
    stream.emit('{bad json');
    stream.emit(JSON.stringify({ ...snapshot, market: 'BTC/USDC' }));
    stream.emit(JSON.stringify(snapshot));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);

    dispose();
    stream.emit(JSON.stringify(snapshot));
    expect(stream.closed).toBe(true);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});
