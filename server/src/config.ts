import { SIZES_USD, HISTORY_START_UTC } from '@shared';

const env = process.env;

/** comma-separated env list → trimmed, non-empty entries. */
function list(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function num(key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export type SourcePref = 'sim' | 'live';

export const config = {
  // API_PORT (not PORT) so the backend never collides with a dev-tool/preview
  // manager that injects PORT for the frontend.
  port: num('API_PORT', 8787),
  /** When set, serve the built frontend (web/dist) from this path same-origin
   *  (production single-service). Unset in dev — Vite serves the frontend. */
  webDist: env.WEB_DIST ?? '',
  // Production default: live (real Monad RPC + CEX references). Set DATA_SOURCE=sim to
  // run the fully offline deterministic simulator instead.
  source: (env.DATA_SOURCE?.toLowerCase() === 'sim' ? 'sim' : 'live') as SourcePref,

  // ── RPC pools ───────────────────────────────────────────────────────────────
  // TWO pools, because no single Monad endpoint is good at both jobs.
  //
  //   HOT     quote loop + fills tail. The ONLY thing that matters is distance
  //           to the tip: a node seven blocks behind quotes 2.3s-old prices, and
  //           no amount of local tuning recovers that.
  //   ARCHIVE volume backfill, markout onboarding, gas passes, blockAtOrAfter.
  //           These binary-search from block 0 and replay months-old ranges, so
  //           lag is irrelevant and RETENTION is everything — and the tip-fresh
  //           fullnodes prune to ~1.7 days.
  //
  // They must be separate pools rather than one ordered list, because failover
  // cannot bridge them: a pruned block answers with a JSON-RPC error, and
  // chain/failover.ts deliberately never switches endpoints on those (a revert
  // or a range-cap probe proves the node is ALIVE). So a fullnode primary with
  // an archive backup does not degrade onto the archive — every deep cursor
  // holds forever while the endpoint that could serve it sits idle.
  rpcHttp: env.RPC_HTTP_URL ?? 'https://rpc.monad.xyz',
  /** Ordered failover RPCs behind the hot primary (comma-separated). Default:
   *  the public RPC, so every deployment survives a provider outage with zero
   *  config. Set to "" to opt out (single-endpoint behavior). RPC_BACKUP_URLS
   *  is the pre-split name, still honored so a live deploy keeps its backups
   *  through the rollout. */
  rpcBackups: list(env.RPC_HTTP_BACKUP_URLS ?? env.RPC_BACKUP_URLS ?? 'https://rpc.monad.xyz'),
  /** Deep-history primary. UNSET (the default) means the archive pool IS the hot
   *  pool — exactly the single-client behavior that predates the split, so an
   *  unconfigured deployment is unaffected. Set it only when the hot primary
   *  cannot serve venue-lifetime ranges (i.e. it is a pruning fullnode). */
  rpcArchive: env.RPC_ARCHIVE_URL ?? '',
  /** Ordered failover RPCs behind the archive primary. Default: the public RPC,
   *  which serves headers/logs/receipts back to block 0 (its ~100-block getLogs
   *  cap is absorbed by getLogsChunked's shrink). Ignored — and rejected at
   *  boot — when RPC_ARCHIVE_URL is unset. */
  rpcArchiveBackups: list(env.RPC_ARCHIVE_BACKUP_URLS ?? 'https://rpc.monad.xyz'),

  bybitRest: env.BYBIT_REST_URL ?? 'https://api.bybit.com',
  bybitWs: env.BYBIT_WS_URL ?? 'wss://stream.bybit.com/v5/public/spot',
  bybitSymbol: env.BYBIT_SYMBOL ?? 'MONUSDT',

  // Binance spot — the CEX reference for non-MON assets (BTC/ETH); MON has no
  // Binance spot so it stays on Bybit. Symbols come from the asset registry.
  // Defaults are Binance's OFFICIAL public market-data mirror (binance.vision):
  // identical engine data + the same REST/WS interfaces, but NOT geo-blocked —
  // api.binance.com returns HTTP 451 from US IPs (e.g. Render Oregon), which
  // silently starved the BTC/ETH references in prod. We only consume public
  // market data, so the mirror is strictly the better default everywhere.
  binanceRest: env.BINANCE_REST_URL ?? 'https://data-api.binance.vision',
  binanceWs: env.BINANCE_WS_URL ?? 'wss://data-stream.binance.vision',

  /** Bybit taker fee (bps) for the MON benchmark — default Supreme VIP (4.5 bps),
   *  Bybit's top PUBLISHED spot tier: the advanced-trader benchmark, matching the
   *  Binance-VIP9 philosophy below (PRO/MM tiers go lower but aren't published). */
  takerBps: num('TAKER_BPS', 4.5),
  /** Binance taker fee (bps) for the BTC/ETH benchmark — default VIP9 (2.25 bps). */
  binanceTakerBps: num('BINANCE_TAKER_BPS', 2.25),
  quoteIntervalMs: num('QUOTE_INTERVAL_MS', 500),
  /** fills-tail loop cadence (ms) — independent of the quote loop, so log
   *  tailing never stretches the quote cadence (and vice versa). */
  tailIntervalMs: num('TAIL_INTERVAL_MS', 500),

  sizesUsd: [...SIZES_USD],

  /** getLogs span the tail ATTEMPTS. Measured caps: the devcore4 fleet serves
   *  1000 blocks per call, the public endpoint 413s above ~100. Sized for the
   *  fleet — a narrower endpoint is handled by getLogsChunked's shrink rather
   *  than by pricing every request for the weakest possible node. */
  getLogsChunk: num('GETLOGS_CHUNK', 900),
  /** Narrowest span we degrade to, and the floor every adaptive crawl shrinks
   *  toward. Proven to work on the public endpoint, so a failover down to it
   *  keeps serving instead of 413ing every call. MUST stay <= backfillChunk:
   *  the deep crawls start at backfillChunk and shrink to this, so a floor
   *  above the start would leave them nowhere to go. */
  getLogsMinChunk: num('GETLOGS_MIN_CHUNK', 90),

  // ── history (persist-forward indexer) ──────────────────────────────────────
  /** SQLite file — authoritative daily-volume history + lastProcessedBlock. */
  dbPath: env.DB_PATH ?? 'data/mpamm.db',
  /** Clober Goldsky subgraph — one-time seed of historical daily volume. */
  subgraphUrl: env.SUBGRAPH_URL ?? 'https://api.goldsky.com/api/public/project_clsljw95chutg01w45cio46j0/subgraphs/v2-subgraph-monad/latest/gn',
  /** First UTC day to seed history from. */
  seedSinceUtc: env.SEED_SINCE_UTC ?? HISTORY_START_UTC,
  /** Snapshot persistence cadence (ms). */
  persistMs: num('PERSIST_MS', 5000),
  /** Periodic re-discovery cadence (ms) — re-runs each adapter's discover() so
   *  mid-run/missed pool state self-heals from its authoritative source. */
  rediscoverMs: num('REDISCOVER_MS', 600_000),
  /** Max same-day gap to fill from getLogs on restart (else start at tip). */
  gapFillMaxBlocks: num('GAPFILL_MAX_BLOCKS', 200000),
  /** Decoded fills are persisted; rows older than this are pruned. The
   *  leaderboard's widest window is 30d, so keep a little more. */
  fillsRetentionDays: num('FILLS_RETENTION_DAYS', 35),

  // ── on-chain backfill (background) ──────────────────────────────────────────
  /** Replay each opted-in adapter's Swap logs from its `backfillFromUtc` to seed
   *  deep daily-volume history without a subgraph. Runs in the background (never
   *  blocks boot or the live tail), resumes across restarts, self-heals per boot
   *  until complete. Set BACKFILL=off to disable (e.g. a range-limited RPC). */
  backfillEnabled: (env.BACKFILL ?? 'on').toLowerCase() !== 'off',
  /** Starting getLogs span for backfill — auto-shrinks on an RPC range error and
   *  floors at getLogsMinChunk, so it runs as wide as the node allows without 413s. */
  backfillChunk: num('BACKFILL_CHUNK', 800),
  /** Delay between backfill chunks (ms) — paces requests under the RPC rate cap. */
  backfillPaceMs: num('BACKFILL_PACE_MS', 40),
  /** Merge + persist backfilled volume (and advance the resume cursor) every N chunks. */
  backfillMergeEvery: num('BACKFILL_MERGE_EVERY', 50),
  /** ONBOARDING markout backfill: once per venue, scan its last N days of fills
   *  on-chain (real block timestamps) and mark them against the exchanges'
   *  ARCHIVED prices (Bybit trade dumps at 1s / Binance 1s klines — see
   *  server/src/history/cex.ts), so a newly added venue starts with its
   *  leaderboard window populated instead of empty. Bounded to the UI's widest
   *  window (30d) on purpose — the display never goes deeper (pamm.wtf-aligned),
   *  so venue-lifetime marking would be cost without product. Resumable across
   *  boots; MARKOUT_BACKFILL=off disables. */
  markoutBackfill: (env.MARKOUT_BACKFILL ?? 'on').toLowerCase() !== 'off',
  markoutBackfillDays: num('MARKOUT_BACKFILL_DAYS', 30),
  /** Retry cadence for DEFERRED markout backfills (ms). A month's CEX archive
   *  publishes a few days after month end; this sweep re-probes (HEAD, cheap)
   *  and marks the deferred days as soon as it lands — no restart needed. */
  markoutRetryMs: num('MARKOUT_RETRY_MS', 6 * 3_600_000),
  /** ONE-SHOT full re-scan trigger: comma-separated venue ids (e.g. "metric").
   *  On boot, clears those venues' backfill done-flag + cursor so their history
   *  re-scans from backfillFromUtc — use after switching to a better archive RPC
   *  to recover skipped holes. Applied once per VALUE (a marker meta remembers
   *  it), so redeploys don't re-trigger; to re-run again later, change the value
   *  (e.g. "metric@2"). The SET-per-day merge keeps re-scans idempotent. */
  backfillReset: env.BACKFILL_RESET ?? '',

  /** QUOTE_UPDATE_BURN (Volume tab): track the MON each venue's own keeper
   *  spends on price updates (adapter gasSources()). GAS_METRIC=off disables
   *  the tracker (the API then serves whatever was already persisted). */
  gasMetric: (env.GAS_METRIC ?? 'on').toLowerCase() !== 'off',
  /** logs-mode receipt sampling: per processed chunk, fetch at most this many
   *  receipts (evenly strided) and scale by the chunk's tx count. Update txs
   *  have flat gas limits and ride the ~100 gwei base-fee floor, so a modest
   *  sample tracks the true cost to well under 1%; counts stay EXACT. */
  gasReceiptSamplePerChunk: num('GAS_RECEIPT_SAMPLE_PER_CHUNK', 40),
  /** blocks-mode (no-event oracles, e.g. POE setData): sample one block every
   *  N blocks via eth_getBlockReceipts and scale by the stride. Only sound for
   *  near-constant-cadence keepers — POE pushes exactly once per block. */
  gasSampleStrideBlocks: num('GAS_SAMPLE_STRIDE_BLOCKS', 1000),
  /** max tail-loop iterations (logs: chunks, blocks: sampled strides) one venue
   *  may run per gas pass — a TIME SLICE, so a months-deep rebuild can't starve
   *  the other venues' today-accrual for hours (the pass loop round-robins;
   *  cursors commit at slice end, so slicing is exactly as crash-safe as the
   *  loops already were). ~600 ≈ 1-2 min of paced work. */
  gasSliceChunks: num('GAS_SLICE_CHUNKS', 600),
  /** idle sleep between gas tail passes once caught up to head (ms). */
  gasTailMs: num('GAS_TAIL_MS', 60_000),
} as const;

// Archive backups without an archive primary are a no-op that LOOKS configured:
// the deep crawls would keep riding the hot pool while an operator believes they
// have a fallback. Same fail-loud rule as the chunk config below — a setting
// that silently does nothing must not boot.
if (!config.rpcArchive && env.RPC_ARCHIVE_BACKUP_URLS !== undefined) {
  throw new Error(
    'RPC_ARCHIVE_BACKUP_URLS is set but RPC_ARCHIVE_URL is not — the archive backups would never be used ' +
    '(with no archive primary the deep crawls run on the hot pool). Set RPC_ARCHIVE_URL, or unset RPC_ARCHIVE_BACKUP_URLS.',
  );
}

// Fail LOUD at boot on a chunk misconfiguration rather than degrading quietly.
// The three deep crawls start at backfillChunk and shrink toward getLogsMinChunk;
// with the floor above the start they can never shrink, so their `catch` would
// reclassify a legitimate "range too large" as an unreadable archive hole and
// SKIP it — silently undercounting exactly the way this project refuses to.
// Same reasoning as the fail-loud venue registry: a bad config should not boot.
if (config.getLogsMinChunk > config.backfillChunk) {
  throw new Error(
    `GETLOGS_MIN_CHUNK (${config.getLogsMinChunk}) must be <= BACKFILL_CHUNK (${config.backfillChunk}) — ` +
    'the backfill and gas crawls start at BACKFILL_CHUNK and shrink toward GETLOGS_MIN_CHUNK; ' +
    'a floor above the start leaves them nowhere to shrink and turns range errors into skipped ranges.',
  );
}
if (config.getLogsMinChunk > config.getLogsChunk) {
  throw new Error(
    `GETLOGS_MIN_CHUNK (${config.getLogsMinChunk}) must be <= GETLOGS_CHUNK (${config.getLogsChunk}) — ` +
    'the tail attempts GETLOGS_CHUNK and narrows toward the floor, never the other way round.',
  );
}
if (config.getLogsMinChunk < 1 || config.getLogsChunk < 1) {
  throw new Error('GETLOGS_CHUNK and GETLOGS_MIN_CHUNK must both be >= 1 block.');
}

export type Config = typeof config;
