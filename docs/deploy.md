# Deploy

The dashboard ships as a **single container**: one Node process serves the REST/WS API **and** the built frontend on the same origin (the SPA's relative `/api` + `/stream` URLs need no config). It is a stateful WS indexer — persistent CEX/Monad connections, a poll loop, single-writer SQLite — so host it on a **persistent-process** platform (not serverless/edge) and run **one replica**.

The [`Dockerfile`](../Dockerfile) builds the frontend and runs the server serving it.

## Render (production — [mpamm.wtf](https://mpamm.wtf))

[`render.yaml`](../render.yaml) is the blueprint: one Standard Docker web service pinned to **Virginia (US East)**, with an `/api/health` health check and a **persistent disk** at `/data` (`DB_PATH=/data/mpamm.db`) so the SQLite history survives deploys. Keep the service close to the hot RPC: network round-trip time is paid by every block-pinned quote frame. A region change requires a new service and disk, so copy a consistent SQLite snapshot and verify it before moving the custom domain.

- **Deploys are Render-native**: every push to `main` builds the Dockerfile and deploys (health-gated, zero-downtime). [`ci.yml`](../.github/workflows/ci.yml) runs verification (typecheck → tests → frontend build → Docker build) on every push + PR.
- Key service variable: `RPC_HTTP_URL` — a **trusted Monad node**, and the one that serves block-pinned quote calls. Pick it for **distance to the tip**: some providers serve a head several blocks behind, which puts that much staleness into every quote on the Execution page before any local tuning applies. Check with `eth_blockNumber` against a second node. Quotes use a dedicated zero-wait HTTP batch lane while sharing this pool's endpoint/failover state with heads and fills. Set `RPC_WS_URL` when that same hot provider exposes `eth_subscribe`/`monadNewHeads` (with `newHeads` fallback); the service automatically keeps fast HTTP head polling active as a watchdog and fallback.
- **Set `RPC_DEPTH_URL` to a separate tip-fresh node.** The 25-point Execution curve runs in an isolated child process, so it cannot stall the main event loop; a separate endpoint also prevents it from consuming `RPC_HTTP_URL`'s connection/rate-limit budget. `RPC_DEPTH_WS_URL` is optional. If `RPC_DEPTH_URL` is omitted the worker reuses the hot node and logs a warning: CPU/event-loop isolation remains, provider-capacity isolation does not.
- **`RPC_ARCHIVE_URL` is the other half.** The tip-freshest nodes are usually pruning fullnodes (a couple of days of history), which cannot serve the venue-lifetime backfills, `blockAtOrAfter`'s search from block 0, or the gas crawl. The archive node must serve logs, headers and receipts at any depth **and** historical `eth_getCode` (the gas tracker bisects it to date a destination's deployment) — verify with `eth_getCode` at an old block before trusting an endpoint. Set it to an archive node and the deep crawls move there while quotes stay on the fast one. Leave it unset and both ride `RPC_HTTP_URL` — the pre-split behavior. Note that failover will **not** cover this for you: a pruned block is a JSON-RPC error, which never trips the breaker, so a pruning primary with an archive *backup* stalls history instead of degrading to it.
- **RPC failover is on by default for the HOT pool**, whose backups default to the public endpoint (`RPC_HTTP_BACKUP_URLS`). The **archive pool ships with no backup at all** (`RPC_ARCHIVE_BACKUP_URLS` defaults to empty) — the public endpoint cannot serve historical `eth_getCode`, so failing over to it would satisfy every crawl except the gas bootstrap, which would then retry forever while the pool looked healthy. Set it only to an endpoint meeting the full archive contract. Within a pool, a dead primary switches to that pool's backups and the primary is probed every minute, snapping back once it's healthy. The TopBar's amber `RPC` chip is hot-pool-only; inspect `state.rpcArchive` or `state.notes` for archive health. Heavy history crawls pause while the archive pool is on a backup; live quotes/fills keep flowing.

## Railway

[`.railway/railway.ts`](../.railway/railway.ts) describes the live Railway service: `mpamm-virginia` in project `enthusiastic-quietude`, built from the `main` branch with the Dockerfile, pinned to **US East Metal (Virginia, `us-east4-eqdc4a`)**, with volume `mpamm-virginia-mpamm-data-virginia` at `/data`, an `/api/health` rollout check, and the RPC URLs kept as Railway-held secrets (`preserve()`). It uses Railway Infrastructure as Code; the legacy `railway.json` format is never read for new services. `npm run typecheck` checks it against the pinned `railway` SDK. `railway config plan` (read-only) and `railway config apply` need Railway CLI **≥ 5.42.1**. Always plan before applying:

- **Names must match the live service.** Renaming the service or volume in the file makes `apply` create a new one beside it, with an empty `/data`.
- **The file manages variables.** A variable set on the service but missing from the file is removed on `apply`. Add every new knob to the file; set secret values with `railway variable set KEY --stdin --skip-deploys` and declare them as `preserve()`.

Differences from Render that matter here:

- **The health check proves very little.** The server binds its port before warm-up (RPC probe, discovery, history load), and `/api/health` returns 200 from that moment on. So the rollout check passes before startup finishes, and its timeout does not bound the boot. Railway never re-probes a live deploy: a boot that later fails exits and is retried by the restart policy (Railway's default: on failure, 10 retries), but a hung (not crashed) process is never restarted.
- **Every deploy has a short outage.** A volume can't be mounted by two deployments, so the old one stops before the new one starts. `drainingSeconds` must stay above the 5s shutdown flush in `server/src/index.ts`.
- **Egress is $0.05/GB** (Render: $0.15/GB) and compute is billed by usage, not by instance size. Volume storage is billed on bytes used, so size headroom costs nothing.

### Seeding or restoring `/data` from a snapshot

This is how production history was moved from Render (2026-10-14), and how to restore it again. Never let the indexer boot on an empty or wrong `/data`: an empty volume re-runs every venue-lifetime backfill. Volume file commands and `railway ssh` need an SSH key registered with Railway (`railway ssh keys add`) **and** an active deployment, so the service first runs a holding server that answers health checks without opening the database.

1. **Hold.** Override the start command, which redeploys:
   ```bash
   railway environment edit --json <<'JSON'
   {"services":{"<service-id>":{"deploy":{"startCommand":"node -e \"require('http').createServer((q,r)=>r.end('maintenance')).listen(process.env.PORT||8787)\""}}}}
   JSON
   ```
2. **Snapshot** the source database. On Render, `render ssh` is interactive-only, but plain `ssh srv-<id>@ssh.virginia.render.com '<cmd>'` works with a registered key. The image has no `sqlite3` CLI, and Render's `/data` lacks room for a second copy, so write to `/tmp`:
   ```bash
   node -e "new (require('node:sqlite').DatabaseSync)('/data/mpamm.db',{readOnly:true}).exec(\"VACUUM INTO '/tmp/mpamm-snapshot.db'\")"
   ```
   `VACUUM INTO` is transactionally consistent (WAL included) and drops the free pages. Stream it out with `gzip -c` over the same ssh, and compare `sha256sum` on both ends.
3. **Move the current database aside; don't delete it.** Move the `-wal`/`-shm` files too: a stale WAL replayed onto a different database corrupts it.
   ```bash
   railway ssh --service mpamm-virginia -- "mkdir -p /data/old-<date> && mv /data/mpamm.db* /data/old-<date>/"
   ```
4. **Upload under a temporary name, verify, then rename.** Volume paths are relative to the `/data` mount:
   ```bash
   railway volume files --volume mpamm-virginia-mpamm-data-virginia upload ./mpamm-snapshot.db /mpamm.db.incoming
   ```
   Inside the container (`railway ssh`), check `sha256sum` and `PRAGMA integrity_check`, then `mv /data/mpamm.db.incoming /data/mpamm.db`.
5. **Release the hold.** `railway config plan` should show the start command being cleared and nothing destructive; then `railway config apply`. The boot log must say `tail.resume: resuming: gap-filling N block(s)`. A `cold start` means the indexer did not find the restored file. Keep the snapshot-to-boot gap short: the fills tail catches up on the hot node, which keeps only a couple of days of history, and fills inside the gap lose their short-horizon markouts.
6. **Verify** against the source host. `/api/bootstrap` should return 200 (it is 503 until history has loaded, unlike `/api/health`). Every completed day in `/api/volume` and `/api/gas` should be identical. `/api/fills` should hold the same recent ids. `state.notes` should have no `rpc.` warnings. `/api/health` `coveragePct60s` should be near 100.

## Any container host / local

```bash
docker build -t mpamm .
docker run --rm -p 8787:8787 -v mpamm-data:/data \
  -e RPC_HTTP_URL=https://your-monad-node \
  -e RPC_DEPTH_URL=https://your-separate-monad-node \
  mpamm
# open http://localhost:8787
```

## Configuration knobs

All optional (defaults in [`server/src/config.ts`](../server/src/config.ts)):

| Variable | What |
|---|---|
| `RPC_HTTP_URL` | hot Monad node — quotes + fills tail (default: public endpoint). Choose for tip freshness |
| `RPC_WS_URL` | optional hot-node WebSocket; prefers `monadNewHeads`, falls back to `newHeads` (default: unset ⇒ HTTP head watcher only) |
| `RPC_HTTP_BACKUP_URLS` | ordered failover nodes for the hot pool, comma-separated (default: public endpoint; `""` disables failover). `RPC_BACKUP_URLS` is the pre-split name, still honored |
| `RPC_WS_BACKUP_URLS` | positional WS peers of `RPC_HTTP_BACKUP_URLS`; empty entries use HTTP only. No endpoint URL is inferred from another protocol |
| `RPC_WARM_MS` | standby head-probe cadence, default 15000ms, minimum 5000ms; preserves configured provider order |
| `RPC_DEPTH_URL` | dedicated tip-fresh node for high-resolution depth curves (recommended; unset ⇒ reuses `RPC_HTTP_URL`) |
| `RPC_DEPTH_WS_URL` | optional depth-node WebSocket (unset ⇒ uses hot WS only when the depth HTTP URL equals the hot URL) |
| `RPC_DEPTH_BACKUP_URLS` | ordered failover nodes for a configured `RPC_DEPTH_URL`, comma-separated (default: none); when `RPC_DEPTH_URL` is unset, the worker inherits `RPC_HTTP_BACKUP_URLS` instead |
| `RPC_DEPTH_WS_BACKUP_URLS` | positional WS peers of `RPC_DEPTH_BACKUP_URLS`; empty entries use HTTP only; when `RPC_DEPTH_URL` is unset, the worker inherits `RPC_WS_BACKUP_URLS` instead |
| `RPC_ARCHIVE_URL` | deep-history node — volume backfill, markout onboarding, gas, `blockAtOrAfter` (default: unset ⇒ same node as `RPC_HTTP_URL`). Choose for retention |
| `RPC_ARCHIVE_BACKUP_URLS` | ordered failover nodes for the archive pool (default: **none** — the public endpoint serves headers/logs/receipts to block 0 but refuses historical `eth_getCode`, which the gas tracker needs). Rejected at boot without `RPC_ARCHIVE_URL` |
| `GETLOGS_CHUNK` | getLogs span the tail attempts (default 900 — the devcore4 fleet serves 1000/call; the public endpoint caps at ~100) |
| `GETLOGS_MIN_CHUNK` | narrowest span, and the floor every adaptive crawl shrinks to (default 90 — works on the public endpoint). Keep `<= BACKFILL_CHUNK` |
| `HEAD_POLL_MS` | HTTP new-head fallback/watchdog cadence (default 75ms) |
| `DEPTH=off` · `DEPTH_SAMPLES` · `DEPTH_MIN_INTERVAL_MS` | disable depth, set curve resolution (default 25), or cap block-pass start cadence (default 0: each observed head, with pending work coalesced) |
| `QUOTE_INTERVAL_MS` | simulator quote cadence only (default 500ms); live quotes are block-triggered |
| `TAIL_INTERVAL_MS` | live fills-tail cadence floor (default 500ms) |
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
| `BACKFILL_RESET=spec[,spec]` | operator override for a one-shot re-scan of a venue's history (the normal path is a `historyRevisions` entry in the adapter — see below). Volume backfill AND fills/markout onboarding for closed days, plus a re-read of today. `venue` replays the lifetime; `venue:<block>` or `venue:YYYY-MM-DD` replays only from there (today included). `@n` is a re-run nonce, never a start (`venue@2`). Each entry is remembered once applied, so change it to re-run |

### Re-deriving history after an adapter change

A change to what an adapter decodes (a redeploy's new sources, a units fix)
ships its own history repair: declare it in the adapter and deploy — no host
setting.

```ts
historyRevisions: [{ id: 'v1-deploy-day', from: '2026-10-12' }],
```

On the first boot of that build each database applies each unseen `id` once:
closed days from `from` are deleted and replayed (volume + fills), and TODAY is
re-read from midnight to the live tail's cursor, so the hours before the deploy
are decoded by the new build too. A start of today is valid (today only). A
replay never moves a scan forward: on a fresh database, or one whose lifetime
scan is still crawling, the scan is left to cover those days itself. Revisions
wait for a run with both `BACKFILL` and `MARKOUT_BACKFILL` on. Never edit an
applied entry — add a new id.

**A replay rewrites every closed day from `from`, not just the wrong ones**, and
two things in those days do not come back as they were. Cross-quoted pairs
(`*/MON`, `*/ETH`) are re-priced at the CEX mid at the time of the replay, not
the time of the fill. Closed-day fills also lose their live markout curves,
which have no archive (`markout-curves.ts`). Set `from` to the first wrong day.
For a venue with cross pairs, compare the fix against that cost before
shipping. Hanji's 2026-09-17..19 midnight misbooking (≤1.6% of each day) was
left in place because replaying from 09-17 would have moved its late-September
cross-pair days by 3–9%.

### Recovering a window the live tail missed

```
BACKFILL_RESET=metric:2026-08-14
```

The same replay as an operator override, for what no code change describes
(an RPC outage hole, a better archive node). It replays that venue from the
given day (or block) to head instead of its whole lifetime — for Metric that is
~955k blocks rather than ~29M — then re-reads today. Both halves are
idempotent: day rows are SET-per-day and fills dedupe on deterministic ids, so a
replay can overlap what is already stored. Watch for `backfill.reset`,
`backfill.reread` and `backfill.start` in `state.notes`; a start in the future
is refused loudly rather than silently downgraded to a lifetime replay.

**Before revisions, a reset recovered every day but the one it was deployed
on.** The replay stops at midnight and the tail only reads forward, so the
deploy day's prefix kept the old decode (Metric v1, 2026-10-12: $572k served of
~$3M). The today re-read (`backfill.reread`) is what closes that gap; it SETs
the day bucket against the tail's own cursor, keeps unchanged fills (and their
live markouts) as they are, and replaces or deletes the rest.

## Operational notes

- **Memory**: the service is tuned for small instances (`NODE_OPTIONS=--max-old-space-size=320` on a 512MB box); the leaderboard aggregation is paged and the backfills stream. If steady-state OOMs recur, move up an instance size.
- **Restarts are safe everywhere**: every long job (volume backfill, markout onboarding, gas scan) is cursor-resumable, and ingest commits atomically with its cursor — a kill mid-scan never double-counts. One SQLite worker owns every post-boot mutation and acknowledges each only after COMMIT; shutdown attempts one final live snapshot and reports a failed acknowledgement before exiting.
- **Watch `state.notes`** (`/api/markets`, and the same lines in the service log): every degradation — starving reference feed, deferred CEX archive, unreadable RPC ranges — is surfaced there, sanitized of URLs/keys. Filter `level: "warn"` for the ones that want a human, or a `code` prefix (`rpc.`, `backfill.`, `markout.`, `gas.`) for one subsystem.

### Execution block cadence

Quote and depth state reads require EIP-1898 `blockHash` support on hot/depth providers. Reads remain unavailable if a provider cannot serve the exact proposal; they never silently fall back to a different state. HTTP-only observation resolves a block header once per pass. The active HTTP pool selects its matching WebSocket; a backup with no configured WS uses HTTP polling. Speculative replacements clear affected server history and reset browser quote samples. Commitment upgrades alone do not compute another quote.

The Render blueprint retains `DEPTH_MIN_INTERVAL_MS=1000`, matching the existing Virginia service, for the initial rollout. Execution's quote-driven block display takes effect on deployment. Enable every-head depth with `0` only after checking CPU throttling, quote latency and adapter completion on the deployed service. Update the blueprint and the service's explicit override together when enabling it. Keep `DEPTH_SAMPLES=25`. A positive interval remains an explicit capacity cap; setting `1000` restores the previous depth start rate without a code rollback. Restore the previous application image to roll back the complete change; no database migration is involved.

A deadline produces missing curves, never retained prices labeled as fresh. Browser diagnostics are opt-in with `?timing=1`; `window.__mpammTiming` holds at most 600 local receipt/decode/draw/presentation-opportunity records. These records are never sent to the service.
