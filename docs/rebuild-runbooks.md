# Runbooks: the Rust service on its node host

Operations for the rebuild ([rebuild-spec.md](rebuild-spec.md), plan M14). Today's
production on Railway keeps [deploy.md](deploy.md) until the switch-over, and stays the
standby after it. Steps marked *(not yet run)* have not been exercised on the host.

## Where things are

| What | Where |
| --- | --- |
| Binaries | `/var/lib/mpamm/bin/` (`mpamm`, `mpamm-reader`, `mpamm-tools`); built off the host by `service/scripts/build-linux.sh`, never on it |
| Settings | `/var/lib/mpamm/mpamm.toml` (`[service]`); secrets only in the environment file the unit loads, never printed or copied |
| Database | `/var/lib/mpamm/data/mpamm.db` (SQLite, WAL) |
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
| `unrepaired_gap` | A block the ring lost can't be read over RPC | Read `pipeline.held`. A block older than the node's history (~17 h on this host) needs the archive URL (`archive_url_env`). The pipeline holds; it never skips |
| `no_final_commit` | Nothing committed for 3 s | With `node_behind`: the node. Alone: read `pipeline.held` and the notes (a venue `NotReady` asks for a rediscovery at once, then holds) |
| `venue_outage` | A venue published no quote in a minute | `quotes.<venue>.lastError` names the cause (a revert names its reason). Its trades still decode |

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

## Host loss *(not yet run)*

1. The standby (today's Railway service) keeps serving; move DNS to it (M15's rollback).
2. A new host: DevOps provisions the node and the `mpamm` user; restore the database
   (the replica in object storage once M13 has it; until then, the last copy taken) and
   deploy. The service catches up from the restored cursor over RPC/archive.

## Checks

```bash
# the service against production's public API, per venue over the blocks both finished
sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools parity --db /var/lib/mpamm/data/mpamm.db --hours 24
# one venue's gas over a block range, recounted from receipts independently of its rules
sudo -u mpamm /var/lib/mpamm/bin/mpamm-tools gas-check --venue hanji --from <a> --to <b>
```
