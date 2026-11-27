# Venue modules (Rust rebuild)

How to add or change a venue in the Rust service (`service/`). Today's TypeScript
adapters keep [adapters.md](adapters.md) until the switch-over; this is the same job
in the rebuild, and most rules carry over unchanged. The design is in
[rebuild-spec.md](rebuild-spec.md); the order of work in [rebuild-plan.md](rebuild-plan.md).

## The shape

One file (or directory) under `service/crates/venues/src/`, implementing
`mpamm_core::Venue`, plus one line in `all()` in `service/crates/venues/src/lib.rs`
(today's registry order). The core never names a venue.

| Method | What it does | Rules |
| --- | --- | --- |
| `id`, `meta` | The venue id its trades carry, and its registry entry (name, colours, kind, role, `since_utc`) | A protocol that redeploys keeps its id (renaming deletes its history on boot) |
| `discover` | Reads the chain (`ChainCx`: the local node, the registry) | Runs at boot (retried until it succeeds) and every 10 min, and at once when a block holds on `NotReady` (5 s debounce). It MERGES into the venue's state, never replaces it |
| `watch` | What the reader copies out of each block: log addresses with topic filters, and addresses whose calldata is kept | Must cover every log `decode` and the gas rules read. `NotReady` while discovery hasn't resolved it |
| `decode` | One final block → trades (`DecodeCx`: registry, a pricer as of the block's time, the venue's durable state) | Pure: no chain reads. Emit only registered pairs (`registry.pair_of`). Ids `venue-txHash-logIndex` with the block-level log index. Skip one malformed log; return `Err` only when the block as a whole can't be decoded |
| `quote` | One proposed block → quote rows (`QuoteCx`: rpc, registry, a frozen reference, the block) | Every read pinned to `cx.block.hash` (`At::Hash`), explicit `CALL_GAS` (8M) on every `eth_call`, independent calls as one JSON-RPC batch; every leg failing is `Err` (`quote_health::check_outage`) |
| `markets` | Markets it quotes | Merge-only like discovery |
| `entry_points` | Contracts takers enter through (attribution) | `router: None` = the venue itself |
| `gas_sources` | Which transactions are its quote updates | See *Gas* |
| `history_revisions`, `history_from_utc` | Dated history repairs shipped with a decode change, and the first day of history | See *History* |

## Errors are load-bearing

- `VenueError::NotReady`: the venue can't say yet (a pool it hasn't discovered, a
  Take no seen event or discovery answer settles). The block HOLDS (nothing of it is
  written), rediscovery runs, and the block is read again.
- `VenueError::Decode`: the block as a whole failed; it holds and is retried.
- Never swallow an error that would silently undercount trades; never fail a block
  for one malformed log.

## State

- Small durable facts (a pool a factory announced, an oracle that rotated in) go in
  `cx.state` (`VenueState::set`). They are committed with the block, so the cursor
  never passes state that wasn't stored, and a restart reloads them.
- A source learned while decoding (a pool created in this very block) is admitted
  before the block's swaps; the pipeline sees the watch set grow and reads the block
  (and the next few) again with it.

## Prices

- Stable-quoted markets: USD is the quote amount.
- A crypto-quoted leg: `cx.pricer.usd_for_token`, never a reference directly. The
  pricer is as of the block's proposal time (from the exchange history), so a block
  decoded late is priced at its own time.
- The bps anchor for quotes is the pair's own reference: `pricer.pair_mid(market)`.

## Gas

With the ring every transaction is seen, so the cost of each is exact (gas limit ×
price paid; Monad charges the limit, reverts included). `GasSources` only says which
transactions count; one counts once even when several rules match:

- `destinations`: sent straight to one of these.
- `relays`: through a shared forwarder (`to`, the 4-byte selector, and the calldata
  word that names one of the relay's `targets`).
- `logs`: emitted a log from this address with this topic0 (the watch set must copy it).

A venue whose gas source isn't resolved returns `NotReady`: the block holds rather
than undercount. The rules are read after the block's decode, so a source loaded in
decode counts in that block.

## Redeploys and history

- A redeploy keeps the venue id: write a generation for the new contracts and
  compose them (`generations.rs`; Metric is the reference). The retired generation
  is decode-only up to its last block.
- A change to what a venue decodes ships its own repair: a `HistoryRevision` with
  `id`, `from` and its `source`: `Replay` (re-decode from `from`), `Fills { until }`
  (re-sum stored trades over a window; nothing re-priced) or `Markets(&[..])` (a newly
  listed market's history only).

## Verifying (required before a venue is done)

- Fixture tests in `service/crates/venues/tests/<venue>.rs`: today's TS fixtures with
  the same expected numbers, real recorded logs, no network. Stub chain reads for
  discovery and quotes (`tests/rpc_stub/` answers exact recorded arguments).
- Decode parity on the live chain: `mpamm-tools decode-range --venue <id> --from A
  --to B` against `server/scripts/decode-range.ts` over the same blocks, diffed by
  `service/tools/compare-fills.py`. Run both at the same time (crypto-quoted USD is
  priced when each tool runs). `--skip-gas-only` keeps busy keeper venues fast.
- Quote parity at one block: `mpamm-tools capture-prices`, then `mpamm-tools quote-at`
  against `server/scripts/quote-at.ts` with the same prices file, diffed by
  `service/tools/compare-quotes.py`.
- Gas: `mpamm-tools gas-check --venue <id> --from A --to B` recounts the range from
  receipts, independently of the rules, and must match to the wei.
- Hand-verify one trade's `usd`, `baseAmount` and `execPx` from the raw log.
- `cargo test --workspace`, and fmt and clippy through `service/scripts/cargo-linux.sh`
  (`fmt --all`, `clippy --workspace --all-targets -- -D warnings`).
- On the node host the shadow run's `mpamm-tools parity` must stay identical for the
  venue against production.
