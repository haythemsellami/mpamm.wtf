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

/** BID_ASK_DEPTH: one demand-driven stream per visible market. EventSource
 *  reconnects by itself and the server immediately replays its last completed
 *  curve, so a transient worker/RPC failure leaves the last good curve visible. */
export function connectDepth(
  market: string,
  onSnapshot: (snapshot: DepthSnapshot) => void,
): () => void {
  let closed = false;
  const stream = new EventSource(`/api/depth/stream?market=${encodeURIComponent(market)}`);
  stream.onmessage = (event) => {
    if (closed) return;
    try {
      const snapshot = JSON.parse(event.data) as DepthSnapshot;
      if (snapshot.market === market) onSnapshot(snapshot);
    } catch { /* ignore a malformed event; the next complete curve replaces it */ }
  };
  return () => { closed = true; stream.close(); };
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

/** Reconnecting WS to the service stream. Returns a disposer. */
export function connectStream(
  onMsg: (m: StreamMessage) => void,
  onState: (s: 'live' | 'reconnecting') => void,
): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => onState('live');
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data) as StreamMessage); } catch { /* ignore */ } };
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
      if (closed) return;
      onState('reconnecting');
      timer = setTimeout(open, 1000);
    };
  };
  open();

  return () => { closed = true; if (timer) clearTimeout(timer); ws?.close(); };
}
