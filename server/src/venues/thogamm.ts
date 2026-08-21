import { decodeAbiParameters, parseAbi } from 'viem';
import type { Fill, Pair, QuoteRow, Side, TokenInfo, VenueMeta } from '@shared';
import { ASSETS, PAIRS, TOKENS } from '@shared';
import { fromUnits, shortHex, toUnits } from '../util.js';
import type { AdapterContext, LogBundle, VenueAdapter } from './adapter.js';
import { createQuoteOutageReporter } from './quote-health.js';

/**
 * ThogAMM is one inventory-funded ERC-7815 pool behind the TAKERBOT proxy.
 * The proxy's executable exact-input view is the quote source of truth: it
 * includes live spread, inventory skew, staleness and exact-token capacity,
 * so the adapter never ports or approximates the maker's private curve.
 *
 * FILLS COME FROM TWO EVENTS, AND THEY DISAGREE ABOUT WHOSE LEGS THEY NAME.
 * The proxy has always carried both — every implementation back to launch day
 * contains both topics — and they are opposite: `TakerTradeExecuted` (topic0
 * 0xb322b204…) indexes the POOL's legs, `MakerSwapExecuted` (0x4b70d42a…) the
 * taker's, so one trade reads with its two tokens in either order depending on
 * which fired. Essentially all real flow lands on TakerTradeExecuted;
 * MakerSwapExecuted fires rarely (single digits across the venue's life), and
 * this adapter filtered on THAT one alone — it was written against the single
 * such log that existed at the time (block 90,433,928). So the venue reported
 * $0 volume from its first day while quoting and burning keeper gas normally:
 * not a topic0 that drifted out from under us, but a fill path we never looked
 * at. Both are decoded now, through the one function that knows which ordering
 * is which, and `checkFillSilence` below watches for the asymmetry that hid
 * this.
 */

export const THOGAMM_ADDRESS = '0x80c74517BCC2D67fFE02D3ED886796272F647210' as const;

const THOGAMM_VENUE: VenueMeta = {
  id: 'thogamm',
  name: 'ThogAMM',
  color: { light: '#6D28D9', dark: '#A78BFA' },
  kind: 'amm',
  role: 'venue',
  sinceUtc: '2026-07-26',
};

const thogammAbi = parseAbi([
  'function getPoolIds() view returns (bytes32[])',
  // ERC-7815 declares this nonpayable, but discovery invokes it through
  // eth_call. State mutability is not part of the selector.
  'function getTokens(bytes32 poolId) view returns (address[])',
  'function makerQuoteExactInput(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut, uint256 lastPostedBlock)',
  // The live fill event — where essentially all of this venue's flow lands.
  // Its indexed legs are the POOL's, NOT the taker's: verified 2026-08-21
  // against 11 consecutive fills, `poolPays` is the token leaving the pool and
  // `poolReceives` the one entering it, each amount equal to the wei that
  // moved in the same tx (ERC-20 Transfer, or a WMON Deposit when the taker
  // paid native MON). That is the reverse of MakerSwapExecuted below, so the
  // two can never share a decode path — see takerLegs().
  // The trailing four words vary per fill and none of them could be pinned to
  // a meaning against the unverified implementation, so they are named
  // positionally rather than given a label this adapter cannot stand behind.
  // Nothing reads them.
  'event TakerTradeExecuted(address indexed poolPays, address indexed poolReceives, uint256 poolPaysAmount, uint256 poolReceivesAmount, uint256 word2, uint256 word3, uint256 word4, uint256 word5)',
  // The legacy fill event: taker-perspective legs, and rare — single digits
  // across the venue's lifetime against thousands on TakerTradeExecuted. Kept
  // because those ARE real fills inside the backfill window, and because it is
  // the regression guard on the reversed ordering above.
  'event MakerSwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed sender, address recipient, uint256 amountIn, uint256 amountOut, uint256 quoteAgeBlocks, uint256 inventoryPenaltyUsdWad)',
  // A taker call the maker refused, carrying the raw revert data it caught
  // ("taker: zero fill" in every sample). Tailed on the fill source so it
  // costs no extra getLogs, and reported rather than dropped: it is quoted
  // flow that did not land, which otherwise looks like a quiet venue.
  // Only `reason` is read — the leg ordering here is untested.
  'event TradeFailed(address indexed tokenA, address indexed tokenB, uint256 amount, bytes reason)',
  'event MakerPricesPushed(uint16 seq, uint32 indexed postedBlock, uint16 sideEnableBits)',
  'event MakerRiskParamsPushed(uint8 indexed fields)',
  'event Upgraded(address indexed implementation)',
]);
const erc20Abi = parseAbi(['function decimals() view returns (uint8)']);
const event = (name: string) => thogammAbi.find((x: any) => x.type === 'event' && x.name === name)!;

export interface ThogammMarket {
  market: string;
  baseKey: string;
  quoteKey: string;
  base: TokenInfo;
  quote: TokenInfo;
}

/** Follow a pool-id rotation, but fail closed if the proxy is not single-pool. */
export function selectThogammPoolId(poolIds: readonly `0x${string}`[]): `0x${string}` {
  if (poolIds.length !== 1) {
    throw new Error(`ThogAMM expected exactly one pool id, got ${poolIds.length}: ${poolIds.join(', ') || 'none'}`);
  }
  return poolIds[0];
}

function tokenKeysForPair(pair: Pair): readonly [string, string] | undefined {
  // cbBTC is an alternative BTC wrapper, so its market symbol—not Pair.base—
  // selects the on-chain token. The same rule handles the WBTC/cbBTC cross.
  const baseKey = pair.symbol.startsWith('cbBTC/') ? 'CBBTC' : ASSETS[pair.base]?.token;
  const quoteKey = pair.symbol.endsWith('/cbBTC')
    ? 'CBBTC'
    : pair.quoteKind === 'asset'
      ? ASSETS[pair.quote]?.token
      : pair.quote;
  return baseKey && quoteKey ? [baseKey, quoteKey] : undefined;
}

/** Resolve every registered pair whose exact two ERC-20s are in the live pool. */
export function thogammMarketsForTokens(addresses: readonly string[]): ThogammMarket[] {
  const available = new Set(addresses.map((address) => address.toLowerCase()));
  const out: ThogammMarket[] = [];
  const seen = new Set<string>();
  for (const pair of PAIRS) {
    const keys = tokenKeysForPair(pair);
    if (!keys) continue;
    const [baseKey, quoteKey] = keys;
    const base = TOKENS[baseKey], quote = TOKENS[quoteKey];
    if (!base || !quote || base.address.toLowerCase() === quote.address.toLowerCase()) continue;
    if (!available.has(base.address.toLowerCase()) || !available.has(quote.address.toLowerCase())) continue;
    const unordered = [base.address.toLowerCase(), quote.address.toLowerCase()].sort().join(':');
    if (seen.has(unordered)) continue;
    seen.add(unordered);
    out.push({ market: pair.symbol, baseKey, quoteKey, base, quote });
  }
  return out;
}

function directionKey(tokenIn: string, tokenOut: string): string {
  return `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
}

export function indexThogammMarkets(markets: readonly ThogammMarket[]): Map<string, ThogammMarket> {
  const out = new Map<string, ThogammMarket>();
  for (const market of markets) {
    for (const [tokenIn, tokenOut] of [
      [market.base.address, market.quote.address],
      [market.quote.address, market.base.address],
    ] as const) {
      const key = directionKey(tokenIn, tokenOut);
      const prior = out.get(key);
      if (prior && prior.market !== market.market) {
        throw new Error(`ThogAMM token pair maps to both ${prior.market} and ${market.market}`);
      }
      out.set(key, market);
    }
  }
  return out;
}

/** The two events that carry a ThogAMM fill. Everything else on the fill
 *  source (a refused taker) is telemetry, not volume. */
export const THOGAMM_FILL_EVENTS: ReadonlySet<string> = new Set(['TakerTradeExecuted', 'MakerSwapExecuted']);

/** One fill's legs in TAKER terms: `in` is always what the taker paid. */
interface TakerLegs {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  /** the event's own recipient, where it carries one (legacy event only). */
  recipient?: string;
}

/**
 * Read one fill log in taker terms — the ONLY place that knows the two events
 * index their legs in opposite order (see the ABI above). Reversing this
 * silently inverts `side` on every fill while every amount still looks right,
 * so both orderings are pinned by a real recorded-log fixture test.
 */
function takerLegs(eventName: string, args: any): TakerLegs | null {
  try {
    if (eventName === 'TakerTradeExecuted') {
      // pool-indexed: what the pool receives is what the taker paid.
      return {
        tokenIn: String(args.poolReceives ?? ''),
        tokenOut: String(args.poolPays ?? ''),
        amountIn: BigInt(args.poolReceivesAmount),
        amountOut: BigInt(args.poolPaysAmount),
      };
    }
    if (eventName === 'MakerSwapExecuted') {
      return {
        tokenIn: String(args.tokenIn ?? ''),
        tokenOut: String(args.tokenOut ?? ''),
        amountIn: BigInt(args.amountIn),
        amountOut: BigInt(args.amountOut),
        recipient: String(args.recipient ?? '0x'),
      };
    }
  } catch {
    return null;  // a malformed amount is one bad log, not a held cursor
  }
  return null;
}

/**
 * Decode one real inventory transition, from either fill event. Malformed and
 * irrelevant logs are skipped locally; a crypto-quoted fill with no live USD
 * leg throws so the core holds the cursor rather than persisting a
 * zero-notional fill.
 */
export function decodeThogammSwap(
  log: any,
  marketsByDirection: ReadonlyMap<string, ThogammMarket>,
  ts: number,
  usdForToken: (tokenKey: string, amount: number) => number,
): Fill | null {
  const args = log?.args;
  const txHash = String(log?.transactionHash ?? '');
  const logIndex = Number(log?.logIndex);
  if (String(log?.address ?? '').toLowerCase() !== THOGAMM_ADDRESS.toLowerCase()
    || !args || !/^0x[0-9a-fA-F]{64}$/.test(txHash)
    || !Number.isSafeInteger(logIndex) || logIndex < 0
    || log?.blockNumber === undefined) return null;

  const legs = takerLegs(String(log?.eventName ?? ''), args);
  if (!legs) return null;

  let blockNumber: bigint;
  try {
    blockNumber = BigInt(log.blockNumber);
  } catch {
    return null;
  }
  if (legs.amountIn <= 0n || legs.amountOut <= 0n || blockNumber <= 0n
    || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const tokenIn = legs.tokenIn.toLowerCase();
  const tokenOut = legs.tokenOut.toLowerCase();
  const market = marketsByDirection.get(directionKey(tokenIn, tokenOut));
  if (!market) return null;

  const inputIsBase = tokenIn === market.base.address.toLowerCase();
  const baseRaw = inputIsBase ? legs.amountIn : legs.amountOut;
  const quoteRaw = inputIsBase ? legs.amountOut : legs.amountIn;
  const baseAmount = fromUnits(baseRaw, market.base.decimals);
  const quoteAmount = fromUnits(quoteRaw, market.quote.decimals);
  if (baseAmount <= 0 || quoteAmount <= 0) return null;

  let usd = usdForToken(market.quoteKey, quoteAmount);
  if (usd <= 0) usd = usdForToken(market.baseKey, baseAmount);
  if (usd <= 0) throw new Error(`ThogAMM ${market.market}: no USD price for either fill leg`);

  const side: Side = inputIsBase ? 'sell' : 'buy';
  return {
    id: `thogamm-${txHash.toLowerCase()}-${logIndex}`,
    venueId: THOGAMM_VENUE.id,
    market: market.market,
    side,
    category: 'UNKNOWN',
    usd,
    baseAmount,
    execPx: quoteAmount / baseAmount,
    txHash,
    // TakerTradeExecuted carries no address; attribution rewrites `to` to
    // tx.from whenever its lookup lands, so this is only the fallback label.
    to: shortHex(legs.recipient ?? '0x'),
    pool: `thogamm ${THOGAMM_ADDRESS.slice(0, 10)}`,
    blockNumber: Number(blockNumber),
    ts,
    markoutsBps: [null, null, null, null, null],
  };
}

interface QuoteLeg {
  market: ThogammMarket;
  sizeUsd: number;
  side: Side;
  amountIn: bigint;
  mid: number;
}

interface PartialQuote {
  market: ThogammMarket;
  sizeUsd: number;
  mid: number;
  bidPx?: number;
  askPx?: number;
}

/** ThogAMM hands TradeFailed the raw revert data it caught from the taker
 *  call. Nearly always a plain Error(string); anything else is reported as its
 *  selector rather than guessed at. */
export function thogammRejectReason(reason: unknown): string {
  const hex = String(reason ?? '');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) return 'unreadable revert data';
  if (hex === '0x') return 'no revert data';
  if (!hex.startsWith('0x08c379a0')) return `custom error ${hex.slice(0, 10)}`;
  try {
    const [message] = decodeAbiParameters([{ type: 'string' }], `0x${hex.slice(10)}`);
    return String(message);
  } catch {
    return `undecodable Error(string) payload`;
  }
}

/** How long the fill filter may match NOTHING before that is itself reported.
 *  ~24h of 400ms blocks: this venue trades in bursts and routinely goes a few
 *  quiet hours, but a full day of silence from a maker that is still quoting
 *  is not quiet — it is the shape of an ABI that no longer matches the chain. */
const FILL_SILENCE_BLOCKS = 216_000n;
/** How recently the keeper must have posted prices for that silence to count
 *  as suspicious rather than explained (~1h; it normally posts every block). */
const QUOTE_FRESH_BLOCKS = 9_000n;

export function createThogammAdapter(): VenueAdapter {
  const byMarket = new Map<string, ThogammMarket>();
  let byDirection = new Map<string, ThogammMarket>();
  let discovered = false;
  // `makerQuoteExactInput` REVERTS rather than returning zero when the maker is
  // off: the keeper posts `sideEnableBits = 0` and every leg reverts
  // "maker: paused" (observed 2026-08-04 07:16:39 UTC, block 92,998,939).
  const reportOutage = createQuoteOutageReporter(THOGAMM_VENUE.name);

  // Fill-silence alarm state. `watchFromBlock` is the head at first discovery:
  // the historical backfill replays old ranges through decode() too, and a
  // fill from three weeks ago must not read as "we are still landing fills".
  let watchFromBlock = 0n;
  let lastFillBlock = 0n;
  // the newest block the maker's own quote view reports it posted prices at —
  // the same keeper activity the gas metric bills, for free on a call we
  // already make.
  let quoteLiveAtBlock = 0n;
  let fillsSilentReported = false;
  let lastRejectReason: string | null = null;

  /**
   * The check that would have caught this adapter's blind spot in a day
   * instead of a month: fills silent for a long window WHILE the venue is
   * demonstrably still quoting. Either half alone is ordinary — a paused maker
   * explains silence, and a live maker is allowed a quiet stretch — but the
   * two together mean we are looking for the wrong thing on-chain.
   *
   * It notes rather than throws on purpose. A throw here holds the shared tail
   * cursor for EVERY venue (datasource/live.ts skips the whole cycle when a
   * required source fails), so failing closed on a suspicion would turn one
   * venue's undercount into a total indexing stall.
   */
  const checkFillSilence = (ctx: AdapterContext, head: bigint) => {
    const since = lastFillBlock > watchFromBlock ? lastFillBlock : watchFromBlock;
    const silentFor = head > since ? head - since : 0n;
    if (silentFor < FILL_SILENCE_BLOCKS) {
      fillsSilentReported = false;
      return;
    }
    if (quoteLiveAtBlock === 0n || head - quoteLiveAtBlock > QUOTE_FRESH_BLOCKS) return;
    if (fillsSilentReported) return;
    fillsSilentReported = true;
    ctx.note('venue.fills.silent', `ThogAMM: no fill decoded in ${silentFor} blocks while its keeper is still posting quotes (last at block ${quoteLiveAtBlock}) — the fill event ABI has probably drifted from the live implementation`);
  };

  const refresh = async (ctx: AdapterContext) => {
    const blockNumber = await ctx.client.getBlockNumber();
    const poolIds = await ctx.client.readContract({
      address: THOGAMM_ADDRESS,
      abi: thogammAbi,
      functionName: 'getPoolIds',
      blockNumber,
    }) as readonly `0x${string}`[];
    const poolId = selectThogammPoolId(poolIds);

    const addresses = await ctx.client.readContract({
      address: THOGAMM_ADDRESS,
      abi: thogammAbi,
      functionName: 'getTokens',
      args: [poolId],
      blockNumber,
    }) as readonly `0x${string}`[];
    const normalized = addresses.map((address) => address.toLowerCase());
    if (normalized.length < 2 || new Set(normalized).size !== normalized.length) {
      throw new Error(`ThogAMM returned an invalid ${normalized.length}-token registry`);
    }

    const knownByAddress = new Map(
      Object.entries(TOKENS).map(([key, token]) => [token.address.toLowerCase(), { key, token }] as const),
    );
    const decimals = await ctx.client.multicall({
      contracts: addresses.map((address) => ({ address, abi: erc20Abi, functionName: 'decimals' as const })),
      allowFailure: true,
      blockNumber,
    });
    for (let i = 0; i < addresses.length; i++) {
      const known = knownByAddress.get(normalized[i]);
      if (!known) {
        ctx.note('venue.market.unlisted', `ThogAMM: token ${shortHex(addresses[i])} is not in @shared TOKENS; its pairs remain unlisted`);
        continue;
      }
      const result = decimals[i];
      if (result.status !== 'success' || Number(result.result) !== known.token.decimals) {
        throw new Error(`ThogAMM ${known.key} decimals mismatch`);
      }
    }

    const found = thogammMarketsForTokens(addresses);
    if (!found.length) throw new Error('ThogAMM discovered no registered markets');
    // Discovery refreshes every ten minutes. Merge so a transient proxy/read
    // issue or later registry change can never shrink the historical decode set.
    for (const market of found) byMarket.set(market.market, market);
    byDirection = indexThogammMarkets([...byMarket.values()]);
    discovered = true;
    ctx.note('venue.discovery', `ThogAMM: ${found.length} registered market(s) across ${addresses.length} on-chain token(s) at block ${blockNumber}`);

    // Discovery is the adapter's only regular sight of the head, so the
    // silence alarm rides on it (every 10 minutes — far finer than the day it
    // measures).
    if (watchFromBlock === 0n) watchFromBlock = blockNumber;
    checkFillSilence(ctx, blockNumber);
  };

  return {
    venues: () => [THOGAMM_VENUE],
    backfillFromUtc: '2026-07-26',

    discover: refresh,

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      if (!discovered || !byMarket.size) return [];
      const calls: Array<{ address: typeof THOGAMM_ADDRESS; abi: typeof thogammAbi; functionName: 'makerQuoteExactInput'; args: readonly [`0x${string}`, `0x${string}`, bigint] }> = [];
      const legs: QuoteLeg[] = [];

      for (const market of byMarket.values()) {
        const mid = ctx.pricer.pairMid(market.market);
        const baseUsd = ctx.pricer.usdPerToken(market.baseKey);
        const quoteUsd = ctx.pricer.usdPerToken(market.quoteKey);
        if (mid <= 0 || baseUsd <= 0 || quoteUsd <= 0) continue;
        for (const sizeUsd of sizesUsd) {
          for (const side of ['sell', 'buy'] as const) {
            const input = side === 'sell' ? market.base : market.quote;
            const inputUsd = side === 'sell' ? baseUsd : quoteUsd;
            const amountIn = toUnits(sizeUsd / inputUsd, input.decimals);
            if (amountIn <= 0n) continue;
            const tokenIn = input.address;
            const tokenOut = side === 'sell' ? market.quote.address : market.base.address;
            calls.push({
              address: THOGAMM_ADDRESS,
              abi: thogammAbi,
              functionName: 'makerQuoteExactInput',
              args: [tokenIn, tokenOut, amountIn],
            });
            legs.push({ market, sizeUsd, side, amountIn, mid });
          }
        }
      }
      if (!calls.length) return [];

      // Quote against the node's latest state at execution time, matching the
      // other live venue adapters. Fetching a head first and pinning this call
      // to it made ThogAMM one RPC round older than Metric/Hanji in the same UI
      // sample, manufacturing an apparent quote-publication lag.
      const results = await ctx.client.multicall({ contracts: calls, allowFailure: true });
      if (reportOutage(ctx, results)) return [];
      const partials = new Map<string, PartialQuote>();
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status !== 'success') continue;
        const leg = legs[i];
        const [amountOut, lastPostedBlock] = result.result as readonly [bigint, bigint];
        // Captured before the size filter: a leg that quotes zero still proves
        // the keeper is alive, which is exactly what checkFillSilence needs.
        if (lastPostedBlock > quoteLiveAtBlock) quoteLiveAtBlock = lastPostedBlock;
        if (amountOut <= 0n) continue;
        const input = fromUnits(leg.amountIn, leg.side === 'sell' ? leg.market.base.decimals : leg.market.quote.decimals);
        const output = fromUnits(amountOut, leg.side === 'sell' ? leg.market.quote.decimals : leg.market.base.decimals);
        if (input <= 0 || output <= 0) continue;
        const key = `${leg.market.market}:${leg.sizeUsd}`;
        const partial = partials.get(key) ?? { market: leg.market, sizeUsd: leg.sizeUsd, mid: leg.mid };
        if (leg.side === 'sell') partial.bidPx = output / input;
        else partial.askPx = input / output;
        partials.set(key, partial);
      }

      const ts = Date.now();
      const rows: QuoteRow[] = [];
      for (const partial of partials.values()) {
        const bidPx = partial.bidPx ?? 0, askPx = partial.askPx ?? 0;
        if (bidPx <= 0 && askPx <= 0) continue;
        const oneSided = bidPx <= 0 || askPx <= 0;
        rows.push({
          venueId: THOGAMM_VENUE.id,
          market: partial.market.market,
          sizeUsd: partial.sizeUsd,
          bidPx,
          askPx,
          bidBps: bidPx > 0 ? (bidPx / partial.mid - 1) * 1e4 : 0,
          askBps: askPx > 0 ? (askPx / partial.mid - 1) * 1e4 : 0,
          spreadBps: oneSided ? 0 : ((askPx - bidPx) / partial.mid) * 1e4,
          filledFull: true,
          oneSided,
          // ThogAMM has no additive LP fee. Its executable output already
          // includes the maker spread, age widening and inventory penalty.
          feeBps: 0,
          ts,
        });
      }
      return rows;
    },

    logSources() {
      return [
        // One source, three events, ONE getLogs: same address, so the extra
        // topics are free and decode() sorts them out by name. Filtering on a
        // single event is what blinded this adapter — a second fill path was
        // right there in the same log stream, one topic away.
        { key: 'trades', address: THOGAMM_ADDRESS, events: [event('TakerTradeExecuted'), event('MakerSwapExecuted'), event('TradeFailed')], kind: 'fills' as const },
        // A proxy upgrade can change the immutable token registry. Holding the
        // cursor on this source lets decode refresh before accepting same-range
        // fills instead of silently dropping a newly registered token.
        { key: 'upgrades', address: THOGAMM_ADDRESS, events: [event('Upgraded')], kind: 'state' as const },
      ];
    },

    entryPoints: () => [{ address: THOGAMM_ADDRESS }],

    // TAKERBOT's keeper self-funds price/risk pushes to the proxy. Both update
    // paths emit one exact event, so destination-keyed log mode follows keeper
    // rotation and counts transactions without block-sampling estimates.
    gasSources: () => [{
      mode: 'logs' as const,
      address: THOGAMM_ADDRESS,
      events: [event('MakerPricesPushed'), event('MakerRiskParamsPushed')],
    }],

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf) {
      const upgrades = logs.upgrades ?? [];
      if (upgrades.length) {
        // Calls go to the PROXY, so an upgrade is transparent while the
        // interface holds — the implementation address is never referenced.
        // But this proxy has upgraded 27 times (7 in its first four live
        // days), and an ABI change is the one thing state refresh cannot
        // absorb: a renamed/reordered/re-indexed event param shifts topic0,
        // and our fill + gas filters would then match NOTHING while looking
        // exactly like a quiet venue (the Hanji FastQuoter failure mode).
        // So announce every upgrade in state.notes — one note per new
        // implementation — as the cue to re-verify the ABIs.
        // The blind spot this adapter actually shipped with was NOT a shifted
        // topic0, though: the fills were on a second event that had been in
        // the implementation all along. An upgrade note only prompts a human;
        // checkFillSilence is what notices when nobody acts on one.
        for (const log of upgrades) {
          const impl = String(log?.args?.implementation ?? '');
          const label = /^0x[0-9a-fA-F]{40}$/.test(impl) ? shortHex(impl) : 'an unreadable implementation';
          ctx.note('venue.upgraded', `ThogAMM: proxy upgraded to ${label} — re-verify quote/fill/gas ABIs against the new implementation`);
        }
        await refresh(ctx);
      }
      // Sources are a constant, so logSources() is always right and cannot carry
      // the fail-closed guard the discovered-address venues get for free.
      // Discovery supplies only the decode table: with it empty every swap
      // decodes to null, the core reads "no fills in this range" and advances
      // past fills the on-chain backfill (< bootHead) will never return for.
      // Hold the cursor instead — conditionally, as Clober does, so an
      // undiscovered ThogAMM never stalls the shared tail over ranges that
      // carry nothing of ours.
      const trades = logs.trades ?? [];
      // Only a real FILL log may hold the cursor: a lone TradeFailed carries
      // nothing discovery could decode, so holding on it would stall the tail
      // over a range that has nothing of ours in it.
      const fillLogs = trades.filter((log: any) => THOGAMM_FILL_EVENTS.has(String(log?.eventName ?? '')));
      if (!discovered && fillLogs.length > 0) {
        throw new Error('ThogAMM discovery unavailable');
      }
      // Refused takers are reported once per distinct reason, the same shape
      // quote-health.ts uses: the reason is the signal, and repeating it per
      // occurrence would bury the rest of the notes window.
      for (const log of trades) {
        if (String(log?.eventName ?? '') !== 'TradeFailed') continue;
        const reason = thogammRejectReason(log?.args?.reason);
        if (reason === lastRejectReason) continue;
        lastRejectReason = reason;
        ctx.note('venue.fills.rejected', `ThogAMM: a taker fill reverted on-chain with "${reason}" — quoted flow that did not land`);
      }
      const out: Fill[] = [];
      for (const log of fillLogs) {
        let blockNumber: bigint;
        try {
          blockNumber = BigInt(log?.blockNumber);
        } catch {
          continue;
        }
        if (blockNumber <= 0n || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) continue;
        const fill = decodeThogammSwap(
          log,
          byDirection,
          tsOf(blockNumber),
          (tokenKey, amount) => ctx.pricer.usdForToken(tokenKey, amount),
        );
        if (!fill) continue;
        out.push(fill);
        // feeds the silence alarm — a decoded fill is the proof it looks for.
        if (blockNumber > lastFillBlock) lastFillBlock = blockNumber;
      }
      return out;
    },
  };
}
