import type { VenueAdapter } from './adapter.js';
import { composeGenerations } from './generations.js';
import { METRIC_VENUE } from './metric-shared.js';
import { createMetricV0Generation } from './metric-v0.js';
import { createMetricV1Generation } from './metric-v1.js';

/**
 * Metric — an oracle-anchored bin AMM (propAMM), fully on-chain and generic
 * over base/quote (MON/USDC, BTC/USDC, ETH/USDC — every pool is a tracked base
 * asset vs a USD stable). Verified live on Monad.
 *
 * Metric REDEPLOYED its whole protocol in September 2026 (new factory, router,
 * quoter and a different Swap ABI) and moved its liquidity over, so the venue
 * is two contract generations behind ONE venue id (generations.ts):
 *   v0  metric-v0.ts  2026-03-30 → 2026-09-27 · retired: decode-only, its swap
 *                     source bounded at the last v0 swap — zero live RPC, still
 *                     replayable for lifetime history.
 *   v1  metric-v1.ts  2026-10-04 →           · live: discovery, quotes, fills, gas.
 *
 * No backfill source is keyless, so volume is seeded by the core's background
 * on-chain replay from `backfillFromUtc` — the v0 deploy day; each generation's
 * sources carry their own block span, so the replay fetches v0 only up to its
 * retirement and v1 only from its factory's creation.
 *
 * History revisions (HistoryRevision — applied once per database on deploy):
 *   v1-deploy-day  2026-10-12, the day v1 support shipped. The operator reset
 *                  then (BACKFILL_RESET=metric:2026-10-04) replayed only closed
 *                  days, so midnight → deploy stayed decoded without the v1
 *                  sources: $572k served against ~$3M on the days around it.
 */
export function createMetricAdapter(): VenueAdapter {
  return composeGenerations(METRIC_VENUE, {
    backfillFromUtc: METRIC_VENUE.sinceUtc,
    historyRevisions: [{ id: 'v1-deploy-day', from: '2026-10-12' }],
  }, {
    v0: createMetricV0Generation(),
    v1: createMetricV1Generation(),
  });
}
