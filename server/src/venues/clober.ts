import type { PublicClient } from 'viem';
import type { QuoteRow, Fill, Side, FillCategory, VenueMeta, Pair } from '@shared';
import { ADDR, TOKENS, ASSETS, PAIRS, pairFor, assetForToken, baseTokenOf } from '@shared';
import { bookViewerAbi, bookManagerAbi, liquidityVaultAbi, routerGatewayAbi, simpleOracleStrategyAbi, CLOBER_MIN_PRICE } from '../chain/abis.js';
import { fromUnits, toUnits, shortHex } from '../util.js';
import { KNOWN_ROUTERS } from '../attribution.js';
import type { UsdPricer } from '../pricer.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';

/** Clober display venue — the ONE venue this adapter surfaces. Its per-theme
 *  color is the single source of truth for the frontend. Displayed as plain
 *  "Clober": the oracle vault (their "Rebalancer" + Strategy) runs the books
 *  that carry 100.0% of Clober's lifetime volume (measured from their subgraph
 *  — non-vault books total ~$38k ever), so the vault IS the venue. The id keeps
 *  its historical value so persisted history survives the rename.
 *  sinceUtc = the vault books' true first trading day (their subgraph's
 *  earliest BookDayData — 2025-10-28), same anchor as backfillFromUtc. */
// color: sky in BOTH themes — the old light brown-gold sat next to Binance's
// gold, and the old dark lavender was near-identical to Hanji's and the UI
// accent purple. Palette validated (CVD/contrast, both surfaces).
const CLOBER_VAULT_VENUE: VenueMeta = { id: 'clober-vault', name: 'Clober', color: { light: '#0284C7', dark: '#0284C7' }, kind: 'vault', role: 'venue', sinceUtc: '2025-10-28' };

/**
 * Clober V2 — best-effort live integration (docs/architecture.md: propAMM scope, quote poller, fill stream), generic over
 * base/quote (MON/USDC, BTC/USDC, ETH/USDC — the vault runs mirror books for each).
 *
 * A Clober "market" (base/stable) is a pair of one-directional books; quoting
 * targets the book whose base == the input token. Deep discovery from the deploy
 * block is impractical on the public RPC (getLogs is range-capped), so this scans
 * recent Open logs to build a book cache + vault-bookId set; if that yields
 * nothing, Clober rows are simply absent (allowFailure, docs/architecture.md: operations). MON uses NATIVE
 * MON (zero address) on Clober; BTC/ETH use their ERC-20 (WBTC/WETH).
 */

const ZERO = '0x0000000000000000000000000000000000000000';
/** Per-side sanity band (bps from the CEX mid): a quote side priced beyond
 *  ±this is a far-tick backstop / mispriced resting order, not executable
 *  liquidity. Verified on-chain against live Clober vault books. */
const PER_SIDE_BAND_BPS = 2000;

export interface CloberBook {
  bookId: bigint;
  base: string;   // token address (lower)
  quote: string;
  unitSize: bigint;
  baseSym?: string;
  quoteSym?: string;
  isVault: boolean;
}

export interface CloberMarket {
  market: string;         // 'BTC/USDC'
  stable: string;
  baseAsset: string;      // ASSETS key ('MON'|'BTC'|'ETH')
  baseToken: string;      // wrapper TOKENS key ('WMON'|'WBTC'|'WETH') — for pricing/sizing
  baseDec: number;        // base asset decimals (WBTC = 8!)
  /** book with base = the base asset (quote = stable) — used to quote SELL base. */
  baseBook?: CloberBook;
  /** book with base = stable (quote = the base asset) — used to quote BUY base. */
  stableBook?: CloberBook;
}

const tokenBySym = (sym: string) => TOKENS[sym];
const symByAddr = (addr: string): string | undefined =>
  Object.values(TOKENS).find((t) => t.address.toLowerCase() === addr.toLowerCase())?.symbol;

type CloberSubgraphBookRow = { id: string; unitSize: string; base: { id: string }; quote: { id: string }; pool: { id: string } | null };

/** Assemble markets from a book cache for exactly the REGISTERED pairs (@shared
 *  PAIRS — the tracked universe), preferring the vault book per direction so
 *  venue attribution + quoting are consistent across every discovery path and
 *  live merge. Books for unregistered combos stay in the cache but never form a
 *  market (and decode drops their Takes). */
export function assembleCloberMarkets(books: Map<string, CloberBook>): CloberMarket[] {
  const markets: CloberMarket[] = [];
  for (const pair of PAIRS) {
    const asset = ASSETS[pair.base];
    const baseTok = baseTokenOf(pair.base);
    const t = TOKENS[pair.quote];
    if (!asset || !baseTok || !t?.stable) continue;
    const st = t.address.toLowerCase();
    let baseBook: CloberBook | undefined, stableBook: CloberBook | undefined;
    for (const b of books.values()) {
      const bBase = assetForToken(b.base), bQuote = assetForToken(b.quote);
      if (bBase?.key === asset.key && b.quote === st && (!baseBook || (b.isVault && !baseBook.isVault))) baseBook = b;
      if (b.base === st && bQuote?.key === asset.key && (!stableBook || (b.isVault && !stableBook.isVault))) stableBook = b;
    }
    if (baseBook || stableBook) markets.push({ market: pair.symbol, stable: t.symbol, baseAsset: asset.key, baseToken: asset.token, baseDec: baseTok.decimals, baseBook, stableBook });
  }
  return markets;
}

/** Build a base/stable CloberBook from an Open event's args; null if not base/stable. */
export function cloberBookFromOpen(a: any, vault: Set<string>): CloberBook | null {
  const base = String(a.base).toLowerCase(), quote = String(a.quote).toLowerCase();
  const bBase = assetForToken(base), bQuote = assetForToken(quote);
  if (!!bBase === !!bQuote) return null; // need exactly one base-asset side
  const baseSym = symByAddr(base), quoteSym = symByAddr(quote);
  const stableSym = bBase ? quoteSym : baseSym;
  if (!stableSym || !TOKENS[stableSym]?.stable) return null;
  const id = String(a.id);
  return {
    bookId: BigInt(a.id), base, quote, unitSize: BigInt(a.unitSize),
    baseSym, quoteSym, isVault: vault.has(id),
  };
}

/** Build a book cache + vault set from recent Open logs, then assemble the
 *  base/stable markets we can quote. `lookback` blocks back from head. */
export async function discoverClober(client: PublicClient, getLogs: AdapterContext['getLogs'], lookback = 4000): Promise<{ books: Map<string, CloberBook>; markets: CloberMarket[]; vault: Set<string> }> {
  const head = await client.getBlockNumber();
  const from = head > BigInt(lookback) ? head - BigInt(lookback) : 0n;
  const books = new Map<string, CloberBook>();
  const vault = new Set<string>();

  try {
    const vlogs = (await getLogs({
      address: ADDR.liquidityVault as `0x${string}`, fromBlock: from, toBlock: head,
      events: liquidityVaultAbi.filter((x: any) => x.type === 'event'),
    })) as any[];
    for (const l of vlogs) {
      if (l.args?.bookIdA !== undefined) vault.add(String(l.args.bookIdA));
      if (l.args?.bookIdB !== undefined) vault.add(String(l.args.bookIdB));
    }
  } catch { /* tolerate */ }

  try {
    const opens = (await getLogs({
      address: ADDR.bookManager as `0x${string}`, fromBlock: from, toBlock: head,
      events: bookManagerAbi.filter((x: any) => x.type === 'event' && x.name === 'Open'),
    })) as any[];
    for (const l of opens) {
      const a = l.args; if (!a) continue;
      const id = String(a.id);
      const b = cloberBookFromOpen(a, vault);
      if (b) books.set(id, b);
    }
  } catch { /* tolerate */ }

  return { books, markets: assembleCloberMarkets(books), vault };
}

/**
 * Discover Clober books from the subgraph (docs/architecture.md: history) — the public RPC
 * can't enumerate them. Yields each base/stable book's id + base/quote + unitSize,
 * and `Book.pool != null` marks vault (propAMM) books. Live quotes and fills then
 * hit the chain (getExpectedOutput / Take logs).
 */
export async function discoverCloberViaSubgraph(
  url: string,
): Promise<{ books: Map<string, CloberBook>; markets: CloberMarket[]; vault: Set<string> }> {
  const addrs = Object.values(TOKENS).map((t) => `"${t.address.toLowerCase()}"`).join(',');
  const rows: CloberSubgraphBookRow[] = [];
  for (let skip = 0; ; skip += 500) {
    const query = `{ books(first: 500, skip: ${skip}, orderBy: id, orderDirection: asc, where: { base_in: [${addrs}], quote_in: [${addrs}] }) { id unitSize base { id } quote { id } pool { id } } }`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`subgraph ${res.status}`);
    const j: any = await res.json();
    if (Array.isArray(j?.errors) && j.errors.length) throw new Error(`subgraph GraphQL error: ${j.errors[0]?.message ?? 'unknown'}`);
    const page = j?.data?.books as CloberSubgraphBookRow[] | undefined;
    if (!Array.isArray(page)) throw new Error('subgraph response missing books');
    rows.push(...page);
    if (page.length < 500) break;
  }

  const books = new Map<string, CloberBook>();
  const vault = new Set<string>();
  for (const r of rows) {
    const { id, book, isVault } = parseSubgraphBook(r);
    if (book) books.set(id, book);
    if (book && isVault) vault.add(id);
  }

  return { books, markets: assembleCloberMarkets(books), vault };
}

/** Resolve specific vault book ids when a live Vault.Open did not arrive with its
 *  BookManager.Open — distinguishes out-of-scope vault books from base/stable books
 *  without silently dropping a fill. */
export async function discoverCloberBooksById(
  url: string,
  ids: string[],
): Promise<{ books: Map<string, CloberBook>; ignored: Set<string>; missing: Set<string> }> {
  const unique = [...new Set(ids)];
  if (!unique.length) return { books: new Map(), ignored: new Set(), missing: new Set() };
  for (const id of unique) if (!/^\d+$/.test(id)) throw new Error(`invalid Clober book id ${id}`);

  const books = new Map<string, CloberBook>();
  const ignored = new Set<string>();
  const missing = new Set(unique);
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const idset = batch.map((id) => `"${id}"`).join(',');
    const query = `{ books(first: ${batch.length}, where: { id_in: [${idset}] }) { id unitSize base { id } quote { id } pool { id } } }`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`subgraph ${res.status}`);
    const j: any = await res.json();
    if (Array.isArray(j?.errors) && j.errors.length) throw new Error(`subgraph GraphQL error: ${j.errors[0]?.message ?? 'unknown'}`);
    const rows = j?.data?.books as CloberSubgraphBookRow[] | undefined;
    if (!Array.isArray(rows)) throw new Error('subgraph response missing books');

    for (const r of rows) {
      const { id, book, isVault } = parseSubgraphBook(r);
      missing.delete(id);
      if (!isVault) {
        missing.add(id);
      } else if (book) {
        books.set(id, book);
      } else {
        ignored.add(id);
      }
    }
  }
  return { books, ignored, missing };
}

function parseSubgraphBook(r: CloberSubgraphBookRow): { id: string; book: CloberBook | null; isVault: boolean } {
  const base = String(r.base.id).toLowerCase();
  const quote = String(r.quote.id).toLowerCase();
  const id = String(BigInt(r.id));
  const isVault = !!r.pool;
  // keep exactly base/stable: one side a tracked base asset, the other a stable
  const bBase = assetForToken(base), bQuote = assetForToken(quote);
  if (!!bBase === !!bQuote) return { id, book: null, isVault };
  const baseSym = symByAddr(base), quoteSym = symByAddr(quote);
  const stableSym = bBase ? quoteSym : baseSym;
  if (!stableSym || !TOKENS[stableSym]?.stable) return { id, book: null, isVault };
  return {
    id,
    isVault,
    book: {
      bookId: BigInt(r.id), base, quote, unitSize: BigInt(r.unitSize),
      baseSym, quoteSym, isVault,
    },
  };
}

/** Quote Clober for each market × size via BookViewer.getExpectedOutput. */
export async function quoteClober(
  client: PublicClient, markets: CloberMarket[], sizesUsd: readonly number[], pricer: UsdPricer,
  blockNumber: bigint,
): Promise<QuoteRow[]> {
  if (!markets.length) return [];
  type Leg = { market: string; size: number; side: Side; book: CloberBook; inDec: number; outDec: number; reqBase: bigint; basePx: number };
  const legs: Leg[] = [];
  for (const m of markets) {
    // bps anchor = the pair-terms CEX mid (wrap basis + stable cross applied),
    // NOT the raw USDT price — book quotes are in the pair's stable terms.
    const basePx = pricer.pairMid(m.market);
    if (basePx <= 0) continue;
    const stable = tokenBySym(m.stable);
    for (const size of sizesUsd) {
      if (m.baseBook) {
        // SELL base: spend base → take quote(stable)
        legs.push({ market: m.market, size, side: 'sell', book: m.baseBook, inDec: m.baseDec, outDec: stable.decimals, reqBase: toUnits(pricer.tokenForUsd(m.baseToken, size), m.baseDec), basePx });
      }
      if (m.stableBook) {
        // BUY base: spend base(stable) → take quote(base asset)
        legs.push({ market: m.market, size, side: 'buy', book: m.stableBook, inDec: stable.decimals, outDec: m.baseDec, reqBase: toUnits(size, stable.decimals), basePx });
      }
    }
  }
  if (!legs.length) return [];

  const contracts = legs.map((l) => ({
    address: ADDR.bookViewer as `0x${string}`,
    abi: bookViewerAbi,
    functionName: 'getExpectedOutput' as const,
    args: [{ id: l.book.bookId, limitPrice: CLOBER_MIN_PRICE, baseAmount: l.reqBase, minQuoteAmount: 0n, hookData: '0x' as `0x${string}` }] as const,
  }));
  const res = await client.multicall({ contracts, allowFailure: true, blockNumber });

  const rowByKey = new Map<string, QuoteRow>();
  const fullByKey = new Map<string, { bid: boolean; ask: boolean }>();
  const ts = Date.now();
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]; const r = res[i];
    if (r.status !== 'success') continue;
    const [takenQuote, spentBase] = r.result as readonly [bigint, bigint];
    if (takenQuote <= 0n || spentBase <= 0n) continue;
    const takenH = fromUnits(takenQuote, l.outDec);
    const spentH = fromUnits(spentBase, l.inDec);
    // px = stable per base, over the FILLED portion only. limitPrice = MIN, so a
    // thin book sweeps to far ticks and the average price craters — the per-side
    // sanity check below catches that (and partial fills via filledFull, B3).
    const px = l.side === 'sell' ? takenH / spentH : spentH / takenH;
    const bps = (px / l.basePx - 1) * 1e4;
    const legFilledFull = spentBase >= (l.reqBase * 999_999_999n) / 1_000_000_000n;
    const key = `${l.market}|${l.size}`;
    let row = rowByKey.get(key);
    if (!row) {
      row = { venueId: CLOBER_VAULT_VENUE.id, market: l.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
      rowByKey.set(key, row);
      fullByKey.set(key, { bid: false, ask: false });
    }
    const fk = fullByKey.get(key)!;
    if (l.side === 'buy') { row.askBps = bps; row.askPx = px; fk.ask = legFilledFull; }
    else { row.bidBps = bps; row.bidPx = px; fk.bid = legFilledFull; }
  }

  // A side is executable at this size only if it fills the full notional AND
  // prices within ±PER_SIDE_BAND_BPS of mid. Both real → a two-sided row; exactly
  // one real → a one-sided row (thin side zeroed, flagged); neither → dropped.
  const out: QuoteRow[] = [];
  for (const [key, row] of rowByKey) {
    const fk = fullByKey.get(key)!;
    row.spreadBps = row.askBps - row.bidBps;
    const bidReal = row.bidPx > 0 && fk.bid && Math.abs(row.bidBps) <= PER_SIDE_BAND_BPS;
    const askReal = row.askPx > 0 && fk.ask && Math.abs(row.askBps) <= PER_SIDE_BAND_BPS;
    if (bidReal && askReal) {
      row.oneSided = false;
      row.filledFull = fk.bid && fk.ask;
      out.push(row);
    } else if (bidReal !== askReal) {
      row.oneSided = true;
      row.filledFull = bidReal ? fk.bid : fk.ask;
      if (!bidReal) { row.bidPx = 0; row.bidBps = 0; }
      if (!askReal) { row.askPx = 0; row.askBps = 0; }
      row.spreadBps = 0; // not meaningful for a one-sided quote
      out.push(row);
    }
  }
  return out;
}

/** routed-flow attribution for a Take (its tx also emitted a RouterGateway.Swap). */
export interface RouterInfo { to: string; category: FillCategory; router?: string; }

/**
 * Clober V2 tick → realized price, stable-per-base. price(tick) = 1.0001^tick =
 * quote-raw per base-raw; human stable-per-base = 1.0001^(±tick) × 10^(baseDec −
 * stableDec) (+ when the base asset is the book's base, − when it's the quote).
 * Generic over base decimals — WBTC (8d) needs the real baseDec, not a fixed 18.
 */
export function cloberTickToPrice(tick: number, baseIsBookBase: boolean, stableDec: number, baseDec: number): number {
  return Math.pow(1.0001, baseIsBookBase ? tick : -tick) * Math.pow(10, baseDec - stableDec);
}

/**
 * The REGISTERED pair a book trades, or null: exactly one side a tracked base
 * asset, the other a real stable, and the (base, stable) combo in @shared PAIRS
 * (audit C1 + review "unregistered markets"). This is THE gate for what Clober
 * volume counts — shared by live decode AND the subgraph backfill seed, so a
 * book that live decode would drop can never leak into closed-day volume.
 */
function registeredBookPair(book: CloberBook): { pair: Pair; baseIsBookBase: boolean; baseDec: number; stableSym: string; stableDec: number } | null {
  const baseSideAsset = assetForToken(book.base);
  const quoteSideAsset = assetForToken(book.quote);
  if (!!baseSideAsset === !!quoteSideAsset) return null;
  const baseIsBookBase = !!baseSideAsset;
  const asset = (baseIsBookBase ? baseSideAsset : quoteSideAsset)!;
  const baseTok = baseTokenOf(asset.key);
  if (!baseTok) return null;
  const stableSym = baseIsBookBase ? book.quoteSym : book.baseSym;
  if (!stableSym || !TOKENS[stableSym]?.stable) return null;
  const pair = pairFor(asset.key, stableSym);
  if (!pair) return null;
  return { pair, baseIsBookBase, baseDec: baseTok.decimals, stableSym, stableDec: TOKENS[stableSym].decimals };
}

/**
 * Decode a Clober Take into a Fill (docs/architecture.md: fill stream). The quote leg is exact
 * (unit × unitSize); the realized price + base leg come from the resting tick, so
 * the fill carries a true execution price and real markouts (audit B1-real).
 */
export function decodeCloberTake(
  log: { args: any; transactionHash: string; blockNumber: bigint; logIndex: number },
  books: Map<string, CloberBook>, tsMs: number, router?: RouterInfo,
): Fill | null {
  const a = log.args; if (!a) return null;
  const bookId = String(a.bookId);
  const book = books.get(bookId);
  if (!book) return null;

  // registered base/stable books only (shared gate — see registeredBookPair).
  const reg = registeredBookPair(book);
  if (!reg) return null;
  const { pair, baseIsBookBase, baseDec, stableDec } = reg;

  // quote leg is exact (unit × unitSize); quote token = stable iff the base asset
  // is the book's base, else it's the base asset (so use baseDec for that side).
  const quoteDec = baseIsBookBase ? stableDec : baseDec;
  const quoteHuman = fromUnits(BigInt(a.unit) * book.unitSize, quoteDec);
  if (quoteHuman <= 0) return null;

  const execPx = cloberTickToPrice(Number(a.tick), baseIsBookBase, stableDec, baseDec);
  if (!Number.isFinite(execPx) || execPx <= 0) return null;

  // USD = the stable leg: exact when the base asset is base (quote IS the stable);
  // else derive the stable value from the realized price. No CEX mid needed.
  const usd = baseIsBookBase ? quoteHuman : quoteHuman * execPx;
  const baseAmount = usd / execPx; // base-asset amount
  if (usd <= 0) return null;

  // A Clober book is one-directional: a Take consumes resting orders, so side
  // follows the book's orientation.
  const side: Side = baseIsBookBase ? 'sell' : 'buy';

  return {
    // deterministic id (txHash:logIndex) so re-tail/gap-fill/restart dedupes.
    id: `clb-${log.transactionHash.toLowerCase()}-${log.logIndex}`,
    venueId: CLOBER_VAULT_VENUE.id,
    // routed → the gateway's evidence (with the external router's brand when
    // known); else UNKNOWN — "no gateway event" is NOT proof of a direct hit
    // (searcher contracts reach the books without the gateway). The core
    // attributor upgrades UNKNOWN to DIRECT via tx.to == controller/bookManager.
    market: pair.symbol, side, category: router?.category ?? 'UNKNOWN',
    ...(router?.router ? { router: router.router } : {}),
    usd, baseAmount, execPx,
    txHash: log.transactionHash, to: router?.to ?? shortHex(a.user ?? ZERO),
    pool: `book ${bookId.slice(0, 8)}`,
    blockNumber: Number(log.blockNumber), ts: tsMs,
    markoutsBps: [null, null, null, null, null],
  };
}

/** Map txHash → routed-flow attribution from RouterGateway.Swap logs (audit I3). */
export function buildRouterMap(logs: Array<{ args: any; transactionHash: string }>): Map<string, RouterInfo> {
  const m = new Map<string, RouterInfo>();
  for (const l of logs) {
    const a = l.args; if (!a) continue;
    const ext = String(a.router ?? ZERO).toLowerCase();
    const brand = KNOWN_ROUTERS.get(ext);
    m.set(l.transactionHash.toLowerCase(), { to: shortHex(String(a.router ?? ZERO)), category: 'ROUTER', ...(brand ? { router: brand } : {}) });
  }
  return m;
}

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

/**
 * Clober oracle-vault adapter — a MIXED-source venue: subgraph for discovery +
 * closed-day backfill, the chain for live quotes + fills. Vault (propAMM) books
 * only; non-vault Clober flow is ignored (this venue IS the vault).
 */
export function createCloberVaultAdapter(): VenueAdapter {
  let books = new Map<string, CloberBook>();   // vault-only book cache
  let vault = new Set<string>();
  let ignoredVaultBooks = new Set<string>();   // vault books known to be outside base/stable scope
  let markets: CloberMarket[] = [];
  let authoritativeDiscovery = false;

  const mergeVaultBooks = (vaultOpens: any[], bmOpens: any[]): void => {
    for (const l of vaultOpens) {
      const a = l.args; if (!a) continue;
      if (a.bookIdA !== undefined) vault.add(String(a.bookIdA));
      if (a.bookIdB !== undefined) vault.add(String(a.bookIdB));
    }
    let changed = false;
    for (const l of bmOpens) {
      const a = l.args; if (!a) continue;
      const id = String(a.id);
      if (!vault.has(id) || books.has(id)) continue;   // vault-only + not already cached
      const b = cloberBookFromOpen(a, vault);           // null if not base/stable
      if (b) { books.set(id, b); ignoredVaultBooks.delete(id); changed = true; }
      else ignoredVaultBooks.add(id);
    }
    if (changed) markets = assembleCloberMarkets(books);
  };

  return {
    venues: () => [CLOBER_VAULT_VENUE],
    // Full venue-lifetime volume + swap counts by replaying Take on-chain from
    // the vault books' first trading day — the same pattern as every other
    // venue. This REPLACED the old subgraph volume seed, which (a) started at
    // the dashboard's launch date (2026-05-13) and silently hid the venue's
    // $230M pre-May history, and (b) carried no swap counts. The subgraph is
    // still used for what it is authoritative for: vault-book DISCOVERY.
    backfillFromUtc: '2025-10-28',
    async discover(ctx: AdapterContext) {
      let disc: { books: Map<string, CloberBook>; markets: CloberMarket[]; vault: Set<string> };
      let authoritative = false;
      try {
        disc = await discoverCloberViaSubgraph(ctx.config.subgraphUrl);
        authoritative = true;
        ctx.note('venue.discovery', `Clober: subgraph discovery (${disc.vault.size} vault book(s))`);
      } catch {
        ctx.note('venue.discovery.degraded', 'Clober: subgraph discovery failed; trying recent Open logs');
        try { disc = await discoverClober(ctx.client, ctx.getLogs, 2000); } catch { disc = { books: new Map(), markets: [], vault: new Set() }; }
      }
      // MERGE (don't replace): a periodic re-discovery can only ADD/refresh vault
      // books, never wipe the cache on a transient subgraph/RPC failure (review #2).
      for (const id of disc.vault) vault.add(id);
      for (const [id, b] of disc.books) if (b.isVault) { books.set(id, b); ignoredVaultBooks.delete(id); }
      markets = assembleCloberMarkets(books);
      if (authoritative) authoritativeDiscovery = true;
      else if (!authoritativeDiscovery) {
        ctx.note('venue.discovery.degraded', 'Clober: authoritative discovery unavailable; holding Take ranges until rediscovery succeeds');
      }
    },
    quote(ctx, sizesUsd, blockNumber, requestedMarkets) {
      const selected = requestedMarkets ? markets.filter((m) => requestedMarkets.has(m.market)) : markets;
      return quoteClober(ctx.client, selected, sizesUsd, ctx.pricer, blockNumber);
    },
    // QUOTE_UPDATE_BURN: the vault's quotes live on the books, and every
    // repricing is one keeper tx through the operator contract that emits
    // SimpleOracleStrategy.UpdatePosition. One event per (key, update); the
    // tracker dedupes to unique txs, so a multi-pair update is counted once.
    // PROVENANCE (deep-reviewed 2026-07-10): strategy + operator + vault are
    // the official Monad deployments in clober-dex/clober-liquidity-vault's
    // README; updatePosition is onlyOperator in source and the event topic0
    // is keccak-matched. COMPLETENESS: operator↔UpdatePosition txs are 1:1
    // on-chain (no non-emitting keeper path), and the strategy's
    // referenceOracle (their README ChainlinkOracle) is a read-through feed —
    // zero dedicated txs/logs, so no Clober-funded update gas exists outside
    // this destination. Blind spot: reverted keeper txs (no logs) undercount.
    gasSources() {
      return [{ mode: 'logs' as const, address: ADDR.simpleOracleStrategy as `0x${string}`, events: [ev(simpleOracleStrategyAbi, 'UpdatePosition')] }];
    },
    logSources() {
      return [
        { key: 'take', address: ADDR.bookManager as `0x${string}`, events: [ev(bookManagerAbi, 'Take')], kind: 'fills' as const },
        // Opens are decoding STATE — a missed vault-book Open makes that book's later
        // Takes undecodable, so an Opens fetch failure HOLDS the cursor (review #2).
        { key: 'bmOpen', address: ADDR.bookManager as `0x${string}`, events: [ev(bookManagerAbi, 'Open')], kind: 'state' as const },
        { key: 'vaultOpen', address: ADDR.liquidityVault as `0x${string}`, events: [ev(liquidityVaultAbi, 'Open')], kind: 'state' as const },
        // router tags are attribution only — when unavailable, Takes decode as UNKNOWN.
        { key: 'router', address: ADDR.routerGateway as `0x${string}`, events: [ev(routerGatewayAbi, 'Swap')], kind: 'attribution' as const },
      ];
    },

    // taker entries owned by Clober: a tx entering at the controller or the
    // book manager is a direct trade (the gateway path is evidenced above).
    entryPoints: () => [{ address: ADDR.controller }, { address: ADDR.bookManager }],
    async decode(ctx: AdapterContext, logs: LogBundle, tsOf, failed: Set<string>) {
      if (!authoritativeDiscovery && (logs.take?.length ?? 0) > 0) {
        throw new Error('authoritative vault-book discovery unavailable');
      }
      mergeVaultBooks(logs.vaultOpen ?? [], logs.bmOpen ?? []);
      const missingVaultBookIds = [...new Set((logs.take ?? [])
        .map((l) => (l.args?.bookId === undefined ? undefined : String(l.args.bookId)))
        .filter((id): id is string => !!id && vault.has(id) && !books.has(id) && !ignoredVaultBooks.has(id)))];
      if (missingVaultBookIds.length) {
        const resolved = await discoverCloberBooksById(ctx.config.subgraphUrl, missingVaultBookIds);
        let changed = false;
        for (const [id, b] of resolved.books) { books.set(id, b); ignoredVaultBooks.delete(id); changed = true; }
        for (const id of resolved.ignored) ignoredVaultBooks.add(id);
        if (changed) markets = assembleCloberMarkets(books);
        const unresolved = missingVaultBookIds.filter((id) => !books.has(id) && !ignoredVaultBooks.has(id));
        if (unresolved.length || resolved.missing.size) throw new Error(`missing metadata for vault book ${unresolved[0] ?? [...resolved.missing][0]}`);
      }
      const routerMap = buildRouterMap(logs.router ?? []);
      const out: Fill[] = [];
      for (const l of logs.take ?? []) {
        const bookId = l.args?.bookId === undefined ? undefined : String(l.args.bookId);
        if (bookId && vault.has(bookId) && !books.has(bookId) && !ignoredVaultBooks.has(bookId)) {
          throw new Error(`missing metadata for vault book ${bookId}`);
        }
        const f = decodeCloberTake(l, books, tsOf(l.blockNumber), routerMap.get(String(l.transactionHash).toLowerCase()));
        if (f) out.push(f);
      }
      return out;
    },
  };
}
