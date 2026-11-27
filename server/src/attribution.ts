import type { PublicClient } from 'viem';
import type { Fill } from '@shared';
import { shortHex } from './util.js';
import type { VenueAdapter } from './venues/adapter.js';

/**
 * Fill attribution — turn an adapter's honest `UNKNOWN` into a provable label
 * by looking at what the transaction actually entered through (`tx.to`):
 *
 *   tx.to == the venue itself (adapter entryPoints, no router name) → DIRECT
 *   tx.to == the venue's own periphery (entryPoints with router name) → ROUTER + name
 *   tx.to == a known aggregator (registry below)                      → ROUTER + brand
 *   anything else (private searcher bots, unidentified contracts)    → stays UNKNOWN
 *
 * Evidence-based venue attribution is never touched: only fills that arrive
 * `UNKNOWN` are enriched, so an adapter with richer log-based labels (Clober's
 * router-gateway events) keeps them. Whenever the lookup succeeds, `to` is
 * rewritten to the tx INITIATOR (`tx.from`) — the event-level "recipient" many
 * venues expose is routing plumbing, not the taker.
 *
 * Cost + failure posture: one batched eth_getTransactionByHash per unique fill
 * tx (LRU-cached across passes — re-tails and multi-fill txs are free), and a
 * label is never load-bearing: a lookup failure leaves the fill exactly as the
 * adapter emitted it. This step must never throw into the fill pipeline.
 */

/** Known aggregator/router entry contracts on Monad → display brand.
 *  Every entry is verified (official docs, verified source, or a canonical
 *  cross-chain deployment) — see the provenance notes. Extend freely; an
 *  unlisted intermediary just stays UNKNOWN. */
export const KNOWN_ROUTERS: ReadonlyMap<string, string> = new Map([
  // Relay (relay.link) — cross-chain intent execution. RelayRouterV3 +
  // v3 ApprovalProxy, both in Relay's contract-addresses docs (same CREATE2
  // addresses across chains); their solver fills user intents through these.
  ['0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', 'Relay'],
  ['0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', 'Relay'],
  // KyberSwap MetaAggregationRouterV2 — canonical cross-chain address.
  ['0x6131b5fae19ea4f9d964eac0408e4408b66337b5', 'KyberSwap'],
  // 0x (ZeroEx) Settler AllowanceHolder — canonical cross-chain address.
  ['0x0000000000001ff3684f28c67538d4d072c22734', '0x'],
  // LFJ routers on Monad mainnet (developers.lfj.gg deployment addresses):
  // LBRouter v2.2 + Router v1 — LFJ's own periphery, brand-labeled here since
  // it routes to more than the POE venue.
  ['0x18556da13313f3532c54711497a8fedac273220e', 'LFJ'],
  ['0x4face5b0ef2757ceb9151d14c036a1135931c70e', 'LFJ'],
  // ERC-4337 EntryPoints (canonical cross-chain addresses, verified live on
  // Monad) — bundler-submitted USER operations: smart-account users swapping.
  // Observed callers are 0x4337…-vanity bundler EOAs.
  ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', 'ERC-4337'], // v0.6
  ['0x0000000071727de22e5e9d8baf0edac6f37da032', 'ERC-4337'], // v0.7
  // Bungee (Socket) — intent/RFQ solver-side executor ("RFQVaultExecutor",
  // verified source). Provenance: deployer/solverSigner 0xF76e737…C34Bd5 is
  // Socket's Bungee solver signer across chains (explorer-tagged "Socket:
  // Bungee Solver" contracts share it), and the source carries Socket codebase
  // signatures (RescueFundsLib, FulfilExec/fulfil). Observed filling through
  // the Metric pAMM.
  ['0x97caca78ac2a94c67643d07843f85afaa44a3ea5', 'Bungee'],
  // Moose Trade — on-chain aggregator for Nexus smart accounts (deployed
  // 2026-09-15, block ~105.02M; addresses from the protocol's own deployment
  // manifest). Users' swaps are `handleOps` user-ops sent straight to the
  // MooseEntryPoint proxy (tx.to), mostly self-submitted: 243 distinct
  // senders over its first 2,122 handleOps. The entry point executes the
  // Nexus account → MooseAggregator proxy → venue adapters, so the entry
  // point is what attribution sees. The aggregator proxy has had no direct
  // txs, but it is Moose's own swap contract, so a direct call labels
  // correctly too. Both are ERC-1967 proxies; the implementations
  // (MooseEntryPoint 0xce8eb3c1…, MooseAggregator 0xdc93abae…) are never tx.to.
  ['0xbd267094d3b410b33f49e8f6ba8b106672746490', 'Moose Trade'], // MooseEntryPoint proxy
  ['0xd1b844a2443704bcb2f737a7434513437438b65e', 'Moose Trade'], // MooseAggregator proxy
  // ── Monad flow routers, routers/solvers registry (vetted 2026-11-28) ───────
  // Source: github.com/monad-crypto/protocols mainnet registry (mainnet/*.jsonc)
  // plus dex-evm/deployments/monad.manifest.json; every address was
  // eth_getCode-checked on chain 143 before listing. Kinds router/aggregator
  // are user-facing entry contracts; executor/solver are solver-side contracts
  // that still receive the fill's tx (a solver submitting straight to a venue,
  // or a settlement/bridge/relayer contract) — the same reasoning as the
  // Relay/Bungee solver entries above. One deliberate omission: Mayan's
  // fast-mctp fee manager (0x5984…c7e56) is router-callback plumbing, never a
  // tx.to, so it is not listed.
  // Uniswap — UniversalRouter, SwapRouter/02, v2 router, UniswapX reactor.
  ['0x000000000ac008f7e07210cfb6648e40249232c2', 'Uniswap'],
  ['0x0d97dc33264bfc1c226207428a79b26757fb9dc3', 'Uniswap'],
  ['0x4b2ab38dbf28d31d467aa8993f6c2585981d6804', 'Uniswap'],
  ['0xa6ce4f10d83dbddac17e68e1837ca9ce6a1b596e', 'Uniswap'],
  ['0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', 'Uniswap'],
  ['0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7', 'Uniswap'],
  ['0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900', 'Uniswap'],
  // 1inch — AggregationRouterV6 + its executors.
  ['0x111111125421ca6dc452d289314280a0f8842a65', '1inch'],
  ['0x1111160508e696a1ba28c1c69b9bce5645b35afe', '1inch'],
  ['0x111116056ad60f0f4fb52d60852f9acd2fafca11', '1inch'],
  ['0x111116058b9828cdcdd810c502b925c14f34ca11', '1inch'],
  ['0x11111605ed459e65d75c7e66bf34b3b7c5f6ca11', '1inch'],
  // 0x (ZeroEx) — Settler, MetaTx settler/taker, Intent/Bridge settlers.
  ['0x031d28683ffc9936903a31670bc618b8bc9b65dd', '0x'],
  ['0x13c61f0240d2013c7b621c91bd5da61865ca5d8c', '0x'],
  ['0x478cf28fd1ba92a6afd04f44b05833f6df7f1486', '0x'],
  ['0xb2376d1183829f444e0ffe9ef1ffaf1b483b84f3', '0x'],
  ['0xb40e9939bb598c38665a5c99c68020eeb8cf49fb', '0x'],
  ['0xfb36b62145a4b272bc804e5e1b41ddbf4bff4cf4', '0x'],
  // KyberSwap — executor + DSL operator (router already listed above).
  ['0x8f10b468b06c6fd214b65f87778827f7d113f996', 'KyberSwap'],
  ['0xcab2fa2eeab7065b45cbcf6e3936dde2506b4f6c', 'KyberSwap'],
  ['0x6352a56caadc4f1e25cd6c75970fa768a3304e64', 'OpenOcean'],
  // SushiSwap — RouteProcessor + RedSnwapper.
  ['0xac4c6e212a361c968f1725b4d055b47e63f80b75', 'SushiSwap'],
  ['0xc10ee9031f2a0b84766a86b55a8d90f357910fb4', 'SushiSwap'],
  // LI.FI — Diamond, Permit2 proxy, executor.
  ['0x026f252016a7c47cdef1f05a3fc9e20c92a49c37', 'LI.FI'],
  ['0x3c6b2e0b7421254846c53c118e24c65d59eae75e', 'LI.FI'],
  ['0x765faa0ffb5557c6cce2ea1097d50acfd5f5c58c', 'LI.FI'],
  // Bungee (Socket) — gateways, routers, request/executor entrypoints.
  ['0x01d8a85adb82408e14bc242ed43fbad0ca2f94cb', 'Bungee'],
  ['0x09b043840cd2f32687ec6b63fb0412585de39822', 'Bungee'],
  ['0x12efda5e4d410c5da723ceb7e43942779e3fe49b', 'Bungee'],
  ['0x1a2f1085a94de6fbcc334aae1ddf527c567b75e7', 'Bungee'],
  ['0x27d966329a325f214b4854a4f0e62550bfebdca3', 'Bungee'],
  ['0x3859ad748d03c358aabb66d084bc5849b624e611', 'Bungee'],
  ['0x3bb92b8452bde5ac20c18e10e606fdc9ac19b414', 'Bungee'],
  ['0x7aea2188414c6d22ce15b2b0b2870bce69e5e5d5', 'Bungee'],
  ['0x94d0bef156041af3ef0b9fec4784468e660045dd', 'Bungee'],
  ['0xa873aab6a98cb764ad6d52820d129d0e3667d9f9', 'Bungee'],
  ['0xab568b1b49f8be7488ca1c0d5dda6ff94691e4c8', 'Bungee'],
  ['0xd0389e84178f809903cbfe7d1efae3efa9c1769c', 'Bungee'],
  // Squid — Router + Multicall.
  ['0x073e81d92bd8b39562106819d12346240606f04a', 'Squid'],
  ['0x2b4d4cf15dad79d3426d19674bd237c1dc9144aa', 'Squid'],
  // Symbiosis — portal/bridge/meta/onchain routers + executors.
  ['0x292fc50e4eb66c3f6514b9e402dbc25961824d62', 'Symbiosis'],
  ['0x5523985926aa12ba58dc5ad00ddca99678d7227e', 'Symbiosis'],
  ['0x79d930abe53dd56b66ed43f8f6a7c6a1b84655ca', 'Symbiosis'],
  ['0x81ab74a9f9d7457ff47dfd102e78a340cf72ec39', 'Symbiosis'],
  ['0xb8f275fbf7a959f4bce59999a2ef122a099e81a8', 'Symbiosis'],
  ['0xbbad2fe9558e55ebfa04b3b5bff0b6c4e2ffdd2c', 'Symbiosis'],
  ['0xda411e3b9047ae198dfb7448e97ca900fe793035', 'Symbiosis'],
  ['0x3335733c454805df6a77f825f266e136fb4a3333', 'Rubic'],
  // Mayan — forwarder/shim/MCTP.
  ['0x337685fdab40d39bd02028545a4ffa7d287cc3e2', 'Mayan'],
  ['0x87a26566dbb3bf206634c1792a96ff4989e3f56e', 'Mayan'],
  ['0xc1062b7c5dc8e4b1df9f200fe360cdc0ed6e7741', 'Mayan'],
  ['0x3e95a025efc7f93bf4efcbea40297f97d421a274', 'Bitget'],
  // deBridge — gate/router/allowance-holder/DLN source+dest.
  ['0x43de2d77bf8027e25dbd179b491e8d64f38398aa', 'deBridge'],
  ['0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251', 'deBridge'],
  ['0xddddddddd4b6472c5002f95610b194d1161223d0', 'deBridge'],
  ['0xe7351fd770a37282b91d153ee690b63579d6dd7f', 'deBridge'],
  ['0xef4fb24ad0916217251f553c0596f8edc630eb66', 'deBridge'],
  ['0x70f6060fc8b01b56869feba8361df468f98c2900', 'Orbiter'],
  // OKX — router + DEXRouter deployments.
  ['0x6088d94c5a40cecd3ae2d4e0710ca687b91c61d0', 'OKX'],
  ['0x7a7ad9aa93cd0a2d0255326e5fb145cec14997ff', 'OKX'],
  ['0xb1e4e25b1938c78ec0b21ccb2d6a0be60aa7e63f', 'OKX'],
  ['0xc1c76e784db8d68585fb608ce68fc5dcff14000e', 'OKX'],
  // Dirol — aggregator/core/limit-order.
  ['0x646462f4d0168a94fe1884c8ae82148a3618a18d', 'Dirol'],
  ['0x77e73c3fcd3fedba383025cde4a5b97733a34c2e', 'Dirol'],
  ['0xa82098c33c75a4a1e20e06f352732910c75c690d', 'Dirol'],
  ['0x274602a953847d807231d2370072f5f4e4594b44', 'Fibrous'],
  ['0x69460570c93f9de5e2edbc3052bf10125f0ca22d', 'Rango'],
  // Eisen — diamond + forwarder.
  ['0x787c474b8a86354d0f5f19fb599a5fc7662a265f', 'Eisen'],
  ['0xece5e77f9a9846c4d69555eb44e0cff8b5f03f1e', 'Eisen'],
  ['0xa68a7f0601effdc65c64d9c47ca1b18d96b4352c', 'Monorail'],
  ['0xc9ca80b5ea956afa98627963d1880033545d108e', 'GMGN'],
  // FastLane Atlas — the ERC-4337-style EntryPoint that receives user-ops.
  // Router flow, not searcher flow: unlike the auction handler in KNOWN_MEV it
  // wraps real users' swaps, so it belongs on the routed side.
  ['0x2da28fedc4643c787cb5c5e84fa6aadb596875e8', 'FastLane Atlas'],
  ['0x9008d19f58aabd9ed0d60971565aa8510560ab41', 'CoW Protocol'],
  // Across — SpokePool + MulticallHandler.
  ['0xd2ecb3afe598b746f8123cae365a598da831a449', 'Across'],
  ['0xec41f75c686e376ab2a4f18bde263ab5822c4511', 'Across'],
  // Garden — HTLC redeem/fulfil contracts (user/solver entrypoints).
  ['0x5fa58e4e89c85b8d678ade970bd6afd4311af17e', 'Garden'],
  ['0xe413743b51f3cc8b3ac24addf50d18fa138cb0bb', 'Garden'],
  // Fly — DEX aggregator + Magpie.
  ['0x20f6ee51340adeed01a59b0e65cb3703f3dc860c', 'Fly'],
  ['0x956df8424b556f0076e8abf5481605f5a791cc7f', 'Fly'],
  ['0xcfbaa9cfce952ca4f4069874ff1df8c05e37a3c7', 'Enso'],
  ['0xbddf3556701b7ecca5d69416cffd7f86d37e52b3', 'Kuru'],
  // ThogAMM — a solver AMM: its keeper routes into other venues in one tx.
  ['0x80c74517bcc2d67ffe02d3ed886796272f647210', 'ThogAMM'],
  // Relay — v2.1 router/ApprovalProxy, depository, receiver.
  ['0x3ec130b627944cad9b2750300ecb0a695da522b6', 'Relay'],
  ['0x4cd00e387622c35bddb9b4c962c136462338bc31', 'Relay'],
  ['0x58cc3e0aa6cd7bf795832a225179ec2d848ce3e7', 'Relay'],
  ['0xf17902d51fdff7bf50aacc78d6bb399baf88b479', 'Relay'],
  ['0x07749429d3d9047a966b28a489500325bac9f1b6', 'de1'],
]);

/** MEV auction/bundle infrastructure → brand. These are NOT routers: the
 *  entry contract sells priority execution (bid forwarded to validators) and
 *  the inner swap is the winning searcher's own flow — labeled category MEV,
 *  "MEV - <brand>" in the tape. Traced example: FastLaneAuctionHandler
 *  (verified source; bid → shMonad 0x1B68626d…) wrapping a flash-loan MON arb
 *  that fills on Metric.
 *
 *  ADMISSION RULE: only SEARCHER-ONLY entrypoints belong here — verify the
 *  contract exposes no user-facing swap/route/user-op function before adding
 *  (AuctionHandler: flashExecutionBid/bidWrapper only; census 120/120 recent
 *  entry txs = one bid selector). A user-op bundler that wraps REAL user flow
 *  (e.g. FastLane's Atlas EntryPoint) must NOT be added wholesale — it would
 *  MEV-label user swaps and needs selector-level gating instead. Users on
 *  FastLane's protect-RPC are unaffected either way: their tx.to stays the
 *  aggregator/pool they called (bundling is relay-level, not calldata-level). */
export const KNOWN_MEV: ReadonlyMap<string, string> = new Map([
  ['0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58', 'FastLane'],
  // "Kubera" — private multichain searcher (their own codename, from the
  // executor's revert strings; no public identity exists). Executor deployed
  // on Monad 2025-11-24 (block 37,740,451) and at the SAME address on
  // Arbitrum/Scroll/Polygon/Optimism/BNB/Blast/Ethereum; deployer + sole
  // caller is the operator wallet below. Admission rule holds: unverified
  // arb-only executor, caller==deployer, no user-facing entrypoints.
  ['0x415669455d93b755efe7f20ef6f1dbdce7f68f7d', 'Kubera'],
  // Three private Monad-only searcher executors — no public identity, so each
  // is named for its executor (the Kubera precedent). Evidence common to all,
  // all re-checkable with one eth_call: unverified with no explorer name tag,
  // no cross-chain twin (11 chains checked), and a CALLER ALLOWLIST that
  // makes user entry impossible — replaying one of their own real txs from a
  // non-allowlisted `from` reverts Unauthorized, so the admission rule holds
  // by construction rather than by selector census alone. They are also
  // already MEV-labeled here whenever they win FastLane's PFL auction: most of
  // their flow enters via the AuctionHandler above, driven by the SAME
  // operator EOAs, and those EOAs send to nothing but FastLane and their own
  // executor. These entries just close the direct-submission half.
  //
  // 0x5530… — ERC-1967 proxy (impl 0x7a35a006…, owner == deployer 0x22c6a8b7…).
  // Dispatch is searcher-only: executor-gated `execute(bytes)`, FastLane's
  // `fastLaneCall` + `setPFLAuctionAddress`, DEX swap callbacks (uniswapV3 /
  // algebra / pancakeV3 / metricOmm) and owner withdrawals — no user-facing
  // swap/route/user-op entry. Census: 1673/1673 entry txs over ~8.5h were
  // `execute(bytes)`, from exactly the four EOAs that read
  // `approvedExecutors(addr) == true`; 44% revert outright (lost races).
  ['0x553037bac82741e7ca05afb48e8538996fd70eca', 'Searcher 0x5530'],
  // 0x2ee2… — ERC-1967 proxy (impl 0xf83a2347…, owner == deployer == sole
  // caller 0x000e4334…). Same shape: one unnamed executor-gated selector,
  // `setExecutor`/`executors` allowlist, `onMorphoFlashLoan`, `fastLaneCall`,
  // owner-only `withdrawToken`/`withdrawETH`. Census: 322 entry txs over ~8.5h
  // = 320 of that one selector + 2 `withdrawToken` (the owner sweeping
  // proceeds — a router has no such tx); 84% revert.
  ['0x2ee25bbbd6795f058876eb206c98f8a55b149d14', 'Searcher 0x2ee2'],
  // 0x53d7… — plain (non-proxy) executor, sole caller 0x826e1446…, never seen
  // via FastLane: direct submission only. `addExecutor`/`removeExecutor` gate
  // one unnamed entry selector (24/24 entry txs), alongside DEX callbacks and
  // owner withdrawals. Its own revert strings name the trade it is doing —
  // "Insufficient profit", "No hops", "Unknown hop type", "Unauthorized".
  ['0x53d7071e15121fd2f81958fa2899f6a0f66261fb', 'Searcher 0x53d7'],
  // ── Monad searcher executors, 7d volume census (2026-11-27) ────────────────
  // Each address below is an unverified contract that a 7d sweep of Uniswap
  // v3/v4/PancakeSwap pool fills saw ONLY as the Swap.sender — a payer into the
  // venue — while its sampled txs entered either through FastLane's auction
  // handler above (0xd32e…) or straight into the executor itself, never through
  // a user-facing contract. That is the direct-submission half of the
  // Searcher 0x5530/0x2ee2 shape, so each is named for its executor. Left out
  // on purpose: searchers whose every sample went through an unidentified
  // intermediary (0x54dd14b7…, unverified, no public tag) — not provable — and
  // EIP-7702 delegated EOAs (0xeed8…, 0x700c…), which are accounts, not
  // contracts. No operator wallet is listed: the census has 1–3 sampled txs per
  // executor, which proves a caller but not sole-caller or deployer.
  ['0x050fa056bf556c023915e65392e136e7630ed860', 'Searcher 0x050f'],
  ['0x1b5e936dff9970057f2ba38bbdc5800e813634d7', 'Searcher 0x1b5e'],
  ['0x2395034803fa2e78ec5c9ad107f20f989146bc0e', 'Searcher 0x2395'],
  ['0x30e179eff56cb405a476e963c642e6746204cf82', 'Searcher 0x30e1'],
  ['0x3c4b206510d04b0fe932dccb2de30ee0312b81d0', 'Searcher 0x3c4b'],
  ['0x488dce3e3a087cec37ce1b8ff79e2dea91d831fb', 'Searcher 0x488d'],
  ['0x4a250d3db1aa30a061f75433769bbb6ebac17262', 'Searcher 0x4a25'],
  ['0x5188cf6c51b046d6778d85b58f407e77ee754034', 'Searcher 0x5188'],
  ['0x532bb4886cbd96e17294b048dd56a499a4587705', 'Searcher 0x532b'],
  ['0x54cce99ab9c2290a0a3cb4a9a6218100f5fb1b23', 'Searcher 0x54cc'],
  ['0x5ac9bc14376bf2727c6211960cf3cec1e2f295bd', 'Searcher 0x5ac9'],
  ['0x61f37dc3b53a4b9bd121f9d727ca01d964dcd5ac', 'Searcher 0x61f3'],
  ['0x62c2de45a39a8a4be53d0433518819e9306b12b0', 'Searcher 0x62c2'],
  ['0x69113d5f5456b141390f188553cc4a36b782a72f', 'Searcher 0x6911'],
  ['0x7ca8f00499ade0e520fddf9d91254d0f9cd01bb2', 'Searcher 0x7ca8'],
  ['0x890e810cfd67e71d0fec1497b66c7876c0c78bbf', 'Searcher 0x890e'],
  ['0x8d4b514ce9cfa3cfebee95e8194b3f42d8fa2b98', 'Searcher 0x8d4b'],
  ['0x936c442645242accaed3ffe0f203921876061cb3', 'Searcher 0x936c'],
  ['0x9b8c84c6ddc3488d89913ab92130f76c5d3f736e', 'Searcher 0x9b8c'],
  ['0xa1aebf28f592a2bac83e12eb7d8bc0684dfb993d', 'Searcher 0xa1ae'],
  ['0xaf400cc399b47a0d9cbe219e84fb377334678934', 'Searcher 0xaf40'],
  ['0xb07838cd5b17d0be026efc66d9735739a827c962', 'Searcher 0xb078'],
  ['0xb61e5b77cb96d93075d0779ea1e7c9f988d1490a', 'Searcher 0xb61e'],
  ['0xb995eadd54ffd519decc1e2ead64781245d474cd', 'Searcher 0xb995'],
  ['0xc44bc3187cd5084bac87af0710ccb3e52041a70d', 'Searcher 0xc44b'],
  ['0xcacc0490661882cf9cb0c60bfe52cf5d662a608f', 'Searcher 0xcacc'],
  ['0xd8de03d6460ed4d700592d47a800626e003b29a9', 'Searcher 0xd8de'],
  ['0xdd8b12a1e5d0666ca86046f207a297883d4a417d', 'Searcher 0xdd8b'],
  ['0xdee5b434f36a7fa0198126e15577524f24ce9556', 'Searcher 0xdee5'],
  ['0xdf06acde6339651625a15746b4ebd0f3083d180f', 'Searcher 0xdf06'],
  ['0xe01496b1741e97c14f1eccb2c62593b51fb7b740', 'Searcher 0xe014'],
  ['0xfff2debbf1f650d2204999d6652156a3af3f47fd', 'Searcher 0xfff2'],
]);

/** Searcher OPERATOR wallets → brand, matched against tx.FROM as the LAST
 *  resort (only when tx.to matched nothing). An EOA cannot carry another
 *  user's flow, so from-matching can never mislabel user swaps — and it
 *  survives executor-contract rotation. Admission: the EOA must be the
 *  proven deployer/sole caller of a KNOWN_MEV executor. */
export const KNOWN_MEV_OPERATORS: ReadonlyMap<string, string> = new Map([
  ['0x256efafed786d24163bedf15d583ea5dbdb4757c', 'Kubera'],
  // Operator EOAs of the three executors above, kept so a rotated executor
  // contract still lands labeled. Each is tied to its executor on-chain: the
  // four 0x5530… wallets read `approvedExecutors(addr) == true` (0x22c6a8b7…
  // is also deployer+owner), 0x000e4334… is 0x2ee2…'s deployer+owner+sole
  // caller, and 0x826e1446… is 0x53d7…'s sole caller (that executor exposes no
  // allowlist view, so sole-caller is the proof). Checked for user flow before
  // listing: over an hour of blocks every one of them sent to nothing but the
  // FastLane AuctionHandler or its own executor. 0x5530…'s four wallets rotate
  // through one bot — exactly what the from-fallback exists to survive.
  ['0x22c6a8b73641e9a1e8066a01c71c388e52230659', 'Searcher 0x5530'],
  ['0x8f1661673adb1b4524ee3436d2cb66e2ff0b6845', 'Searcher 0x5530'],
  ['0x66cbc7e161c4683e48decd13ee1f4495ea848e18', 'Searcher 0x5530'],
  ['0x62fd55d9d8bb20f19984b56bfec4f49a5c20f1ab', 'Searcher 0x5530'],
  ['0x000e4334baea5ed508919eb74845f8557e942ccc', 'Searcher 0x2ee2'],
  ['0x826e1446245a0ab5b24888b407dfeb47a4d5749d', 'Searcher 0x53d7'],
]);

const LOOKUP_POOL = 12;   // concurrent tx lookups (batched by the transport anyway)
const CACHE_MAX = 4096;   // txHash → {to, from}; ~an hour of busy tape

export class FillAttributor {
  /** insertion-ordered Map as a cheap LRU (delete+set on hit refresh not
   *  needed — fills for one tx arrive together; we only evict oldest). */
  private cache = new Map<string, { to: string; from: string } | null>();

  constructor(
    private client: Pick<PublicClient, 'getTransaction'>,
    private adapters: readonly VenueAdapter[],
  ) {}

  /** Enrich UNKNOWN fills in place. Never throws; unresolved fills are left
   *  exactly as the adapter emitted them.
   *
   *  `clients` is tried in order per tx and defaults to the hot client. A
   *  caller that read the fills from the archive pool passes that pool first:
   *  a pruning fullnode answers "not found" for a tx older than its retention,
   *  which would leave every fill of a gap-fill UNKNOWN. */
  async attribute(fills: Fill[], clients: readonly Pick<PublicClient, 'getTransaction'>[] = [this.client]): Promise<void> {
    const targets = fills.filter((f) => f.category === 'UNKNOWN');
    if (!targets.length) return;

    // venueId → entry map (lowercased address → router name | '' for direct),
    // rebuilt per pass: entry sets follow discovery/quarantine, and it's cheap.
    const venueEntries = new Map<string, Map<string, string>>();
    for (const a of this.adapters) {
      if (!a.entryPoints) continue;
      const m = new Map<string, string>();
      try {
        for (const e of a.entryPoints()) m.set(e.address.toLowerCase(), e.router ?? '');
      } catch { continue; } // pre-discovery — this pass just attributes less
      for (const v of a.venues()) venueEntries.set(v.id, m);
    }

    const hashes = [...new Set(targets.map((f) => f.txHash))].filter((h) => !this.cache.has(h));
    for (let i = 0; i < hashes.length; i += LOOKUP_POOL) {
      await Promise.all(hashes.slice(i, i + LOOKUP_POOL).map(async (h) => {
        for (const client of clients) {
          for (let r = 0; r < 2; r++) {
            try {
              const t = await client.getTransaction({ hash: h as `0x${string}` });
              this.cache.set(h, { to: String(t.to ?? '').toLowerCase(), from: String(t.from).toLowerCase() });
              return;
            } catch { await new Promise((res) => setTimeout(res, 120 * (r + 1))); }
          }
        }
        this.cache.set(h, null); // looked up and failed — don't retry this pass
      }));
    }
    // evict oldest entries beyond the cap (Map preserves insertion order).
    for (const k of this.cache.keys()) {
      if (this.cache.size <= CACHE_MAX) break;
      this.cache.delete(k);
    }

    for (const f of targets) {
      const tx = this.cache.get(f.txHash);
      if (!tx) continue;                       // lookup failed — honest UNKNOWN stays
      f.to = shortHex(tx.from);                // the initiator, not routing plumbing
      const entry = venueEntries.get(f.venueId)?.get(tx.to);
      if (entry !== undefined) {
        if (entry === '') { f.category = 'DIRECT'; continue; }
        f.category = 'ROUTER';
        f.router = entry;
        continue;
      }
      const brand = KNOWN_ROUTERS.get(tx.to);
      if (brand) {
        f.category = 'ROUTER';
        f.router = brand;
        continue;
      }
      const mev = KNOWN_MEV.get(tx.to);
      if (mev) {
        f.category = 'MEV';
        f.router = mev;
        continue;
      }
      const op = KNOWN_MEV_OPERATORS.get(tx.from);
      if (op) {
        f.category = 'MEV';
        f.router = op;
      }
    }
    // drop failed lookups so the next pass retries them.
    for (const [k, v] of this.cache) if (v === null) this.cache.delete(k);
  }
}
