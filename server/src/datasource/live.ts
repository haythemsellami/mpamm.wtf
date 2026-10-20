import { AnalyticsWorker } from '../analytics-worker.js';
import { QuoteRunner } from '../quote-runner.js';
import { QuoteHealthBatch } from '../venues/quote-health.js';
import { agePendingMarkouts, nearestReferenceSample } from '../markout-aging.js';
import { BaseSource, QUOTE_HISTORY_MS } from './index.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS, ASSETS, PAIRS, pairOf, cexForBase, CURVE_OFFSETS_S, curveMarkMs,
  type DataSourceMode, type MarkoutCurvesResponse, type MarketState, type QuoteSnapshot, type QuoteRow, type Fill, type DailyVolume,
  type LeaderboardResponse, type GasResponse, type NoteCode, type QuoteFrameTelemetry,
  type QuoteHeadSource, type RealtimeHealth,
} from '@shared';
import { allPreferAvailability, guardRpcRead, isAvailabilityFailure } from '../chain/failover.js';
import { FillAttributor } from '../attribution.js';
import { pairMidSeries } from '../history/cex.js';
import { curveComplete, curvePoints } from '../markout-curves.js';
import { GasTracker } from '../gas.js';
import { DepthWorkerClient } from '../depth/worker-client.js';
import { config } from '../config.js';
import {
  monad, publicClient, headClient, hotHeadEndpoint, resolveQuoteBlock, quoteClient, scopedQuoteClient, archiveClient, getLogsChunked, probeChain, probeArchiveChain, blockAtOrAfter,
  onRpcEvent, onArchiveRpcEvent, rpcStatus, rpcGeneration, archiveRpcStatus, archiveRpcGeneration, hasDedicatedArchive,
} from '../chain/rpc.js';
import { HotHeadWatcher, type HeadIdentity } from '../chain/heads.js';
import { UsdPricer } from '../pricer.js';
import { VolumeStore, retentionCutoffMs, type DayFillCount, type ResetDeletes, type SnapshotResult } from '../db.js';

/** routine sweeps (a few expired fills every 10 min) stay quiet in the log. */
const PRUNE_LOG_MIN_ROWS = 1_000;
import { directStoreWriter, SnapshotWriter, type SnapshotWrite, type StoreWriter } from '../persistence.js';
import { NOTE_MSG_MAX, NoteBuffer, scrubNote } from '../notes.js';
import { utcDay, annotateCex } from '../util.js';
import { seedSources } from './seed.js';
import { ADAPTERS, REFERENCES, venueMeta, venueIds, allVenueIds, allAdapterVenueIds, validateRegistry } from '../venues/registry.js';
import { sourceSpan, type AdapterContext, type HistoryRevision, type LogBundle, type LogSource, type ReferenceRegistry, type VenueAdapter } from '../venues/adapter.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ARCHIVE_RETRY_BASE_MS = 15_000;
const ARCHIVE_RETRY_MAX_MS = 120_000;
const ARCHIVE_BOUNDARY_NOTE_MS = 30_000;
const WS_HEAD_FALLBACK_MSG = 'quote-head WebSocket unavailable — HTTP head polling is active';
const REALTIME_WINDOW_MS = 60_000;

/** Max blocks one tail cycle fetches/decodes/commits (see tailFills). */
const TAIL_WINDOW_BLOCKS = 1_000;
/** The in-memory recent-fill ring (`/api/markets` tape, ingest dedup window). */
const FILL_RING_SIZE = 400;

interface QuoteTrigger {
  identity?: HeadIdentity;
  blockNumber: bigint;
  source: Exclude<QuoteHeadSource, 'sim'>;
  observedAt: number;
  coalescedBlocks: number;
}

interface RealtimeFrameSample {
  block: number;
  emittedAt: number;
  coalescedBlocks: number;
}

/** Unique emitted block coverage across the retained wall-time window. The
 *  denominator extends to the latest observed head so an in-flight lag is not
 *  reported as 100% merely because it has not emitted yet. */
export function realtimeCoverage(
  frames: readonly RealtimeFrameSample[],
  headBlock: number,
  now = Date.now(),
): { coveragePct60s: number; coalescedBlocks60s: number } {
  const recent = frames.filter((f) => f.emittedAt >= now - REALTIME_WINDOW_MS);
  if (!recent.length) return { coveragePct60s: 0, coalescedBlocks60s: 0 };
  const unique = new Set(recent.map((f) => f.block));
  const first = Math.min(...unique);
  const last = Math.max(headBlock, ...unique);
  const span = Math.max(1, last - first + 1);
  return {
    coveragePct60s: Math.min(100, unique.size / span * 100),
    coalescedBlocks60s: recent.reduce((sum, f) => sum + f.coalescedBlocks, 0),
  };
}

/** Capture the mutable CEX feeds synchronously, before the first RPC await in a
 *  frame. JavaScript cannot run feed callbacks inside this turn, so every
 *  adapter receives one immutable sizing/bps view even if the books move while
 *  its pinned chain calls are in flight. */
export function captureReferenceFrame(
  references: Pick<ReferenceRegistry, 'assetUsd' | 'midForPair' | 'quote'>,
  sizesUsd: readonly number[],
  markets?: ReadonlySet<string>,
): { pricer: UsdPricer; monUsd: number; rows: QuoteRow[]; assetPrices: Map<string, number>; pairMids: Map<string, number> } {
  const assetPrices = new Map<string, number>();
  for (const key of Object.keys(ASSETS)) assetPrices.set(key, references.assetUsd(key));
  const pairMids = new Map(PAIRS.map((pair) => [pair.symbol, references.midForPair(pair.symbol)]));
  const rows = references.quote(sizesUsd, markets);
  return {
    pricer: new UsdPricer(
      (key) => assetPrices.get(key) ?? 0,
      (market) => pairMids.get(market) ?? 0,
    ),
    monUsd: assetPrices.get('MON') ?? 0,
    rows,
    assetPrices,
    pairMids,
  };
}

/** Cursor-preserving availability retries use a real outage cadence, not the
 *  normal crawl pace. A sustained 429 otherwise turns a background repair into
 *  a tight loop that prolongs the throttle and starves later venues. */
export function archiveRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(3, Math.floor(attempt) - 1));
  return Math.min(ARCHIVE_RETRY_MAX_MS, ARCHIVE_RETRY_BASE_MS * 2 ** exponent);
}

/** A history run may share one UTC anchor only while that day is current. */
export function historyRunRolled(runDay: string, nowMs: number = Date.now()): boolean {
  return utcDay(nowMs) !== runDay;
}

class HistoryDayRolledError extends Error {
  constructor(readonly runDay: string) {
    super(`deep history crossed UTC midnight after starting on ${runDay}`);
    this.name = 'HistoryDayRolledError';
  }
}

export interface ArchiveBoundaryWaitState {
  head: bigint;
  target: bigint;
  lag: bigint;
  waitedMs: number;
}

export interface ArchiveBoundaryWaitObserver {
  graceMs: number;
  onHeld: (state: ArchiveBoundaryWaitState) => void;
  onResumed?: (state: ArchiveBoundaryWaitState) => void;
  /** deterministic clock injection for tests. */
  now?: () => number;
}

/** Wait until the archive can serve an exact hot-head handoff. An archive
 *  chosen for retention may trail the hot node by a few blocks, but it will
 *  pass that fixed target shortly as the chain advances. The wait remains
 *  deliberately unbounded and fail-closed; the observer makes a serving but
 *  persistently lagging archive visible without weakening that invariant. */
export async function waitForArchiveBoundary(
  target: bigint,
  getHead: () => Promise<bigint>,
  isUnavailable: () => boolean = () => false,
  pause: (ms: number) => Promise<void> = sleep,
  generation: () => number = () => 0,
  observer?: ArchiveBoundaryWaitObserver,
): Promise<boolean> {
  let waited = false;
  let unavailableAttempts = 0;
  let held = false;
  const now = observer?.now ?? Date.now;
  const startedAt = now();
  while (target > 0n) {
    if (isUnavailable()) {
      waited = true;
      await pause(archiveRetryDelayMs(++unavailableAttempts));
      continue;
    }
    try {
      const head = await guardRpcRead(getHead, isUnavailable, generation);
      if (head >= target) {
        if (held) observer?.onResumed?.({ head, target, lag: 0n, waitedMs: Math.max(0, now() - startedAt) });
        return waited;
      }
      if (!held && observer && now() - startedAt >= observer.graceMs) {
        held = true;
        observer.onHeld({ head, target, lag: target - head, waitedMs: Math.max(0, now() - startedAt) });
      }
      unavailableAttempts = 0;
    } catch (e) {
      // 429 does not trip the breaker (the endpoint is alive), but retrying it
      // every second amplifies the throttle. Preserve the boundary and use the
      // same quiet backoff as a breaker-visible outage.
      if (isAvailabilityFailure(e)) {
        waited = true;
        await pause(archiveRetryDelayMs(++unavailableAttempts));
        continue;
      }
    }
    waited = true;
    await pause(1_000);
  }
  return waited;
}

/** Compact, stable telemetry durations: precise enough to size an incident,
 *  without changing every second and defeating note deduplication. */
export function approximateDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 120_000) return `~${Math.max(1, Math.round(value / 1_000))}s`;
  if (value < 7_200_000) return `~${Math.round(value / 60_000)}m`;
  if (value < 172_800_000) return `~${Math.round(value / 3_600_000)}h`;
  return `~${(value / 86_400_000).toFixed(1)}d`;
}

/** Reference-feed starvation lifecycle for the base assets.
 *
 * A starved base asset hides its pairs (no reference rows, no bps anchors, no
 * markouts), so the warning must be LOUD — but it must also CLEAR when the feed
 * recovers. It previously did not: `noteOnce` is sticky for the process
 * lifetime, so one transient Bybit blip left prod serving "MON pairs are
 * hidden" for hours while MON quotes were visibly live. Recovery now drops the
 * stale warning and announces, same shape as the RPC breaker's snap-back note.
 *
 * Control flow is pure with injected note sinks so the transitions are
 * unit-tested without standing up a live source (see reference-notes.test.ts).
 */
export function checkReferenceStarvation(
  assets: readonly { key: string; cex: string; cexSymbol: string; symbol: string }[],
  midOf: (key: string) => number,
  starvedSince: Map<string, number>,
  now: number,
  io: { warn: (m: string) => void; clear: (m: string) => void; announce: (m: string) => void },
): void {
  for (const a of assets) {
    const warning = `${a.cex} feed has no ${a.cexSymbol} mid — ${a.symbol} pairs are hidden (reference/markouts unavailable)`;
    if (midOf(a.key) <= 0) {
      if (!starvedSince.has(a.key)) starvedSince.set(a.key, now);
      io.warn(warning);
      continue;
    }
    const since = starvedSince.get(a.key);
    if (since === undefined) continue; // healthy all along — nothing to say
    starvedSince.delete(a.key);
    // clear() must be handed the EXACT string warn() emitted, or the stale
    // warning survives the recovery — that is the bug this function exists for.
    io.clear(warning);
    const mins = Math.max(1, Math.round((now - since) / 60_000));
    io.announce(`${a.cex} feed recovered: ${a.cexSymbol} mid is back — ${a.symbol} pairs visible again (hidden for ~${mins}m)`);
  }
}

/** Consecutive empty block frames before a venue is called dark. Keep the
 *  threshold at ~10s after moving live quotes from 500ms ticks to Monad blocks. */
export const QUOTE_DARK_CYCLES = 34;

/**
 * A venue that has stopped quoting — the CORE's backstop.
 *
 * Returning no rows is how a venue leaves the Execution grid, and by itself it
 * says nothing: a venue switching itself off and an adapter whose ABI drifted
 * look identical. Adapters that can dig out a reason do (venues/quote-health.ts)
 * and this stands down for them, but the check lives here so a venue going dark
 * is reported whether or not its adapter's author thought about it — including
 * adapters not written yet.
 *
 * No time-of-day or lookback rule on purpose: "has it quoted recently" needs
 * persistence to survive a restart and then goes BLIND on exactly the long
 * outages that matter most. Emptiness is judged only against the run of empty
 * cycles, so the signal never expires. Callers gate on boot warmup (references
 * start cold) and on RPC health (during failover everything is empty and the
 * rpc.* note already explains it).
 *
 * `explained` is scoped to THIS outage: a note raised while the venue was still
 * quoting cannot be the explanation for it having stopped. state.notes is an
 * append log, not a health register — venue.quote.unavailable has eight writers
 * (this check, the core when quote() rejects, and adapters via ctx.note) and
 * none of them retract, so "the window holds that code for this venue" stays
 * true forever after anything says it once, and the backstop stood down against
 * a note describing an outage that had already ended: silent on exactly the
 * unexplained outage it exists to catch. `empty` therefore carries `since` —
 * when the venue was last seen with rows — and a note that IS about this outage
 * is raised on or after it (an adapter notes from inside the same quote() that
 * returned nothing). A venue never yet seen quoting takes any note: the window
 * only holds notes from this process, so there is no earlier outage to confuse
 * it with, and that is the boot case where the adapter speaks during warmup.
 * A plain recency window would instead go blind on a long outage.
 *
 * Recovery RETRACTS the warning as well as announcing it, like the three
 * sibling checks in this file. Not only window hygiene here: the wording is fixed (the run is always
 * QUOTE_DARK_CYCLES when it fires), so noteOnce would swallow the SECOND
 * outage's warning as a verbatim repeat of the first. `dark` therefore carries
 * the exact string raised — drop() matches on the scrubbed message, the same
 * reason gapResume stores its line rather than rebuilding it.
 */
export function checkQuoteOutage(
  venues: readonly { id: string; name: string }[],
  rowsFor: (id: string) => number,
  empty: Map<string, { runs: number; since: number }>,
  dark: Map<string, string>,
  now: number,
  io: {
    warn: (id: string, m: string) => void;
    announce: (id: string, m: string) => void;
    clear: (id: string, m: string) => void;
    explained: (id: string, since: number, except?: string) => boolean;
  },
): void {
  for (const v of venues) {
    if (rowsFor(v.id) > 0) {
      empty.set(v.id, { runs: 0, since: now }); // quoting AS OF now
      const warned = dark.get(v.id);
      if (warned === undefined) continue;
      dark.delete(v.id);
      io.clear(v.id, warned); // byte-identical to what warn() raised
      io.announce(v.id, `${v.name} is quoting again`);
      continue;
    }
    const run = empty.get(v.id) ?? { runs: 0, since: 0 }; // 0: never seen quoting
    run.runs++;
    empty.set(v.id, run);
    const warned = dark.get(v.id);
    if (warned !== undefined) {
      // The reason can arrive AFTER this check fired: Clober only names its
      // empty books once a reference warms and it has legs to price. Hand the
      // venue back to the adapter, or frameMissingVenues lists it dark until
      // it quotes again, next to the explanation. Retract without announcing:
      // it still is not quoting, and the adapter now owns the recovery note.
      if (io.explained(v.id, run.since, warned)) {
        dark.delete(v.id);
        io.clear(v.id, warned);
      }
      continue;
    }
    if (run.runs < QUOTE_DARK_CYCLES) continue;
    // The adapter already said WHY, so it owns this venue's outage telemetry
    // BOTH ways: standing down here but still marking it dark would let the
    // core announce a second, vaguer recovery alongside the adapter's own.
    if (io.explained(v.id, run.since)) continue;
    const msg = `${v.name} is not quoting — no rows for ${run.runs} consecutive cycles (venue offline, or its adapter no longer matches the contract)`;
    dark.set(v.id, msg); // only ever holds venues this check itself reported
    io.warn(v.id, msg);
  }
}

/** Which quote-capable ids the Execution tab should flag as MISSING this frame.
 *
 * The frame's `missingVenues` used to be every expected id with no row, so a
 * venue whose outage was already explained sat in amber forever: Lunarbase's
 * paused pool was listed on every frame for six weeks (2026-09), indistinguishable
 * from an adapter that broke. A venue that stopped quoting for a KNOWN reason
 * has already left the grid on purpose, and the reason is on state.notes for
 * whoever maintains it — the indicator exists for the outage nobody has
 * explained, so it is what remains after the explained ones are removed.
 *
 * "Explained" is exactly checkQuoteOutage's test — a venue.quote.unavailable
 * note for that venue raised since it was last seen quoting — with one
 * exclusion: the id must not be one the backstop itself marked dark. The
 * backstop's own warning is a venue.quote.unavailable note too, so without
 * that exclusion an UNEXPLAINED outage would drop off the indicator ten
 * seconds in, when the warning it raises about it started explaining it. The
 * references are never in `empty` (they are not venues the checker drives), so
 * they fall back to `since = 0`, and their own starvation code is not this one:
 * a cold reference stays listed. */
export function frameMissingVenues(
  expected: Iterable<string>,
  present: ReadonlySet<string>,
  empty: ReadonlyMap<string, { since: number }>,
  dark: ReadonlyMap<string, string>,
  explained: (id: string, since: number) => boolean,
): string[] {
  const out: string[] = [];
  for (const id of expected) {
    if (present.has(id)) continue;
    if (!dark.has(id) && explained(id, empty.get(id)?.since ?? 0)) continue;
    out.push(id);
  }
  return out.sort();
}

const CURVE_LAST_S = CURVE_OFFSETS_S[CURVE_OFFSETS_S.length - 1];

/** Archive-pending lifecycle for the markout re-scan (family A of #6).
 *
 * A day's CEX price archive publishes only after it closes (Bybit's book
 * archive the next morning UTC; a day's markouts also need the NEXT day's
 * file for the horizons past midnight), so the remark walk defers that day and raises a sticky `markout.archive.pending`
 * note. Like the reference-starvation warning before 6c3cf5b, that note was
 * sticky for the whole process: it kept telling maintainers "markouts resume
 * later" for hours after the archive had landed and the fills were marked.
 * Recovery now retracts the stale note on the sweep the archive publishes, then
 * announces that markouts resumed.
 *
 * The retract is keyed on the structured identity (venue, market, day). The
 * cleared string is rebuilt from those same fields, so it is byte-identical to
 * what warn() emitted. Handing clear() a different string leaves the stale note
 * behind, the exact bug this pattern exists to prevent.
 *
 * Pure with injected sinks (the async archive probe stays at the call site), so
 * the transitions are unit-tested without a live CEX dump (archive-notes.test.ts).
 */
export function checkArchivePending(
  a: { vid: string; name: string; market: string; day: string },
  published: boolean,
  pending: Set<string>,
  io: { warn: (m: string) => void; clear: (m: string) => void; announce: (m: string) => void },
): void {
  const key = `${a.vid}:${a.market}:${a.day}`;
  const warning = `${a.name} ${a.market}: CEX price archive for ${a.day} not published yet — markouts resume later`;
  if (!published) {
    pending.add(key);
    io.warn(warning);
    return;
  }
  if (!pending.delete(key)) return; // published all along: nothing to retract
  io.clear(warning);
  io.announce(`${a.name} ${a.market}: CEX price archive for ${a.day} published — markouts resumed`);
}

/** Resume the persisted tail cursor (gap-fill the hole), or cold-start at the
 * tip and LOSE every fill inside the hole.
 *
 * Resume is correct for a gap of ANY size: the windowed tail
 * (TAIL_WINDOW_BLOCKS) bounds gap-fill memory per window and commits the
 * cursor per window, so gap size only buys catch-up time. The 200k default
 * cap predates that windowing and silently dropped a ~216k-block outage hole
 * on 2026-09-17 — the fix deploy cold-started past it and the day's volume
 * stayed undercounted (POE alone lost $183k of real, on-chain swaps). The
 * cap survives only as an explicit operator brake for a range-limited RPC;
 * tripping it loses the hole's fills (warned, recoverable via
 * BACKFILL_RESET). Pure so the boundary is unit-testable (gap-fill.test.ts).
 */
export function shouldGapFill(lpb: string | undefined, head: bigint, maxBlocks: number): boolean {
  if (!lpb) return false; // first boot — nothing to resume, not a loss
  return head - BigInt(lpb) <= BigInt(maxBlocks);
}

/** Gap-fill catch-up lifecycle for the live tail (family B of #6).
 *
 * On boot the tail resumes from the persisted cursor and raises a sticky
 * `tail.resume` note naming how many blocks it has to gap-fill. That note stayed
 * on the record for the whole process, long after the tail had decoded the gap
 * and gone current. It clears once the cursor reaches the boot head the count
 * was measured against, then announces the tail is caught up.
 *
 * Singleton state (one tail cursor serves the indexer), so the holder carries a
 * single outstanding message rather than a per-key map. The count is fixed at
 * boot while the cursor keeps moving, so the caller stores the emitted string and
 * replays it verbatim to clear(). Rebuilding it from the moved cursor would miss,
 * leaving the stale note behind.
 *
 * Pure with injected sinks, unit-tested without a live tail (gap-fill.test.ts).
 */
export function checkGapFill(
  lastBlock: bigint,
  target: bigint,
  state: { msg?: string },
  io: { clear: (m: string) => void; announce: (m: string) => void },
): void {
  if (state.msg === undefined || lastBlock < target) return;
  io.clear(state.msg);
  state.msg = undefined;
  // name the TARGET the gap was measured to, not a position: the cursor has
  // already moved past it by the time we get here (lastBlock >= target), so
  // "current at block target" would report a block the tail has left behind.
  io.announce(`gap-fill caught up: decoded through block ${target}`);
}

/**
 * Day-stamp the fills of one replay chunk with the fewest block reads that
 * still put every fill on the right UTC day.
 *
 * The replay used to take ONE timestamp per chunk: a chunk spans ≤ 800 blocks
 * (≈ 4 min), so for daily bucketing any block's time was good enough — except
 * for the one chunk per day that straddles midnight, whose fills all landed on
 * the day of its anchor block. That put up to a chunk's worth of swaps on the
 * wrong day (68 Metric swaps at the 09-18→19 boundary when Sep 17–20 were
 * replayed on 2026-09-21), and it made a replayed day disagree with the same
 * day as the live tail had counted it — the tail stamps every fill's own block.
 * Totals were conserved; the days were not.
 *
 * So: read the first and last log blocks. Same day (every chunk but one per
 * day) → one stamp for all, as before. Different days → bisect the distinct
 * log blocks for the first one on the later day, O(log n) reads, and stamp
 * each side with its own end. A chunk cannot straddle two midnights (that
 * would be a 24h chain stall inside 800 blocks), so two days are enough.
 *
 * `tsOf` is the caller's retried block-time read (ms). A block it cannot
 * resolve is stepped over — the anchor walks forward, the tail walks back, a
 * bisect probe walks toward the tail — because a range-cap RPC can return a
 * log for a block it momentarily 404s, and one such block must never abort a
 * multi-million-block replay. An AVAILABILITY failure (breaker open, mixed
 * providers) is rethrown untouched: the chunk must be held intact and
 * re-fetched, never stamped from a partial provider view. Returns null only
 * when no block at all resolves (the caller skips the chunk, loudly).
 */
export async function stampChunkDays(
  blocks: readonly bigint[], // distinct, ascending
  tsOf: (bn: bigint) => Promise<number>,
  dayOf: (ms: number) => string = utcDay,
): Promise<((bn: bigint) => number) | null> {
  const known = new Map<bigint, number>();
  const read = async (bn: bigint): Promise<number | undefined> => {
    const hit = known.get(bn);
    if (hit !== undefined) return hit;
    try { const ms = await tsOf(bn); known.set(bn, ms); return ms; }
    catch (e) { if (isAvailabilityFailure(e)) throw e; return undefined; }
  };
  // anchor: the first block that resolves, walking forward.
  let lo = 0, loMs: number | undefined;
  for (; lo < blocks.length; lo++) { loMs = await read(blocks[lo]); if (loMs !== undefined) break; }
  if (loMs === undefined) return null;
  // tail: the last block that resolves, walking back (stopping at the anchor).
  let hi = blocks.length - 1, hiMs: number | undefined;
  for (; hi > lo; hi--) { hiMs = await read(blocks[hi]); if (hiMs !== undefined) break; }
  const anchorMs = loMs;
  if (hi <= lo || hiMs === undefined || dayOf(hiMs) === dayOf(anchorMs)) return () => anchorMs;
  // straddles midnight: find the first block on the later day.
  const day0 = dayOf(anchorMs);
  // Invariant: blocks[lo] is on day0 and blocks[hi] on the later day; the
  // resolved probe becomes the new bound on its own side.
  while (hi - lo > 1) {
    let probe = (lo + hi) >> 1;
    let ms = await read(blocks[probe]);
    // an unresolvable probe steps toward the tail; if every block between is
    // unresolvable the bracket stands and those blocks stamp with the anchor,
    // exactly what the one-stamp replay did for them.
    while (ms === undefined && probe + 1 < hi) ms = await read(blocks[++probe]);
    if (ms === undefined) break;
    if (dayOf(ms) === day0) lo = probe; else hi = probe;
  }
  const boundary = blocks[hi], laterMs = hiMs;
  return (bn) => (bn >= boundary ? laterMs : anchorMs);
}

/**
 * The first UTC day the fills onboarding scan covers for a venue: its rolling
 * window, floored at the venue's own first day. Shared with the scan itself so
 * the reset's delete boundary and the scan's start can never drift apart —
 * that drift is silent data loss, since anything deleted below the start is
 * never re-inserted.
 */
export function fillsScanFromDay(backfillFromUtc: string | undefined, nowMs: number, windowDays: number): string {
  const since = utcDay(nowMs - windowDays * 86_400_000);
  return backfillFromUtc && backfillFromUtc > since ? backfillFromUtc : since;
}

/**
 * What a reset may delete — "exactly what the replay will restore", decided in
 * one place.
 *
 * Two tables, two windows, because the scans differ: the volume backfill
 * replays a venue's whole lifetime (or from a targeted day, day-ALIGNED),
 * while the fills onboarding only ever covers its rolling window. A single
 * shared window is what made the lifetime reset delete fills nothing put back.
 *
 * A disabled stage yields NO delete for its table, and its done-flag/cursor stay
 * untouched too. Re-arming a disabled stage without clearing its rows would
 * only recreate the merge-only bug on a later boot; the operator must re-run
 * the reset with that stage enabled. TODAY is excluded for the same reason: it
 * belongs to the live tail and neither scan writes it, so a mid-day reset that
 * dropped it would erase what had already been counted since midnight. Today
 * is re-read instead (rereadToday), SET against the tail's own cursor.
 *
 * The fills boundary is the scan's own resume point: backfillRecentFills takes
 * `max(window start, cursor)`, so a targeted start LATER than the window wins
 * and is matched by block; otherwise the window start does, matched by day. A
 * targeted start on the window's first day still uses its block, which is at
 * or after that day's first block either way.
 */
export function planVenueReset(opts: {
  from?: { block: bigint; day: string };
  fillsFromDay: string;
  /** the current UTC day — the exclusive upper bound on both deletes */
  today: string;
  volumeEnabled: boolean;
  fillsEnabled: boolean;
}): ResetDeletes {
  const { from, fillsFromDay, today, volumeEnabled, fillsEnabled } = opts;
  const deletes: ResetDeletes = { beforeDay: today };
  if (volumeEnabled) deletes.volume = { fromDay: from?.day };
  if (fillsEnabled) {
    deletes.fills = from !== undefined && from.day >= fillsFromDay
      ? { fromBlock: from.block }
      : { fromDay: fillsFromDay };
  }
  return deletes;
}

/**
 * Drop a venue from the in-memory day mirror, scoped exactly like the store
 * delete it accompanies. The store is not the only copy: `days` is what the
 * snapshot writes back, so a row deleted only in SQLite returns on the next
 * persist — and a row cleared only in memory persists a zero over history the
 * replay never revisits. `byVenue` absent = 0 (@shared: DailyVolume).
 */
export function purgeVenueDays(days: DailyVolume[], vid: string, deletes: ResetDeletes): void {
  const { volume, beforeDay } = deletes;
  if (!volume) return;                       // the store kept these rows too
  for (const d of days) {
    if (d.utcDay >= beforeDay) continue;                                  // today: the tail owns it
    if (volume.fromDay === undefined || d.utcDay >= volume.fromDay) delete d.byVenue[vid];
  }
}

/** Remove deleted DB fills from every in-memory owner too. Otherwise the
 * `/api/markets` ring keeps serving stale rows and a pending/dirty fill can be
 * written straight back on the next snapshot. */
export function purgeVenueFills(
  state: { fills: Fill[]; pending: Set<Fill>; dirty: Set<Fill>; countedIds: Set<string> },
  vid: string,
  deletes: ResetDeletes,
): void {
  const fillDelete = deletes.fills;
  if (!fillDelete) return;
  const beforeMs = Date.parse(`${deletes.beforeDay}T00:00:00Z`);
  const fromMs = 'fromDay' in fillDelete
    ? Date.parse(`${fillDelete.fromDay}T00:00:00Z`)
    : 0;
  const dropped = (f: Fill) => f.venueId === vid && f.ts < beforeMs && (
    'fromBlock' in fillDelete ? BigInt(f.blockNumber) >= fillDelete.fromBlock : f.ts >= fromMs
  );
  const ids = new Set<string>();
  for (const f of state.fills) if (dropped(f)) ids.add(f.id);
  for (const set of [state.pending, state.dirty]) {
    for (const f of set) if (dropped(f)) { ids.add(f.id); set.delete(f); }
  }
  state.fills.splice(0, state.fills.length, ...state.fills.filter((f) => !dropped(f)));
  for (const id of ids) state.countedIds.delete(id);
}

/** A closed day whose stored, non-zero swap count the boot reconcile rewrote. */
export interface SwapCountChange { venueId: string; utcDay: string; from: number; to: number }

/**
 * SET each day's per-venue swap count to its retained-fills count, and return
 * the rewrites that were EVIDENCE: a closed day whose stored count was
 * non-zero and differed.
 *
 * The rewrite only ever fixes the count. A replay that booked fills onto the
 * wrong day moved their USD too, and that stays wrong, so a silent rewrite
 * hides the only sign of it: the next boot sees a consistent day. The
 * 2026-09-21 replay booked 12 clober-vault fills a day early; this rewrite
 * quietly took 09-18/09-19 from 503/689 to 491/701 while USD stayed ±$1,268
 * off for three weeks.
 *
 * A stored 0 is not evidence: it marks a day whose volume we have but not its
 * count (subgraph seed, or a row a reset deleted that the replay has not
 * rebuilt yet). Filling it in is this rewrite's job. Today is the live
 * tail's, mid-accrual by definition.
 */
export function reconcileDaySwaps(
  days: DailyVolume[],
  counts: Iterable<{ utcDay: string; venueId: string; swaps: number }>,
  today: string,
): SwapCountChange[] {
  const byDay = new Map<string, Map<string, number>>();
  for (const c of counts) {
    let m = byDay.get(c.utcDay); if (!m) { m = new Map(); byDay.set(c.utcDay, m); }
    m.set(c.venueId, c.swaps);
  }
  const changed: SwapCountChange[] = [];
  for (const d of days) {
    const m = byDay.get(d.utcDay);
    if (!m) continue;
    for (const [venueId, swaps] of m) {
      const vd = (d.byVenue[venueId] ??= { usd: 0, swaps: 0 });
      if (d.utcDay < today && vd.swaps > 0 && vd.swaps !== swaps) changed.push({ venueId, utcDay: d.utcDay, from: vd.swaps, to: swaps });
      vd.swaps = swaps;
    }
  }
  return changed;
}

/** Which of a venue's day rows a queued reset will re-SET: a chain replay
 *  from its start on, or a 'fills' revision over [day, until). */
export type ResetStart =
  | { from: 'lifetime' } | { from: 'block'; block: bigint } | { from: 'day'; day: string }
  | { from: 'fills'; day: string; until: string };

/** A venue's history stages that will still re-SET day rows, read from meta
 *  (the boot reconcile runs before the first block read). */
export interface VenueRebuild {
  /** queued resets that will re-SET day rows */
  resets: ResetStart[];
  /** unfinished volume replay; it resumes at the start of the day holding
   *  `cursor` (absent = from its first day) */
  volume?: { cursor?: bigint };
}

/**
 * The first day whose stored fills may be INCOMPLETE while a venue's fills
 * onboarding is unfinished (or never ran: MARKOUT_BACKFILL off leaves the
 * table tail-only, starting mid-day). The reconcile leaves these days alone:
 * the fills are not the authority there yet. Rewriting from them would write
 * an undercount, and since onboarding writes no day row, nothing would bring
 * the stored count back for a later boot to compare once the fills are whole.
 *
 * Fills are complete below `cursor`, but it is not day-aligned and the days
 * past it may hold no fills at all (a reset deleted them). So the day it sits
 * in is taken to be the newest day with a fill below it. Where the cursor is
 * in fact on a later day, that day is complete and merely waits: skipping
 * keeps evidence for a later boot, it never erases it. With no cursor the scan
 * restarts at its window start `fromDay`, which is also a floor: the scan
 * never reaches earlier days.
 */
export function fillsIncompleteFrom(
  spans: ReadonlyMap<string, { minBlock: number }>,
  onboarding: { cursor?: bigint; fromDay: string },
): string {
  let from = onboarding.fromDay;
  const { cursor } = onboarding;
  if (cursor !== undefined) for (const [day, s] of spans) if (BigInt(s.minBlock) < cursor && day > from) from = day;
  return from;
}

/**
 * Whether a pending stage will still re-SET this (venue, day)'s row. The
 * reconcile leaves such a day alone, since rewriting it now would make the
 * day look consistent whatever the stage then did. A stage that applies
 * replaces the row, and the boot after judges the result. One that is
 * refused is stamped settled, so the boot after finds the stored count, and
 * with it the evidence, and warns. A 'fills' revision that is HELD stays
 * queued, so its days stay as stored: it holds because the window's fills
 * fail conservation, i.e. fills are missing, and a rewrite from them would
 * write an undercount. Its own backfill.config.invalid warning, raised every
 * boot, is the signal there.
 *
 * Scoped per DAY: a day is placed against a stage's start by the block span
 * of its fills (`maxBlock`), erring toward judging the day where the span
 * cannot tell:
 *  - a queued chain reset re-SETs from its start day; a block start counts
 *    only once one of the day's fills is at or past it. A 'fills' revision
 *    re-SETs only its [day, until) window;
 *  - an unfinished volume replay checkpoints the day it is in with a partial
 *    total and re-scans it from its start, so exactly the days with a fill at
 *    or past its cursor are still to be SET.
 */
export function pendingReSet(day: { utcDay: string; maxBlock: number }, pending: VenueRebuild): boolean {
  const d = day.utcDay;
  const top = BigInt(day.maxBlock);
  const covers = (r: ResetStart): boolean => {
    switch (r.from) {
      case 'lifetime': return true;
      case 'day': return d >= r.day;
      case 'fills': return d >= r.day && d < r.until;
      case 'block': return top >= r.block;
    }
  };
  if (pending.resets.some(covers)) return true;
  return !!pending.volume && (pending.volume.cursor === undefined || top >= pending.volume.cursor);
}

/** A venue's rewritten counts summed, signed ("+3", "-3", "0"). 0 is the
 *  signature of fills booked on the wrong day; any other net, of fills
 *  missing or doubled. */
export function swapNet(changes: readonly SwapCountChange[]): string {
  const net = changes.reduce((s, c) => s + c.to - c.from, 0);
  return net > 0 ? `+${net}` : String(net);
}

/**
 * `head` followed by the changes ("2026-09-18 503→491", day order), as many
 * as fit in `max` with the rest counted ("+3 more"). Budgeted against the
 * WHOLE message, not a fixed count: the head's length varies with the day
 * count and net, and scrubNote cuts anything past NOTE_MSG_MAX mid-entry. So
 * everything a reader must not lose goes in `head`, and the list absorbs the
 * squeeze by whole entries.
 */
export function swapNoteMsg(head: string, changes: readonly SwapCountChange[], max = NOTE_MSG_MAX): string {
  const items = [...changes]
    .sort((a, b) => (a.utcDay < b.utcDay ? -1 : a.utcDay > b.utcDay ? 1 : 0))
    .map((c) => `${c.utcDay} ${c.from}→${c.to}`);
  const fit = (shown: number) => head + [...items.slice(0, shown), ...(shown < items.length ? [`+${items.length - shown} more`] : [])].join(', ');
  let shown = items.length;
  while (shown > 0 && fit(shown).length > max) shown--;
  return fit(shown);
}

/** Fields that make two decodes the SAME fill. Attribution labels (category,
 *  `to`, router) are excluded: they are best-effort enrichment a second pass
 *  can label differently, and replacing a live fill over a label would throw
 *  away its markouts and curve for nothing. */
function sameFill(a: Fill, b: Fill): boolean {
  return a.ts === b.ts && a.blockNumber === b.blockNumber && a.venueId === b.venueId && a.market === b.market
    && a.side === b.side && a.usd === b.usd && a.baseAmount === b.baseAmount && a.execPx === b.execPx
    && !!a.pxApprox === !!b.pxApprox && a.txHash === b.txHash && a.pool === b.pool;
}

/**
 * Converge one venue's fills over a re-read range onto the current decode.
 *
 * `total` is the venue's exact day bucket over the range — a SET, like the
 * closed-day replay, never an increment: the tail decoded the same range with
 * the previous build, and its count is precisely what is being replaced.
 *
 * A fill decoded identically is left alone (it keeps the markouts and curve the
 * tail captured live, which no archive can restore for today); a changed one
 * is deleted and re-inserted; a stored one the decode no longer produces is
 * deleted. Pure so the convergence rules are unit-testable (history-revisions.test.ts).
 */
export function planReread(stored: readonly Fill[], decoded: readonly Fill[]): {
  deleteIds: string[]; insert: Fill[]; total: { usd: number; swaps: number };
} {
  const byId = new Map<string, Fill>();
  for (const f of decoded) byId.set(f.id, f);   // a re-tailed duplicate collapses
  const kept = new Set<string>();
  const deleteIds: string[] = [];
  for (const s of stored) {
    const d = byId.get(s.id);
    if (d && sameFill(s, d)) kept.add(s.id);
    else deleteIds.push(s.id);
  }
  const insert = [...byId.values()].filter((f) => !kept.has(f.id));
  let usd = 0;
  for (const f of byId.values()) usd += f.usd;
  return { deleteIds, insert, total: { usd, swaps: byId.size } };
}

/**
 * Fold re-read fills into the recent-fill ring: ts order, newest `cap` kept.
 * Reports which inserted fills made it in (their dedup ids and markout aging
 * start now) and which ring members fell out (their dedup ids go, exactly as
 * ingest's own eviction drops them). Pure (history-revisions.test.ts).
 */
export function mergeIntoRing(ring: readonly Fill[], inserted: readonly Fill[], cap: number): {
  ring: Fill[]; added: Fill[]; evicted: Fill[];
} {
  if (!inserted.length) return { ring: [...ring], added: [], evicted: [] };
  const fresh = new Set(inserted);
  const all = [...ring, ...inserted].sort((a, b) => a.ts - b.ts || a.blockNumber - b.blockNumber);
  const cut = Math.max(0, all.length - cap);
  const kept = all.slice(cut);
  return {
    ring: kept,
    added: kept.filter((f) => fresh.has(f)),
    evicted: all.slice(0, cut).filter((f) => !fresh.has(f)),
  };
}

/**
 * An adapter's declared HistoryRevisions as reset targets — the same pipeline
 * BACKFILL_RESET feeds, with a marker of their own.
 *
 * The marker is per REVISION (`history_revision_<vid>_<id>`), not the env
 * reset's per-venue key: sharing that key, applying a revision would read as
 * a changed BACKFILL_RESET entry and re-run the operator's reset, and vice
 * versa. The marker's value is the entry's text, so editing an applied entry
 * re-runs it — adding a new id is the clearer way to ask for that.
 *
 * Starts are UTC days only (a block number means nothing in review) and ids
 * must be unique: two entries sharing a marker would overwrite each other's
 * record and re-run on every boot. Either mistake comes back `invalid`, which
 * the apply pass reports loudly on every boot WITHOUT stamping (a stamp could
 * land on a shared marker) — and history-revisions.test.ts fails on.
 *
 * A 'fills' revision needs both ends as days, `from` < `until`. An `until` on
 * a chain replay is invalid rather than ignored: the replay cannot stop
 * there, and a reader would assume it does. A 'markets' revision needs a day
 * `from` and registered market symbols, and takes no `until` (it ends on the
 * day it first runs); `markets` on any other source is invalid, since only
 * 'markets' would scope anything by them.
 */
export function revisionTargets(vid: string, revisions: readonly HistoryRevision[] | undefined): BackfillResetTarget[] {
  const uses = new Map<string, number>();
  for (const r of revisions ?? []) uses.set(r.id.trim(), (uses.get(r.id.trim()) ?? 0) + 1);
  return (revisions ?? []).map((r) => {
    const id = r.id.trim();
    const marker = `history_revision_${vid}_${id}`;
    // EVERY occurrence of a shared id is invalid, the first included: a valid
    // first one would apply, and the invalid twin would still share its marker.
    const badId = !/^[\w.-]+$/.test(id) || (uses.get(id) ?? 0) > 1;
    if (r.source === 'fills') {
      const spec = `${vid}#${id}:fills:${r.from ?? ''}..${r.until ?? ''}`;
      const ok = !badId && r.from !== undefined && r.until !== undefined
        && isUtcDay(r.from) && isUtcDay(r.until) && r.from < r.until;
      return ok && r.markets === undefined
        ? { vid, spec, marker, from: 'fills' as const, day: r.from!, until: r.until! }
        : { vid, spec, marker, from: 'invalid' as const };
    }
    if (r.source === 'markets') {
      const markets = [...new Set((r.markets ?? []).map((m) => m.trim()))].sort();
      const spec = `${vid}#${id}:markets:${r.from ?? ''}:${markets.join(',')}`;
      const ok = !badId && r.from !== undefined && isUtcDay(r.from) && r.until === undefined
        && markets.length > 0 && markets.every((m) => !!pairOf(m));
      return ok
        ? { vid, spec, marker, from: 'markets' as const, day: r.from!, markets }
        : { vid, spec, marker, from: 'invalid' as const };
    }
    const spec = `${vid}#${id}:${r.from ?? 'lifetime'}`;
    const [parsed] = parseBackfillReset(r.from === undefined ? vid : `${vid}:${r.from}`);
    if (badId || r.until !== undefined || r.markets !== undefined || (r.source !== undefined && r.source !== 'chain')
      || !parsed || parsed.from === 'block' || parsed.from === 'invalid') {
      return { vid, spec, marker, from: 'invalid' as const };
    }
    return { ...parsed, spec, marker };
  });
}

/** Fills of `vid` in [fromMs, toMs) that are not in the table yet: queued
 *  for the next snapshot (`dirty`, the persistence queue — NOT `pending`,
 *  the markout-aging queue, which a fill past its last horizon never joins),
 *  or inside a snapshot that has not committed. A 'fills' revision summing
 *  the table without them would undercount their day for good. */
export function unpersistedFillsIn(
  owners: { dirty: Iterable<Fill>; inflight: Iterable<readonly Fill[]> },
  vid: string,
  fromMs: number,
  toMs: number,
): number {
  const inWindow = (f: Fill) => f.venueId === vid && f.ts >= fromMs && f.ts < toMs;
  const ids = new Set<string>();
  for (const f of owners.dirty) if (inWindow(f)) ids.add(f.id);
  for (const batch of owners.inflight) for (const f of batch) if (inWindow(f)) ids.add(f.id);
  return ids.size;
}

/** How far a 'fills' window's stored total may drift from its fills' total.
 *  Moving fills between days conserves the sum exactly for stable-quoted
 *  pairs; cross pairs carry the gap between the two times they were priced
 *  (0.01% across hanji's 2026-09-17..19). A larger gap means fills are
 *  missing, and SETting the days from them would destroy volume. */
export const FILLS_REVISION_TOLERANCE = 0.005;

/**
 * Decide a 'fills' history revision: SET each venue-day in [from, until) to
 * the sum of its retained fills, or say why not. Pure so every refusal is
 * unit-testable (fills-revision.test.ts).
 *
 *  - 'wait' (not stamped, re-checked next pass): the window is not closed
 *    yet; the venue's volume or fills scan is still running (a pending
 *    replay will rewrite these days, or the fills are still partial); or
 *    fills in the window are not persisted yet.
 *  - 'refuse' (stamped, warned): the window starts before fills retention.
 *    Pruned days can never be summed. A database that young (fresh, or a dev
 *    copy) built those days with the current replay anyway.
 *  - 'hold' (not stamped, warned, re-checked next boot): the stored total and
 *    the fills total disagree beyond FILLS_REVISION_TOLERANCE. That is missing
 *    fills, not misbucketed ones, and needs a human.
 */
export function planFillsRevision(opts: {
  from: string;
  /** exclusive */
  until: string;
  today: string;
  /** the first UTC day fills retention still keeps whole */
  retainedFrom: string;
  /** the venue's volume backfill AND fills onboarding are both done */
  scansDone: boolean;
  /** in-memory fills in the window that are not yet persisted */
  unpersisted: number;
  /** the venue's stored day buckets in the window (absent = no row) */
  stored: ReadonlyMap<string, { usd: number; swaps: number }>;
  /** the venue's fills summed per own-timestamp day over the window */
  fills: ReadonlyMap<string, { usd: number; swaps: number }>;
}):
  | { action: 'wait' | 'refuse' | 'hold'; reason: string }
  | { action: 'apply'; days: Array<{ utcDay: string; usd: number; swaps: number; was?: { usd: number; swaps: number } }> } {
  const { from, until, today, retainedFrom, stored, fills } = opts;
  if (until > today) return { action: 'wait', reason: `window ends ${until}, which has not closed yet (today is ${today})` };
  if (from < retainedFrom) {
    return { action: 'refuse', reason: `window starts ${from}, before fills retention (${retainedFrom}): those fills are pruned, so the days cannot be re-derived` };
  }
  if (!opts.scansDone) return { action: 'wait', reason: 'the venue\'s volume backfill or fills onboarding is still running' };
  if (opts.unpersisted > 0) return { action: 'wait', reason: `${opts.unpersisted} fill(s) in the window are not persisted yet` };
  let storedUsd = 0, fillsUsd = 0;
  for (const v of stored.values()) storedUsd += v.usd;
  for (const v of fills.values()) fillsUsd += v.usd;
  const drift = Math.abs(storedUsd - fillsUsd);
  if (drift > 0.01 && drift > FILLS_REVISION_TOLERANCE * Math.max(storedUsd, fillsUsd)) {
    return {
      action: 'hold',
      reason: `stored $${storedUsd.toFixed(2)} vs fills $${fillsUsd.toFixed(2)} over the window: re-bucketing conserves the total, so fills are missing — not applied`,
    };
  }
  const days = [...new Set([...stored.keys(), ...fills.keys()])]
    .filter((d) => d >= from && d < until)
    .sort()
    .map((utcDay) => ({ utcDay, ...(fills.get(utcDay) ?? { usd: 0, swaps: 0 }), was: stored.get(utcDay) }));
  return { action: 'apply', days };
}

/**
 * The last day a 'markets' revision adds to: the days the PREVIOUS build
 * decoded, which nothing else will recount.
 *
 * It starts as the day the revision first runs. That day's hours before the
 * deploy were decoded without the markets, its hours after by this build's
 * tail (whose fills the held check skips). Where the venue's volume replay is
 * unfinished, every day from the one it resumes on is SET by this build, the
 * markets included, so the window ends the day before. A fresh database
 * (replay not started) therefore ends it before it begins. Re-checked every
 * run: a chain reset landing while the revision waits rewinds the replay, and
 * the window shrinks with it. It never grows. Pure (history-revisions.test.ts).
 */
export function marketsRevisionThrough(opts: {
  /** persisted by an earlier run; absent on the first */
  through?: string;
  today: string;
  /** the venue's volume replay: finished (or none), or the day it resumes on */
  replay: { done: true } | { done: false; resumeDay: string };
}): string {
  let through = opts.through ?? opts.today;
  if (!opts.replay.done) {
    const dayBefore = utcDay(Date.parse(`${opts.replay.resumeDay}T00:00:00Z`) - 86_400_000);
    if (dayBefore < through) through = dayBefore;
  }
  return through;
}

/**
 * What one scanned range of a 'markets' revision adds: the listed markets'
 * fills that are not held yet, summed per own-timestamp day.
 *
 * A HELD fill (stored, or still queued for the store) was decoded by this
 * build and is already in its day. Adding it again would count it twice. A
 * new fill is added to its day wherever it falls, but inserted only inside
 * retention (`retainedFromMs`): an older row would just be pruned. Pure
 * (history-revisions.test.ts).
 */
export function planMarketsAdd(
  fills: readonly Fill[],
  markets: ReadonlySet<string>,
  held: (id: string) => boolean,
  retainedFromMs: number,
): { days: Map<string, { usd: number; swaps: number }>; insert: Fill[]; held: number } {
  const days = new Map<string, { usd: number; swaps: number }>();
  const insert: Fill[] = [];
  const seen = new Set<string>();
  let heldCount = 0;
  for (const f of fills) {
    if (!markets.has(f.market) || seen.has(f.id)) continue;   // a re-tailed duplicate collapses
    seen.add(f.id);
    if (held(f.id)) { heldCount++; continue; }
    const day = utcDay(f.ts);
    const d = days.get(day) ?? { usd: 0, swaps: 0 };
    d.usd += f.usd; d.swaps += 1;
    days.set(day, d);
    if (f.ts >= retainedFromMs) insert.push(f);
  }
  return { days, insert, held: heldCount };
}

/** A 'markets' revision's running total, persisted with its cursor so the
 *  applied note reports every pass, not just the last one. */
export function parseMarketsAdded(v: string | undefined): { swaps: number; usd: number } {
  try {
    const o = JSON.parse(v ?? '');
    if (Number.isFinite(o?.swaps) && Number.isFinite(o?.usd)) return { swaps: o.swaps, usd: o.usd };
  } catch { /* unset */ }
  return { swaps: 0, usd: 0 };
}

/**
 * A today re-read that a restart carried past midnight: its day is CLOSED now,
 * so it is no longer the tail's — the closed-day replay owns it. It comes back
 * as an ordinary reset from that day (which re-reads the new today as well).
 * Its marker is the pending re-read itself: queuing the new today's re-read
 * overwrites it, which is what records this one as applied.
 */
export function carriedRereadTarget(vid: string, pendingDay: string | undefined, today: string): BackfillResetTarget | null {
  if (!pendingDay || pendingDay >= today) return null;
  return { vid, spec: pendingDay, marker: rereadKey(vid), carried: true, from: 'day', day: pendingDay };
}

/** The pending today re-read for a venue: its UTC day, cleared in the same
 *  snapshot that commits the re-read's day bucket. */
export const rereadKey = (vid: string) => `reread_day_${vid}`;

/**
 * Why a reset names a venue this boot cannot resolve to a running adapter.
 *
 *  - 'inactive'  — a real adapter venue the VENUES filter sat out (the adapter
 *    dev loop). The reset must stay PENDING: stamping it applied would consume
 *    it against a subset boot and skip it forever on a full one. Same rule
 *    allVenueIds() exists for on the DB-reconciliation side.
 *  - 'reference' — a CEX benchmark. It has no adapter, no backfill and no rows
 *    of its own, so it can never be reset; asking again would not help.
 *  - 'unknown'   — not in the code at all, i.e. a typo.
 */
export function classifyMissingResetVenue(
  vid: string,
  allAdapterIds: ReadonlySet<string>,
  referenceIds: ReadonlySet<string>,
): 'inactive' | 'reference' | 'unknown' {
  if (allAdapterIds.has(vid)) return 'inactive';
  if (referenceIds.has(vid)) return 'reference';
  return 'unknown';
}

/**
 * Has this entry already been applied?
 *
 * Keyed on the ENTRY's own text, never the whole BACKFILL_RESET value: keyed
 * on the value, appending a venue to the list — or bumping one venue's nonce —
 * would re-run the destructive replay for every venue already done. Entry text
 * is trimmed by the parser, so padding cannot masquerade as a change either.
 */
export function resetAlreadyApplied(store: Pick<VolumeStore, 'getMeta'>, t: BackfillResetTarget): boolean {
  if (!t.vid) return false;
  const v = store.getMeta(resetMarker(t));
  // a carried re-read is pending while its marker still names its day
  return t.carried ? v !== t.spec : v === t.spec;
}

/** where an entry's applied-record lives */
export function resetMarker(t: BackfillResetTarget): string {
  return t.marker ?? `backfill_reset_applied_${t.vid}`;
}

/** Record an entry as finished — done, or refused for a reason that will still
 *  hold next boot. An entry with no parseable venue id has nowhere to record. */
export function markResetApplied(store: Pick<VolumeStore, 'setMeta'>, t: BackfillResetTarget): void {
  if (t.vid && !t.carried) store.setMeta(resetMarker(t), t.spec);
}

/**
 * One-time adoption of the legacy reset marker.
 *
 * A single global key used to record the applied VALUE. Per-venue keys are
 * authoritative now, so the first boot on this code has none — and without
 * adoption every entry of a value that was ALREADY applied would run again.
 * For a destructive replay that makes upgrading the binary itself a reset,
 * which is the worst possible surprise from a deploy that changed no config.
 *
 * Gated by its own flag rather than by the legacy key, because the legacy key
 * keeps being written as a rollback breadcrumb: re-reading it every boot would
 * re-adopt the current value and stamp entries that had legitimately deferred.
 *
 * A value that was only PARTLY applied under the old code adopts as fully
 * applied. That is what the old marker already meant — the unapplied entry was
 * lost then too — so adoption preserves the status quo rather than repairing
 * it, and a re-run is one value change away.
 */
export function adoptLegacyResetMarker(
  store: Pick<VolumeStore, 'getMeta' | 'setMeta'>,
  want: string,
  entries: readonly { vid: string; spec: string }[],
): void {
  if (store.getMeta('backfill_reset_migrated') === '1') return;
  if (store.getMeta('backfill_reset_applied') === want) {
    // each venue adopts ITS OWN entry, matching what settle() will write
    for (const e of entries) if (e.vid) store.setMeta(`backfill_reset_applied_${e.vid}`, e.spec);   // its OWN entry
  }
  store.setMeta('backfill_reset_migrated', '1');
}

export function resetVenueHistory(
  store: Pick<VolumeStore, 'resetVenueHistory'>,
  vid: string,
  /** `from` moves the cursors (omitted = whole lifetime); `deletes` says which
   *  rows may go. Build `deletes` with planVenueReset — hand-rolling it is how
   *  a delete stops matching the replay that has to restore it. */
  plan: { from?: { block: bigint; day: string }; deletes: ResetDeletes },
): { volume: number; fills: number } {
  // Drop what the venue already has BEFORE re-scanning. mergeBackfill only
  // writes days it decoded fills in, so a merge-only reset can raise a venue's
  // history but never lower it: any day that stops producing fills keeps its
  // stale number. Clearing first is what makes a reset a true replay.
  // The matching cursor resets are inside the store transaction. Separating
  // them would let a crash strand deleted rows behind a still-set done-flag.
  return store.resetVenueHistory(vid, plan.deletes, plan.from?.block);
}

/** One parsed entry. `spec` is that entry's own raw text — NOT the whole
 *  BACKFILL_RESET value — because it is what the venue's one-shot marker is
 *  keyed on: keyed on the whole value, adding a venue to the list would re-run
 *  the destructive replay for every venue already done. */
export type BackfillResetTarget = {
  vid: string;
  spec: string;
  /** meta key recording the entry as applied (value = `spec`); unset = the env
   *  reset's per-venue key. HistoryRevisions and carried re-reads have their own. */
  marker?: string;
  /** a carried today re-read (carriedRereadTarget): settled by re-queuing, never stamped */
  carried?: boolean;
} & (
  | { from: 'lifetime' }
  | { from: 'block'; block: bigint }
  | { from: 'day'; day: string }
  /** a 'fills' HistoryRevision: re-derive [day, until) from retained fills */
  | { from: 'fills'; day: string; until: string }
  /** a 'markets' HistoryRevision: add these markets' history from `day` */
  | { from: 'markets'; day: string; markets: string[] }
  | { from: 'invalid' }
);

/** Date.parse normalizes impossible dates (2026-02-30 becomes March 2), which
 * is too permissive for a destructive operator command. */
function isUtcDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && utcDay(ms) === day;
}

/** Pair a resolved block with the block's real UTC day. A requested day can
 * land later after a chain halt, and delete scopes must follow what the replay
 * actually starts from rather than the calendar text the operator entered. */
export function resetStartFromBlock(block: bigint, timestampSec: bigint | number): { block: bigint; day: string } {
  return { block, day: utcDay(Number(timestampSec) * 1000) };
}

/**
 * Why a reset start cannot be applied, or null when it can — everything
 * knowable WITHOUT touching the chain.
 *
 * A start in the future does not fail loudly on its own; each form quietly
 * becomes head-anchored instead. `eth_getBlock` on a block that does not exist
 * yet throws, which reports an operator typo as an RPC fault. And
 * `blockAtOrAfter` converges to `hi` for a future day (chain/rpc.ts), so a
 * `block > bootHead` test waves it through — the block EQUALS head rather than
 * exceeding it. Either way the reset is reported as applied while it clears
 * nothing and re-scans nothing, and the one-shot marker is spent on it.
 *
 * Checked before resolving so the refusal names the real mistake, and so a
 * typo costs no RPC. TODAY is a valid start: it re-reads today's prefix (the
 * part the tail decoded with the previous build) and touches no closed day.
 */
export function refuseResetStart(t: BackfillResetTarget, today: string, bootHead: bigint): string | null {
  if (t.from === 'block' && bootHead > 0n && t.block > bootHead) {
    return `start ${t.block} is past head ${bootHead} — skipped rather than replaying the lifetime`;
  }
  if (t.from === 'day' && t.day > today) {
    return `start ${t.day} is in the future (today is ${today}) — skipped rather than anchoring the replay to head`;
  }
  if (t.from === 'markets' && t.day > today) {
    return `start ${t.day} is in the future (today is ${today}) — there is no history to add`;
  }
  return null;
}

/**
 * The same question for a start only knowable after the chain answered: a RAW
 * block carries no day until eth_getBlock resolves one.
 *
 * A start landing on today is valid — a today-only re-read, as for a day start
 * (refuseResetStart) — and it re-reads the WHOLE day from midnight: a superset
 * of the block asked for, and the only range whose day bucket can be SET.
 */
export function refuseResolvedStart(
  from: { block: bigint; day: string },
  today: string,
  bootHead: bigint,
): string | null {
  // Clock skew between the day boundary and the node can still land a resolved
  // day start past head; refuseResetStart cannot see that before resolving.
  if (bootHead > 0n && from.block > bootHead) {
    return `start ${from.block} is past head ${bootHead} — skipped rather than replaying the lifetime`;
  }
  if (from.day > today) {
    return `start block ${from.block} falls on ${from.day}, after today (${today}) — skipped rather than anchoring the replay to head`;
  }
  return null;
}

/**
 * BACKFILL_RESET grammar: `vid[:from][@nonce]`, comma-separated.
 *
 *   metric                  replay the venue's whole lifetime (the original form)
 *   metric:95836845         replay from that block
 *   metric:2026-08-14       replay from that UTC day
 *   metric@2                lifetime again — `@` stays a re-run nonce, not a start
 *   metric:2026-08-14@2     both
 *
 * `:` carries the start and `@` the nonce so the two can never be confused.
 * Each venue records its own normalized entry, so changing either re-runs that
 * venue without disturbing the other entries in the list.
 */
export function parseBackfillReset(spec: string): BackfillResetTarget[] {
  return spec.split(',').map((x) => x.trim()).filter(Boolean).map((entry) => {
    // Structure first. Anything past the nonce used to be DISCARDED, so a typo
    // like `metric@2:95836845` (nonce before start) silently parsed as bare
    // `metric` and launched the lifetime replay the operator was avoiding.
    const at = entry.split('@');
    const nonce = at[1];
    if (at.length > 2 || (nonce !== undefined && (nonce === '' || nonce.includes(':')))) {
      return { vid: at[0]?.split(':')[0] ?? '', spec: entry, from: 'invalid' as const };
    }
    const [vid, from, ...rest] = at[0].split(':');
    if (!vid || rest.length) return { vid: vid ?? '', spec: entry, from: 'invalid' as const };
    if (from === undefined) return { vid, spec: entry, from: 'lifetime' as const };
    // day first: a date can never be read as a block number, and vice versa.
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return isUtcDay(from)
        ? { vid, spec: entry, from: 'day' as const, day: from }
        : { vid, spec: entry, from: 'invalid' as const };
    }
    if (/^\d+$/.test(from) && BigInt(from) > 0n) return { vid, spec: entry, from: 'block' as const, block: BigInt(from) };
    return { vid, spec: entry, from: 'invalid' as const };
  });
}

/** Hold a deep history crawl while the ARCHIVE pool is not fully healthy: on a
 *  backup, or with every endpoint down. The crawl resumes on the archive primary.
 *
 *  Gated on the archive pool, not the hot one, because that is the pool these
 *  crawls actually ride — holding them on hot-pool degradation would pause
 *  history for an incident that cannot affect it, and (worse) let them hammer a
 *  degraded archive backup during one that does.
 *
 *  `down` is checked as well as `degraded`, and the two are NOT the same state:
 *  when the breaker exhausts every endpoint it wraps back to index 0 and reports
 *  `down: true, degraded: false`. Running a crawl then is the dangerous case —
 *  every fetch fails, and the loops below read sustained failure as a permanent
 *  archive hole and SKIP it (in hole mode, a doubling stride up to a day per
 *  hop). That is exactly the silent undercount this file refuses to produce.
 *  Recovery is safe to wait for: the breaker keeps probing while down
 *  (chain/failover.ts), so it clears without any traffic from us.
 *  (Cursors/accumulators simply wait — nothing is lost or restarted.) */
function archiveUnavailable(): boolean {
  const s = archiveRpcStatus();
  return s.degraded || s.down;
}

function hotUnavailable(): boolean {
  const s = rpcStatus();
  return s.degraded || s.down;
}

/** One deep read is valid only when the archive pool stays primary/healthy for
 *  its entire lifetime. The breaker can fail over and retry inside the await. */
const archiveRead = <T>(read: () => Promise<T>): Promise<T> => guardRpcRead(read, archiveUnavailable, archiveRpcGeneration);
/** The same guarantee on the HOT pool, for the today re-read: a result served
 *  across a failover is refused (and retried) rather than mixed. */
const hotRead = <T>(read: () => Promise<T>): Promise<T> => guardRpcRead(read, hotUnavailable, rpcGeneration);

async function holdWhileDegraded(): Promise<boolean> {
  const wasUnavailable = archiveUnavailable();
  while (archiveUnavailable()) await sleep(15_000);
  return wasUnavailable;
}

/**
 * LiveDataSource — real Monad RPC + CEX reference, run as a persist-forward
 * indexer. It is entirely venue-agnostic: every venue is a registered adapter
 * (server/src/venues/registry.ts) and the core only ever sees `venueId`.
 *
 *  - quotes: each adapter's quote() (contract reads) + the CEX reference walk.
 *  - fills:  each adapter declares logSources(); the core getLogs's them and
 *    hands them back to decode(); fills are priced by the adapter, bucketed into
 *    UTC-day per-venue volume, and joined to the reference mid for markouts.
 *  - history: the SQLite DB is authoritative. On boot we load persisted days +
 *    lastProcessedBlock, run each adapter's optional backfill() (deep history
 *    seed), and either gap-fill from the last processed block or start forward.
 */
export class LiveDataSource extends BaseSource {
  readonly mode: DataSourceMode = 'live';

  private pricer = new UsdPricer((key) => REFERENCES.assetUsd(key), (market) => REFERENCES.midForPair(market));
  private store = new VolumeStore(config.dbPath);
  /** QUOTE_UPDATE_BURN accrual — destination-keyed per-venue keeper gas. */
  // ARCHIVE pool: the gas tracker resolves `gas_from` through blockAtOrAfter and
  // crawls receipts from there, so it is a deep-history consumer end to end.
  private gas = new GasTracker(
    archiveClient,
    this.store,
    ADAPTERS,
    (code, msg, venue) => this.noteOnce(code, msg, venue),
    () => archiveUnavailable(),
    config.gasSliceChunks,
    archiveRpcGeneration,
  );
  /** fill attribution — UNKNOWN → DIRECT / "Router - X" from tx.to (best-effort;
   *  stays on during failover — per-fill lookups are live-path cheap, unlike crawls). */
  private attributor = new FillAttributor(publicClient, ADAPTERS);
  /** shared infra handed to every adapter (they don't import globals), built
   *  once PER ADAPTER so every note it raises carries its own venue id without
   *  the adapter repeating that at each call site. */
  private ctxCache = new WeakMap<VenueAdapter, AdapterContext>();
  private ctxFor(a: VenueAdapter): AdapterContext {
    let ctx = this.ctxCache.get(a);
    if (!ctx) {
      const venue = this.vidOf(a);
      ctx = {
        client: { ...publicClient, getBlockNumber: headClient.getBlockNumber },
        getLogs: getLogsChunked,
        pricer: this.pricer,
        config,
        // deduped: discovery notes repeat verbatim on every 10-min rediscover
        // and were accumulating unbounded ("Metric: 3 pool(s)" × N). A
        // `repeatable` note is a transition the adapter latches itself.
        note: (code, msg, opts) => opts?.repeatable ? this.note(code, msg, venue) : this.noteOnce(code, msg, venue),
        // storeWriter is read at CALL time: it is the direct store during boot
        // discovery and the persistence worker once writes are sealed.
        state: {
          get: (key) => this.store.getMeta(`adapter_${venue}_${key}`),
          set: (key, value) => this.storeWriter.setMeta(`adapter_${venue}_${key}`, value),
        },
      };
      this.ctxCache.set(a, ctx);
    }
    return ctx;
  }
  /** Frame-local context: on-chain state is pinned by block number, while this
   *  immutable pricer pins every adapter's off-chain bps/sizing inputs to the
   *  same synchronous CEX snapshot captured before the first await. */
  private frameCtxFor(a: VenueAdapter, pricer: UsdPricer): AdapterContext {
    return { ...this.ctxFor(a), client: quoteClient, pricer };
  }
  /** the adapter's primary venue id — what its notes are stamped with. */
  private vidOf(a: VenueAdapter): string | undefined { return a.venues()[0]?.id; }

  private analyticsWorker = new AnalyticsWorker(config.dbPath);
  private quoteRunner = new QuoteRunner();
  private referenceTimer?: ReturnType<typeof setInterval>;
  private markoutTimer?: ReturnType<typeof setInterval>;
  private markoutWork?: Promise<void>;
  private quotes: QuoteSnapshot = { block: 0, monUsd: 0, ts: 0, rows: [] };
  private days: DailyVolume[] = [];
  private fills: Fill[] = [];
  private pending = new Set<Fill>();
  private dirty = new Set<Fill>();
  /** UTC days whose volume/meta changed since the last atomic live snapshot.
   * Historical rows are immutable here; rewriting the full table every five
   * seconds blocks the event loop and delays block-triggered quote frames. */
  private dirtyDays = new Set<string>();
  /** ids already counted into the volume buckets (kept in sync with the fills
   *  window) — makes ingest idempotent so a re-decode never double-counts. */
  private countedIds = new Set<string>();
  /** Meta keys committed with the NEXT snapshot — atomically with the day
   *  buckets and cursor it carries (a finished today re-read clears its
   *  pending marker this way, in the same transaction as the bucket it SET). */
  private snapshotMeta: Record<string, string> = {};
  /** venue id → UTC day of a pending today re-read (rereadToday). */
  private rereads = new Map<string, string>();
  private rereadRunning = false;
  /** Fills cut into a snapshot whose write has not settled: between the cut
   *  and the COMMIT they are in neither the store nor `dirty`. */
  private inflightFills = new Set<readonly Fill[]>();
  /** Work that must run BETWEEN tail cycles (scheduleTail drains it). */
  private tailGates: Array<() => Promise<void>> = [];
  /** CEX mid history per PAIR (market symbol), in the pair's own terms (wrap
   *  basis + stable cross applied) — the markout anchors. Keyed per pair, not per
   *  base, because MON/USDC and MON/USDT0 mark against different mids. */
  private midHist = new Map<string, { t: number; mid: number }[]>();
  /** How far back the reference ring reaches (sampleReferences trims it). */
  private static readonly MID_HIST_MS = 120_000;
  /** Fills whose markout curve was already taken (complete or not). */
  private curveTaken = new WeakSet<Fill>();
  /** Late fills queued ONLY for their curve: every legacy horizon had elapsed at
   *  ingest, so those stay exactly as an unqueued fill's (never ring-derived). */
  private curveOnly = new WeakSet<Fill>();
  /** Complete curves awaiting the next snapshot (fills.curve_bps). Kept off the
   *  Fill objects: those ride the WS stream, and the curve must not. */
  private dirtyCurves = new Map<string, (number | null)[]>();
  /** Snapshots in a row whose curve UPDATE matched no fill row, per fill id
   *  (requeueUnmatchedCurves). An entry lives only while its curve is queued. */
  private curveMisses = new Map<string, number>();
  /** Snapshot overlap resolves within a commit or two; past this the fill row
   *  is not coming (retention pruned it under a still-in-memory fill). */
  private static readonly CURVE_MAX_RETRIES = 3;
  private lastBlock = 0n;
  /** Chain head captured at boot: live gap-fill handoff and reset validation. */
  private bootHead = 0n;
  /** Latest healthy HOT-primary head handed to the DEEP crawls. A run never
   *  resolves its closed-day boundary until the archive has reached this block. */
  private deepEnd = 0n;
  /** process start — grace period before "reference feed has no mid" notes. */
  private bootMs = Date.now();
  private tailTimer?: ReturnType<typeof setTimeout>;
  private quoteRetryTimer?: ReturnType<typeof setTimeout>;
  private postQuoteImmediate?: ReturnType<typeof setImmediate>;
  /** newHeads + HTTP-watchdog feed. Both paths are deduped before they reach the
   *  latest-only quote runner below. */
  private headWatcher = new HotHeadWatcher(headClient, { endpoint: hotHeadEndpoint, pollMs: config.headPollMs });
  private quotedBlock = 0n;
  private quotedIdentity: HeadIdentity = {};
  private runningIdentity: HeadIdentity = {};
  private pendingQuote?: QuoteTrigger;
  private runningQuoteBlock?: bigint;
  private quoteRunning = false;
  private observedHead = 0n;
  private lastHeadSource: QuoteHeadSource = 'http';
  private wsStatus: RealtimeHealth['wsStatus'] = config.rpcWs ? 'connecting' : 'disabled';
  private realtimeFrames: RealtimeFrameSample[] = [];
  private eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private eventLoopLagMs = 0;
  private loopsStopped = false;
  private stopPromise?: Promise<void>;
  private persistTimer?: ReturnType<typeof setInterval>;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private snapshotWriter?: SnapshotWriter;
  private storeWriter: StoreWriter = directStoreWriter(this.store);
  private rediscoverTimer?: ReturnType<typeof setInterval>;
  private remarkTimer?: ReturnType<typeof setInterval>;
  /** Deep workers stay inert until archive verification has installed the
   *  expected-chain guard. Hot quotes/fills may warm concurrently with it. */
  private archiveVerified = false;
  /** re-entrancy guard shared by the boot onboarding chain and the retry timer
   *  — two remark walks over the same cursors must never interleave. */
  private remarkRunning = false;
  /** the served notes window (server/src/notes.ts): sanitized, stamped with a
   *  code + level, deduped, and capped without letting one chatty subsystem
   *  evict everything else. */
  private notes = new NoteBuffer();
  /** High-resolution curves live in another process. Only its pre-serialized
   *  publications cross this boundary; RPC/ABI/JSON work cannot delay quotes. */
  private depthWorker = new DepthWorkerClient(
    (publication) => this.publishDepthPublication(publication),
    (level, message) => console[level === 'warn' ? 'warn' : 'log'](`[mpamm] depth: ${scrubNote(message)}`),
  );
  /** base asset key → when its reference mid went dark (checkReferenceStarvation). */
  private starvedSince = new Map<string, number>();
  /** venue+market+day keys with a still-unpublished CEX archive (checkArchivePending,
   *  family A of #6). Retracted when that archive publishes; per-key so each deferred
   *  day re-arms its own recovery independently. */
  private archivePending = new Set<string>();
  /** the boot gap-fill resume note still outstanding (checkGapFill, family B of #6),
   *  retracted when the tail cursor reaches bootHead. Singleton on purpose: one tail
   *  cursor serves the whole indexer. */
  private gapResume: { msg?: string } = {};
  /** venue id → run of consecutive empty quote cycles + when it was last seen
   *  quoting, and the venues already reported dark against the exact warning
   *  raised for each, so recovery can retract it (checkQuoteOutage). In memory
   *  on purpose: nothing here needs to survive a restart, since a still-dark
   *  venue re-earns its run. */
  private quoteEmptyRuns = new Map<string, { runs: number; since: number }>();
  private quoteDark = new Map<string, string>();
  /** venue id → reason currently on the record for a THROWN quote() — the core's
   *  half of venue.quote.unavailable (the catch in poll()). A rejection is noted
   *  once per distinct reason and recovery is ANNOUNCED when a later quote()
   *  succeeds, exactly like createQuoteOutageReporter (venues/quote-health.ts):
   *  silence on heal would leave the warning standing until the window rolls it
   *  off. In memory for the same reason as the two maps above: a still-failing
   *  venue re-earns its note after a restart. */
  private quoteFailed = new Map<string, string>();
  private block = 0;
  /** all registered venue ids — a fill/quote carrying an unknown id is dropped
   *  (a plugin bug must not silently store data the UI can't render). */
  private knownVenueIds = new Set<string>();

  async start(): Promise<void> {
    this.eventLoopDelay.enable();
    // Fail loud on a misconfigured registry (duplicate/invalid venue id) before
    // touching the network — a colliding id would silently merge two venues.
    validateRegistry();
    this.knownVenueIds = venueIds();
    // RPC failover events (switch / all-down / recovery) land in state.notes.
    // Subscribed BEFORE the boot probe so a degraded start is on the record.
    onRpcEvent((e) => this.noteOnce(e.code, e.msg));
    if (hasDedicatedArchive) onArchiveRpcEvent((e) => this.noteOnce(e.code, e.msg));
    // Fail fast when NO endpoint serves or the primary is on the wrong chain
    // (docs/architecture.md: operations) rather than half-start; a dead primary
    // with a healthy backup boots degraded instead of failing.
    const probe = await probeChain();
    if (!probe.ok) throw new Error(`Monad RPC sanity check failed (${probe.reason}). Set DATA_SOURCE=sim to run offline.`);
    // Start archive verification concurrently with hot-path warm-up. A
    // blackholed archive may spend several transport timeouts per endpoint;
    // quotes and the fill tail must not remain empty while that happens. Deep
    // workers are gated below until the probe has proved chain identity.
    const archiveProbePending = probeArchiveChain();

    await REFERENCES.start();
    this.sampleReferences();
    this.referenceTimer = setInterval(() => this.sampleReferences(), 100);
    this.markoutTimer = setInterval(() => { void this.ageMarkouts(); }, 300);
    // discover every venue's markets/pools (adapters hold their own state).
    for (const a of ADAPTERS) {
      try { await a.discover(this.ctxFor(a)); }
      catch (e) { this.note('venue.discovery.failed', `${a.venues()[0]?.name ?? 'venue'} discovery failed: ${(e as Error).message}`, this.vidOf(a)); }
    }

    await this.initHistory();
    this.historyReady = true;
    const resetWant = config.backfillReset.trim();
    if (resetWant) adoptLegacyResetMarker(this.store, resetWant, parseBackfillReset(resetWant));
    // The schema/migrations above finish on the main connection first. Every
    // mutation after this point goes through one worker connection so volume
    // latency cannot pause newHeads or quote response handling.
    this.snapshotWriter = new SnapshotWriter(config.dbPath);
    this.storeWriter = this.snapshotWriter;
    this.gas.setWriter(this.snapshotWriter);
    this.store.sealWrites();
    // every venue an adapter declares, not just its first: a reset can name any of them
    for (const vid of ADAPTERS.flatMap((a) => a.venues().map((v) => v.id))) {
      const day = this.store.getMeta(rereadKey(vid));
      if (day && day === utcDay()) this.rereads.set(vid, day);
    }
    this.kickMaintenance();

    // The boot head was captured by initHistory. Quote that exact state once,
    // then let newHeads drive every later matrix. If boot quoting fails, the
    // watcher's immediate HTTP observation retries it (or a newer head).
    this.observedHead = this.bootHead;
    try {
      const trigger: QuoteTrigger = { blockNumber: this.bootHead, source: 'http', observedAt: Date.now(), coalescedBlocks: 0,
        identity: { ...this.headWatcher.identity(this.bootHead), generation: hotHeadEndpoint().generation } };
      await this.poll(this.bootHead, trigger);
      this.quotedBlock = this.bootHead;
      this.quotedIdentity = trigger.identity ?? {};
    }
    catch { /* the head watcher retries without advancing quotedBlock */ }
    this.headWatcher.start({
      onBlock: (blockNumber, source, observedAt, identity) => this.queueQuoteBlock(blockNumber, source, observedAt, identity),
      onReplaced: (fromBlock) => {
        this.quoteRunner.stop();
        this.observedHead = fromBlock - 1n;
        if (this.quotedBlock >= fromBlock) this.quotedBlock = fromBlock - 1n;
        this.pendingQuote = undefined;
        this.quotesFull = false;
        this.quotes = { ...this.quotes, rows: [], revision: this.headWatcher.identity(fromBlock).revision };
        this.invalidateQuoteHistory(Number(fromBlock), this.quotes.revision);
        this.realtimeFrames = this.realtimeFrames.filter((frame) => frame.block < Number(fromBlock));
      },
      onWsConnected: () => {
        this.wsStatus = 'connected';
        this.emitRealtimeState();
      },
      onWsFallback: () => {
        this.wsStatus = 'fallback';
        this.noteOnce('quote.head.fallback', WS_HEAD_FALLBACK_MSG);
        this.emitRealtimeState();
      },
      onWsRecovered: () => {
        this.wsStatus = 'connected';
        this.dropNote('quote.head.fallback', WS_HEAD_FALLBACK_MSG);
        this.note('quote.head.recovered', 'quote-head WebSocket recovered — newHeads is driving quotes again');
        this.emitRealtimeState();
      },
    });
    // Fill ingest is intentionally still timer-driven and independent. Its
    // finality-margin range reads never decide which block a quote represents.
    this.scheduleTail();
    void this.runRereads();
    this.persistTimer = setInterval(() => { void this.persist(); }, config.persistMs);
    // rolling retention: without it fills only aged out at boot, so uptime
    // alone grew the table past its window.
    this.pruneTimer = setInterval(() => this.kickMaintenance(), config.pruneIntervalMs);
    this.rediscoverTimer = setInterval(() => { void this.rediscover(); }, config.rediscoverMs);

    // The archive pool is NOT fatal for an outage. Deep crawls hold their
    // cursors and resume when it serves, while the hot dashboard is already
    // live above. A wrong-chain primary remains fatal and no deep worker has
    // been allowed to read or persist through it.
    const archiveProbe = await archiveProbePending;
    if (!archiveProbe.ok && archiveProbe.wrongChain) {
      throw new Error(`Archive RPC sanity check failed (${archiveProbe.reason}). It answers successfully, so failover cannot route around it and deep crawls would persist another chain's history — fix RPC_ARCHIVE_URL.`);
    }
    if (!archiveProbe.ok) {
      this.note('rpc.down', `archive RPC sanity check failed (${archiveProbe.reason}) — deep history (volume backfill, markout onboarding, gas) will hold until it serves; live quotes and fills are unaffected`);
    }
    this.archiveVerified = true;
    // seed deep history in the BACKGROUND — never blocks boot or the live tail.
    if (config.backfillEnabled || config.markoutBackfill) void this.backgroundHistory();
    // quote-update gas: its own cursor + loop (first pass covers the shallow
    // history horizon, later passes tail forward) — independent of the fills
    // pipeline on purpose: a gas-source failure must never hold the fill cursor.
    if (config.gasMetric) this.gas.start();
    // Deferred markout backfills retry on a TIMER, not just at boot: a day's
    // CEX archive publishes after the day closes, and "marks itself when it
    // lands" must not depend on a deploy happening to restart the process. Each
    // sweep is cheap when nothing is markable (per-venue SQL for candidates +
    // a HEAD probe per missing archive day — no RPC, no downloads).
    if (config.markoutBackfill) this.remarkTimer = setInterval(() => { void this.remarkSweep(); }, config.markoutRetryMs);
  }

  /** Background history stages, in product-value order: onboarding markouts
   *  first (bounded ~30d — populates the leaderboard window a viewer actually
   *  sees), THEN the deep venue-lifetime volume backfill (can run for hours).
   *  Re-invoked by the rediscovery timer while seeds are pending (a venue whose
   *  pools were quarantined at boot must seed once they recover — same
   *  process, not just next deploy); the guard keeps one chain in flight. */
  private historyRunning = false;
  private async backgroundHistory(): Promise<void> {
    if (!this.archiveVerified || this.historyRunning) return;
    this.historyRunning = true;
    let rerun = false;
    try {
      // Pin a healthy HOT-primary head, then wait for the archive to reach that
      // exact block. If either wait crosses midnight, repeat with a fresh head;
      // blockAtOrAfter must never search for today's boundary below today's
      // first block and silently return a stale upper bound.
      let nowMs = 0;
      let runDay = '';
      for (;;) {
        nowMs = Date.now();
        runDay = utcDay(nowMs);
        const head = await guardRpcRead(() => headClient.getBlockNumber(), hotUnavailable, rpcGeneration);
        if (head > this.deepEnd) this.deepEnd = head;
        if (hasDedicatedArchive) {
          let lagWasAnnounced = false;
          let heldMsg = '';
          const waited = await waitForArchiveBoundary(
            this.deepEnd,
            () => archiveClient.getBlockNumber(),
            archiveUnavailable,
            sleep,
            archiveRpcGeneration,
            {
              graceMs: ARCHIVE_BOUNDARY_NOTE_MS,
              onHeld: ({ head, target, lag }) => {
                lagWasAnnounced = true;
                // Monad's official 300ms block time converts the block deficit
                // into the chain-time lag an operator can size at a glance.
                heldMsg = `deep history waiting for archive handoff: archive head ${head}, target ${target} (${lag} blocks / ${approximateDuration(Number(lag) * 300)} behind)`;
                this.noteOnce('backfill.held', heldMsg);
              },
              onResumed: ({ target, waitedMs }) => {
                this.dropNote('backfill.held', heldMsg);
                this.note('backfill.held', `deep history resumed: archive reached hot handoff block ${target} after ${approximateDuration(waitedMs)}`);
              },
            },
          );
          if (waited && !lagWasAnnounced) {
            this.noteOnce('backfill.held', `deep history held until the archive reached hot handoff block ${this.deepEnd}`);
          }
        }
        if (!historyRunRolled(runDay)) break;
      }
      // Scan only FULLY closed days. If this run crosses midnight, the stage
      // stays pending and restarts against a fresh hot-head bound so the day
      // that just closed is replayed in full (including the post-boot suffix).
      const firstCurrentBlock = await blockAtOrAfter(
        Math.floor(Date.parse(`${runDay}T00:00:00Z`) / 1000),
        this.deepEnd,
      );
      const closedEnd = firstCurrentBlock > 0n ? firstCurrentBlock - 1n : 0n;
      // Gap-fill and deep replay can overlap closed blocks after a restart. Let
      // the tail finish first; the deep SET then becomes the final exact value
      // instead of a later tail increment double-counting the overlap.
      await this.waitForTailBoundary(closedEnd);
      await this.applyBackfillReset(nowMs, closedEnd);
      if (historyRunRolled(runDay)) throw new HistoryDayRolledError(runDay);
      if (config.markoutBackfill) {
        try { await this.markoutOnboarding(nowMs, closedEnd); }
        catch (e) {
          if (e instanceof HistoryDayRolledError) throw e;
          this.noteOnce('markout.paused', `markout onboarding stopped: ${(e as Error).message}; retried automatically`);
        }
      }
      if (config.backfillEnabled) await this.backfillOnchain(nowMs, closedEnd);
    } catch (e) {
      if (e instanceof HistoryDayRolledError) {
        this.noteOnce('backfill.held', `${e.message} — extending the closed-day boundary and resuming`);
        rerun = true;
      } else {
        // This chain is started with `void`, so anything escaping here is an
        // unhandled rejection that takes the whole stage down silently. The
        // rediscovery timer re-invokes it while seeds are pending, so saying so
        // and standing down IS the retry.
        this.noteOnce('backfill.paused', `history stage stopped: ${(e as Error).message}; retried automatically`);
      }
    } finally {
      this.historyRunning = false;
      if (rerun && !this.loopsStopped) setTimeout(() => { void this.backgroundHistory(); }, 0);
    }
  }

  /** Deep SETs must land after the live gap-fill has crossed their bound. */
  private async waitForTailBoundary(target: bigint): Promise<void> {
    while (!this.loopsStopped && this.lastBlock < target) await sleep(1_000);
    if (this.loopsStopped) throw new Error('source stopped while history waited for the live tail');
  }

  /** true while any fill-landing venue still awaits a one-time history seed. */
  private seedsPending(): boolean {
    return ADAPTERS.some((a) => {
      const v = a.venues()[0];
      if (!v?.id || v.role !== 'venue') return false;
      return (config.backfillEnabled && !!a.backfillFromUtc && this.store.getMeta(`backfill_done_${v.id}`) !== '1')
        || (config.markoutBackfill && this.store.getMeta(`mkfill_done_${v.id}`) !== '1');
    });
  }

  /** An operator reset is its own retryable history task. Existing seed flags
   *  may all be done when its first attempt loses the hot primary before the
   *  reset is applied, so those flags alone cannot decide whether to re-run.
   *  Filter to adapters active in this boot: a VENUES-filtered reset is meant
   *  to wait for a later boot, not launch a no-op history pass every 10 minutes. */
  private resetPending(): boolean {
    if (!config.backfillEnabled && !config.markoutBackfill) return false;   // nothing would run them
    const active = new Set(ADAPTERS.flatMap((a) => a.venues().map((v) => v.id)));
    // an invalid revision is never stamped, and only a code fix clears it — it
    // must not re-launch the history pass every rediscovery tick meanwhile.
    // A held 'fills' revision is the same: it needs a human, not a re-check.
    return this.resetTargets(utcDay())
      .some((target) => active.has(target.vid) && !(target.marker && target.from === 'invalid')
        && !this.heldRevisions.has(resetMarker(target)) && !resetAlreadyApplied(this.store, target));
  }
  /** 'fills' revisions this process found unsafe (planFillsRevision 'hold'):
   *  left unstamped, so the next boot re-checks and re-warns. */
  private heldRevisions = new Set<string>();

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.loopsStopped = true;
    this.clearExecutionHistory();
    this.headWatcher.stop();
    this.quoteRunner.stop();
    if (this.referenceTimer) clearInterval(this.referenceTimer);
    if (this.markoutTimer) clearInterval(this.markoutTimer);
    this.eventLoopDelay.disable();
    if (this.tailTimer) clearTimeout(this.tailTimer);
    if (this.quoteRetryTimer) clearTimeout(this.quoteRetryTimer);
    if (this.postQuoteImmediate) clearImmediate(this.postQuoteImmediate);
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.rediscoverTimer) clearInterval(this.rediscoverTimer);
    if (this.remarkTimer) clearInterval(this.remarkTimer);
    this.gas.stop();
    const finalPersist = this.persist(true);
    const depthStop = this.depthWorker.stop();
    REFERENCES.stop();
    this.stopPromise = Promise.all([finalPersist, depthStop, this.markoutWork]).then(() => undefined).finally(async () => {
      try { await this.analyticsWorker.close(); await this.snapshotWriter?.close(); }
      finally { this.store.close(); }
    });
    return this.stopPromise;
  }

  protected onDepthDemand(market: string, active: boolean): void {
    if (!config.depthEnabled) {
      if (active) this.publishDepth({ market, asOfBlock: this.block, refMid: 0, ts: Date.now(), venues: [] });
      return;
    }
    this.depthWorker.setDemand(market, active);
  }

  /** QUOTE_UPDATE_BURN series — straight from daily_gas (tiny table). */
  gasSeries(): GasResponse {
    return { days: this.store.gasDays(utcDay()), approx: this.gas.approxVenueIds() };
  }

  /** Periodically re-run each adapter's discover() so mid-run or missed pool
   *  state self-heals from its authoritative source (review #2). Adapters merge
   *  (never wipe) their cache, so a transient failure here is harmless. */
  private async rediscover(): Promise<void> {
    for (const a of ADAPTERS) {
      try { await a.discover(this.ctxFor(a)); }
      catch (e) { this.noteOnce('venue.discovery.failed', `${a.venues()[0]?.name ?? 'venue'} re-discovery failed: ${(e as Error).message}`, this.vidOf(a)); }
    }
    // seeds deferred at boot (pools quarantined / not discovered) retry here —
    // no-op when everything is seeded, and the in-flight guard makes an extra
    // kick free while a multi-hour backfill is still running.
    if (this.archiveVerified && (this.seedsPending() || this.resetPending())) void this.backgroundHistory();
    if (this.rereads.size) void this.runRereads();
  }

  private realtimeHealth(): RealtimeHealth | undefined {
    const frame = this.quotes.frame;
    if (!frame) return undefined;
    const now = Date.now();
    this.realtimeFrames = this.realtimeFrames.filter((f) => f.emittedAt >= now - REALTIME_WINDOW_MS);
    const headBlock = Number(this.observedHead > 0n ? this.observedHead : BigInt(this.quotes.block));
    const coverage = realtimeCoverage(this.realtimeFrames, headBlock, now);
    return {
      headBlock,
      quoteBlock: this.quotes.block,
      lagBlocks: Math.max(0, headBlock - this.quotes.block),
      frameMs: frame.durationMs,
      headToFrameMs: Math.max(0, frame.emittedAt - frame.headObservedAt),
      eventLoopLagMs: this.eventLoopLagMs,
      ...coverage,
      headSource: this.lastHeadSource,
      wsStatus: this.wsStatus,
    };
  }

  getState(): MarketState {
    const realtime = this.realtimeHealth();
    return {
      chainId: 143, block: this.block, monUsd: REFERENCES.assetUsd('MON'), monChangePct: REFERENCES.changePctFor('MON'),
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: monad.blockTime ?? 300, source: 'live', venues: venueMeta(),
      quoteMarkets: Object.fromEntries(ADAPTERS.flatMap((a) => a.venues().map((v) => [v.id, [...(a.quoteMarkets?.() ?? [])]]))), notes: this.notes.list(),
      rpc: rpcStatus(),
      // Only when the pools actually differ: with no dedicated archive this
      // would be a copy of `rpc`, and a duplicated chip reads as a second
      // subsystem that does not exist.
      ...(hasDedicatedArchive ? { rpcArchive: archiveRpcStatus() } : {}),
      ...(realtime ? { realtime } : {}),
    };
  }
  getQuotes(): QuoteSnapshot {
    return Date.now() - this.quotes.ts <= QUOTE_HISTORY_MS ? this.quotes : { ...this.quotes, rows: [] };
  }
  private quotesFull = false;
  private historyReady = false;
  isReady(): boolean { return this.historyReady; }
  quoteSnapshotComplete(): boolean { return this.quotesFull; }
  private quotePollingStarted = false;
  private fullSnapshotPending?: Promise<QuoteSnapshot>;
  fullQuoteSnapshot(fresh = false): Promise<QuoteSnapshot> {
    // REST remains non-blocking while discovery/history warms up. A legacy
    // stream handoff still waits for a genuinely complete first frame.
    if (!fresh && !this.quotePollingStarted) return Promise.resolve(this.getQuotes());
    if (!fresh && this.quotesFull && Date.now() - this.quotes.ts < 300) return Promise.resolve(this.quotes);
    if (this.fullSnapshotPending) return this.fullSnapshotPending;
    this.fullSnapshotPending = new Promise<QuoteSnapshot>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.off('message', receive); };
      const receive = (message: import('@shared').StreamMessage) => {
        if (message.ch !== 'quotes' || !this.quotesFull) return;
        finish(); resolve(message.data);
      };
      const timer = setTimeout(() => { finish(); reject(new Error('quote snapshot unavailable')); }, 3_000);
      this.on('message', receive);
    }).finally(() => { this.fullSnapshotPending = undefined; });
    return this.fullSnapshotPending;
  }
  getFills(): Fill[] { return this.fills; }
  getVolume(): DailyVolume[] { return this.days.map((d) => ({ ...d, byVenue: { ...d.byVenue } })); }

  // ── history: load + seed + resume (persist-forward indexer) ─────────────────
  private async initHistory(): Promise<void> {
    // 0. prune any venue that left the registry (non-destructive — every
    //    remaining venue's history is kept, unlike a schema reset). Runs before
    //    we load days so a removed venue's stale rows never reach the UI/totals.
    // prune against the UNFILTERED registry: a VENUES=subset dev boot must not
    // delete the filtered-out venues' history (their done-flags would survive
    // and block any re-backfill — unrecoverable without a manual reset).
    const pruned = this.store.reconcileVenues([...allVenueIds()]);
    if (pruned.volume || pruned.fills) this.note('store.migrated', `pruned ${pruned.volume} volume row(s) + ${pruned.fills} fill(s) for removed venue(s)`);
    // one-time honesty relabel: Metric/POE used to hardcode DIRECT with no
    // attribution evidence — retained rows revert to UNKNOWN (new fills get
    // real labels from the attributor; evidence-based venues are untouched).
    if (this.store.getMeta('attribution_relabel') !== 'v1') {
      const n = this.store.relabelCategory(['metric', 'poe'], 'DIRECT', 'UNKNOWN');
      if (n > 0) this.note('store.migrated', `attribution: relabeled ${n} retained unevidenced DIRECT fill(s) to UNKNOWN`);
      this.store.setMeta('attribution_relabel', 'v1');
    }
    // FastLane rows written as ROUTER before the MEV class existed: the
    // auction handler sells priority execution (bid → shMonad), it routes
    // nothing — the inner swap is searcher flow.
    if (this.store.getMeta('mev_relabel') !== 'v1') {
      const n = this.store.relabelCategoryByRouter('FastLane', 'ROUTER', 'MEV');
      if (n > 0) this.note('store.migrated', `attribution: reclassified ${n} FastLane fill(s) ROUTER → MEV`);
      this.store.setMeta('mev_relabel', 'v1');
    }
    // 1. authoritative persisted history
    this.days = this.store.all();
    // drop a FEW batches past the retention window now (so recentFills and
    // swap counts below never see expired rows at the head of the table);
    // any larger backlog, and the VACUUM, run on the persistence worker once
    // it starts (kickMaintenance) — boot blocks the event loop, stalling quotes
    // and the WS (and a host that health-probes a live process kills it).
    const aged = this.store.pruneFillsBefore(retentionCutoffMs(Date.now(), config.fillsRetentionDays), config.pruneBootMaxBatches);
    if (aged.removed) console.log(`[mpamm] retention: pruned ${aged.removed} fill(s) at boot${aged.done ? '' : ' — backlog continues on the worker'}`);
    // load recent fills for live serving
    this.fills = this.store.recentFills(FILL_RING_SIZE);
    // seed the dedup guard with the persisted window so a gap-fill re-decode of
    // already-counted fills won't re-count them.
    for (const f of this.fills) this.countedIds.add(f.id);
    // Resume markout aging across a restart (M1): a fill persisted with only its
    // early horizons must go back on the pending queue if a later horizon is
    // still in the future, or ageMarkouts would leave those cells null forever.
    const bootMs = Date.now();
    for (const f of this.fills) if (this.hasFutureMarkoutHorizon(f, bootMs)) this.pending.add(f);

    // 2. per-adapter historical backfill (deep-history seed, e.g. a subgraph).
    const today = utcDay();
    let seeded = 0;
    const seededFills: Fill[] = [];
    for (const a of ADAPTERS) {
      if (!a.backfill) continue;
      const allowed = new Set(a.venues().map((v) => v.id)); // ids this adapter may emit
      try {
        const bf = await a.backfill(this.ctxFor(a), config.seedSinceUtc);
        for (const bd of bf.days ?? []) {
          if (bd.utcDay >= today) continue; // today is owned by live tailing
          let row = this.days.find((d) => d.utcDay === bd.utcDay);
          if (!row) { row = this.emptyDay(bd.utcDay, false); this.days.push(row); }
          for (const [venueId, vd] of Object.entries(bd.byVenue)) {
            if (!allowed.has(venueId)) { this.note('venue.foreign', `dropped backfill volume for foreign venue '${venueId}'`, this.vidOf(a)); continue; }
            row.byVenue[venueId] = { usd: vd.usd, swaps: vd.swaps ?? 0 };
          }
          row.partial = false;
          seeded++;
        }
        // historical fills → the DB, so the DB-backed leaderboard/tape queries
        // (queryFills) actually see them (review #2). Their volume is carried by
        // bf.days, so they are NOT ingested (no double-count), and their
        // closed-day blocks sit before the live tail cursor (never re-decoded).
        for (const f of bf.fills ?? []) {
          if (!allowed.has(f.venueId)) { this.note('venue.foreign', `dropped backfill fill for foreign venue '${f.venueId}'`, this.vidOf(a)); continue; }
          seededFills.push(f);
        }
      } catch (e) {
        this.note('backfill.paused', `${a.venues()[0]?.name ?? 'venue'} backfill unavailable (${(e as Error).message}); history grows forward`, this.vidOf(a));
      }
    }
    if (seededFills.length) {
      // insert-if-absent: backfill() re-runs every boot, and an upsert would
      // reset already-remarked markouts to the adapter's nulls — permanently
      // (the remark cursor never revisits walked days).
      this.store.insertFillsIfAbsent(seededFills);
      // Backfill-fills markout contract (review #3): only a fill whose horizons are
      // still in the FUTURE may be aged against the live mid. Historical closed-day
      // fills (horizons elapsed) are NOT queued — their markouts stay as the adapter
      // supplied them (typically null), so they're tape-visible but excluded from
      // markout/leaderboard stats (never fabricated from a much-later mid).
      for (const f of seededFills) if (this.hasFutureMarkoutHorizon(f, bootMs)) this.pending.add(f);
    }
    if (seeded) this.note('backfill.done', `seeded ${seeded} closed day-row(s) from adapter backfill; on-chain-only venues accumulate forward`);
    this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
    this.today(); // ensure today's partial bucket, rolling any stale "today" closed
    this.reconcileSwapCounts(); // derive per-venue swap counts from retained + backfilled fills
    this.store.upsertMany(this.days);
    this.dirtyDays.clear();

    // 3. resume point — same-day gap-fill, else start at tip
    const head = await headClient.getBlockNumber();
    this.block = Number(head);
    this.bootHead = head; // upper bound for the live gap-fill (tail owns > head)
    // Initial deep handoff. Each background run refreshes this from the healthy
    // hot primary, then waits for both the archive and live tail before applying
    // an authoritative SET to any newly closed day.
    this.deepEnd = head;
    const lpb = this.store.getMeta('lastProcessedBlock');
    // gap-fill ANY gap — including across UTC midnight and multi-hour outages:
    // decoded fills carry real block timestamps and dayFor() buckets them onto
    // the right (possibly just-closed) day; countedIds/fill-id dedup keeps it
    // idempotent, and the windowed tail bounds the memory a huge gap uses.
    // The old same-day condition silently dropped the gap's fills on every
    // midnight-crossing restart; the 200k-size condition silently dropped the
    // 2026-09-17 outage hole (see shouldGapFill).
    const gap = lpb ? head - BigInt(lpb) : 0n;
    if (shouldGapFill(lpb, head, config.gapFillMaxBlocks)) {
      this.lastBlock = BigInt(lpb!);
      // remember this exact line so the tail can retract it once it catches up to
      // bootHead (checkGapFill, family B of #6); the count is fixed here while the
      // cursor keeps moving, so the string is stored rather than rebuilt.
      const resume = `resuming: gap-filling ${gap} block(s) since last run`;
      this.note('tail.resume', resume);
      this.gapResume.msg = resume;
    } else {
      this.lastBlock = head;
      // two different events: a bounded gap was skipped (fills in it are lost
      // for good, so it is a warning) versus a first boot with nothing to resume.
      if (lpb) this.note('tail.gap.skipped', `gap of ${gap} block(s) exceeds GAPFILL_MAX_BLOCKS=${config.gapFillMaxBlocks} — resuming at tip; the gap's fills are NOT decoded (recover with BACKFILL_RESET)`);
      else this.note('tail.resume', 'cold start — today builds forward from now');
    }
  }

  /** Storage maintenance, all on the persistence worker so the event loop
   *  (quotes, /api/health) keeps serving: drain the retention backlog in
   *  bounded sweeps, then VACUUM once if the disk allows it. Run after boot
   *  AND by the retention timer — a boot sweep a reader blocked is finished
   *  by a later tick, which must still reach the VACUUM. */
  private kickMaintenance(): void {
    void this.pruneSweep().then((drained) => { if (drained) return this.vacuumOnce(); });
  }

  private pruning = false;
  /** Retention on the writer worker: bounded sweeps back to back until the
   *  backlog is gone (a short pause between them lets snapshot writes
   *  interleave), stopping early when a reader pins the WAL. Resolves true
   *  when the backlog is fully drained. */
  private async pruneSweep(): Promise<boolean> {
    if (this.pruning) return false;
    this.pruning = true;
    let total = 0;
    try {
      while (!this.loopsStopped) {
        const r = await this.storeWriter.pruneFills(retentionCutoffMs(Date.now(), config.fillsRetentionDays), config.pruneMaxBatches);
        total += r.removed;
        if (r.done || r.blocked) {
          if (total > PRUNE_LOG_MIN_ROWS) console.log(`[mpamm] retention: pruned ${total} fill(s)${r.done ? ' — backlog clear' : ' — paused (reader holds the WAL)'}`);
          return r.done;
        }
        await sleep(1_000);
      }
      return false;
    } catch (e) {
      this.noteOnce('store.persist.failed', `retention sweep failed (${(e as Error).message}); retried next interval`);
      return false;
    } finally {
      this.pruning = false;
    }
  }

  private vacuumed = false;
  /** One VACUUM per process, behind the disk-capacity gate, on the worker. */
  private async vacuumOnce(): Promise<void> {
    if (this.vacuumed) return;
    this.vacuumed = true;
    try {
      const fs = statfsSync(dirname(config.dbPath));
      const r = await this.storeWriter.vacuumIfRoom(Number(fs.bavail) * Number(fs.bsize));
      const mb = (b: number) => (b / 1e6).toFixed(0);
      if (r.plan === 'defer') console.log(`[mpamm] vacuum deferred: ${mb(r.freeBytes)} MB reclaimable, but only ${mb(r.availBytes)} MB free for a ${mb(r.liveBytes)} MB rewrite`);
      if (r.plan === 'run') console.log(`[mpamm] vacuum: reclaimed ${mb(r.freeBytes)} MB in ${r.ms}ms`);
    } catch (e) {
      console.log(`[mpamm] vacuum skipped (${(e as Error).message})`);
    }
  }

  private persist(reportFailure = false): Promise<void> {
    // Swap the dirty sets synchronously. New fills/day mutations land in fresh
    // sets while this immutable snapshot waits for the worker ACK; a failure
    // merges the original objects/keys back so the next tick retries them.
    const dirtyFills = this.dirty;
    const dirtyDays = this.dirtyDays;
    const dirtyCurves = this.dirtyCurves;
    const extraMeta = this.snapshotMeta;
    this.dirty = new Set();
    this.dirtyDays = new Set();
    this.dirtyCurves = new Map();
    this.snapshotMeta = {};
    const snapshot: SnapshotWrite = {
      days: this.days
        .filter((d) => dirtyDays.has(d.utcDay))
        .map((d) => ({ ...d, byVenue: Object.fromEntries(Object.entries(d.byVenue).map(([id, v]) => [id, { ...v }])) })),
      meta: { ...extraMeta, lastProcessedBlock: String(this.lastBlock), lastProcessedDay: utcDay() },
      fills: [...dirtyFills].map((f) => ({ ...f, markoutsBps: [...f.markoutsBps] })),
      curves: [...dirtyCurves].map(([id, curveBps]) => ({ id, curveBps })),
    };

    const inflight = snapshot.fills;
    this.inflightFills.add(inflight);
    return this.writeSnapshot(snapshot)
      .finally(() => { this.inflightFills.delete(inflight); })
      .then(
        (result): Promise<void> | void => {
          this.requeueUnmatchedCurves(dirtyCurves, result.unmatchedCurves);
          // The shutdown flush has no next tick: work restored meanwhile (an
          // earlier in-flight snapshot that failed, a requeued curve) must be
          // drained before stop() closes the writer — this snapshot already
          // committed the cursor past it. Converges: a failure throws here,
          // and a curve requeues at most CURVE_MAX_RETRIES times.
          if (reportFailure && (this.dirty.size || this.dirtyDays.size || this.dirtyCurves.size || Object.keys(this.snapshotMeta).length)) return this.persist(true);
        },
        (e) => {
          for (const f of dirtyFills) this.dirty.add(f);
          for (const day of dirtyDays) this.dirtyDays.add(day);
          for (const [id, curve] of dirtyCurves) if (!this.dirtyCurves.has(id)) this.dirtyCurves.set(id, curve);
          for (const [k, v] of Object.entries(extraMeta)) if (!(k in this.snapshotMeta)) this.snapshotMeta[k] = v;
          // retained + retried next tick, but say so — a broken disk otherwise
          // looks healthy while the cursor silently stops advancing.
          this.noteOnce('store.persist.failed', `persist failed (${(e as Error).message}); ${reportFailure ? 'shutdown flush not acknowledged' : 'retrying'}`);
          if (reportFailure) throw e;
        },
      );
  }

  private writeSnapshot(snapshot: SnapshotWrite): Promise<SnapshotResult> {
    return this.storeWriter.persist(snapshot);
  }

  /**
   * A committed snapshot's curve can match no fill row. Snapshots overlap (each
   * swaps its dirty sets before the previous ACK), so the snapshot inserting
   * fill F can roll back AFTER a later one carrying only F's curve was cut:
   * that UPDATE lands first, on nothing, and F is re-inserted curve-less. So a
   * miss is requeued for the snapshot that re-inserts F — but only while F is
   * still in memory, and only a few times: a reset/retention-deleted fill
   * misses forever, and failing the write instead would wedge every later
   * snapshot (and the cursors committed with them) behind a row that is gone.
   */
  private requeueUnmatchedCurves(sent: ReadonlyMap<string, (number | null)[]>, unmatched: readonly string[]): void {
    const missed = new Set(unmatched);
    if (this.curveMisses.size) for (const id of sent.keys()) if (!missed.has(id)) this.curveMisses.delete(id);
    if (!missed.size) return;
    const inMemory = new Set<string>();
    for (const owner of [this.fills, this.dirty, this.pending]) for (const f of owner) inMemory.add(f.id);
    for (const id of missed) {
      const curve = sent.get(id);
      const misses = (this.curveMisses.get(id) ?? 0) + 1;
      if (!curve || !inMemory.has(id) || misses > LiveDataSource.CURVE_MAX_RETRIES) { this.curveMisses.delete(id); continue; }
      this.curveMisses.set(id, misses);
      if (!this.dirtyCurves.has(id)) this.dirtyCurves.set(id, curve);
    }
  }

  /** A fresh zeroed daily bucket (venue slices fill in as fills land). */
  private emptyDay(day: string, partial: boolean): DailyVolume {
    return { utcDay: day, byVenue: {}, partial };
  }

  /**
   * Notes are the service's dev-facing telemetry (server/src/notes.ts): the
   * buffer sanitizes the message, stamps the timestamp and the code's level,
   * and prints every note as it is raised. `code` classifies the event and
   * `venue` scopes it, both known here at the call site.
   */
  private note(code: NoteCode, msg: string, venue?: string): void { this.notes.note(code, msg, venue); }
  /** raise a note at most once — per-tick drop reasons must not spam state.notes. */
  private noteOnce(code: NoteCode, msg: string, venue?: string): void { this.notes.noteOnce(code, msg, venue); }
  /** retract a note that no longer describes reality (a recovered degradation). */
  private dropNote(code: NoteCode, msg: string, venue?: string): void { this.notes.drop(code, msg, venue); }

  /** keep only items whose venueId is one this adapter declared — a foreign id
   *  (plugin bug) is dropped with a one-time note, never silently stored (review #3). */
  private ownVenues<T extends { venueId: string }>(a: VenueAdapter, items: T[], kind: string): T[] {
    const allowed = new Set(a.venues().map((v) => v.id));
    return items.filter((x) => {
      if (allowed.has(x.venueId)) return true;
      this.noteOnce('venue.foreign', `${a.venues()[0]?.name ?? 'adapter'} emitted a ${kind} for foreign venue '${x.venueId}' — dropped`, this.vidOf(a));
      return false;
    });
  }

  /**
   * Derive per-venue swap counts from the retained fills — the authoritative
   * per-fill record — so the protocol breakdown is accurate across the retention
   * window immediately. Days with no retained fills (older than retention, or a
   * subgraph-seeded day) keep swaps 0: we have their volume, not the count.
   *
   * A rewrite of a closed day's non-zero count is reported, never silent (see
   * reconcileDaySwaps): it is the last trace of a day booked from the wrong
   * fills, whose USD this does not repair. One warn per venue per boot.
   *
   * So a closed day is rewritten only when this boot can judge it. Two kinds
   * are left exactly as stored, unrewritten and unreported, until a later boot
   * can: days whose fills may still be incomplete (fillsIncompleteFrom), and
   * days a pending stage will re-SET (pendingReSet). Rewriting either would
   * erase the evidence while nothing guarantees a fix.
   */
  private reconcileSwapCounts(): void {
    const now = Date.now();
    const today = utcDay(now);
    // only days inside retention: the cutoff is day-aligned and nothing at or
    // after it is ever pruned, so those days are complete — while an expired
    // day may be half-deleted (boot prune capped at PRUNE_BOOT_MAX_BATCHES),
    // and overwriting its persisted swaps with the remainder would corrupt it.
    const counts = this.store.fillCountsByDayVenue(retentionCutoffMs(now, config.fillsRetentionDays));
    const spans = new Map<string, Map<string, DayFillCount>>();
    for (const c of counts) {
      let m = spans.get(c.venueId); if (!m) { m = new Map(); spans.set(c.venueId, m); }
      m.set(c.utcDay, c);
    }
    // an invalid entry repairs nothing, so it must not hold a day back
    const queued = this.resetTargets(today).filter((t): t is Exclude<BackfillResetTarget, { from: 'invalid' }> =>
      !!t.vid && t.from !== 'invalid' && !resetAlreadyApplied(this.store, t));
    const held = new Map<string, (c: DayFillCount) => boolean>();
    for (const [venueId, m] of spans) {
      const { a, vid } = this.historyVenue(venueId);
      // fills count as complete only once onboarded, even with
      // MARKOUT_BACKFILL off: then they are tail-only and start mid-day
      const incompleteFrom = this.store.getMeta(`mkfill_done_${vid}`) === '1' ? undefined : fillsIncompleteFrom(m, {
        cursor: this.metaBlock(`mkfill_cursor_${vid}`),
        fromDay: fillsScanFromDay(a?.backfillFromUtc, now, config.markoutBackfillDays),
      });
      const pending = this.pendingRebuild(venueId, queued);
      held.set(venueId, (c) => (incompleteFrom !== undefined && c.utcDay >= incompleteFrom) || pendingReSet(c, pending));
    }
    // today is the live tail's, rewritten as always
    const judged = counts.filter((c) => c.utcDay >= today || !held.get(c.venueId)!(c));
    const changes = reconcileDaySwaps(this.days, judged, today);
    for (const venueId of new Set(changes.map((c) => c.venueId))) {
      const drift = changes.filter((c) => c.venueId === venueId);
      this.note('store.swaps.drift', swapNoteMsg(`swap count drift on ${drift.length} closed day(s), net ${swapNet(drift)} — counts reconciled from fills, USD was not: those days' USD may be misbucketed: `, drift), venueId);
    }
  }

  /** The adapter that owns `venueId`, and the id its history stages key their
   *  markers on: the adapter's FIRST venue. */
  private historyVenue(venueId: string): { a?: VenueAdapter; vid: string } {
    const a = ADAPTERS.find((x) => x.venues().some((v) => v.id === venueId));
    return { a, vid: (a && this.vidOf(a)) ?? venueId };
  }

  /** a stored block cursor, or undefined when unset (or not a block). */
  private metaBlock(key: string): bigint | undefined {
    const v = this.store.getMeta(key);
    return v && /^\d+$/.test(v) ? BigInt(v) : undefined;
  }

  /** What this boot's history stages will still re-SET for a venue (see VenueRebuild). */
  private pendingRebuild(venueId: string, queued: readonly Exclude<BackfillResetTarget, { from: 'invalid' }>[]): VenueRebuild {
    const { a, vid } = this.historyVenue(venueId);
    // A chain reset rewrites day rows only through the volume replay; without
    // it, it repairs no USD and explains nothing here. A 'fills' revision
    // SETs its days itself. A 'markets' revision re-SETs nothing: it adds a
    // fill to a day and to the table in one commit, so its days stay judgeable.
    const volumeReplays = config.backfillEnabled && !!a?.backfillFromUtc;
    const out: VenueRebuild = {
      resets: queued.filter((t): t is Exclude<typeof t, { from: 'markets' }> =>
        t.vid === vid && t.from !== 'markets' && (t.from === 'fills' || volumeReplays)),
    };
    if (volumeReplays && this.store.getMeta(`backfill_done_${vid}`) !== '1') out.volume = { cursor: this.metaBlock(`backfill_cursor_${vid}`) };
    return out;
  }

  /**
   * ONE-SHOT history resets, from three places, through one pipeline:
   *  - BACKFILL_RESET, the operator override, `vid[:from][@nonce]`:
   *      metric                lifetime replay
   *      metric:95836845       replay from that block
   *      metric:2026-08-14     replay from that UTC day
   *      metric@2              lifetime; `@` is a re-run nonce, never a start
   *  - adapters' HistoryRevisions — the same replay declared in code, so the
   *    deploy that changes a decode is also the one that repairs its history;
   *  - a today re-read a restart carried past midnight (carriedRereadTarget).
   *
   * Each enabled history stage is cleared and re-armed as one atomic unit for
   * the CLOSED days; a stage switched off for this run stays untouched. Today
   * belongs to the live tail, so it is never deleted here — it is re-read
   * instead (queueReread), from midnight to the tail's cursor, which is the
   * part of the day the previous build decoded. Without that re-read, a reset
   * applied mid-day recovered every day but the one it was deployed on.
   *
   * Every entry has its own marker, so redeploys and edits to a different
   * entry do not re-trigger a multi-hour scan. Runs from backgroundHistory()
   * ahead of both stages so neither can miss it.
   */
  private resetTargets(today: string): BackfillResetTarget[] {
    const want = config.backfillReset.trim();
    const targets = want ? parseBackfillReset(want) : [];
    // A revision is a full replay or nothing. With a stage switched off it
    // would rebuild half the history and still be stamped applied — and unlike
    // the env reset, nobody chose to run it on this config. So it waits for a
    // run with both stages on (production always is; the adapter dev loop is
    // not). A carried re-read too: queuing today's re-read overwrites the very
    // marker it is keyed on, so a half replay would consume it for good.
    const fullReplay = config.backfillEnabled && config.markoutBackfill;
    // The adapter's FIRST venue only: both closed-day stages (backfillAdapter,
    // backfillRecentFills) key their cursors on it and book every decoded fill
    // under it. A reset aimed at a later venue would delete rows no scan rebuilds.
    for (const a of ADAPTERS) {
      const vid = this.vidOf(a);
      if (!vid) continue;
      if (!fullReplay) continue;
      targets.push(...revisionTargets(vid, a.historyRevisions));
      const carried = carriedRereadTarget(vid, this.store.getMeta(rereadKey(vid)), today);
      if (carried) targets.push(carried);
    }
    return targets;
  }

  /** `closedEnd` is the last block of the last closed day: the bound of the
   *  one entry kind that reads the chain here ('markets'). */
  private async applyBackfillReset(nowMs: number, closedEnd: bigint): Promise<void> {
    const want = config.backfillReset.trim();
    const today = utcDay(nowMs);
    const targets = this.resetTargets(today);

    const applied: string[] = [];
    for (const t of targets) {
      // One-shot PER ENTRY, not per value. A global marker could not record
      // that one entry deferred: retrying it meant re-running the entries that
      // had succeeded, throwing away replays already hours deep.
      if (resetAlreadyApplied(this.store, t)) continue;
      // Stamped only once an entry is FINISHED — done, or refused for a reason
      // that will still hold next boot. A transient failure leaves it unstamped
      // so this entry, and only this entry, is retried. A carried re-read is
      // stamped by queueReread itself (it overwrites the marker it is keyed on).
      const settle = () => t.vid && !t.carried
        ? this.storeWriter.setMeta(resetMarker(t), t.spec)
        : Promise.resolve();
      const label = t.marker && !t.carried ? `history revision ${t.spec}` : `backfill reset: ${t.vid}`;

      if (t.from === 'invalid') {
        this.noteOnce('backfill.config.invalid', t.marker
          ? `history revision '${t.spec}' is invalid — expected a unique id ([A-Za-z0-9_.-]) and from: YYYY-MM-DD or omitted (source 'fills': from < until, both YYYY-MM-DD; until only with 'fills'; source 'markets': from YYYY-MM-DD and registered markets)`
          : `backfill reset: cannot parse '${t.spec}' — expected vid, vid:<block> or vid:YYYY-MM-DD`);
        // An invalid REVISION is a code bug that only a fix clears; stamping it
        // could also land on a valid twin's marker (shared id) and re-arm it.
        if (!t.marker) await settle();
        continue;
      }
      // A start that is not in the past is IGNORED by both resume checks
      // (`cb <= end + 1n`), which would quietly downgrade a targeted replay
      // into a head-anchored one. Refuse instead of doing something other than
      // what was asked — see refuseResetStart for why neither form self-reports.
      const refusal = refuseResetStart(t, today, this.bootHead);
      if (refusal) {
        this.note('backfill.config.invalid', `${label} ${refusal}`);
        await settle();
        continue;
      }
      // An unresolvable id would delete nothing and re-scan nothing while still
      // reporting "applied" — the exact silent no-op this pass exists to stamp
      // out. The adapter also owns backfillFromUtc, which scopes the fills
      // delete. Which KIND of unresolvable decides whether the reset is spent.
      const adapter = ADAPTERS.find((a) => a.venues().some((v) => v.id === t.vid));
      if (!adapter) {
        const missing = classifyMissingResetVenue(t.vid, allAdapterVenueIds(), new Set(REFERENCES.metas().map((v) => v.id)));
        if (missing === 'inactive') {
          // deliberately NOT settled — it has to survive to a boot that runs it
          this.note('backfill.deferred', `backfill reset: venue '${t.vid}' is not running this boot (VENUES filter) — left pending for a boot that includes it`);
          continue;
        }
        this.note('backfill.config.invalid', missing === 'reference'
          ? `backfill reset: '${t.vid}' is a CEX reference, which has no history to reset — skipped`
          : `backfill reset: no adapter declares venue '${t.vid}' — skipped`);
        await settle();
        continue;
      }
      // A 'fills' revision re-derives closed days from stored rows: no chain
      // read, no delete, no re-read of today. It settles itself, because its
      // stamp commits in the same snapshot as its days.
      if (t.from === 'fills') {
        const line = await this.applyFillsRevision(t, nowMs, today, label);
        if (line) applied.push(line);
        continue;
      }
      // A 'markets' revision adds rows and fills itself, and settles itself:
      // its stamp waits for the last day of its window to close.
      if (t.from === 'markets') {
        const line = await this.applyMarketsRevision(adapter, t, nowMs, today, closedEnd, label);
        if (line) applied.push(line);
        continue;
      }
      // A start ON today has no closed day to replay: it is the re-read alone.
      // Resolving its block would also be pointless work — the re-read always
      // starts at midnight.
      if (t.from === 'day' && t.day === today) {
        await this.queueReread(t.vid, today);
        await settle();
        applied.push(`${t.vid} today only — re-reading ${today} from midnight`);
        continue;
      }
      // A targeted replay needs BOTH ends of its start: the block the cursors
      // resume at, and the day the volume delete is scoped to (the volume scan
      // day-aligns, so it restores from that day's start).
      // ARCHIVE pool for both resolves below: a reset start is REFUSED unless it
      // is in the past, so `t.block` and the block blockAtOrAfter returns are
      // both arbitrarily deep — on a pruning hot node they would throw, and the
      // catch's "retried next boot" would mean forever.
      let from: { block: bigint; day: string } | undefined;
      if (t.from === 'block') {
        try {
          const b = await archiveRead(() => archiveClient.getBlock({ blockNumber: t.block }));
          from = resetStartFromBlock(t.block, b.timestamp);
        } catch (e) {
          // no settle(): a resolve that failed on the RPC may well succeed on
          // the next boot, and consuming the reset would strand it silently.
          this.note('backfill.config.invalid', `${label} — could not resolve block ${t.block} to a day (${(e as Error).message}); retried next boot`);
          continue;
        }
      }
      if (t.from === 'day') {
        try {
          const block = await blockAtOrAfter(Math.floor(Date.parse(`${t.day}T00:00:00Z`) / 1000), this.bootHead);
          const b = await archiveRead(() => archiveClient.getBlock({ blockNumber: block }));
          from = resetStartFromBlock(block, b.timestamp);
        }
        catch (e) {
          // no settle(): transient, same as the block form above.
          this.note('backfill.config.invalid', `${label} — could not resolve ${t.day} to a block (${(e as Error).message}); retried next boot`);
          continue;
        }
      }
      // Now that a day exists for it, ask the same question again — a RAW
      // block could only be judged against head before this point.
      const resolvedRefusal = from !== undefined ? refuseResolvedStart(from, today, this.bootHead) : null;
      if (resolvedRefusal) {
        this.note('backfill.config.invalid', `${label} ${resolvedRefusal}`);
        await settle();
        continue;
      }
      if (from !== undefined && from.day === today) {
        await this.queueReread(t.vid, today);
        await settle();
        applied.push(`${t.vid} today only — re-reading ${today} from midnight`);
        continue;
      }
      // Delete only what the two scans will actually rebuild. A switched-off
      // stage keeps its rows AND its cursor/done-flag; re-run with that stage
      // enabled if it also needs a true replay.
      const deletes = planVenueReset({
        from,
        fillsFromDay: fillsScanFromDay(adapter.backfillFromUtc, nowMs, config.markoutBackfillDays),
        today: utcDay(nowMs),
        volumeEnabled: config.backfillEnabled,
        fillsEnabled: config.markoutBackfill,
      });
      const dropped = await this.storeWriter.resetVenueHistory(t.vid, deletes, from?.block);
      purgeVenueDays(this.days, t.vid, deletes);
      purgeVenueFills({ fills: this.fills, pending: this.pending, dirty: this.dirty, countedIds: this.countedIds }, t.vid, deletes);
      if (dropped.fills) this.dropAggregates();
      // Queued BEFORE the entry is stamped: a crash between the two re-applies
      // the reset (idempotent) rather than losing today's re-read.
      await this.queueReread(t.vid, today);
      await settle();
      // Say what was DESTROYED, not just what will be re-scanned: this is a
      // one-shot operation with no undo, and the counts are the only record.
      const scope = from === undefined ? 'lifetime' : `from block ${from.block} (${from.day} onward)`;
      const kind = t.carried ? 'carried re-read' : t.marker ? `revision ${t.spec}` : 'reset';
      applied.push(`${t.vid} ${kind} ${scope} — dropped ${dropped.volume} day-row(s), ${dropped.fills} fill(s); re-reading ${today} from midnight`);
    }
    // Legacy breadcrumb, written for ROLLBACK only: older builds read this key
    // and would re-run the whole value without it. Nothing here reads it after
    // adoptLegacyResetMarker has run once.
    if (want) await this.storeWriter.setMeta('backfill_reset_applied', want);
    if (applied.length) this.note('backfill.reset', `history reset applied — ${applied.join('; ')}`);
  }

  /**
   * Apply one 'fills' revision (planFillsRevision decides whether it can).
   * The re-derived days and the revision's marker commit in ONE snapshot, so
   * a crash can never stamp the revision without its days. Days written
   * without the stamp simply re-apply next boot, to the same values.
   * Returns the applied-note line, or null when this pass applied nothing.
   */
  private async applyFillsRevision(t: BackfillResetTarget & { from: 'fills' }, nowMs: number, today: string, label: string): Promise<string | null> {
    const fromMs = Date.parse(`${t.day}T00:00:00Z`);
    const untilMs = Date.parse(`${t.until}T00:00:00Z`);
    const unpersisted = unpersistedFillsIn({ dirty: this.dirty, inflight: this.inflightFills }, t.vid, fromMs, untilMs);
    const stored = new Map<string, { usd: number; swaps: number }>();
    for (const d of this.days) {
      const v = d.byVenue[t.vid];
      if (v && d.utcDay >= t.day && d.utcDay < t.until) stored.set(d.utcDay, { usd: v.usd, swaps: v.swaps });
    }
    const plan = planFillsRevision({
      from: t.day,
      until: t.until,
      today,
      retainedFrom: utcDay(retentionCutoffMs(nowMs, config.fillsRetentionDays)),
      scansDone: this.store.getMeta(`backfill_done_${t.vid}`) === '1' && this.store.getMeta(`mkfill_done_${t.vid}`) === '1',
      unpersisted,
      stored,
      fills: new Map(this.store.fillTotalsByDay(t.vid, fromMs, untilMs).map((r) => [r.utcDay, { usd: r.usd, swaps: r.swaps }])),
    });
    if (plan.action === 'wait') {
      this.noteOnce('backfill.deferred', `${label} waits — ${plan.reason}`, t.vid);
      return null;
    }
    if (plan.action !== 'apply') {
      this.note('backfill.config.invalid', `${label} ${plan.reason}`, t.vid);
      // a pruned window never comes back; a conservation gap needs a human
      if (plan.action === 'refuse') await this.storeWriter.setMeta(resetMarker(t), t.spec);
      else this.heldRevisions.add(resetMarker(t));
      return null;
    }
    const acc = new Map(plan.days.map((d) => [d.utcDay, { usd: d.usd, swaps: d.swaps }]));
    const changed = this.mergeBackfill(t.vid, acc);
    await this.writeSnapshot({ days: changed, meta: { [resetMarker(t)]: t.spec }, fills: [] });
    // An open Volume tab loads closed days ONCE (the REST snapshot) and then
    // only merges `volume` frames, which carry today. One resync makes it
    // reload, rather than one frame per day: the gateway coalesces a burst of
    // compressed frames down to its last, which would strand the middle days.
    // Sent once per revision, never per tick (egress budget).
    this.emitMsg({ ch: 'volume', resync: true });
    const usd = (n: number) => `$${n.toFixed(2)}`;
    const moves = plan.days.map((d) => `${d.utcDay} ${usd(d.was?.usd ?? 0)}→${usd(d.usd)}`).join(', ');
    return `${label} — re-derived from retained fills: ${moves}`;
  }

  /**
   * Apply one 'markets' revision: ADD the listed markets' history over the
   * days the previous build decoded (marketsRevisionThrough), and nothing
   * else. ARCHIVE pool, from `from` to the window's last closed block. Each
   * flush's day increments, inserted fills, resume cursor and running total
   * commit in ONE snapshot, so a crash never adds a range twice. The stamp
   * waits until the window's last day has closed and been read.
   *
   * It runs in the reset pass, AHEAD of the fills onboarding and the volume
   * replay, and that order keeps the held check sound: the onboarding stores
   * fills without adding them to a day, so it must never reach a window day
   * before this scan does. A failure therefore throws and holds the history
   * pass behind it; only an archive range that stays unreadable is skipped,
   * loudly, as the replay does.
   *
   * Returns the applied-note line, or null while it waits.
   */
  private async applyMarketsRevision(
    a: VenueAdapter, t: BackfillResetTarget & { from: 'markets' }, nowMs: number, today: string, closedEnd: bigint, label: string,
  ): Promise<string | null> {
    const marker = resetMarker(t);
    const cursorKey = `${marker}_cursor`, throughKey = `${marker}_through`, addedKey = `${marker}_added`;
    const startOf = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

    // The volume replay re-SETs every day from the one it resumes on, with
    // this build: those are not this revision's to add to.
    let replay: { done: true } | { done: false; resumeDay: string } = { done: true };
    if (a.backfillFromUtc && this.store.getMeta(`backfill_done_${t.vid}`) !== '1') {
      const cb = this.metaBlock(`backfill_cursor_${t.vid}`);
      const resumeDay = cb === undefined
        ? a.backfillFromUtc
        : utcDay(Number((await archiveRead(() => archiveClient.getBlock({ blockNumber: cb > closedEnd ? closedEnd : cb }))).timestamp) * 1000);
      replay = { done: false, resumeDay };
    }
    const stored = this.store.getMeta(throughKey) || undefined;
    const through = marketsRevisionThrough({ through: stored, today, replay });
    if (through !== stored) await this.storeWriter.setMeta(throughKey, through);
    if (through < t.day) {
      await this.storeWriter.setMeta(marker, t.spec);
      return `${label} — nothing to add: the volume replay decodes ${t.markets.join(', ')} with this build from ${t.day}`;
    }

    const seed = seedSources(a);
    if (seed.action === 'defer') {
      this.noteOnce('backfill.deferred', `${label} waits — ${seed.reason}`, t.vid);
      return null;
    }
    if (seed.action === 'skip') {
      this.note('backfill.config.invalid', `${label} — the venue lands no fills, so it has no market history to add`, t.vid);
      await this.storeWriter.setMeta(marker, t.spec);
      return null;
    }

    const throughClosed = through < today;
    const end = throughClosed ? (await blockAtOrAfter(startOf(through) + 86_400, closedEnd + 1n)) - 1n : closedEnd;
    let cursor = this.metaBlock(cursorKey) ?? await blockAtOrAfter(startOf(t.day), closedEnd + 1n);
    const markets = new Set(t.markets);
    let added = parseMarketsAdded(this.store.getMeta(addedKey));
    const before = added.swaps;

    if (cursor <= end) {
      const retainedFromMs = retentionCutoffMs(nowMs, config.fillsRetentionDays);
      const floor = BigInt(config.getLogsMinChunk);
      const maxChunk = BigInt(config.backfillChunk);
      let chunk = maxChunk;
      let sinceFlush = 0, tries = 0, availabilityAttempts = 0;
      const kept: Fill[] = [];
      this.noteOnce('backfill.start', `${label}: adding ${t.markets.join(', ')} — blocks ${cursor}→${end} (${t.day}..${through})`, t.vid);
      while (cursor <= end) {
        if (historyRunRolled(today)) throw new HistoryDayRolledError(today);
        await holdWhileDegraded();
        const to = cursor + chunk - 1n > end ? end : cursor + chunk - 1n;
        let batches: any[][];
        try {
          batches = await allPreferAvailability(seed.all.map((s) => {
            const span = sourceSpan(s, cursor, to);
            return span ? archiveRead(() => archiveClient.getLogs({ address: s.address as any, fromBlock: span.from, toBlock: span.to, events: s.events as any } as any) as Promise<any[]>) : Promise.resolve([]);
          }));
          if (chunk < maxChunk) chunk = chunk * 2n > maxChunk ? maxChunk : chunk * 2n;
        } catch (e) {
          // Unreachable/throttled ≠ unreadable — hold, never shrink or skip.
          if (isAvailabilityFailure(e)) { await sleep(archiveRetryDelayMs(++availabilityAttempts)); continue; }
          if (chunk > floor) { chunk = chunk / 2n > floor ? chunk / 2n : floor; continue; }
          if (++tries <= 5) { await sleep(config.backfillPaceMs * 25 * tries); continue; }
          // Unreadable at the floor: an archive hole, which retrying across boots
          // cannot fix. Skip it loudly, as the replay does — never silently.
          this.note('backfill.range.skipped', `${label}: the RPC archive could not serve blocks ${cursor}→${to} (${(e as Error).message}) — skipped; ${t.markets.join(', ')} fills there are not added`, t.vid);
          batches = seed.all.map(() => []);
        }
        tries = 0;
        // A decode error (a price leg still warming) is not a hole: it throws,
        // holding the pass. The timestamp is a placeholder until the market
        // filter has run: decode only stamps it (VenueAdapter.decode), so real
        // ones are read for the kept fills' blocks alone, not every log's.
        const bundle: LogBundle = {};
        seed.all.forEach((s, i) => { bundle[s.key] = batches[i]; });
        const fills = batches.some((b) => b.length)
          ? this.ownVenues(a, await a.decode(this.ctxFor(a), bundle, () => 0, new Set()), 'revision fill')
            .filter((f) => f.venueId === t.vid && markets.has(f.market))
          : [];
        try {
          const blocks = [...new Set(fills.map((f) => f.blockNumber))];
          const ts = new Map<number, number>();
          for (let i = 0; i < blocks.length; i += 15) {
            await Promise.all(blocks.slice(i, i + 15).map(async (bn) => {
              ts.set(bn, Number((await archiveRead(() => archiveClient.getBlock({ blockNumber: BigInt(bn) }))).timestamp) * 1000);
            }));
          }
          for (const f of fills) f.ts = ts.get(f.blockNumber)!;
        } catch (e) {
          if (isAvailabilityFailure(e)) { await sleep(archiveRetryDelayMs(++availabilityAttempts)); continue; }
          throw e;
        }
        availabilityAttempts = 0;
        kept.push(...fills);
        cursor = to + 1n;
        if (++sinceFlush >= config.backfillMergeEvery || cursor > end) {
          added = await this.commitMarketsAdd(t, kept, markets, retainedFromMs, { [cursorKey]: String(cursor) }, addedKey, added);
          kept.length = 0;
          sinceFlush = 0;
        }
        await sleep(config.backfillPaceMs);
      }
      // An open Volume tab loads closed days once (REST) and then merges only
      // today's frames: one resync makes it reload the days this pass added.
      if (added.swaps > before) this.emitMsg({ ch: 'volume', resync: true });
    }

    if (!throughClosed) {
      this.noteOnce('backfill.deferred', `${label} waits for ${through} to close: its hours before this build were decoded without ${t.markets.join(', ')}`, t.vid);
      return null;
    }
    await this.storeWriter.setMeta(marker, t.spec);
    return `${label} — added ${added.swaps} ${t.markets.join(', ')} fill(s), $${added.usd.toFixed(2)}, over ${t.day}..${through}`;
  }

  /**
   * One flush of a 'markets' revision: the plan's day increments, its new
   * fills, the resume cursor and the running total, in ONE snapshot. HELD is
   * what the store has plus what is still on its way there: just after the
   * window's last day closes, the tail's fills of that day may be in neither
   * place yet but the queue. Memory takes the increments first and gives them
   * back if the write fails; snapshots commit in order, so none cut before
   * this one can land after it with the old value.
   */
  private async commitMarketsAdd(
    t: BackfillResetTarget & { from: 'markets' },
    kept: readonly Fill[],
    markets: ReadonlySet<string>,
    retainedFromMs: number,
    meta: Record<string, string>,
    addedKey: string,
    added: { swaps: number; usd: number },
  ): Promise<{ swaps: number; usd: number }> {
    const ids = [...new Set(kept.map((f) => f.id))];
    const held = new Set(this.store.fillsByIds(ids).map((f) => f.id));
    for (const owner of [this.fills, this.dirty, this.pending]) for (const f of owner) held.add(f.id);
    for (const batch of this.inflightFills) for (const f of batch) held.add(f.id);
    const plan = planMarketsAdd(kept, markets, (id) => held.has(id), retainedFromMs);

    const touched: Array<{ d: DailyVolume; was?: { usd: number; swaps: number } }> = [];
    const total = { ...added };
    for (const [day, add] of plan.days) {
      let d = this.days.find((x) => x.utcDay === day);
      if (!d) { d = this.emptyDay(day, false); this.days.push(d); }
      const was = d.byVenue[t.vid];
      d.byVenue[t.vid] = { usd: (was?.usd ?? 0) + add.usd, swaps: (was?.swaps ?? 0) + add.swaps };
      touched.push({ d, was });
      total.swaps += add.swaps;
      total.usd += add.usd;
    }
    if (touched.length) this.days.sort((x, y) => (x.utcDay < y.utcDay ? -1 : 1));
    try {
      await this.writeSnapshot({ days: touched.map((x) => x.d), meta: { ...meta, [addedKey]: JSON.stringify(total) }, fills: plan.insert });
    } catch (e) {
      for (const { d, was } of touched) {
        if (was) d.byVenue[t.vid] = was;
        else delete d.byVenue[t.vid];
      }
      throw e;
    }
    if (plan.insert.length) this.dropAggregates();
    return total;
  }

  /** Run `fn` between two tail cycles: no fill is ingested, and the cursor
   *  does not move, until it settles. */
  private inTail<T>(fn: () => Promise<T>): Promise<T> {
    if (this.loopsStopped) return Promise.reject(new Error('source stopped'));
    return new Promise<T>((resolve, reject) => {
      this.tailGates.push(() => fn().then(resolve, reject));
    });
  }

  /** Persist the pending marker FIRST: a re-read must survive a restart that
   *  lands before it finishes, or today's prefix is lost exactly as before. */
  private async queueReread(vid: string, day: string): Promise<void> {
    delete this.snapshotMeta[rereadKey(vid)];   // an earlier re-read's clear must not land after this
    await this.storeWriter.setMeta(rereadKey(vid), day);
    // ...and again once acknowledged: an in-flight snapshot that carried the
    // clear and FAILED restores it into snapshotMeta while the write is
    // pending. Worker replies are ordered, so that restore has run by now.
    delete this.snapshotMeta[rereadKey(vid)];
    this.rereads.set(vid, day);
    void this.runRereads();
  }

  private async runRereads(): Promise<void> {
    if (this.rereadRunning || this.loopsStopped) return;
    this.rereadRunning = true;
    try {
      for (const [vid, day] of [...this.rereads]) {
        const a = ADAPTERS.find((x) => x.venues().some((v) => v.id === vid));
        // A day that closed while this waited is the closed-day replay's now:
        // its marker stays, and the reset pass carries it (carriedRereadTarget).
        if (!a || day !== utcDay()) { this.rereads.delete(vid); continue; }
        const name = a.venues()[0]?.name ?? vid;
        try {
          await this.rereadToday(a, vid, name, day);
          this.rereads.delete(vid);
        } catch (e) {
          // held, never skipped: retried on the rediscovery tick
          this.noteOnce('backfill.reread.held', `${name}: re-read of ${day} paused (${(e as Error).message}); retried automatically`, vid);
        }
      }
    } finally {
      this.rereadRunning = false;
    }
  }

  /**
   * Re-decode TODAY for one venue — midnight to the tail's cursor — and SET its
   * day bucket and fills to the result.
   *
   * Today is the one day no replay can reach: the closed-day scans stop at
   * midnight, and the tail only reads forward. So the hours between midnight
   * and the deploy that changed a decode (Metric's v1 sources, 2026-10-12:
   * ~$2.5M) were decoded by the previous build and stayed that way. The day
   * was "closed" by the next midnight, after the reset that would have
   * replayed it had already run.
   *
   * The bucket is SET, not incremented: the tail's count over [midnight,
   * cursor] is exactly what the re-read replaces, so it has to be computed
   * against the SAME cursor. The bulk is read while the tail keeps running;
   * the remainder (old cursor → current cursor) is read and the result applied
   * inside the tail (inTail), so no cycle ingests between the last read and
   * the SET. HOT pool on purpose: these blocks are under a day old, and they
   * are the blocks the tail itself just read there.
   */
  private async rereadToday(a: VenueAdapter, vid: string, name: string, day: string): Promise<void> {
    const dayStartMs = Date.parse(`${day}T00:00:00Z`);
    const dayEndMs = dayStartMs + 86_400_000;
    const bulkEnd = this.lastBlock;
    const start = await this.firstBlockOfDay(dayStartMs, bulkEnd);
    if (start === null) {
      // the tail has not reached today yet (boot gap-fill): it will decode
      // today with this build, so there is nothing to re-read
      this.snapshotMeta[rereadKey(vid)] = '';
      this.note('backfill.reread', `${name}: ${day} not reached by the tail yet — it decodes the day with this build, nothing to re-read`, vid);
      return;
    }
    const decoded: Fill[] = [];
    await this.rereadRange(a, vid, start, bulkEnd, dayStartMs, dayEndMs, decoded);
    // Labels for the bulk OUTSIDE the gate: attribution is a lookup per tx, and
    // a day's worth inside it would hold the live tail for all of them.
    try { await this.attributor.attribute(decoded); } catch { /* labels only */ }
    await this.inTail(async () => {
      const end = this.lastBlock;
      if (end > bulkEnd) {
        const rest: Fill[] = [];
        await this.rereadRange(a, vid, bulkEnd + 1n, end, dayStartMs, dayEndMs, rest);
        try { await this.attributor.attribute(rest); } catch { /* labels only */ }
        decoded.push(...rest);
      }

      // What the tail holds for the range: stored rows, fills cut into a
      // snapshot that has not committed yet (posted before reconcileFills, so
      // its row lands first and is deleted after it), and in-memory ones (the
      // newest object wins). Everything from here to the reconcile post is
      // synchronous, so no snapshot can be cut in between.
      const inRange = (f: Fill) => f.venueId === vid && f.ts >= dayStartMs && f.ts < dayEndMs && BigInt(f.blockNumber) <= end;
      const held = new Map<string, Fill>();
      for (const f of this.store.venueFillsInRange(vid, dayStartMs, dayEndMs, end)) held.set(f.id, f);
      for (const batch of this.inflightFills) for (const f of batch) if (inRange(f)) held.set(f.id, f);
      for (const owner of [this.fills, this.dirty, this.pending]) for (const f of owner) if (inRange(f)) held.set(f.id, f);
      const plan = planReread([...held.values()], decoded);

      // Drop the replaced fills from memory BEFORE the write is queued: a
      // snapshot taken meanwhile would otherwise write the old row back.
      const gone = new Set(plan.deleteIds);
      const dropGone = () => {
        if (!gone.size) return;
        const drop = (f: Fill) => gone.has(f.id);
        this.fills.splice(0, this.fills.length, ...this.fills.filter((f) => !drop(f)));
        for (const set of [this.pending, this.dirty]) for (const f of set) if (drop(f)) set.delete(f);
        for (const id of gone) { this.countedIds.delete(id); this.dirtyCurves.delete(id); }
      };
      dropGone();
      const written = await this.storeWriter.reconcileFills(plan.deleteIds, plan.insert);
      // Again after the ACK: a snapshot in flight before the write that then
      // failed merges its captured fills/curves back into dirty while we await,
      // and the next snapshot would write a deleted fill (or its old curve)
      // back. Replies are ordered, so that merge has already happened.
      dropGone();
      // The served tape and the ingest dedup window follow the store. NOT via
      // ingest(): the bucket below is SET, so an ingest would count them twice.
      // Markout/curve queueing mirrors ingest's, curve-only branch included.
      const ring = mergeIntoRing(this.fills, plan.insert, FILL_RING_SIZE);
      this.fills = ring.ring;
      for (const f of ring.added) {
        this.countedIds.add(f.id);
        if (this.hasFutureMarkoutHorizon(f)) this.pending.add(f);
        else if (this.curveInRing(f)) { this.curveOnly.add(f); this.pending.add(f); }
      }
      for (const f of ring.evicted) this.countedIds.delete(f.id);

      const d = this.dayFor(dayStartMs);
      const before = d.byVenue[vid] ?? { usd: 0, swaps: 0 };
      // An explicit zero, never a deleted key: the snapshot only upserts the
      // venues a day carries, so a missing key leaves the stale SQLite row in
      // place — while the same snapshot clears the marker that would retry it.
      d.byVenue[vid] = { ...plan.total };
      this.dirtyDays.add(day);
      this.snapshotMeta[rereadKey(vid)] = '';
      if (written.deleted || written.inserted) {
        this.dropAggregates();
        // connected tapes only take per-fill upserts — a deletion needs a reload
        this.emitMsg({ ch: 'fill', resync: true });
      }
      this.note('backfill.reread', `${name}: re-read ${day} blocks ${start}→${end} — ${before.swaps}→${plan.total.swaps} swaps, $${Math.round(before.usd)}→$${Math.round(plan.total.usd)}; fills +${written.inserted} −${written.deleted}`, vid);
    });
  }

  /** Decode [from, to] in tail-sized windows, keeping this day's own fills.
   *  Windowed for the same reason the tail is: a whole day of raw logs held at
   *  once is the OOM the 320MB heap already hit (2026-09-16). */
  private async rereadRange(a: VenueAdapter, vid: string, from: bigint, to: bigint, dayStartMs: number, dayEndMs: number, out: Fill[]): Promise<void> {
    const window = BigInt(TAIL_WINDOW_BLOCKS) * 10n;
    const hotLogs = (p: { address: unknown; fromBlock: bigint; toBlock: bigint; events?: unknown }) =>
      hotRead(() => publicClient.getLogs(p as any) as Promise<unknown[]>);
    for (let lo = from; lo <= to; lo += window) {
      if (this.loopsStopped) throw new Error('source stopped');
      const hi = lo + window - 1n > to ? to : lo + window - 1n;
      // logSources() per window: it is the fail-closed gate (throws while
      // discovery is not ready), and decode may admit a pool mid-range.
      const sources = a.logSources();
      const bundle: LogBundle = {};
      const blocks = new Set<bigint>();
      await Promise.all(sources.map(async (s) => {
        const span = sourceSpan(s, lo, hi);
        const logs = span ? (await getLogsChunked({ address: s.address, fromBlock: span.from, toBlock: span.to, events: s.events as any }, undefined, hotLogs)) as any[] : [];
        bundle[s.key] = logs;
        for (const l of logs) blocks.add(l.blockNumber);
      }));
      const ts = new Map<bigint, number>();
      const list = [...blocks];
      for (let i = 0; i < list.length; i += 15) {
        await Promise.all(list.slice(i, i + 15).map(async (bn) => {
          ts.set(bn, Number((await hotRead(() => publicClient.getBlock({ blockNumber: bn }))).timestamp) * 1000);
        }));
      }
      const tsOf = (bn: bigint) => {
        const t = ts.get(bn);
        if (t == null) throw new Error(`missing block timestamp for ${bn}`);
        return t;
      };
      const fills = this.ownVenues(a, await a.decode(this.ctxFor(a), bundle, tsOf, new Set()), 'fill');
      for (const f of fills) if (f.venueId === vid && f.ts >= dayStartMs && f.ts < dayEndMs) out.push(f);
      await sleep(config.backfillPaceMs);
    }
  }

  /** First block at or after `dayStartMs` within [hi − 400k, hi] (≈ 33h at
   *  0.3s blocks, so it always holds midnight), or null when even `hi` is
   *  earlier. A local search rather than blockAtOrAfter, which bisects from
   *  block 0. The bracket's lower header is deliberately older than a day, so
   *  it alone is read from the ARCHIVE pool; every probe after it falls
   *  between it and `hi`, inside today's span, and stays on the hot pool. */
  private async firstBlockOfDay(dayStartMs: number, hi: bigint): Promise<bigint | null> {
    const tsOf = async (bn: bigint) => Number((await hotRead(() => publicClient.getBlock({ blockNumber: bn }))).timestamp) * 1000;
    if (hi <= 0n || await tsOf(hi) < dayStartMs) return null;
    let lo = hi > 400_000n ? hi - 400_000n : 0n;
    const loTs = Number((await archiveRead(() => archiveClient.getBlock({ blockNumber: lo }))).timestamp) * 1000;
    if (loTs >= dayStartMs) {
      if (lo === 0n) return 0n;
      throw new Error(`midnight is more than 400k blocks behind block ${hi}`);
    }
    let h = hi;   // invariant: ts(lo) < dayStart <= ts(h)
    while (h - lo > 1n) {
      const mid = lo + (h - lo) / 2n;
      if (await tsOf(mid) >= dayStartMs) h = mid; else lo = mid;
    }
    return h;
  }

  // ── background on-chain backfill ─────────────────────────────────────────────
  /**
   * Seed deep daily-volume history for adapters that declared `backfillFromUtc`
   * but have no keyless subgraph — by replaying their Swap logs on-chain. Runs
   * OFF the boot path (never blocks the dashboard or the live tail): chunked +
   * paced under the RPC's limits, resumable across restarts, and self-healing
   * (retried each boot and on the rediscovery tick until `backfill_done_<venue>` is set).
   */
  private async backfillOnchain(nowMs: number, end: bigint): Promise<void> {
    for (const a of ADAPTERS) {
      const sinceUtc = a.backfillFromUtc;
      const vid = a.venues()[0]?.id ?? '';
      const name = a.venues()[0]?.name ?? vid;
      if (!sinceUtc || !vid || this.store.getMeta(`backfill_done_${vid}`) === '1') continue;
      const seed = seedSources(a);
      // 'skip' (can't land fills by design) is done forever; 'defer' (pools
      // quarantined/undiscovered right now) must NOT be — the done-flag would
      // silently drop the venue's lifetime history (issue: seed vs quarantine).
      if (seed.action === 'skip') { await this.storeWriter.setMeta(`backfill_done_${vid}`, '1'); continue; }
      if (seed.action === 'defer') { this.noteOnce('backfill.deferred', `${name} backfill deferred — ${seed.reason}`, vid); continue; }
      try { await this.backfillAdapter(a, vid, name, sinceUtc, seed.fills, nowMs, end); }
      catch (e) {
        if (e instanceof HistoryDayRolledError) throw e;
        this.noteOnce('backfill.paused', `${name} backfill paused (${(e as Error).message}); retried automatically`, vid);
      }
    }
  }

  private async backfillAdapter(a: VenueAdapter, vid: string, name: string, sinceUtc: string, sources: LogSource[], nowMs: number, end: bigint): Promise<void> {
    if (end <= 0n) return;
    await holdWhileDegraded();
    const today = utcDay(nowMs);
    const startSec = Math.floor(Date.parse(`${sinceUtc}T00:00:00Z`) / 1000);
    if (!Number.isFinite(startSec)) { this.noteOnce('backfill.config.invalid', `${name} backfill: invalid backfillFromUtc '${sinceUtc}'`, vid); return; }

    // Resume from a DAY-ALIGNED block: re-scan the in-progress day from its start
    // so mergeBackfill's SET-per-day stays idempotent (earlier days already done).
    let from = await blockAtOrAfter(startSec, end);
    const cur = this.store.getMeta(`backfill_cursor_${vid}`);
    if (cur) {
      const cb = BigInt(cur);
      if (cb > from && cb <= end + 1n) {
        try {
          const b = await archiveRead(() => archiveClient.getBlock({ blockNumber: cb > end ? end : cb }));
          const daySec = Math.floor(Date.parse(`${utcDay(Number(b.timestamp) * 1000)}T00:00:00Z`) / 1000);
          from = await blockAtOrAfter(daySec, end);
        } catch (e) {
          // The resume block remains valid when the archive is unavailable or
          // throttled. Hold it instead of turning a brief incident into a full
          // venue-lifetime replay; only an answer-level missing block may fall
          // back to the configured history start.
          if (isAvailabilityFailure(e)) throw e;
        }
      }
    }
    if (from > end) {
      if (historyRunRolled(today)) throw new HistoryDayRolledError(today);
      await this.storeWriter.setMeta(`backfill_done_${vid}`, '1');
      return;
    }

    // `end` is the last block before `today`; a rollover expires the run before
    // its done marker, then the next run extends the bound and revisits the day.
    const acc = new Map<string, { usd: number; swaps: number }>(); // closed utcDay -> totals
    // Values already committed during THIS run. Periodic checkpoints can then
    // write only days whose accumulated total changed, rather than replaying
    // the full in-memory history on the main event loop.
    const flushed = new Map<string, { usd: number; swaps: number }>();
    let chunk = BigInt(config.backfillChunk);
    const floor = BigInt(config.getLogsMinChunk);
    let cursor = from;
    let sinceMerge = 0;
    let availabilityAttempts = 0;
    // RPC archive holes: some providers permanently fail getLogs for specific
    // historical ranges ("error getting block header from triedb and archive").
    // Retrying across boots can never fix those — the backfill would stall at the
    // same block forever (observed live on Metric ~block 73.05M). After retries
    // exhaust at the floor chunk size we SKIP the range and say so loudly. Holes
    // can span MILLIONS of blocks, so while consecutive chunks keep failing the
    // skip stride DOUBLES (floor → ~a day per hop, retries drop to 1): the hole's
    // far edge is found in O(log) hops instead of hours of 90-block skips. Cost:
    // the last hop can overshoot past the hole's end by up to one stride — those
    // blocks are counted in `skipped` (loud), never silently.
    let skipped = 0n;
    let holeRun = 0;
    let skipStride = floor;
    // ≈ 18h of Monad blocks at the official 0.3s/block. Left at the value
    // chosen when 0.4s/block was assumed (where it WAS a full UTC day): this is
    // a cap on how far one hole-skip hop may leap, and raising it only widens
    // the last hop's overshoot — which is real blocks, counted in `skipped` and
    // reported loudly. Bump to 288_000n to restore the "one UTC day" intent.
    const MAX_STRIDE = 216_000n;
    const maxChunk = BigInt(config.backfillChunk);
    this.noteOnce('backfill.start', `${name}: on-chain backfill — blocks ${from}→${end} (venue history since ${sinceUtc})`, vid);

    /** one getLogs across every fill source over [cursor, t]; throws on failure.
     *  ARCHIVE pool — this replays from the venue's deploy day. A source is
     *  only fetched inside its declared block span (a retired generation). */
    const fetchRange = (t: bigint) => allPreferAvailability(sources.map((s) => {
      const span = sourceSpan(s, cursor, t);
      return span ? archiveRead(() => archiveClient.getLogs({ address: s.address as any, fromBlock: span.from, toBlock: span.to, events: s.events as any } as any) as Promise<any[]>) : Promise.resolve([]);
    }));

    while (cursor <= end) {
      if (historyRunRolled(today)) throw new HistoryDayRolledError(today);
      if (await holdWhileDegraded()) this.noteOnce('backfill.held', `${name} backfill held while archive RPC was unavailable — resumed on primary`, vid);
      // ── in-hole mode: probe a floor-sized slice at the cursor. Readable → the
      // hole is over (fall through and INGEST that probe normally). Unreadable →
      // skip a stride and double it (capped), so a multi-million-block hole is
      // crossed in O(log) hops.
      let to = cursor + chunk - 1n > end ? end : cursor + chunk - 1n;
      let batches: any[][] | null = null;
      let availabilityFailed = false;
      if (holeRun > 0) {
        const probeTo = cursor + floor - 1n > end ? end : cursor + floor - 1n;
        try {
          batches = await fetchRange(probeTo);
          to = probeTo;                      // ingest exactly the probe slice
          holeRun = 0; skipStride = floor;   // hole ended — back to normal scanning
        } catch (e) {
          // Not getting an ANSWER proves nothing about the archive's CONTENTS —
          // whether we could not reach it or it throttled us (429). Skipping on it would leap a
          // doubling stride (up to ~18h of blocks per hop) over data that is
          // perfectly readable, and then mark those days done. Hold the cursor
          // and wait for the pool instead; a real hole ANSWERS, with an error.
          if (isAvailabilityFailure(e)) { availabilityFailed = true; }
          else {
            const strideTo = cursor + skipStride - 1n > end ? end : cursor + skipStride - 1n;
            skipped += strideTo - cursor + 1n;
            holeRun++;
            skipStride = skipStride * 2n > MAX_STRIDE ? MAX_STRIDE : skipStride * 2n;
            cursor = strideTo + 1n;
            await sleep(config.backfillPaceMs);
          }
        }
      } else {
        // ── normal mode: shrink the span on a range error, back off on a
        // transient error, and enter hole mode when the floor chunk still fails.
        let tries = 0;
        while (batches === null) {
          try {
            batches = await fetchRange(to);
            if (chunk < maxChunk) { chunk = chunk * 2n > maxChunk ? maxChunk : chunk * 2n; } // recover after shrinks
          } catch (e) {
            // Unreachable (or throttled) ≠ unreadable: it must never shrink the
            // span (the node never served the request) nor age into hole mode. Retry
            // the same cursor until the pool answers — holdWhileDegraded above
            // parks the crawl entirely once the breaker notices.
            if (isAvailabilityFailure(e)) { availabilityFailed = true; break; }
            if (chunk > floor) { chunk = chunk / 2n > floor ? chunk / 2n : floor; break; } // too wide → shrink, retry cursor
            if (++tries <= 5) { await sleep(config.backfillPaceMs * 25 * tries); continue; } // transient → back off
            // permanently unreadable at floor granularity → enter hole mode.
            skipped += to - cursor + 1n;
            holeRun = 1;
            skipStride = floor * 2n;
            this.noteOnce('backfill.range.skipped', `${name} backfill: RPC archive could not serve blocks near ${cursor} — skipping unreadable range(s); affected day(s) may undercount`, vid);
            cursor = to + 1n;
            break;
          }
        }
      }
      if (availabilityFailed) { await sleep(archiveRetryDelayMs(++availabilityAttempts)); continue; }
      if (batches === null) continue; // shrank or entered hole mode — loop from the adjusted cursor

      const all = batches.flat();
      if (all.length) {
        // Day-stamping reads only the chunk's first and last log blocks, plus a
        // bisect when they fall on different days — see stampChunkDays for why
        // one stamp per chunk was not enough. Each block read is retried on a
        // transient error; an availability failure holds the chunk intact.
        const readBlockMs = async (bn: bigint): Promise<number> => {
          for (let i = 0; ; i++) {
            try { return Number((await archiveRead(() => archiveClient.getBlock({ blockNumber: bn }))).timestamp) * 1000; }
            catch (e) {
              if (isAvailabilityFailure(e) || i >= 2) throw e;
              await sleep(config.backfillPaceMs * 5 * (i + 1));
            }
          }
        };
        const blocks = [...new Set<bigint>(all.map((l) => BigInt(l.blockNumber)))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
        let tsOf: ((bn: bigint) => number) | null = null;
        let timestampUnavailable = false;
        try { tsOf = await stampChunkDays(blocks, readBlockMs); }
        catch (e) { if (!isAvailabilityFailure(e)) throw e; timestampUnavailable = true; }
        // getLogs succeeded, but without a timestamp the whole chunk is unknown.
        // Hold it intact on an outage/429; the next pass re-fetches idempotently.
        if (timestampUnavailable) { await sleep(archiveRetryDelayMs(++availabilityAttempts)); continue; }
        if (tsOf) {
          const bundle: LogBundle = {};
          sources.forEach((s, i) => { bundle[s.key] = batches![i]; });
          const fills = this.ownVenues(a, await a.decode(this.ctxFor(a), bundle, tsOf, new Set()), 'backfill fill');
          for (const f of fills) {
            const day = utcDay(f.ts);
            if (day >= today) continue; // today is owned by the live tail — no overlap
            const e = acc.get(day) ?? { usd: 0, swaps: 0 };
            e.usd += f.usd; e.swaps += 1; acc.set(day, e);
          }
        } else {
          this.noteOnce('backfill.range.skipped', `${name} backfill: block timestamps unresolved near ${cursor} — chunk skipped`, vid);
        }
      }

      availabilityAttempts = 0;
      cursor = to + 1n;
      if (++sinceMerge >= config.backfillMergeEvery || cursor > end) {
        const changed = this.mergeBackfill(vid, acc, flushed);
        await this.writeSnapshot({ days: changed, meta: { [`backfill_cursor_${vid}`]: String(cursor) }, fills: [] });
        for (const d of changed) flushed.set(d.utcDay, { ...acc.get(d.utcDay)! });
        sinceMerge = 0;
      }
      await sleep(config.backfillPaceMs);
    }

    const changed = this.mergeBackfill(vid, acc, flushed);
    await this.writeSnapshot({ days: changed, meta: { [`backfill_cursor_${vid}`]: String(end + 1n) }, fills: [] });
    if (historyRunRolled(today)) throw new HistoryDayRolledError(today);
    // done even when ranges were skipped — re-running every boot can't fix an RPC
    // archive hole. To re-attempt after the provider repairs it: delete the
    // 'backfill_done_<venue>' + 'backfill_cursor_<venue>' meta rows (the SET-per-day
    // merge makes a full re-run idempotent).
    await this.storeWriter.setMeta(`backfill_done_${vid}`, '1');
    this.note('backfill.done', `${name}: backfill complete — ${acc.size} day(s) seeded` +
      (skipped > 0n ? ` (${skipped} block(s) unreadable on the RPC archive and skipped — those windows may undercount)` : ''), vid);
    this.emitMsg({ ch: 'volume', data: this.cloneDay(this.today()) }); // nudge connected clients
  }

  /** Merge accumulated backfill totals into this.days, SET per (day, venue):
   *  backfill is authoritative for a CLOSED day it fully scanned, and the live
   *  tail only ever writes today+, so a SET can never double-count. */
  private mergeBackfill(
    vid: string,
    acc: Map<string, { usd: number; swaps: number }>,
    flushed: ReadonlyMap<string, { usd: number; swaps: number }> = new Map(),
  ): DailyVolume[] {
    const changed: DailyVolume[] = [];
    for (const [day, tot] of acc) {
      let d = this.days.find((x) => x.utcDay === day);
      if (!d) { d = this.emptyDay(day, false); this.days.push(d); }
      d.byVenue[vid] = { usd: tot.usd, swaps: tot.swaps };
      const prior = flushed.get(day);
      if (!prior || prior.usd !== tot.usd || prior.swaps !== tot.swaps) changed.push(d);
    }
    this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
    return changed;
  }

  // ── onboarding markout backfill (last ~30d per venue) ────────────────────────
  /**
   * When a venue is onboarded (no `mkfill_done_<vid>` marker), give it the
   * leaderboard window it's missing: scan its last MARKOUT_BACKFILL_DAYS of
   * fills on-chain with REAL block timestamps, persist them (insert-if-absent —
   * never clobbering a live-marked fill), then mark every still-unmarked fill
   * against the exchanges' ARCHIVED prices (server/src/history/cex.ts). Bounded
   * to the UI's widest window on purpose — the display never goes deeper.
   * Every stage is resumable (cursor metas); the remark also re-runs cheaply on
   * later boots so days deferred on an unpublished archive (the newest Bybit
   * book day) self-heal once it publishes.
   */
  private async markoutOnboarding(nowMs: number, end: bigint): Promise<void> {
    if (this.remarkRunning) return;
    this.remarkRunning = true;
    try { await this.markoutOnboardingInner(nowMs, end); }
    finally { this.remarkRunning = false; }
  }

  /** Timer-driven retry of DEFERRED markout backfills (e.g. a Bybit book
   *  archive day that wasn't published yet): re-walk each venue's remark
   *  cursors. No-op while the boot chain still owns the stage, and cheap when
   *  there is nothing markable (SQL candidates + a HEAD probe per missing day). */
  private async remarkSweep(): Promise<void> {
    if (this.remarkRunning) return;
    this.remarkRunning = true;
    try {
      for (const a of ADAPTERS) {
        const vid = a.venues()[0]?.id ?? '';
        if (!vid || this.store.getMeta(`mkfill_done_${vid}`) !== '1') continue; // boot chain owns pre-scan venues
        await this.remarkVenue(vid, a.venues()[0]?.name ?? vid);
      }
    } catch (e) {
      this.noteOnce('markout.paused', `markout retry sweep failed: ${(e as Error).message}; retried on the next sweep`);
    } finally {
      this.remarkRunning = false;
    }
  }

  private async markoutOnboardingInner(nowMs: number, end: bigint): Promise<void> {
    for (const a of ADAPTERS) {
      const vid = a.venues()[0]?.id ?? '';
      const name = a.venues()[0]?.name ?? vid;
      if (!vid) continue;
      // ALL sources (fills + state + attribution), unlike the volume backfill:
      // these rows are user-visible in the tape/leaderboard, so decode needs its
      // state (e.g. Clober book Opens) and router attribution to label them.
      const seed = seedSources(a);
      if (seed.action === 'skip') { await this.storeWriter.setMeta(`mkfill_done_${vid}`, '1'); continue; }
      if (seed.action === 'defer') { this.noteOnce('markout.deferred', `${name} markout onboarding deferred — ${seed.reason}`, vid); continue; }
      try {
        if (this.store.getMeta(`mkfill_done_${vid}`) !== '1') await this.backfillRecentFills(a, vid, name, seed.all, nowMs, end);
        await this.remarkVenue(vid, name);
      } catch (e) {
        if (e instanceof HistoryDayRolledError) throw e;
        this.noteOnce('markout.paused', `${name} markout onboarding paused (${(e as Error).message}); retried automatically`, vid);
      }
    }
  }

  /** Scan the venue's recent fills on-chain (day-aligned window, real block
   *  timestamps) and persist them. Volume buckets are NOT touched — closed-day
   *  volume is owned by the venue's volume backfill / subgraph seed, and the
   *  deterministic fill ids make this idempotent against both. */
  private async backfillRecentFills(a: VenueAdapter, vid: string, name: string, sources: LogSource[], nowMs: number, end: bigint): Promise<void> {
    if (end <= 0n) return;
    await holdWhileDegraded();
    const today = utcDay(nowMs);
    // Day-ALIGNED window start so every scanned day is complete — a partial
    // oldest day would later reconcile an undercounted swap count onto a day the
    // volume backfill counted fully.
    // Shared with the reset's delete boundary (fillsScanFromDay) so the two
    // cannot drift: anything deleted below this start is never re-inserted.
    const sinceDay = fillsScanFromDay(a.backfillFromUtc, nowMs, config.markoutBackfillDays);
    const startSec = Math.floor(Date.parse(`${sinceDay}T00:00:00Z`) / 1000);
    let from = await blockAtOrAfter(startSec, end);
    const cur = this.store.getMeta(`mkfill_cursor_${vid}`);
    if (cur) {
      const cb = BigInt(cur);
      if (cb > from && cb <= end + 1n) from = cb; // resume (fills are id-deduped, no day alignment needed)
    }
    if (from > end) {
      if (historyRunRolled(today)) throw new HistoryDayRolledError(today);
      await this.storeWriter.setMeta(`mkfill_done_${vid}`, '1');
      return;
    }

    // `end` is the last block before `today`. If midnight arrives during the
    // scan, the done marker stays unset; the next run begins at this run's
    // `end + 1`, exactly the first block of the newly closed day.
    let chunk = BigInt(config.backfillChunk);
    const floor = BigInt(config.getLogsMinChunk);
    const maxChunk = BigInt(config.backfillChunk);
    let cursor = from;
    let sinceFlush = 0;
    let persisted = 0;
    let tsFails = 0; // consecutive timestamp-resolution failures at the SAME cursor
    let availabilityAttempts = 0;
    const batch: Fill[] = [];
    // `sinceDay` is the WINDOW anchor, not necessarily where this scan begins: a
    // resumed cursor (or a targeted BACKFILL_RESET) moves `from` forward. Naming
    // the anchor as if it were the start reported a scan that was not happening —
    // the same mislabel already corrected on backfill.start above.
    this.noteOnce('markout.scan.start', `${name}: onboarding fill scan — blocks ${from}→${end} (window since ${sinceDay})`, vid);

    // ARCHIVE pool — the window reaches back markoutBackfillDays (30d default),
    // far past a pruning fullnode's retention.
    const fetchAll = (t: bigint) => allPreferAvailability(sources.map((s) => {
      const span = sourceSpan(s, cursor, t);
      return span ? archiveRead(() => archiveClient.getLogs({ address: s.address as any, fromBlock: span.from, toBlock: span.to, events: s.events as any } as any) as Promise<any[]>) : Promise.resolve([]);
    }));

    while (cursor <= end) {
      if (historyRunRolled(today)) throw new HistoryDayRolledError(today);
      if (await holdWhileDegraded()) this.noteOnce('markout.scan.held', `${name} onboarding scan held while archive RPC was unavailable — resumed on primary`, vid);
      const to = cursor + chunk - 1n > end ? end : cursor + chunk - 1n;
      let batches: any[][] | null = null;
      let tries = 0;
      let availabilityFailed = false;
      while (batches === null) {
        try {
          batches = await fetchAll(to);
          if (chunk < maxChunk) chunk = chunk * 2n > maxChunk ? maxChunk : chunk * 2n; // recover after shrinks
        } catch (e) {
          // Unreachable/throttled ≠ unreadable — see the volume backfill. A skip here
          // permanently omits fills from the 30-day markout window, so a pool
          // outage must hold rather than consume the range.
          if (isAvailabilityFailure(e)) { availabilityFailed = true; break; }
          if (chunk > floor) { chunk = chunk / 2n > floor ? chunk / 2n : floor; break; } // too wide → shrink, retry cursor
          if (++tries <= 5) { await sleep(config.backfillPaceMs * 25 * tries); continue; } // transient → back off
          // A recent range should never be an archive hole; if the RPC still
          // can't serve it, skip ONE floor chunk loudly rather than stalling.
          this.noteOnce('markout.range.skipped', `${name} onboarding: RPC could not serve blocks near ${cursor} — a small range was skipped`, vid);
          cursor = to + 1n;
          break;
        }
      }
      if (availabilityFailed) { await sleep(archiveRetryDelayMs(++availabilityAttempts)); continue; }
      if (batches === null) continue; // shrank or skipped — loop from the adjusted cursor

      const all = batches.flat();
      if (all.length) {
        // REAL per-block timestamps (batched + paced): markouts are a seconds-
        // scale join, so the chunk-anchor shortcut the volume backfill uses
        // would smear fills by minutes.
        const blockTs = new Map<string, number>();
        const blocks = [...new Set<bigint>(all.map((l) => l.blockNumber as bigint))];
        const POOL = 15;
        let tsFailed = false;
        let timestampUnavailable = false;
        for (let i = 0; i < blocks.length && !tsFailed && !timestampUnavailable; i += POOL) {
          await Promise.all(blocks.slice(i, i + POOL).map(async (bn) => {
            for (let r = 0; r < 3; r++) {
              try {
                blockTs.set(String(bn), Number((await archiveRead(() => archiveClient.getBlock({ blockNumber: bn }))).timestamp) * 1000);
                return;
              } catch (e) {
                if (isAvailabilityFailure(e)) { timestampUnavailable = true; return; }
                await sleep(config.backfillPaceMs * 5 * (r + 1));
              }
            }
            tsFailed = true;
          }));
          await sleep(config.backfillPaceMs);
        }
        if (timestampUnavailable) { await sleep(archiveRetryDelayMs(++availabilityAttempts)); continue; }
        // bounded retry: a permanently unresolvable block must not loop forever —
        // after 3 attempts skip the chunk (its fills stay un-backfilled, loudly).
        if (tsFailed) {
          if (++tsFails < 3) { await sleep(config.backfillPaceMs * 25 * tsFails); continue; }
          this.noteOnce('markout.range.skipped', `${name} onboarding: block timestamps unresolved near ${cursor} — chunk skipped`, vid);
          tsFails = 0;
          cursor = to + 1n;
          continue;
        }
        tsFails = 0;
        const tsOf = (bn: bigint) => {
          const ts = blockTs.get(String(bn));
          if (ts == null) throw new Error(`missing block timestamp for ${bn}`);
          return ts;
        };
        const bundle: LogBundle = {};
        sources.forEach((s, i) => { bundle[s.key] = batches![i]; });
        const fills = this.ownVenues(a, await a.decode(this.ctxFor(a), bundle, tsOf, new Set()), 'onboarding fill');
        // today is owned by the live tail (its volume/markouts accrue there).
        for (const f of fills) if (utcDay(f.ts) < today) batch.push(f);
      }

      availabilityAttempts = 0;
      cursor = to + 1n;
      if (++sinceFlush >= config.backfillMergeEvery || cursor > end) {
        persisted += await this.storeWriter.insertFillsIfAbsent(batch);
        batch.length = 0;
        await this.storeWriter.setMeta(`mkfill_cursor_${vid}`, String(cursor));
        sinceFlush = 0;
      }
      await sleep(config.backfillPaceMs);
    }

    await this.storeWriter.setMeta(`mkfill_cursor_${vid}`, String(end + 1n));
    if (historyRunRolled(today)) throw new HistoryDayRolledError(today);
    await this.storeWriter.setMeta(`mkfill_done_${vid}`, '1');
    this.note('markout.scan.done', `${name}: onboarding fill scan complete — ${persisted} historical fill(s) persisted`, vid);
  }

  /** Mark this venue's still-unmarked persisted fills against archived CEX
   *  prices, per market, walking closed days forward (resumable cursor). */
  private async remarkVenue(vid: string, name: string): Promise<void> {
    // NOW-relative (not boot-relative): the retry timer runs for the process
    // lifetime, and each sweep may mark newly-closed days. The live aging path
    // owns the most recent window either way.
    const cutoff = Date.now() - 2 * 3_600_000;
    for (const market of this.store.remarkCandidateMarkets(vid, cutoff)) {
      // per-market isolation: one market's archive failure (e.g. a geo-blocked
      // endpoint) must not skip the venue's OTHER markets — observed in prod
      // when a MON cross-leg 403 paused the whole venue's remark stage.
      try { await this.remarkVenueMarket(vid, name, market, cutoff); }
      catch (e) { this.noteOnce('markout.paused', `${name} ${market}: markout backfill paused (${(e as Error).message}); retries on the next sweep`, vid); }
    }
  }

  private async remarkVenueMarket(vid: string, name: string, market: string, cutoff: number): Promise<void> {
    if (!pairOf(market)) return; // unregistered market — never marked (defense in depth)
    const metaKey = `mkhist_cursor_${vid}_${market}`;
    const first = this.store.earliestRemarkCandidate(vid, market, cutoff);
    if (first == null) return;
    let day = utcDay(first);
    const cur = this.store.getMeta(metaKey);
    // resume from the cursor: candidates BEFORE it were walked already and stayed
    // null (permanent mid gaps) — re-fetching their archives every boot would
    // loop forever for nothing.
    if (cur && cur > day) day = cur;
    const lastDay = utcDay(cutoff - 86_400_000); // only fully-closed days
    let marked = 0;
    while (day <= lastDay) {
      const dayStart = Date.parse(`${day}T00:00:00Z`);
      const dayEnd = dayStart + 86_400_000;
      const fills = this.store.fillsForRemark(vid, market, dayStart, dayEnd);
      if (fills.length) {
        // pair-terms mid series covering the day + the horizons past midnight.
        const series = await pairMidSeries(market, dayStart, dayEnd + 120_000);
        // Warn+defer while this day's archive is missing, retract the stale
        // note on the sweep it publishes (checkArchivePending, family A of #6).
        // The pending string stays byte-identical so drop() matches what
        // noteOnce() emitted. The retraction fires here; the "resumed" announce
        // waits until applyRemarks below has actually written the markouts, so a
        // failed write can never leave a note claiming they resumed (review nit).
        let resumed: string | undefined;
        checkArchivePending({ vid, name, market, day }, series != null, this.archivePending, {
          warn: (m) => this.noteOnce('markout.archive.pending', m, vid),
          clear: (m) => this.dropNote('markout.archive.pending', m, vid),
          announce: (m) => { resumed = m; },
        });
        // deferral is a BREAK, not a return: the days already marked this walk
        // must still get their summary note + cache invalidation below.
        if (!series) break;
        const updates = fills.map((f) => {
          const ss = f.side === 'buy' ? 1 : -1;
          const marks = MARKOUT_HORIZONS.map((h) => {
            const mid = series.at(f.ts + h * 1000);
            return mid == null || mid <= 0 || f.execPx <= 0 ? null : ss * (mid / f.execPx - 1) * 1e4;
          });
          return { id: f.id, markoutsBps: marks };
        });
        await this.storeWriter.applyRemarks(updates);
        // the markouts are on disk now, so the "resumed" line is finally true.
        // checkArchivePending set `resumed` only on the sweep the archive
        // published, so this stays silent on every other sweep.
        if (resumed) this.note('markout.archive.published', resumed, vid);
        // count only fills that got ≥1 markout — an all-null result (mid gaps)
        // is honest but isn't "computed".
        marked += updates.filter((u) => u.markoutsBps.some((m) => m != null)).length;
      }
      await this.storeWriter.setMeta(metaKey, day);
      day = utcDay(dayStart + 86_400_000 + 1);
      await sleep(config.backfillPaceMs);
    }
    if (marked) {
      this.note('markout.remark.done', `${name} ${market}: markouts backfilled for ${marked} fill(s)`, vid);
      this.lbCache.clear(); // fresh aggregates on the next /api/leaderboard hit
    }
  }

  /** Drop the fill aggregates after fills are DELETED. A pass already running
   *  over the pre-reset rows is detached (no longer shared with new requests)
   *  and, via the generation, can't cache its result afterwards. */
  private aggGen = 0;
  private dropAggregates(): void {
    this.aggGen++;
    this.lbCache.clear(); this.lbInflight.clear();
    this.curveCache.clear(); this.curveInflight.clear();
  }

  /** Markout-curve aggregates over the window — same worker, cache and
   *  dedupe discipline as the leaderboard. */
  private curveCache = new Map<number, { at: number; res: MarkoutCurvesResponse }>();
  private curveInflight = new Map<number, Promise<MarkoutCurvesResponse>>();
  markoutCurves(days: number): Promise<MarkoutCurvesResponse> {
    const ttl = days <= 1 ? 30_000 : days <= 7 ? 120_000 : 600_000;
    const now = Date.now();
    const hit = this.curveCache.get(days);
    if (hit && now - hit.at < ttl) return Promise.resolve(hit.res);
    const inflight = this.curveInflight.get(days);
    if (inflight) return inflight;
    const gen = this.aggGen;
    const p = (async () => {
      const res = await this.analyticsWorker.computeCurves(days, now);
      if (gen === this.aggGen) this.curveCache.set(days, { at: now, res });
      return res;
    })().finally(() => { if (this.curveInflight.get(days) === p) this.curveInflight.delete(days); });
    this.curveInflight.set(days, p);
    return p;
  }

  /** Aggregated leaderboard over the FULL window, from SQLite (no fetch cap).
   *  TTL-cached per window so polling clients share one computation, and
   *  inflight-deduped so concurrent cold hits can't stack N computes. The pass
   *  runs on the read-only analytics worker, including SQL and sorts. */
  private lbCache = new Map<number, { at: number; res: LeaderboardResponse }>();
  private lbInflight = new Map<number, Promise<LeaderboardResponse>>();
  leaderboard(days: number): Promise<LeaderboardResponse> {
    const ttl = days <= 1 ? 15_000 : days <= 7 ? 120_000 : 600_000;
    const now = Date.now();
    const hit = this.lbCache.get(days);
    if (hit && now - hit.at < ttl) return Promise.resolve(hit.res);
    const inflight = this.lbInflight.get(days);
    if (inflight) return inflight;
    const gen = this.aggGen;
    const p = (async () => {
      const res = await this.analyticsWorker.compute(days, now);
      if (gen === this.aggGen) this.lbCache.set(days, { at: now, res });
      return res;
    })().finally(() => { if (this.lbInflight.get(days) === p) this.lbInflight.delete(days); });
    this.lbInflight.set(days, p);
    return p;
  }

  /** Historical fills from the DB (the leaderboard/markouts query real windows). */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : 0;
    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
    return this.store.fillsSince(sinceMs, Math.min(Math.floor(rawLimit), 50_000));
  }

  // ── live quote + fill-tail loops ────────────────────────────────────────────
  /** Timer-driven fill ingest. Quotes are driven separately by HotHeadWatcher. */
  private scheduleTail(delay?: number): void {
    if (this.loopsStopped) return;
    const interval = config.tailIntervalMs;
    const timer = setTimeout(async () => {
      const t0 = Date.now();
      try { await this.tailFills(); } catch (e) { this.noteOnce('tail.failed', `tail failed — holding cursor, retrying: ${(e as Error).message}`); }
      // between cycles: nothing can ingest while a gate runs (inTail)
      for (const gate of this.tailGates.splice(0)) await gate();
      this.emitMsg({ ch: 'volume', data: this.cloneDay(this.today()) });
      this.scheduleTail(Math.max(0, interval - (Date.now() - t0)));
    }, delay ?? interval);
    this.tailTimer = timer;
  }

  /**
   * Keep the dashboard at the live head without overlapping adapter state.
   * While one block is evaluating, later heads coalesce to the newest one: a
   * real-time quote page must not build an unbounded queue of stale matrices.
   * Every matrix that is emitted is nevertheless complete at one explicit
   * block; overload becomes an observable block-number gap, never mixed state.
   */
  private queueQuoteBlock(
    blockNumber: bigint,
    source: Exclude<QuoteHeadSource, 'sim'> = 'http',
    observedAt = Date.now(),
    identity: HeadIdentity = this.headWatcher.identity(blockNumber),
  ): void {
    if (this.loopsStopped || blockNumber < this.observedHead) return;
    const matches = (previous: HeadIdentity) => (previous.revision ?? 0) === (identity.revision ?? 0)
      && previous.generation === identity.generation
      && (!previous.hash || !identity.hash || previous.hash === identity.hash);
    let headAdvanced = false;
    if (blockNumber > this.observedHead) {
      this.observedHead = blockNumber;
      this.lastHeadSource = source;
      headAdvanced = true;
    } else if ((blockNumber === this.quotedBlock && matches(this.quotedIdentity))
      || (blockNumber === this.runningQuoteBlock && matches(this.runningIdentity))
      || (blockNumber === this.pendingQuote?.blockNumber && matches(this.pendingQuote.identity ?? {}))) return;
    if (blockNumber < this.quotedBlock) return;

    // Publish the new head before its quote finishes. If frames begin to fall
    // behind, the dashboard can then show the growing lag instead of freezing
    // on the health of the last successful frame.
    if (headAdvanced) this.emitRealtimeState();

    if (this.pendingQuote) {
      // Replacing pending block N with N+k discards N through N+k-1.
      this.pendingQuote = {
        blockNumber,
        source,
        identity,
        observedAt,
        coalescedBlocks: this.pendingQuote.coalescedBlocks + Number(blockNumber - this.pendingQuote.blockNumber),
      };
    } else {
      // A watcher can first observe N+k while N is running (or after N was the
      // last quote). Account for the unobserved intermediate block numbers too.
      const base = this.runningQuoteBlock ?? this.quotedBlock;
      this.pendingQuote = {
        blockNumber,
        source,
        identity,
        observedAt,
        coalescedBlocks: Math.max(0, Number(blockNumber - base - 1n)),
      };
    }
    void this.drainQuoteBlocks();
  }

  private requeueFailedTrigger(trigger: QuoteTrigger): void {
    if (trigger.identity && (trigger.identity.revision ?? 0) !== (this.headWatcher.identity(trigger.blockNumber).revision ?? 0)) return;
    const pending = this.pendingQuote;
    if (pending === undefined || trigger.blockNumber > pending.blockNumber) {
      this.pendingQuote = { ...trigger, identity: this.headWatcher.identity(trigger.blockNumber) };
      return;
    }
    if (pending.blockNumber > trigger.blockNumber) {
      // The failed running block will never be emitted because a newer pending
      // head already superseded it. Carry both that block and any skips already
      // attributed to it into the eventual successful frame.
      pending.coalescedBlocks += trigger.coalescedBlocks + 1;
    }
  }

  private emitRealtimeState(): void {
    this.emitMsg({ ch: 'state', data: this.getState() });
  }

  /** Quote delivery is the latency-sensitive result. State fanout runs on
   * the next event-loop turn, after a pending
   * newer frame has already been allowed to enter its RPC wait. */
  private schedulePostQuoteMaintenance(): void {
    if (this.postQuoteImmediate || this.loopsStopped) return;
    this.postQuoteImmediate = setImmediate(() => {
      this.postQuoteImmediate = undefined;
      if (this.loopsStopped) return;
      this.emitRealtimeState();
    });
  }

  private async drainQuoteBlocks(): Promise<void> {
    if (this.quoteRunning || this.loopsStopped) return;
    this.quoteRunning = true;
    let retry = false;
    try {
      while (!this.loopsStopped && this.pendingQuote !== undefined) {
        const trigger = this.pendingQuote;
        const blockNumber = trigger.blockNumber;
        this.pendingQuote = undefined;
        if (blockNumber < this.quotedBlock) continue;
        this.runningQuoteBlock = blockNumber;
        this.runningIdentity = trigger.identity ?? {};
        try {
          await this.poll(blockNumber, trigger);
          this.quotedBlock = blockNumber;
          this.quotedIdentity = trigger.identity ?? {};
        } catch {
          // Retry this exact block unless a newer observed head has already
          // replaced it. The retry is delayed so a sick RPC cannot hot-loop.
          this.requeueFailedTrigger(trigger);
          retry = true;
          break;
        } finally {
          this.runningQuoteBlock = undefined;
        }
      }
    } finally {
      this.quoteRunning = false;
    }
    if (this.loopsStopped || this.pendingQuote === undefined) return;
    if (retry) {
      if (this.quoteRetryTimer) clearTimeout(this.quoteRetryTimer);
      this.quoteRetryTimer = setTimeout(() => {
        this.quoteRetryTimer = undefined;
        void this.drainQuoteBlocks();
      }, Math.max(25, config.headPollMs));
    } else {
      queueMicrotask(() => { void this.drainQuoteBlocks(); });
    }
  }

  private sampleReferences(): void {
    const now = Date.now();
    for (const pair of PAIRS) {
      const mid = REFERENCES.midForPair(pair.symbol);
      if (!(mid > 0)) continue;
      const history = this.midHist.get(pair.symbol) ?? [];
      const last = history.at(-1);
      history.push({ t: now, mid });
      // A wall-clock correction must not invalidate binary horizon lookups.
      if (last && last.t > now) history.sort((a, b) => a.t - b.t);
      while (history.length > 1 && (history[0].t < now - LiveDataSource.MID_HIST_MS || history.length > 2_000)) history.shift();
      this.midHist.set(pair.symbol, history);
    }
  }

  private async poll(blockNumber: bigint, trigger: QuoteTrigger = {
    blockNumber,
    source: 'http',
    observedAt: Date.now(),
    coalescedBlocks: 0,
  }): Promise<void> {
    this.quotePollingStarted = true;
    const quoteStartedAt = Date.now();

    // One synchronous turn captures every mutable CEX input before adapters
    // start awaiting RPC. The chain reads below are pinned to `blockNumber`; the
    // frame pricer makes their USD sizing and bps anchors equally immutable.
    // Every registered pair/size is sampled once per block, even with no
    // viewers. Subscriptions control delivery only, never the retained dataset.
    const referenceFrame = captureReferenceFrame(REFERENCES, config.sizesUsd);
    const { pricer: framePricer, monUsd, rows: refRows, assetPrices, pairMids } = referenceFrame;
    // Surface a starving reference feed LOUDLY (state.notes): with no base mid
    // there are no reference rows, no venue bps anchors and no markouts for that
    // asset's pairs — they silently vanish from the UI otherwise (this is exactly
    // how a geo-blocked Binance feed hid BTC/ETH in prod; feeds swallow their
    // own connection errors, so the mid is the observable signal). Grace period
    // covers the normal cold-start warmup.
    if (quoteStartedAt - this.bootMs > 60_000) {
      checkReferenceStarvation(Object.values(ASSETS), (k) => assetPrices.get(k) ?? 0, this.starvedSince, quoteStartedAt, {
        warn: (m) => this.noteOnce('reference.starved', m),
        clear: (m) => this.dropNote('reference.starved', m),
        announce: (m) => this.note('reference.recovered', m),
      });
    }
    const pinned = await resolveQuoteBlock(blockNumber, trigger.identity ?? this.headWatcher.identity(blockNumber));
    trigger.identity = pinned;
    if (!this.headWatcher.rememberResolved(blockNumber, pinned)) throw new Error('quote proposal superseded');
    const requestedAdapters = ADAPTERS.filter((a) => a.quote);
    const adapterMs: Record<string, number> = {};
    const completedAdapters = new Set<VenueAdapter>();
    const venueRowsNested = await Promise.all(requestedAdapters.map(async (a) => {
        if (!a.quote) return [] as QuoteRow[];
        const adapterStarted = performance.now();
        let quoteSignal: AbortSignal | undefined;
        // a THROWN quote is a degradation like any other — swallowing it left
        // the venue's disappearance with no explanation anywhere.
        try {
          const rows = await this.quoteRunner.run(this.vidOf(a) ?? 'unknown', config.quoteDeadlineMs, async (signal) => {
            quoteSignal = signal;
            const original = this.frameCtxFor(a, framePricer);
            const ctx = { ...original, quoteSignal: signal, client: scopedQuoteClient(`${this.vidOf(a)}-${blockNumber}`, signal, pinned),
              note: (...args: Parameters<typeof original.note>) => { if (!signal.aborted) original.note(...args); } };
            const health = new QuoteHealthBatch(ctx);
            const rows = await a.quote!({ ...ctx, quoteHealth: health.forPlan(0) }, config.sizesUsd, blockNumber);
            signal.throwIfAborted();
            if (!this.headWatcher.isCurrent(blockNumber, pinned)) throw new Error('quote proposal superseded');
            health.commit();
            completedAdapters.add(a);
            // The catch below only runs on rejection, so the "it succeeded"
            // branch lives here: announce the heal, mirroring
            // createQuoteOutageReporter. Returning [] still counts — emptiness
            // is checkQuoteOutage's job, not this latch's.
            {
              const vid = this.vidOf(a) ?? 'unknown';
              const prev = this.quoteFailed.get(vid);
              if (prev !== undefined) {
                this.quoteFailed.delete(vid);
                this.note('venue.quote.recovered', `${a.venues()[0]?.name ?? 'venue'} quoting again (was "${prev}")`, this.vidOf(a));
              }
            }
            return rows;
          }, [] as QuoteRow[]).catch((e) => {
            if (quoteSignal?.aborted) return [] as QuoteRow[];
            // a rejection is not necessarily an Error — a bare string or an
            // Error with an empty message would otherwise note "quote failed:
            // undefined", which is worse than useless to whoever reads it.
            const why = (e instanceof Error && e.message) || String(e ?? '') || 'no reason given';
            // One event, one note: a changed reason is a new event, a repeat is
            // deduped by the latch. Plain note(), NOT noteOnce(): noteOnce
            // dedupes against the whole window, so after a recovery the SAME
            // failure again would be swallowed and the window would end on
            // "quoting again" while the venue is down.
            const vid = this.vidOf(a) ?? 'unknown';
            if (this.quoteFailed.get(vid) !== why) {
              this.quoteFailed.set(vid, why);
              this.note('venue.quote.unavailable', `${a.venues()[0]?.name ?? 'venue'} quote failed: ${why}`, this.vidOf(a));
            }
            return [] as QuoteRow[];
          });
          return this.ownVenues(a, rows, 'quote'); // drop rows for ids the adapter didn't declare
        } finally {
          const venue = this.vidOf(a) ?? 'unknown';
          adapterMs[venue] = Math.round((performance.now() - adapterStarted) * 10) / 10;
        }
      }));
    if (!this.headWatcher.isCurrent(blockNumber, pinned) || rpcGeneration() !== pinned.generation) throw new Error('quote proposal superseded');
    this.block = Number(blockNumber);
    const venueRows = venueRowsNested.flat();
    // A venue that stopped quoting vanishes from the grid silently otherwise
    // (checkQuoteOutage). Skipped during boot warmup — references start cold,
    // so EVERY venue is legitimately empty for the first cycles — and while the
    // RPC is degraded, when everything is empty and the rpc.* note says why.
    if (quoteStartedAt - this.bootMs > 60_000 && !rpcStatus().degraded) {
      const counts = new Map<string, number>();
      for (const r of venueRows) counts.set(r.venueId, (counts.get(r.venueId) ?? 0) + 1);
      // Deadline and busy-slot misses are frame telemetry, not evidence that
      // an accepted adapter result reported a venue outage or recovery.
      const quoting = requestedAdapters.filter((a) => completedAdapters.has(a)).flatMap((a) => a.venues());
      // `quoteStartedAt` is stamped BEFORE the adapters quote, so a
      // note an adapter raises from inside this tick lands on or after `since`.
      checkQuoteOutage(quoting, (id) => counts.get(id) ?? 0, this.quoteEmptyRuns, this.quoteDark, quoteStartedAt, {
        warn: (id, m) => this.noteOnce('venue.quote.unavailable', m, id),
        announce: (id, m) => this.note('venue.quote.recovered', m, id),
        clear: (id, m) => this.dropNote('venue.quote.unavailable', m, id),
        explained: (id, since, except) => this.notes.holds('venue.quote.unavailable', id, since, except),
      });
    }
    annotateCex(venueRows, refRows); // docs/architecture.md: fill stream — matched per market, so each venue row hits its pair's CEX
    const rows = [...venueRows, ...refRows];
    const present = new Set(rows.map((row) => row.venueId));
    const expected = new Set([
      ...requestedAdapters.flatMap((a) => a.venues().map((v) => v.id)),
      ...PAIRS.map((pair) => cexForBase(pair.base)),
    ]);
    const quoteCompletedAt = Date.now();
    const loopMaxNs = this.eventLoopDelay.max;
    this.eventLoopLagMs = Number.isFinite(loopMaxNs) ? Math.round(loopMaxNs / 100_000) / 10 : 0;
    this.eventLoopDelay.reset();
    const emittedAt = Date.now();
    const frame: QuoteFrameTelemetry = {
      headSource: trigger.source,
      headObservedAt: trigger.observedAt,
      quoteStartedAt,
      quoteCompletedAt,
      emittedAt,
      durationMs: Math.max(0, quoteCompletedAt - quoteStartedAt),
      adapterMs,
      missingVenues: frameMissingVenues(expected, present, this.quoteEmptyRuns, this.quoteDark,
        (id, since) => this.notes.holds('venue.quote.unavailable', id, since)),
      coalescedBlocks: trigger.coalescedBlocks,
    };
    this.quotes = { block: this.block, blockHash: pinned.hash, ...(pinned.revision ? { revision: pinned.revision } : {}), monUsd, ts: emittedAt, rows, frame };
    this.quotesFull = requestedAdapters.every((adapter) => completedAdapters.has(adapter));
    this.realtimeFrames.push({ block: this.block, emittedAt, coalescedBlocks: trigger.coalescedBlocks });
    this.realtimeFrames = this.realtimeFrames.filter((f) => f.emittedAt >= emittedAt - REALTIME_WINDOW_MS);
    this.emitMsg({ ch: 'quotes', data: this.quotes });
    this.schedulePostQuoteMaintenance();
  }

  // ── fills ───────────────────────────────────────────────────────────────────
  private async tailFills(): Promise<void> {
    // Defer the tail until at least one CEX reference is warm so markout anchors are
    // sound; lastBlock is not advanced, so the range is re-decoded once warm (audit C3).
    if (!Object.keys(ASSETS).some((k) => REFERENCES.assetUsd(k) > 0)) return;
    // finality margin: Monad logs/receipts can mutate for ~2 blocks (~600ms).
    // A speculative log that mutates away after ingest would be PERMANENT
    // phantom volume — there is no un-count path. Same margin as the gas tracker.
    const head = (await headClient.getBlockNumber()) - 5n;
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1n;
    // Bound how much range ONE cycle materializes: the whole span is held in
    // memory (raw logs → decoded fills) before the single cursor commit at the
    // end, so a multi-hour gap (long outage, previously-held cursor) is
    // hundreds of MB of log objects at once — enough to OOM the 320MB-capped
    // prod heap on every restart boot (2026-09-16). A window commits
    // atomically and the next cycle resumes from the new cursor; steady-state
    // tails (1-2 blocks/cycle) never reach the cap. 1000 blocks ≈ 10 getLogs
    // chunks per source (the RPC caps ranges at ~100 blocks). NB getLogs
    // ranges are INCLUSIVE of both ends — the -1 keeps the capped window at
    // exactly TAIL_WINDOW_BLOCKS blocks, not one more.
    const to = head - from < BigInt(TAIL_WINDOW_BLOCKS) ? head : from + BigInt(TAIL_WINDOW_BLOCKS) - 1n;

    // Fetch every adapter's declared log sources into a per-adapter bundle. Track
    // whether any REQUIRED (fill-producing) source failed: if so we must NOT
    // advance the cursor, or a transient RPC error would look like "no logs" and
    // silently lose those fills forever (review #1). Only attribution sources
    // are tolerated on failure; state/discovery sources are cursor-critical.
    let requiredFailed = false;
    // Gather every adapter's sources BEFORE any fetch starts. logSources() is
    // the fail-closed gate: it throws while discovery hasn't succeeded, and the
    // cursor must hold. Called inside the fetch map below, one adapter's throw
    // rejected the outer Promise.all instantly while the OTHER adapters' range
    // fetches kept running detached — results discarded, the whole (ever-growing)
    // held range re-fetched on every retry. That allocation spiral OOM-killed
    // prod within hours of a persistently undiscovered adapter (2026-09-16).
    const declared = ADAPTERS.map((a) => ({ a, sources: a.logSources() }));
    const perAdapter = await Promise.all(declared.map(async ({ a, sources }) => {
      const bundle: LogBundle = {};
      const all: any[] = [];
      const failed = new Set<string>(); // source keys whose fetch failed (surfaced to decode)
      await Promise.all(sources.map(async (s) => {
        // outside its declared span a source cannot have logs: no fetch at all
        const span = sourceSpan(s, from, to);
        if (!span) { bundle[s.key] = []; return; }
        try {
          const logs = (await getLogsChunked({ address: s.address, fromBlock: span.from, toBlock: span.to, events: s.events as any })) as any[];
          bundle[s.key] = logs;
          all.push(...logs);
        } catch {
          bundle[s.key] = [];
          failed.add(s.key);
          // 'fills' + 'state' sources hold the cursor; only 'attribution' is tolerated.
          if (s.kind !== 'attribution') {
            requiredFailed = true;
            this.noteOnce('venue.source.failed', `${a.venues()[0]?.name ?? 'venue'} log source '${s.key}' failed — holding cursor, retrying`, this.vidOf(a));
          }
        }
      }));
      return { a, bundle, all, failed };
    }));

    // ATOMIC (review #1): if any required (fills/state) source failed, skip the
    // ENTIRE cycle — do NOT resolve timestamps, decode, mutate adapter state,
    // ingest, emit, or advance the cursor. The identical range is re-tailed next
    // cycle once every required source is back, so a fill is never partially
    // decoded, and dedupe (countedIds) is not relied on across a held range.
    if (requiredFailed) return;

    // resolve block timestamps once for every block that carries a log (audit B2).
    const blocks = new Set<bigint>();
    for (const { all } of perAdapter) for (const l of all) blocks.add(l.blockNumber);
    let blockTs: Map<string, number>;
    try {
      blockTs = await this.blockTimes(blocks);
    } catch (e) {
      this.noteOnce('tail.timestamps.failed', `block timestamp lookup failed — holding cursor, retrying: ${(e as Error).message}`);
      return;
    }
    const tsOf = (bn: bigint) => {
      const ts = blockTs.get(String(bn));
      if (ts == null) throw new Error(`missing block timestamp for ${bn}`);
      return ts;
    };

    const fresh: Fill[] = [];
    let decodeFailed = false;
    for (const { a, bundle, failed } of perAdapter) {
      try { fresh.push(...this.ownVenues(a, await a.decode(this.ctxFor(a), bundle, tsOf, failed), 'fill')); }
      catch (e) {
        decodeFailed = true;
        this.noteOnce('venue.decode.failed', `${a.venues()[0]?.name ?? 'venue'} decode error — holding cursor, retrying: ${(e as Error).message}`, this.vidOf(a));
      }
    }
    // Decode is cursor-critical too: if an adapter cannot decode this range, do
    // not count any fills from it and do not advance. The exact range is retried.
    if (decodeFailed) return;

    fresh.sort((a, b) => a.blockNumber - b.blockNumber);
    // best-effort label enrichment (UNKNOWN → DIRECT / Router - X). Never
    // cursor-critical: a lookup failure leaves the adapter's honest UNKNOWN.
    try { await this.attributor.attribute(fresh); } catch { /* labels only */ }
    for (const f of fresh) this.ingest(f);
    // Publish the cursor only after every decoded fill has landed in memory.
    // backgroundHistory waits on this value before applying authoritative
    // closed-day SETs; exposing it earlier leaves a race where a late tail
    // increment double-counts a day the deep replay just replaced.
    this.lastBlock = to;
    // the boot gap is fully decoded once the cursor reaches bootHead: retract the
    // resume note, then announce the tail is current (checkGapFill, family B of #6).
    checkGapFill(this.lastBlock, this.bootHead, this.gapResume, {
      clear: (m) => this.dropNote('tail.resume', m),
      announce: (m) => this.note('tail.caughtup', m),
    });
  }

  /** Block timestamps (ms) for the blocks that carry logs (audit B2). */
  private async blockTimes(blocks: Set<bigint>): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    await Promise.all([...blocks].map(async (bn) => {
      const b = await publicClient.getBlock({ blockNumber: bn });
      m.set(String(bn), Number(b.timestamp) * 1000);
    }));
    return m;
  }

  private ingest(f: Fill): void {
    // never store a fill for a venue the registry doesn't know (its volume would
    // be invisible in the UI / could merge into another venue) — review #3.
    if (!this.knownVenueIds.has(f.venueId)) { this.noteOnce('venue.foreign', `dropped fill for unknown venue '${f.venueId}'`); return; }
    // Idempotent (H1): a fill already counted — a re-tail / gap-fill / restart
    // re-decode of the same on-chain event (deterministic id) — must never
    // advance the volume buckets again.
    if (this.countedIds.has(f.id)) return;
    this.countedIds.add(f.id);
    this.fills.push(f);
    if (this.fills.length > FILL_RING_SIZE) {
      const dropped = this.fills.shift();
      if (dropped) this.countedIds.delete(dropped.id);
    }
    // Keep aging any fill that still has a recoverable (future) markout horizon.
    // A fill landing after its last horizon (a tail/RPC stall over 60s) is
    // still queued for its CURVE while the ring covers the curve's first point.
    if (this.hasFutureMarkoutHorizon(f)) this.pending.add(f);
    else if (this.curveInRing(f)) { this.curveOnly.add(f); this.pending.add(f); }
    this.dirty.add(f);
    // Bucket by the fill's execution day, keyed generically by venueId.
    const d = this.dayFor(f.ts);
    const vd = (d.byVenue[f.venueId] ??= { usd: 0, swaps: 0 });
    vd.usd += f.usd;
    vd.swaps += 1;
    this.dirtyDays.add(d.utcDay);
    this.emitMsg({ ch: 'fill', data: f });
  }

  /** Find/create the daily bucket for a fill's execution timestamp (audit B2). */
  private dayFor(tsMs: number): DailyVolume {
    const day = utcDay(tsMs);
    let d = this.days.find((x) => x.utcDay === day);
    if (!d) {
      d = this.emptyDay(day, day === utcDay());
      this.days.push(d);
      this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
    }
    return d;
  }

  /** True while a fill still has a null markout horizon whose mark time is in the
   *  future — i.e. still observable, so it's worth keeping on the pending queue.
   *  An approximate-price fill is NEVER queued: mid/execPx against a pxApprox
   *  execPx would fabricate the very markouts the shared contract keeps out of
   *  the stats (they must stay null, in memory and in SQLite). */
  private hasFutureMarkoutHorizon(f: Fill, now = Date.now()): boolean {
    if (f.pxApprox) return false;
    return MARKOUT_HORIZONS.some((h, i) => f.markoutsBps[i] == null && now < f.ts + h * 1000);
  }

  /** True while the ring still reaches back to the fill's first curve point.
   *  Samples exist only from boot on, so a pre-boot point simply stays missing
   *  and the curve incomplete — never back-dated. Same pxApprox / registry
   *  gates as the markouts. */
  private curveInRing(f: Fill, now = Date.now()): boolean {
    if (f.pxApprox || !pairOf(f.market)) return false;
    return curveMarkMs(f.ts, CURVE_OFFSETS_S[0]) - LiveDataSource.CURVE_NEAR_TOL_MS >= now - LiveDataSource.MID_HIST_MS;
  }

  /** Join each pending fill to the reference mid at each horizon as it ages. */
  private ageMarkouts(): Promise<void> {
    if (this.markoutWork) return this.markoutWork;
    this.markoutWork = agePendingMarkouts(this.pending, (fill, now) => this.ageMarkout(fill, now), () => this.loopsStopped)
      .finally(() => { this.markoutWork = undefined; });
    return this.markoutWork;
  }

  private ageMarkout(f: Fill, now: number): void {
    // an approximate-price fill must never be aged — mid/execPx against a
    // pxApprox execPx fabricates markouts the contract excludes. Unreachable
    // via hasFutureMarkoutHorizon (which refuses to queue them); defensive.
    if (f.pxApprox) { this.pending.delete(f); return; }
    // an UNREGISTERED market has no CEX routing — never fall back to MON/Bybit
    // (a BTC fill aged vs a $0.02 mid would fabricate absurd markouts). Leave
    // its markouts null and stop tracking it (defense in depth; adapters gate
    // discovery/decode on the pair registry so this shouldn't be reachable).
    if (!pairOf(f.market)) { this.pending.delete(f); this.noteOnce('markout.market.unregistered', `fill market '${f.market}' is not a registered pair — markouts skipped`, f.venueId); return; }
    const hist = this.midHist.get(f.market) ?? [];
    // queued for the curve alone: the legacy horizons are left untouched.
    if (this.curveOnly.has(f)) {
      this.takeCurve(f, hist, now);
      if (this.curveTaken.has(f)) this.pending.delete(f);
      return;
    }
    // A horizon that elapsed before we had any mid for THIS pair can't be
    // computed faithfully — leave it null rather than fabricate it (M1).
    const earliestMid = hist.length ? hist[0].t : now;
    const ss = f.side === 'buy' ? 1 : -1;
    let changed = false, complete = true;
    for (let i = 0; i < MARKOUT_HORIZONS.length; i++) {
      if (f.markoutsBps[i] != null) continue;
      const at = f.ts + MARKOUT_HORIZONS[i] * 1000;
      if (now < at) { complete = false; continue; }   // horizon not reached yet
      if (at < earliestMid) continue;                  // elapsed unobserved → leave null
      const mid = this.midNear(f.market, at);
      // no near-enough mid ⇒ the horizon stays null (elapsed-unobservable),
      // and the fill still leaves the pending queue below — never a 0.
      if (mid > 0 && f.execPx > 0) {
        f.markoutsBps[i] = ss * (mid / f.execPx - 1) * 1e4;
        changed = true;
      }
    }
    if (changed) { this.dirty.add(f); this.emitMsg({ ch: 'fill', data: f }); }
    this.takeCurve(f, hist, now);
    if (complete) this.pending.delete(f);
  }
  private takeCurve(f: Fill, hist: readonly { t: number; mid: number }[], now: number): void {
    // The curve is taken ONCE, when its last point has elapsed — the ring
    // (~2 min) still covers every point then. Only a complete curve is kept: a
    // gap (boot, starving feed) leaves curve_bps NULL rather than freezing a
    // partial one. There is deliberately no archive backfill: the archives are
    // per-second LAST TRADES, which sit ~1bp off the BBO mid right at the fill
    // (trade-side bounce correlated with the flow — measured over a day of
    // MON/USDC fills), exactly where the curve's signal lives.
    if (!this.curveTaken.has(f) && now >= curveMarkMs(f.ts, CURVE_LAST_S) + LiveDataSource.CURVE_NEAR_TOL_MS) {
      this.curveTaken.add(f);
      const curve = curvePoints(f, (t) => nearestReferenceSample(hist, t, LiveDataSource.CURVE_NEAR_TOL_MS)?.mid);
      if (curveComplete(curve)) this.dirtyCurves.set(f.id, curve);
    }
  }
  /** Curve points are 1s apart, so a sample further than this from its mark
   *  belongs to a neighbouring point. The ring samples every 100ms. */
  private static readonly CURVE_NEAR_TOL_MS = 250;
  /** the pair mid within ±MID_NEAR_TOL_MS of `t`, else 0 (unmarkable). The
   *  history is time- and length-capped; a stalled event loop must never join
   *  a fill to a reference sample minutes away from its horizon. */
  private static readonly MID_NEAR_TOL_MS = 6_000;
  private midNear(market: string, t: number): number {
    const hist = this.midHist.get(market) ?? [];
    const sample = nearestReferenceSample(hist, t, LiveDataSource.MID_NEAR_TOL_MS);
    if (sample) return sample.mid;
    // live fallback only when NOW is an honest mark for t
    return Math.abs(Date.now() - t) <= LiveDataSource.MID_NEAR_TOL_MS ? REFERENCES.midForPair(market) : 0;
  }

  private cloneDay(d: DailyVolume): DailyVolume { return { ...d, byVenue: { ...d.byVenue } }; }

  /** Today's bucket — find-or-create BY DAY KEY (a proposer-clock-skewed block
   *  can create tomorrow's row a moment early; assuming "last row = today"
   *  then spawned a duplicate today that broadcast as $0). Rolls every older
   *  partial closed. */
  private today(): DailyVolume {
    const day = utcDay();
    let d = this.days.find((x) => x.utcDay === day);
    if (!d) {
      d = this.emptyDay(day, true);
      this.days.push(d);
      this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
      this.dirtyDays.add(day);
    }
    if (!d.partial) { d.partial = true; this.dirtyDays.add(d.utcDay); }
    for (const x of this.days) {
      if (x !== d && x.partial && x.utcDay < day) {
        x.partial = false;
        this.dirtyDays.add(x.utcDay);
      }
    }
    return d;
  }
}
