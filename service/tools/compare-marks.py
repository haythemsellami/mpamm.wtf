#!/usr/bin/env python3
"""Diffs two archive-mark outputs (Rust `mpamm-tools archive-marks` vs
`server/scripts/archive-marks.ts`) per horizon, in bps: how many marks
each side gave, where one gave a mark and the other none, and the max and
median absolute difference where both did. With --fills (the /api/fills
input), the same against the live marks production stored, for context.

  compare-marks.py rust.json ts.json [--fills fills.json]
"""
import json
import statistics
import sys

HORIZONS = [0, 5, 10, 30, 60]


def marks(path):
    return {r["id"]: r.get("markoutsBps") for r in json.load(open(path))}


def compare(a, b, label_a, label_b):
    common = sorted(set(a) & set(b))
    print(f"{label_a} vs {label_b}: {len(common)} trades in common")
    worst = 0.0
    for i, h in enumerate(HORIZONS):
        diffs, only_a, only_b, both_null = [], 0, 0, 0
        for k in common:
            x = (a[k] or [None] * 5)[i]
            y = (b[k] or [None] * 5)[i]
            if x is None and y is None:
                both_null += 1
            elif y is None:
                only_a += 1
            elif x is None:
                only_b += 1
            else:
                diffs.append(abs(x - y))
        if diffs:
            mx, med = max(diffs), statistics.median(diffs)
            worst = max(worst, mx)
            p99 = sorted(diffs)[int(0.99 * (len(diffs) - 1))]
            print(f"  {h:>2}s: {len(diffs)} compared, max {mx:.6g} bp, p99 {p99:.6g} bp, median {med:.6g} bp; "
                  f"only {label_a} {only_a}, only {label_b} {only_b}, both null {both_null}")
        else:
            print(f"  {h:>2}s: nothing compared; only {label_a} {only_a}, only {label_b} {only_b}, both null {both_null}")
    return worst


def main():
    args = sys.argv[1:]
    fills = None
    if "--fills" in args:
        i = args.index("--fills")
        fills = args[i + 1]
        del args[i:i + 2]
    rust, ts = marks(args[0]), marks(args[1])
    compare(rust, ts, "rust", "ts")
    if fills:
        live = {f["id"]: f.get("markoutsBps") for f in json.load(open(fills))}
        compare(rust, live, "rust", "live")


if __name__ == "__main__":
    main()
