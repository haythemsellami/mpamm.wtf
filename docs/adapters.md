# Writing a venue adapter

The dashboard is **venue-agnostic**. Every venue — an on-chain AMM, a CLOB, a market-making vault — is a self-contained *adapter*. The indexer, database, API and frontend never mention a venue by name: they read everything (display name, color, per-day volume, fills, quotes, quote-update gas) from your adapter. **Adding a venue is one new file + one line in `registry.ts`. No core edits.**

Your data can be **fully on-chain**, from a **subgraph**, or a mix — the contract is only about the *shapes you return*, not where you get them.

The shipped adapters are the reference implementations (`server/src/venues/`):

- **`poe.ts`** / **`metric.ts`** — fully on-chain AMMs: discover pools via a factory/immutables read, quote via a view call, decode `Swap` logs. History seeded by the core's lifetime on-chain backfill (`backfillFromUtc`).
- **`clober.ts`** — mixed-source: subgraph for vault-book *discovery* only; quotes/fills/history all on-chain. Shows router attribution, mid-run book discovery, and multi-book markets.
- **`hanji.ts`** — fully on-chain LOB: a static market table *verified against each CLOB's on-chain config at discovery* (token layout, scaling factors, fees — nothing assumed), quotes via a helper view, fills = `OrderPlaced` events with an aggressive portion (realized VWAP, never the event's limit-price field).
- **`uniswap.ts`** — a `role: 'baseline'` adapter: QUOTE-ONLY (`logSources → []`). Baselines are standard-DEX comparison bands on the Execution page — never in volume/markouts/leaderboard, default-off, never ★.

## Quick start

1. `cp server/src/venues/_template.ts server/src/venues/myvenue.ts` and fill in the TODOs.
2. Register it in `registry.ts` (the editable list is `ALL_ADAPTERS`; the exported `ADAPTERS` is the `VENUES`-filtered view of it):
   ```ts
   import { createMyVenueAdapter } from './myvenue.js';
   const ALL_ADAPTERS: VenueAdapter[] = [ /* …existing… */, createMyVenueAdapter() ];
   ```
3. `npm -w server run typecheck`, then run it against the chain (see **Developing locally** below).

## The interface (`adapter.ts`)

```ts
interface VenueAdapter {
  venues(): VenueMeta[];                              // your display venue(s)
  discover(ctx): Promise<void>;                       // find markets/pools; hold your own state
  backfill?(ctx, sinceUtc): Promise<AdapterBackfill>; // OPTIONAL closed-day seed (subgraph/REST)
  backfillFromUtc?: string;                           // venue deploy day → core replays your logs for lifetime volume
  quote?(ctx, sizesUsd): Promise<QuoteRow[]>;         // OPTIONAL live bid/ask (Execution tab)
  logSources(): LogSource[];                          // contracts/events the core getLogs's for you
  gasSources?(): GasSource[];                         // OPTIONAL: where your own quote-update txs live (QUOTE_UPDATE_BURN)
  decode(ctx, logs, tsOf, failed): Fill[] | Promise<Fill[]>; // your logs → normalized fills
}
```

Everything you need is on `ctx` (`AdapterContext`) — **use it instead of importing globals**: `ctx.client` (viem), `ctx.getLogs` (range-chunked), `ctx.pricer` (`usdPerToken`/`tokenForUsd` for USD sizing; **`pairMid(market)`** = the pair's CEX reference mid in the pair's own terms — use it as the bps anchor when quoting), `ctx.config`, `ctx.log`.

**Only quote/emit REGISTERED pairs** (`@shared` `PAIRS`; check a combo with `pairFor(baseKey, stableSym)`). An unregistered market has no reference rows and no markout routing — the core drops it. Adding a pair/asset is a `@shared` registry entry (see **Scope & limits**).

## What to return

- **`VenueMeta`** — `{ id, name, color: { light, dark }, kind: 'amm'|'clob'|'vault', role: 'venue', sinceUtc }`. `id` is the stable key used as `Fill.venueId`/`QuoteRow.venueId` — lowercase kebab-case, unique across all adapters (validated at boot, fail-loud). `sinceUtc` = the venue's on-chain deploy / first-activity day: per-day UI views omit your venue before that date, and it anchors the gas-burn history.
- **Colors**: `color` is the single source of truth for your venue's lines/bars/swatches, per theme. Requirements: clearly distinct from every existing venue color **in both themes**, legible on both surfaces (light `#FCFBF8`, dark `#0A0C10`, ≥3:1 contrast), and distinguishable under color-vision deficiency simulation against its co-plotted neighbors (the venue palette + Binance gold). Expect reviewers to check this — propose a color and we'll validate.
- **`Fill`** — `{ id, venueId, market, side, category, usd, baseAmount, execPx, txHash, to, pool, blockNumber, ts, markoutsBps: [null×5] }`. Give `id` a **deterministic** value (`` `${venue}-${txHash}-${logIndex}` ``) so re-tails/gap-fills/restarts dedupe instead of double-counting. Leave `markoutsBps` null — the core ages them vs the reference. Set `pxApprox: true` if `execPx` isn't a real realized price (excluded from markout stats rather than fabricating ~0 edge).
- **`QuoteRow`** — bid/ask in **bps vs `ctx.pricer.pairMid(market)`**; px is quote-per-base. Set `oneSided: true` when only one side is executable at that size, `filledFull: false` when the book/pool exhausts before the full notional.
- **`gasSources()`** — declare WHERE your own keeper pays gas to keep quotes fresh; the tracker (`server/src/gas.ts`) owns cursors, venue-lifetime history and forward accrual. **Destination-keyed** (the contract that *receives* the update), so keeper/sender rotation never breaks tracking. Modes: `'logs'` when updates emit an event (`events` ABI or a raw `topic0` for an unverified contract — counts exact, cost receipt-sampled) and `'blocks'` when they don't (sampled block receipts — an estimate, rendered with ≈; only sound for a near-constant keeper cadence). Throw while discovery hasn't resolved the destination. **Omit the hook entirely if your venue doesn't self-fund updates** (external oracle, taker-paid JIT) — absence is the honest value.

## How the core uses you

- **Boot:** `discover()` once; `backfill()` (if present) seeds closed days; the background lifetime replay covers `backfillFromUtc → now` for volume + swap counts; the markout onboarding scans your last ~30 days of fills and marks them against archived CEX prices — you implement nothing for either.
- **Each tick:** the core fetches every `logSources()` entry over the new range and calls `decode()`; fills are deduped, bucketed into daily volume, and joined to the reference mid for markouts. `quote()` rows feed the Execution comparison.
- **Frontend:** `venues()` is served in `state.venues`; the UI renders your venue with zero client-side knowledge of it.

## Correctness rules (the ones that bite)

- **Log-source `kind` (failure handling):** `'fills'` (default) and `'state'` (decoding state, e.g. pool/book `Open`s) both **hold the block cursor** on a fetch failure — the tail cycle skips atomically and retries. `'attribution'` (labels only, e.g. router tags) is tolerated — the cursor advances and the fill carries degraded attribution. Don't mislabel state as attribution.
- **Discovery readiness:** if `discover()` must enumerate your fill/state contracts, `logSources()` must **throw** while that state is unavailable. Returning `[]` means "genuinely nothing to tail", never "discovery failed".
- **Decode is cursor-critical:** if `decode()` throws, the core holds the cursor and retries the whole range — use that for genuinely unsafe states. For one malformed log, catch locally and skip it so the indexer doesn't wedge.
- **Attribution is the core's job — emit `UNKNOWN`, never guess:** set `category: 'UNKNOWN'` unless you have log-level evidence (Clober's router-gateway events). The core attributor (`server/src/attribution.ts`) looks at what the tx entered through (`tx.to`) and upgrades UNKNOWN fills to `DIRECT` (tx.to is the venue itself), `Router - <venue>` (your own periphery) or `Router - <brand>` (the verified aggregator registry — extend it there). Declare your venue's taker entry contracts via the optional `entryPoints()` hook: addresses with no `router` name are the venue itself (DIRECT); with a name they're your periphery. Private/unidentified intermediaries stay UNKNOWN — that's the honest label.
- **Merge-safe discovery:** `discover()` re-runs periodically; make it **merge** into your cache, never replace, so a transient failure can't shrink the tailed set.
- **Multiple venues from one adapter** are fine (return several `VenueMeta`, tag each fill/quote with the right id) — the core validates that every emitted `venueId` was declared.
- **`backfill().fills`** are persisted and tape-visible; their **volume** must come from `backfill().days` (fills are not re-aggregated). Historical fills with null markouts stay excluded from markout stats — never fabricated from a much-later mid.

## Developing locally

```bash
npm install
# fastest adapter iteration loop: ONLY your venue, no heavy history jobs, scratch DB
VENUES=myvenue BACKFILL=off MARKOUT_BACKFILL=off GAS_METRIC=off \
DB_PATH=./data/scratch.db npm run dev
```

- `VENUES=<id,id>` filters the adapter registry — run just your venue against the chain (references stay on; the Execution comparison works).
- Every server script auto-loads a repo-root **`.env`** (`--env-file-if-exists=../.env`, already gitignored) — copy `.env.example` and put `RPC_HTTP_URL` there instead of exporting it per command.
- The default public RPC works for quotes + live fill tailing but caps `getLogs` ranges — set `RPC_HTTP_URL` to a higher-limit/archive node to exercise the lifetime backfill (`BACKFILL=on`, the default). Monad's docs list providers: https://docs.monad.xyz/tooling-and-infra/rpc-providers.
- `DATA_SOURCE=sim npm run dev` runs the offline simulator — your venue appears automatically (the sim is registry-driven). Good for UI wiring; **useless for decode correctness** — verify against the real chain.
- Watch `state.notes` on `/api/markets` (also shown in the UI footer): adapter errors, discovery failures and degradations surface there.

## Verifying your adapter (what review checks)

Run the live checklist — it exercises discovery, quoting, log decoding and unit math against the real chain and prints a report:

```bash
npm -w server run verify-adapter -- myvenue
```

Then hand-verify, once, on real data:

1. **Units**: pick a live fill, recompute `usd` / `baseAmount` / `execPx` by hand from the raw log (decimals and scaling are where every adapter bug lives — 8-decimal WBTC, share units, tick math).
2. **Cross-check vs the explorer**: the same tx on monadscan should show the same amounts.
3. **Quotes vs reality**: your bid/ask bps should bracket the pair's CEX mid sanely (a venue quoting ±2000bps off mid is a decode/scaling bug, not alpha).
4. **Fees**: read them from the chain (a config/view), don't hardcode a docs number.
5. **Fixtures**: record 2–3 real logs and add a decode test (see below) so the math is locked forever.

## Tests (required for new adapters)

Fixture-based decode tests run in CI (`npm -w server run test`, vitest). Record real logs from the chain (the verify script prints ready-to-paste fixtures) and assert the decoded `Fill` fields — `usd`, `baseAmount`, `execPx`, `side`, deterministic `id`. See `server/src/venues/__tests__/` for the pattern. No network in tests — fixtures only.

## PR checklist

(The PR template pre-fills this — [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md).)

- [ ] One adapter file + one `registry.ts` line (+ `@shared` pair/token entries if you add markets); no core edits.
- [ ] `venues()` meta: unique kebab-case `id`, both theme colors, `sinceUtc` = real first-activity day, `backfillFromUtc` set.
- [ ] Only registered pairs emitted; deterministic fill ids; `pxApprox` where realized price isn't real.
- [ ] Log sources classified (`fills`/`state`/`attribution`); `logSources()` throws pre-discovery if needed; discovery merges.
- [ ] `gasSources()` declared (or explicitly omitted with a comment saying who pays for quote updates and why it's not you).
- [ ] Fees read on-chain. Units hand-verified against a real fill + the explorer.
- [ ] Fixture decode tests added; `npm run typecheck` + `npm -w server run test` green.
- [ ] `npm -w server run verify-adapter -- <id>` output pasted into the PR.

Tell us in the PR: what kind of venue (AMM/CLOB/vault), how quoting works, who runs the quoting keeper, and links to docs/audits. If you'd rather send that brief and have us build the adapter — that works too (Hanji shipped that way).

## Scope & limits

Both **venues** and the **pair/asset universe** are registry-driven (`@shared`):

- A new **venue** on existing pairs = one adapter file + one `registry.ts` line.
- A new **pair** on an existing base/quote = one `PAIRS` entry (adapters pick it up at the next discovery).
- A new **base asset** = an `ASSETS` entry (CEX routing + symbols, optional wrap-basis symbol) + its wrapper in `TOKENS` + `PAIRS` entries. A new **quote stable** = a `TOKENS` entry (+ `usdtCross` where the CEX lists it).
- The CEX references live in the `ReferenceRegistry` (`reference.ts`, `role: 'reference'`) — one per base asset, converted into each pair's own terms ([architecture.md](architecture.md#the-reference-is-in-the-pairs-own-terms)). Venue adapters never talk to a CEX.
