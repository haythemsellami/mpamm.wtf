#!/usr/bin/env bash
# Builds the service's release binaries for the node host (x86_64 Linux,
# x86-64-v3 for the Zen 4/5 hosts) in a container, and copies them to dist/.
# Cargo's registry, git checkouts and target dir live in named volumes, so
# only the first build fetches the Monad repository.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --platform linux/amd64 -t mpamm-service-build -f build/Dockerfile build
docker run --rm --platform linux/amd64 \
  -v "$PWD":/src -w /src \
  -v mpamm-cargo-registry:/root/.cargo/registry \
  -v mpamm-cargo-git:/root/.cargo/git \
  -v mpamm-cargo-target:/target \
  -e RUSTFLAGS="-C target-cpu=x86-64-v3" \
  mpamm-service-build \
  bash -c 'cargo build --release -p mpamm-reader && mkdir -p dist && cp /target/release/mpamm-reader dist/ && rustc --version && cmake --version | head -1'
ls -l dist/
