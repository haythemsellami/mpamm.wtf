# Runbooks: the Rust service on its node host

Operations for the rebuild ([rebuild-spec.md](rebuild-spec.md), plan M14). Today's
production on Railway keeps [deploy.md](deploy.md) until the switch-over, and stays the
standby after it. Steps marked *(not yet run)* have not been exercised on the host.

## Where things are

| What | Where |
| --- | --- |
| Binaries | `/var/lib/mpamm/bin/` (`mpamm`, `mpamm-reader`, `mpamm-tools`); built off the host by `service/scripts/build-linux.sh`, never on it |
| Settings | `/var/lib/mpamm/mpamm.toml` (`[service]`); secrets only in the environment file the unit loads, never printed or copied |
| Database | `/var/lib/mpamm/data/mpamm.db` (SQLite, WAL); its copy off the host in object storage (*Replication and restore*) |
| Health | `curl -s 127.0.0.1:8787/api/health`: `status`, `alerts`, ring, pipeline, feeds, per-venue quote timings |
| Notes | `curl -s 127.0.0.1:8787/api/markets \| jq .state.notes`: every warning the service logged, URLs removed |
| Log | the unit's journal (`journalctl -u mpamm`); by hand, the file the process writes |

Access on the host is limited to running commands as `mpamm` and
`systemctl start|stop|restart mpamm.service`; anything else is DevOps'.

## Health and alerts

`status` (503 when it needs a human): `ok`; `starting` (no commit yet); `holding` (a
block is held, under 30 s); `held` (held 30 s or more: 503); `stalled` (no ring event
for `stall_secs`: 503); `no_ring` (the ring can't be opened: 503).

| Alert | Means | Do |
| --- | --- | --- |
| `node_behind` | No execution event for 2 s | Check the node (`monad-execution`, `monad-bft`); quotes and trades wait on it. Fallback mode is not built yet |
| `ring_lag` | The reader trails the ring by 500k events (the ring holds ~2^21) | The reader's core is starved: check the CPU pin (`reader_cpu`) and what else runs there |
| `unrepaired_gap` | A block the ring lost can't be read over RPC | Read `pipeline.held`. A block older than the node's history (it starts at its last state sync) needs the archive URL (`archive_url_env`). The pipeline holds; it never skips |
| `no_final_commit` | Nothing committed for 3 s | With `node_behind`: the node. Alone: read `pipeline.held` and the notes (a venue `NotReady` asks for a rediscovery at once, then holds) |
| `venue_outage` | A venue published no quote in a minute | `quotes.<venue>.lastError` names the cause (a revert names its reason). Its trades still decode |
| `replication_down` | The database isn't being copied off the host: replication off (no replica URL), the copier down for 30 s, a copier error in the last minute with no recovery since, or its position (or uploads) still for 2 min while the store commits | Read `replication` on health (`lastExit`, `lastError`) and the `replication.warn` notes. Never a 503: quotes and trades carry on. See *Replication and restore* |

## Deploy and roll back

Once `mpamm.service` runs `/var/lib/mpamm/bin/mpamm`:

```bash
service/scripts/build-linux.sh
HEALTH=service service/scripts/deploy.sh <node-host>             # installs, restarts, waits for health, rolls back if it never gets healthy
HEALTH=service service/scripts/deploy.sh <node-host> --rollback  # the previous binary
```

A restart resumes at the cursor + 1: blocks still in the ring are replayed from it,
older ones are read over RPC. Run 2026-11-27 on the shadow run: a 1 s and a 20 s
outage, both resumed at the next block from the ring with 0 gaps. The service takes up
to 10 s to stop (it finishes the block in flight; a held block is abandoned, nothing of
it written).

## Node upgrade *(not yet run)*

The ring's schema hash ties a build to a node version.

1. DevOps announces the node release tag.
2. Bump `monad-event-ring` / `monad-exec-events` in `service/Cargo.toml` to that tag;
   build in the container; run the ring snapshot test (`crates/ring/tests/snapshot.rs`)
   and the full suite.
3. Deploy right after the node restarts on the new version. Until then the old build
   reports `no_ring` (the reader refuses a ring whose schema it doesn't know).
4. Check `/api/health`: `ok`, `ring.reopens`, no `unrepaired_gap`.

## Node reset or resync *(not yet run)*

The ring file is recreated: the reader reopens it (`ring.reopens`) and resumes from the
committed cursor. Blocks the new ring doesn't hold are read over RPC from the local
node, or from the archive when the node's history no longer reaches them. The pipeline
holds until every block is read; nothing is skipped. A resync from a node snapshot
whose history starts after the cursor needs the archive URL.

## Fallback mode

With `MPAMM_HOT_RPC_URL` in the env file, the service switches to the hosted hot node by
itself when the local node goes quiet for 5 s, its ring can't be read (a node upgrade this
build doesn't know), or it trails the hosted head by more than 10 blocks for 30 s: quotes
read the hosted node, final blocks are read over RPC (gas stays exact), discovery asks it.
It switches back after 10 healthy seconds on the ring. `/api/health` → `fallback` (and the
`fallback_mode` alert) while it's on; notes `fallback.enter` / `fallback.exit`.

- Nothing to do while it runs; fix the node. Viewers see quotes a few hundred ms later.
- Node upgrades: upgrade the node, let the service run in fallback until the matching
  build is deployed, then deploy it (the ring is read again; fallback ends on its own).
- Without the variable there is no fallback: a node outage stalls quotes and trades until
  it's back (the pipeline holds; nothing is lost).

## History repairs

A build that changes what a venue decodes ships a dated revision; a new venue brings its
lifetime. On boot the service plans them (`history: b0 …; N repair(s) to run` in the
log), adopts what today's service already applied, and runs the rest one at a time from
the archive pool, a day per transaction. Progress is on `/api/health` → `history` (the
job, its day and cursor, each archive node); notes `history.start`, `history.done`,
`history.held` (a job waiting: an archive down, prices not published), `history.invalid`.

- **Rehearse first**, on a copy, with the build that ships it:
  `mpamm-tools repair --db <copy> [--reset venue:from@n] [--plan-only]`. Days the node
  still holds can use it as the archive (`--archive-url http://127.0.0.1:8080`).
- **An operator replay** (a gap no code change describes): add
  `history_reset = "venue:YYYY-MM-DD@1"` to `[service]` in `mpamm.toml` (or
  `MPAMM_HISTORY_RESET`) and restart. Each entry runs once; bump `@n` to run it again.
- **A held job** retries at its cursor with a growing pause (30 s to 10 min); nothing is
  written for the day it holds on. Fix the cause (usually the archive URL or an archive
  not yet published for a closed day); no restart is needed.
- Today's blocks in a repair are priced with the service's prices at their time; a closed
  day waits for the exchanges' archives (published the next day).

## Replication and restore

The service runs Litestream (`/var/lib/mpamm/bin/litestream`, the release pinned and
checksummed by `service/scripts/fetch-litestream.sh`) as its child, with
`/var/lib/mpamm/litestream.yml` (`service/deploy/litestream.yml`; `deploy.sh` installs
both). The write-ahead log reaches object storage about once a second; a full snapshot is
taken daily and kept a week, so any second of the last 7 days can be restored. The copier
is fail-open: it never stops quotes or trades, the service restarts it with a back-off,
and health reports it (`replication`: `state`, `metrics.txid`, `txidAgeMs`, `putsAgeMs`,
`lastError`).

- **Turning it on:** the environment file gets `MPAMM_REPLICA_URL`
  (`s3://<bucket>/mpamm?endpoint=<endpoint>`) and the bucket's keys,
  `LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY` (whoever owns the file adds
  them; never in the repo or a chat). `mpamm.toml` already names the binary. Restart, then
  check that `replication.state` is `running` and `txidAgeMs` and `putsAgeMs` stay under a
  few seconds.
- **One copier per replica, ever.** The copier holds `.mpamm.db-litestream.lock` beside the
  database for its life, and a restarted service waits for the previous copier's final
  sync. Never run `litestream replicate` by hand against the service's database.
- **What a restore loses:** the last second or so of writes. Trades in it come back from
  the chain, because the block cursor commits with its trades and a restored database
  resumes where its data stops; quote history in that window is gone.

**Restore** (a new host, or a point in time), with the service stopped:

```bash
export LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=…    # from the env file's owner
sudo -u mpamm -E /var/lib/mpamm/bin/litestream restore -integrity-check full \
  -o /var/lib/mpamm/data/mpamm.db 's3://<bucket>/mpamm?endpoint=<endpoint>'
# a point in time instead of the latest: add -timestamp 2026-11-28T10:00:00Z
```

Then point `MPAMM_REPLICA_URL` at a **new** path (`…/mpamm-<date>`) before starting: a
replaced database must not continue the old replica's sequence. Start the service; it
resumes at the restored cursor + 1, reading older blocks from the ring or the archive.
Keep the old path until the new one has its first snapshot.

Drilled 2026-11-28 with a file replica: a 349 MB database restored in 5–7 s on the host
and on a laptop, every table identical to the source, and the service booted on the copy
resumed at its cursor + 1 with trades matching the shadow run's. A fresh replica starts at
about five times the compressed database (the first image in L0, L1–L3 and the snapshot);
L0's copy is pruned after 5 minutes.

## Host loss *(not yet run)*

1. The standby (today's Railway service) keeps serving; move DNS to it (M15's rollback).
2. A new host: DevOps provisions the node and the `mpamm` user; restore the database from
   object storage (*Replication and restore*) and deploy. The service catches up from the
   restored cursor over RPC/archive.

## Checks

```bash
# the service against production's public API, per venue over the blocks both finished
sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools parity --db /var/lib/mpamm/data/mpamm.db --hours 24
# after an attribution change, stored UNKNOWN trades decoded before it, labelled again
# (only category/router/to change; --dry-run lists them first)
sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools relabel --db /var/lib/mpamm/data/mpamm.db --from <a> --to <b> --dry-run
# a load test of the stream: N viewers as Execution tabs, beside the service
sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools stream-load --clients 1000 --secs 60
# the history repairs a database would run (records adopted markers; run on a copy)
sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools repair --db <copy> --plan-only
# one venue's gas over a block range, recounted from receipts independently of its rules
sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools gas-check --venue hanji --from <a> --to <b>
```
