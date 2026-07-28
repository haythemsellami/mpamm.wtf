import { parseAbi } from 'viem';
import type { Fill, Pair, QuoteRow, Side, TokenInfo, VenueMeta } from '@shared';
import { ASSETS, PAIRS, TOKENS } from '@shared';
import { fromUnits, shortHex, toUnits } from '../util.js';
import type { AdapterContext, LogBundle, VenueAdapter } from './adapter.js';

/**
 * ThogAMM is one inventory-funded ERC-7815 pool behind the TAKERBOT proxy.
 * The proxy's executable exact-input view is the quote source of truth: it
 * includes live spread, inventory skew, staleness and exact-token capacity,
 * so the adapter never ports or approximates the maker's private curve.
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
  'event MakerSwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed sender, address recipient, uint256 amountIn, uint256 amountOut, uint256 quoteAgeBlocks, uint256 inventoryPenaltyUsdWad)',
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

/**
 * Decode one real inventory transition. Malformed/irrelevant logs are skipped
 * locally; a crypto-quoted fill with no live USD leg throws so the core holds
 * the cursor rather than persisting a zero-notional fill.
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
    || String(log?.eventName ?? '') !== 'MakerSwapExecuted'
    || !args || !/^0x[0-9a-fA-F]{64}$/.test(txHash)
    || !Number.isSafeInteger(logIndex) || logIndex < 0
    || log?.blockNumber === undefined) return null;

  let amountIn: bigint, amountOut: bigint, blockNumber: bigint;
  try {
    amountIn = BigInt(args.amountIn);
    amountOut = BigInt(args.amountOut);
    blockNumber = BigInt(log.blockNumber);
  } catch {
    return null;
  }
  if (amountIn <= 0n || amountOut <= 0n || blockNumber <= 0n
    || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const tokenIn = String(args.tokenIn ?? '').toLowerCase();
  const tokenOut = String(args.tokenOut ?? '').toLowerCase();
  const market = marketsByDirection.get(directionKey(tokenIn, tokenOut));
  if (!market) return null;

  const inputIsBase = tokenIn === market.base.address.toLowerCase();
  const baseRaw = inputIsBase ? amountIn : amountOut;
  const quoteRaw = inputIsBase ? amountOut : amountIn;
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
    to: shortHex(String(args.recipient ?? '0x')),
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

export function createThogammAdapter(): VenueAdapter {
  const byMarket = new Map<string, ThogammMarket>();
  let byDirection = new Map<string, ThogammMarket>();
  let discovered = false;

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
        ctx.log(`ThogAMM: token ${shortHex(addresses[i])} is not in @shared TOKENS; its pairs remain unlisted`);
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
    ctx.log(`ThogAMM: ${found.length} registered market(s) across ${addresses.length} on-chain token(s) at block ${blockNumber}`);
  };

  return {
    venues: () => [THOGAMM_VENUE],
    backfillFromUtc: '2026-07-26',

    discover: refresh,

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      if (!discovered || !byMarket.size) return [];
      const blockNumber = await ctx.client.getBlockNumber();
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

      const results = await ctx.client.multicall({ contracts: calls, allowFailure: true, blockNumber });
      const partials = new Map<string, PartialQuote>();
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status !== 'success') continue;
        const leg = legs[i];
        const [amountOut] = result.result as readonly [bigint, bigint];
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
        { key: 'swaps', address: THOGAMM_ADDRESS, events: [event('MakerSwapExecuted')], kind: 'fills' as const },
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
      if ((logs.upgrades ?? []).length) await refresh(ctx);
      const out: Fill[] = [];
      for (const log of logs.swaps ?? []) {
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
        if (fill) out.push(fill);
      }
      return out;
    },
  };
}
