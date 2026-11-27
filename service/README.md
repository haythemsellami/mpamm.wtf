# mpamm service (Rust)

The rebuild described in [docs/rebuild-spec.md](../docs/rebuild-spec.md): one Rust
service beside its own Monad node, reading Execution Events. The order of work is
in [docs/rebuild-plan.md](../docs/rebuild-plan.md). This directory is a Cargo
workspace.

| Crate | What it does |
| --- | --- |
| `mpamm` | The service binary: the ring reader on a pinned core, the commit pipeline, the quote engine, markout aging and rediscovery on the async runtime, one SQLite writer thread, and today's REST and stream (plus the built dashboard with `--web-dist`) through `mpamm/src/source`. |
| `crates/ring` (`mpamm-ring`) | The event model, the watch set (what to copy out of the ring), and the block tracker: block assembly, block-level log indexes, commit states, abandoned proposals, and heights the ring lost (`Missing`), reported strictly in order. `sdk.rs` reads the node's ring and `follow.rs` is the reader thread's loop (Linux only); everything else builds and tests anywhere. |
| `crates/core` (`mpamm-core`) | `FinalBlock`, identical whether read from the ring or over RPC, and the `Venue` trait. |
| `crates/pipeline` (`mpamm-pipeline`) | Final blocks in strict order: RPC repair (local node, then archive), venue decode, exact gas and attribution, one commit per block; holds instead of skipping. |
| `crates/venues` (`mpamm-venues`) | The 11 venue modules (discovery, watch set, decode, gas sources, quotes), each checked against today's adapter on live blocks. How to write one: [docs/rebuild-venues.md](../docs/rebuild-venues.md). |
| `crates/pricing` (`mpamm-pricing`) | Bybit, Binance and Kraken feeds, the pair-terms reference, the price history marks and late decodes read, wrapper rates. |
| `crates/quotes` (`mpamm-quotes`) | One quote job per proposed block, every read pinned to its hash, a deadline per venue; each answer announced as it finishes. |
| `crates/markouts` (`mpamm-markouts`) | Markouts at each horizon and the −5…+15 s curve, marked at the proposal time from the price history. |
| `crates/analytics` (`mpamm-analytics`) | The leaderboard and markout-curve aggregations, bit-identical to today's. |
| `crates/store` (`mpamm-store`) | SQLite: every trade, daily volume and gas, the cursor, revisions, venue state; one transaction per final block. |
| `crates/registry` (`mpamm-registry`) | The market registry, compiled in from `shared/registry.json`, with lookups tested against today's TypeScript. |
| `crates/types` (`mpamm-types`) | Data types in today's JSON shapes, REST and stream payloads included. |
| `crates/api` (`mpamm-api`) | Today's HTTP API and `/stream` protocol (`mpamm.v2.gzip` / `mpamm.v2.json`) on axum, behind the `ApiSource` trait, so the web app runs unchanged against the service. `cargo run -p mpamm-api --example fake` serves synthetic live data on 127.0.0.1:8787 for `npm -w web run dev`. |
| `crates/chain` (`mpamm-chain`) | JSON-RPC over HTTP (calls, batches, block headers). Errors never carry a URL, so hosted keys can't reach a log. |
| `tools` (`mpamm-tools`) | Verification: `decode-range` and `quote-at` (parity with today's adapters at the same blocks), `gas-check` (a block range's gas against a receipts recount), `parity` (the shadow run against production's API), `migrate` (today's database into the new schema). |
| `reader` (`mpamm-reader`) | The phase-1 tool: follows the ring, records each height's timeline, repairs lost heights over RPC, and writes daily files, a cursor and a health file. Decodes no venue data. |

The execution-event SDK (`monad-event-ring`, `monad-exec-events`) is pinned to the
node's own release tag in `Cargo.toml` (`v0.16.5`). The ring's schema hash ties a
build to a node version: upgrade the tag together with the node.

## Build and test

On any machine, for everything but the ring adapter:

```bash
cargo test --workspace            # from service/
```

For Linux (the SDK, the reader binary, clippy), in a container with the SDK's
toolchain (Ubuntu 24.04, clang-19, CMake):

```bash
service/scripts/cargo-linux.sh test --workspace
service/scripts/cargo-linux.sh clippy --workspace --all-targets -- -D warnings
service/scripts/build-linux.sh    # release binaries → service/dist/
```

Never build on the node host: a release build would take the node's cores. The
first container run fetches the Monad repository with its submodules, which is
slow; later runs reuse the cached volumes.

## Run the service on the node host

Until `mpamm.service` runs it, by hand, as the shadow run (its own database beside
today's production; `setsid` so the ssh session doesn't hold it):

```bash
scp service/dist/mpamm <node-host>:/tmp/
ssh <node-host> 'sudo -u mpamm install -m 0755 /tmp/mpamm /var/lib/mpamm/bin/mpamm-shadow'
ssh <node-host> 'sudo -u mpamm setsid bash -c "cd /var/lib/mpamm && exec bin/mpamm-shadow --config /dev/null --db data-shadow/mpamm.db --reader-cpu 0 --web-dist web/dist > mpamm-shadow.log 2>&1" < /dev/null > /dev/null 2>&1 &'
ssh <node-host> 'curl -s 127.0.0.1:8787/api/health'
ssh -N -L 18787:127.0.0.1:8787 <node-host>      # the dashboard at http://localhost:18787
```

A stopping service can take up to 10 s (it finishes the block in flight), so wait for the
old process to exit before starting the next on the same port. The shadow run's check
against production, per venue over the blocks both have finished:

```bash
ssh <node-host> 'sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools parity --db /var/lib/mpamm/data-shadow/mpamm.db --hours 2'
```

Health statuses, alerts and what to do about each are in
[docs/rebuild-runbooks.md](../docs/rebuild-runbooks.md).

The dashboard's browser suite runs against the Rust API without a chain (the API's fake
example serves the built app): `npm -w web run test:e2e:rust`.

Settings come from flags, then the `[service]` table of `/var/lib/mpamm/mpamm.toml`
(`db`, `ring`, `rpc_url`, `archive_url_env`, `reader_cpu`, `http`, `web_dist`,
`finalize_wait_ms`, `stall_secs`, `quote_deadline_ms`), then defaults. The hosted archive URL is read only from the environment
variable named by `archive_url_env` (default `MPAMM_ARCHIVE_RPC_URL`). Once the unit
points at `/var/lib/mpamm/bin/mpamm`, `service/scripts/deploy.sh <node-host>` installs a
build with `service/deploy/mpamm.toml`, restarts it and checks health
(`HEALTH=service`), rolling back if it never becomes healthy.

## Run the reader on the node host

```bash
scp service/dist/mpamm-reader <node-host>:/tmp/
ssh <node-host> 'sudo -u mpamm install -D -m 0755 /tmp/mpamm-reader /var/lib/mpamm/bin/mpamm-reader'
ssh <node-host> 'sudo -u mpamm /var/lib/mpamm/bin/mpamm-reader --cpu 0 --duration-secs 600'
```

`--cpu 0` pins it to the one core no node daemon is pinned to on our first node
host. It stops cleanly on SIGTERM or SIGINT (writing what it holds and the
cursor), and resumes from `cursor.json` on the next start: from the ring if the
height is still there, otherwise from the ring's oldest block with the heights in
between repaired over RPC (`--fresh` starts at the newest block instead).

Repairs read the local node (`--rpc-url`, default `http://127.0.0.1:8080`), then
the hosted archive named by the environment variable in `--archive-url-env`
(default `MPAMM_ARCHIVE_RPC_URL`; its value is never printed).

Output goes to `/var/lib/mpamm/reader/` (`--out-dir`):

- `blocks-YYYY-MM-DD.jsonl`: one line per settled height (`final` from the ring,
  `repaired` over RPC with the reason) or losing proposal (`abandoned`). After a
  crash a few lines past the cursor can repeat; keep the last line per height.
- `summary-YYYY-MM-DD.jsonl`: one line per interval (also printed to stdout):
  percentiles, gaps, repairs, unrepaired heights, reader lag, ring depth.
- `authors.json`: arrival delay per proposer key, to join with validator locations.
- `cursor.json`: the first height not yet written.
- `health.json`: rewritten every second: `ok`, `repairing`, `stalled`, `no_ring`
  or `stopped`, with reader lag and the unrepaired heights.

Daily files older than `--keep-days` (30) are deleted.

`arrival_ms` uses the proposer's clock (`proposal_epoch_nanos`) against this host's
clock, so it includes their NTP offsets; every other duration is measured on one clock.
