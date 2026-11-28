#!/usr/bin/env python3
"""Diffs two same-block quote outputs (Rust `mpamm-tools quote-at` vs
`server/scripts/quote-at.ts`): every (venue, market, size) row, every
price and flag. Prices must agree to the stream's display precision
(7 significant digits; 0.01 bp for bps fields) — docs/rebuild-spec.md →
How the port is proven.

  compare-quotes.py rust.json ts.json
"""
import json
import sys

def key(r):
    return (r["venueId"], r["market"], r["sizeUsd"])

a = {key(r): r for r in json.load(open(sys.argv[1]))}
b = {key(r): r for r in json.load(open(sys.argv[2]))}
diffs = []
for k in sorted(set(a) | set(b)):
    if k not in a or k not in b:
        diffs.append((k, "row", k in a, k in b))
        continue
    x, y = a[k], b[k]
    for f in ["bidPx", "askPx"]:
        u, v = float(x[f]), float(y[f])
        if abs(u - v) > 1e-7 * max(abs(u), abs(v)):
            diffs.append((k, f, u, v))
    for f in ["bidBps", "askBps", "spreadBps", "feeBps"]:
        if abs(float(x[f]) - float(y[f])) > 0.01:
            diffs.append((k, f, x[f], y[f]))
    for f in ["filledFull", "oneSided"]:
        if bool(x.get(f)) != bool(y.get(f)):
            diffs.append((k, f, x.get(f), y.get(f)))
print(f"rows: {len(a)} vs {len(b)}")
for d in diffs[:40]:
    print("differs:", *d)
print("IDENTICAL (to display precision)" if not diffs else f"{len(diffs)} differences")
sys.exit(0 if not diffs else 1)
