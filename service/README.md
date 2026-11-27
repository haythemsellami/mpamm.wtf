# mpamm service (Rust)

The rebuild described in [docs/rebuild-spec.md](../docs/rebuild-spec.md): one Rust
service beside its own Monad node, reading Execution Events. This directory is a
Cargo workspace; today it holds phase 1 only.

| Crate | Binary | What it does |
| --- | --- | --- |
| `reader` | `mpamm-reader` | Follows the node's execution-event ring and records each block's timeline: proposal → arrival delay, execution time, voted / finalized / verified times, abandoned proposals, sequence gaps, reader lag, and how far back the ring still reaches. Decodes no venue data yet. |

The execution-event SDK (`monad-event-ring`, `monad-exec-events`) is pinned to the
node's own release tag in `Cargo.toml` (`v0.16.5`). The ring's schema hash ties a
build to a node version: upgrade the tag together with the node.

## Build

Never on the node host: a release build would take the node's cores. Build an
x86_64 Linux binary in Docker (Ubuntu 24.04, clang-19, CMake, as the SDK requires):

```bash
service/scripts/build-linux.sh   # → service/dist/mpamm-reader
```

The first build fetches the Monad repository with its submodules, which is slow;
later builds reuse the cached volumes.

## Run on the node host

```bash
scp service/dist/mpamm-reader <node-host>:/tmp/
ssh <node-host> 'sudo -u mpamm install -D -m 0755 /tmp/mpamm-reader /var/lib/mpamm/bin/mpamm-reader'
ssh <node-host> 'sudo -u mpamm taskset -c 0 /var/lib/mpamm/bin/mpamm-reader --duration-secs 600'
```

CPU 0 is the one core no node daemon is pinned to on our first node host. Output goes to
`/var/lib/mpamm/reader/`:

- `blocks.jsonl`: one line per settled block (`verified` or `abandoned`)
- `summary.jsonl`: one line per interval (also printed to stdout)
- `authors.json`: arrival delay per proposer key, to join with validator locations

`arrival_ms` uses the proposer's clock (`proposal_epoch_nanos`) against this host's
clock, so it includes their NTP offsets; every other duration is measured on one clock.
