import type { Fill, QuoteRow, VenueMeta } from '@shared';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';

/**
 * ADAPTER TEMPLATE — copy this file, rename it (e.g. `myvenue.ts`), fill in the
 * TODOs, and add one line to `registry.ts`. Nothing else in the core changes.
 * Delete the methods/patterns you don't need. Full guide: docs/adapters.md.
 *
 * Three sourcing patterns (mix freely):
 *   A. on-chain only  — discover + logSources + decode, NO backfill (like POE / Metric).
 *   B. one-time seed (subgraph/REST) + on-chain tail — add backfill().
 *   C. quote-only     — implement quote(); return [] from logSources()/decode().
 */

// 1) Describe your venue(s). `id` is the stable key used everywhere (Fill.venueId,
//    QuoteRow.venueId). `color` per theme is the ONE source of truth the frontend
//    reads — no color is hardcoded client-side. An adapter may return more than
//    one venue (tag each fill/quote with the matching id).
const MY_VENUE: VenueMeta = {
  id: 'my-venue',
  name: 'My Venue',
  color: { light: '#3366FF', dark: '#88AAFF' },
  kind: 'amm',      // 'amm' | 'clob' | 'vault' | 'cex'
  role: 'venue',    // 'venue' for a propAMM/on-chain venue ('reference' is CEX-only)
  // TODO: your venue's on-chain deploy / first-activity day. Per-day UI views
  // omit the venue before it, and the gas-burn history anchors on it.
  // verify-adapter FAILS a display venue without it.
  sinceUtc: '2026-01-01',
};

/** viem AbiEvent lookup helper (for logSources). */
const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

export function createTemplateAdapter(): VenueAdapter {
  // adapter-private state (discovered markets/pools/books). Held on the closure.
  let markets: unknown[] = [];
  let discovered = false;

  return {
    venues: () => [MY_VENUE],
    // TODO (recommended): the core replays your fill logs from this day for
    // venue-LIFETIME volume + swap counts. Usually equals sinceUtc.
    // backfillFromUtc: '2026-01-01',

    // Find your markets/pools. Use ctx.client (viem read/multicall) and/or fetch
    // a subgraph. Stash what you need on the closure state above.
    async discover(ctx: AdapterContext) {
      // markets = await ctx.client.readContract({ ... });   // on-chain
      // markets = (await (await fetch(ctx.config.subgraphUrl, { ... })).json()).data.pools;  // subgraph
      discovered = true;
      ctx.note('venue.discovery', `${MY_VENUE.name}: discovered ${markets.length} market(s)`);
    },

    // (Pattern B) OPTIONAL historical seed — closed-day volume and/or fills.
    // DELETE this whole method for on-chain-only venues (they build forward).
    async backfill(ctx: AdapterContext, sinceUtc: string) {
      // const rows = await fetchDailyVolume(ctx.config.subgraphUrl, sinceUtc);
      // return { days: rows.map((r) => ({ utcDay: r.day, byVenue: { [MY_VENUE.id]: { usd: r.usd } } })) };
      return {};
    },

    // (Pattern C) OPTIONAL live bid/ask for the Execution tab. One QuoteRow per
    // (market,size) you can quote. bid/ask are bps vs the PAIR's CEX mid
    // (ctx.pricer.pairMid — already in the pair's own terms: wrap basis + stable
    // cross applied); px is quote-per-base (stable per base). venueId = your id.
    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      const rows: QuoteRow[] = [];
      // const mid = ctx.pricer.pairMid(market); // bps anchor, per market
      // for (const market of markets) for (const sizeUsd of sizesUsd) {
      //   const { bidPx, askPx, filledFull } = await readYourQuoter(ctx.client, market, sizeUsd);
      //   rows.push({ venueId: MY_VENUE.id, market, sizeUsd,
      //     bidPx, askPx, bidBps: (bidPx/mid-1)*1e4, askBps: (askPx/mid-1)*1e4,
      //     spreadBps: (askPx-bidPx)/mid*1e4, filledFull, feeBps: 0, ts: Date.now() });
      // }
      return rows;
    },

    // Declare the contract logs the core fetches each cycle (read AFTER discover,
    // so pool addresses are known). `events` are viem AbiEvent objects. The core
    // getLogs's these over the new block range and returns them to decode() by key.
    // If discovery is required to enumerate fill/state sources, throw while it is
    // unavailable. Returning [] means "there are genuinely no logs to tail".
    // Classify each source with `kind` (governs failure handling): 'fills' (default)
    // + 'state' HOLD the cursor on failure — the whole cycle retries, so no fill is
    // lost or left undecodable; 'attribution' is tolerated (cursor advances; the
    // affected fill carries a degraded label instead of being dropped).
    logSources() {
      // if (!discovered) throw new Error(`${MY_VENUE.name} discovery unavailable`);
      // return [
      //   { key: 'swap',   address: MY_POOL_ADDRESS, events: [ev(myAbi, 'Swap')], kind: 'fills' },
      //   { key: 'open',   address: MY_FACTORY,      events: [ev(myAbi, 'PoolCreated')], kind: 'state' },
      //   { key: 'router', address: ROUTER_ADDRESS,  events: [ev(routerAbi, 'Swap')], kind: 'attribution' },
      // ];
      void ev; void discovered;
      return [];
    },

    // OPTIONAL — QUOTE_UPDATE_BURN (Volume tab): where does this venue's OWN
    // keeper pay gas to keep quotes fresh? Destination-keyed (the contract the
    // update tx goes TO — sender rotation never matters). 'logs' when updates
    // emit an event (exact counts; use raw `topic0` if the contract is
    // unverified); 'blocks' when they don't (sampled estimate, UI shows ≈ —
    // only sound for a near-constant keeper cadence). Throw while discovery
    // hasn't resolved the destination. OMIT THE HOOK ENTIRELY when the venue
    // doesn't self-fund its updates (external oracle / taker-paid JIT) —
    // absence is the honest value, not zero.
    // gasSources() {
    //   return [{ mode: 'logs', address: MY_STRATEGY, events: [ev(myAbi, 'UpdatePrice')] }];
    // },

    // Turn your fetched logs into normalized fills. `logs[key]` matches your
    // logSources keys; `tsOf(blockNumber)` → block timestamp (ms). Own any
    // venue-specific correlation here (router maps, mid-run pool discovery, …).
    // `failedSources` holds the keys of any 'attribution' sources that failed this
    // cycle — use it to avoid a confident label (e.g. category 'UNKNOWN' instead of
    // 'DIRECT' when your router/attribution source was unavailable).
    // Throw only when the whole range is unsafe to advance; the core will hold the
    // cursor and retry. Catch and skip individual malformed/irrelevant logs locally.
    decode(_ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number, _failedSources: Set<string>): Fill[] {
      const out: Fill[] = [];
      for (const l of logs.swap ?? []) {
        // decode l → usd (stable leg), baseAmount (MON), execPx (quote-per-base), side, market:
        // out.push({
        //   id: `mv-${l.transactionHash.toLowerCase()}-${l.logIndex}`,  // deterministic (txHash:logIndex) so re-tail dedupes
        //   venueId: MY_VENUE.id, market, side, category: 'DIRECT',
        //   usd, baseAmount, execPx, txHash: l.transactionHash, to, pool,
        //   blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
        //   markoutsBps: [null, null, null, null, null],  // the core ages these vs the reference
        // });
        void l; void tsOf;
      }
      return out;
    },
  };
}
