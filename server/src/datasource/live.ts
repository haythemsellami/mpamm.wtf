import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS, ASSETS, PAIRS, pairOf,
  type DataSourceMode, type MarketState, type QuoteSnapshot, type QuoteRow, type Fill, type DailyVolume,
  type LeaderboardResponse, type GasResponse, type NoteCode,
} from '@shared';
import { isTransportFailure } from '../chain/failover.js';
import { computeLeaderboard } from '../analytics.js';
import { FillAttributor } from '../attribution.js';
import { pairMidSeries } from '../history/cex.js';
import { GasTracker } from '../gas.js';
import { config } from '../config.js';
import {
  publicClient, archiveClient, getLogsChunked, probeChain, probeArchiveChain, blockAtOrAfter,
  onRpcEvent, onArchiveRpcEvent, rpcStatus, archiveRpcStatus, hasDedicatedArchive,
} from '../chain/rpc.js';
import { UsdPricer } from '../pricer.js';
import { VolumeStore, type ResetDeletes } from '../db.js';
import { NoteBuffer } from '../notes.js';
import { utcDay, annotateCex } from '../util.js';
import { seedSources } from './seed.js';
import { ADAPTERS, REFERENCES, venueMeta, venueIds, allVenueIds, allAdapterVenueIds, validateRegistry } from '../venues/registry.js';
import type { AdapterContext, LogBundle, LogSource, VenueAdapter } from '../venues/adapter.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** Consecutive empty quote cycles before a venue is called dark. At the 500ms
 *  quote cadence that is ~10s: long enough that one RPC blip inside a venue's
 *  own multicall is not an outage, short enough to catch the real thing. */
export const QUOTE_DARK_CYCLES = 20;

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
    explained: (id: string, since: number) => boolean;
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
    if (run.runs < QUOTE_DARK_CYCLES || dark.has(v.id)) continue;
    // The adapter already said WHY, so it owns this venue's outage telemetry
    // BOTH ways: standing down here but still marking it dark would let the
    // core announce a second, vaguer recovery alongside the adapter's own.
    if (io.explained(v.id, run.since)) continue;
    const msg = `${v.name} is not quoting — no rows for ${run.runs} consecutive cycles (venue offline, or its adapter no longer matches the contract)`;
    dark.set(v.id, msg); // only ever holds venues this check itself reported
    io.warn(v.id, msg);
  }
}

/** Archive-pending lifecycle for the markout re-scan (family A of #6).
 *
 * A month's CEX price archive publishes days after the month closes, so the
 * remark walk defers that day and raises a sticky `markout.archive.pending`
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
 * dropped it would erase what had already been counted since midnight. A reset
 * re-run the next day rewrites that day properly, once it is closed.
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
  return !!t.vid && store.getMeta(`backfill_reset_applied_${t.vid}`) === t.spec;
}

/** Record an entry as finished — done, or refused for a reason that will still
 *  hold next boot. An entry with no parseable venue id has nowhere to record. */
export function markResetApplied(store: Pick<VolumeStore, 'setMeta'>, t: BackfillResetTarget): void {
  if (t.vid) store.setMeta(`backfill_reset_applied_${t.vid}`, t.spec);
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
export type BackfillResetTarget = { vid: string; spec: string } & (
  | { from: 'lifetime' }
  | { from: 'block'; block: bigint }
  | { from: 'day'; day: string }
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
 * typo costs no RPC.
 */
export function refuseResetStart(t: BackfillResetTarget, today: string, bootHead: bigint): string | null {
  if (t.from === 'block' && bootHead > 0n && t.block > bootHead) {
    return `start ${t.block} is past head ${bootHead} — skipped rather than replaying the lifetime`;
  }
  if (t.from === 'day' && t.day >= today) {
    return t.day === today
      ? `start ${t.day} is TODAY — the live tail owns today, so a replay from it would delete nothing and re-scan nothing; use an earlier day`
      : `start ${t.day} is in the future (today is ${today}) — skipped rather than anchoring the replay to head`;
  }
  return null;
}

/**
 * The same question for a start only knowable after the chain answered: a RAW
 * block carries no day until eth_getBlock resolves one.
 *
 * A start landing on today is a total no-op — both deletes bound exclusively at
 * today and both scans skip it — so it would spend the venue's one-shot marker
 * on nothing at all. Refused rather than applied, and refused PERMANENTLY even
 * though the same start becomes valid after midnight: a destructive replay must
 * not lie in wait to fire at a boundary the operator did not choose. The note
 * says what to do instead, and bumping the nonce re-arms it deliberately.
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
  if (from.day >= today) {
    return `start block ${from.block} falls on ${from.day}, which the live tail owns — a replay from it would delete nothing and re-scan nothing; use an earlier block`;
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
  private gas = new GasTracker(archiveClient, this.store, ADAPTERS, (code, msg, venue) => this.noteOnce(code, msg, venue), () => archiveUnavailable());
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
        client: publicClient,
        getLogs: getLogsChunked,
        pricer: this.pricer,
        config,
        // deduped: discovery notes repeat verbatim on every 10-min rediscover
        // and were accumulating unbounded ("Metric: 3 pool(s)" × N).
        note: (code, msg) => this.noteOnce(code, msg, venue),
      };
      this.ctxCache.set(a, ctx);
    }
    return ctx;
  }
  /** the adapter's primary venue id — what its notes are stamped with. */
  private vidOf(a: VenueAdapter): string | undefined { return a.venues()[0]?.id; }

  private quotes: QuoteSnapshot = { block: 0, monUsd: 0, ts: 0, rows: [] };
  private days: DailyVolume[] = [];
  private fills: Fill[] = [];
  private pending = new Set<Fill>();
  private dirty = new Set<Fill>();
  /** ids already counted into the volume buckets (kept in sync with the fills
   *  window) — makes ingest idempotent so a re-decode never double-counts. */
  private countedIds = new Set<string>();
  /** CEX mid history per PAIR (market symbol), in the pair's own terms (wrap
   *  basis + stable cross applied) — the markout anchors. Keyed per pair, not per
   *  base, because MON/USDC and MON/USDT0 mark against different mids. */
  private midHist = new Map<string, { t: number; mid: number }[]>();
  private lastBlock = 0n;
  /** chain head captured at boot — the upper bound for on-chain backfill (the
   *  live tail owns every block after it, so the two never overlap). */
  private bootHead = 0n;
  /** Upper bound for the DEEP crawls: min(bootHead, the archive pool's own head).
   *  bootHead comes from the HOT pool, and a dedicated archive is allowed to lag
   *  it by design (retention is what it is picked for, not tip freshness). Handing
   *  the archive a toBlock past its head is a range it cannot serve — and both
   *  crawls treat their end as COMPLETE, setting backfill_done / mkfill_done once
   *  the cursor passes it. At a UTC rollover that difference is a just-closed day
   *  scanned short and then marked finished, with the live tail starting at the
   *  HOT head and never revisiting it. Clamp instead; the blocks between the two
   *  heads are today's, which the tail owns anyway. */
  private deepEnd = 0n;
  /** process start — grace period before "reference feed has no mid" notes. */
  private bootMs = Date.now();
  private quoteTimer?: ReturnType<typeof setTimeout>;
  private tailTimer?: ReturnType<typeof setTimeout>;
  private loopsStopped = false;
  private persistTimer?: ReturnType<typeof setInterval>;
  private rediscoverTimer?: ReturnType<typeof setInterval>;
  private remarkTimer?: ReturnType<typeof setInterval>;
  /** re-entrancy guard shared by the boot onboarding chain and the retry timer
   *  — two remark walks over the same cursors must never interleave. */
  private remarkRunning = false;
  /** the served notes window (server/src/notes.ts): sanitized, stamped with a
   *  code + level, deduped, and capped without letting one chatty subsystem
   *  evict everything else. */
  private notes = new NoteBuffer();
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
  private block = 0;
  /** all registered venue ids — a fill/quote carrying an unknown id is dropped
   *  (a plugin bug must not silently store data the UI can't render). */
  private knownVenueIds = new Set<string>();

  async start(): Promise<void> {
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
    // The archive pool is NOT fatal to boot. Deep crawls are background work and
    // every one of them holds its cursor on failure, so a dead archive costs
    // history that resumes later — while refusing to boot would also take down
    // live quoting, which needs no history at all. Say so loudly instead.
    const archiveProbe = await probeArchiveChain();
    // A WRONG-CHAIN archive primary is fatal, unlike an unreachable one. An
    // outage is a gap that heals — the cursors hold and resume. Another chain's
    // node ANSWERS, successfully, so the breaker can never fail away from it
    // (chain/failover.ts: only transport errors switch endpoints) and the deep
    // crawls would read its logs and persist them as this chain's history.
    // Wrong history cannot be unmixed; refuse to boot instead.
    if (!archiveProbe.ok && archiveProbe.wrongChain) {
      throw new Error(`Archive RPC sanity check failed (${archiveProbe.reason}). It answers successfully, so failover cannot route around it and deep crawls would persist another chain's history — fix RPC_ARCHIVE_URL.`);
    }
    if (!archiveProbe.ok) {
      this.note('rpc.down', `archive RPC sanity check failed (${archiveProbe.reason}) — deep history (volume backfill, markout onboarding, gas) will hold until it serves; live quotes and fills are unaffected`);
    }

    await REFERENCES.start();
    // discover every venue's markets/pools (adapters hold their own state).
    for (const a of ADAPTERS) {
      try { await a.discover(this.ctxFor(a)); }
      catch (e) { this.note('venue.discovery.failed', `${a.venues()[0]?.name ?? 'venue'} discovery failed: ${(e as Error).message}`, this.vidOf(a)); }
    }

    await this.initHistory();

    await this.poll().catch(() => undefined);
    // Quotes and the fills tail run as INDEPENDENT self-scheduling loops: the
    // old shared setInterval skipped overlapping fires, so one slow phase
    // quantized the whole cadence to interval multiples (a 600ms tick became a
    // 1s cadence) and log tailing stretched quote freshness. Chaining runs the
    // next pass as soon as the previous finishes (floored at the interval), so
    // cadence = max(interval, duration) — never rounded up.
    this.scheduleLoop('quote');
    this.scheduleLoop('tail');
    this.persistTimer = setInterval(() => this.persist(), config.persistMs);
    this.rediscoverTimer = setInterval(() => { void this.rediscover(); }, config.rediscoverMs);
    // seed deep history in the BACKGROUND — never blocks boot or the live tail.
    if (config.backfillEnabled || config.markoutBackfill) void this.backgroundHistory();
    // quote-update gas: its own cursor + loop (first pass covers the shallow
    // history horizon, later passes tail forward) — independent of the fills
    // pipeline on purpose: a gas-source failure must never hold the fill cursor.
    if (config.gasMetric) this.gas.start();
    // Deferred markout backfills retry on a TIMER, not just at boot: a month's
    // CEX archive publishes days after month end, and "marks itself when it
    // lands" must not depend on a deploy happening to restart the process. Each
    // sweep is cheap when nothing is markable (per-venue SQL for candidates +
    // a HEAD probe per missing dump month — no RPC, no downloads).
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
    if (this.historyRunning) return;
    this.historyRunning = true;
    try {
      // BEFORE both stages, and NOT behind either individual switch: whichever
      // scan is enabled must see its reset before it starts.
      // ONE clock for the run. The reset's delete boundary and both scans must
      // agree on which day the live tail owns; a UTC midnight between separate
      // clocks otherwise leaves a preserved/stale day inside a replay window.
      const nowMs = Date.now();
      await this.applyBackfillReset(nowMs);
      if (config.markoutBackfill) {
        try { await this.markoutOnboarding(nowMs); }
        catch (e) { this.noteOnce('markout.paused', `markout onboarding stopped: ${(e as Error).message}; retried automatically`); }
      }
      if (config.backfillEnabled) await this.backfillOnchain(nowMs);
    } catch (e) {
      // This chain is started with `void`, so anything escaping here is an
      // unhandled rejection that takes the whole stage down silently. The
      // rediscovery timer re-invokes it while seeds are pending, so saying so
      // and standing down IS the retry.
      this.noteOnce('backfill.paused', `history stage stopped: ${(e as Error).message}; retried automatically`);
    } finally {
      this.historyRunning = false;
    }
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

  stop(): void {
    this.loopsStopped = true;
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    if (this.tailTimer) clearTimeout(this.tailTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.rediscoverTimer) clearInterval(this.rediscoverTimer);
    if (this.remarkTimer) clearInterval(this.remarkTimer);
    this.gas.stop();
    this.persist();
    REFERENCES.stop();
    this.store.close();
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
    if (this.seedsPending()) void this.backgroundHistory();
  }

  getState(): MarketState {
    return {
      chainId: 143, block: this.block, monUsd: REFERENCES.assetUsd('MON'), monChangePct: REFERENCES.changePctFor('MON'),
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: config.quoteIntervalMs, source: 'live', venues: venueMeta(), notes: this.notes.list(),
      rpc: rpcStatus(),
      // Only when the pools actually differ: with no dedicated archive this
      // would be a copy of `rpc`, and a duplicated chip reads as a second
      // subsystem that does not exist.
      ...(hasDedicatedArchive ? { rpcArchive: archiveRpcStatus() } : {}),
    };
  }
  getQuotes(): QuoteSnapshot { return this.quotes; }
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
    // load recent fills for live serving; drop rows past the retention window
    // (the persisted mid curve shares the fills' retention — it only exists to
    // replay THEM on a markout-model bump).
    this.store.pruneFills(Date.now() - config.fillsRetentionDays * 86_400_000);
    this.store.pruneMids(Date.now() - config.fillsRetentionDays * 86_400_000);
    this.fills = this.store.recentFills(400);
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

    // 3. resume point — same-day gap-fill, else start at tip
    const head = await publicClient.getBlockNumber();
    this.block = Number(head);
    this.bootHead = head; // upper bound for the live gap-fill (tail owns > head)
    // The archive's own head bounds the deep crawls (see deepEnd). An archive
    // that cannot answer at all leaves deepEnd at the hot head: the crawls then
    // fail closed on their first fetch and hold, which is the honest outcome —
    // far better than silently narrowing every venue's history to nothing.
    this.deepEnd = head;
    if (hasDedicatedArchive) {
      try {
        const archiveHead = await archiveClient.getBlockNumber();
        if (archiveHead < head) this.deepEnd = archiveHead;
      } catch { /* unreadable — keep the hot bound; the crawls hold on their own */ }
    }
    const lpb = this.store.getMeta('lastProcessedBlock');
    // gap-fill ANY bounded gap — including across UTC midnight: decoded fills
    // carry real block timestamps and dayFor() buckets them onto the right
    // (possibly just-closed) day; countedIds/fill-id dedup keeps it idempotent.
    // The old same-day condition silently dropped the gap's fills on every
    // midnight-crossing restart.
    if (lpb && head - BigInt(lpb) <= BigInt(config.gapFillMaxBlocks)) {
      this.lastBlock = BigInt(lpb);
      // remember this exact line so the tail can retract it once it catches up to
      // bootHead (checkGapFill, family B of #6); the count is fixed here while the
      // cursor keeps moving, so the string is stored rather than rebuilt.
      const resume = `resuming: gap-filling ${head - BigInt(lpb)} block(s) since last run`;
      this.note('tail.resume', resume);
      this.gapResume.msg = resume;
    } else {
      this.lastBlock = head;
      // two different events: a bounded gap was skipped (fills in it are lost
      // for good, so it is a warning) versus a first boot with nothing to resume.
      if (lpb) this.note('tail.gap.skipped', `gap exceeds ${config.gapFillMaxBlocks} blocks — resuming at tip (interim fills not decoded)`);
      else this.note('tail.resume', 'cold start — today builds forward from now');
    }
  }

  private persist(): void {
    try {
      // one transaction: volume + cursor + fills together, so a crash can never
      // leave the volume ahead of the cursor and let a gap-fill re-count (H1).
      // Each pass also samples every pair's CURRENT reference mid into
      // mid_history (~PERSIST_MS cadence) — the curve a future markout-model
      // bump can replay retained fills against instead of nulling them.
      const now = Date.now();
      const mids = PAIRS
        .map((p) => ({ ts: now, market: p.symbol, mid: REFERENCES.midForPair(p.symbol) }))
        .filter((m) => m.mid > 0);
      this.store.persistSnapshot(
        this.days,
        { lastProcessedBlock: String(this.lastBlock), lastProcessedDay: utcDay() },
        this.dirty.size ? [...this.dirty] : [],
        mids,
      );
      this.dirty.clear();
    } catch (e) {
      // retained + retried next tick, but say so — a broken disk otherwise
      // looks healthy while the cursor silently stops advancing.
      this.noteOnce('store.persist.failed', `persist failed (${(e as Error).message}); retrying`);
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
   */
  private reconcileSwapCounts(): void {
    const byDay = new Map<string, Map<string, number>>();
    for (const c of this.store.fillCountsByDayVenue()) {
      let m = byDay.get(c.utcDay); if (!m) { m = new Map(); byDay.set(c.utcDay, m); }
      m.set(c.venueId, c.swaps);
    }
    for (const d of this.days) {
      const m = byDay.get(d.utcDay);
      if (!m) continue;
      for (const [venueId, swaps] of m) {
        (d.byVenue[venueId] ??= { usd: 0, swaps: 0 }).swaps = swaps;
      }
    }
  }

  /**
   * ONE-SHOT history reset for the listed venues after switching to a better
   * archive RPC, or to recover a window the live tail could not see. Each
   * enabled history stage is cleared and re-armed as one atomic unit; a stage
   * switched off for this run stays untouched.
   *
   * BACKFILL_RESET is `vid[:from][@nonce]`, comma-separated:
   *   metric                lifetime replay
   *   metric:95836845       replay from that block
   *   metric:2026-08-14     replay from that UTC day
   *   metric@2              lifetime; `@` is a re-run nonce, never a start
   *
   * A per-venue marker remembers its applied entry, so redeploys and edits to a
   * different venue do not re-trigger a multi-hour scan. Runs from
   * backgroundHistory() ahead of both stages so neither can miss it.
   */
  private async applyBackfillReset(nowMs: number): Promise<void> {
    const want = config.backfillReset.trim();
    if (!want) return;
    const targets = parseBackfillReset(want);
    adoptLegacyResetMarker(this.store, want, targets);

    const applied: string[] = [];
    for (const t of targets) {
      // One-shot PER VENUE, not per value. A global marker could not record
      // that one entry deferred: retrying it meant re-running the entries that
      // had succeeded, throwing away replays already hours deep.
      if (resetAlreadyApplied(this.store, t)) continue;
      // Stamped only once an entry is FINISHED — done, or refused for a reason
      // that will still hold next boot. A transient failure leaves it unstamped
      // so this entry, and only this entry, is retried.
      const settle = () => markResetApplied(this.store, t);

      if (t.from === 'invalid') {
        this.note('backfill.config.invalid', `backfill reset: cannot parse '${t.spec}' — expected vid, vid:<block> or vid:YYYY-MM-DD`);
        settle();
        continue;
      }
      // A start that is not in the past is IGNORED by both resume checks
      // (`cb <= end + 1n`), which would quietly downgrade a targeted replay
      // into a head-anchored one. Refuse instead of doing something other than
      // what was asked — see refuseResetStart for why neither form self-reports.
      const refusal = refuseResetStart(t, utcDay(nowMs), this.bootHead);
      if (refusal) {
        this.note('backfill.config.invalid', `backfill reset: ${t.vid} ${refusal}`);
        settle();
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
        settle();
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
          const b = await archiveClient.getBlock({ blockNumber: t.block });
          from = resetStartFromBlock(t.block, b.timestamp);
        } catch (e) {
          // no settle(): a resolve that failed on the RPC may well succeed on
          // the next boot, and consuming the reset would strand it silently.
          this.note('backfill.config.invalid', `backfill reset: ${t.vid} — could not resolve block ${t.block} to a day (${(e as Error).message}); retried next boot`);
          continue;
        }
      }
      if (t.from === 'day') {
        try {
          const block = await blockAtOrAfter(Math.floor(Date.parse(`${t.day}T00:00:00Z`) / 1000), this.bootHead);
          const b = await archiveClient.getBlock({ blockNumber: block });
          from = resetStartFromBlock(block, b.timestamp);
        }
        catch (e) {
          // no settle(): transient, same as the block form above.
          this.note('backfill.config.invalid', `backfill reset: ${t.vid} — could not resolve ${t.day} to a block (${(e as Error).message}); retried next boot`);
          continue;
        }
      }
      // Now that a day exists for it, ask the same question again — a RAW
      // block could only be judged against head before this point.
      const resolvedRefusal = from !== undefined ? refuseResolvedStart(from, utcDay(nowMs), this.bootHead) : null;
      if (resolvedRefusal) {
        this.note('backfill.config.invalid', `backfill reset: ${t.vid} ${resolvedRefusal}`);
        settle();
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
      const dropped = resetVenueHistory(this.store, t.vid, { from, deletes });
      purgeVenueDays(this.days, t.vid, deletes);
      purgeVenueFills({ fills: this.fills, pending: this.pending, dirty: this.dirty, countedIds: this.countedIds }, t.vid, deletes);
      if (dropped.fills) this.lbCache.clear();
      settle();
      // Say what was DESTROYED, not just what will be re-scanned: this is a
      // one-shot operation with no undo, and the counts are the only record.
      const scope = from === undefined ? 'lifetime' : `from block ${from.block} (${from.day} onward)`;
      applied.push(`${t.vid} ${scope} — dropped ${dropped.volume} day-row(s), ${dropped.fills} fill(s)`);
    }
    // Legacy breadcrumb, written for ROLLBACK only: older builds read this key
    // and would re-run the whole value without it. Nothing here reads it after
    // adoptLegacyResetMarker has run once.
    this.store.setMeta('backfill_reset_applied', want);
    if (applied.length) this.note('backfill.reset', `backfill reset applied (${want}) — ${applied.join('; ')}`);
  }

  // ── background on-chain backfill ─────────────────────────────────────────────
  /**
   * Seed deep daily-volume history for adapters that declared `backfillFromUtc`
   * but have no keyless subgraph — by replaying their Swap logs on-chain. Runs
   * OFF the boot path (never blocks the dashboard or the live tail): chunked +
   * paced under the RPC's limits, resumable across restarts, and self-healing
   * (retried each boot and on the rediscovery tick until `backfill_done_<venue>` is set).
   */
  private async backfillOnchain(nowMs: number): Promise<void> {
    for (const a of ADAPTERS) {
      const sinceUtc = a.backfillFromUtc;
      const vid = a.venues()[0]?.id ?? '';
      const name = a.venues()[0]?.name ?? vid;
      if (!sinceUtc || !vid || this.store.getMeta(`backfill_done_${vid}`) === '1') continue;
      const seed = seedSources(a);
      // 'skip' (can't land fills by design) is done forever; 'defer' (pools
      // quarantined/undiscovered right now) must NOT be — the done-flag would
      // silently drop the venue's lifetime history (issue: seed vs quarantine).
      if (seed.action === 'skip') { this.store.setMeta(`backfill_done_${vid}`, '1'); continue; }
      if (seed.action === 'defer') { this.noteOnce('backfill.deferred', `${name} backfill deferred — ${seed.reason}`, vid); continue; }
      try { await this.backfillAdapter(a, vid, name, sinceUtc, seed.fills, nowMs); }
      catch (e) { this.noteOnce('backfill.paused', `${name} backfill paused (${(e as Error).message}); retried automatically`, vid); }
    }
  }

  private async backfillAdapter(a: VenueAdapter, vid: string, name: string, sinceUtc: string, sources: LogSource[], nowMs: number): Promise<void> {
    const end = this.deepEnd;
    if (end <= 0n) return;
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
          const b = await archiveClient.getBlock({ blockNumber: cb > end ? end : cb });
          const daySec = Math.floor(Date.parse(`${utcDay(Number(b.timestamp) * 1000)}T00:00:00Z`) / 1000);
          from = await blockAtOrAfter(daySec, end);
        } catch { /* fall back to the full-range start */ }
      }
    }
    if (from > end) { this.store.setMeta(`backfill_done_${vid}`, '1'); return; }

    // The reset and both scans share one closed-day boundary. If this replay
    // begins before midnight and reaches this stage after it, consulting the
    // live clock would scan the newly closed day even though the reset kept it;
    // a zero-fill result would then leave its stale row untouched.
    const today = utcDay(nowMs);
    const acc = new Map<string, { usd: number; swaps: number }>(); // closed utcDay -> totals
    let chunk = BigInt(config.backfillChunk);
    const floor = BigInt(config.getLogsMinChunk);
    let cursor = from;
    let sinceMerge = 0;
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
     *  ARCHIVE pool — this replays from the venue's deploy day. */
    const fetchRange = (t: bigint) => Promise.all(sources.map((s) =>
      archiveClient.getLogs({ address: s.address as any, fromBlock: cursor, toBlock: t, events: s.events as any } as any) as Promise<any[]>));

    while (cursor <= end) {
      if (await holdWhileDegraded()) this.noteOnce('backfill.held', `${name} backfill held while on backup RPC — resumed on primary`, vid);
      // ── in-hole mode: probe a floor-sized slice at the cursor. Readable → the
      // hole is over (fall through and INGEST that probe normally). Unreadable →
      // skip a stride and double it (capped), so a multi-million-block hole is
      // crossed in O(log) hops.
      let to = cursor + chunk - 1n > end ? end : cursor + chunk - 1n;
      let batches: any[][] | null = null;
      if (holeRun > 0) {
        const probeTo = cursor + floor - 1n > end ? end : cursor + floor - 1n;
        try {
          batches = await fetchRange(probeTo);
          to = probeTo;                      // ingest exactly the probe slice
          holeRun = 0; skipStride = floor;   // hole ended — back to normal scanning
        } catch (e) {
          // A TRANSPORT failure proves nothing about the archive's CONTENTS —
          // only that we could not reach it. Skipping on it would leap a
          // doubling stride (up to ~18h of blocks per hop) over data that is
          // perfectly readable, and then mark those days done. Hold the cursor
          // and wait for the pool instead; a real hole ANSWERS, with an error.
          if (isTransportFailure(e)) { await sleep(config.backfillPaceMs * 25); continue; }
          const strideTo = cursor + skipStride - 1n > end ? end : cursor + skipStride - 1n;
          skipped += strideTo - cursor + 1n;
          holeRun++;
          skipStride = skipStride * 2n > MAX_STRIDE ? MAX_STRIDE : skipStride * 2n;
          cursor = strideTo + 1n;
          await sleep(config.backfillPaceMs);
          continue;
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
            // Unreachable ≠ unreadable: a transport failure must never shrink the
            // span (the node never saw the request) nor age into hole mode. Retry
            // the same cursor until the pool answers — holdWhileDegraded above
            // parks the crawl entirely once the breaker notices.
            if (isTransportFailure(e)) { await sleep(config.backfillPaceMs * 25); continue; }
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
        if (batches === null) continue; // shrank or entered hole mode — loop from the adjusted cursor
      }

      const all = batches.flat();
      if (all.length) {
        // ONE timestamp per chunk is enough for DAILY bucketing (a chunk spans
        // ≤ chunk blocks ≈ a few minutes) and keeps a high-volume venue's full
        // backfill to ~1 getBlock/chunk instead of one per fill. Anchor on any log
        // block that resolves (retry + try siblings) so a flaky/missing getBlock —
        // a range-cap RPC can return a log for a block it momentarily 404s — never
        // aborts a multi-million-block backfill.
        let anchorMs = NaN;
        for (const bn of new Set<bigint>(all.map((l) => l.blockNumber as bigint))) {
          for (let i = 0; i < 3 && !Number.isFinite(anchorMs); i++) {
            try { anchorMs = Number((await archiveClient.getBlock({ blockNumber: bn })).timestamp) * 1000; }
            catch { await sleep(config.backfillPaceMs * 5 * (i + 1)); }
          }
          if (Number.isFinite(anchorMs)) break;
        }
        if (Number.isFinite(anchorMs)) {
          const tsOf = () => anchorMs; // chunk-level ts — daily bucketing only
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

      cursor = to + 1n;
      if (++sinceMerge >= config.backfillMergeEvery || cursor > end) {
        this.mergeBackfill(vid, acc);
        this.store.setMeta(`backfill_cursor_${vid}`, String(cursor));
        this.store.upsertMany(this.days);
        sinceMerge = 0;
      }
      await sleep(config.backfillPaceMs);
    }

    this.mergeBackfill(vid, acc);
    this.store.setMeta(`backfill_cursor_${vid}`, String(end + 1n));
    // done even when ranges were skipped — re-running every boot can't fix an RPC
    // archive hole. To re-attempt after the provider repairs it: delete the
    // 'backfill_done_<venue>' + 'backfill_cursor_<venue>' meta rows (the SET-per-day
    // merge makes a full re-run idempotent).
    this.store.setMeta(`backfill_done_${vid}`, '1');
    this.store.upsertMany(this.days);
    this.note('backfill.done', `${name}: backfill complete — ${acc.size} day(s) seeded` +
      (skipped > 0n ? ` (${skipped} block(s) unreadable on the RPC archive and skipped — those windows may undercount)` : ''), vid);
    this.emitMsg({ ch: 'volume', data: this.cloneDay(this.today()) }); // nudge connected clients
  }

  /** Merge accumulated backfill totals into this.days, SET per (day, venue):
   *  backfill is authoritative for a CLOSED day it fully scanned, and the live
   *  tail only ever writes today+, so a SET can never double-count. */
  private mergeBackfill(vid: string, acc: Map<string, { usd: number; swaps: number }>): void {
    for (const [day, tot] of acc) {
      let d = this.days.find((x) => x.utcDay === day);
      if (!d) { d = this.emptyDay(day, false); this.days.push(d); }
      d.byVenue[vid] = { usd: tot.usd, swaps: tot.swaps };
    }
    this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
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
   * later boots so days deferred on an unpublished archive (the current month's
   * Bybit dump) self-heal once it publishes.
   */
  private async markoutOnboarding(nowMs: number): Promise<void> {
    if (this.remarkRunning) return;
    this.remarkRunning = true;
    try { await this.markoutOnboardingInner(nowMs); }
    finally { this.remarkRunning = false; }
  }

  /** Timer-driven retry of DEFERRED markout backfills (e.g. a month's Bybit
   *  dump that wasn't published yet): re-walk each venue's remark cursors.
   *  No-op while the boot chain still owns the stage, and cheap when there is
   *  nothing markable (SQL candidates + a HEAD probe per missing month). */
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

  private async markoutOnboardingInner(nowMs: number): Promise<void> {
    for (const a of ADAPTERS) {
      const vid = a.venues()[0]?.id ?? '';
      const name = a.venues()[0]?.name ?? vid;
      if (!vid) continue;
      // ALL sources (fills + state + attribution), unlike the volume backfill:
      // these rows are user-visible in the tape/leaderboard, so decode needs its
      // state (e.g. Clober book Opens) and router attribution to label them.
      const seed = seedSources(a);
      if (seed.action === 'skip') { this.store.setMeta(`mkfill_done_${vid}`, '1'); continue; }
      if (seed.action === 'defer') { this.noteOnce('markout.deferred', `${name} markout onboarding deferred — ${seed.reason}`, vid); continue; }
      try {
        if (this.store.getMeta(`mkfill_done_${vid}`) !== '1') await this.backfillRecentFills(a, vid, name, seed.all, nowMs);
        await this.remarkVenue(vid, name);
      } catch (e) {
        this.noteOnce('markout.paused', `${name} markout onboarding paused (${(e as Error).message}); retried automatically`, vid);
      }
    }
  }

  /** Scan the venue's recent fills on-chain (day-aligned window, real block
   *  timestamps) and persist them. Volume buckets are NOT touched — closed-day
   *  volume is owned by the venue's volume backfill / subgraph seed, and the
   *  deterministic fill ids make this idempotent against both. */
  private async backfillRecentFills(a: VenueAdapter, vid: string, name: string, sources: LogSource[], nowMs: number): Promise<void> {
    const end = this.deepEnd;
    if (end <= 0n) return;
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
    if (from > end) { this.store.setMeta(`mkfill_done_${vid}`, '1'); return; }

    // The RUN's day, not this venue's start day. A reset earlier in the same
    // run preserved its "today" — the one day it may not delete — and fills are
    // insert-if-absent (ON CONFLICT DO NOTHING), so a scan working from a LATER
    // day cannot correct that day's rows, only add to them: the stale fills
    // survive and reconcileSwapCounts then counts them alongside the fresh
    // ones. Venue scans run back to back for hours, so whether that happened
    // depended on how long earlier venues took. Sharing the anchor makes the
    // preserved day the same day for every stage of the run.
    // The volume replay uses this same anchor: mergeBackfill only SETS days
    // that decoded at least one fill, so a newly closed zero-fill day cannot be
    // allowed into one scan after the reset deliberately preserved it.
    const today = utcDay(nowMs);
    let chunk = BigInt(config.backfillChunk);
    const floor = BigInt(config.getLogsMinChunk);
    const maxChunk = BigInt(config.backfillChunk);
    let cursor = from;
    let sinceFlush = 0;
    let persisted = 0;
    let tsFails = 0; // consecutive timestamp-resolution failures at the SAME cursor
    const batch: Fill[] = [];
    // `sinceDay` is the WINDOW anchor, not necessarily where this scan begins: a
    // resumed cursor (or a targeted BACKFILL_RESET) moves `from` forward. Naming
    // the anchor as if it were the start reported a scan that was not happening —
    // the same mislabel already corrected on backfill.start above.
    this.noteOnce('markout.scan.start', `${name}: onboarding fill scan — blocks ${from}→${end} (window since ${sinceDay})`, vid);

    // ARCHIVE pool — the window reaches back markoutBackfillDays (30d default),
    // far past a pruning fullnode's retention.
    const fetchAll = (t: bigint) => Promise.all(sources.map((s) =>
      archiveClient.getLogs({ address: s.address as any, fromBlock: cursor, toBlock: t, events: s.events as any } as any) as Promise<any[]>));

    while (cursor <= end) {
      if (await holdWhileDegraded()) this.noteOnce('markout.scan.held', `${name} onboarding scan held while on backup RPC — resumed on primary`, vid);
      const to = cursor + chunk - 1n > end ? end : cursor + chunk - 1n;
      let batches: any[][] | null = null;
      let tries = 0;
      while (batches === null) {
        try {
          batches = await fetchAll(to);
          if (chunk < maxChunk) chunk = chunk * 2n > maxChunk ? maxChunk : chunk * 2n; // recover after shrinks
        } catch (e) {
          // Unreachable ≠ unreadable — see the volume backfill above. A skip here
          // permanently omits fills from the 30-day markout window, so a pool
          // outage must hold rather than consume the range.
          if (isTransportFailure(e)) { await sleep(config.backfillPaceMs * 25); continue; }
          if (chunk > floor) { chunk = chunk / 2n > floor ? chunk / 2n : floor; break; } // too wide → shrink, retry cursor
          if (++tries <= 5) { await sleep(config.backfillPaceMs * 25 * tries); continue; } // transient → back off
          // A recent range should never be an archive hole; if the RPC still
          // can't serve it, skip ONE floor chunk loudly rather than stalling.
          this.noteOnce('markout.range.skipped', `${name} onboarding: RPC could not serve blocks near ${cursor} — a small range was skipped`, vid);
          cursor = to + 1n;
          break;
        }
      }
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
        for (let i = 0; i < blocks.length && !tsFailed; i += POOL) {
          await Promise.all(blocks.slice(i, i + POOL).map(async (bn) => {
            for (let r = 0; r < 3; r++) {
              try {
                blockTs.set(String(bn), Number((await archiveClient.getBlock({ blockNumber: bn })).timestamp) * 1000);
                return;
              } catch { await sleep(config.backfillPaceMs * 5 * (r + 1)); }
            }
            tsFailed = true;
          }));
          await sleep(config.backfillPaceMs);
        }
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

      cursor = to + 1n;
      if (++sinceFlush >= config.backfillMergeEvery || cursor > end) {
        persisted += this.store.insertFillsIfAbsent(batch);
        batch.length = 0;
        this.store.setMeta(`mkfill_cursor_${vid}`, String(cursor));
        sinceFlush = 0;
      }
      await sleep(config.backfillPaceMs);
    }

    this.store.setMeta(`mkfill_done_${vid}`, '1');
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
      catch (e) { this.noteOnce('markout.paused', `${name} ${market}: markout backfill paused (${(e as Error).message}); resumes next boot`, vid); }
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
        // Warn+defer while this month's archive is missing, retract the stale
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
        this.store.applyRemarks(updates);
        // the markouts are on disk now, so the "resumed" line is finally true.
        // checkArchivePending set `resumed` only on the sweep the archive
        // published, so this stays silent on every other sweep.
        if (resumed) this.note('markout.archive.published', resumed, vid);
        // count only fills that got ≥1 markout — an all-null result (mid gaps)
        // is honest but isn't "computed".
        marked += updates.filter((u) => u.markoutsBps.some((m) => m != null)).length;
      }
      this.store.setMeta(metaKey, day);
      day = utcDay(dayStart + 86_400_000 + 1);
      await sleep(config.backfillPaceMs);
    }
    if (marked) {
      this.note('markout.remark.done', `${name} ${market}: markouts backfilled for ${marked} fill(s)`, vid);
      this.lbCache.clear(); // fresh aggregates on the next /api/leaderboard hit
    }
  }

  /** Aggregated leaderboard over the FULL window, from SQLite (no fetch cap).
   *  TTL-cached per window so polling clients share one computation, and
   *  inflight-deduped so concurrent cold hits can't stack N computes. The pass
   *  itself yields to the event loop (computeLeaderboard) — only the SQL scan
   *  is a synchronous slice. */
  private lbCache = new Map<number, { at: number; res: LeaderboardResponse }>();
  private lbInflight = new Map<number, Promise<LeaderboardResponse>>();
  leaderboard(days: number): Promise<LeaderboardResponse> {
    const ttl = days <= 1 ? 15_000 : days <= 7 ? 120_000 : 600_000;
    const now = Date.now();
    const hit = this.lbCache.get(days);
    if (hit && now - hit.at < ttl) return Promise.resolve(hit.res);
    const inflight = this.lbInflight.get(days);
    if (inflight) return inflight;
    const p = (async () => {
      // keyset pages (never the whole window — a 30d materialization OOM'd the
      // 512MB box), upper bound pinned to the request time so BOTH passes see
      // the same snapshot while live fills keep landing.
      const since = now - days * 86_400_000;
      const makePass = () => {
        let afterTs = -1;
        let afterId = '';
        return () => {
          const page = this.store.lbFillsChunk(since, afterTs, afterId, 25_000, now);
          if (page.length) { const last = page[page.length - 1]; afterTs = last.ts; afterId = last.id; }
          return page;
        };
      };
      const res = await computeLeaderboard(makePass, days, now, (ids) => this.store.fillsByIds(ids));
      this.lbCache.set(days, { at: now, res });
      return res;
    })().finally(() => this.lbInflight.delete(days));
    this.lbInflight.set(days, p);
    return p;
  }

  /** Historical fills from the DB (the leaderboard/markouts query real windows). */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : 0;
    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
    return this.store.fillsSince(sinceMs, Math.min(Math.floor(rawLimit), 50_000));
  }

  // ── poll loop ───────────────────────────────────────────────────────────────
  /** one self-scheduling pass of either loop; a pass can never overlap itself
   *  (the next run is only armed after the previous completes). */
  private scheduleLoop(kind: 'quote' | 'tail', delay?: number): void {
    if (this.loopsStopped) return;
    const interval = kind === 'quote' ? config.quoteIntervalMs : config.tailIntervalMs;
    const timer = setTimeout(async () => {
      const t0 = Date.now();
      if (kind === 'quote') {
        try { await this.poll(); } catch { /* keep ticking */ }
        this.ageMarkouts();
      } else {
        try { await this.tailFills(); } catch (e) { this.noteOnce('tail.failed', `tail failed — holding cursor, retrying: ${(e as Error).message}`); }
        this.emitMsg({ ch: 'volume', data: this.cloneDay(this.today()) });
      }
      this.scheduleLoop(kind, Math.max(0, interval - (Date.now() - t0)));
    }, delay ?? interval);
    if (kind === 'quote') this.quoteTimer = timer; else this.tailTimer = timer;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const monUsd = REFERENCES.assetUsd('MON');
    // Surface a starving reference feed LOUDLY (state.notes): with no base mid
    // there are no reference rows, no venue bps anchors and no markouts for that
    // asset's pairs — they silently vanish from the UI otherwise (this is exactly
    // how the geo-blocked Binance feed on Render hid BTC/ETH; feeds swallow their
    // own connection errors, so the mid is the observable signal). Grace period
    // covers the normal cold-start warmup.
    if (now - this.bootMs > 60_000) {
      checkReferenceStarvation(Object.values(ASSETS), (k) => REFERENCES.assetUsd(k), this.starvedSince, now, {
        warn: (m) => this.noteOnce('reference.starved', m),
        clear: (m) => this.dropNote('reference.starved', m),
        announce: (m) => this.note('reference.recovered', m),
      });
    }
    // record each PAIR's CEX mid history in its own terms (the markout anchors).
    for (const pair of PAIRS) {
      const mid = REFERENCES.midForPair(pair.symbol);
      if (mid <= 0) continue;
      const h = this.midHist.get(pair.symbol) ?? [];
      h.push({ t: now, mid });
      if (h.length > 400) h.shift();
      this.midHist.set(pair.symbol, h);
    }

    // head rides the SAME batched round as the adapters' first reads — a
    // dedicated await here paid one extra network round-trip per tick.
    const [head, venueRowsNested] = await Promise.all([
      publicClient.getBlockNumber(),
      Promise.all(ADAPTERS.map(async (a) => {
        if (!a.quote) return [] as QuoteRow[];
        // a THROWN quote is a degradation like any other — swallowing it left
        // the venue's disappearance with no explanation anywhere.
        const rows = await a.quote(this.ctxFor(a), config.sizesUsd).catch((e) => {
          // a rejection is not necessarily an Error — a bare string or an
          // Error with an empty message would otherwise note "quote failed:
          // undefined", which is worse than useless to whoever reads it.
          const why = (e instanceof Error && e.message) || String(e ?? '') || 'no reason given';
          this.noteOnce('venue.quote.unavailable', `${a.venues()[0]?.name ?? 'venue'} quote failed: ${why}`, this.vidOf(a));
          return [] as QuoteRow[];
        });
        return this.ownVenues(a, rows, 'quote'); // drop rows for ids the adapter didn't declare
      })),
    ]);
    this.block = Number(head);
    const venueRows = venueRowsNested.flat();
    // A venue that stopped quoting vanishes from the grid silently otherwise
    // (checkQuoteOutage). Skipped during boot warmup — references start cold,
    // so EVERY venue is legitimately empty for the first cycles — and while the
    // RPC is degraded, when everything is empty and the rpc.* note says why.
    if (now - this.bootMs > 60_000 && !rpcStatus().degraded) {
      const counts = new Map<string, number>();
      for (const r of venueRows) counts.set(r.venueId, (counts.get(r.venueId) ?? 0) + 1);
      const quoting = ADAPTERS.filter((a) => a.quote).map((a) => a.venues()[0]).filter(Boolean);
      // `now` is stamped at the top of poll(), BEFORE the adapters quote, so a
      // note an adapter raises from inside this tick lands on or after `since`.
      checkQuoteOutage(quoting, (id) => counts.get(id) ?? 0, this.quoteEmptyRuns, this.quoteDark, now, {
        warn: (id, m) => this.noteOnce('venue.quote.unavailable', m, id),
        announce: (id, m) => this.note('venue.quote.recovered', m, id),
        clear: (id, m) => this.dropNote('venue.quote.unavailable', m, id),
        explained: (id, since) => this.notes.holds('venue.quote.unavailable', id, since),
      });
    }
    // benchmark rows for every pair, each routed to + tagged with its CEX (Bybit/Binance).
    const refRows = REFERENCES.quote(config.sizesUsd);
    annotateCex(venueRows, refRows); // docs/architecture.md: fill stream — matched per market, so each venue row hits its pair's CEX
    this.quotes = { block: this.block, monUsd, ts: now, rows: [...venueRows, ...refRows] };
    this.emitMsg({ ch: 'state', data: this.getState() });
    this.emitMsg({ ch: 'quotes', data: this.quotes });
  }

  // ── fills ───────────────────────────────────────────────────────────────────
  private async tailFills(): Promise<void> {
    // Defer the tail until at least one CEX reference is warm so markout anchors are
    // sound; lastBlock is not advanced, so the range is re-decoded once warm (audit C3).
    if (!Object.keys(ASSETS).some((k) => REFERENCES.assetUsd(k) > 0)) return;
    // finality margin: Monad logs/receipts can mutate for ~2 blocks (~600ms).
    // A speculative log that mutates away after ingest would be PERMANENT
    // phantom volume — there is no un-count path. Same margin as the gas tracker.
    const head = (await publicClient.getBlockNumber()) - 5n;
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1n;

    // Fetch every adapter's declared log sources into a per-adapter bundle. Track
    // whether any REQUIRED (fill-producing) source failed: if so we must NOT
    // advance the cursor, or a transient RPC error would look like "no logs" and
    // silently lose those fills forever (review #1). Only attribution sources
    // are tolerated on failure; state/discovery sources are cursor-critical.
    let requiredFailed = false;
    const perAdapter = await Promise.all(ADAPTERS.map(async (a) => {
      const bundle: LogBundle = {};
      const all: any[] = [];
      const failed = new Set<string>(); // source keys whose fetch failed (surfaced to decode)
      await Promise.all(a.logSources().map(async (s) => {
        try {
          const logs = (await getLogsChunked({ address: s.address, fromBlock: from, toBlock: head, events: s.events as any })) as any[];
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

    // every required source succeeded → advance the cursor and ingest.
    this.lastBlock = head;
    // the boot gap is fully decoded once the cursor reaches bootHead: retract the
    // resume note, then announce the tail is current (checkGapFill, family B of #6).
    checkGapFill(this.lastBlock, this.bootHead, this.gapResume, {
      clear: (m) => this.dropNote('tail.resume', m),
      announce: (m) => this.note('tail.caughtup', m),
    });
    fresh.sort((a, b) => a.blockNumber - b.blockNumber);
    // best-effort label enrichment (UNKNOWN → DIRECT / Router - X). Never
    // cursor-critical: a lookup failure leaves the adapter's honest UNKNOWN.
    try { await this.attributor.attribute(fresh); } catch { /* labels only */ }
    for (const f of fresh) this.ingest(f);
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
    if (this.fills.length > 400) {
      const dropped = this.fills.shift();
      if (dropped) this.countedIds.delete(dropped.id);
    }
    // Keep aging any fill that still has a recoverable (future) markout horizon.
    if (this.hasFutureMarkoutHorizon(f)) this.pending.add(f);
    this.dirty.add(f);
    // Bucket by the fill's execution day, keyed generically by venueId.
    const d = this.dayFor(f.ts);
    const vd = (d.byVenue[f.venueId] ??= { usd: 0, swaps: 0 });
    vd.usd += f.usd;
    vd.swaps += 1;
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

  /** Join each pending fill to the reference mid at each horizon as it ages. */
  private ageMarkouts(): void {
    const now = Date.now();
    for (const f of [...this.pending]) {
      // an approximate-price fill must never be aged — mid/execPx against a
      // pxApprox execPx fabricates markouts the contract excludes. Unreachable
      // via hasFutureMarkoutHorizon (which refuses to queue them); defensive.
      if (f.pxApprox) { this.pending.delete(f); continue; }
      // an UNREGISTERED market has no CEX routing — never fall back to MON/Bybit
      // (a BTC fill aged vs a $0.02 mid would fabricate absurd markouts). Leave
      // its markouts null and stop tracking it (defense in depth; adapters gate
      // discovery/decode on the pair registry so this shouldn't be reachable).
      if (!pairOf(f.market)) { this.pending.delete(f); this.noteOnce('markout.market.unregistered', `fill market '${f.market}' is not a registered pair — markouts skipped`, f.venueId); continue; }
      const hist = this.midHist.get(f.market) ?? [];
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
      if (complete) this.pending.delete(f);
    }
  }
  /** the pair mid within ±MID_NEAR_TOL_MS of `t`, else 0 (unmarkable). The
   *  history is length-capped, not time-capped, and poll() can starve during a
   *  long catch-up tail — an uncapped "nearest" sample could be minutes off. */
  private static readonly MID_NEAR_TOL_MS = 6_000;
  private midNear(market: string, t: number): number {
    const hist = this.midHist.get(market) ?? [];
    let best = 0, bestDt = Infinity;
    for (const s of hist) { const dt = Math.abs(s.t - t); if (dt < bestDt) { bestDt = dt; best = s.mid; } }
    if (bestDt <= LiveDataSource.MID_NEAR_TOL_MS) return best;
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
    }
    d.partial = true;
    for (const x of this.days) if (x !== d && x.partial && x.utcDay < day) x.partial = false;
    return d;
  }
}
