import type { PublicClient } from 'viem';
import type { NoteCode } from '@shared';
import { config } from './config.js';
import { utcDay } from './util.js';
import { blockAtOrAfter } from './chain/rpc.js';
import type { VolumeStore } from './db.js';
import type { NoteFn } from './notes.js';
import type { GasSource, VenueAdapter } from './venues/adapter.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bump to re-run the one-time bootstrap coverage verification (see pass()). */
const GAS_COVERAGE_EPOCH = '2';

/** Canonical fingerprint of a venue's declared gas destinations: lowercased,
 *  deduped, sorted, comma-joined — so reordering, checksum-casing, or listing
 *  an address twice is NOT a change. */
export function gasSourcesSignature(sources: GasSource[]): string {
  const addrs = sources.flatMap((s) => (Array.isArray(s.address) ? s.address : [s.address]));
  return [...new Set(addrs.map((x) => x.toLowerCase()))].sort().join(',');
}

/** How a destination-set change invalidates the accrued series.
 *  - additions only → the past was merely INCOMPLETE: before the added
 *    contract EXISTED no tx could target it, so rows up to its creation day
 *    are still exact → 'partial' rebuild from that day (see
 *    reconcileSourceChange for how the day is found).
 *  - any removal → the past was WRONG: day rows are additive scaled sums, the
 *    removed address's share can't be unmixed → 'full' lifetime rebuild. */
export function classifyGasSourceChange(prevSig: string, sig: string): { kind: 'none' | 'partial' | 'full'; added: `0x${string}`[] } {
  const prev = new Set(prevSig.split(',').filter(Boolean));
  const next = new Set(sig.split(',').filter(Boolean));
  const added = [...next].filter((x) => !prev.has(x)) as `0x${string}`[];
  const removed = [...prev].filter((x) => !next.has(x));
  if (!added.length && !removed.length) return { kind: 'none', added: [] };
  if (removed.length || !added.length) return { kind: 'full', added: [] };
  return { kind: 'partial', added };
}

/** Bootstrap boundary for a series that predates destination fingerprinting:
 *  the earliest creation day strictly after the series anchor — everything
 *  from there must be re-scanned to be provably complete. Null when every
 *  destination predates the anchor (the scan covered them from birth). */
export function bootstrapRebuildDay(creationDays: string[], anchorDay: string): string | null {
  const late = creationDays.filter((d) => d > anchorDay).sort();
  return late[0] ?? null;
}

/** Evidence window for skipping a bootstrap rebuild: the 7 full UTC days
 *  after the destination's creation day (creation day itself is excluded —
 *  an older destination may own its burn). Clamped to closed days; empty
 *  when the destination is too young to have a full week of evidence. */
export function coverageEvidenceWindow(creationDay: string, todayDay: string): string[] {
  const out: string[] = [];
  const t = Date.parse(`${creationDay}T00:00:00Z`);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(t + i * 86_400_000).toISOString().slice(0, 10);
    if (d >= todayDay) break; // today is a partial bucket — not evidence
    out.push(d);
  }
  return out;
}

/** True when every day of the evidence window has counted burn. ONLY valid
 *  for a SINGLE-destination venue: with one destination, any counted burn
 *  after its creation is necessarily its own, so a continuous nonzero week
 *  proves the old scan was already covering it. Multi-destination venues
 *  must never use this — an older destination's burn would mask the newer
 *  one's hole (exactly the Hanji v1/v2 trap). An empty window is NOT
 *  evidence (too young) — callers rebuild. */
export function hasCoverageEvidence(window: string[], nonzeroDays: Set<string>): boolean {
  return window.length > 0 && window.every((d) => nonzeroDays.has(d));
}

/**
 * GasTracker — QUOTE_UPDATE_BURN accrual: the MON each venue's own keeper
 * spends keeping its quotes fresh, bucketed per (UTC day, venue) into
 * `daily_gas`. Venues declare WHERE their update txs are found (adapter
 * `gasSources()`, destination-keyed — sender rotation never matters); this
 * tracker owns the how: cursors, the first-run VENUE-LIFETIME backfill (from
 * the venue's sinceUtc — same anchor as the volume backfill) and forward
 * accrual are the same loop, so there is no separate onboarding stage.
 *
 * Monad charges gas_limit, and receipts report gasUsed == limit, so a tx's
 * true cost is exactly receipt.gasUsed × effectiveGasPrice — no estimation on
 * the cost side. Two enumeration modes (see GasSource):
 *  - 'logs':   update events → EXACT tx counts; cost receipt-sampled per chunk
 *              (keeper gas limits are flat → sub-1% error, counts untouched).
 *  - 'blocks': no events (POE setData) → sampled eth_getBlockReceipts scaled
 *              by stride; ESTIMATE (approx venue, UI shows ≈). Only sound for
 *              a near-constant-cadence keeper.
 *
 * Crash-safety: increments are ADDITIVE, committed atomically WITH the venue's
 * cursor (VolumeStore.applyGas) — a crash can never double-count. Known blind
 * spot (documented, accepted): logs-mode misses REVERTED keeper txs, which on
 * Monad still pay their full gas_limit — a small undercount when a keeper
 * misfires; blocks-mode sees them (receipts carry status).
 */
export class GasTracker {
  private stopped = false;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** venues whose numbers are sampled estimates — sticky, persisted as meta so
   *  the ≈ marker survives restarts even before the venue's sources resolve. */
  private approx = new Set<string>();
  private noted = new Set<string>();

  constructor(
    private client: PublicClient,
    private store: VolumeStore,
    private adapters: readonly VenueAdapter[],
    private note: NoteFn,
    /** RPC failover state — gas accrual pauses on a backup endpoint (cursors
     *  hold exactly, so the series catches up losslessly on the primary). */
    private degraded: () => boolean = () => false,
    /** per-pass tail budget override (tests); production uses the config knob. */
    private sliceChunks: number = config.gasSliceChunks,
  ) {
    for (const a of adapters) {
      const vid = a.venues()[0]?.id;
      if (vid && this.store.getMeta(`gas_approx_${vid}`) === '1') this.approx.add(vid);
    }
  }

  start(): void {
    void this.pass();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** venue ids whose values are sampled estimates (blocks mode). */
  approxVenueIds(): string[] { return [...this.approx].sort(); }

  /** one pass: tail every gas-declaring venue to head, then reschedule. */
  private async pass(): Promise<void> {
    if (this.running || this.stopped) return;
    // Receipt/log crawls are the heaviest RPC consumers — while on a backup
    // endpoint they'd starve the live tail's rate budget, so skip the pass
    // and just re-arm the timer; accrual resumes on the primary.
    if (this.degraded()) {
      this.timer = setTimeout(() => { void this.pass(); }, config.gasTailMs);
      return;
    }
    this.running = true;
    try {
      // COVERAGE EPOCH: stored destination fingerprints are only trustworthy
      // if the build that stored them actually verified coverage. The first
      // fingerprinting build did not (it stored the sig while skipping the
      // empty-prevSig case), so sigs it wrote can mask holes — bumping the
      // epoch clears all stored sigs exactly once, re-arming the per-venue
      // bootstrap check below (which is cheap and provably-bounded for
      // venues that were fine). Bump again only if sig trust is ever broken
      // the same way.
      if (this.store.getMeta('gas_cov_epoch') !== GAS_COVERAGE_EPOCH) {
        this.store.deleteMetaPrefix('gas_srcs_');
        this.store.setMeta('gas_cov_epoch', GAS_COVERAGE_EPOCH);
      }
      // a venue whose adapter no longer declares gasSources must not keep a
      // stale (possibly misattributed) series — wipe rows + cursor once, so
      // dropping a wrong source self-heals on deploy.
      for (const a of this.adapters) {
        const vid = a.venues()[0]?.id ?? '';
        if (!vid || a.gasSources) continue;
        if (this.store.getMeta(`gas_cursor_${vid}`)) {
          this.store.resetGas(vid);
          this.store.setMeta(`gas_approx_${vid}`, '');
          this.approx.delete(vid);
          this.note('gas.series.reset', `${a.venues()[0]?.name ?? vid}: gas series removed — venue no longer declares quote-update sources`, vid);
        }
      }
      // destination ownership: the SAME contract claimed by two venues would
      // double-count every update tx — first declarer wins, the rest are
      // skipped LOUDLY (this is exactly how a misattributed address surfaces).
      const owner = new Map<string, string>();
      for (const a of this.adapters) {
        if (this.stopped) return;
        if (!a.gasSources) continue;
        const vid = a.venues()[0]?.id ?? '';
        const name = a.venues()[0]?.name ?? vid;
        if (!vid) continue;
        let conflict = false;
        try {
          for (const s of a.gasSources()) {
            for (const addr of Array.isArray(s.address) ? s.address : [s.address]) {
              const key = addr.toLowerCase();
              const held = owner.get(key);
              if (held && held !== vid) {
                this.noteOnce('gas.destination.conflict', `${name}: gas destination ${addr.slice(0, 10)}… already tracked by '${held}' — venue skipped until the collision is resolved`, vid);
                conflict = true;
              } else owner.set(key, vid);
            }
          }
        } catch { /* sources unresolved (pre-discovery) — tailVenue defers anyway */ }
        if (conflict) continue;
        try { await this.tailVenue(a, vid, name); }
        catch (e) { this.note('gas.scan.paused', `${name}: quote-update gas tail paused (${(e as Error).message}); retried next pass`, vid); }
      }
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => { void this.pass(); }, config.gasTailMs);
    }
  }

  private async tailVenue(a: VenueAdapter, vid: string, name: string): Promise<void> {
    let sources: GasSource[];
    try { sources = a.gasSources!(); }
    catch { return; } // destination not resolved yet (discovery) — retried next pass
    if (!sources.length) return;

    // one enumeration mode per venue: a single block cursor can't track two
    // differently-paced walks. Every current venue declares exactly one source.
    const mode = sources[0].mode;
    if (sources.some((s) => s.mode !== mode)) {
      this.noteOnce('gas.mode.mixed', `${name}: mixed gas-source modes — using '${mode}' sources only`, vid);
      sources = sources.filter((s) => s.mode === mode);
    }
    if (mode === 'blocks' && !this.approx.has(vid)) {
      this.approx.add(vid);
      this.store.setMeta(`gas_approx_${vid}`, '1');
    }

    // finality margin: Monad receipts/logs can mutate for ~2 blocks (~800ms).
    const head = (await this.client.getBlockNumber()) - 5n;
    const cursorKey = `gas_cursor_${vid}`;

    // VENUE-LIFETIME series, same anchor as the volume backfill: the burn
    // history should start when the venue did, not at an arbitrary horizon.
    const sinceDay = a.venues()[0]?.sinceUtc ?? a.backfillFromUtc ?? utcDay();

    // destination-set fingerprint: a venue that MIGRATES its update contract
    // (Hanji's FastQuoter, 2026-07-16: new address, 12-second cutover) leaves
    // a cursor that already walked past the new contract's first active days —
    // additive accrual can't fill that hole. How much history the change
    // invalidates depends on its shape (see classifyGasSourceChange): pure
    // additions rebuild from the added contract's creation day, anything
    // else re-scans the venue lifetime. Same self-healing shape as the
    // sinceUtc deepening below.
    const sig = gasSourcesSignature(sources);
    const sigKey = `gas_srcs_${vid}`;
    const fromKey = `gas_from_${vid}`;
    const prevSig = this.store.getMeta(sigKey);
    const hasCursor = !!this.store.getMeta(cursorKey);
    if (prevSig && prevSig !== sig && hasCursor) {
      await this.reconcileSourceChange(vid, name, prevSig, sig, sinceDay, head, cursorKey);
    } else if (!prevSig && hasCursor) {
      // BOOTSTRAP: the series predates destination fingerprinting (the sig
      // key shipped after this venue's scan began), so we can't know which
      // destinations built it — a source added before fingerprinting existed
      // would leave an invisible hole (Hanji's v2, Jul 2026). Rebuild from
      // the earliest listed-address creation that postdates the series
      // anchor; a venue whose destinations all predate its anchor was
      // necessarily covered from birth and is left untouched. At worst this
      // re-scans a bounded, provably-sufficient tail once. Probe failure →
      // return WITHOUT storing the fingerprint so the next tick retries.
      try {
        const anchor = this.store.getMeta(fromKey) ?? sinceDay;
        const days: string[] = [];
        for (const addr of sig.split(',').filter(Boolean)) {
          const cb = await this.creationBlock(addr as `0x${string}`, head);
          if (cb === null) continue; // undeployed → contributes no txs
          const blk = await this.client.getBlock({ blockNumber: cb });
          days.push(utcDay(Number(blk.timestamp) * 1000));
        }
        const day = bootstrapRebuildDay(days, anchor);
        if (day) {
          // coverage-evidence gate, SINGLE-destination venues only: with one
          // destination, any counted burn after its creation is necessarily
          // its own — a continuous nonzero week right after creation proves
          // the old scan already covered it (Clober: strategy deployed 3.5
          // weeks after the venue anchor but counted since day one — without
          // this gate the epoch would wipe its whole series for nothing).
          // Multi-destination venues always rebuild: an older destination's
          // burn would mask the newer one's hole (the Hanji v1/v2 trap).
          const single = sig.split(',').filter(Boolean).length === 1;
          const window = coverageEvidenceWindow(day, utcDay());
          const covered = single && window.length > 0
            && hasCoverageEvidence(window, this.store.gasNonzeroDays(vid, window[0], window[window.length - 1]));
          if (!covered) {
            const startBlock = await blockAtOrAfter(Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000), head);
            this.store.resetGasFrom(vid, day);
            this.store.setMeta(cursorKey, String(startBlock));
            this.note('gas.series.reset', `${name}: verifying quote-update coverage — rebuilding from ${day}`, vid);
          }
        }
      } catch { return; }
    }
    this.store.setMeta(sigKey, sig);
    // one-time migration: rows seeded before gas_from existed came from the
    // old shallow (30d) horizon — wipe them WITH their cursor and re-scan from
    // the venue's start (additive rows + a deeper scan would double-count).
    // Self-healing for the future too: if a venue's start ever moves EARLIER,
    // the same wipe-and-rescan deepens its series on the next boot.
    const seededFrom = this.store.getMeta(fromKey);
    if (this.store.getMeta(cursorKey) && (!seededFrom || seededFrom > sinceDay)) {
      this.store.resetGas(vid);
      this.note('gas.series.reset', `${name}: deepening quote-update gas history to ${sinceDay} — re-scanning`, vid);
    }
    const cur = this.store.getMeta(cursorKey);
    let cursor: bigint;
    if (cur) {
      cursor = BigInt(cur);
    } else {
      cursor = await blockAtOrAfter(Math.floor(Date.parse(`${sinceDay}T00:00:00Z`) / 1000), head);
      this.store.setMeta(fromKey, sinceDay);
      this.noteOnce('gas.scan.start', `${name}: quote-update gas scan from ${sinceDay} — blocks ${cursor}→${head}`, vid);
    }
    if (cursor > head) return;

    if (mode === 'logs') await this.tailLogs(vid, name, sources, cursor, head, cursorKey);
    else {
      // one cursor, N destinations: a migrating venue lists old + new update
      // contracts and the single block walk counts txs to any of them.
      const addrs = new Set(sources
        .flatMap((s) => (Array.isArray(s.address) ? s.address : [s.address]))
        .map((x) => x.toLowerCase()));
      await this.tailBlocks(vid, addrs, cursor, head, cursorKey);
    }
  }

  /** Apply a destination-set change with the least destructive rebuild that is
   *  still correct. Pure additions pin the boundary to the added contracts'
   *  CREATION day (bisected via getCode — no tx could target them earlier):
   *  rows before it are kept, rows from it on are wiped and the cursor
   *  re-seeded at the day's first block. Anything that blocks the inference —
   *  a removal, a failed probe, or creation at/before the series anchor —
   *  falls back to the conservative full lifetime rebuild (wrong history
   *  can't be unmixed; missing history can't be patched behind a cursor). */
  private async reconcileSourceChange(vid: string, name: string, prevSig: string, sig: string, sinceDay: string, head: bigint, cursorKey: string): Promise<void> {
    const change = classifyGasSourceChange(prevSig, sig);
    if (change.kind === 'none') return;
    if (change.kind === 'partial') {
      try {
        let earliest: bigint | null = null;
        for (const addr of change.added) {
          const cb = await this.creationBlock(addr, head);
          if (cb === null) { earliest = null; break; } // undeployed address → can't bound it
          if (earliest === null || cb < earliest) earliest = cb;
        }
        if (earliest !== null) {
          const blk = await this.client.getBlock({ blockNumber: earliest });
          const day = utcDay(Number(blk.timestamp) * 1000);
          if (day > sinceDay) {
            const startBlock = await blockAtOrAfter(Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000), head);
            this.store.resetGasFrom(vid, day);
            this.store.setMeta(cursorKey, String(startBlock));
            this.note('gas.series.reset', `${name}: quote-update destination added — rebuilding from ${day} (earlier history unaffected)`, vid);
            return;
          }
        }
      } catch { /* probe/anchor failure — fall through to the full rebuild */ }
    }
    this.store.resetGas(vid);
    this.note('gas.series.reset', `${name}: quote-update destination set changed — re-scanning venue lifetime`, vid);
  }

  /** First block where `addr` has code (its deployment), or null when it has
   *  no code at head. Bisection is sound because code existence is monotonic
   *  (post-Cancun there is no selfdestruct-and-redeploy). A failed probe
   *  THROWS rather than returning a guess: treating "probe failed" as "no
   *  code yet" would push the boundary later and silently lose burn days —
   *  the caller's fallback (full rebuild) is the safe shape. */
  private async creationBlock(addr: `0x${string}`, head: bigint): Promise<bigint | null> {
    const has = async (bn: bigint) => ((await this.client.getCode({ address: addr, blockNumber: bn })) ?? '0x') !== '0x';
    if (!(await has(head))) return null;
    let lo = 0n, hi = head; // invariant: !has(lo) … has(hi)
    if (await has(lo)) return lo;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (await has(mid)) hi = mid; else lo = mid;
    }
    return hi;
  }

  // ── logs mode: events enumerate update txs; receipts price them ────────────
  private async tailLogs(vid: string, name: string, sources: GasSource[], cursor: bigint, head: bigint, cursorKey: string): Promise<void> {
    const maxChunk = BigInt(config.backfillChunk);
    const floor = BigInt(config.getLogsMinChunk);
    let chunk = maxChunk;
    const acc = new Map<string, { mon: number; txs: number }>();
    let sinceCommit = 0;
    // TIME SLICE: a deep rebuild yields after `sliceChunks` ADVANCING
    // iterations so the pass loop can serve every other venue's accrual
    // (shrink/retry attempts don't count — they make no progress, and their
    // own bounded back-off already prevents a stall). The trailing commit
    // persists acc + cursor, so an exhausted slice is indistinguishable from
    // a crash-resume — the next pass continues exactly where this one ended.
    const budget = Math.max(1, this.sliceChunks);
    let sliced = 0;

    const fetchLogs = async (from: bigint, to: bigint): Promise<any[]> => {
      const batches = await Promise.all(sources.map((s) => {
        if (s.mode !== 'logs') return Promise.resolve([] as any[]);
        if (s.topic0) {
          // unverified destination — only the event's topic hash is known.
          return this.client.request({
            method: 'eth_getLogs',
            params: [{ address: s.address, topics: [s.topic0], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
          }) as Promise<any[]>;
        }
        return this.client.getLogs({ address: s.address as any, fromBlock: from, toBlock: to, events: s.events as any } as any) as Promise<any[]>;
      }));
      return batches.flat();
    };

    while (cursor <= head && !this.stopped) {
      const to = cursor + chunk - 1n > head ? head : cursor + chunk - 1n;
      let logs: any[] | null = null;
      let tries = 0;
      while (logs === null) {
        try {
          logs = await fetchLogs(cursor, to);
          if (chunk < maxChunk) chunk = chunk * 2n > maxChunk ? maxChunk : chunk * 2n; // recover after shrinks
        } catch {
          if (chunk > floor) { chunk = chunk / 2n > floor ? chunk / 2n : floor; break; } // too wide → shrink, retry cursor
          if (++tries <= 5) { await sleep(config.backfillPaceMs * 25 * tries); continue; } // transient → back off
          // a range the RPC can't serve is skipped LOUDLY (undercount, never a stall).
          this.noteOnce('gas.range.skipped', `${name}: gas scan could not read blocks near ${cursor} — a small range was skipped`, vid);
          logs = [];
        }
      }
      if (logs === null) continue; // shrank — retry same cursor with a narrower span

      if (logs.length) {
        // unique update txs in the chunk (one tx may emit several update events)
        const txBlocks = new Map<string, bigint>();
        for (const l of logs) {
          const h = String(l.transactionHash).toLowerCase();
          if (!txBlocks.has(h)) txBlocks.set(h, BigInt(l.blockNumber));
        }
        // ONE anchor timestamp per chunk (≤ ~5 min span) is enough for DAILY buckets.
        let anchorMs = NaN;
        for (const bn of new Set(txBlocks.values())) {
          for (let i = 0; i < 3 && !Number.isFinite(anchorMs); i++) {
            try { anchorMs = Number((await this.client.getBlock({ blockNumber: bn })).timestamp) * 1000; }
            catch { await sleep(config.backfillPaceMs * 5 * (i + 1)); }
          }
          if (Number.isFinite(anchorMs)) break;
        }
        if (!Number.isFinite(anchorMs)) {
          this.noteOnce('gas.range.skipped', `${name}: gas scan block timestamps unresolved near ${cursor} — chunk skipped`, vid);
        } else {
          // receipts: evenly-strided sample, scaled to the exact tx count. Keeper
          // limits are flat and prices ride the base-fee floor — the sample tracks
          // the true sum to well under 1% while counts stay exact.
          const hashes = [...txBlocks.keys()];
          const target = Math.max(1, config.gasReceiptSamplePerChunk);
          const stride = Math.max(1, Math.ceil(hashes.length / target));
          const sample = hashes.filter((_, i) => i % stride === 0);
          let sampledMon = 0;
          let sampledN = 0;
          const POOL = 15;
          for (let i = 0; i < sample.length; i += POOL) {
            await Promise.all(sample.slice(i, i + POOL).map(async (h) => {
              for (let r = 0; r < 3; r++) {
                try {
                  const rc = await this.client.getTransactionReceipt({ hash: h as `0x${string}` });
                  sampledMon += Number(rc.gasUsed * rc.effectiveGasPrice) / 1e18;
                  sampledN++;
                  return;
                } catch { await sleep(config.backfillPaceMs * 5 * (r + 1)); }
              }
            }));
            await sleep(config.backfillPaceMs);
          }
          if (sampledN > 0) {
            const day = utcDay(anchorMs);
            const e = acc.get(day) ?? { mon: 0, txs: 0 };
            e.mon += (sampledMon / sampledN) * hashes.length;
            e.txs += hashes.length;
            acc.set(day, e);
          } else {
            this.noteOnce('gas.range.skipped', `${name}: gas scan receipts unavailable near ${cursor} — chunk skipped`, vid);
          }
        }
      }

      cursor = to + 1n;
      if (++sinceCommit >= config.backfillMergeEvery || cursor > head) {
        this.commit(vid, acc, cursorKey, cursor);
        sinceCommit = 0;
      }
      if (++sliced >= budget) break; // slice spent — trailing commit persists, next pass resumes
      await sleep(config.backfillPaceMs);
    }
    this.commit(vid, acc, cursorKey, cursor);
  }

  // ── blocks mode: no events — sample block receipts, scale by stride ────────
  private async tailBlocks(vid: string, targets: ReadonlySet<string>, cursor: bigint, head: bigint, cursorKey: string): Promise<void> {
    const stride = BigInt(Math.max(1, config.gasSampleStrideBlocks));
    const acc = new Map<string, { mon: number; txs: number }>();
    let sinceCommit = 0;
    // TIME SLICE — same contract as tailLogs: yield after `budget` segments,
    // trailing commit persists, next pass resumes from the stored cursor.
    const budget = Math.max(1, this.sliceChunks);
    let sliced = 0;

    while (cursor <= head && !this.stopped) {
      const segEnd = cursor + stride - 1n > head ? head : cursor + stride - 1n;
      const segLen = Number(segEnd - cursor + 1n);
      let ok = false;
      for (let r = 0; r < 3 && !ok; r++) {
        try {
          const [receipts, block] = await Promise.all([
            this.client.request({ method: 'eth_getBlockReceipts', params: [`0x${cursor.toString(16)}`] }) as Promise<any[]>,
            this.client.getBlock({ blockNumber: cursor }),
          ]);
          // includes reverted txs on purpose — Monad charges their full limit too.
          const mine = (receipts ?? []).filter((rc) => targets.has(String(rc.to ?? '').toLowerCase()));
          const mon = mine.reduce((a, rc) => a + Number(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice)) / 1e18, 0);
          const day = utcDay(Number(block.timestamp) * 1000);
          const e = acc.get(day) ?? { mon: 0, txs: 0 };
          e.mon += mon * segLen;
          e.txs += mine.length * segLen;
          acc.set(day, e);
          ok = true;
        } catch { await sleep(config.backfillPaceMs * 5 * (r + 1)); }
      }
      // an unreadable sample block skips its segment (tiny undercount, no stall)
      cursor = segEnd + 1n;
      if (++sinceCommit >= config.backfillMergeEvery || cursor > head) {
        this.commit(vid, acc, cursorKey, cursor);
        sinceCommit = 0;
      }
      if (++sliced >= budget) break; // slice spent — trailing commit persists, next pass resumes
      await sleep(config.backfillPaceMs);
    }
    this.commit(vid, acc, cursorKey, cursor);
  }

  private commit(vid: string, acc: Map<string, { mon: number; txs: number }>, cursorKey: string, cursor: bigint): void {
    const rows = [...acc.entries()]
      .filter(([, v]) => v.txs > 0 || v.mon > 0)
      .map(([day, v]) => ({ utcDay: day, venueId: vid, mon: v.mon, txs: v.txs }));
    this.store.applyGas(rows, cursorKey, String(cursor));
    acc.clear();
  }

  private noteOnce(code: NoteCode, msg: string, venue?: string): void {
    const key = `${code}|${venue ?? ''}|${msg}`;
    if (this.noted.has(key)) return;
    if (this.noted.size >= 300) this.noted.clear(); // cursor-stamped messages are unique — bound the set
    this.noted.add(key);
    this.note(code, msg, venue);
  }
}
