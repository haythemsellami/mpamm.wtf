import type { PublicClient } from 'viem';
import type { Fill, QuoteRow, VenueMeta } from '@shared';
import type { getLogsChunked } from '../chain/rpc.js';
import type { UsdPricer } from '../pricer.js';
import type { Config } from '../config.js';

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
  /** range-chunked getLogs (the public RPC caps eth_getLogs spans). */
  getLogs: typeof getLogsChunked;
  /** token→USD pricing (stables = $1, base assets off their CEX reference). */
  pricer: UsdPricer;
  config: Config;
  log: (m: string) => void;
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
 *              is receipt-sampled per chunk (flat keeper gas limits make the
 *              estimate sub-1%).
 *  - 'blocks': updates emit NO logs (e.g. POE's ClapOracle setData) — sample
 *              blocks with eth_getBlockReceipts, count txs `to === address`,
 *              scale by the stride. ESTIMATE (UI shows ≈) — only sound for a
 *              near-constant-cadence keeper (POE pushes every block).
 *
 * A venue whose quoting cost is NOT self-funded (external oracle, taker-paid
 * JIT repricing) simply doesn't implement gasSources — absence is the honest
 * value, not zero.
 */
export type GasSource =
  | { mode: 'logs'; address: `0x${string}` | `0x${string}`[]; events?: readonly unknown[]; topic0?: `0x${string}` }
  | { mode: 'blocks'; address: `0x${string}` | `0x${string}`[] };

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
  /** optional live bid/ask per market×size for the Execution tab. */
  quote?(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]>;
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
   *  malformed/irrelevant logs locally. */
  decode(ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number, failedSources: Set<string>): Fill[] | Promise<Fill[]>;
}

/**
 * The CEX reference registry — the benchmarks for markouts + the Execution
 * comparison, routed PER BASE ASSET (Bybit for MON, Binance for BTC/ETH). These
 * are NOT fill-producing venues; one registry owns every CEX feed.
 */
export interface ReferenceRegistry {
  start(): Promise<void>;
  stop(): void;
  /** the CEX benchmark venue metas (role: 'reference'). */
  metas(): VenueMeta[];
  /** the reference venue id benchmarking a base asset ('bybit' | 'binance'). */
  refVenueIdForBase(base: string): string;
  /** USD(≈USDT) price of a base asset (MON/BTC/ETH) — for notional sizing and
   *  the header, NOT for bps anchoring (that needs the pair's quote terms). */
  assetUsd(base: string): number;
  /** the CEX reference mid for a PAIR, expressed in the pair's own terms:
   *  baseUSDT mid × wrap basis (WBTCBTC for wrapped BTC) ÷ the stable's USDT
   *  cross (USDCUSDT for USDC pairs). This is the bps anchor + markout mark —
   *  like-for-like with what actually trades on-chain (docs/architecture.md: pair-terms reference). */
  midForPair(market: string): number;
  /** 24h change % for a base asset. */
  changePctFor(base: string): number;
  /** taker-walk benchmark rows for every tracked pair, each routed to and tagged
   *  with the pair's CEX (venueId = 'bybit' | 'binance'), prices converted into
   *  the pair's quote terms (wrap basis + stable cross). */
  quote(sizesUsd: readonly number[]): QuoteRow[];
}
