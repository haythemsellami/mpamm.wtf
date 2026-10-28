# ThogAMM tracking

The adapter follows the single ERC-7815 pool at
`0x80c74517BCC2D67fFE02D3ED886796272F647210` on Monad (143). Public ABI,
deployment metadata and execution rules are in the
[ThogAMM integration guide](https://github.com/thogard785/thog-amm-integration-guide).

## Quotes and settled volume

`makerQuoteExactInput` supplies the read-only baseline at the frame's block.
It includes spread, inventory adjustments, quote age and conservative capacity.
It excludes transaction-context execution friction: effective gas price versus
basefee, FastLane warmth, and same-block treatment affect the actual swap.
The Execution page displays this distinction; `feeBps: 0` means no additive LP
fee, not that a transaction is guaranteed to receive the view's output.
Reverted legs remain unavailable and one-sided quotes retain only their available
side. The adapter does not reconstruct the private pricing model.

Only the proxy's `MakerSwapExecuted` logs count as this venue's volume. The
operator's `TakerTradeExecuted` logs represent trading on other venues and are
excluded. The event's actual input/output amounts need no issuer multiplier.

Discovery reads `getPoolIds` / `getTokens` and checks ERC-20 decimals. Upgrades,
`MakerTokenAdded`, and `MakerTokenRetired` refresh the active quote set before
same-range fills are decoded. Previously discovered markets remain in the
historical decode set. Registry read errors propagate so the cursor retries.

Keeper gas retains both legacy push events and the now-public
`MakerPageUpdated(uint8 indexed lane, bytes payload, uint256 control)` ABI. Its
topic is unchanged from PR #158, as is that PR's `params-pushed-topic` repair.
Transactions that also perform operator trades remain counted by the existing
keeper-gas methodology; the tracker deduplicates by transaction.

## xStock references

The October 27 registry has 13 tokens. The dashboard tracks all 75 unordered
non-stable/stable or non-stable/non-stable pairs (150 directions), including
50 xStock pairs and XAUt/WBTC. The three stable/stable pairs remain outside the
base-asset benchmark model.

| Token | Monad ERC-20 (18 decimals) | Kraken v2 book |
| --- | --- | --- |
| SPYx | `0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48` | `SPYx/USD` |
| QQQx | `0xa753a7395cae905cd615da0b82a53e0560f250af` | `QQQx/USD` |
| EWYx | `0x299c95eb52bfd5bc98d924bce17197b64864589b` | `EWYx/USD` |
| NVDAx | `0xc845b2894dbddd03858fd2d643b4ef725fe0849d` | `NVDAx/USD` |
| TSLAx | `0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0` | `TSLAx/USD` |

These are the actual unwrapped xStock token books, not underlying equities or
perpetual-futures proxies. The Kraken instrument subscription enables tokenized
assets. The feed maintains 25 levels, verifies the top-10 CRC32 with original
JSON decimal precision, and walks the book for each notional. Disconnects or
checksum failures discard the books until new snapshots arrive. Only online
markets on an online matching engine supply references. Heartbeats distinguish
an unchanged book from a dead connection.

Kraken quotes these tokens in USD. USDC, USDT0 and AUSD references divide by the
corresponding Kraken `USDC/USD`, `USDT/USD` and `AUSD/USD` mids. Crypto cross pairs
convert their USDT quote leg through `USDT/USD`. Stock/stock pairs use the ratio
of two USD books. WBTC quote legs additionally include Binance `WBTCBTC`;
cbBTC retains the existing explicit native-BTC parity assumption. Missing
conversion legs do not become a $1 peg.

Reference walks apply the base-book depth and fee, then convert at the other
legs' mids. They do not include the cost of executing every conversion leg.
`KRAKEN_XSTOCK_TAKER_BPS` defaults to **2.5 bps**, the Kraken Pro xStocks $1B+
volume tier published on October 27, 2026. `KRAKEN_WS_URL` overrides the default
`wss://ws.kraken.com/v2`. No API keys or new dependencies are required; the
repository's Node 24 minimum provides lossless JSON reviver context.

Live markouts use the same pair-terms reference. No matching historical Kraken
xStock BBO archive is configured, so historical xStock marks remain null. The
remark worker reports `markout.archive.unsupported` for affected historical
fills; it does not query Bybit using a Kraken symbol or substitute stock candles.
Persisted live marks remain available. Automatic market-only revisions replay
xStock fills from October 26 and XAUt/WBTC from September 15, without repricing
existing markets or requiring a deployment environment-variable change.

## Verification evidence

On October 28, 2026 UTC, `verify-adapter -- thogamm` discovered 75 markets at
block **117223313**, emitted 150 quote rows and decoded 45 recent settled fills,
with all ten checks passing and no warnings. All five xStock references warmed.

At block **117224137**, a separate pinned call quoted **1 SPYx**
(`1000000000000000000` raw units) to **770.369227 USDC** (`770369227` raw units):
`770369227 / 10^6 / (10^18 / 10^18) = 770.369227 USDC/SPYx`.
The reverse input of 100 USDC reverted with `maker: balance`. The recorded quote
fixture and tests preserve the units and unavailable-side behavior.

A real settled fill in the verifier was
[`0x3e02c1…286f3`](https://monadscan.com/tx/0x3e02c1eeb6ba574c9d04e22140830839a813bfa31ed31d32c0bda806f15286f3),
block 117220388, log 61: `22627416` raw USDC bought
`1037087468976999087933` raw WMON. That is 22.627416 USDC /
1037.087468976999087933 MON = **0.02181823296189286 USDC/MON**, with
$22.627416 quote-side notional under the dashboard's stablecoin convention.
No xStock fills were found in the separately recorded 7,218-swap sample.
The xStock fill-unit test is explicitly constructed, not labeled as a real fill.

Sources: [Kraken v2 book](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book),
[instrument status](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/instrument),
[checksum](https://docs.kraken.com/exchange/guides/websockets/book-checksum-v2),
[fee schedule](https://www.kraken.com/features/fee-schedule).
