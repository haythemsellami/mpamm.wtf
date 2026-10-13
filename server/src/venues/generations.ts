import type { QuoteRow, VenueMeta } from '@shared';
import type { AdapterContext, EntryPoint, GasSource, HistoryRevision, LogBundle, LogSource, VenueAdapter } from './adapter.js';

/**
 * One venue, several contract GENERATIONS. A protocol that redeploys (new
 * factory, new ABI) is still the same venue: its history is keyed by venue id,
 * and a new id would be a different venue whose old rows the boot reconcile
 * prunes. So the redeploy is a new generation module behind the SAME
 * VenueMeta, and this composer is what the registry sees.
 *
 * Dispatch is by the contract that emitted a log, never by time: each
 * generation declares its own sources, so the composer only namespaces their
 * keys (`<gen>:<key>`) and hands each generation back exactly what it asked
 * for. A retired generation stays decode-capable for lifetime replays and
 * declares a bounded span (LogSource.untilBlock), so the core never fetches it
 * live. See docs/adapters.md → Retiring contracts.
 */
export type VenueGeneration = Omit<VenueAdapter, 'venues' | 'backfill' | 'backfillFromUtc' | 'historyRevisions'>;

export function composeGenerations(meta: VenueMeta, opts: { backfillFromUtc?: string; historyRevisions?: readonly HistoryRevision[] }, generations: Record<string, VenueGeneration>): VenueAdapter {
  const gens = Object.entries(generations);
  const prefix = (name: string) => `${name}:`;
  const withGas = gens.filter(([, g]) => g.gasSources);

  const adapter: VenueAdapter = {
    venues: () => [meta],
    backfillFromUtc: opts.backfillFromUtc,
    historyRevisions: opts.historyRevisions,
    quoteMarkets: () => [...new Set(gens.flatMap(([, g]) => g.quoteMarkets?.() ?? []))],

    // Every generation runs even when one fails, so a retired generation's
    // problem can never stall the live one's discovery — then the first error
    // is surfaced, as the core expects of any discover().
    async discover(ctx: AdapterContext) {
      const results = await Promise.allSettled(gens.map(([, g]) => g.discover(ctx)));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[], blockNumber: bigint, markets?: ReadonlySet<string>): Promise<QuoteRow[]> {
      const rows = await Promise.all(gens.map(([, g]) => g.quote?.(ctx, sizesUsd, blockNumber, markets) ?? Promise.resolve([])));
      return rows.flat();
    },

    // A throw from ANY generation propagates: logSources() is the core's
    // fail-closed gate, and a partial source set would advance the cursor
    // past the other generation's unfetched logs.
    logSources(): LogSource[] {
      return gens.flatMap(([name, g]) => g.logSources().map((s) => ({ ...s, key: prefix(name) + s.key })));
    },

    entryPoints: (): EntryPoint[] => gens.flatMap(([, g]) => g.entryPoints?.() ?? []),

    async decode(ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number, failedSources: Set<string>) {
      const out = [];
      for (const [name, g] of gens) {
        const p = prefix(name);
        const keys = Object.keys(logs).filter((k) => k.startsWith(p));
        // a bundle carries only the sources its caller fetched (the volume
        // backfill takes 'fills' sources only); a generation with none of its
        // keys present has nothing to decode in it
        if (!keys.length) continue;
        const own: LogBundle = Object.fromEntries(keys.map((k) => [k.slice(p.length), logs[k]]));
        const failed = new Set([...failedSources].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)));
        out.push(...await g.decode(ctx, own, tsOf, failed));
      }
      return out;
    },
  };
  // Declared only when some generation burns quote-update gas: the tracker
  // treats an ABSENT hook as "this venue does not self-fund" and wipes the series.
  if (withGas.length) adapter.gasSources = (): GasSource[] => withGas.flatMap(([, g]) => g.gasSources!());
  return adapter;
}
