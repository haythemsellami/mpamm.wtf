import { parseAbi } from 'viem';
import type { QuoteRow, Fill, Side, VenueMeta } from '@shared';
import { TOKENS, pairFor } from '@shared';
import { shortHex, toUnits } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';
import { createQuoteOutageLatch, quoteOutageReason, type MulticallOutcome, type QuoteOutage } from './quote-health.js';

/**
 * Crystal Vault adapter — Crystal is a multi-market on-chain CLOB (verified
 * `Crystal` 0x508254c8…, each market a CREATE2 `CrystalMarket` the core
 * delegatecalls, so every market's events are logged by the core with the
 * market in topic1). On WMON/USDC the passive side is the protocol's
 * CrystalVault 0x020f863a… ("MON/USDC by Crystal Labs"), repriced by its
 * owner-keeper through `execute()` — a propAMM quoting through a book, the
 * Hanji shape. Verified 2026-10-27 from the verified sources (CrystalMarket,
 * CrystalVault) and every Fill/Trade the market logged to 2026-10-26:
 *
 *   scope:  ONLY the vault's MAKER fills count. The book is open: 13 outside
 *           makers have rested orders on it, which makes it a raw CLOB with a
 *           vault on it, not a vault book — the out-of-scope case. Over its
 *           life to 2026-10-26 the vault made 72,711 of 73,261 maker fills
 *           and $8.69M of $8.76M (99.27% of the USDC leg); on 2026-09-29 only
 *           55%. The vault also TAKES: 303 trades ($53.7k, 263 on 09-29) where
 *           it sold or bought through outside makers' orders — its own
 *           arbitrage, not flow against its quotes, and never a self-trade.
 *           Counting every Trade would book those as venue volume. Hanji can
 *           count every aggressive fill only because its vault holds 100% of
 *           resting orders; Clober counts its vault books only. Counting the
 *           vault's legs keeps this venue the propAMM even if outside makers
 *           grow.
 *   fills:  `Fill(market, maker, fillInfo, fillAmount)`, one per maker order
 *           a taker consumes, then ONE `Trade(market, taker, isBuy, …)` per
 *           taker order, in that log order inside `_marketOrder` (the only
 *           place either is emitted). The vault's legs of a trade are summed
 *           into one fill keyed on the Trade's log index. Packing (source):
 *             fillInfo   = takerSells << 252 | price << 168 | orderId << 112 | left
 *             fillAmount = paidToMaker << 128 | paidToTaker
 *           A taker BUY pays USDC and receives WMON; a SELL the reverse.
 *   units:  the raw token amounts, so nothing market-specific: USDC 6 dp,
 *           WMON 18. A book price is raw = human × scaleFactor × 10^6 / 10^18
 *           (getMarket's scaleFactor 1e21 ⇒ 1e9); the fill legs reproduce
 *           their own price word, and are never derived from it.
 *   fees:   getMarket's takerFee/makerRebate are 1e5-scaled multipliers
 *           (100000 = none). The taker fee is taken in USDC around the legs
 *           (Trade.amountIn adds it on buys, amountOut nets it on sells), so a
 *           fill's USD is the GROSS USDC leg, as Hanji's. makerRebate shaves
 *           the taker's leg instead (99995 = 0.5bp to the maker); it is inside
 *           the legs, so execPx is the realized price. Live 2026-10-27: taker
 *           100000 (0bp), maker 99995; the market's first trade paid 3bp.
 *   quotes: Crystal.getQuote — the market's own taker walk (makerRebate and
 *           taker fee applied), so no client-side book model. The vault has
 *           no quote view of its own. worstPrice bounds the walk to
 *           ±PER_SIDE_BAND_BPS of the pair mid (see there).
 *   gas:    the keeper is the vault's immutable owner() 0xaf9ed4D3…; it sends
 *           only `execute` (0x61d59c2d) txs, only to the vault (1,500-block
 *           sample: 359 txs, ~0.24/block, none reverted, 250k–550k limits).
 *           The vault emits nothing itself, and the OrdersUpdated that Crystal
 *           logs for it is shared with every maker on every market, so it is
 *           'blocks' mode keyed on the vault.
 *
 * The vault can only trade ITS market, whose WMON/USDC tokens are immutable,
 * and `changeMarket()` can only move it to a new market for the same pair. So
 * a vault Fill on any market is WMON/USDC (tokens verified at discovery);
 * quotes follow `market()`, re-read at each discovery.
 */

// sinceUtc = the vault's first fill, 2026-09-22 15:42:44 UTC (block
// 107,073,783; the vault was created 2026-09-21 10:06, block 106,721,048).
// backfillFromUtc = the market's first trade (2026-09-20 06:20 UTC, a $5
// trade by an outside maker): the replay covers the whole book even though
// only the vault's legs count.
// color: raspberry in both themes. Green went to WOOFi (#00613A), which the
// first pick (#166534) sat ΔE2000 1.1 from under tritan simulation. Nearest
// neighbour now, across normal/protan/deutan/tritan: 9.7 (Capricorn, tritan)
// light and 8.1 (POE, tritan) dark; 11.7 / 15.2 from Capricorn and 17.5 /
// 18.3 from Hanji in normal vision. Contrast 6.2 / 4.6 on the two surfaces.
const CRYSTAL_VENUE: VenueMeta = { id: 'crystal', name: 'Crystal Vault', color: { light: '#AD2B62', dark: '#D14781' }, kind: 'clob', role: 'venue', sinceUtc: '2026-09-22' };

const CRYSTAL = '0x508254c838b2e936b0631440c5c6e3ab3a4a98bd' as const;
const CRYSTAL_VAULT = '0x020f863a6212a9ed5caa73a087e62acd371b7334' as const;

const BASE_TOK = 'WMON';
const QUOTE_TOK = 'USDC';

export const crystalAbi = parseAbi([
  'struct MarketInfo { address quoteAsset; address baseAsset; uint256 marketType; uint256 highestBid; uint256 lowestAsk; uint256 scaleFactor; uint256 tickSize; uint256 maxPrice; uint256 minSize; uint256 takerFee; uint256 makerRebate; uint256 reserveQuote; uint256 reserveBase; bool isAMMEnabled; }',
  'function getMarket(address market) view returns (MarketInfo info)',
  // nonpayable on-chain (it delegatecalls the market) but writes nothing:
  // declared view so it multicalls as a plain eth_call
  'function getQuote(address market, bool isBuy, bool isExactInput, bool isCompleteFill, uint256 size, uint256 worstPrice) view returns (uint256 amountIn, uint256 amountOut)',
  'event Fill(address indexed market, address indexed user, uint256 fillInfo, uint256 fillAmount)',
  'event Trade(address indexed market, address indexed user, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 startPrice, uint256 endPrice)',
]);
const vaultAbi = parseAbi([
  'function market() view returns (address)',
  'function quoteAsset() view returns (address)',
  'function baseAsset() view returns (address)',
]);

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

/** Per-side sanity band (bps from the pair mid), the Hanji/Clober convention,
 *  passed to getQuote as worstPrice. The book holds far-tick stub asks above
 *  the vault's ladder: at block 117,079,229 a $10k buy walked into them for a
 *  +6,500 bps "full" fill. With the band, a side whose in-band depth runs out
 *  is a PARTIAL (filledFull=false), and a side with none is absent. */
const PER_SIDE_BAND_BPS = 2_000;

const M128 = (1n << 128n) - 1n;

/** Why a frame that asked every leg produced no row. Every leg failing is
 *  the multicall reporter's case, worded the same way. Otherwise the book
 *  answered and holds nothing within the band at any size (a row needs only
 *  a partial fill), which is the vault's state, not an adapter fault. */
function crystalOutage(res: readonly MulticallOutcome[]): QuoteOutage {
  const name = CRYSTAL_VENUE.name;
  const all = quoteOutageReason(res);
  if (all) return { reason: all, msg: `${name} quotes unavailable — all ${res.length} legs failed with "${all}" (venue disabled, or the ABI drifted from the contract)` };
  const band = `within ±${PER_SIDE_BAND_BPS} bps of mid`;
  const failures = res.filter((r) => r.status === 'failure');
  if (failures.length) {
    const why = quoteOutageReason(failures)!; // every entry failed, so never null
    return { reason: `some getQuote calls failed with "${why}"`, msg: `${name} quotes unavailable — ${failures.length} of ${res.length} getQuote calls failed with "${why}", and no answered side fills ${band}` };
  }
  const reason = `no book side fills ${band}`;
  return { reason, msg: `${name} quotes unavailable — ${reason}: the vault's ladder is empty or priced away from mid, not an adapter fault` };
}

interface CrystalBook {
  market: `0x${string}`;
  /** human quote-per-base → raw book price (scaleFactor × 10^qDec / 10^bDec). */
  pxScale: number;
  feeBps: number;
}

export function createCrystalAdapter(): VenueAdapter {
  // the verdict is on executable rows, not reverts: every leg can answer and
  // still fill nothing in band, and that must not read as a recovery
  const reportOutage = createQuoteOutageLatch(CRYSTAL_VENUE.name);
  const pair = pairFor('MON', QUOTE_TOK);
  const base = TOKENS[BASE_TOK], quote = TOKENS[QUOTE_TOK];
  let book: CrystalBook | undefined;

  return {
    venues: () => [CRYSTAL_VENUE],
    quoteMarkets: () => (book && pair ? [pair.symbol] : []),
    backfillFromUtc: '2026-09-20',

    async discover(ctx: AdapterContext) {
      if (!pair) throw new Error('Crystal Vault: MON/USDC is not a registered pair');
      const [market, quoteAsset, baseAsset] = await ctx.client.multicall({
        contracts: (['market', 'quoteAsset', 'baseAsset'] as const).map((functionName) => ({ address: CRYSTAL_VAULT, abi: vaultAbi, functionName })),
        allowFailure: false,
      });
      const info = await ctx.client.readContract({ address: CRYSTAL, abi: crystalAbi, functionName: 'getMarket', args: [market] });
      // fail closed: every unit below assumes this exact token layout
      const lc = (a: string) => a.toLowerCase();
      if (lc(baseAsset) !== lc(base.address) || lc(quoteAsset) !== lc(quote.address)
        || lc(info.baseAsset) !== lc(base.address) || lc(info.quoteAsset) !== lc(quote.address)) {
        throw new Error(`Crystal Vault: vault ${baseAsset}/${quoteAsset} on market ${market} (${info.baseAsset}/${info.quoteAsset}) is not ${BASE_TOK}/${QUOTE_TOK}`);
      }
      const takerFeeBps = (100_000 - Number(info.takerFee)) / 10;
      const makerBps = (100_000 - Number(info.makerRebate)) / 10;
      if (book && book.market !== lc(market)) ctx.note('venue.upgraded', `Crystal Vault: vault moved from market ${book.market} to ${lc(market)}`);
      // the AMM leg would quote beside the vault; fills stay the vault's own
      if (info.isAMMEnabled) ctx.note('venue.discovery.degraded', `Crystal Vault: market ${lc(market)} has its AMM enabled — quotes include AMM liquidity`);
      book = {
        market: lc(market) as `0x${string}`,
        pxScale: Number(info.scaleFactor) * 10 ** quote.decimals / 10 ** base.decimals,
        feeBps: takerFeeBps,
      };
      ctx.note('venue.discovery', `Crystal Vault: ${pair.symbol} market ${shortHex(book.market)}, taker fee ${takerFeeBps}bps + maker ${makerBps}bps (on-chain)`);
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[], blockNumber: bigint, requestedMarkets?: ReadonlySet<string>): Promise<QuoteRow[]> {
      if (!book || !pair || (requestedMarkets && !requestedMarkets.has(pair.symbol))) return [];
      const b = book;
      const pxMid = ctx.pricer.pairMid(pair.symbol);
      if (pxMid <= 0) return [];
      const band = PER_SIDE_BAND_BPS / 1e4;
      const askLimit = BigInt(Math.floor(pxMid * (1 + band) * b.pxScale));
      const bidLimit = BigInt(Math.ceil(pxMid * (1 - band) * b.pxScale));

      // exact-input legs: buy spends USDC (asks), sell spends WMON (bids)
      const legs = sizesUsd.map((size) => ({
        size,
        buyIn: toUnits(ctx.pricer.tokenForUsd(QUOTE_TOK, size), quote.decimals),
        sellIn: toUnits(ctx.pricer.tokenForUsd(BASE_TOK, size), base.decimals),
      })).filter((l) => l.buyIn > 0n && l.sellIn > 0n);
      if (!legs.length) return [];
      const res = await ctx.client.multicall({
        contracts: legs.flatMap((l) => [
          { address: CRYSTAL, abi: crystalAbi, functionName: 'getQuote' as const, args: [b.market, true, true, false, l.buyIn, askLimit] as const },
          { address: CRYSTAL, abi: crystalAbi, functionName: 'getQuote' as const, args: [b.market, false, true, false, l.sellIn, bidLimit] as const },
        ]),
        allowFailure: true,
        blockNumber,
      });
      const rows: QuoteRow[] = [];
      const ts = Date.now();
      const human = (raw: bigint, dec: number) => Number(raw) / 10 ** dec;
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const buy = res[2 * i], sell = res[2 * i + 1];
        // amountIn falls short of the request when the in-band book runs out
        const [buyQ, buyB] = buy.status === 'success' ? buy.result : [0n, 0n];
        const [sellB, sellQ] = sell.status === 'success' ? sell.result : [0n, 0n];
        const hasAsk = buyQ > 0n && buyB > 0n, hasBid = sellB > 0n && sellQ > 0n;
        if (!hasAsk && !hasBid) continue;
        const askPx = hasAsk ? human(buyQ, quote.decimals) / human(buyB, base.decimals) : 0;
        const bidPx = hasBid ? human(sellQ, quote.decimals) / human(sellB, base.decimals) : 0;
        const full = (spent: bigint, req: bigint) => spent * 1000n >= req * 999n;
        rows.push({
          venueId: CRYSTAL_VENUE.id, market: pair.symbol, sizeUsd: l.size,
          askPx, bidPx,
          askBps: hasAsk ? (askPx / pxMid - 1) * 1e4 : 0,
          bidBps: hasBid ? (bidPx / pxMid - 1) * 1e4 : 0,
          spreadBps: hasAsk && hasBid ? ((askPx - bidPx) / pxMid) * 1e4 : 0,
          filledFull: (hasAsk ? full(buyQ, l.buyIn) : true) && (hasBid ? full(sellB, l.sellIn) : true),
          ...(hasAsk && hasBid ? {} : { oneSided: true }),
          feeBps: b.feeBps, ts,
        });
      }
      reportOutage(ctx, rows.length ? null : crystalOutage(res));
      return rows;
    },

    logSources() {
      if (!book) throw new Error('Crystal Vault discovery unavailable'); // hold the cursor until the vault's tokens are verified
      // every market's Fill/Trade (~4k logs/day in all); decode keeps the vault's
      return [{ key: 'book', address: CRYSTAL, events: [ev(crystalAbi, 'Fill'), ev(crystalAbi, 'Trade')], kind: 'fills' as const }];
    },

    // takers enter through Crystal itself (marketOrder, swap, the router-style
    // swapExact* entry points all live on the core contract)
    entryPoints: () => [{ address: CRYSTAL }],

    gasSources() {
      return [{ mode: 'blocks' as const, address: CRYSTAL_VAULT }];
    },

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      const raw = logs.book ?? [];
      if (!raw.length || !pair) return [];
      const sorted = [...raw].sort((x, y) => (x.blockNumber === y.blockNumber ? Number(x.logIndex) - Number(y.logIndex) : x.blockNumber < y.blockNumber ? -1 : 1));
      // the vault's legs per (tx, market), closed by that market's next Trade
      const open = new Map<string, Array<{ info: bigint; amount: bigint }>>();
      const out: Fill[] = [];
      for (const l of sorted) {
        const a = l.args;
        if (!a?.market) continue;
        const key = `${String(l.transactionHash).toLowerCase()}|${String(a.market).toLowerCase()}`;
        if (l.eventName === 'Fill') {
          if (String(a.user).toLowerCase() !== CRYSTAL_VAULT) continue;
          const legs = open.get(key) ?? [];
          legs.push({ info: BigInt(a.fillInfo), amount: BigInt(a.fillAmount) });
          open.set(key, legs);
          continue;
        }
        if (l.eventName !== 'Trade') continue;
        const legs = open.get(key);
        if (!legs) continue; // no vault leg: an outside maker's trade
        open.delete(key);
        // the vault as its own taker would be a wash (none on record)
        if (String(a.user).toLowerCase() === CRYSTAL_VAULT) continue;
        const side: Side = a.isBuy ? 'buy' : 'sell';
        if (legs.some((g) => ((g.info >> 252n) & 1n) !== (a.isBuy ? 0n : 1n))) {
          ctx.note('venue.decode.failed', `Crystal Vault: fill legs disagree with their Trade's side in ${l.transactionHash} — skipped`);
          continue;
        }
        let q = 0n, bse = 0n;
        for (const g of legs) {
          const toMaker = g.amount >> 128n, toTaker = g.amount & M128;
          if (a.isBuy) { q += toMaker; bse += toTaker; } else { bse += toMaker; q += toTaker; }
        }
        const baseAmount = Number(bse) / 10 ** base.decimals;
        const quoteAmount = Number(q) / 10 ** quote.decimals;
        if (baseAmount <= 0 || quoteAmount <= 0) continue;
        const usd = ctx.pricer.usdForToken(QUOTE_TOK, quoteAmount);
        if (usd <= 0) throw new Error('Crystal Vault: no USD price for USDC (feeds warming?)');
        out.push({
          id: `crystal-${String(l.transactionHash).toLowerCase()}-${l.logIndex}`,
          venueId: CRYSTAL_VENUE.id,
          market: pair.symbol, side,
          category: 'UNKNOWN',
          usd, baseAmount, execPx: quoteAmount / baseAmount,
          txHash: l.transactionHash, to: shortHex(String(a.user)),
          pool: `book ${String(a.market).slice(0, 8)}`,
          blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
          markoutsBps: [null, null, null, null, null],
        });
      }
      // a vault leg whose Trade never arrived: the bundle is incomplete
      // (_marketOrder always closes its fills with a Trade) — hold the cursor
      if (open.size) throw new Error(`Crystal Vault: ${open.size} vault fill group(s) without their Trade (first: ${[...open.keys()][0]})`);
      return out;
    },
  };
}
