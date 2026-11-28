#!/usr/bin/env bash
# Downloads the pinned Litestream release (the database's copier, run by the
# service: service/mpamm/src/replication.rs), checks it against the pinned
# SHA-256, and puts the binary in service/dist/ for deploy.sh to ship.
#
#   service/scripts/fetch-litestream.sh                   # linux-x86_64 → dist/litestream
#   service/scripts/fetch-litestream.sh darwin-arm64      # → dist/litestream-darwin-arm64 (restore drills)
#
# Bumping the version: take the new release's checksums.txt from GitHub, check
# each line against the asset digests GitHub shows, and update both below.
set -euo pipefail

version=0.5.18
platform=${1:-linux-x86_64}
case "$platform" in
  linux-x86_64) sha=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea; out=litestream ;;
  darwin-arm64) sha=6d3e0875e5416628ef3d274e8f7bb0ecc2a19cbbe76b9ba43efe9901d82a5c84; out=litestream-darwin-arm64 ;;
  *) echo "unknown platform $platform (linux-x86_64 or darwin-arm64)" >&2; exit 2 ;;
esac

dist=$(cd "$(dirname "$0")/.." && pwd)/dist
name=litestream-$version-$platform.tar.gz
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v$version/$name" -o "$work/$name"
got=$(shasum -a 256 "$work/$name" | cut -d' ' -f1)
if [[ "$got" != "$sha" ]]; then
  echo "checksum mismatch for $name: got $got, pinned $sha" >&2
  exit 1
fi
# Only the binary leaves the archive, into a directory of its own.
mkdir -p "$work/x" "$dist"
tar -xzf "$work/$name" -C "$work/x" litestream
install -m 0755 "$work/x/litestream" "$dist/$out"
echo "$dist/$out (litestream $version, $platform, sha256 $sha)"
