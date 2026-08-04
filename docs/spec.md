# propAMM dashboard — design spec

The **venue-agnostic** design: what the system measures, the invariants it holds, and the contracts its parts agree on. No protocol is named here on purpose — concrete venues are plug-ins, and this document must stay true when they change. For the system **as built** (which venues, which feeds, which contracts) see [architecture.md](architecture.md); to add a venue see [adapters.md](adapters.md).

| | |
|---|---|
| **Scope** | Real-time dashboard for **propAMMs** on Monad mainnet |
| **Venue model** | composable adapter registry — one self-contained adapter per protocol |
| **Benchmark** | per base asset, a designated CEX reference **converted into each pair's own terms** (stable cross + wrapped/native basis) |

---

## 1. Summary

A read-only, real-time dashboard surfacing four primitives per **propAMM** venue: **historical filled volume**, **live execution quality** (realized cost vs the pair's CEX reference at a chosen notional), a **live fill tape with markouts**, and the **gas its own keeper burns keeping quotes fresh**. The venue set is a plug-in registry — each protocol ships one adapter; the rest of the system never hardcodes a venue.

**propAMM = maker/oracle-priced.** The dashboard is dedicated to venues where a market maker (or an oracle the maker anchors to) sets the price — not passive AMMs whose price emerges from a bonding curve, nor raw CLOBs. Qualifying *structures* include: an oracle-anchored pool quoting off a pushed fair price; an oracle-driven vault resting orders on an order book; a vault that quotes an order book just-in-time inside taker transactions. A permissionless book or curve where anyone's liquidity sets the price does not qualify — though a standard DEX may appear as a **baseline** (quote-only comparison band), never as a venue.

The defining architectural fact: **fills are events, quotes are not**. Landed trades arrive as logs you subscribe to; a live quote ("what would this size get right now") exists only by simulating against current state via an on-chain read. No subgraph or REST endpoint returns a fresh quote. That split drives the system — a streamed path for volume + tape, a polled path for execution quality.

Built as a **backend service** (D1): the service owns the RPC/CEX connections, aggregates once, and serves a thin frontend over its own API.

---

## 2. Goals / non-goals

**Goals**
- Per-venue daily filled volume in USD, UTC-day buckets, today partial — advanced **on-chain** (persist-forward indexer), with each venue's **lifetime** history replayed from its first active day.
- Per-pair live execution quality for an **HFT audience**: realized cost in bps vs executing the same size on the pair's CEX as taker (fee-inclusive on both legs, converted into pair terms), refreshed at block cadence — 100% like-for-like.
- A live, normalized fill tape + markouts across every venue.
- The venue's **own operating cost**: quote-update gas per day, measured from the chain.
- One normalized data model (`QuoteRow`, `Fill`) keyed by `venueId` so the frontend is venue-agnostic.
- A **composable venue layer**: any team adds a protocol via one adapter file + one registry line, zero core edits.

**Non-goals**
- No trade execution — strictly read-only. No wallet, no order placement.
- No chains other than Monad mainnet.
- No non-propAMM venues (passive curve DEXes, raw CLOBs) — except as quote-only baselines.
- Pair universe is registry-driven; quote legs are USD stables or registered assets — arbitrary token/token pairs without a constructible reference are out of scope.
- No deep per-maker analytics (league tables, PnL attribution across makers). Daily volume + gas are the persisted aggregates; fills are retained on a rolling window.

---

## 3. Product surface — the four tabs

Every tab renders purely from the venue registry (`state.venues`) — name, color, role and grouping come from `VenueMeta`, nothing hardcoded.

### 3.1 Execution
Rolling window (~60s) of live quotes per pair at a chosen notional, expressed as **realized cost in bps vs the pair's CEX reference**. For each pair × side × notional: (1) simulate the on-chain fill via the adapter's `quote()` — venue-fee-inclusive; (2) walk the pair's CEX book for the **same base size**, convert into the pair's terms, overlay the configured taker fee; (3) compare realized-vs-realized — the only honest comparison for size-sensitive flow. `filledFull=false` marks an exhausted pool/book (`PARTIAL`); `oneSided=true` marks a single executable side. An optional **baseline band** (`role: 'baseline'`) overlays a standard DEX's cost envelope — quote-only, default off, never ★. Reference chips default **on** so the benchmark stays visible during venue quote gaps.

### 3.2 Volume
Stacked daily-notional-by-venue. Each landed swap contributes the USD value of its **stable quote leg**, bucketed by UTC day; today's bucket is partial and ticks up live. Stable quote leg ⇒ **exact USD with no price oracle**, for both history and live. A per-venue summary (window totals, share, swaps) sits beside the chart.

**QUOTE_UPDATE_BURN** (same chart grammar, same selected window, no brush of its own): the MON each venue's **own keeper** spends keeping its quotes fresh — per-venue window totals, update-tx counts, and a burn-per-$1M-volume efficiency line. Monad charges **`gas_limit`** (receipts report `gasUsed == limit`), so cost is exactly `gasUsed × effectiveGasPrice`. Sources are **destination-keyed** per venue (adapter `gasSources()`): venues whose updates emit events are counted exactly; venues whose updates emit nothing are block-sampled and rendered as estimates (≈); a venue that does **not self-fund** its updates (external oracle, taker-paid JIT repricing) has **no series on purpose** — absence, never a fabricated zero.

### 3.3 Markouts
Live normalized fill tape + post-trade markouts: each fill's realized price vs its pair's CEX mid at T+{0,5,10,30,60}s, aging in as it crosses each horizon. Fills whose realized price is approximated (`pxApprox`) are excluded from markout stats rather than fabricating ~0 edge. Rows link to the explorer.

### 3.4 Leaderboard
Top groups/swaps over a selectable window (24H/7D/30D — markouts are a recent-execution-quality signal, not an all-time archive), filtered to fills with a real `execPx`. Stats are **aggregated server-side** (`/api/leaderboard`): the browser gets small TAKER-signed group rows (volume, swaps, markout percentiles, pool PnL, a cumulative-PnL sparkline) plus top winner/loser fills per horizon, and derives the MAKER view as a pure sign flip. Shipping raw fills would silently truncate the wide windows at any sane fetch cap.

---

## 4. Architecture

### 4.0 The adapter contract

`server/src/venues/adapter.ts` — each venue is one adapter:

```ts
interface VenueAdapter {
  venues(): VenueMeta[];                                  // 1+ display venues (id, name, color, kind, role, sinceUtc)
  discover(ctx): Promise<void>;                           // resolve pools/books; adapter holds its own state
  backfill?(ctx, sinceUtc): Promise<{ days?; fills? }>;   // optional historical seed
  backfillFromUtc?: string;                               // venue first-active day → core replays lifetime history
  quote?(ctx, sizesUsd): Promise<QuoteRow[]>;             // optional live bid/ask (Execution)
  logSources(): LogSource[];                              // { key, address, events, kind: 'fills'|'state'|'attribution' }
  gasSources?(): GasSource[];                             // where the venue's own quote-update txs live
  decode(ctx, logs, tsOf, failed): Fill[];                // adapter decodes ITS logs → fills
}
```

`AdapterContext` hands over shared infra: `client`, `getLogs` (chunked), `pricer` (incl. `pairMid(market)` — the bps anchor), `config`, `log`. The registry is the one wiring point; `validateRegistry()` fails loud on duplicate/invalid ids. A `ReferenceRegistry` (roles `'reference'`) owns every CEX feed, routed **per base asset** — venue adapters never talk to a CEX.

### 4.1 Quote poller
Each adapter's `quote()` collapses its request set into **Multicall3 `eth_call`s** per tick at block cadence, normalized to `QuoteRow[]` (bps vs `pairMid`), then annotated with the pair's CEX realized-vs-taker columns.

### 4.2 Fill stream
Each cycle the core fetches the union of every adapter's `logSources()` over the pending range and hands each adapter its logs to `decode()` → normalized `Fill`s. Fills carry a **deterministic id** (`venue-txHash-logIndex`) so re-tails dedupe; attribution sources (router tags) classify fills but never create them (no double-count).

### 4.3 Aggregation / state
- **Quote matrix** — latest rows in memory, replaced each poll, pushed to clients.
- **Volume bucketer** — folds fills into `DailyVolume.byVenue` per UTC day; today broadcast as deltas, closed days persisted. Swap counts from an exact SQL aggregate.
- **Markout aging** — join fills to their pair's mid history at each horizon; an earliest-mid guard prevents fabricating elapsed-unobserved horizons.
- **Gas tracker** — per-venue cursors accrue quote-update burn into `daily_gas`, committed **atomically with the cursor** (additive rows + a crash can never double-count).

### 4.4 History — persist-forward indexer + lifetime backfill
Public RPC endpoints cap `getLogs` ranges, so live mode is a **persist-forward indexer**: SQLite is the source of truth, loaded on boot, advanced forward from decoded fills, resumed from `lastProcessedBlock` with a same-day gap-fill.

- **Fail-closed ingest**: any error in a tail cycle — a `fills`/`state` log source, the block-timestamp lookup, an adapter `decode()` — **holds the global cursor** and retries the exact range; nothing advances, ingests, or emits partially. Daily volume + cursor + fills persist in one transaction (idempotent re-tail).
- **Venue-lifetime volume backfill**: the core replays each adapter's fill logs from its `backfillFromUtc` (first active day), yielding real per-day USD **and swap counts**. Off the boot path, adaptive `getLogs` chunks (auto-shrink on range errors; unreadable archive ranges are skipped **loudly**), paced, day-aligned resumable cursors, SET-per-day idempotent merges, closed days only.
- **Onboarding markout backfill**: once per venue, scan its recent fills with **real per-block timestamps** (markouts are a seconds-scale join) and mark them against **archived CEX prices** — the same pair-terms construction as the live reference. Bounded to the UI's widest window on purpose. An unpublished archive month defers and self-heals on a retry timer. Carry-forward lookups have a staleness cap: a print gap yields a **null** markout, never a fabricated one.
- **Gas history**: venue-lifetime, anchored on `sinceUtc` like volume; deepening a venue's start wipes + re-scans its series once (additive rows can't be extended in place).

### 4.5 The reference is in the pair's own terms
The deep CEX books are USDT-quoted and native-asset; on-chain pairs trade **wrapped assets in USD stables**. Both mismatches are real, live-priced markets — never assumed away:

```
refPx(pair) = <BASE>USDT px × wrapBasis(base) ÷ usdtCross(quote)
```

- **`usdtCross(quote)`** — the stable's `<STABLE>USDT` mid on the same exchange as the base feed. Stable/USDT bases run ~±10bps — larger than most spreads shown, so a $1-peg assumption would fabricate a systematic on-chain "edge". A stable that *is* USDT needs no cross; an unlisted stable stays peg-assumed with a ⚠ note.
- **`wrapBasis(base)`** — the wrapped/native mid where a live market exists; a wrapper with **no listed basis market** is parity-overridden with a ⚠ note (and gets its own pair symbols so it never marks against another wrapper's basis).
- **Asset-quoted pairs** (`quoteKind: 'asset'`): the quote leg is the quote *asset's* own USDT mid — a synthetic cross that may span two exchanges. An unwarm leg makes the pair unavailable rather than mis-marked.
- **Markouts mark per pair** against the converted mid (`midForPair`) — pairs sharing a base but differing in quote age against different, correct anchors. Taker walks stay on the deep books and convert at the cross mids (~1bp wide — far below the basis it removes).
- Benchmark taker fees are config constants at each exchange's top **published** tier; venue display names carry the tier.

---

## 5. Data model & API

```ts
VenueMeta   { id; name; color{light,dark}; kind:'amm'|'clob'|'vault'|'cex'; role:'venue'|'reference'|'baseline'; sinceUtc? }
QuoteRow    { venueId; market; sizeUsd; bidBps; askBps; bidPx; askPx; spreadBps; filledFull; oneSided?; feeBps; ts }
Fill        { id; venueId; market; side; category; usd; baseAmount; execPx; pxApprox?; txHash; to; pool; blockNumber; ts; markoutsBps[] }
DailyVolume { utcDay; partial; byVenue: Record<venueId, { usd; swaps }> }
GasDay      { utcDay; partial; byVenue: Record<venueId, { mon; txs }> }
```

Persisted (SQLite, **long format** — adding/removing a venue never changes the shape):

```
meta(key, value)                               -- schema/model versions + every cursor
daily_volume(utc_day, venue_id, usd, swaps)    -- PK (utc_day, venue_id)
day_meta(utc_day, partial)
fills(id, venue_id, …, markouts_bps)           -- upsert-by-id; rolling retention
mid_history(market, ts, mid)                   -- per-pair reference-mid curve
daily_gas(utc_day, venue_id, mon, txs)         -- additive; atomic with its cursor
```

`markout_model_version` gates a markout-model migration: retained fills keep volume/tape data; markouts are replayed from `mid_history` (when the stored curve is still a valid mark) or nulled — old-model and new-model bps never mix. A venue leaving the registry is pruned **non-destructively** on boot; only a true structural `schema_version` bump resets (venues re-backfill on-chain).

```
GET /api/venues                    the venue registry (VenueMeta[])
GET /api/markets                   state snapshot (incl. venues + public degradation notes)
GET /api/quotes                    latest quote matrix
GET /api/quotes/history            last ~60s of real ticks (chart seed — never fabricated history)
GET /api/volume?from=&to=          daily series
GET /api/fills?days=&limit=        recent fills (the tape)
GET /api/leaderboard?days=1|7|30   server-side aggregates
GET /api/gas                       quote-update burn series (+ approx venue ids)
WS  /stream                        channels: state, quotes, fill, volume
```

---

## 6. Key decisions

| # | Decision | Rationale / trade-off |
|---|---|---|
| **D1** | **Backend service**, thin frontend | One shared set of RPC/CEX connections; tip-accurate quoting needs a trusted node not exposed client-side; on-chain history needs one persistent writer. |
| **D2** | Venues = **composable adapter registry** | One file + one registry line per protocol; the core is venue-agnostic. Enables community PRs and keeps the model generic (`venueId`). |
| **D3** | Scope = **propAMM-only** | Maker/oracle-priced venues only; passive curve DEXes and raw CLOBs excluded by design (standard DEXes may appear as quote-only baselines). |
| **D4** | History = **persist-forward indexer + lifetime on-chain backfill** | SQLite is the source of truth; every venue's history replays from its first active day — listing date never truncates a venue's record. |
| **D5** | Sub-venue attribution = **on-chain tagging** | When a protocol's propAMM is a subset of a larger system (a vault on a public book), the tracked cut is identified from the protocol's own on-chain events — never inferred. |
| **D6** | Universe = **pair/asset registry** | Base assets, wrappers, stables and pairs are `@shared` registry entries; adapters are generic over base/quote and only registered pairs count. |
| **D7** | Benchmark = **per-asset reference, converted into pair terms** | Each base asset routes to a designated CEX feed; the USDT-quoted reference converts by the live stable cross and wrapped/native basis — never a $1 peg or wrap≡native assumption. Realized-vs-realized at size, taker fees at each exchange's top published tier. |
| **D8** | Honest absence over fabricated zero | A venue that doesn't self-fund quote updates has no gas series; an unmarked fill has null markouts; an unwarm reference hides the pair. Every degradation is a visible note, not a silent default. |

---

## 7. Reliability & operations

- **RPC requirements**: `eth_call` + `getLogs`. Public endpoints cap ranges ⇒ all range work chunks adaptively; a high-limit/archive node makes lifetime backfills practical.
- **Fail-closed indexing**: required-source failures hold the cursor; ticks are re-entrancy-guarded; discovery merges (never shrinks) its cache; `logSources()` throws until discovery is ready.
- **Boot**: live boot fail-fasts on a chain sanity check (chain id, Multicall3) so a supervisor restarts it. The simulator (`DATA_SOURCE=sim`) is the explicit offline mode — registry-driven, same contract, never a silent fallback.
- **Every long job is cursor-resumable** and commits atomically with its cursor — kills mid-scan never double-count.
- **Developer notes**: every degradation (starving feed, deferred archive, skipped ranges) is surfaced in `state.notes` as `{ ts, level, code, venue?, msg }`, sanitized so credentials never leak. Maintainer-facing telemetry, not rendered in the UI.
- **Deploy**: single container, one replica (single-writer SQLite + in-memory state), persistent disk. See [deploy.md](deploy.md).
