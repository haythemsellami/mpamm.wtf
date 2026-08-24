# Deploy

The dashboard ships as a **single container**: one Node process serves the REST/WS API **and** the built frontend on the same origin (the SPA's relative `/api` + `/stream` URLs need no config). It is a stateful WS indexer — persistent CEX/Monad connections, a poll loop, single-writer SQLite — so host it on a **persistent-process** platform (not serverless/edge) and run **one replica**.

The [`Dockerfile`](../Dockerfile) builds the frontend and runs the server serving it.

## Render (production — [mpamm.wtf](https://mpamm.wtf))

[`render.yaml`](../render.yaml) is the blueprint: one always-on Docker web service with an `/api/health` health check and a **persistent disk** at `/data` (`DB_PATH=/data/mpamm.db`) so the SQLite history survives deploys.

- **Deploys are Render-native**: every push to `main` builds the Dockerfile and deploys (health-gated, zero-downtime). [`ci.yml`](../.github/workflows/ci.yml) runs verification (typecheck → tests → frontend build → Docker build) on every push + PR.
- Key service variable: `RPC_HTTP_URL` — a **trusted Monad node**, and the one that decides quote freshness. Pick it for **distance to the tip**: some providers serve a head several blocks behind, which puts that much staleness into every quote on the Execution page before any local tuning applies. Check with `eth_blockNumber` against a second node.
- **`RPC_ARCHIVE_URL` is the other half.** The tip-freshest nodes are usually pruning fullnodes (a couple of days of history), which cannot serve the venue-lifetime backfills, `blockAtOrAfter`'s search from block 0, or the gas crawl. Set it to an archive node and the deep crawls move there while quotes stay on the fast one. Leave it unset and both ride `RPC_HTTP_URL` — the pre-split behavior. Note that failover will **not** cover this for you: a pruned block is a JSON-RPC error, which never trips the breaker, so a pruning primary with an archive *backup* stalls history instead of degrading to it.
- **RPC failover is on by default**, per pool: if a primary dies the indexer switches to that pool's backups (`RPC_HTTP_BACKUP_URLS` / `RPC_ARCHIVE_BACKUP_URLS`, default the public endpoint) and probes the primary every minute, snapping back once it's healthy — the TopBar shows an amber `RPC` chip and `state.notes` records the switch, naming the pool. Heavy history crawls pause while the archive pool is on a backup; live quotes/fills keep flowing.

## Any container host / local

```bash
docker build -t mpamm .
docker run --rm -p 8787:8787 -v mpamm-data:/data \
  -e RPC_HTTP_URL=https://your-monad-node \
  mpamm
# open http://localhost:8787
```

## Configuration knobs

All optional (defaults in [`server/src/config.ts`](../server/src/config.ts)):

| Variable | What |
|---|---|
| `RPC_HTTP_URL` | hot Monad node — quotes + fills tail (default: public endpoint). Choose for tip freshness |
| `RPC_HTTP_BACKUP_URLS` | ordered failover nodes for the hot pool, comma-separated (default: public endpoint; `""` disables failover). `RPC_BACKUP_URLS` is the pre-split name, still honored |
| `RPC_ARCHIVE_URL` | deep-history node — volume backfill, markout onboarding, gas, `blockAtOrAfter` (default: unset ⇒ same node as `RPC_HTTP_URL`). Choose for retention |
| `RPC_ARCHIVE_BACKUP_URLS` | ordered failover nodes for the archive pool (default: public endpoint — it serves headers/logs/receipts to block 0). Rejected at boot without `RPC_ARCHIVE_URL` |
| `GETLOGS_CHUNK` | getLogs span the tail attempts (default 900 — the devcore4 fleet serves 1000/call; the public endpoint caps at ~100) |
| `GETLOGS_MIN_CHUNK` | narrowest span, and the floor every adaptive crawl shrinks to (default 90 — works on the public endpoint). Keep `<= BACKFILL_CHUNK` |
| `QUOTE_INTERVAL_MS` / `TAIL_INTERVAL_MS` | quote-loop / fills-tail-loop cadence floors (default 500 each; the loops are independent and self-scheduling) |
| `DATA_SOURCE=sim` | offline simulator instead of live |
| `VENUES=id,id` | run a subset of the adapter registry (adapter development) |
| `API_PORT` | HTTP/WS port (default 8787) |
| `BACKEND_URL` | dev only: where the Vite proxy targets `/api` + `/stream` (default `http://localhost:8787` — set it when you change `API_PORT`) |
| `DB_PATH` | SQLite path (default `data/mpamm.db`) |
| `TAKER_BPS` / `BINANCE_TAKER_BPS` | CEX benchmark taker fees (defaults: Bybit Supreme VIP 4.5, Binance VIP9 2.25) |
| `BACKFILL=off` · `BACKFILL_CHUNK` · `BACKFILL_PACE_MS` | venue-lifetime volume backfill |
| `MARKOUT_BACKFILL=off` · `MARKOUT_BACKFILL_DAYS` | onboarding markout backfill (archived CEX prices) |
| `GAS_METRIC=off` · `GAS_SAMPLE_STRIDE_BLOCKS` | QUOTE_UPDATE_BURN tracker |
| `SUBGRAPH_URL` | Clober discovery subgraph override |
| `BACKFILL_RESET=spec[,spec]` | one-shot re-scan of a venue's history — volume backfill AND fills/markout onboarding. `venue` replays the lifetime; `venue:<block>` or `venue:YYYY-MM-DD` replays only from there. `@n` is a re-run nonce, never a start (`venue@2`). The applied value is remembered, so change it to re-run |

### Recovering a window the live tail missed

```
BACKFILL_RESET=metric:2026-08-14
```

Replays that venue from the given day (or block) to head instead of its whole
lifetime — for Metric that is ~955k blocks rather than ~29M. Both halves are
idempotent: day rows are SET-per-day and fills dedupe on deterministic ids, so a
replay can overlap what is already stored. Watch for `backfill.reset` then
`backfill.start` in `state.notes`; a start past head is refused loudly rather
than silently downgraded to a lifetime replay.

## Operational notes

- **Memory**: the service is tuned for small instances (`NODE_OPTIONS=--max-old-space-size=320` on a 512MB box); the leaderboard aggregation is paged and the backfills stream. If steady-state OOMs recur, move up an instance size.
- **Restarts are safe everywhere**: every long job (volume backfill, markout onboarding, gas scan) is cursor-resumable, and ingest commits atomically with its cursor — a kill mid-scan never double-counts.
- **Watch `state.notes`** (`/api/markets`, and the same lines in the service log): every degradation — starving reference feed, deferred CEX archive, unreadable RPC ranges — is surfaced there, sanitized of URLs/keys. Filter `level: "warn"` for the ones that want a human, or a `code` prefix (`rpc.`, `backfill.`, `markout.`, `gas.`) for one subsystem.
