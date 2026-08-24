/**
 * @mpamm/shared — the contract between the backend service and the frontend.
 *
 * Everything the frontend renders flows through these types (docs/architecture.md: data model + system shape). The
 * backend produces them from either real chain/Bybit data (LiveDataSource) or
 * the simulator (SimDataSource); the frontend never knows which.
 */

// ──────────────────────────────────────────────────────────────────────────
// Domain vocabulary
// ──────────────────────────────────────────────────────────────────────────

/** buy/sell of the base asset (MON/BTC/ETH). */
export type Side = 'buy' | 'sell';

/** Routing classification for a fill, shown in the tape/leaderboard. `MEV` =
 *  the tx entered through auction/bundle infrastructure (e.g. FastLane) — the
 *  inner swap is searcher flow, not user routing. `UNKNOWN` = the attribution
 *  source was unavailable when the fill was decoded, so we can't say whether
 *  it was direct or routed (never guessed as DIRECT). */
export type FillCategory = 'DIRECT' | 'ROUTER' | 'AGG' | 'MEV' | 'CEX/DEX' | 'UNKNOWN';

export type DataSourceMode = 'live' | 'sim';

/**
 * Venue identity — the composable unit. Every venue (LFJ POE, Clober, …) and
 * CEX reference venue is described by one of these, produced by its
 * adapter on the backend and shipped to the frontend so NOTHING about a venue
 * is hardcoded in the core: name, color and grouping all come from here.
 *
 * `role: 'venue'` = a propAMM/on-chain venue that lands fills and shows in
 * Volume/Markouts/Leaderboard. `role: 'reference'` = a CEX benchmark venue
 * (Bybit for MON, Binance for BTC/ETH): it provides the markout/quote reference
 * and shows only in Execution. `role: 'baseline'` = a quote-only standard-DEX
 * comparison (Uniswap v4): Execution-page only — rendered as a cost-envelope
 * band, toggled OFF by default, never in volume/markouts/leaderboard, never ★.
 */
export interface VenueMeta {
  /** stable key used everywhere as `Fill.venueId` / `QuoteRow.venueId` (e.g. 'poe', 'clober-vault', 'bybit'). */
  id: string;
  /** display name (e.g. 'LFJ POE', 'Clober', 'Bybit'). */
  name: string;
  /** venue color per theme — the single source of truth for line/bar/swatch color. */
  color: { light: string; dark: string };
  kind: 'amm' | 'clob' | 'vault' | 'cex';
  role: 'venue' | 'reference' | 'baseline';
  /** true when a reference venue is walked as a taker (order book + fee), not at mid.
   *  Drives the "vs CEX" comparison basis; the Execution prose explains the method. */
  taker?: boolean;
  /** first UTC day ('YYYY-MM-DD') this venue EXISTED (deployment day, or the day
   *  its tracked history starts). Per-day views (e.g. Volume hover tooltips) omit
   *  the venue before this date — a venue that didn't exist yet must not render
   *  as "$0 / 0.0%", which reads as a live venue doing no business. Unset = shown
   *  for every day. */
  sinceUtc?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Constants — verified contracts & token universe (verified on-chain; the registry is the source of truth)
// ──────────────────────────────────────────────────────────────────────────

export const MONAD_CHAIN_ID = 143;

/** The dashboard's ORIGINAL v0.1 launch-history date — now only the sim's
 *  synthetic-history start and the default for the (currently unused) adapter
 *  backfill() seed hook. Real venue history replays on-chain from each
 *  adapter's own `backfillFromUtc` (its deploy / first-activity day). */
export const HISTORY_START_UTC = '2026-05-13';

export const ADDR = {
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  // Clober V2
  bookManager: '0x6657d192273731C3cAc646cc82D5F28D0CBE8CCC',
  bookViewer: '0xe424c211e2Ed8a5B6d1C57FA493C41715568D238',
  controller: '0x19b68a2b909D96c05B623050C276FBD457De8e83',
  routerGateway: '0x7B58A24C5628881a141D630f101Db433D419B372',
  liquidityVault: '0xB09684f5486d1af80699BbC27f14dd5A905da873',
  simpleOracleStrategy: '0x54cd5332b1689b6506Ce089DA5651B1A814e9E7D',
  operator: '0xCBd3C0B81A9a36356a3669A7f60A0d2F0846195B',
} as const;

/** Clober BookManager deploy block — start of on-chain history. */
export const CLOBER_DEPLOY_BLOCK = 31662843n;

export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** USD stablecoin pegged to $1 (docs/architecture.md: pair-terms reference). */
  stable: boolean;
  /** CEX `<STABLE>USDT` cross symbol used to convert a USDT-quoted reference
   *  into THIS stable's terms (e.g. USDC → 'USDCUSDT', ~±10bps of real basis).
   *  Unset = treated ≡ USDT (exact for USDT0 — it IS Tether's USDT on Monad;
   *  an approximation for unlisted stables like AUSD). */
  usdtCross?: string;
  /** the base ASSET this (non-stable) token represents when it is NOT the
   *  asset's canonical wrapper (e.g. cbBTC → 'BTC'; WBTC is already
   *  ASSETS.BTC.token). Lets `assetForToken` price alternative wrappers. */
  baseAsset?: string;
}

/**
 * MON has two on-chain representations and venues differ (docs/architecture.md):
 *  - ERC-20 AMM pools (POE, Metric) use the WMON wrapper.
 *  - Clober (V4-style) books + the LiquidityVault use NATIVE MON (the zero
 *    address, via isNative()).
 * Both are the same asset (same price, 18 decimals). Treat them as MON.
 */
export const NATIVE_MON = '0x0000000000000000000000000000000000000000';
export const WMON_ADDRESS = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';

export const TOKENS: Record<string, TokenInfo> = {
  USDC: { symbol: 'USDC', address: '0x754704bc059f8c67012fed69bc8a327a5aafb603', decimals: 6, stable: true, usdtCross: 'USDCUSDT' },
  USDT0: { symbol: 'USDT0', address: '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', decimals: 6, stable: true }, // Tether's omnichain USDT — ≡ USDT, no cross
  AUSD: { symbol: 'AUSD', address: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', decimals: 6, stable: true }, // no CEX listing — $1 peg assumed
  USD1: { symbol: 'USD1', address: '0x111111d2bf19e43c34263401e0cad979ed1cdb61', decimals: 18, stable: true, usdtCross: 'USD1USDT' },
  WMON: { symbol: 'WMON', address: WMON_ADDRESS, decimals: 18, stable: false },
  MON: { symbol: 'MON', address: NATIVE_MON, decimals: 18, stable: false },
  WBTC: { symbol: 'WBTC', address: '0x0555e30da8f98308edb960aa94c0db47230d2b9c', decimals: 8, stable: false },
  WETH: { symbol: 'WETH', address: '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242', decimals: 18, stable: false },
  // Coinbase wrapped BTC (Hanji's BTC representation). NO CEX lists a cbBTC/BTC
  // basis pair, so cbBTC pairs use wrapBasisOverride: '' (parity — Coinbase 1:1
  // mint/redeem keeps it ~sub-bp) with a UI caveat, unlike WBTC's live WBTCBTC.
  CBBTC: { symbol: 'cbBTC', address: '0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b', decimals: 8, stable: false, baseAsset: 'BTC' },
};

/** A set of every token address that denotes MON (WMON wrapper + native MON). */
export const MON_ADDRESSES: ReadonlySet<string> = new Set([WMON_ADDRESS.toLowerCase(), NATIVE_MON]);

/** True if `addr` denotes MON in either representation. */
export function isMonAddress(addr: string): boolean {
  return MON_ADDRESSES.has(addr.toLowerCase());
}

/** True if a token symbol denotes MON (WMON or native MON). */
export function isMonSymbol(sym: string | undefined): boolean {
  return sym === 'WMON' || sym === 'MON';
}

/** Which CEX benchmarks an asset. MON (and any MON derivative) → Bybit (Binance
 *  has no MON spot); everything else → Binance at the VIP9 taker tier. */
export type CexId = 'bybit' | 'binance';

/**
 * A tradeable BASE asset. The dashboard is generic over base/quote: a venue pool
 * is `base`/`quote`, where `base` is one of these assets (priced by its `cex`)
 * and `quote` is a USD stable. `token` is the on-chain ERC-20 wrapper key in
 * TOKENS used for sizing/decoding (MON also has a native representation).
 */
export interface AssetSpec {
  /** asset key, also used as `Pair.base` (e.g. 'MON'|'BTC'|'ETH'). */
  key: string;
  /** display symbol (e.g. 'MON'). */
  symbol: string;
  /** ERC-20 wrapper token key in TOKENS (e.g. 'WMON'|'WBTC'|'WETH'). */
  token: string;
  /** CEX that prices/benchmarks this asset. */
  cex: CexId;
  /** the CEX spot symbol (e.g. 'MONUSDT'|'BTCUSDT'|'ETHUSDT'). */
  cexSymbol: string;
  /** CEX wrapped/native basis symbol (Binance): the on-chain asset is a WRAPPED
   *  representation, so the native reference is multiplied by this mid to show
   *  the CEX line in wrapped terms (e.g. BTC → 'WBTCBTC', ~−5bps live; pamm.wtf
   *  does the same). Unset when wrap ≡ native (WMON, canonical WETH). */
  wrapBasisSymbol?: string;
}

/** The base-asset registry. Add an asset here + a pool in an adapter to list it. */
export const ASSETS: Record<string, AssetSpec> = {
  MON: { key: 'MON', symbol: 'MON', token: 'WMON', cex: 'bybit', cexSymbol: 'MONUSDT' },
  BTC: { key: 'BTC', symbol: 'BTC', token: 'WBTC', cex: 'binance', cexSymbol: 'BTCUSDT', wrapBasisSymbol: 'WBTCBTC' },
  ETH: { key: 'ETH', symbol: 'ETH', token: 'WETH', cex: 'binance', cexSymbol: 'ETHUSDT' },
};

/** A tracked market: a base asset vs a quote. `symbol` is the display key used
 *  as `Fill.market` / `QuoteRow.market` (e.g. 'BTC/USDC'). The quote is a USD
 *  stable by default; `quoteKind: 'asset'` marks a crypto-quoted pair (e.g.
 *  MON/ETH), whose reference quote leg is the quote ASSET's own USDT mid. */
export interface Pair {
  symbol: string;
  /** base asset key (ASSETS). */
  base: string;
  /** quote key: a stable token (TOKENS) by default, or an asset (ASSETS) when
   *  `quoteKind: 'asset'`. */
  quote: string;
  /** 'asset' = crypto-quoted pair: refPx = baseUSDT × wrap ÷ quoteUSDT (the
   *  quote asset's own CEX mid replaces the stable's USDT cross). USD sizing
   *  uses the quote asset's live USD price instead of ≡$1. */
  quoteKind?: 'asset';
  /** override the BASE asset's wrap-basis CEX symbol for THIS pair — different
   *  venues trade different wrappers of one asset (Metric/Clober BTC = WBTC,
   *  live 'WBTCBTC' basis; Hanji BTC = cbBTC, no CEX basis pair → '' = parity).
   *  undefined = inherit ASSETS[base].wrapBasisSymbol. */
  wrapBasisOverride?: string;
}

/** The pair registry — THE tracked-market universe, the single source of truth.
 *  Adapters discover pools for exactly these pairs (and must not emit any other
 *  market), reference rows exist for exactly these, and markouts are routed by
 *  them. Venues quote/land fills on whichever they have a pool for; pairs no
 *  propAMM venue quotes are hidden by the UI. */
export const PAIRS: Pair[] = [
  { symbol: 'MON/USDC', base: 'MON', quote: 'USDC' },
  { symbol: 'BTC/USDC', base: 'BTC', quote: 'USDC' },
  { symbol: 'ETH/USDC', base: 'ETH', quote: 'USDC' },
  { symbol: 'MON/USDT0', base: 'MON', quote: 'USDT0' },
  { symbol: 'MON/AUSD', base: 'MON', quote: 'AUSD' },
  { symbol: 'MON/USD1', base: 'MON', quote: 'USD1' },
  { symbol: 'BTC/USDT0', base: 'BTC', quote: 'USDT0' },
  { symbol: 'BTC/AUSD', base: 'BTC', quote: 'AUSD' },
  { symbol: 'ETH/USDT0', base: 'ETH', quote: 'USDT0' },
  { symbol: 'ETH/AUSD', base: 'ETH', quote: 'AUSD' },
  // Hanji's markets (cbBTC ≠ WBTC — distinct market symbols so each wrapper
  // gets ITS OWN reference basis; sharing 'BTC/USDC' would mis-mark cbBTC by
  // the live WBTC basis). NB pairFor(base, quote) resolves the CANONICAL pair
  // (first match) — token-specific pairs like these are referenced by symbol.
  { symbol: 'cbBTC/USDC', base: 'BTC', quote: 'USDC', wrapBasisOverride: '' },
  { symbol: 'cbBTC/USDT0', base: 'BTC', quote: 'USDT0', wrapBasisOverride: '' },
  { symbol: 'cbBTC/AUSD', base: 'BTC', quote: 'AUSD', wrapBasisOverride: '' },
  { symbol: 'MON/ETH', base: 'MON', quote: 'ETH', quoteKind: 'asset' },
  { symbol: 'BTC/MON', base: 'BTC', quote: 'MON', quoteKind: 'asset' },
  { symbol: 'BTC/ETH', base: 'BTC', quote: 'ETH', quoteKind: 'asset' },
  { symbol: 'cbBTC/MON', base: 'BTC', quote: 'MON', quoteKind: 'asset', wrapBasisOverride: '' },
  { symbol: 'cbBTC/ETH', base: 'BTC', quote: 'ETH', quoteKind: 'asset', wrapBasisOverride: '' },
  // WBTC/cbBTC applies WBTCBTC to the WBTC base leg. The asset-quoted reference
  // uses native BTC for the cbBTC quote leg, so cbBTC parity is implicit rather
  // than a wrap-basis override.
  { symbol: 'WBTC/cbBTC', base: 'BTC', quote: 'BTC', quoteKind: 'asset' },
];

/** Market symbols (derived from the pair registry). */
export const MARKETS: readonly string[] = PAIRS.map((p) => p.symbol);
export type Market = string;

/** The base asset for a key ('MON'|'BTC'|'ETH'). */
export function assetOf(baseKey: string): AssetSpec | undefined {
  return ASSETS[baseKey];
}
/** The pair for a market symbol. */
export function pairOf(symbol: string): Pair | undefined {
  return PAIRS.find((p) => p.symbol === symbol);
}
/** The REGISTERED pair for a (base asset, stable quote) combo — undefined when
 *  the combo isn't in the tracked universe. Adapters gate discovery/decode on
 *  this so an unregistered market can never be emitted (it would have no
 *  reference rows and no markout routing). */
export function pairFor(baseKey: string, quoteSym: string): Pair | undefined {
  return PAIRS.find((p) => p.base === baseKey && p.quote === quoteSym);
}
/** The ERC-20 wrapper TokenInfo for a base asset (WMON/WBTC/WETH). */
export function baseTokenOf(baseKey: string): TokenInfo | undefined {
  const a = ASSETS[baseKey];
  return a ? TOKENS[a.token] : undefined;
}
/** The base asset denoted by an on-chain token address (native MON, WMON, WBTC,
 *  WETH, cbBTC). Replaces MON-specific checks so adapters are asset-generic;
 *  alternative wrappers resolve via `TokenInfo.baseAsset`. */
export function assetForToken(addr: string): AssetSpec | undefined {
  const a = addr.toLowerCase();
  if (isMonAddress(a)) return ASSETS.MON;
  const canonical = Object.values(ASSETS).find((as) => TOKENS[as.token]?.address.toLowerCase() === a);
  if (canonical) return canonical;
  const alt = Object.values(TOKENS).find((t) => t.baseAsset && t.address.toLowerCase() === a);
  return alt?.baseAsset ? ASSETS[alt.baseAsset] : undefined;
}

/** The BASE wrap-basis CEX symbol effective for a pair — the pair's override
 *  (''= parity, e.g. cbBTC) or the base asset's default (WBTC → 'WBTCBTC').
 *  Shared by the live reference, the historical markout series, and the UI's
 *  basis notes so the three can never disagree. */
export function wrapBasisFor(pair: Pair): string | undefined {
  const sym = pair.wrapBasisOverride !== undefined ? pair.wrapBasisOverride : ASSETS[pair.base]?.wrapBasisSymbol;
  return sym || undefined;
}
/** Which CEX benchmarks a base asset (default Bybit). */
export function cexForBase(baseKey: string): CexId {
  return ASSETS[baseKey]?.cex ?? 'bybit';
}

/** Notional sizes (USD) probed per pair×side in the exec matrix. */
export const SIZES_USD = [100, 1000, 10000, 100000] as const;

/** Markout horizons (seconds) joined to each pair's CEX reference (docs/architecture.md: fill stream). */
export const MARKOUT_HORIZONS = [0, 5, 10, 30, 60] as const;

// ──────────────────────────────────────────────────────────────────────────
// Quotes (Execution view, docs/architecture.md: quote poller)
// ──────────────────────────────────────────────────────────────────────────

/** One realized quote for (venue, market, size). bid/ask are in bps vs the
 *  pair's CEX BBO mid (Bybit for MON, Binance for BTC/ETH); px is quote-per-base
 *  (stable per base asset). */
export interface QuoteRow {
  /** which venue this quote belongs to (VenueMeta.id). */
  venueId: string;
  market: string;
  sizeUsd: number;
  bidBps: number;
  askBps: number;
  bidPx: number;
  askPx: number;
  /** ask − bid, the round-trip spread in bps. */
  spreadBps: number;
  /** false when the venue's liquidity exhausts before the full notional. */
  filledFull: boolean;
  /** true when only ONE side is executable at this size (the other side is thin /
   *  far-tick backstop): the shown side is real, the missing side is px 0 and
   *  spreadBps is not meaningful. Set by the Clober/Vault quoter (CLOB books that
   *  quote a genuine ask but no real bid at the requested size, or vice-versa). */
  oneSided?: boolean;
  /** venue fee in bps (e.g. POE getQuote fee); 0 for CLOB venues. */
  feeBps: number;
  /** realized cost vs the pair's CEX-AS-TAKER at this size, sign-normalized so
   *  positive = on-chain executes worse (docs/architecture.md: fill stream): cexAskBps for buying the
   *  base, cexBidBps for selling. The honest realized-vs-realized comparison.
   *  Undefined for the CEX benchmark row itself. */
  cexAskBps?: number;
  cexBidBps?: number;
  ts: number;
}

/** The full quote matrix for one poll — replaced wholesale each tick. */
export interface QuoteSnapshot {
  block: number;
  monUsd: number;
  ts: number;
  rows: QuoteRow[];
}

// ──────────────────────────────────────────────────────────────────────────
// Fills (Tape, Markouts, Leaderboard — docs/architecture.md: fill stream)
// ──────────────────────────────────────────────────────────────────────────

export interface Fill {
  id: string;
  /** which venue landed this fill (VenueMeta.id) — set by the venue's adapter. */
  venueId: string;
  market: string;
  side: Side;
  category: FillCategory;
  /** USD value of the stable quote leg (exact for base/stable pairs). */
  usd: number;
  /** base-asset amount of the fill (MON/BTC/ETH). */
  baseAmount: number;
  /** realized execution price, quote-per-base. */
  execPx: number;
  /** true when execPx/baseAmount are NOT a realized price (e.g. Clober's base
   *  leg needs the deferred tick→price; docs/architecture.md: fill stream). Such fills carry exact USD
   *  but no fill-quality markouts — consumers must not treat their markouts as
   *  real execution edge. */
  pxApprox?: boolean;
  txHash: string;
  /** human label for the `to`/router address. */
  to: string;
  /** brand of the known intermediary the tx entered through (tx.to) — e.g.
   *  'Relay', 'KyberSwap', '0x', a venue's own router name, or MEV-auction
   *  infrastructure ('FastLane', with category MEV). Set by attribution;
   *  absent = direct or unknown. */
  router?: string;
  /** pool/book label. */
  pool: string;
  blockNumber: number;
  ts: number;
  /** markout in bps vs the pair's CEX reference at [0,5,10,30,60]s; null until aged. */
  markoutsBps: (number | null)[];
}

// ──────────────────────────────────────────────────────────────────────────
// Volume (docs/architecture.md: data model)
// ──────────────────────────────────────────────────────────────────────────

/** One venue's slice of a day: USD notional + forward-indexed swap count.
 *  Seeded (backfilled) days may carry `usd` with `swaps: 0` when the source
 *  (e.g. a subgraph) exposes volume but not a per-swap count. */
export interface VenueDaily {
  usd: number;
  swaps: number;
}

export interface DailyVolume {
  /** UTC day, 'YYYY-MM-DD'. */
  utcDay: string;
  /** per-venue slice, keyed by VenueMeta.id. Venues absent from a day are 0. */
  byVenue: Record<string, VenueDaily>;
  /** true for today's still-accumulating bucket. */
  partial: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Quote-update gas burn ("QUOTE_UPDATE_BURN", Volume tab) — the MON each
// propAMM's own keeper spends keeping its quotes fresh (price pushes / book
// rebalances). Monad charges gas_limit (receipts report gasUsed == limit), so
// per-tx cost is exactly receipt.gasUsed × effectiveGasPrice. Venues whose
// quoting cost is NOT self-funded (external oracle, taker-paid JIT) simply
// have no series here.
// ──────────────────────────────────────────────────────────────────────────

/** One venue's quote-update burn for one UTC day. */
export interface VenueGasDaily {
  /** MON charged (gas_limit × effective price, summed over update txs). */
  mon: number;
  /** number of quote-update transactions. */
  txs: number;
}

export interface GasDay {
  utcDay: string;
  byVenue: Record<string, VenueGasDaily>;
  /** true for today's still-accumulating bucket. */
  partial: boolean;
}

export interface GasResponse {
  days: GasDay[];
  /** venue ids whose numbers are sampled estimates (block-sampling mode, no
   *  update events on-chain) — the UI prefixes them with ≈. */
  approx: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Leaderboard aggregates (docs/architecture.md: API) — computed SERVER-side over the FULL
// window. Shipping raw fills to the browser silently truncated the 7D/30D
// windows at the fetch cap (~20k fills ≈ <2 days at Metric's rate); the
// aggregation now runs where all the rows are. Windows align with pamm.wtf
// (1d/7d/30d) — markouts are a recent-execution-quality signal, not an
// all-time archive.
// ──────────────────────────────────────────────────────────────────────────

/** Aggregation windows (days) served by /api/leaderboard. */
export const LEADERBOARD_WINDOW_DAYS = [1, 7, 30] as const;

/** Horizon INDEXES (into MARKOUT_HORIZONS) the leaderboard aggregates over
 *  (T+0/10/30/60s — the UI's horizon pills). */
export const LEADERBOARD_HORIZON_IDX = [0, 2, 3, 4] as const;

/** Server-side group-by dimensions (the UI's GROUP BY pills). */
export const LEADERBOARD_GROUPINGS = ['protocol', 'pool', 'to', 'category'] as const;
export type LeaderboardGrouping = (typeof LEADERBOARD_GROUPINGS)[number];

/** One aggregated leaderboard row. All values are TAKER-signed; the MAKER view
 *  is a pure sign flip the client derives (pX' = −p(100−X), pnl' = −pnl,
 *  spark' = −spark), so the server never computes it twice. */
export interface LeaderboardGroupRow {
  /** group key: venueId (protocol) / pool / to-label / category ('direct' for DIRECT). */
  key: string;
  vol: number;
  swaps: number;
  /** markout-bps percentiles over the group's fills at the row's horizon. */
  p5: number; p25: number; p50: number; p75: number; p95: number;
  /** Σ(markout_bps × usd / 10⁴) — pool PnL at the row's horizon. */
  pnl: number;
  /** downsampled cumulative-PnL series (ts order) for the sparkline. */
  spark: number[];
}

export interface LeaderboardResponse {
  days: number;
  generatedAt: number;
  /** fills scanned in the window (pxApprox excluded) — the stats' true base. */
  totalFills: number;
  /** grouping → horizon index (string key) → top rows by volume. Only fills with
   *  a realized markout at that horizon feed a cell (nulls never coerced to 0). */
  groups: Record<LeaderboardGrouping, Record<string, LeaderboardGroupRow[]>>;
  /** horizon index → biggest single-swap winners/losers by TAKER PnL. Full fills
   *  so the client renders + re-signs them (MAKER winners = TAKER losers). */
  topSwaps: Record<string, { winners: Fill[]; losers: Fill[] }>;
  /** last-24h fills by |T+0 PnL| desc (the Markouts tab's OUTLIER_FEED). */
  outliers: Fill[];
}

/** Linear-interpolated percentile (p in [0,1]) — the ONE implementation shared
 *  by the server aggregation and any client-side math, so numbers never drift. */
export function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// ──────────────────────────────────────────────────────────────────────────
// Market state / service status
// ──────────────────────────────────────────────────────────────────────────

/** Live-source RPC failover status, per pool. Labels only ("primary",
 *  "backup-1", "archive", "archive-backup-1") — endpoint URLs embed keys and
 *  must never reach this public shape. */
export interface RpcStatus {
  /** label of the endpoint currently serving requests. */
  active: string;
  /** true while serving from a backup instead of the primary. */
  degraded: boolean;
  /** true when no endpoint is serving — chain data is frozen. */
  down: boolean;
  /** epoch ms when the primary was left (absent while on it). */
  degradedSinceTs?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// state.notes — developer-facing telemetry
// ──────────────────────────────────────────────────────────────────────────

/** How much a note matters. 'warn' means a maintainer should look: data is
 *  degraded, held or dropped. 'info' is lifecycle and progress. */
export type NoteLevel = 'info' | 'warn';

/**
 * Every note code, `<subsystem>.<event>`.
 *
 * The code, not the wording, is what a consumer filters, groups or alerts on,
 * so it is fixed where the note is raised: the emitter already knows which
 * event this is, and nothing downstream should have to rebuild that by
 * matching prose. `msg` is free text and may be reworded any time. The
 * subsystem prefix is load-bearing too: the notes window charges its overflow
 * to the noisiest subsystem (server/src/notes.ts).
 */
export type NoteCode =
  // RPC failover breaker (server/src/chain/failover.ts) — labels only.
  | 'rpc.failover' | 'rpc.down' | 'rpc.recovered' | 'rpc.endpoint.dropped'
  // venue adapters: discovery, market coverage, quoting, decode
  | 'venue.discovery' | 'venue.discovery.degraded' | 'venue.discovery.failed'
  | 'venue.market.unlisted' | 'venue.upgraded' | 'venue.quarantined'
  | 'venue.quote.unavailable' | 'venue.quote.recovered' | 'venue.gas.suspect'
  | 'venue.source.failed' | 'venue.decode.failed' | 'venue.foreign'
  // the live fill tail and its resume point
  | 'tail.resume' | 'tail.caughtup' | 'tail.gap.skipped' | 'tail.failed' | 'tail.timestamps.failed'
  // deep volume history: adapter seed + the on-chain replay
  | 'backfill.start' | 'backfill.done' | 'backfill.deferred' | 'backfill.held'
  | 'backfill.reset' | 'backfill.paused' | 'backfill.range.skipped' | 'backfill.config.invalid'
  // markout onboarding scan + the archived-price remark
  | 'markout.scan.start' | 'markout.scan.done' | 'markout.scan.held'
  | 'markout.remark.done' | 'markout.deferred' | 'markout.archive.pending' | 'markout.archive.published'
  | 'markout.paused' | 'markout.range.skipped' | 'markout.market.unregistered'
  // QUOTE_UPDATE_BURN accrual (server/src/gas.ts)
  | 'gas.scan.start' | 'gas.series.reset' | 'gas.scan.paused'
  | 'gas.range.skipped' | 'gas.destination.conflict' | 'gas.mode.mixed'
  // CEX reference feeds
  | 'reference.starved' | 'reference.recovered'
  // SQLite store migrations / persistence
  | 'store.migrated' | 'store.persist.failed'
  // the data source itself
  | 'source.sim';

/** The level each code is raised at. Level lives WITH the code, not at the
 *  call site, so one event cannot be a warning in one branch and an info line
 *  in another — that consistency is what makes `level` safe to alert on. A
 *  site that needs a different level needs a different code. */
export const NOTE_LEVEL: Record<NoteCode, NoteLevel> = {
  'rpc.failover': 'warn', 'rpc.down': 'warn', 'rpc.recovered': 'info', 'rpc.endpoint.dropped': 'warn',
  'venue.discovery': 'info', 'venue.discovery.degraded': 'warn', 'venue.discovery.failed': 'warn',
  'venue.market.unlisted': 'warn', 'venue.upgraded': 'warn', 'venue.quarantined': 'warn',
  'venue.quote.unavailable': 'warn', 'venue.quote.recovered': 'info', 'venue.gas.suspect': 'warn',
  'venue.source.failed': 'warn', 'venue.decode.failed': 'warn', 'venue.foreign': 'warn',
  'tail.resume': 'info', 'tail.caughtup': 'info', 'tail.gap.skipped': 'warn', 'tail.failed': 'warn', 'tail.timestamps.failed': 'warn',
  'backfill.start': 'info', 'backfill.done': 'info', 'backfill.deferred': 'info', 'backfill.held': 'info',
  'backfill.reset': 'info', 'backfill.paused': 'warn', 'backfill.range.skipped': 'warn', 'backfill.config.invalid': 'warn',
  'markout.scan.start': 'info', 'markout.scan.done': 'info', 'markout.scan.held': 'info',
  'markout.remark.done': 'info', 'markout.deferred': 'info', 'markout.archive.pending': 'info', 'markout.archive.published': 'info',
  'markout.paused': 'warn', 'markout.range.skipped': 'warn', 'markout.market.unregistered': 'warn',
  'gas.scan.start': 'info', 'gas.series.reset': 'info', 'gas.scan.paused': 'warn',
  'gas.range.skipped': 'warn', 'gas.destination.conflict': 'warn', 'gas.mode.mixed': 'warn',
  'reference.starved': 'warn', 'reference.recovered': 'info',
  'store.migrated': 'info', 'store.persist.failed': 'warn',
  'source.sim': 'info',
};

/** One entry of `MarketState.notes`. */
export interface StateNote {
  /** epoch ms the note was raised (not when it was served). */
  ts: number;
  level: NoteLevel;
  code: NoteCode;
  /** the venue id this note is about, when it is about one. */
  venue?: string;
  /** the sentence a human reads: sanitized (URLs stripped) and length-capped. */
  msg: string;
}

export interface MarketState {
  chainId: number;
  block: number;
  monUsd: number;
  monChangePct: number;
  takerBps: number;
  markets: string[];
  sizesUsd: number[];
  quoteCadenceMs: number;
  source: DataSourceMode;
  /** the venue registry (adapters + CEX reference) — the frontend renders
   *  everything venue-related from this, so venues aren't hardcoded client-side. */
  venues: VenueMeta[];
  /** the indexer's own telemetry, oldest first: degradations, held cursors and
   *  lifecycle. Served for maintainers, contributors and tooling debugging the
   *  service (docs/architecture.md: public notes); the dashboard does not
   *  render it. */
  notes?: StateNote[];
  /** RPC failover health (absent in sim — there is no RPC). */
  rpc?: RpcStatus;
  /** Deep-history RPC pool health — quote/tail freshness and history depth need
   *  different nodes, so they are separate failover pools (server config: RPC
   *  pools). Absent when no dedicated archive is configured (the pools are the
   *  same one) and in sim. */
  rpcArchive?: RpcStatus;
}

// ──────────────────────────────────────────────────────────────────────────
// REST payloads + WS stream protocol
// ──────────────────────────────────────────────────────────────────────────

export interface MarketsResponse {
  state: MarketState;
  quotes: QuoteSnapshot;
  fills: Fill[];
  volume: DailyVolume[];
}

export type StreamMessage =
  | { ch: 'state'; data: MarketState }
  | { ch: 'quotes'; data: QuoteSnapshot }
  | { ch: 'fill'; data: Fill }
  | { ch: 'volume'; data: DailyVolume };

export const STREAM_PATH = '/stream';
