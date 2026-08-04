import { parseAbi } from 'viem';
import type { QuoteRow, Fill, Side, VenueMeta } from '@shared';
import { TOKENS, ASSETS, PAIRS, baseTokenOf } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';
import { createQuoteOutageReporter } from './quote-health.js';

/**
 * LFJ POE adapter — LFJ's "Public Prop AMM" on Monad, fully on-chain and generic
 * over base/quote (any tracked base asset vs a USD stable; POE currently lists
 * MON/USDC only).
 *
 * POE is a propAMM, NOT LFJ's Liquidity Book: each pool prices off a ClapOracle
 * (Concentrated-Liquidity Constant-Product); the pool's own `getQuote` returns an
 * executable, fee-inclusive amount, so the read is a single view call:
 *   Factory.getPool(x, y)                        → the pool for a token pair
 *   Pool.getTokens()                             → canonical tokenX / tokenY
 *   Pool.getQuote(swapXtoY, amountIn)            → amountOut (+ actualAmountIn, fees)
 *   Pool.Swap(…, actualAmountIn, amountOut, …)   → the landed fill
 *
 * No backfill (no keyless deep-history source) — volume is seeded by the core's
 * background on-chain replay from `backfillFromUtc`. ABIs: LFJ POE OraclePool
 * (developers.lfj.gg/poe). Verified live on Monad.
 */

/** LFJ POE display venue — keeps LFJ's brand palette (POE is an LFJ product). */
// sinceUtc = the pool's on-chain deploy day (block 73455416) — same anchor as backfillFromUtc.
// color: orange in BOTH themes (dark was periwinkle — colliding with the dark
// link color and breaking cross-theme identity). Palette validated (CVD/contrast).
const POE_VENUE: VenueMeta = { id: 'poe', name: 'LFJ POE', color: { light: '#FF4D00', dark: '#EA580C' }, kind: 'amm', role: 'venue', sinceUtc: '2026-05-09' };

/** POE OraclePoolFactory on Monad (sorts token args internally). */
const FACTORY = '0x78120F2C0EBF0cc8B7E7749e62D36e6523dD711D' as const;
const ZERO = '0x0000000000000000000000000000000000000000';

const poeFactoryAbi = parseAbi([
  'function getPool(address tokenX, address tokenY) view returns (address)',
]);
const poePoolAbi = parseAbi([
  'function getTokens() view returns (address tokenX, address tokenY)',
  'function getQuote(bool swapXtoY, uint256 amountIn) view returns (uint256 amountOut, uint256 actualAmountIn, uint256 feeIn, uint256 feeOut)',
  'function getOracle() view returns (address)',
  'event Swap(address indexed sender, address indexed recipient, bool indexed swapXtoY, uint256 actualAmountIn, uint256 amountOut, uint256 feeIn, uint256 feeOut)',
]);

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

interface PoePool {
  pool: `0x${string}`;
  market: string;    // 'MON/USDC'
  baseIsX: boolean;  // is the base asset tokenX of the pool?
  baseToken: string; // TOKENS key of the base wrapper ('WMON'|'WBTC'|'WETH')
  baseDec: number;
  stableSym: string;
  stableDec: number;
}

/**
 * LFJ POE adapter — on-chain discovery (Factory.getPool + Pool.getTokens) +
 * executable quotes (Pool.getQuote) + Pool.Swap fill decode. No backfill().
 */
export function createPoeAdapter(): VenueAdapter {
  // every leg reverting is a venue-wide cause (paused, ABI drift), not a
  // per-pair gap — name it instead of vanishing (venues/quote-health.ts).
  const reportOutage = createQuoteOutageReporter(POE_VENUE.name);
  // MERGE, never replace (LFJ review #3): getPool is a factory READ, not a
  // cursor-holding log source, so a transient/partial discovery must only
  // ADD/refresh pools — never shrink the tailed set or drop an address a live
  // tail may still decode against.
  const byMarket = new Map<string, PoePool>();
  const byAddr = new Map<string, PoePool>();
  let discovered = false;
  /** the shared ClapOracle — every pool prices off it; LFJ's keeper pushes
   *  setData() to it EVERY block. Resolved on-chain (pool.getOracle()) so an
   *  oracle migration re-resolves on rediscovery instead of tracking a corpse. */
  let clapOracle: `0x${string}` | undefined;

  return {
    venues: () => [POE_VENUE],
    // seed daily volume by replaying Pool.Swap on-chain from the WMON/USDC pool's
    // deployment (block 73455416 · 2026-05-09). Background — see live.ts.
    backfillFromUtc: '2026-05-09',

    async discover(ctx: AdapterContext) {
      // discover pools for exactly the REGISTERED pairs (@shared PAIRS — the
      // tracked-market universe), so this adapter can never emit a market with
      // no reference rows / markout routing.
      const combos = PAIRS.map((pair) => {
        const asset = ASSETS[pair.base];
        const baseTok = baseTokenOf(pair.base);
        const stable = TOKENS[pair.quote];
        return asset && baseTok && stable?.stable ? { pair, asset, baseTok, stable } : undefined;
      }).filter((c): c is NonNullable<typeof c> => !!c);

      // phase 1: resolve the POE pool for each registered pair.
      const poolRes = await ctx.client.multicall({
        contracts: combos.map((c) => ({ address: FACTORY, abi: poeFactoryAbi, functionName: 'getPool' as const, args: [c.baseTok.address, c.stable.address] as const })),
        allowFailure: true,
      });
      const candidates: { pool: `0x${string}`; combo: (typeof combos)[number] }[] = [];
      for (let i = 0; i < combos.length; i++) {
        const r = poolRes[i];
        // fail closed: an RPC error on a configured lookup holds the cursor (throws).
        if (r.status !== 'success') throw new Error(`POE getPool failed for ${combos[i].pair.symbol}`);
        const addr = String(r.result).toLowerCase() as `0x${string}`;
        if (addr === ZERO) continue; // no POE pool for this pair — normal
        candidates.push({ pool: addr, combo: combos[i] });
      }
      if (!candidates.length) { discovered = true; ctx.note('venue.discovery', 'POE: 0 base/stable pool(s)'); return; }

      // phase 2: canonical token order (which side is the base) per pool.
      const tokRes = await ctx.client.multicall({
        contracts: candidates.map((c) => ({ address: c.pool, abi: poePoolAbi, functionName: 'getTokens' as const })),
        allowFailure: true,
      });
      // the shared ClapOracle, from the first pool that answers (they all
      // return the same one — verified on-chain). Best-effort: a failed read
      // defers the gas source (gasSources throws), never discovery itself.
      try {
        const o = String(await ctx.client.readContract({ address: candidates[0].pool, abi: poePoolAbi, functionName: 'getOracle' }));
        if (/^0x[0-9a-fA-F]{40}$/.test(o) && o !== ZERO) clapOracle = o.toLowerCase() as `0x${string}`;
      } catch { /* resolved on a later rediscovery */ }

      for (let i = 0; i < candidates.length; i++) {
        const r = tokRes[i];
        if (r.status !== 'success') throw new Error(`POE getTokens failed for ${candidates[i].pool}`);
        const [tx] = r.result as readonly [string, string];
        const { pool, combo } = candidates[i];
        const p: PoePool = {
          pool,
          market: combo.pair.symbol,
          baseIsX: String(tx).toLowerCase() === combo.baseTok.address.toLowerCase(),
          baseToken: combo.asset.token,
          baseDec: combo.baseTok.decimals,
          stableSym: combo.stable.symbol,
          stableDec: combo.stable.decimals,
        };
        byMarket.set(p.market, p);
        byAddr.set(p.pool.toLowerCase(), p);
      }
      discovered = true;
      ctx.note('venue.discovery', `POE: ${byMarket.size} base/stable pool(s)`);
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      const pools = [...byMarket.values()];
      if (!pools.length) return [];

      // getQuote(swapXtoY, amountIn) per pool × size × side (view — eth_call).
      type Leg = { pool: PoePool; size: number; side: Side; reqIn: bigint; inDec: number; outDec: number; basePx: number };
      const legs: Leg[] = [];
      const calls: { address: `0x${string}`; abi: typeof poePoolAbi; functionName: 'getQuote'; args: readonly [boolean, bigint] }[] = [];
      for (const p of pools) {
        // bps anchor = the pair-terms CEX mid (wrap basis + stable cross applied),
        // NOT the raw USDT price — venue quotes are in the pair's stable terms.
        const basePx = ctx.pricer.pairMid(p.market);
        if (basePx <= 0) continue;
        for (const size of sizesUsd) {
          // BUY base: spend the stable. swapXtoY sends X→Y, so buying the base is
          // X→Y when the stable is X (i.e. the base is NOT X).
          const buyIn = toUnits(size, p.stableDec);
          legs.push({ pool: p, size, side: 'buy', reqIn: buyIn, inDec: p.stableDec, outDec: p.baseDec, basePx });
          calls.push({ address: p.pool, abi: poePoolAbi, functionName: 'getQuote', args: [!p.baseIsX, buyIn] });
          // SELL base: spend base worth `size`. swapXtoY when the base IS X.
          const sellIn = toUnits(ctx.pricer.tokenForUsd(p.baseToken, size), p.baseDec);
          legs.push({ pool: p, size, side: 'sell', reqIn: sellIn, inDec: p.baseDec, outDec: p.stableDec, basePx });
          calls.push({ address: p.pool, abi: poePoolAbi, functionName: 'getQuote', args: [p.baseIsX, sellIn] });
        }
      }
      if (!calls.length) return [];
      const res = await ctx.client.multicall({ contracts: calls, allowFailure: true });
      if (reportOutage(ctx, res)) return [];

      const rowByKey = new Map<string, QuoteRow>();
      const ts = Date.now();
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const r = res[i];
        if (r.status !== 'success') continue;
        const [amountOut, actualAmountIn, feeIn, feeOut] = r.result as readonly [bigint, bigint, bigint, bigint];
        if (amountOut <= 0n || actualAmountIn <= 0n) continue;
        const inH = fromUnits(actualAmountIn, l.inDec);
        const outH = fromUnits(amountOut, l.outDec);
        if (inH <= 0 || outH <= 0) continue;
        const px = l.side === 'buy' ? inH / outH : outH / inH; // stable per base (all-in)
        const bps = (px / l.basePx - 1) * 1e4;
        const legFull = actualAmountIn >= (l.reqIn * 999n) / 1000n;
        const feeBps = ((actualAmountIn > 0n ? Number(feeIn) / Number(actualAmountIn) : 0) + (amountOut > 0n ? Number(feeOut) / Number(amountOut) : 0)) * 1e4;

        const key = `${l.pool.market}|${l.size}`;
        let row = rowByKey.get(key);
        if (!row) {
          row = { venueId: POE_VENUE.id, market: l.pool.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
          rowByKey.set(key, row);
        }
        if (l.side === 'buy') { row.askBps = bps; row.askPx = px; }
        else { row.bidBps = bps; row.bidPx = px; }
        row.feeBps = Math.max(row.feeBps, feeBps);
        row.filledFull &&= legFull;
      }
      for (const row of rowByKey.values()) row.spreadBps = row.askBps - row.bidBps;
      return [...rowByKey.values()].filter((r) => r.askPx > 0 && r.bidPx > 0);
    },

    logSources() {
      if (!discovered) throw new Error('POE discovery unavailable'); // hold the cursor until discovered
      const pairs = [...byMarket.values()].map((p) => p.pool);
      if (!pairs.length) return [];
      return [{ key: 'swap', address: pairs, events: [ev(poePoolAbi, 'Swap')], kind: 'fills' as const }];
    },

    // taker entries owned by the venue: the pools themselves. LFJ's routers are
    // in the global registry (they route beyond POE, so they carry the brand).
    entryPoints: () => [...byMarket.values()].map((p) => ({ address: p.pool })),

    // QUOTE_UPDATE_BURN: the oracle operator pushes setData() to the
    // ClapOracle every block (~400ms) with NO event, so updates can't be
    // enumerated from logs — 'blocks' mode samples eth_getBlockReceipts for
    // txs to the oracle and scales by the stride. Sound here precisely
    // BECAUSE the cadence is one-per-block; the UI shows ≈.
    // PROVENANCE (deep-reviewed 2026-07-10): the oracle address is listed on
    // LFJ's own contracts page (developers.lfj.gg/poe/poe-contracts) AND
    // re-derived on-chain from pool.getOracle() at every discovery; their
    // "Tracking Price" doc describes the operator-push model. COMPLETENESS:
    // 400/400 sampled txs to the oracle are setData (no admin noise), and
    // the docs route price/fee/alpha exclusively through it — no other
    // POE-funded update destination exists.
    gasSources() {
      if (!clapOracle) throw new Error('POE oracle not resolved yet'); // hold the gas cursor
      return [{ mode: 'blocks' as const, address: clapOracle }];
    },

    decode(_ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      for (const l of logs.swap ?? []) {
        const p = byAddr.get(String(l.address).toLowerCase());
        if (!p) continue;
        const a = l.args;
        if (!a || a.actualAmountIn === undefined || a.amountOut === undefined) continue;
        const actualAmountIn = BigInt(a.actualAmountIn), amountOut = BigInt(a.amountOut);
        // swapXtoY sends tokenX→tokenY, so the input is the base exactly when swapXtoY === baseIsX.
        const inputIsBase = Boolean(a.swapXtoY) === p.baseIsX;
        const baseRaw = inputIsBase ? actualAmountIn : amountOut;
        const stableRaw = inputIsBase ? amountOut : actualAmountIn;
        const baseAmount = fromUnits(baseRaw, p.baseDec);
        const usd = fromUnits(stableRaw, p.stableDec);
        if (baseAmount <= 0 || usd <= 0) continue;
        const execPx = usd / baseAmount; // realized stable-per-base (real markouts, no pxApprox)
        const side: Side = inputIsBase ? 'sell' : 'buy'; // spent base ⇒ sell
        out.push({
          id: `poe-${String(l.transactionHash).toLowerCase()}-${l.logIndex}`,
          venueId: POE_VENUE.id,
          // attribution is the core's job (tx.to): claiming DIRECT here would
          // label aggregator/searcher flow as direct — emit honest UNKNOWN.
          market: p.market, side, category: 'UNKNOWN',
          usd, baseAmount, execPx,
          txHash: l.transactionHash, to: shortHex(String(a.recipient ?? '0x')),
          pool: `poe ${p.pool.slice(0, 8)}`,
          blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
          markoutsBps: [null, null, null, null, null],
        });
      }
      return out;
    },
  };
}
