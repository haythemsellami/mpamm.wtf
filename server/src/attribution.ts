import type { PublicClient } from 'viem';
import type { Fill } from '@shared';
import { shortHex } from './util.js';
import type { VenueAdapter } from './venues/adapter.js';

/**
 * Fill attribution — turn an adapter's honest `UNKNOWN` into a provable label
 * by looking at what the transaction actually entered through (`tx.to`):
 *
 *   tx.to == the venue itself (adapter entryPoints, no router name) → DIRECT
 *   tx.to == the venue's own periphery (entryPoints with router name) → ROUTER + name
 *   tx.to == a known aggregator (registry below)                      → ROUTER + brand
 *   anything else (private searcher bots, unidentified contracts)    → stays UNKNOWN
 *
 * Evidence-based venue attribution is never touched: only fills that arrive
 * `UNKNOWN` are enriched, so an adapter with richer log-based labels (Clober's
 * router-gateway events) keeps them. Whenever the lookup succeeds, `to` is
 * rewritten to the tx INITIATOR (`tx.from`) — the event-level "recipient" many
 * venues expose is routing plumbing, not the taker.
 *
 * Cost + failure posture: one batched eth_getTransactionByHash per unique fill
 * tx (LRU-cached across passes — re-tails and multi-fill txs are free), and a
 * label is never load-bearing: a lookup failure leaves the fill exactly as the
 * adapter emitted it. This step must never throw into the fill pipeline.
 */

/** Known aggregator/router entry contracts on Monad → display brand.
 *  Every entry is verified (official docs, verified source, or a canonical
 *  cross-chain deployment) — see the provenance notes. Extend freely; an
 *  unlisted intermediary just stays UNKNOWN. */
export const KNOWN_ROUTERS: ReadonlyMap<string, string> = new Map([
  // Relay (relay.link) — cross-chain intent execution. RelayRouterV3 +
  // v3 ApprovalProxy, both in Relay's contract-addresses docs (same CREATE2
  // addresses across chains); their solver fills user intents through these.
  ['0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', 'Relay'],
  ['0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', 'Relay'],
  // KyberSwap MetaAggregationRouterV2 — canonical cross-chain address.
  ['0x6131b5fae19ea4f9d964eac0408e4408b66337b5', 'KyberSwap'],
  // 0x (ZeroEx) Settler AllowanceHolder — canonical cross-chain address.
  ['0x0000000000001ff3684f28c67538d4d072c22734', '0x'],
  // FastLane AuctionHandler (shMonad) — verified source on monadscan; MEV
  // auction flash-execution entry (dominant Metric flow in sampling).
  ['0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58', 'FastLane'],
  // LFJ routers on Monad mainnet (developers.lfj.gg deployment addresses):
  // LBRouter v2.2 + Router v1 — LFJ's own periphery, brand-labeled here since
  // it routes to more than the POE venue.
  ['0x18556da13313f3532c54711497a8fedac273220e', 'LFJ'],
  ['0x4face5b0ef2757ceb9151d14c036a1135931c70e', 'LFJ'],
]);

const LOOKUP_POOL = 12;   // concurrent tx lookups (batched by the transport anyway)
const CACHE_MAX = 4096;   // txHash → {to, from}; ~an hour of busy tape

export class FillAttributor {
  /** insertion-ordered Map as a cheap LRU (delete+set on hit refresh not
   *  needed — fills for one tx arrive together; we only evict oldest). */
  private cache = new Map<string, { to: string; from: string } | null>();

  constructor(
    private client: Pick<PublicClient, 'getTransaction'>,
    private adapters: readonly VenueAdapter[],
  ) {}

  /** Enrich UNKNOWN fills in place. Never throws; unresolved fills are left
   *  exactly as the adapter emitted them. */
  async attribute(fills: Fill[]): Promise<void> {
    const targets = fills.filter((f) => f.category === 'UNKNOWN');
    if (!targets.length) return;

    // venueId → entry map (lowercased address → router name | '' for direct),
    // rebuilt per pass: entry sets follow discovery/quarantine, and it's cheap.
    const venueEntries = new Map<string, Map<string, string>>();
    for (const a of this.adapters) {
      if (!a.entryPoints) continue;
      const m = new Map<string, string>();
      try {
        for (const e of a.entryPoints()) m.set(e.address.toLowerCase(), e.router ?? '');
      } catch { continue; } // pre-discovery — this pass just attributes less
      for (const v of a.venues()) venueEntries.set(v.id, m);
    }

    const hashes = [...new Set(targets.map((f) => f.txHash))].filter((h) => !this.cache.has(h));
    for (let i = 0; i < hashes.length; i += LOOKUP_POOL) {
      await Promise.all(hashes.slice(i, i + LOOKUP_POOL).map(async (h) => {
        for (let r = 0; r < 2; r++) {
          try {
            const t = await this.client.getTransaction({ hash: h as `0x${string}` });
            this.cache.set(h, { to: String(t.to ?? '').toLowerCase(), from: String(t.from).toLowerCase() });
            return;
          } catch { await new Promise((res) => setTimeout(res, 120 * (r + 1))); }
        }
        this.cache.set(h, null); // looked up and failed — don't retry this pass
      }));
    }
    // evict oldest entries beyond the cap (Map preserves insertion order).
    for (const k of this.cache.keys()) {
      if (this.cache.size <= CACHE_MAX) break;
      this.cache.delete(k);
    }

    for (const f of targets) {
      const tx = this.cache.get(f.txHash);
      if (!tx) continue;                       // lookup failed — honest UNKNOWN stays
      f.to = shortHex(tx.from);                // the initiator, not routing plumbing
      const entry = venueEntries.get(f.venueId)?.get(tx.to);
      if (entry !== undefined) {
        if (entry === '') { f.category = 'DIRECT'; continue; }
        f.category = 'ROUTER';
        f.router = entry;
        continue;
      }
      const brand = KNOWN_ROUTERS.get(tx.to);
      if (brand) {
        f.category = 'ROUTER';
        f.router = brand;
      }
    }
    // drop failed lookups so the next pass retries them.
    for (const [k, v] of this.cache) if (v === null) this.cache.delete(k);
  }
}
