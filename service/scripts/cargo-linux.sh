#!/usr/bin/env bash
# Runs a cargo command for x86_64 Linux in the build container, the platform
# the node host runs and the only one where the event-ring SDK builds:
#   service/scripts/cargo-linux.sh test --workspace
#   service/scripts/cargo-linux.sh clippy --workspace -- -D warnings
# Cargo's registry, git checkouts and target dir live in named volumes, so
# only the first run fetches the Monad repository.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -q --platform linux/amd64 -t mpamm-service-build -f build/Dockerfile build >/dev/null
exec docker run --rm --platform linux/amd64 \
  -v "$PWD":/src -w /src \
  -v mpamm-cargo-registry:/root/.cargo/registry \
  -v mpamm-cargo-git:/root/.cargo/git \
  -v mpamm-cargo-target:/target \
  -e RUSTFLAGS="${RUSTFLAGS:--C target-cpu=x86-64-v3}" \
  mpamm-service-build cargo "$@"
