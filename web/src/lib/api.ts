import type { MarketsResponse, StreamMessage, DepthSnapshot, Fill, QuoteSnapshot, LeaderboardResponse, GasResponse } from '@shared';

export async function fetchMarkets(): Promise<MarketsResponse> {
  const r = await fetch('/api/markets');
  if (!r.ok) throw new Error(`/api/markets ${r.status}`);
  return r.json();
}

/** The last ~60s of real quote ticks for one (market, size) — seeds the
 *  Execution chart so it shows real history instead of a flat pre-fill. */
export async function fetchQuoteHistory(market: string, size: number): Promise<QuoteSnapshot[]> {
  const r = await fetch(`/api/quotes/history?market=${encodeURIComponent(market)}&size=${size}`);
  if (!r.ok) throw new Error(`/api/quotes/history ${r.status}`);
  return r.json();
}

/** How long a tab must stay hidden before we suspend its live streams. Long
 *  enough that alt-tabbing to check something never thrashes the connection,
 *  short enough that a dashboard parked on a second monitor stops billing.
 *  Suspending pays for itself after ~1 minute hidden: a resume costs one REST
 *  resync (~0.6MB) against ~13MB/min of stream. */
export const HIDDEN_GRACE_MS = 60_000;

/**
 * A hidden tab renders nothing, so every byte streamed to it is pure egress —
 * and a propAMM dashboard is exactly the kind of page people leave open for
 * days. Both live streams (WS quotes, depth SSE) suspend once the tab has been
 * hidden for HIDDEN_GRACE_MS and reopen the moment it comes back; reopening
 * re-syncs from REST, which is the same path a dropped connection already took.
 *
 * `document.hidden` is false for a visible-but-unfocused window, so watching
 * the dashboard side-by-side with something else keeps streaming as it should.
 * Returns a disposer that removes the listener and cancels a pending suspend.
 */
export function whileVisible(suspend: () => void, resume: () => void): () => void {
  let grace: ReturnType<typeof setTimeout> | undefined;
  const onVisibilityChange = () => {
    if (grace) { clearTimeout(grace); grace = undefined; }
    if (document.hidden) grace = setTimeout(suspend, HIDDEN_GRACE_MS);
    else resume();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Seed from the CURRENT state, not just from future events: a tab opened in
  // the background (cmd-click, "open in new tab", session restore) is hidden
  // from load and fires no visibilitychange until it is first focused, so an
  // event-only gate would let exactly those tabs stream unwatched forever.
  // Only the suspend side is seeded — `resume` is the callers' reopen path and
  // there is nothing to reopen before the first suspend.
  if (document.hidden) grace = setTimeout(suspend, HIDDEN_GRACE_MS);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (grace) clearTimeout(grace);
  };
}

/** BID_ASK_DEPTH: one demand-driven stream per visible market. EventSource
 *  reconnects by itself and the server immediately replays its last completed
 *  curve, so a transient worker/RPC failure leaves the last good curve visible.
 *  That same replay is what makes suspending a hidden tab safe — resuming
 *  repaints the current curve rather than a stale one. */
export function connectDepth(
  market: string,
  onSnapshot: (snapshot: DepthSnapshot) => void,
): () => void {
  let closed = false;
  let suspended = false;
  let stream: EventSource | undefined;

  const open = () => {
    if (closed || suspended) return;
    stream = new EventSource(`/api/depth/stream?market=${encodeURIComponent(market)}`);
    stream.onmessage = (event) => {
      if (closed) return;
      try {
        const snapshot = JSON.parse(event.data) as DepthSnapshot;
        if (snapshot.market === market) onSnapshot(snapshot);
      } catch { /* ignore a malformed event; the next complete curve replaces it */ }
    };
  };
  open();

  const stopGate = whileVisible(
    () => { suspended = true; stream?.close(); stream = undefined; },
    () => { if (!suspended) return; suspended = false; open(); },
  );

  return () => { closed = true; stopGate(); stream?.close(); };
}

/** Recent fills window (persisted) — feeds the live SWAP_TAPE. The leaderboard
 *  and outlier stats come pre-aggregated from /api/leaderboard instead (raw
 *  fills silently truncated the wide windows at any sane fetch cap). */
export async function fetchFills(days = 1, limit = 5000): Promise<Fill[]> {
  const r = await fetch(`/api/fills?days=${days}&limit=${limit}`);
  if (!r.ok) throw new Error(`/api/fills ${r.status}`);
  return r.json();
}

/** QUOTE_UPDATE_BURN: per-venue quote-update gas per UTC day (Volume tab). */
export async function fetchGas(): Promise<GasResponse> {
  const r = await fetch('/api/gas');
  if (!r.ok) throw new Error(`/api/gas ${r.status}`);
  return r.json();
}

/** Server-side aggregated leaderboard/markout stats over the FULL window. */
export async function fetchLeaderboard(days: number): Promise<LeaderboardResponse> {
  const r = await fetch(`/api/leaderboard?days=${days}`);
  if (!r.ok) throw new Error(`/api/leaderboard ${r.status}`);
  return r.json();
}

/** Reconnecting WS to the service stream, suspended while the tab is hidden
 *  (see whileVisible). Returns a disposer. */
export function connectStream(
  onMsg: (m: StreamMessage) => void,
  onState: (s: 'live' | 'reconnecting') => void,
): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let suspended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`;

  const open = () => {
    if (closed || suspended) return;
    ws = new WebSocket(url);
    ws.onopen = () => onState('live');
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data) as StreamMessage); } catch { /* ignore */ } };
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
      // A suspend closed this on purpose — do NOT schedule a reconnect, or the
      // hidden tab would immediately reopen the stream it just gave up.
      if (closed || suspended) return;
      onState('reconnecting');
      timer = setTimeout(open, 1000);
    };
  };
  open();

  const stopGate = whileVisible(
    () => {
      suspended = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      // Report the stream as down BEFORE closing: the store keys its post-drop
      // resync off this, so coming back re-fetches the snapshot and replays the
      // fills we missed — the same healing path a real disconnect takes.
      onState('reconnecting');
      ws?.close();
    },
    () => { if (!suspended) return; suspended = false; open(); },
  );

  return () => { closed = true; stopGate(); if (timer) clearTimeout(timer); ws?.close(); };
}
