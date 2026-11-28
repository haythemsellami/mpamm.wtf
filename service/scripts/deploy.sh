#!/usr/bin/env bash
# Deploys a built binary to the node host as the one thing mpamm.service runs
# (/var/lib/mpamm/bin/mpamm), restarts the unit, waits for the service to
# report healthy, and puts the previous binary back if it doesn't.
#
#   service/scripts/deploy.sh <ssh-host> [binary]          # default binary: dist/mpamm
#   service/scripts/deploy.sh <ssh-host> --rollback        # back to the previous binary
#
# HEALTH picks the check: `reader` (the phase-1 reader's health.json, the
# default until the service binary exists) or `service` (GET /api/health on
# the service's local port, PORT, default 8787). TIMEOUT is how long the new
# binary has to become healthy (default 60 s).
#
# Needs only what the host grants the deploying user: running commands as
# `mpamm`, and start/stop/restart of mpamm.service. Never builds on the host.
set -euo pipefail

host=${1:?usage: deploy.sh <ssh-host> [binary|--rollback]}
arg=${2:-}
health=${HEALTH:-reader}
port=${PORT:-8787}
timeout=${TIMEOUT:-60}
bin=/var/lib/mpamm/bin/mpamm

check_health() {
  case "$health" in
    reader)
      # health.json is rewritten every second while the reader runs.
      ssh "$host" "sudo -u mpamm python3 -c '
import json, time, sys
h = json.load(open(\"/var/lib/mpamm/reader/health.json\"))
fresh = time.time() - h[\"at_unix\"] < 5
sys.exit(0 if fresh and h[\"status\"] in (\"ok\", \"repairing\") else 1)
'" 2>/dev/null
      ;;
    service)
      ssh "$host" "curl -fsS --max-time 2 http://127.0.0.1:$port/api/health >/dev/null" 2>/dev/null
      ;;
    *) echo "unknown HEALTH=$health" >&2; exit 2 ;;
  esac
}

wait_healthy() {
  local deadline=$((SECONDS + timeout))
  sleep 3
  until check_health; do
    if ((SECONDS >= deadline)); then return 1; fi
    sleep 2
  done
}

restart() {
  ssh "$host" 'sudo systemctl restart mpamm.service'
}

if [[ "$arg" == "--rollback" ]]; then
  ssh "$host" "sudo -u mpamm test -x $bin.prev" || { echo "no previous binary on $host" >&2; exit 1; }
  ssh "$host" "sudo -u mpamm mv -f $bin.prev $bin"
  restart
  wait_healthy && echo "rolled back; healthy" || { echo "rolled back, but not healthy after ${timeout}s" >&2; exit 1; }
  exit 0
fi

src=${arg:-$(dirname "$0")/../dist/mpamm}
[[ -x "$src" ]] || { echo "no executable at $src (build with service/scripts/build-linux.sh)" >&2; exit 1; }
sum=$(shasum -a 256 "$src" | cut -c1-12)
tmp=/tmp/mpamm-deploy-$sum

echo "deploying $(basename "$src") ($sum) to $host"
scp -q "$src" "$host:$tmp"
# Settings travel with the binary (service/deploy/mpamm.toml, no secrets).
scp -q "$(dirname "$0")/../deploy/mpamm.toml" "$host:$tmp.toml"
ssh "$host" "sudo -u mpamm install -m 0644 $tmp.toml /var/lib/mpamm/mpamm.toml && rm -f $tmp.toml"
# Replication: Litestream's config always; its pinned binary
# (scripts/fetch-litestream.sh) when fetched and not already on the host.
scp -q "$(dirname "$0")/../deploy/litestream.yml" "$host:$tmp.litestream.yml"
ssh "$host" "sudo -u mpamm install -m 0644 $tmp.litestream.yml /var/lib/mpamm/litestream.yml && rm -f $tmp.litestream.yml"
ls_bin=$(dirname "$0")/../dist/litestream
if [[ -x "$ls_bin" ]]; then
  want=$(shasum -a 256 "$ls_bin" | cut -d' ' -f1)
  have=$(ssh "$host" "sudo -u mpamm sha256sum /var/lib/mpamm/bin/litestream 2>/dev/null | cut -d' ' -f1" || true)
  if [[ "$want" != "$have" ]]; then
    scp -q "$ls_bin" "$host:$tmp.litestream"
    ssh "$host" "sudo -u mpamm install -D -m 0755 $tmp.litestream /var/lib/mpamm/bin/litestream && rm -f $tmp.litestream"
  fi
fi
ssh "$host" "sudo -u mpamm install -D -m 0755 $tmp $bin.new && rm -f $tmp \
  && { sudo -u mpamm test -x $bin && sudo -u mpamm cp -f $bin $bin.prev || true; } \
  && sudo -u mpamm mv -f $bin.new $bin"
restart
if wait_healthy; then
  echo "healthy on $host"
else
  echo "not healthy after ${timeout}s; rolling back" >&2
  if ssh "$host" "sudo -u mpamm test -x $bin.prev"; then
    ssh "$host" "sudo -u mpamm mv -f $bin.prev $bin"
    restart
    wait_healthy && echo "previous binary restored and healthy" >&2 || echo "previous binary restored, not healthy either" >&2
  fi
  exit 1
fi
