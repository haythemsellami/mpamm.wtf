#!/usr/bin/env python3
"""Diffs two decode-range outputs (Rust vs TypeScript): ids, then every
field. USD must match exactly (within float formatting) for stable-quoted
markets; crypto-quoted markets are priced at the moment each tool ran, so
their USD is compared within --usd-tolerance (relative).

  compare-fills.py rust.json ts.json [--usd-tolerance 0.002]
"""
import json
import sys

def main():
    args = sys.argv[1:]
    tol = 0.002
    if "--usd-tolerance" in args:
        i = args.index("--usd-tolerance")
        tol = float(args[i + 1])
        del args[i:i + 2]
    a = {f["id"]: f for f in json.load(open(args[0]))}
    b = {f["id"]: f for f in json.load(open(args[1]))}
    only_a, only_b = sorted(set(a) - set(b)), sorted(set(b) - set(a))
    stable = {"USDC", "USDT0", "AUSD", "USD1"}
    diffs = []
    for k in sorted(set(a) & set(b)):
        x, y = a[k], b[k]
        crypto_quoted = x["market"].split("/")[1] not in stable
        for f in ["market", "side", "category", "pxApprox", "pool", "to", "router", "blockNumber"]:
            if x.get(f) != y.get(f):
                diffs.append((k, f, x.get(f), y.get(f)))
        for f in ["baseAmount", "execPx", "usd"]:
            u, v = float(x[f]), float(y[f])
            rel = abs(u - v) / max(abs(u), abs(v), 1e-300)
            limit = tol if (f in ("usd",) and crypto_quoted) or (f == "execPx" and crypto_quoted and x.get("pxApprox")) else 1e-12
            if rel > limit:
                diffs.append((k, f, u, v))
    print(f"{args[0]}: {len(a)} fills; {args[1]}: {len(b)} fills; common {len(set(a) & set(b))}")
    for k in only_a[:20]:
        print("only in first:", k)
    for k in only_b[:20]:
        print("only in second:", k)
    for d in diffs[:40]:
        print("differs:", *d)
    ok = not only_a and not only_b and not diffs
    print("IDENTICAL" if ok else f"{len(only_a)} + {len(only_b)} id differences, {len(diffs)} field differences")
    sys.exit(0 if ok else 1)

main()
