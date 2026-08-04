import { parseAbi, keccak256, encodeAbiParameters } from 'viem';
import type { QuoteRow, VenueMeta, Pair } from '@shared';
import { PAIRS, TOKENS, NATIVE_MON } from '@shared';
import type { VenueAdapter, AdapterContext } from './adapter.js';

/**
 * Uniswap v4 BASELINE adapter — the standard-DEX comparison band on the
 * Execution page (role 'baseline'): quote-only, default-off, never in
 * volume/markouts/leaderboard, never ★. It answers one question per pair:
 * "what would this size cost on a vanilla AMM right now?"
 *
 *  - v4 is a singleton: pools live inside the PoolManager, keyed by
 *    PoolKey{currency0, currency1, fee, tickSpacing, hooks}; poolId =
 *    keccak(abi.encode(key)). Native MON is currency 0x0 — the LIVE Monad
 *    pools are native-MON (the WMON ones are empty; verified on-chain).
 *  - discovery probes the STANDARD HOOKLESS tiers per registered pair via
 *    StateView (gas-free reads) and picks the deepest initialized pool. Hooked
 *    pools are excluded on purpose: a hook can arbitrarily change pricing, and
 *    the baseline must be vanilla AMM math to be comparable. Re-discovery
 *    re-picks as liquidity migrates.
 *  - quotes come from the V4Quoter via eth_call (it is nonpayable by design
 *    but made for offchain callers — same pattern as Metric's quoteSwap).
 *    Quoter output is fee-inclusive; `feeBps` carries the pool's tier so the
 *    UI can label the band with the ACTUAL pool used (e.g. "UNI-V4 0.05%").
 *  - a pair with no pool (or one that quotes outside the sanity band at a
 *    size) simply emits no row — no chip, no band. New propAMM pairs with no
 *    Uniswap pool cost nothing here.
 */

// color: olive/lime in BOTH themes — validated (CVD/contrast) against the venue
// palette + Binance gold (co-plotted on non-MON pairs; the design's brighter
// chartreuse was protan-identical to that gold, ΔE 1.6).
const UNI_VENUE: VenueMeta = { id: 'uniswap-v4', name: 'Uniswap v4', color: { light: '#3F6212', dark: '#4D7C0F' }, kind: 'amm', role: 'baseline' };

/** Uniswap v4 on Monad (developers.uniswap.org/contracts/v4/deployments). */
const STATE_VIEW = '0x77395f3b2e73ae90843717371294fa97cc419d64' as const;
const QUOTER = '0xa222dd357a9076d1091ed6aa2e16c9742dd26891' as const;
const NO_HOOKS = '0x0000000000000000000000000000000000000000' as const;

/** standard fee tiers (pips) with their conventional tick spacings. */
const TIERS: ReadonlyArray<readonly [number, number]> = [[100, 1], [500, 10], [3000, 60], [10000, 200]];

/** per-side sanity band vs the pair reference — a "quote" thousands of bps out
 *  (drained pool / dust liquidity) is not a comparable execution. */
const PER_SIDE_BAND_BPS = 2000;

const svAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);
const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

interface PoolKey { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` }

const poolIdOf = (k: PoolKey) => keccak256(encodeAbiParameters(
  [{ type: 'tuple', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ] }],
  [k as never],
));

/** on-chain currency + decimals + pricer key for a pair-symbol side. Display
 *  symbols map to their on-chain representations: 'MON' → NATIVE 0x0 (that's
 *  where v4's real MON liquidity lives — the WMON pools are empty), 'ETH' →
 *  WETH, 'BTC' → WBTC, 'cbBTC' → CBBTC (the distinct symbols exist precisely
 *  to disambiguate wrappers); stables' display symbols equal their TOKENS keys. */
const DISPLAY_TOKEN: Record<string, string> = { ETH: 'WETH', BTC: 'WBTC', cbBTC: 'CBBTC' };
function currencyFor(displaySym: string): { addr: `0x${string}`; dec: number; tok: string } | undefined {
  if (displaySym === 'MON') return { addr: NATIVE_MON as `0x${string}`, dec: 18, tok: 'MON' };
  const key = DISPLAY_TOKEN[displaySym] ?? displaySym;
  const t = TOKENS[key];
  return t ? { addr: t.address, dec: t.decimals, tok: key } : undefined;
}

interface UniMarket {
  market: string;
  key: PoolKey;
  feeBps: number;        // pool tier in bps (500 pips → 5)
  baseIsCurrency0: boolean;
  baseDec: number; quoteDec: number;
  baseTok: string; quoteTok: string; // TOKENS keys for USD sizing
}

export function createUniswapAdapter(): VenueAdapter {
  let markets: UniMarket[] = [];

  return {
    venues: () => [UNI_VENUE],

    async discover(ctx: AdapterContext) {
      // candidate = every registered pair × standard hookless tier
      type Cand = { pair: Pair; key: PoolKey; base: NonNullable<ReturnType<typeof currencyFor>>; quote: NonNullable<ReturnType<typeof currencyFor>>; id: `0x${string}` };
      const cands: Cand[] = [];
      for (const pair of PAIRS) {
        const [bSym, qSym] = pair.symbol.split('/');
        const base = currencyFor(bSym), quote = currencyFor(qSym);
        if (!base || !quote) continue;
        for (const [fee, tickSpacing] of TIERS) {
          const [c0, c1] = [base.addr.toLowerCase(), quote.addr.toLowerCase()].sort() as [`0x${string}`, `0x${string}`];
          const key: PoolKey = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: NO_HOOKS };
          cands.push({ pair, key, base, quote, id: poolIdOf(key) });
        }
      }
      const res = await ctx.client.multicall({
        contracts: cands.flatMap((c) => [
          { address: STATE_VIEW, abi: svAbi, functionName: 'getSlot0' as const, args: [c.id] as const },
          { address: STATE_VIEW, abi: svAbi, functionName: 'getLiquidity' as const, args: [c.id] as const },
        ]),
        allowFailure: true,
      });
      // deepest initialized hookless pool per pair wins
      const best = new Map<string, { cand: Cand; liq: bigint }>();
      cands.forEach((c, i) => {
        const slot = res[i * 2], liq = res[i * 2 + 1];
        if (slot.status !== 'success' || liq.status !== 'success') return;
        const sqrtP = (slot.result as readonly [bigint, number, number, number])[0];
        const L = liq.result as bigint;
        if (sqrtP === 0n || L === 0n) return; // uninitialized or no in-range liquidity
        const cur = best.get(c.pair.symbol);
        if (!cur || L > cur.liq) best.set(c.pair.symbol, { cand: c, liq: L });
      });
      markets = [...best.values()].map(({ cand }) => ({
        market: cand.pair.symbol,
        key: cand.key,
        feeBps: cand.key.fee / 100,
        baseIsCurrency0: cand.key.currency0 === cand.base.addr.toLowerCase(),
        baseDec: cand.base.dec, quoteDec: cand.quote.dec,
        baseTok: cand.base.tok, quoteTok: cand.quote.tok,
      }));
      ctx.note('venue.discovery', `Uniswap v4: ${markets.length} baseline pool(s) (deepest hookless tier per pair)`);
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      if (!markets.length) return [];
      type Leg = { m: UniMarket; size: number; side: 'buy' | 'sell'; inHuman: number };
      const legs: Leg[] = [];
      const calls: Array<{ address: `0x${string}`; abi: typeof quoterAbi; functionName: 'quoteExactInputSingle'; args: readonly [{ poolKey: PoolKey; zeroForOne: boolean; exactAmount: bigint; hookData: `0x${string}` }] }> = [];
      for (const m of markets) {
        if (ctx.pricer.pairMid(m.market) <= 0) continue; // reference not warm — no comparable row
        for (const size of sizesUsd) {
          // BUY base: exact-in the quote leg (stables ≡ $, crypto quotes priced live)
          const quoteIn = ctx.pricer.tokenForUsd(m.quoteTok, size);
          // SELL base: exact-in the base leg
          const baseIn = ctx.pricer.tokenForUsd(m.baseTok, size);
          if (quoteIn <= 0 || baseIn <= 0) continue;
          legs.push({ m, size, side: 'buy', inHuman: quoteIn });
          calls.push({ address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: m.key, zeroForOne: !m.baseIsCurrency0, exactAmount: BigInt(Math.round(quoteIn * 10 ** m.quoteDec)), hookData: '0x' }] });
          legs.push({ m, size, side: 'sell', inHuman: baseIn });
          calls.push({ address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: m.key, zeroForOne: m.baseIsCurrency0, exactAmount: BigInt(Math.round(baseIn * 10 ** m.baseDec)), hookData: '0x' }] });
        }
      }
      if (!calls.length) return [];
      // quoter sims are gas-heavy — keep each aggregate comfortably under call caps
      const qRes = await ctx.client.multicall({ contracts: calls, allowFailure: true, batchSize: 4096 });

      const rowByKey = new Map<string, QuoteRow>();
      const ts = Date.now();
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const r = qRes[i];
        if (r.status !== 'success') continue; // pool can't serve this leg (drained side) — stays one-sided/absent
        const [amountOut] = r.result as readonly [bigint, bigint];
        if (amountOut === 0n) continue;
        const mid = ctx.pricer.pairMid(l.m.market);
        // realized pair-terms price for the leg (quoter output is fee-inclusive)
        const px = l.side === 'buy'
          ? l.inHuman / (Number(amountOut) / 10 ** l.m.baseDec)   // quote in / base out
          : (Number(amountOut) / 10 ** l.m.quoteDec) / l.inHuman; // quote out / base in
        const bps = (px / mid - 1) * 1e4;
        if (!Number.isFinite(bps) || Math.abs(bps) > PER_SIDE_BAND_BPS) continue; // not a comparable execution
        const key = `${l.m.market}|${l.size}`;
        let row = rowByKey.get(key);
        if (!row) {
          row = { venueId: UNI_VENUE.id, market: l.m.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: l.m.feeBps, ts };
          rowByKey.set(key, row);
        }
        if (l.side === 'buy') { row.askBps = bps; row.askPx = px; }
        else { row.bidBps = bps; row.bidPx = px; }
      }
      const rows = [...rowByKey.values()];
      for (const row of rows) {
        const hasBid = row.bidPx > 0, hasAsk = row.askPx > 0;
        if (hasBid && hasAsk) row.spreadBps = row.askBps - row.bidBps;
        else row.oneSided = true; // one leg failed the band/quoter — show the real side only
      }
      return rows.filter((r) => r.bidPx > 0 || r.askPx > 0);
    },

    // quote-only baseline: no fills, no volume, no markouts.
    logSources: () => [],
    decode: () => [],
  };
}
