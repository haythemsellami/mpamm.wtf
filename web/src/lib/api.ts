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

/** BID_ASK_DEPTH: per-venue executable-spread curves over the $100 → $1M
 *  notional grid for one market. Polled on the quote tick rather than streamed
 *  — the server computes it on demand, so nobody pays for a panel nobody has
 *  open. */
export async function fetchDepth(market: string): Promise<DepthSnapshot> {
  const r = await fetch(`/api/depth?market=${encodeURIComponent(market)}`);
  if (!r.ok) throw new Error(`/api/depth ${r.status}`);
  return r.json();
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
