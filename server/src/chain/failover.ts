import { HttpRequestError, TimeoutError } from 'viem';
import type { NoteCode } from '@shared';

/**
 * RpcBreaker — ordered-endpoint failover for one RPC client.
 *
 * Each viem client (hot + archive, chain/rpc.ts) rides its own breaker, so
 * failover happens HERE and nowhere else: K consecutive transport-level
 * failures on the active endpoint advance to the next one (wrapping), and
 * while off the primary a background probe re-checks it every minute — two
 * consecutive healthy probes snap back. Preference is strictly ordered
 * (primary is the paid/better node); this is NOT latency ranking.
 *
 * Failover is WITHIN a pool, never across pools — which is exactly why the two
 * pools exist. A pruned-block reply is a JSON-RPC error, so per the classifier
 * below it can never move a pruning fullnode's traffic onto an archive backup;
 * a mixed list would stall every deep cursor instead of degrading. Keep the
 * pools separate (config.ts: RPC pools).
 *
 * Correctness hinges on the failure classifier: only transport-level errors
 * (5xx / network / timeout) may trip the breaker. A JSON-RPC error response —
 * reverts, "block range too large" (the adaptive chunkers probe ranges
 * constantly), rate-limit backoffs — proves the endpoint is ALIVE and must
 * never cause a switch. Mixed providers are safe by construction: nearly every
 * HOT reads are pinned to explicit blocks and tails run at head−5, so an honest
 * backup can keep them current. DEEP callers impose a stricter contract with
 * guardRpcRead below: a failover during any cursor-bearing read discards the
 * result, even when the backup returned successfully.
 *
 * Event messages are label-only ("primary", "backup-1") — they flow into the
 * public state.notes, so endpoint URLs (which embed RPC keys) must never
 * appear in them. Each event also carries the note code the transition IS, so
 * a consumer filters on `rpc.failover` rather than on the wording.
 */

/** A breaker transition, ready to raise as a note (server/src/notes.ts). */
export interface RpcNote {
  code: NoteCode;
  /** label-only sentence — never a URL. */
  msg: string;
}

/** raw JSON-RPC request fn (an instantiated viem transport's `request`). */
export type RpcRequestFn = (args: { method: string; params?: unknown }) => Promise<unknown>;

export interface BreakerEndpoint {
  label: string;
  request: RpcRequestFn;
}

/** Public shape served on /api/markets (shared MarketState.rpc). */
/** Outcome of a boot verify. `wrongChain` separates a MISCONFIGURATION (an
 *  endpoint on another chain answers successfully, so the breaker can never
 *  fail away from it) from an OUTAGE (unreachable, which recovers on its own).
 *  Callers that treat an outage as non-fatal must still fail closed on the
 *  former — persisting another chain's logs is silent corruption, not a gap. */
export interface RpcVerifyResult {
  ok: boolean;
  block: number;
  reason?: string;
  wrongChain?: boolean;
}

export interface RpcStatusView {
  /** label of the endpoint currently serving requests. */
  active: string;
  /** true while the active endpoint is not the configured primary. */
  degraded: boolean;
  /** true when the last full rotation found no endpoint serving. */
  down: boolean;
  /** epoch ms when we left the primary (absent while on it). */
  degradedSinceTs?: number;
}

/** Transport-level failure = the endpoint itself is unusable. Healthy 4xx
 *  responses are excluded on purpose: throttling/range caps must back off or
 *  shrink, not bounce the whole indexer between endpoints under load. Auth and
 *  ACL failures are the exception — no request can succeed on that endpoint. */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (e instanceof HttpRequestError) {
    // A 4xx response proves the endpoint is serving. In particular, 413 is the
    // public RPC's getLogs range-cap signal: classifying it as transport failure
    // prevents adaptive chunkers from shrinking and can fail over a healthy
    // endpoint. 401/403 cannot serve any RPC request and 408 is transport-shaped.
    return e.status === undefined || e.status === 401 || e.status === 403 || e.status === 408 || e.status >= 500;
  }
  return false;
}

/** The pool stopped being fully usable while a request was in flight. This is
 *  deliberately an availability error even when the underlying read returned a
 *  value or an answer-level archive error: accepting either after failover can
 *  mix providers inside one cursor transaction. */
export class RpcReadUnavailableError extends Error {
  constructor(readonly cause?: unknown) {
    super('RPC pool changed or became unavailable while a read was in flight');
    this.name = 'RpcReadUnavailableError';
  }
}

/**
 * "We could not get an answer", as opposed to "the node answered that it cannot
 * serve this range": transport failures (unreachable), HTTP 429 (alive, but
 * throttled), or a read whose pool failed over before it settled.
 *
 * Deliberately a different predicate from isTransportFailure. For the BREAKER a
 * 429 proves the endpoint is alive and must not trip a switch. For a deep CRAWL
 * any of these failures says nothing about whether the requested blocks exist;
 * treating one as a permanent archive hole would skip readable history.
 */
export function isAvailabilityFailure(e: unknown): boolean {
  if (e instanceof RpcReadUnavailableError) return true;
  if (isTransportFailure(e)) return true;
  return e instanceof HttpRequestError && e.status === 429;
}

/** Accept a read only if its pool is fully available both before and after the
 *  await. Breakers retry transparently, so error classification alone cannot
 *  reveal that a request moved from the primary to a backup mid-flight. */
export async function guardRpcRead<T>(read: () => Promise<T>, unavailable: () => boolean): Promise<T> {
  if (unavailable()) throw new RpcReadUnavailableError();
  try {
    const value = await read();
    if (unavailable()) throw new RpcReadUnavailableError();
    return value;
  } catch (e) {
    if (e instanceof RpcReadUnavailableError) throw e;
    if (unavailable()) throw new RpcReadUnavailableError(e);
    throw e;
  }
}

/** Wait for every concurrent archive read, then prefer any availability
 *  failure over answer-level errors. Promise.all reports only the first promise
 *  to reject; if a permanent hole wins that race while a sibling source was
 *  throttled/unreachable, a crawler can consume a range it never fully read. */
export async function allPreferAvailability<T>(reads: Iterable<PromiseLike<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(reads);
  const unavailable = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected' && isAvailabilityFailure(r.reason));
  if (unavailable) throw unavailable.reason;
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}

const FAILURE_THRESHOLD = 3;   // consecutive transport failures before advancing
const PROBE_INTERVAL_MS = 60_000; // primary re-check cadence while degraded
const RECOVERY_PROBES = 2;     // consecutive healthy probes to snap back

type EndpointHealth = 'unknown' | 'valid' | 'wrong-chain';

class WrongChainEndpointError extends Error {}

export class RpcBreaker {
  private endpoints: BreakerEndpoint[] = [];
  /** An endpoint unreachable at boot is retained, but it must not serve a real
   *  request until its chain id has been checked. Otherwise a wrong-chain node
   *  that recovers later can return successful empty logs and advance a deep
   *  cursor as if Monad had no activity in that range. */
  private endpointHealth: EndpointHealth[] = [];
  private expectedChainId: number | undefined;
  private active = 0;
  private failures = 0;
  /** endpoints advanced-through without a single success — >= endpoint count
   *  means a full rotation failed: everything is down. */
  private advancesSinceSuccess = 0;
  private allDown = false;
  private degradedSinceTs: number | undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private probeInFlight = false;
  private healthyProbes = 0;
  private onEvent: (n: RpcNote) => void = () => undefined;
  private readonly probeIntervalMs: number;
  /** Names this pool in every note it raises. Two pools now share this class
   *  (hot + archive, see chain/rpc.ts), and their transitions land in ONE
   *  state.notes buffer — without the name, "RPC failover: primary unhealthy"
   *  is ambiguous between the node that serves quotes and the node that serves
   *  history, which are different incidents with different urgency. */
  private readonly pool: string;

  constructor(opts?: { probeIntervalMs?: number; pool?: string }) {
    this.probeIntervalMs = opts?.probeIntervalMs ?? PROBE_INTERVAL_MS;
    this.pool = opts?.pool ?? 'RPC';
  }

  /** Bind the instantiated transports. Called once, before any traffic. */
  attach(endpoints: BreakerEndpoint[]): void {
    if (!endpoints.length) throw new Error('RpcBreaker: no endpoints');
    this.endpoints = endpoints;
    this.endpointHealth = endpoints.map(() => 'unknown');
  }

  /** Replace the event sink (single listener — the live source's noteOnce). */
  subscribe(cb: (n: RpcNote) => void): void {
    this.onEvent = cb;
  }

  status(): RpcStatusView {
    return {
      active: this.endpoints[this.active]?.label ?? 'primary',
      degraded: this.active !== 0,
      down: this.allDown,
      ...(this.degradedSinceTs !== undefined ? { degradedSinceTs: this.degradedSinceTs } : {}),
    };
  }

  /** One request through the active endpoint; on a threshold-crossing failure
   *  the request transparently retries on the next endpoint(s), at most one
   *  full rotation. Non-transport errors pass through untouched. */
  async request(args: { method: string; params?: unknown }): Promise<unknown> {
    let hops = 0;
    for (;;) {
      const idx = this.active;
      try {
        await this.ensureChain(idx);
        const res = await this.endpoints[idx].request(args);
        // any success proves the active endpoint serves — clear streak state.
        if (idx === this.active) this.failures = 0;
        this.advancesSinceSuccess = 0;
        if (this.allDown) {
          this.allDown = false;
          this.onEvent({ code: 'rpc.recovered', msg: `${this.pool} serving again (on ${this.endpoints[this.active].label})` });
        }
        return res;
      } catch (e) {
        if (e instanceof WrongChainEndpointError) {
          if (idx === this.active) this.advance();
          if (this.active === idx || ++hops >= this.endpoints.length) throw e;
          continue;
        }
        if (!isTransportFailure(e)) throw e;
        // Concurrent failures from one bad batch all land here with the same
        // idx — only the streak on the STILL-active endpoint counts, so a
        // burst advances once, not once per in-flight request.
        if (idx === this.active) {
          this.failures += 1;
          if (this.failures >= FAILURE_THRESHOLD) this.advance();
        }
        if (this.active === idx || ++hops >= this.endpoints.length) throw e;
        // another endpoint is active now (we advanced, or a sibling did) — retry there.
      }
    }
  }

  /** Verify every endpoint's chain id before serving traffic. Wrong-chain
   *  BACKUPS are dropped (misconfig must not be discovered mid-failover); a
   *  wrong-chain PRIMARY is fatal (never silently run on backups forever). An
   *  unreachable endpoint is kept — it may be mid-outage (today's incident) —
   *  and if that's the primary, we pre-position onto the first healthy backup
   *  so boot doesn't burn the failure threshold on a known-dead node. */
  async verify(expectChainId: number): Promise<RpcVerifyResult> {
    this.expectedChainId = expectChainId;
    const health: (boolean | undefined)[] = []; // true=healthy, false=wrong chain, undefined=unreachable
    let block = 0;
    for (let i = 0; i < this.endpoints.length; i++) {
      const inspected = await this.inspectEndpoint(i, 'at boot');
      health.push(inspected.health);
      if (inspected.health === true) block = Math.max(block, inspected.block);
    }
    if (health[0] === false) return { ok: false, block: 0, wrongChain: true, reason: `${this.pool} primary is on the wrong chain (chainId != ${expectChainId})` };
    // drop wrong-chain backups (walk backwards so indices stay valid).
    for (let i = this.endpoints.length - 1; i >= 1; i--) {
      if (health[i] === false) {
        this.endpoints.splice(i, 1);
        this.endpointHealth.splice(i, 1);
        health.splice(i, 1);
      }
    }
    const firstHealthy = health.findIndex((h) => h === true);
    if (firstHealthy === -1) {
      // Archive verification is deliberately non-fatal for an outage. Publish
      // the real state and start recovery ourselves: paused consumers generate
      // no traffic that could otherwise move the breaker forward.
      this.allDown = true;
      this.advancesSinceSuccess = this.endpoints.length;
      this.startProbe();
      return { ok: false, block: 0, reason: `no reachable ${this.pool} endpoint (${this.endpoints.length} tried)` };
    }
    if (firstHealthy > 0) {
      this.active = firstHealthy;
      this.degradedSinceTs = Date.now();
      this.onEvent({ code: 'rpc.failover', msg: `${this.pool} primary unreachable at boot — starting on ${this.endpoints[firstHealthy].label}` });
      this.startProbe();
    }
    return { ok: true, block };
  }

  /** One primary probe round (the timer's body; exposed for tests). */
  async probeNow(): Promise<void> {
    if (this.probeInFlight || !this.endpoints.length) return;
    // Sitting on a healthy primary is the one state with nothing to probe.
    // `allDown` while active === 0 is NOT that state: it is the post-wrap
    // state above, where the primary is presumed dead and only a probe can
    // prove otherwise.
    if (this.active === 0 && !this.allDown) return;
    this.probeInFlight = true;
    try {
      if (this.allDown) {
        // A full rotation may recover on ANY endpoint. Probing only the primary
        // deadlocks a paused archive crawl when a backup comes back first.
        for (let i = 0; i < this.endpoints.length; i++) {
          const inspected = await this.inspectEndpoint(i, 'after recovery');
          if (inspected.health !== true) continue;
          this.active = i;
          this.failures = 0;
          this.allDown = false;
          this.advancesSinceSuccess = 0;
          this.degradedSinceTs = i === 0 ? undefined : (this.degradedSinceTs ?? Date.now());
          this.onEvent({ code: 'rpc.recovered', msg: `${this.pool} serving again (on ${this.endpoints[i].label})` });
          if (i === 0 || this.endpointHealth[0] === 'wrong-chain') this.stop();
          return;
        }
        return;
      }
      // A primary that was unreachable at boot is still untrusted. Chain-id
      // validation is part of every recovery probe, not just boot verification.
      const inspected = await this.inspectEndpoint(0, 'after recovery');
      if (inspected.health === true) {
        this.healthyProbes += 1;
        if (this.healthyProbes >= RECOVERY_PROBES) this.backOnPrimary();
      } else {
        this.healthyProbes = 0;
        if (inspected.health === false) this.stop(); // wrong-chain cannot heal in place
      }
    } finally {
      this.probeInFlight = false;
    }
  }

  /** Stop timers (shutdown/tests). */
  stop(): void {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = undefined; }
  }

  private advance(): void {
    const from = this.endpoints[this.active].label;
    let steps = 0;
    do {
      this.active = (this.active + 1) % this.endpoints.length;
      steps += 1;
    } while (steps < this.endpoints.length && this.endpointHealth[this.active] === 'wrong-chain');
    this.failures = 0;
    this.advancesSinceSuccess += steps;
    if (this.advancesSinceSuccess >= this.endpoints.length && !this.allDown) {
      this.allDown = true;
      this.onEvent({
        code: 'rpc.down',
        msg: this.endpoints.length === 1
          ? `${this.pool} endpoint unreachable (no backups configured) — chain data frozen until it recovers`
          : `${this.pool}: all ${this.endpoints.length} endpoints unreachable — chain data frozen until one recovers`,
      });
    }
    if (this.active === 0) {
      // cycled through every backup back to the primary — give it a fresh shot
      // silently (nothing recovered; the next SUCCESS announces recovery).
      this.degradedSinceTs = undefined;
      this.healthyProbes = 0;
      // KEEP probing. This used to stop() here, which was safe only because
      // every consumer retried forever and so generated the traffic that
      // clears `allDown`. The deep crawls now PAUSE while their pool is down
      // (they must — see the hole-skip note in live.ts), and a paused consumer
      // sends nothing, so without a probe of our own an all-down archive pool
      // could never recover: the crawls wait on `down`, `down` waits on a
      // request, and nobody makes one.
      this.startProbe();
      return;
    }
    if (this.degradedSinceTs === undefined) this.degradedSinceTs = Date.now();
    this.onEvent({ code: 'rpc.failover', msg: `${this.pool} failover: ${from} unhealthy — switched to ${this.endpoints[this.active].label}` });
    this.startProbe();
  }

  private backOnPrimary(): void {
    const wasOn = this.endpoints[this.active]?.label;
    const sinceTs = this.degradedSinceTs;
    this.active = 0;
    this.failures = 0;
    this.healthyProbes = 0;
    this.degradedSinceTs = undefined;
    this.stop();
    if (sinceTs !== undefined) {
      const mins = Math.max(1, Math.round((Date.now() - sinceTs) / 60_000));
      this.onEvent({ code: 'rpc.recovered', msg: `${this.pool} recovered: back on primary (was on ${wasOn} for ~${mins}m)` });
    }
  }

  private startProbe(): void {
    if (this.probeTimer) return;
    this.healthyProbes = 0;
    this.probeTimer = setInterval(() => { void this.probeNow(); }, this.probeIntervalMs);
    // never hold the process open for a health probe (tests, shutdown).
    this.probeTimer.unref?.();
  }

  /** Verify an endpoint before it serves traffic after being unreachable at
   *  boot. This runs through the raw endpoint, not the breaker, so a wrong-chain
   *  answer can never satisfy the caller's original request. */
  private async ensureChain(idx: number): Promise<void> {
    if (this.expectedChainId === undefined || this.endpointHealth[idx] === 'valid') return;
    if (this.endpointHealth[idx] === 'wrong-chain') throw new WrongChainEndpointError(`${this.endpoints[idx].label} is on the wrong chain`);
    const id = await this.endpoints[idx].request({ method: 'eth_chainId' });
    const chainId = Number(BigInt(String(id)));
    if (chainId !== this.expectedChainId) {
      this.markWrongChain(idx, chainId, 'after recovery');
      throw new WrongChainEndpointError(`${this.endpoints[idx].label} chainId ${chainId} != ${this.expectedChainId}`);
    }
    this.endpointHealth[idx] = 'valid';
  }

  /** Inspect chain identity first, then reachability/head. Sequential ordering
   *  is deliberate: if chainId answers wrong while blockNumber times out, the
   *  endpoint is still a known misconfiguration rather than an unknown outage. */
  private async inspectEndpoint(idx: number, when: string): Promise<{ health: boolean | undefined; block: number }> {
    if (this.endpointHealth[idx] === 'wrong-chain') return { health: false, block: 0 };
    try {
      const id = await this.endpoints[idx].request({ method: 'eth_chainId' });
      const chainId = Number(BigInt(String(id)));
      if (this.expectedChainId !== undefined && chainId !== this.expectedChainId) {
        this.markWrongChain(idx, chainId, when);
        return { health: false, block: 0 };
      }
      const bn = await this.endpoints[idx].request({ method: 'eth_blockNumber' });
      this.endpointHealth[idx] = 'valid';
      return { health: true, block: Number(BigInt(String(bn))) };
    } catch {
      return { health: undefined, block: 0 };
    }
  }

  private markWrongChain(idx: number, chainId: number, when: string): void {
    if (this.endpointHealth[idx] === 'wrong-chain') return;
    this.endpointHealth[idx] = 'wrong-chain';
    this.onEvent({
      code: 'rpc.endpoint.dropped',
      msg: `${this.pool} ${this.endpoints[idx].label} dropped ${when}: chainId ${chainId} != ${this.expectedChainId}`,
    });
  }
}
