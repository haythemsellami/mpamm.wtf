# Agent guide — mpamm.wtf

Real-time propAMM dashboard for Monad. Monorepo: `shared/` (types + pair/token registries), `server/` (Node/TS indexer + API, SQLite via `node:sqlite`), `web/` (Vite + React). Everything is keyed by `venueId` — venues live ONLY in `server/src/venues/` adapters; the core and frontend never hardcode one.

## Commands

```bash
npm run dev                      # live backend :8787 + Vite :5173 (DATA_SOURCE=sim for offline)
npm run typecheck                # all workspaces — run after every change
npm -w server run test           # vitest (fixture-based decode tests; no network)
npm run build                    # frontend build
npm -w server run verify-adapter -- <venueId>   # live on-chain adapter checklist
VENUES=<id> BACKFILL=off MARKOUT_BACKFILL=off GAS_METRIC=off npm run dev   # single-adapter dev loop
```

Node ≥ 22 required (`node:sqlite`). The backend needs `API_PORT` free (default 8787); a stale `tsx watch` process is the usual cause of EADDRINUSE.

## The task most contributors have: add a venue adapter

Follow **[docs/adapters.md](docs/adapters.md)** exactly — interface, correctness rules, verification, PR checklist. The non-negotiables:

- One new file in `server/src/venues/` + one line in `registry.ts`. **No core edits.**
- Emit only REGISTERED pairs (`@shared` `PAIRS`, check with `pairFor`); unregistered markets are dropped.
- Deterministic fill ids (`venue-txHash-logIndex`) — dedup across re-tails depends on it.
- Throwing is load-bearing: `logSources()`/`decode()` throw ⇒ the block cursor HOLDS and retries (fail-closed). Never swallow an error that would silently undercount fills; never throw for one malformed log (skip it locally).
- `discover()` must MERGE into adapter state, never replace it (it re-runs every 10 min).
- Verify units on the real chain before claiming done: recompute one fill's `usd`/`baseAmount`/`execPx` by hand from the raw log; decimals/scaling are where every adapter bug lives.
- Add fixture decode tests (`server/src/venues/__tests__/`) — real recorded logs, no network.

## Conventions & gotchas

- **Comments explain constraints, not narration.** Match the existing density/voice — most files open with a "why it is this way" header comment.
- **Monad gas rule**: the chain charges `gas_limit`, and receipts report `gasUsed == limit`. `receipt.gasUsed × effectiveGasPrice` is the exact MON charged; real execution gas is unavailable via RPC.
- **References are pair-terms** ([docs/architecture.md](docs/architecture.md#the-reference-is-in-the-pairs-own-terms)): never compare an on-chain USDC price to a raw USDT CEX price; use `ctx.pricer.pairMid(market)` as the bps anchor.
- **SQLite schema is long-format** (`(utc_day, venue_id)` rows) — venue changes never alter the shape. Additive migrations only (`CREATE TABLE IF NOT EXISTS` / PRAGMA-guarded `ALTER`); bumping `SCHEMA_VERSION` wipes prod history on deploy, so treat it as a last resort.
- **Cursors commit atomically with their data** (one transaction) everywhere — volume, fills, gas. Keep that invariant in anything new; it's what makes every background job crash-safe and restart-resumable.
- **`state.notes` is developer-facing telemetry** (`/api/markets` plus stdout, never the dashboard UI). Each note is `{ ts, level, code, venue?, msg }` (`@shared`: `StateNote`). Raise one with the code that matches the event (`ctx.note(code, msg)` in an adapter, `note`/`noteOnce` in the core); the buffer stamps the time, takes the level from the code (`NOTE_LEVEL`), strips URLs so an RPC key can never leak and drops a verbatim repeat.
- **Two RPC clients, and the choice is not cosmetic** (`server/src/chain/rpc.ts`): `publicClient` is the HOT pool (quote loop, fills tail — chosen for distance to the tip) and `archiveClient` is the DEEP pool (volume backfill, markout onboarding, gas, `blockAtOrAfter` — chosen for retention). Anything that reads a block more than ~a day old MUST use `archiveClient` (the archive contract is logs/headers/receipts at any depth **plus** historical `eth_getCode`, which `GasTracker.creationBlock()` bisects from block 0); the tip-freshest nodes are pruning fullnodes and a deep read on the hot pool returns a JSON-RPC error, which by design never trips failover — the cursor just holds forever. Unset `RPC_ARCHIVE_URL` makes them the same client, so the default is the old single-node behavior.
- The public Monad RPC caps `getLogs` to ~100 blocks; all range work must chunk adaptively (see existing backfill loops for the shrink/back-off/hole-skip pattern).
- Frontend reads ONLY the API (`store.tsx`); tabs compute view-models from contract data. Venue colors come from `VenueMeta.color` per theme — new colors must be distinct + CVD-safe in both themes.

## Verification bar

"Done" means demonstrated: typecheck + tests green, the change exercised end-to-end (sim preview for UI; live RPC for chain paths), and — for anything touching money math — one real example hand-verified against the chain/explorer. Follow `docs/adapters.md` → *Verifying your adapter* for the venue checklist.
