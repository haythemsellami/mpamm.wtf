# Architecture

How the dashboard works end to end **as built** — which venues, which feeds, how quotes/fills/history flow, and what is persisted. The venue-agnostic design (invariants, contracts, decisions) lives in [spec.md](spec.md); for **adding a venue**, read [adapters.md](adapters.md); for hosting, [deploy.md](deploy.md).

## What counts as a propAMM

The dashboard is dedicated to venues where a **maker (or the oracle it anchors to) sets the price** — not passive AMMs whose price emerges from a bonding curve, and not raw CLOBs. Each tracked venue qualifies for a different structural reason:

- **LFJ POE** — LFJ's "Public Prop AMM": pools price off a ClapOracle that LFJ's keeper pushes **every block**; the pool exposes an executable, fee-inclusive `getQuote`. It prices like a maker desk, not a curve.
- **Metric** — an oracle-anchored bin AMM: each pool's `PriceProvider` feeds an oracle bid/ask and the router simulates swaps over binned liquidity around that price.
- **Clober** — Clober V2 is a general on-chain CLOB, but the tracked venue is its **LiquidityVault** (oracle-driven maker): `SimpleOracleStrategy` prices the vault's resting orders and a keeper repositions them every ~21s. The vault's books carry ~100% of Clober's lifetime volume, so the vault *is* the venue. Attribution is by **vault book id** (collected from `LiquidityVault.Open`); independent-maker flow on other books is excluded.
- **Hanji** — a fully on-chain LOB whose **entire passive side is the protocol's LP vault** (verified on-chain): quoting is JIT ("FastQuoter virtual liquidity") — the quote materializes, fills, and cancels inside each taker's transaction, priced off the vault's oracle.

**Not venues:** the CEX references (Bybit/Binance, `role: 'reference'`) and the Uniswap v4 **baseline** (`role: 'baseline'`) — a quote-only standard-DEX comparison band on the Execution page, default-off, never in volume/markouts/leaderboard. Passive curve DEXes (e.g. LFJ Liquidity Book) are out of scope by design.

## System shape

The defining fact: **fills are events, quotes are not.** Landed trades arrive as logs you subscribe to; a live quote ("what would $50k get right now") exists only by simulating against current state via an `eth_call`. That split drives everything — a streamed path for volume/tape, a polled path for execution quality.

```
                  ┌────────────────── Monad RPC (trusted node) ──────────────────┐
                  │   eth_call · Multicall3         getLogs (tail + history)      │
                  └──────┬──────────────────────────────┬────────────────────────┘
             poll @ block cadence               live fills │ + lifetime replay
                  ┌──────▼───────┐                  ┌──────▼───────┐
                  │ Quote poller │                  │ Fill stream  │   + gas tracker
                  │ adapter.quote│                  │ adapter.     │   (quote-update
                  │              │                  │ decode() over│    keeper txs)
                  │              │                  │ logSources() │
                  └──────┬───────┘                  └──────┬───────┘
               QuoteRow[]│                           Fill[]│
                         ▼                                 ▼
   ┌──── Registry-driven aggregation (venue-agnostic, keyed by venueId) ────┐
   │ in-mem quote matrix │ UTC-day volume buckets │ markouts vs pair mid    │
   │                     │ (SQLite)               │ (SQLite fills + curve)  │
   └────────────┬─────────────────────────────────────────┬────────────────┘
         REST snapshots │                            WS push │
                  ┌─────▼────────────────────────────────── ▼─────┐
                  │  web/  — [1] Execution [2] Volume [3] Markouts │
                  │          [4] Leaderboard  (reads state.venues) │
                  └───────────────────────────────────────────────┘

   Bybit WS (MON + crosses) · Binance WS (BTC/ETH + crosses + WBTCBTC) ─► pair-terms references
```

One Node service owns every external connection and serves a thin frontend over its own REST + WS API (single-service decision: tip-accurate quoting needs a trusted node that isn't exposed client-side, and history needs one persistent writer). Two `DataSource` implementations share the exact same contract: **live** (Monad RPC + CEX feeds) and **sim** (a registry-driven simulator for offline dev, `DATA_SOURCE=sim`).

## Workspaces

| Path      | What |
|-----------|------|
| `shared/` | The contract: `QuoteRow` / `Fill` / `DailyVolume` / `GasDay` / `MarketState` types (keyed by `venueId`), and the `PAIRS` / `ASSETS` / `TOKENS` registries with verified addresses. |
| `server/` | Node + TS service: `DataSource` (live/sim), the venue-adapter registry, CEX reference feeds, aggregation, SQLite, REST/WS. |
| `web/`    | Vite + React frontend. Four tabs rendering purely off the API — venues and pairs are never hardcoded client-side. |

## Quote poller (Execution tab)

Quotes and the fills tail run as **independent self-scheduling loops** (`QUOTE_INTERVAL_MS` / `TAIL_INTERVAL_MS`, default 500ms each): the next pass starts as soon as the previous finishes, floored at the interval — cadence is `max(interval, pass duration)`, never rounded up to interval multiples, and log tailing can't stretch quote freshness. Each adapter's `quote()` collapses its per-market/size reads into **Multicall3 `eth_call`s** (POE `getQuote`, Metric `quoteSwap`, Clober `getExpectedOutput`, Hanji's book-assembly helper, Uniswap `quoteExactInputSingle`). Rows are normalized to `QuoteRow[]` in **bps vs the pair's reference mid**, then annotated with the CEX realized-vs-taker columns — the CEX book is walked for the **same base size** with the taker fee overlaid: realized-vs-realized at size, the only honest comparison for size-sensitive flow. `filledFull=false` marks an exhausted pool/book (`PARTIAL` tag); `oneSided=true` marks a book with only one executable side.

## Fill stream (tape, volume, markouts)

Each tick the core fetches every adapter's `logSources()` over the pending block range and hands each adapter its logs to `decode()` into normalized `Fill`s. Fills are deduped by deterministic id (`venue-txHash-logIndex`), bucketed into per-venue UTC-day volume, and joined to their **pair's** CEX mid for 0/5/10/30/60s markouts. Because every tracked pair quotes in a USD stable, the stable leg *is* the USD value — exact, no price oracle.

**Fail-closed ingest**: a failed fill/state log fetch, block-timestamp lookup, or adapter `decode()` **holds the global cursor** and retries the exact range — nothing advances or ingests partially. Daily volume + cursor + fills persist in one transaction, so a crash can never let a gap-fill double count.

## History: persist-forward indexer + venue-lifetime backfill

SQLite is the source of truth. On boot the service loads persisted days + the `lastProcessedBlock` cursor; a same-day restart gap-fills `getLogs` from the cursor to the tip. Deep history comes from the **background on-chain backfill**: each adapter's fill logs are replayed from its `backfillFromUtc` (the venue's deploy / first-activity day), yielding real per-day USD **and swap counts** for the venue's whole life. The replay runs off the boot path, in adaptive `getLogs` chunks (auto-shrink on range errors, hole-skipping with loud notes for unreadable archive ranges), paced under RPC limits, resumable across restarts (`backfill_cursor_*` / `backfill_done_*` metas), and writes closed days only — the live tail owns today.

**Onboarding markouts come free**: when a venue first appears, the core scans its last ~30 days of fills with real per-block timestamps and marks them against **archived CEX prices** (Bybit monthly trade dumps at 1s, Binance 1s klines — the same pair-terms construction as the live reference). A month whose archive isn't published yet defers and self-heals on a 6-hourly retry timer. A new venue's Markouts/Leaderboard tabs start populated, not empty.

## QUOTE_UPDATE_BURN (quote-update gas)

The Volume tab's second panel tracks the MON each venue's **own keeper** spends keeping its quotes fresh. Monad charges **`gas_limit`** (receipts report `gasUsed == limit`), so a tx's cost is exactly `gasUsed × effectiveGasPrice`. Sources are **destination-keyed** per venue (adapter `gasSources()`, see [adapters.md](adapters.md)); `server/src/gas.ts` owns cursors, the venue-lifetime first scan (same anchor as the volume backfill), and real-time forward accrual into `daily_gas` — committed atomically with the cursor so a crash never double-counts. Two modes: `'logs'` (updates emit an event — exact counts, receipt-sampled cost) and `'blocks'` (no events — sampled `eth_getBlockReceipts`, an estimate served in `GET /api/gas` `approx` and rendered with ≈). A venue that doesn't self-fund its updates (external oracle, taker-paid JIT) has **no series on purpose** — absence, not a fabricated zero.

## The reference is in the pair's own terms

The deep CEX books are USDT-quoted and native-asset; the on-chain pairs trade **wrapped assets in USD stables**. Both mismatches are real, live-priced markets — never assumed away:

```
refPx(pair) = <BASE>USDT px × wrapBasis(base) ÷ usdtCross(quote)
```

- **`usdtCross(quote)`** — the stable's `<STABLE>USDT` mid on the same exchange as the base feed (e.g. `USDCUSDT`). The USDC/USDT basis runs **~±10bps** — larger than most spreads shown, so a $1-peg assumption would fabricate a systematic on-chain "edge". `USDT0` needs no cross (it *is* Tether's USDT on Monad); unlisted stables (AUSD) stay peg-assumed with a ⚠ note.
- **`wrapBasis(base)`** — the wrapped/native mid for wrapped assets (Binance `WBTCBTC`, ~−5bps live), so the CEX line is like-for-like with the WBTC that actually trades on-chain. **cbBTC pairs are parity-overridden** (no CEX lists cbBTC/BTC; Coinbase 1:1 mint/redeem) — which is why Hanji's BTC markets are distinct `cbBTC/*` symbols rather than sharing `BTC/USDC`.
- **Asset-quoted pairs** (`Pair.quoteKind: 'asset'`, e.g. MON/ETH): the quote leg is the quote *asset's* own USDT mid — a synthetic cross that may span two exchanges (Bybit MON ÷ Binance ETH). An unwarm leg makes the pair unavailable rather than mis-marked.
- **Markouts mark per pair** against the converted mid (`midForPair`), so MON/USDC and MON/USDT0 fills age against different, correct anchors. Taker walks stay on the deep USDT books and convert at the cross mids (cross books are ~1bp wide — far below the ~10bp basis this removes).
- Routing: Bybit `MONUSDT` for MON (Binance lists no MON spot), Binance `BTCUSDT`/`ETHUSDT` for BTC/ETH, via the geo-unrestricted mirrors. Benchmark taker fees are config constants at each exchange's top published tier (Bybit Supreme VIP **4.5 bps**, Binance VIP9 **2.25 bps** — `TAKER_BPS` / `BINANCE_TAKER_BPS`).

## Data model & API

```ts
VenueMeta   { id; name; color{light,dark}; kind:'amm'|'clob'|'vault'|'cex'; role:'venue'|'reference'|'baseline'; sinceUtc? }
QuoteRow    { venueId; market; sizeUsd; bidBps; askBps; bidPx; askPx; spreadBps; filledFull; oneSided?; feeBps; ts }
Fill        { id; venueId; market; side; category; usd; baseAmount; execPx; pxApprox?; txHash; to; pool; blockNumber; ts; markoutsBps[] }
DailyVolume { utcDay; partial; byVenue: Record<venueId, { usd; swaps }> }
GasDay      { utcDay; partial; byVenue: Record<venueId, { mon; txs }> }
```

Persisted (SQLite, long format — adding/removing a venue never changes the shape; a venue leaving the registry is pruned non-destructively on boot):

```
meta(key, value)                               -- schema/model versions + every cursor
daily_volume(utc_day, venue_id, usd, swaps)    -- PK (utc_day, venue_id)
day_meta(utc_day, partial)
fills(id, venue_id, …, markouts_bps)           -- upsert-by-id; rolling retention
mid_history(market, ts, mid)                   -- per-pair reference-mid curve (markout-model replays)
daily_gas(utc_day, venue_id, mon, txs)         -- QUOTE_UPDATE_BURN; additive, atomic with its cursor
```

`markout_model_version` gates a markout-model migration: retained fills keep volume/tape data and their markouts are replayed from `mid_history` (when the stored curve is still a valid mark) or nulled — old-model and new-model bps never mix.

REST + WS contract (the frontend renders purely off these):

```
GET /api/health                    liveness (mode + block) — deploy health checks hit this
GET /api/venues                    the venue registry (VenueMeta[])
GET /api/markets                   state snapshot (incl. venues + notes)
GET /api/quotes                    latest quote matrix
GET /api/quotes/history?market=&size=   last ~60s of real ticks (chart seed)
GET /api/volume?from=&to=          daily series (DailyVolume.byVenue)
GET /api/fills?days=&limit=        recent fills (the tape)
GET /api/leaderboard?days=1|7|30   server-side aggregated leaderboard/markout stats
GET /api/gas                       QUOTE_UPDATE_BURN series (+ approx venue ids)
WS  /stream                        channels: state, quotes, fill, volume
```

The leaderboard aggregates server-side on purpose: shipping raw fills truncated the 7/30-day windows at any sane fetch cap. The browser gets small TAKER-signed group rows and derives the MAKER view as a pure sign flip.

## Operations & reliability

- **RPC requirements**: `eth_call` + `getLogs` + `eth_getBlockByNumber` + `eth_getBlockReceipts` + `eth_getCode`. Historical logs, headers and receipts are needed, and so — in exactly one place — is historical **code state**: `GasTracker.creationBlock()` bisects `eth_getCode` from block 0 to date a quote-update destination's deployment. Nothing else needs it; every other block-pinned read pins the CURRENT head, for intra-poll consistency. Concretely: the volume backfill replays from each venue's deploy day, `blockAtOrAfter` binary-searches from block 0, and the gas tracker crawls receipts from `gas_from` and dates its destinations with `eth_getCode`. Public endpoints cap `getLogs` (~100 blocks) — fine for the live tail, slow for deep backfills; a high-limit archive RPC makes venue-lifetime scans practical. All chunking is adaptive.
- **Two RPC pools** (`server/src/chain/rpc.ts`): the hot path and the deep crawls want opposite things from a node, so they get separate clients. **HOT** (`RPC_HTTP_URL` + `RPC_HTTP_BACKUP_URLS`) serves the quote loop and the fills tail, where only distance to the tip matters — a node seven blocks behind quotes 2.3s-old prices and nothing downstream can recover that. **ARCHIVE** (`RPC_ARCHIVE_URL` + `RPC_ARCHIVE_BACKUP_URLS`) serves the volume backfill, markout onboarding, gas passes and `blockAtOrAfter`, where lag is irrelevant and retention is everything — tip-fresh fullnodes typically prune to a couple of days. It must meet the full requirement list above, historical `eth_getCode` included; the public endpoint does NOT, which is why the archive pool ships with no default backup. Leave `RPC_ARCHIVE_URL` unset and the archive client *is* the hot client (the pre-split single-node behavior, unchanged).
- They are separate pools rather than one ordered list because **failover cannot bridge them**: a pruned block answers with a JSON-RPC error, and the classifier deliberately never switches on those, so a pruning primary with an archive backup would stall every deep cursor forever while the endpoint that could serve it sat idle. A half-configured archive (backups, no primary) is rejected at boot for the same reason — it would look configured while doing nothing.
- **RPC failover** (`server/src/chain/failover.ts`): each pool rides its own breaker in front of its ordered endpoint list. Three consecutive **transport-level** failures switch endpoints — JSON-RPC errors and 429s never do (reverts and range-cap probes prove the node is alive) — and a 60s probe snaps back to the primary after two healthy checks. Mixed providers are safe because reads are block-pinned and tails run at head−5. While the archive pool is degraded, deep crawls hold losslessly; while the hot pool is, quotes/fills/gap-fill keep running on the backup. The TopBar's amber/red `RPC` chip reflects the **hot** pool only; archive health is exposed as `state.rpcArchive` and both pools record every transition in `state.notes`, naming the pool (labels only — URLs embed keys).
- **Fail-loud registry**: duplicate/invalid venue ids throw at startup; fills/quotes for undeclared venue ids are dropped with a public note, never silently stored.
- **Boot sanity**: live mode fail-fasts on chain id 143 + Multicall3 presence rather than half-starting — but a dead primary with a healthy backup boots degraded instead of failing; wrong-chain backups are dropped loudly, a wrong-chain primary stays fatal. The ARCHIVE pool is verified too, with a deliberate split: an **unreachable** archive is NOT fatal — deep crawls are background work whose cursors hold on failure, so it costs history that resumes later, while refusing to boot would also take down live quoting, which needs no history at all. A **wrong-chain** archive primary IS fatal, because it answers successfully: the breaker can never fail away from it (only transport errors switch endpoints) and the deep crawls would persist another chain's logs as ours. Wrong history cannot be unmixed; missing history heals.
- **Self-healing discovery**: every adapter's `discover()` re-runs periodically (default 10 min) and must merge, never replace, its cache.
- **Developer notes**: `state.notes` (on `/api/markets`, and the same lines on stdout) carries every degradation and lifecycle event — starving reference feeds, deferred archives, skipped RPC holes, held cursors. Each entry is `{ ts, level, code, venue?, msg }` (`@shared`: `StateNote`), so a consumer filters on `level` or a `code` prefix instead of parsing prose. Messages are sanitized (URLs stripped) so a private RPC key can never leak. The served window is capped, charging overflow to the noisiest subsystem so one chatty crawl cannot evict the note that explains an incident. This is a maintainer/contributor channel: the dashboard does not render it.

## Where addresses & ABIs live

Contract addresses and event signatures are **in code, next to their use** — not duplicated here where they'd drift: token/pair registries and Clober core addresses in [`shared/src/index.ts`](../shared/src/index.ts), Clober ABIs in [`server/src/chain/abis.ts`](../server/src/chain/abis.ts), and each venue's contracts at the top of its adapter in [`server/src/venues/`](../server/src/venues/). Everything is verified on-chain before shipping.
