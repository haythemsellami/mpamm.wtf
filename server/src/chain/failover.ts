import { HttpRequestError, TimeoutError } from 'viem';
import type { NoteCode } from '@shared';

/**
 * RpcBreaker — ordered-endpoint failover for the single shared RPC client.
 *
 * The whole indexer (quotes, fills, gas, backfills) rides one viem client, so
 * failover happens HERE and nowhere else: K consecutive transport-level
 * failures on the active endpoint advance to the next one (wrapping), and
 * while off the primary a background probe re-checks it every minute — two
 * consecutive healthy probes snap back. Preference is strictly ordered
 * (primary is the paid/better node); this is NOT latency ranking.
 *
 * Correctness hinges on the failure classifier: only transport-level errors
 * (5xx / network / timeout) may trip the breaker. A JSON-RPC error response —
 * reverts, "block range too large" (the adaptive chunkers probe ranges
 * constantly), rate-limit backoffs — proves the endpoint is ALIVE and must
 * never cause a switch. Mixed providers are safe by construction: nearly every
 * read is pinned to an explicit block number and tails run at head−5, so any
 * honest node returns identical data; a lagging backup surfaces as a retry and
 * the fail-closed cursors already absorb that.
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

/** Transport-level failure = the endpoint itself is unhealthy. 429 is excluded
 *  on purpose: throttled-but-alive must back off (viem's inner retry does),
 *  not bounce the whole indexer between endpoints under load. */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (e instanceof HttpRequestError) return e.status !== 429;
  return false;
}

const FAILURE_THRESHOLD = 3;   // consecutive transport failures before advancing
const PROBE_INTERVAL_MS = 60_000; // primary re-check cadence while degraded
const RECOVERY_PROBES = 2;     // consecutive healthy probes to snap back

export class RpcBreaker {
  private endpoints: BreakerEndpoint[] = [];
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

  constructor(opts?: { probeIntervalMs?: number }) {
    this.probeIntervalMs = opts?.probeIntervalMs ?? PROBE_INTERVAL_MS;
  }

  /** Bind the instantiated transports. Called once, before any traffic. */
  attach(endpoints: BreakerEndpoint[]): void {
    if (!endpoints.length) throw new Error('RpcBreaker: no endpoints');
    this.endpoints = endpoints;
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
        const res = await this.endpoints[idx].request(args);
        // any success proves the active endpoint serves — clear streak state.
        if (idx === this.active) this.failures = 0;
        this.advancesSinceSuccess = 0;
        if (this.allDown) {
          this.allDown = false;
          this.onEvent({ code: 'rpc.recovered', msg: `RPC serving again (on ${this.endpoints[this.active].label})` });
        }
        return res;
      } catch (e) {
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
  async verify(expectChainId: number): Promise<{ ok: boolean; block: number; reason?: string }> {
    const health: (boolean | undefined)[] = []; // true=healthy, false=wrong chain, undefined=unreachable
    let block = 0;
    for (const ep of this.endpoints) {
      try {
        const [id, bn] = await Promise.all([
          ep.request({ method: 'eth_chainId' }),
          ep.request({ method: 'eth_blockNumber' }),
        ]);
        const chainId = Number(BigInt(String(id)));
        if (chainId !== expectChainId) {
          health.push(false);
          this.onEvent({ code: 'rpc.endpoint.dropped', msg: `RPC ${ep.label} dropped at boot: chainId ${chainId} != ${expectChainId}` });
        } else {
          health.push(true);
          block = Math.max(block, Number(BigInt(String(bn))));
        }
      } catch {
        health.push(undefined);
      }
    }
    if (health[0] === false) return { ok: false, block: 0, reason: `primary is on the wrong chain (chainId != ${expectChainId})` };
    // drop wrong-chain backups (walk backwards so indices stay valid).
    for (let i = this.endpoints.length - 1; i >= 1; i--) {
      if (health[i] === false) { this.endpoints.splice(i, 1); health.splice(i, 1); }
    }
    const firstHealthy = health.findIndex((h) => h === true);
    if (firstHealthy === -1) {
      return { ok: false, block: 0, reason: `no reachable RPC endpoint (${this.endpoints.length} tried)` };
    }
    if (firstHealthy > 0) {
      this.active = firstHealthy;
      this.degradedSinceTs = Date.now();
      this.onEvent({ code: 'rpc.failover', msg: `RPC primary unreachable at boot — starting on ${this.endpoints[firstHealthy].label}` });
      this.startProbe();
    }
    return { ok: true, block };
  }

  /** One primary probe round (the timer's body; exposed for tests). */
  async probeNow(): Promise<void> {
    if (this.active === 0 || this.probeInFlight || !this.endpoints.length) return;
    this.probeInFlight = true;
    try {
      await this.endpoints[0].request({ method: 'eth_blockNumber' });
      this.healthyProbes += 1;
      if (this.healthyProbes >= RECOVERY_PROBES) this.backOnPrimary();
    } catch {
      this.healthyProbes = 0;
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
    this.active = (this.active + 1) % this.endpoints.length;
    this.failures = 0;
    this.advancesSinceSuccess += 1;
    if (this.advancesSinceSuccess >= this.endpoints.length && !this.allDown) {
      this.allDown = true;
      this.onEvent({
        code: 'rpc.down',
        msg: this.endpoints.length === 1
          ? 'RPC endpoint unreachable (no backups configured) — chain data frozen until it recovers'
          : `RPC: all ${this.endpoints.length} endpoints unreachable — chain data frozen until one recovers`,
      });
    }
    if (this.active === 0) {
      // cycled through every backup back to the primary — give it a fresh shot
      // silently (nothing recovered; the next SUCCESS announces recovery).
      this.degradedSinceTs = undefined;
      this.healthyProbes = 0;
      this.stop();
      return;
    }
    if (this.degradedSinceTs === undefined) this.degradedSinceTs = Date.now();
    this.onEvent({ code: 'rpc.failover', msg: `RPC failover: ${from} unhealthy — switched to ${this.endpoints[this.active].label}` });
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
      this.onEvent({ code: 'rpc.recovered', msg: `RPC recovered: back on primary (was on ${wasOn} for ~${mins}m)` });
    }
  }

  private startProbe(): void {
    if (this.probeTimer) return;
    this.healthyProbes = 0;
    this.probeTimer = setInterval(() => { void this.probeNow(); }, this.probeIntervalMs);
    // never hold the process open for a health probe (tests, shutdown).
    this.probeTimer.unref?.();
  }
}
