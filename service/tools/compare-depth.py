#!/usr/bin/env python3
"""Diffs two same-block depth snapshots (Rust `mpamm-tools depth-at` vs
`server/scripts/depth-at.ts`): the market, block and reference mid, the
venues' order, the missing venues, and every curve point by point (its
notional, which sides exist, their bps, and where the curve ends). Bps must
agree to the stream's display precision (0.01 bp); exact matches are
counted too.

  compare-depth.py rust.json ts.json
"""
import json
import sys

a = json.load(open(sys.argv[1]))
b = json.load(open(sys.argv[2]))
diffs = []
for f in ["market", "asOfBlock", "refMid"]:
    if a[f] != b[f]:
        diffs.append((f, a[f], b[f]))
order = lambda s: [c["venueId"] for c in s["venues"]]
if order(a) != order(b):
    diffs.append(("venues", order(a), order(b)))
if sorted(a.get("missingVenues", [])) != sorted(b.get("missingVenues", [])):
    diffs.append(("missingVenues", a.get("missingVenues"), b.get("missingVenues")))
curves_b = {c["venueId"]: c for c in b["venues"]}
points = exact = 0
for ca in a["venues"]:
    cb = curves_b.get(ca["venueId"])
    if cb is None:
        continue
    v = ca["venueId"]
    if ca["maxNotional"] != cb["maxNotional"]:
        diffs.append((v, "maxNotional", ca["maxNotional"], cb["maxNotional"]))
    if [p["notional"] for p in ca["points"]] != [p["notional"] for p in cb["points"]]:
        diffs.append((v, "notionals", [p["notional"] for p in ca["points"]], [p["notional"] for p in cb["points"]]))
        continue
    for pa, pb in zip(ca["points"], cb["points"]):
        for side in ["bidBps", "askBps"]:
            if (side in pa) != (side in pb):
                diffs.append((v, pa["notional"], side, pa.get(side), pb.get(side)))
            elif side in pa:
                points += 1
                exact += pa[side] == pb[side]
                if abs(pa[side] - pb[side]) > 0.01:
                    diffs.append((v, pa["notional"], side, pa[side], pb[side]))
print(f"{a['market']} at {a['asOfBlock']}: curves {order(a)} vs {order(b)}; "
      f"missing {a.get('missingVenues')} vs {b.get('missingVenues')}; {points} sides compared, {exact} bit-identical")
for d in diffs[:40]:
    print("differs:", *d)
print("IDENTICAL (to display precision)" if not diffs else f"{len(diffs)} differences")
sys.exit(0 if not diffs else 1)
