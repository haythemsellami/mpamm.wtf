import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MARKETS, STREAM_PATH, LEADERBOARD_WINDOW_DAYS, type MarketsResponse, type MarketState, type StreamMessage, type StreamState } from '@shared';
import type { DataSource } from './datasource/index.js';
import { config } from './config.js';
import { venueMeta } from './venues/registry.js';

/** Unsent bytes a stream client may accumulate before we cut it. ~20 quote
 *  ticks of backlog — generous for a real browser on a slow link, reached only
 *  by a peer that has stopped draining. Counted BEFORE compression (ws buffers
 *  the payload while its deflate job is queued), so this stays a bound on the
 *  frames a peer is behind, not on the bytes finally put on the wire. */
export const MAX_BACKLOG_BYTES = 1_000_000;
/** Ping cadence; one unanswered round (≥ this long) terminates the client. */
export const HEARTBEAT_MS = 30_000;
const DEPTH_HEARTBEAT_MS = 15_000;

/**
 * WS compression. The stream is repetitive JSON — the ~47KB quote frame
 * deflates 6.0x and the state frame 4.6x — and NOTHING was compressing it:
 * Render's edge brotli's the REST routes but a WebSocket is an opaque upgrade
 * to it, and `ws` ships permessage-deflate off by default. That default cost
 * ~230KB/s per open tab (~20GB/day, ~$3/day of egress).
 *
 * `ws` disables it for a real reason — zlib on Node fragments memory under
 * concurrency — and this process has already been OOM-killed once (see the
 * broadcast loop). So this is tuned for BOUNDED memory, not maximum ratio:
 *
 * - no context takeover on EITHER side ⇒ zlib retains no per-connection
 *   sliding window between messages, so N idle clients cost O(1) instead of
 *   O(N × ~300KB). The ratios above were measured frame-standalone, i.e. under
 *   exactly this setting — giving up context takeover costs us nothing here,
 *   because each frame is a full snapshot rather than a delta against the last.
 * - `concurrencyLimit` caps simultaneous zlib jobs; excess work queues instead
 *   of allocating in parallel.
 * - `threshold` leaves small frames (fill/volume deltas, the lean state frame)
 *   uncompressed, where a deflate block costs more than it saves.
 *
 * level 6 measured 0.22ms per quote frame — at ~3.2 frames/s/client that is
 * single-digit ms of CPU per second even with tens of clients.
 */
export const PERMESSAGE_DEFLATE = {
  zlibDeflateOptions: { level: 6 },
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  concurrencyLimit: 10,
  threshold: 1024,
} as const;

/** The hello frame: everything the client needs to render, minus the
 *  maintainer-only `notes` buffer (~10KB the dashboard never reads — it is
 *  served by GET /api/markets, which the client fetches on connect anyway). */
export function helloFrame(state: MarketState): StreamState {
  const { notes: _notes, ...rest } = state;
  return rest;
}

/** Every state frame after the hello: also drops the venue registry, which is
 *  immutable for the life of the process. The client keeps the copy it got in
 *  the hello (and re-fetches it with the REST snapshot on every reconnect). */
export function tickFrame(state: StreamState): StreamState {
  const { venues: _venues, ...rest } = helloFrame(state as MarketState);
  return rest;
}

/** What to do with one stream client on a broadcast. Pure so the backpressure
 *  policy is unit-tested — a wrong 'cut' here would disconnect real users, and
 *  a missing one leaks the heap (see the OOM note on the broadcast loop). */
export function streamAction(readyState: number, bufferedAmount: number): 'send' | 'drop' | 'cut' {
  if (readyState !== WebSocket.OPEN) return 'drop';           // closing/closed — forget it
  return bufferedAmount > MAX_BACKLOG_BYTES ? 'cut' : 'send'; // hopeless vs healthy
}

type SseWriter = {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(chunk: string): unknown;
  destroy(): unknown;
};

/** A disconnect can race the destroyed check. Contain both that write failure
 *  and slow-client backlog to this response instead of the server process. */
export function trySseWrite(response: SseWriter, chunk: string): boolean {
  if (response.destroyed) return false;
  if (response.writableLength > MAX_BACKLOG_BYTES) {
    response.destroy();
    return false;
  }
  try {
    response.write(chunk);
    return true;
  } catch {
    response.destroy();
    return false;
  }
}

/**
 * Thin transport over a DataSource (docs/architecture.md: API + system shape): REST snapshots + a WS
 * stream. The frontend renders purely off these and never touches the chain,
 * subgraph, or CEX feeds directly.
 */
export function startServer(source: DataSource): Server {
  const app = express();
  app.use(cors());

  // HSTS (production only): once a browser has seen this over HTTPS, it forces
  // HTTPS for a year — including subdomains (www.*) — so there's no plain-http
  // hop to cache as "not secure". Guarded by NODE_ENV so it never pins localhost
  // in dev; TLS is terminated at Render's edge, which only serves us over HTTPS.
  // No `preload` directive — that's a separate, hard-to-reverse hstspreload.org opt-in.
  if (process.env.NODE_ENV === 'production') {
    app.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    const state = source.getState();
    res.json({ ok: true, source: source.mode, block: state.block, realtime: state.realtime });
  });

  app.get('/api/markets', (_req, res) => {
    const body: MarketsResponse = {
      state: source.getState(),
      quotes: source.getQuotes(),
      fills: source.getFills(),
      volume: source.getVolume(),
    };
    res.json(body);
  });

  // the venue registry (adapters + CEX reference) — id/name/color/kind/role.
  // The frontend also gets this inside /api/markets state.venues; this is a
  // standalone endpoint for external consumers.
  app.get('/api/venues', (_req, res) => res.json(venueMeta()));

  app.get('/api/quotes', (_req, res) => res.json(source.getQuotes()));
  // the last ~60s of real quote ticks for one (market, size) — seeds the
  // Execution chart on load / pair-switch so it never fabricates flat history.
  app.get('/api/quotes/history', (req, res) => {
    const market = typeof req.query.market === 'string' ? req.query.market : '';
    const size = positiveNumberParam(req.query.size);
    if (!market || size === undefined) return res.status(400).json({ error: 'market and size query params required' });
    res.json(source.quoteHistory(market, size));
  });
  // Depth computation is owned by an isolated worker. REST is a cache read only;
  // it can never open RPC work on this event loop.
  app.get('/api/depth', (req, res) => {
    const market = depthMarketParam(req.query.market);
    if (!market) return res.status(400).json({ error: 'market must be registered' });
    const publication = source.getDepth(market);
    if (!publication) return res.status(503).json({ error: 'depth warming' });
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/json').send(publication.json);
  });

  // One-way demand + updates are a natural SSE stream: the first viewer starts
  // the market in the worker, every other viewer shares it, and only completed
  // snapshots cross into this process. Pre-serialized payloads keep fanout cheap.
  app.get('/api/depth/stream', (req, res) => {
    const market = depthMarketParam(req.query.market);
    if (!market) return res.status(400).json({ error: 'market must be registered' });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    let unwatch = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unwatch();
    };
    const write = (chunk: string) => {
      if (!closed && !trySseWrite(res, chunk)) cleanup();
    };
    res.once('close', cleanup);
    res.once('error', cleanup);
    write('retry: 1000\n\n');
    if (closed) return;
    heartbeat = setInterval(() => {
      write(': keepalive\n\n');
    }, DEPTH_HEARTBEAT_MS);
    heartbeat.unref();
    unwatch = source.watchDepth(market, (publication) => write(`data: ${publication.json}\n\n`));
    if (closed) unwatch();
  });
  app.get('/api/fills', (req, res) => {
    // ?days=N → last N days (from the persisted store); ?limit caps the count.
    const days = positiveNumberParam(req.query.days);
    const sinceMs = days === undefined ? undefined : Date.now() - days * 86_400_000;
    const requestedLimit = positiveNumberParam(req.query.limit);
    const limit = Math.min(Math.floor(requestedLimit ?? 1000), 50_000);
    res.json(source.queryFills({ sinceMs, limit }));
  });
  // aggregated leaderboard/markout stats over the FULL window (?days=1|7|30) —
  // computed server-side next to the rows; shipping raw fills silently truncated
  // the wide windows at the fetch cap. TAKER-signed; clients derive MAKER.
  app.get('/api/leaderboard', async (req, res) => {
    const days = positiveNumberParam(req.query.days) ?? 1;
    if (!(LEADERBOARD_WINDOW_DAYS as readonly number[]).includes(days)) {
      return res.status(400).json({ error: `days must be one of ${LEADERBOARD_WINDOW_DAYS.join(', ')}` });
    }
    try { res.json(await source.leaderboard(days)); }
    catch { res.status(500).json({ error: 'aggregation failed' }); }
  });
  // QUOTE_UPDATE_BURN: per-venue quote-update gas per UTC day (MON + tx
  // counts), plus which venues are sampled estimates (UI shows ≈).
  app.get('/api/gas', (_req, res) => res.json(source.gasSeries()));

  app.get('/api/volume', (req, res) => {
    // honor ?from=&to= (YYYY-MM-DD, lexicographic). Both scope columns
    // (cloberVenue / cloberVault) are carried per row and the client selects, so
    // ?scope is accepted but informational (audit I7).
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    let days = source.getVolume();
    if (from) days = days.filter((d) => d.utcDay >= from);
    if (to) days = days.filter((d) => d.utcDay <= to);
    res.json(days);
  });

  // Production single-service: serve the built frontend same-origin (so the
  // relative /api + /stream URLs just work). Skipped in dev (Vite serves it).
  if (config.webDist && existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === STREAM_PATH) return next();
      res.sendFile(join(config.webDist, 'index.html'));
    });
    console.log(`[mpamm] serving frontend from ${config.webDist}`);
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: STREAM_PATH, perMessageDeflate: PERMESSAGE_DEFLATE });

  const clients = new Set<WebSocket>();
  // Clients that owe us a pong from the last heartbeat round.
  const awaitingPong = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    // hello with current state so a client can render before the next tick.
    // This is the ONLY frame carrying the venue registry (see StreamState).
    safeSend(ws, { ch: 'state', data: helloFrame(source.getState()) });
    safeSend(ws, { ch: 'quotes', data: source.getQuotes() });
    ws.on('pong', () => awaitingPong.delete(ws));
    ws.on('close', () => drop(ws));
    ws.on('error', () => drop(ws));
  });
  const drop = (ws: WebSocket) => { clients.delete(ws); awaitingPong.delete(ws); };
  const cut = (ws: WebSocket) => { drop(ws); try { ws.terminate(); } catch { /* already gone */ } };

  const onMessage = (m: StreamMessage) => {
    // Serialize ONCE for the whole fanout, and strip the state frame down to
    // what actually changes (see StreamState — this is the single biggest
    // egress win in the protocol).
    const payload = JSON.stringify(m.ch === 'state' ? { ch: 'state', data: tickFrame(m.data) } : m);
    for (const ws of clients) {
      // BACKPRESSURE: a stalled peer (sleeping laptop, backgrounded phone,
      // half-dead TCP) never closes, so every frame we push queues in OUR
      // heap — the quote tick alone is ~46KB at ~3/s, ~500MB per stalled
      // client per hour. That OOM-killed prod (heap 311MB after 18h uptime,
      // 2026-07-29). A live dashboard gains nothing from replaying a stale
      // backlog, so cut anyone who falls this far behind; their browser
      // reconnects and gets a fresh hello.
      const action = streamAction(ws.readyState, ws.bufferedAmount);
      if (action === 'drop') { drop(ws); continue; }
      if (action === 'cut') { cut(ws); continue; }
      ws.send(payload);
    }
  };
  source.on('message', onMessage);

  // HEARTBEAT: a peer that vanished without a close frame keeps readyState
  // OPEN forever, so it would otherwise sit in `clients` buffering for the
  // process lifetime. One missed pong round (≥30s) is enough to cut it.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (awaitingPong.has(ws)) { cut(ws); continue; }
      awaitingPong.add(ws);
      try { ws.ping(); } catch { cut(ws); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Fail cleanly on a listen error (e.g. another instance already on this port)
  // instead of crashing with an unhandled 'error' event.
  const onFatal = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[mpamm] API_PORT ${config.port} is already in use — another instance is running, or set API_PORT to a free port.`);
    } else {
      console.error('[mpamm] server error:', err.message);
    }
    process.exit(1);
  };
  httpServer.on('error', onFatal);
  wss.on('error', onFatal);

  httpServer.listen(config.port, () => {
    console.log(`[mpamm] ${source.mode} source · http://localhost:${config.port} · ws ${STREAM_PATH}`);
  });

  httpServer.on('close', () => { clearInterval(heartbeat); source.off('message', onMessage); });
  return httpServer;
}

function safeSend(ws: WebSocket, m: StreamMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function positiveNumberParam(v: unknown): number | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function depthMarketParam(v: unknown): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === 'string' && (MARKETS as readonly string[]).includes(raw) ? raw : undefined;
}
