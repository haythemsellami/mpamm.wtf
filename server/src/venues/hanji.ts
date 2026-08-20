import { parseAbi } from 'viem';
import type { QuoteRow, Fill, Side, VenueMeta } from '@shared';
import { TOKENS, pairOf } from '@shared';
import { shortHex } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';
import { createQuoteOutageReporter } from './quote-health.js';

/**
 * Hanji adapter — a fully on-chain LOB whose ENTIRE passive side is the
 * protocol's LP vault (verified on-chain: 100% of resting orders on the sampled
 * books are owned by the LPManager), i.e. a propAMM quoting through an order
 * book. Integration per the Hanji team's brief, with every unit VERIFIED
 * against live fills before shipping:
 *
 *   quotes:  FastQuoterHelper.assembleOrderbooksFromOrders(PROXY, levels) — the
 *            proxy view includes the vault's virtual liquidity (their guidance).
 *   fills:   OrderPlaced on the CLOBs where aggressive_shares > 0. The event's
 *            `price` is the LIMIT price (market orders carry sentinels — never
 *            use it); realized price = aggressive_value / filled base (VWAP).
 *   units:   everything is in SHARES, scaled per market by getConfig():
 *              baseHuman  = shares × scalingX / 10^xDec
 *              quoteHuman = value  × scalingY / 10^yDec
 *              humanPrice = raw × (scalingY/10^yDec) ÷ (scalingX/10^xDec)
 *            (the derived price scale reproduces Hanji's published priceScale on
 *            all six markets; 30/30 sampled fills matched book mids to <2%).
 *   fees:    getConfig()[9] is the taker rate in 1e18 scale (1e14 = 1bp live on
 *            every market — matches aggressive_fee/aggressive_value exactly).
 *
 * Scaling factors, token layout and fees are read ON-CHAIN at discovery and
 * checked against the expected token addresses — a config drift fails loud
 * instead of silently mispricing. BTC markets trade cbBTC (not WBTC), so they
 * map to the dedicated cbBTC/* pairs (parity wrap basis — no CEX lists a
 * cbBTC/BTC pair; see @shared PAIRS).
 */

// sinceUtc = the CLOBs' on-chain deploy day (blocks 79242115–79242169, bisected).
// color: fuchsia in BOTH themes — the old dark lavender was near-identical to
// Clober's and to the UI accent purple. Palette validated (CVD/contrast).
// `id` stays 'hanji': it is the DB key for this venue's volume/fills/gas history
// and the frontend lookup key, so only the display name moves.
const HANJI_VENUE: VenueMeta = { id: 'hanji', name: 'Hanji pAMM Vault', color: { light: '#A21CAF', dark: '#C026D3' }, kind: 'clob', role: 'venue', sinceUtc: '2026-06-05' };

const FAST_QUOTER_HELPER = '0x237dB58fea34A35A8543b44C217d221606cE7788' as const;

/** The FastQuoter — Hanji's propAMM engine (team brief). Its quotes are priced
 *  off `externalPrices` (FP24-packed bid/ask ×5 pairs + expiry) that Hanji's
 *  keeper writes via `updatePrices(uint256)` (sel 0xae7e8d81) every ~1s from
 *  HEAVILY ROTATING EOAs (87 senders observed in 4 min) — which is exactly why
 *  gas tracking is destination-keyed. Updates emit NO logs, and every direct
 *  tx to a quoter is a price update (254/254, 317/317 and 38/38 sampled across
 *  three generations), so blocks-mode tx counting is exact-in-kind.
 *  Provenance: team-provided update tx 0x2b17b095… decoded against their
 *  published packing.
 *
 *  GENERATIONS: Hanji redeploys the FastQuoter every week or two and cuts the
 *  fleet over to it; the old contract simply stops receiving pushes. The one
 *  invariant across all six is `owner() == 0xA24D2aF7…` — so that, plus the
 *  updatePrices(uint256) packed-word calldata, is what confirms a candidate is
 *  theirs. Do NOT identify them by gas limit: gen1+ push at a flat 45,000 but
 *  gen0 used 100,000, and the limit is a keeper setting, not an identity.
 *  Every generation is listed so the burn series spans the cutovers — a
 *  missing one doesn't error, it silently flatlines the venue's burn while the
 *  venue itself trades on (gen3 went untracked for 11 days that way, gen5 for
 *  3 days; both were noticed only because burn hit null against live volume).
 *
 *  NOT OURS: 0xc1ff9fefdd86735bb14286caa796f72d90f4b0fc pushes the very same
 *  selector from its own rotating fleet, but `owner()` is 0x6792e60a… and it
 *  ran CONCURRENTLY with gen1 (2026-07-13 → 07-15) — two live quoters under
 *  different owners can't both be Hanji's. It is a third party copying the
 *  pattern; counting it would inflate Hanji's burn the way tracking
 *  0x0000a8fd…8888 once did. Check owner() before appending anything.
 *
 *  To find the CURRENT one: scan recent blocks for the updatePrices selector
 *  0xae7e8d81 and read the destination — far cheaper than ranking destinations
 *  by tx frequency, since the fleet rotates senders every push. To audit the
 *  WHOLE set you must sample across the venue lifetime, not recent blocks: a
 *  retired generation is invisible today, which is how gen0 stayed unlisted
 *  from the start. Append below; the gas tracker re-scans from the earliest
 *  ADDED contract's creation day whenever this set changes (gas.ts:
 *  reconcileSourceChange), so earlier history is preserved. */
const FAST_QUOTERS = [
  '0xd637b38f8436fc4974ce9236d65888a1bac64160', // gen0 — 2026-06-26 13:43:02 → 2026-06-30 UTC
  '0x04fdEAC24E4e57364B4F22844106583d88F747d7', // gen1 — 2026-06-30 22:49:37 → 2026-07-16 15:33 UTC
  '0x48cba27861983367c3fb063877b144a628e2b48b', // gen2 — 2026-07-16 → ~2026-07-30
  '0x91855e7930044a8f13f10b336abf551f1f58ac7e', // gen3 — deployed 2026-07-30 06:39:45 UTC
  '0xeae24c729ee1a38554037e4ad25ef1e3c9e30be0', // gen4 — deployed 2026-08-08 23:36:31 UTC
  '0x103de0b5226a2a6d8b918d8192dc23248825bb55', // gen5 — deployed 2026-08-14 15:02:12 UTC, active
] as const;

/** Hanji markets (team-provided, tokens verified on-chain via getConfig).
 *  `market` is the @shared pair symbol; base/quote are TOKENS registry keys. */
const KNOWN_MARKETS = [
  { market: 'MON/USDC', clob: '0xC35b1Ca1a2C398A21df5783b3a5eA6A2D56f298F', proxy: '0x1aeD222dda944a87703c918745b11bE13f8eEf10', baseTok: 'WMON', quoteTok: 'USDC' },
  { market: 'ETH/USDC', clob: '0xAC652E05Ac4B2e9eCaE5C65595E4E4E2734F61Cc', proxy: '0x0ACBA24cecd750bAdB3179FB9eE3F2Cd27431778', baseTok: 'WETH', quoteTok: 'USDC' },
  { market: 'cbBTC/USDC', clob: '0xbc87C6e5A9788404C143D42474508956267B253D', proxy: '0xC11805e92CA6a36cE9507902Ab6Bb5Cd11e438bf', baseTok: 'CBBTC', quoteTok: 'USDC' },
  { market: 'MON/ETH', clob: '0xBe717AEdc2cdc0a4d3903B7A6a70691942E72793', proxy: '0xc4aDcB94D0dce7fc84e180fAE3621Df13ad37e06', baseTok: 'WMON', quoteTok: 'WETH' },
  { market: 'cbBTC/MON', clob: '0x77ED4fcB978fa0CE78799064cB38D12FE7c3ce7d', proxy: '0x012e06b56EEE881603E47748931dC38EfaBf54eF', baseTok: 'CBBTC', quoteTok: 'WMON' },
  { market: 'cbBTC/ETH', clob: '0x8A89f08d3B5aB37f634f2B4dCf2DB29Ecf9938c7', proxy: '0x05e028d33fA727168bC9396bDAc5Cab387c8a196', baseTok: 'CBBTC', quoteTok: 'WETH' },
] as const;

const lobAbi = parseAbi([
  // verified layout (all six CLOBs share the implementation): scaling factors,
  // token addresses, and the 1e18-scaled taker fee rate at index 9.
  'function getConfig() view returns (uint256 scalingX, uint256 scalingY, address tokenX, address tokenY, uint256 f4, uint256 f5, address a6, address a7, uint256 f8, uint256 takerFeeRate, uint256 f10, uint256 f11, uint256 f12)',
  'event OrderPlaced(address indexed owner, address indexed initiator, uint64 order_id, bool indexed isAsk, uint128 quantity, uint72 price, uint128 passive_shares, uint128 passive_fee, uint128 aggressive_shares, uint128 aggressive_value, uint128 aggressive_fee, bool market_only, bool post_only)',
]);
const helperAbi = parseAbi([
  'function assembleOrderbooksFromOrders(address lobAddress, uint24 maxPriceLevels) view returns (uint72[] bidPrices, uint128[] bidShares, uint72[] askPrices, uint128[] askShares)',
]);

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

/** book depth requested per quote poll — enough for the largest probed notional. */
const BOOK_LEVELS = 60;

interface HanjiMarket {
  market: string;
  clob: `0x${string}`;
  proxy: `0x${string}`;
  baseTok: string;   // TOKENS key
  quoteTok: string;  // TOKENS key
  /** shares → human base: shares × baseShare (= scalingX / 10^xDec). */
  baseShare: number;
  /** value-shares → human quote: value × quoteShare (= scalingY / 10^yDec). */
  quoteShare: number;
  /** raw uint72 price → human quote-per-base. */
  pxScale: number;
  feeBps: number;
}

export function createHanjiAdapter(): VenueAdapter {
  // every leg FAILING is a venue-wide cause (paused, ABI drift, dead RPC route),
  // not a per-pair gap — name it instead of vanishing (venues/quote-health.ts).
  const reportOutage = createQuoteOutageReporter(HANJI_VENUE.name);
  let markets: HanjiMarket[] = [];
  let byClob = new Map<string, HanjiMarket>();
  let discovered = false;

  return {
    venues: () => [HANJI_VENUE],
    // seed daily volume by replaying OrderPlaced on-chain from the CLOBs'
    // deployment day (2026-06-05). Background — see live.ts.
    backfillFromUtc: '2026-06-05',

    async discover(ctx: AdapterContext) {
      const res = await ctx.client.multicall({
        contracts: KNOWN_MARKETS.map((m) => ({ address: m.clob as `0x${string}`, abi: lobAbi, functionName: 'getConfig' as const })),
        allowFailure: true,
      });
      const found: HanjiMarket[] = [];
      for (let i = 0; i < KNOWN_MARKETS.length; i++) {
        const m = KNOWN_MARKETS[i];
        const r = res[i];
        // fail closed: a configured market that won't resolve is a hard error
        // (held cursor), not a silent skip.
        if (r.status !== 'success') throw new Error(`Hanji getConfig failed for ${m.market} (${m.clob})`);
        const [sx, sy, tokenX, tokenY, , , , , , takerFeeRate] = r.result as readonly [bigint, bigint, string, string, bigint, bigint, string, string, bigint, bigint, bigint, bigint, bigint];
        const base = TOKENS[m.baseTok], quote = TOKENS[m.quoteTok];
        if (!base || !quote) throw new Error(`Hanji ${m.market}: unknown token key`);
        // the on-chain token layout must match the configured pair — a mismatch
        // means this table is stale and every unit below would be wrong.
        if (String(tokenX).toLowerCase() !== base.address.toLowerCase() || String(tokenY).toLowerCase() !== quote.address.toLowerCase()) {
          throw new Error(`Hanji ${m.market}: on-chain tokens ${tokenX}/${tokenY} don't match ${m.baseTok}/${m.quoteTok}`);
        }
        if (!pairOf(m.market)) { ctx.note('venue.market.unlisted', `Hanji pAMM Vault: ${m.market} is not a registered pair — skipped`); continue; }
        const baseShare = Number(sx) / 10 ** base.decimals;
        const quoteShare = Number(sy) / 10 ** quote.decimals;
        found.push({
          market: m.market, clob: m.clob as `0x${string}`, proxy: m.proxy as `0x${string}`,
          baseTok: m.baseTok, quoteTok: m.quoteTok,
          baseShare, quoteShare,
          pxScale: quoteShare / baseShare, // humanPrice = raw × quoteShare ÷ baseShare⁻¹… = raw × (sy/10^yDec)/(sx/10^xDec)
          feeBps: Number(takerFeeRate) / 1e14, // 1e18-scaled rate → bps
        });
      }
      markets = found;
      byClob = new Map(markets.map((m) => [m.clob.toLowerCase(), m]));
      discovered = true;
      ctx.note('venue.discovery', `Hanji pAMM Vault: ${markets.length} market(s), taker fee ${markets[0]?.feeBps ?? '?'}bps (on-chain config)`);
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      if (!markets.length) return [];
      // one multicall for every market's book (proxy → includes vault liquidity).
      const res = await ctx.client.multicall({
        contracts: markets.map((m) => ({
          address: FAST_QUOTER_HELPER, abi: helperAbi,
          functionName: 'assembleOrderbooksFromOrders' as const,
          args: [m.proxy, BOOK_LEVELS] as const,
        })),
        allowFailure: true,
      });
      if (reportOutage(ctx, res)) return [];

      const rows: QuoteRow[] = [];
      const ts = Date.now();
      for (let i = 0; i < markets.length; i++) {
        const m = markets[i];
        const r = res[i];
        if (r.status !== 'success') continue;
        // bps anchor = the pair-terms CEX mid (wrap basis + quote leg applied).
        const pxMid = ctx.pricer.pairMid(m.market);
        if (pxMid <= 0) continue; // reference leg not warm — no comparable row
        const [bidP, bidS, askP, askS] = r.result as readonly [readonly bigint[], readonly bigint[], readonly bigint[], readonly bigint[]];
        const fee = m.feeBps / 1e4;

        // walk a ladder for `baseNeeded`, best level first → VWAP + filled-full.
        const walk = (prices: readonly bigint[], shares: readonly bigint[], baseNeeded: number) => {
          let remaining = baseNeeded, cost = 0;
          for (let k = 0; k < prices.length && remaining > 0; k++) {
            const px = Number(prices[k]) * m.pxScale;
            const avail = Number(shares[k]) * m.baseShare;
            const take = Math.min(avail, remaining);
            cost += take * px;
            remaining -= take;
          }
          const filled = baseNeeded - remaining;
          return { vwap: filled > 0 ? cost / filled : 0, filledFull: remaining <= baseNeeded * 0.001 };
        };

        for (const size of sizesUsd) {
          const baseNeeded = ctx.pricer.tokenForUsd(m.baseTok, size);
          if (baseNeeded <= 0) continue;
          const buy = walk(askP, askS, baseNeeded);   // buy base = consume asks
          const sell = walk(bidP, bidS, baseNeeded);  // sell base = consume bids
          const hasAsk = buy.vwap > 0, hasBid = sell.vwap > 0;
          if (!hasAsk && !hasBid) continue;
          // taker fee on top of the walked book (the ladder is raw prices).
          const askPx = hasAsk ? buy.vwap * (1 + fee) : 0;
          const bidPx = hasBid ? sell.vwap * (1 - fee) : 0;
          rows.push({
            venueId: HANJI_VENUE.id, market: m.market, sizeUsd: size,
            askPx, bidPx,
            askBps: hasAsk ? (askPx / pxMid - 1) * 1e4 : 0,
            bidBps: hasBid ? (bidPx / pxMid - 1) * 1e4 : 0,
            spreadBps: hasAsk && hasBid ? ((askPx - bidPx) / pxMid) * 1e4 : 0,
            filledFull: (hasAsk ? buy.filledFull : true) && (hasBid ? sell.filledFull : true),
            ...(hasAsk && hasBid ? {} : { oneSided: true }),
            feeBps: m.feeBps, ts,
          });
        }
      }
      return rows;
    },

    logSources() {
      if (!discovered) throw new Error('Hanji discovery unavailable'); // hold the cursor until discovered
      if (!markets.length) return [];
      return [{ key: 'orderPlaced', address: markets.map((m) => m.clob), events: [ev(lobAbi, 'OrderPlaced')], kind: 'fills' as const }];
    },

    // taker entries owned by Hanji: the per-market proxies (a direct trade's
    // tx.to is the proxy; the CLOBs themselves are only reached internally).
    entryPoints: () => KNOWN_MARKETS.map((m) => ({ address: m.proxy })),

    // QUOTE_UPDATE_BURN: Hanji's keeper pays to keep quotes fresh by writing
    // externalPrices into the FastQuoter (~1 updatePrices/s, log-less) — see
    // the FAST_QUOTER note for the verified mechanism. 'blocks' mode because
    // updates emit no events; the near-constant cadence (median gap 3 blocks)
    // makes the sampled estimate sound, same as POE. On-book JIT quoting
    // remains taker-paid and is deliberately not counted. NB: an earlier
    // build tracked 0x0000a8fd…8888 — another protocol's pool (mistaken
    // trace inference, since replaced by this team-confirmed destination).
    gasSources() {
      return [{ mode: 'blocks' as const, address: [...FAST_QUOTERS] }];
    },

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      // keep only real trades first (the aggressive portion of an order);
      // passive placements — incl. the vault's re-quotes — are not fills.
      const trades = (logs.orderPlaced ?? []).filter((l) => {
        const m = byClob.get(String(l.address).toLowerCase());
        const a = l.args;
        return !!m && !!a && a.aggressive_shares !== undefined
          && BigInt(a.aggressive_shares) !== 0n && BigInt(a.aggressive_value) !== 0n;
      });
      if (!trades.length) return [];

      // ATTRIBUTION: the event's owner/initiator are the Hanji PROXY for routed
      // flow (verified on-chain — both fields were the proxy on a live fill).
      // The tx-level lookup (real trader = tx.from; tx.to picks DIRECT via the
      // proxy entryPoints vs a branded router) now lives in the core attributor
      // — emit honest UNKNOWN and let it label.
      const out: Fill[] = [];
      for (const l of trades) {
        const m = byClob.get(String(l.address).toLowerCase())!;
        const a = l.args;
        const baseAmount = Number(a.aggressive_shares) * m.baseShare;
        const quoteAmount = Number(a.aggressive_value) * m.quoteShare;
        if (baseAmount <= 0 || quoteAmount <= 0) continue;
        const execPx = quoteAmount / baseAmount; // realized VWAP in pair terms (real markouts, no pxApprox)
        // USD notional: the quote leg (exact ≡$1 for stables); crypto-quoted
        // pairs price the quote leg live, with the base leg as fallback. If
        // NEITHER leg is priceable the cycle must fail closed (held cursor /
        // paused backfill) rather than store a $0 fill.
        let usd = ctx.pricer.usdForToken(m.quoteTok, quoteAmount);
        if (usd <= 0) usd = ctx.pricer.usdForToken(m.baseTok, baseAmount);
        if (usd <= 0) throw new Error(`Hanji ${m.market}: no USD price for either leg (feeds warming?)`);
        // isAsk = the aggressive order SELLS the base (tokenX) into the book.
        const side: Side = a.isAsk ? 'sell' : 'buy';
        out.push({
          id: `hanji-${String(l.transactionHash).toLowerCase()}-${l.logIndex}`,
          venueId: HANJI_VENUE.id,
          market: m.market, side,
          category: 'UNKNOWN',
          usd, baseAmount, execPx,
          txHash: l.transactionHash, to: shortHex(String(a.initiator ?? '0x')),
          pool: `lob ${m.clob.slice(0, 8)}`,
          blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
          markoutsBps: [null, null, null, null, null],
        });
      }
      return out;
    },
  };
}
