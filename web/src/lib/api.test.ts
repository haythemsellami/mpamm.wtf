// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DepthSnapshot } from '@shared';
import { HIDDEN_GRACE_MS, connectDepth, connectStream } from './api';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close(): void { this.closed = true; }
  emit(data: string): void { this.onmessage?.(new MessageEvent('message', { data })); }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  close(): void { if (this.closed) return; this.closed = true; this.onclose?.(); }
  open(): void { this.onopen?.(); }
  emit(data: string): void { this.onmessage?.(new MessageEvent('message', { data })); }
}

/** Drive the Page Visibility API the way a browser does. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setHidden(false);
  FakeEventSource.instances = [];
  FakeWebSocket.instances = [];
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


// A dashboard people leave open for days was streaming ~230KB/s to tabs nobody
// was looking at — the single largest line on the Render bill (2026-09). These
// pin the suspend/resume contract: no bytes to a hidden tab, no thrash on a
// quick alt-tab, and a resume that heals through the SAME path a real drop uses.
describe('suspending a hidden tab', () => {
  it('closes the stream once hidden past the grace period, and not before', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onState = vi.fn();
    const dispose = connectStream(vi.fn(), onState);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(onState).toHaveBeenLastCalledWith('live');

    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1);
    expect(ws.closed).toBe(false);          // still inside the grace window
    vi.advanceTimersByTime(1);
    expect(ws.closed).toBe(true);
    // the store keys its resync off this, so a resume replays what we missed
    expect(onState).toHaveBeenLastCalledWith('reconnecting');

    dispose();
  });

  it('does not reconnect while the tab stays hidden', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const dispose = connectStream(vi.fn(), vi.fn());
    FakeWebSocket.instances[0].open();

    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    vi.advanceTimersByTime(10 * 60_000);    // ten minutes in the background

    // the reconnect-on-close path must not fight the suspend
    expect(FakeWebSocket.instances).toHaveLength(1);
    dispose();
  });

  it('reopens the moment the tab comes back', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onState = vi.fn();
    const dispose = connectStream(vi.fn(), onState);
    FakeWebSocket.instances[0].open();
    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);

    setHidden(false);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(onState).toHaveBeenLastCalledWith('live');

    dispose();
  });

  it('ignores a quick alt-tab', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const dispose = connectStream(vi.fn(), vi.fn());
    const ws = FakeWebSocket.instances[0];
    ws.open();

    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS / 2);
    setHidden(false);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2);

    expect(ws.closed).toBe(false);              // never dropped
    expect(FakeWebSocket.instances).toHaveLength(1);
    dispose();
  });

  it('still reconnects after a REAL drop while visible', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onState = vi.fn();
    const dispose = connectStream(vi.fn(), onState);
    FakeWebSocket.instances[0].open();

    FakeWebSocket.instances[0].close();          // the network, not us
    expect(onState).toHaveBeenLastCalledWith('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    dispose();
  });

  it('suspends the depth stream too, and replays on resume', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const onSnapshot = vi.fn();
    const dispose = connectDepth('MON/USDC', onSnapshot);
    expect(FakeEventSource.instances).toHaveLength(1);

    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    expect(FakeEventSource.instances[0].closed).toBe(true);

    setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(2);
    // the server replays its last completed curve on (re)connect, so the view
    // repaints with a current curve rather than the one it froze on.
    const snapshot = { market: 'MON/USDC', asOfBlock: 99, ts: 1, refMid: 1, venues: [] } satisfies DepthSnapshot;
    FakeEventSource.instances[1].emit(JSON.stringify(snapshot));
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);

    dispose();
  });

  it('stops watching visibility once disposed', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const dispose = connectStream(vi.fn(), vi.fn());
    FakeWebSocket.instances[0].open();
    dispose();

    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    setHidden(false);
    expect(FakeWebSocket.instances).toHaveLength(1);  // no zombie reconnect
  });
});
