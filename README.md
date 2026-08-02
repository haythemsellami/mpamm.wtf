# propAMM · Monad — execution monitor

**Live at [mpamm.wtf](https://mpamm.wtf).**

A real-time dashboard for **propAMMs on Monad mainnet** — venues where a market maker (or the oracle it anchors to) sets the price. Every venue is a **composable adapter**: one file + one registry line lists a protocol, and volume, fills, markouts, quote-update gas and the UI all follow. Every pair is benchmarked against its **own CEX reference**, routed per base asset and **converted into the pair's own terms** (live stable cross + wrapped/native basis, never a $1 peg). Four views: live execution quality (with an optional standard-DEX baseline band), filled volume + quote-update gas burn, swap markouts, and a markout leaderboard.

![mpamm.wtf — realtime execution comparison](docs/assets/dashboard.png)

```
┌──────────────┐   Multicall3 eth_call (quotes)   ┌──────────────┐   REST + WS    ┌─────────────┐
│ Monad RPC    │──  getLogs tail (fills) ────────▶│   server/    │───────────────▶│    web/     │
│ CEX WS feeds │──  reference books + crosses ───▶│ DataSource   │  /api  /stream │ React tabs  │
│ (per asset)  │──  wrapped/native basis ────────▶│              │                │             │
└──────────────┘                                  └──────────────┘                └─────────────┘
```

## Quick start

```bash
npm install
npm run dev          # backend (live) on :8787 + Vite on :5173 → open http://localhost:5173
```

By default the backend runs **live** — real Monad RPC (Multicall3 quotes + `getLogs` fills) + the CEX reference feeds. It fails fast if the chain is unreachable rather than serving fabricated data. To run fully offline against the deterministic **simulator** (no external dependencies):

```bash
DATA_SOURCE=sim npm run dev
```

`npm run typecheck` typechecks all workspaces · `npm -w server run test` runs the tests · `npm run build` builds the frontend.

## Add your venue

The whole system is venue-agnostic: **one adapter file + one registry line** lists a new protocol — volume, fills, markouts, leaderboard, gas burn and the UI all follow, with lifetime on-chain history backfilled automatically. Start with **[docs/adapters.md](docs/adapters.md)**.

```bash
# develop your adapter in isolation against the real chain
VENUES=myvenue BACKFILL=off MARKOUT_BACKFILL=off GAS_METRIC=off npm run dev
```

## Docs

| | |
|---|---|
| [docs/adapters.md](docs/adapters.md) | Writing a venue adapter — interface, correctness rules, local dev, verification, PR checklist |
| [docs/architecture.md](docs/architecture.md) | How it works — propAMM scope, quote/fill paths, persist-forward indexer, pair-terms CEX references, data model, API |
| [docs/spec.md](docs/spec.md) | The venue-agnostic design spec — invariants, contracts, key decisions |
| [docs/deploy.md](docs/deploy.md) | Hosting — single container, Render blueprint, configuration knobs |

The pixel-level design source lives under [`design/`](design/).

## License

[AGPL-3.0-only](LICENSE). Fork it, modify it, build on it — but if you run a
modified version as a network service, the AGPL requires you to offer your
users the complete corresponding source. Improvements stay public, the same
way this project is.
