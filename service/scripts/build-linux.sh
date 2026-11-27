#!/usr/bin/env bash
# Builds the service's release binaries for the node host (x86_64 Linux,
# x86-64-v3 for the Zen 4/5 hosts) in the build container, and copies them
# to dist/. Never build on the node host: a release build takes its cores.
set -euo pipefail
cd "$(dirname "$0")/.."
bins=(mpamm-reader)
scripts/cargo-linux.sh build --release "${bins[@]/#/--bin=}"
mkdir -p dist
docker run --rm --platform linux/amd64 -v "$PWD":/src -v mpamm-cargo-target:/target ubuntu:24.04 \
  bash -c "$(printf 'cp /target/release/%s /src/dist/ && ' "${bins[@]}") true"
ls -l dist/
