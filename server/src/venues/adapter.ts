import type { PublicClient } from 'viem';
import type { Fill, NoteCode, QuoteRow, VenueMeta } from '@shared';
import type { getLogsChunked } from '../chain/rpc.js';
import type { UsdPricer } from '../pricer.js';
import type { Config } from '../config.js';
import type { MulticallOutcome, QuoteHealthReport } from './quote-health.js';

/**
 * Venue adapter contract — the composable unit.
 *
 * The core (indexer, aggregator, markouts, DB, API, frontend) is entirely
 * venue-agnostic: it only ever sees `VenueMeta` + `Fill.venueId` + `QuoteRow.venueId`.
 * A protocol is plugged in by dropping ONE adapter file here and adding it to
 * `registry.ts` — no core edits. An adapter can source its data fully on-chain,
 * from a subgraph, or a mix; it just has to return the shared shapes.
 *
 * See docs/adapters.md for a walkthrough and `_template.ts` for a copy-paste stub.
 */

/** Shared infrastructure handed to every adapter — use these instead of importing
 *  the globals, so an adapter is a pure function of its context. */
export interface AdapterContext {
  /** viem public client for the Monad RPC (contract reads / multicall). */
  client: PublicClient;
  /** Present only for cancelable live quote work. Check after awaits before
   * applying shared caches/notes; canceled transports may still settle. */
  quoteSignal?: AbortSignal;
  /** Stage per-plan health until the adapter's complete demand has settled. */
  quoteHealth?: (report: QuoteHealthReport, results: readonly MulticallOutcome[]) => void;
  /** range-chunked getLogs (the public RPC caps eth_getLogs spans). */
  getLogs: typeof getLogsChunked;
  /** token→USD pricing (stables = $1, base assets off their CEX reference). */
  pricer: UsdPricer;
  config: Config;
  /** raise a developer-facing note (server/src/notes.ts → `state.notes` on
   *  /api/markets, and stdout). Pick the `code` that matches the event: it is
   *  what a consumer filters and alerts on, and it also decides the note's
   *  level (@shared: NOTE_LEVEL), so nothing downstream has to read your
   *  wording. The core stamps the timestamp and your venue id, and drops a
   *  repeat of a note it already holds (discovery re-runs every 10 minutes).
   *
   *  Pass `{ repeatable: true }` for a STATE TRANSITION you already latch
   *  (outage → recovery → the same outage again). Window-wide dedupe would
   *  swallow the second outage as a repeat of the first, still in the window,
   *  and the core's went-dark backstop would then report the venue as
   *  unexplained. That is how ThogAMM's second "maker: stale" outage reached
   *  the dashboard as MISSING (2026-09-30). */
  note: (code: NoteCode, msg: string, opts?: { repeatable?: boolean }) => void;
  /** Small durable key/value store, namespaced to this adapter's venue (SQLite
   *  `meta`; survives restarts). For state that cannot be re-derived cheaply at
   *  boot — e.g. a pool a permissionless factory announced ONCE: the fills tail
   *  never re-reads a log behind its cursor, so an in-memory-only record of it
   *  is lost on the next restart. `set` resolves after COMMIT and throws on
   *  failure; await it before returning fills that depend on it, so the cursor
   *  can never commit past state that was not persisted. Absent outside the
   *  live indexer (depth worker, scripts, tests) — treat it as optional. */
  state?: AdapterState;
}

export interface AdapterState {
  get(key: string): string | undefined;
  set(key: string, value: string): Promise<void>;
}

/** A group of on-chain logs the core fetches each cycle for this adapter and
 *  hands back to `decode()` under `key`. `events` are viem AbiEvent objects
 *  (e.g. `abi.filter(x => x.type === 'event' && x.name === 'Swap')`). */
export interface LogSource {
  key: string;
  address: `0x${string}` | `0x${string}`[];
  events: readonly unknown[];
  /** what this source feeds — governs how a fetch FAILURE is handled:
   *  - `'fills'`       (default): fill-producing. Failure HOLDS the block cursor
   *    — the whole tail cycle is skipped and re-tried next cycle, so no fills are
   *    lost or partially decoded.
   *  - `'state'`       : decoding state (e.g. pool/book `Open`s). Missing it can
   *    make later fills undecodable, so failure ALSO holds the cursor.
   *  - `'attribution'` : labels only (e.g. router tags). Failure is tolerated —
   *    the cursor advances and affected fills just carry degraded attribution. */
  kind?: 'fills' | 'state' | 'attribution';
  /** Inclusive block span the source can emit logs in — a contract's creation
   *  block, a retired contract's last activity. Unset = unbounded. The core
   *  never fetches the source outside it (tail, volume backfill, markout
   *  onboarding): a retired generation costs zero RPC yet stays replayable
   *  (docs/adapters.md → Retiring contracts). A bound is a PROMISE, not a
   *  filter — logs outside it are never seen, so declare one only where the
   *  chain proves the contract inert beyond it. */
  fromBlock?: bigint;
  untilBlock?: bigint;
}

/** The part of the inclusive range [from, to] a source can emit logs in, or
 *  null when it cannot emit any there (skip the fetch entirely). */
export function sourceSpan(s: Pick<LogSource, 'fromBlock' | 'untilBlock'>, from: bigint, to: bigint): { from: bigint; to: bigint } | null {
  const lo = s.fromBlock !== undefined && s.fromBlock > from ? s.fromBlock : from;
  const hi = s.untilBlock !== undefined && s.untilBlock < to ? s.untilBlock : to;
  return lo <= hi ? { from: lo, to: hi } : null;
}

/** Logs delivered to `decode()`, keyed by `LogSource.key`. */
export type LogBundle = Record<string, any[]>;

/** A contract belonging to this venue that takers enter through (compared
 *  against `tx.to` by the core fill attributor — server/src/attribution.ts):
 *  no `router` = the venue itself (pool/book/proxy) — a match is a DIRECT
 *  fill; with `router` = the venue's own periphery — a match labels the fill
 *  `Router - <name>`. Aggregators do NOT belong here (global registry). */
export interface EntryPoint {
  address: string;
  router?: string;
}

/**
 * How a venue's QUOTE-UPDATE transactions are found on-chain — the txs its own
 * keeper sends to push prices / reprice books (QUOTE_UPDATE_BURN). Monad
 * charges gas_limit (receipts report gasUsed == limit), so a tx's cost is
 * exactly receipt.gasUsed × effectiveGasPrice.
 *
 *  - 'logs':   every update emits an event — enumerate update txs via getLogs
 *              (`events` ABI objects, or a raw `topic0` when the contract is
 *              unverified and only the hash is known). Counts are exact; cost
 *              is receipt-sampled per chunk — an ESTIMATE (UI shows ≈ on the
 *              MON figure), ~5-10% off on days when a few heavy pushes
 *              dominate the spend.
 *  - 'blocks': updates emit NO logs (e.g. POE's ClapOracle setData) — sample
 *              blocks with eth_getBlockReceipts, count txs `to === address`,
 *              scale by the stride. Counts AND cost estimated (UI shows ≈) —
 *              only sound for a near-constant-cadence keeper (POE pushes
 *              every block).
 *
 *              `relays` additionally counts updates that reach `address`
 *              THROUGH a shared forwarder (see GasRelay).
 *
 * A venue whose quoting cost is NOT self-funded (external oracle, taker-paid
 * JIT repricing) simply doesn't implement gasSources — absence is the honest
 * value, not zero.
 */
export type GasSource =
  | { mode: 'logs'; address: `0x${string}` | `0x${string}`[]; events?: readonly unknown[]; topic0?: `0x${string}` }
  | { mode: 'blocks'; address: `0x${string}` | `0x${string}`[]; relays?: readonly GasRelay[] };

/**
 * A SHARED contract some of a venue's update txs are sent to instead of the
 * update contract itself (e.g. an MEV auction handler that forwards the call
 * to a named searcher). tx.to alone can't attribute these — other searchers
 * use the same relay — and the receipt may carry nothing naming the target
 * (reverted bids have no logs, yet still pay gas_limit). So the match is on
 * CALLDATA: tx.to == `address`, the 4-byte `selector`, and the static head
 * word `targetWord` (0-based, after the selector) holding one of the
 * source's own `address` entries. The relay is never an owned destination —
 * it is not claimed in the cross-venue ownership check.
 */
export interface GasRelay {
  address: `0x${string}`;
  selector: `0x${string}`;
  targetWord: number;
}

/**
 * A one-shot replay of this venue's history, declared next to the code change
 * that needs it — the in-code form of `BACKFILL_RESET=<venue>:<from>`, so the
 * replay's scope is reviewed in the PR and recorded in git rather than set by
 * hand in the host's dashboard.
 *
 * The core replays closed days from `from` (volume + fills, deleting first so
 * a day can go DOWN), then re-reads TODAY up to the live tail's cursor — the
 * part of the day the tail decoded with the previous build. Applied once per
 * database, keyed on `id`: never edit an applied entry, add a new id.
 *
 * A venue whose history scan has not reached `from` yet (a fresh database) is
 * left to that scan: the replay never moves a scan cursor forward.
 */
export interface HistoryRevision {
  /** stable, unique per venue — the marker that records it as applied */
  id: string;
  /** first UTC day (YYYY-MM-DD) whose stored history is wrong; omit for the
   *  whole lifetime. Today is valid: only today's prefix is re-read. */
  from?: string;
  /**
   * Where the corrected history comes from. 'chain' (the default) is the
   * replay above. 'fills' re-derives each closed day in [from, until) from
   * the venue's RETAINED fills: it SETs the day's volume to their sum, and
   * reads no chain, deletes nothing and re-prices nothing.
   *
   * Use 'fills' only when the fills are right and the day buckets are not,
   * i.e. fills were booked on the wrong day. A replay would rewrite every
   * day from `from` to yesterday. It re-prices cross-quoted pairs at the
   * replay's CEX mid and drops closed-day fills' live markout curves, which
   * cannot be rebuilt. 'fills' changes only the window.
   *
   * The window must be inside fills retention when the build boots (a
   * pruned day has nothing to sum). The window's total must also be
   * conserved: moving fills between days cannot change it.
   *
   * 'markets' ADDS the history of markets this build starts decoding that
   * were already trading (`markets`), and touches nothing else. It reads the
   * chain from `from` like the replay but keeps only those markets' fills,
   * and adds each to its day (inserting the fill unless stored). Every other
   * row stays as stored, so no cross pair is re-priced and no markout curve
   * is dropped. Its scope is every block an OLDER build decoded: up to the
   * first block this build's tail read, recorded on its first boot, minus
   * the days a volume replay or reset re-SETs with this build. Use it for a
   * newly listed market, never to fix a decode: a fill it adds is, by
   * definition, one no earlier build counted.
   */
  source?: 'chain' | 'fills' | 'markets';
  /** 'fills' only, and required there: the first UTC day AFTER the window
   *  (exclusive). It must close before the revision can apply. */
  until?: string;
  /** 'markets' only, and required there: the registered market symbols
   *  (@shared PAIRS) whose history this revision adds. */
  markets?: readonly string[];
}

/**
 * A one-shot rebuild of this venue's gas series, declared next to the change
 * that needs it. A destination-set change already rebuilds itself (gas.ts
 * reconcileSourceChange); this is for a series accrued WRONG under an
 * unchanged set, e.g. by a scan that skipped chunks it could not price.
 *
 * The gas tracker wipes the series from `from` (the venue lifetime when
 * omitted) together with its cursor, then re-scans it. Applied once per
 * database, keyed on `id`: never edit an applied entry, add a new id. A venue
 * whose gas scan has not started yet is only marked applied, since its first
 * scan reads the fixed history anyway.
 */
export interface GasRevision {
  /** stable, unique per venue — the marker that records it as applied */
  id: string;
  /** first UTC day (YYYY-MM-DD) whose stored burn is wrong; omit for the
   *  whole lifetime */
  from?: string;
}

/** Optional historical seed returned by `backfill()`. */
export interface AdapterBackfill {
  /** closed-day per-venue volume to merge into the store (usd; swaps defaults to 0). */
  days?: Array<{ utcDay: string; byVenue: Record<string, { usd: number; swaps?: number }> }>;
  /** optional historical fills (for tape/markouts/leaderboard). */
  fills?: Fill[];
}

export interface VenueAdapter {
  /** the display venue(s) this adapter produces — usually one. Every `Fill`/`QuoteRow`
   *  it emits must carry a `venueId` that is one of these. */
  venues(): VenueMeta[];
  /** Discovered quote coverage, independent of whether a viewer requested it. */
  quoteMarkets?(): readonly string[];
  /** find the markets/pools this venue trades. The adapter holds its own state
   *  (markets, book cache, …). Called once at boot; may also be called to refresh. */
  discover(ctx: AdapterContext): Promise<void>;
  /** optional one-time historical seed (subgraph or REST). Fast + synchronous —
   *  runs during boot. For a slow on-chain replay use `backfillFromUtc` instead. */
  backfill?(ctx: AdapterContext, sinceUtc: string): Promise<AdapterBackfill>;
  /** opt into the core's background on-chain backfill: replay this adapter's
   *  `logSources('fills')` from this UTC day (e.g. '2026-05-13') → decode() → daily
   *  volume. The core owns the chunking/pacing/resume so the adapter stays thin.
   *  Use for venues with no keyless subgraph; leave unset to accrue forward only. */
  backfillFromUtc?: string;
  /** Re-derive stored history after a change to what this adapter decodes — a
   *  redeploy's new sources, a units fix. Each entry runs ONCE per database, on
   *  the first boot of the build that declares it: the deploy is the trigger,
   *  not an operator setting. Applies to `venues()[0]`, the venue the core's
   *  history scans book this adapter's fills under. See HistoryRevision. */
  historyRevisions?: readonly HistoryRevision[];
  /** Rebuild the stored QUOTE_UPDATE_BURN series after it was accrued wrong —
   *  the gas counterpart of `historyRevisions`, which never touches gas. Same
   *  contract: ONCE per database, on the first boot of the build that declares
   *  it. See GasRevision. */
  gasRevisions?: readonly GasRevision[];
  /** Optional live bid/ask per market×size for the Execution tab. Every chain
   *  read must use `blockNumber`: one published matrix represents exactly one
   *  Monad block rather than a mixture of adjacent `latest` states.
   *
   *  `markets` narrows work before an adapter builds its contract calls. The
   *  realtime engine passes subscribed markets; depth passes one requested
   *  market. Legacy full-matrix consumers leave it unset. */
  quote?(
    ctx: AdapterContext,
    sizesUsd: readonly number[],
    blockNumber: bigint,
    markets?: ReadonlySet<string>,
  ): Promise<QuoteRow[]>;
  /** the contract logs the core should fetch each cycle (read after `discover`).
   *  If discovery is required to enumerate fill/state sources and is not ready,
   *  throw here so the core holds the cursor instead of tailing an incomplete
   *  source set. Returning [] means there are genuinely no logs to tail. */
  logSources(): LogSource[];
  /** optional: where this venue's own quote-update txs are found (see
   *  GasSource). Throw if discovery hasn't resolved the destination yet — the
   *  gas tracker holds that venue's cursor and retries. Omit entirely when the
   *  venue doesn't self-fund its price updates. */
  gasSources?(): GasSource[];
  /** optional: this venue's taker entry contracts (see EntryPoint) — lets the
   *  core attributor turn an UNKNOWN fill into DIRECT (tx.to is the venue
   *  itself) or `Router - <venue>` (tx.to is the venue's own periphery).
   *  Return the currently-known set; called per tail pass, cheap. */
  entryPoints?(): EntryPoint[];
  /** decode this adapter's fetched logs into normalized fills. Owns any
   *  venue-specific correlation (router maps, mid-run pool discovery, filtering).
   *  `failedSources` holds the keys of any `'attribution'` sources whose fetch
   *  failed this cycle (required-source failures never reach decode — the cycle is
   *  skipped). Use it to avoid a confident label when attribution is unavailable
   *  (e.g. tag a fill `UNKNOWN` instead of `DIRECT`). If this method throws, the
   *  core holds the cursor and retries the whole range; catch and skip individual
   *  malformed/irrelevant logs locally. `tsOf(block)` is only ever stamped onto
   *  `Fill.ts`, never branched on: history scans pass an approximation (the
   *  volume replay's chunk-day stamp, a 'markets' revision's placeholder) and
   *  correct the fills they keep. */
  decode(ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number, failedSources: Set<string>): Fill[] | Promise<Fill[]>;
}

/**
 * The CEX reference registry — the benchmarks for markouts + the Execution
 * comparison, routed per base asset (Bybit, Binance, or Kraken xStocks). These
 * are NOT fill-producing venues; one registry owns every CEX feed.
 */
export interface ReferenceRegistry {
  start(): Promise<void>;
  stop(): void;
  /** the CEX benchmark venue metas (role: 'reference'). */
  metas(): VenueMeta[];
  /** the reference venue id benchmarking a base asset ('bybit' | 'binance' | 'kraken'). */
  refVenueIdForBase(base: string): string;
  /** USD(≈USDT) price of a base asset (MON/BTC/ETH) — for notional sizing and
   *  the header, NOT for bps anchoring (that needs the pair's quote terms). */
  assetUsd(base: string): number;
  /** USD for VALUING a settled fill: assetUsd, except that a market in a
   *  scheduled closure or outage (Kraken xStocks, 24/5) keeps its last good
   *  price. An xStock/xStock fill has no other USD leg, and decode throwing
   *  for want of one would hold the shared tail for every venue. Never for
   *  sizing, bps anchors or markouts. */
  settledUsd(base: string): number;
  /** The base's CEX itself reports its market as not trading (Kraken's 24/5
   *  xStock closures, a halt, maintenance). Its pairs have no reference while
   *  it lasts, and that is expected, not a starving feed. */
  marketClosed(base: string): boolean;
  /** the CEX reference mid for a PAIR, expressed in the pair's own terms:
   *  base book mid converted for USD/USDT, base/quote wrapper bases, and
   *  the quote asset or stable cross. This is the bps anchor + markout mark —
   *  like-for-like with what actually trades on-chain (docs/architecture.md: pair-terms reference). */
  midForPair(market: string): number;
  /** 24h change % for a base asset. */
  changePctFor(base: string): number;
  /** taker-walk benchmark rows for every tracked pair, each routed to and tagged
   *  with the pair's CEX (venueId = 'bybit' | 'binance' | 'kraken'), prices converted into
   *  the pair's quote terms (wrap basis + stable cross). */
  quote(sizesUsd: readonly number[], markets?: ReadonlySet<string>): QuoteRow[];
}
