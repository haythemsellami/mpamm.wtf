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
  // LFJ routers on Monad mainnet (developers.lfj.gg deployment addresses):
  // LBRouter v2.2 + Router v1 — LFJ's own periphery, brand-labeled here since
  // it routes to more than the POE venue.
  ['0x18556da13313f3532c54711497a8fedac273220e', 'LFJ'],
  ['0x4face5b0ef2757ceb9151d14c036a1135931c70e', 'LFJ'],
  // ERC-4337 EntryPoints (canonical cross-chain addresses, verified live on
  // Monad) — bundler-submitted USER operations: smart-account users swapping.
  // Observed callers are 0x4337…-vanity bundler EOAs.
  ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', 'ERC-4337'], // v0.6
  ['0x0000000071727de22e5e9d8baf0edac6f37da032', 'ERC-4337'], // v0.7
  // Bungee (Socket) — intent/RFQ solver-side executor ("RFQVaultExecutor",
  // verified source). Provenance: deployer/solverSigner 0xF76e737…C34Bd5 is
  // Socket's Bungee solver signer across chains (explorer-tagged "Socket:
  // Bungee Solver" contracts share it), and the source carries Socket codebase
  // signatures (RescueFundsLib, FulfilExec/fulfil). Observed filling through
  // the Metric pAMM.
  ['0x97caca78ac2a94c67643d07843f85afaa44a3ea5', 'Bungee'],
]);

/** MEV auction/bundle infrastructure → brand. These are NOT routers: the
 *  entry contract sells priority execution (bid forwarded to validators) and
 *  the inner swap is the winning searcher's own flow — labeled category MEV,
 *  "MEV - <brand>" in the tape. Traced example: FastLaneAuctionHandler
 *  (verified source; bid → shMonad 0x1B68626d…) wrapping a flash-loan MON arb
 *  that fills on Metric.
 *
 *  ADMISSION RULE: only SEARCHER-ONLY entrypoints belong here — verify the
 *  contract exposes no user-facing swap/route/user-op function before adding
 *  (AuctionHandler: flashExecutionBid/bidWrapper only; census 120/120 recent
 *  entry txs = one bid selector). A user-op bundler that wraps REAL user flow
 *  (e.g. FastLane's Atlas EntryPoint) must NOT be added wholesale — it would
 *  MEV-label user swaps and needs selector-level gating instead. Users on
 *  FastLane's protect-RPC are unaffected either way: their tx.to stays the
 *  aggregator/pool they called (bundling is relay-level, not calldata-level). */
export const KNOWN_MEV: ReadonlyMap<string, string> = new Map([
  ['0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58', 'FastLane'],
  // "Kubera" — private multichain searcher (their own codename, from the
  // executor's revert strings; no public identity exists). Executor deployed
  // on Monad 2025-11-24 (block 37,740,451) and at the SAME address on
  // Arbitrum/Scroll/Polygon/Optimism/BNB/Blast/Ethereum; deployer + sole
  // caller is the operator wallet below. Admission rule holds: unverified
  // arb-only executor, caller==deployer, no user-facing entrypoints.
  ['0x415669455d93b755efe7f20ef6f1dbdce7f68f7d', 'Kubera'],
  // Three private Monad-only searcher executors — no public identity, so each
  // is named for its executor (the Kubera precedent). Evidence common to all,
  // all re-checkable with one eth_call: unverified with no explorer name tag,
  // no cross-chain twin (11 chains checked), and a CALLER ALLOWLIST that
  // makes user entry impossible — replaying one of their own real txs from a
  // non-allowlisted `from` reverts Unauthorized, so the admission rule holds
  // by construction rather than by selector census alone. They are also
  // already MEV-labeled here whenever they win FastLane's PFL auction: most of
  // their flow enters via the AuctionHandler above, driven by the SAME
  // operator EOAs, and those EOAs send to nothing but FastLane and their own
  // executor. These entries just close the direct-submission half.
  //
  // 0x5530… — ERC-1967 proxy (impl 0x7a35a006…, owner == deployer 0x22c6a8b7…).
  // Dispatch is searcher-only: executor-gated `execute(bytes)`, FastLane's
  // `fastLaneCall` + `setPFLAuctionAddress`, DEX swap callbacks (uniswapV3 /
  // algebra / pancakeV3 / metricOmm) and owner withdrawals — no user-facing
  // swap/route/user-op entry. Census: 1673/1673 entry txs over ~8.5h were
  // `execute(bytes)`, from exactly the four EOAs that read
  // `approvedExecutors(addr) == true`; 44% revert outright (lost races).
  ['0x553037bac82741e7ca05afb48e8538996fd70eca', 'Searcher 0x5530'],
  // 0x2ee2… — ERC-1967 proxy (impl 0xf83a2347…, owner == deployer == sole
  // caller 0x000e4334…). Same shape: one unnamed executor-gated selector,
  // `setExecutor`/`executors` allowlist, `onMorphoFlashLoan`, `fastLaneCall`,
  // owner-only `withdrawToken`/`withdrawETH`. Census: 322 entry txs over ~8.5h
  // = 320 of that one selector + 2 `withdrawToken` (the owner sweeping
  // proceeds — a router has no such tx); 84% revert.
  ['0x2ee25bbbd6795f058876eb206c98f8a55b149d14', 'Searcher 0x2ee2'],
  // 0x53d7… — plain (non-proxy) executor, sole caller 0x826e1446…, never seen
  // via FastLane: direct submission only. `addExecutor`/`removeExecutor` gate
  // one unnamed entry selector (24/24 entry txs), alongside DEX callbacks and
  // owner withdrawals. Its own revert strings name the trade it is doing —
  // "Insufficient profit", "No hops", "Unknown hop type", "Unauthorized".
  ['0x53d7071e15121fd2f81958fa2899f6a0f66261fb', 'Searcher 0x53d7'],
]);

/** Searcher OPERATOR wallets → brand, matched against tx.FROM as the LAST
 *  resort (only when tx.to matched nothing). An EOA cannot carry another
 *  user's flow, so from-matching can never mislabel user swaps — and it
 *  survives executor-contract rotation. Admission: the EOA must be the
 *  proven deployer/sole caller of a KNOWN_MEV executor. */
export const KNOWN_MEV_OPERATORS: ReadonlyMap<string, string> = new Map([
  ['0x256efafed786d24163bedf15d583ea5dbdb4757c', 'Kubera'],
  // Operator EOAs of the three executors above, kept so a rotated executor
  // contract still lands labeled. Each is tied to its executor on-chain: the
  // four 0x5530… wallets read `approvedExecutors(addr) == true` (0x22c6a8b7…
  // is also deployer+owner), 0x000e4334… is 0x2ee2…'s deployer+owner+sole
  // caller, and 0x826e1446… is 0x53d7…'s sole caller (that executor exposes no
  // allowlist view, so sole-caller is the proof). Checked for user flow before
  // listing: over an hour of blocks every one of them sent to nothing but the
  // FastLane AuctionHandler or its own executor. 0x5530…'s four wallets rotate
  // through one bot — exactly what the from-fallback exists to survive.
  ['0x22c6a8b73641e9a1e8066a01c71c388e52230659', 'Searcher 0x5530'],
  ['0x8f1661673adb1b4524ee3436d2cb66e2ff0b6845', 'Searcher 0x5530'],
  ['0x66cbc7e161c4683e48decd13ee1f4495ea848e18', 'Searcher 0x5530'],
  ['0x62fd55d9d8bb20f19984b56bfec4f49a5c20f1ab', 'Searcher 0x5530'],
  ['0x000e4334baea5ed508919eb74845f8557e942ccc', 'Searcher 0x2ee2'],
  ['0x826e1446245a0ab5b24888b407dfeb47a4d5749d', 'Searcher 0x53d7'],
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
        continue;
      }
      const mev = KNOWN_MEV.get(tx.to);
      if (mev) {
        f.category = 'MEV';
        f.router = mev;
        continue;
      }
      const op = KNOWN_MEV_OPERATORS.get(tx.from);
      if (op) {
        f.category = 'MEV';
        f.router = op;
      }
    }
    // drop failed lookups so the next pass retries them.
    for (const [k, v] of this.cache) if (v === null) this.cache.delete(k);
  }
}
