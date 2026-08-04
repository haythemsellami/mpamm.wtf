# Deploy

The dashboard ships as a **single container**: one Node process serves the REST/WS API **and** the built frontend on the same origin (the SPA's relative `/api` + `/stream` URLs need no config). It is a stateful WS indexer — persistent CEX/Monad connections, a poll loop, single-writer SQLite — so host it on a **persistent-process** platform (not serverless/edge) and run **one replica**.

The [`Dockerfile`](../Dockerfile) builds the frontend and runs the server serving it.

## Render (production — [mpamm.wtf](https://mpamm.wtf))

[`render.yaml`](../render.yaml) is the blueprint: one always-on Docker web service with an `/api/health` health check and a **persistent disk** at `/data` (`DB_PATH=/data/mpamm.db`) so the SQLite history survives deploys.

- **Deploys are Render-native**: every push to `main` builds the Dockerfile and deploys (health-gated, zero-downtime). [`ci.yml`](../.github/workflows/ci.yml) runs verification (typecheck → tests → frontend build → Docker build) on every push + PR.
- Key service variable: `RPC_HTTP_URL` — a **trusted Monad node**. The public endpoint works but is rate-limited and caps `getLogs` ranges, which slows the venue-lifetime backfills considerably.
- **RPC failover is on by default**: if the primary node dies, the indexer switches to `RPC_BACKUP_URLS` (default: the public endpoint) and probes the primary every minute, snapping back once it's healthy — the TopBar shows an amber `RPC` chip and `state.notes` records the switch. Heavy history crawls pause on a backup; live quotes/fills keep flowing.

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
| `RPC_HTTP_URL` / `RPC_WS_URL` | Monad node (default: public endpoint) |
| `RPC_BACKUP_URLS` | ordered failover nodes, comma-separated (default: public endpoint; `""` disables failover) |
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
| `BACKFILL_RESET=venue[,venue]` | one-shot re-scan of a venue's volume history |

## Operational notes

- **Memory**: the service is tuned for small instances (`NODE_OPTIONS=--max-old-space-size=320` on a 512MB box); the leaderboard aggregation is paged and the backfills stream. If steady-state OOMs recur, move up an instance size.
- **Restarts are safe everywhere**: every long job (volume backfill, markout onboarding, gas scan) is cursor-resumable, and ingest commits atomically with its cursor — a kill mid-scan never double-counts.
- **Watch `state.notes`** (`/api/markets`, and the same lines in the service log): every degradation — starving reference feed, deferred CEX archive, unreadable RPC ranges — is surfaced there, sanitized of URLs/keys. Filter `level: "warn"` for the ones that want a human, or a `code` prefix (`rpc.`, `backfill.`, `markout.`, `gas.`) for one subsystem.
