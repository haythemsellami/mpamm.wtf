import type { QuoteSnapshot, StreamEnvelope } from '@shared';

/** Browser-local timings cross the SharedWorker boundary, never the wire. */
export type ReceivedEnvelope = StreamEnvelope & { timing?: { receivedAt: number; decodedAt: number } };
export interface FrameTiming {
  block: number;
  revision: number;
  ts: number;
  /** The block's proposal time (server clock), when the producer sends it. */
  proposalTs?: number;
  receivedAt: number;
  decodedAt: number;
  drawnAt?: number;
  paintOpportunityAt?: number;
}
const pending = new WeakMap<QuoteSnapshot, FrameTiming>();
const samples: FrameTiming[] = [];
export const browserNow = () => performance.timeOrigin + performance.now();
export const timingEnabled = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('timing') === '1';
const enabled = timingEnabled;

export function recordFrameDelivery(envelope: ReceivedEnvelope): void {
  if (!enabled() || envelope.snapshot || envelope.message.ch !== 'quotes' || !envelope.timing || document.hidden) return;
  const quote = envelope.message.data;
  pending.set(quote, { block: quote.block, revision: quote.revision ?? 0, ts: quote.ts, proposalTs: quote.proposalTs, ...envelope.timing });
}
export function recordCanvasDraw(quote: QuoteSnapshot | null): void {
  if (!quote || !enabled() || document.hidden) return;
  const sample = pending.get(quote);
  if (!sample) return;
  pending.delete(quote);
  sample.drawnAt = browserNow();
  samples.push(sample);
  if (samples.length > 600) samples.shift();
  // This bounds a presentation opportunity, not hardware scan-out. All clocks
  // here belong to this browser; the overlay's proposal → paint is the one
  // figure that subtracts a server stamp, and it says so.
  requestAnimationFrame(() => setTimeout(() => {
    if (!document.hidden) sample.paintOpportunityAt = browserNow();
  }, 0));
  Object.assign(window, { __mpammTiming: samples });
}

/** Painted samples so far (the overlay reads them). */
export function timingSamples(): readonly FrameTiming[] {
  return samples;
}

/** p50 / p90 of each hop over painted samples, in ms. `proposal → paint`
 *  is the one cross-clock figure (the server's proposal stamp against this
 *  browser's paint): it holds to NTP accuracy, so it is labelled as such. */
export function timingSummary(list: readonly FrameTiming[]): Record<string, { p50: number; p90: number; n: number } | null> {
  const painted = list.filter((s) => s.paintOpportunityAt !== undefined);
  const q = (xs: number[]) => {
    if (!xs.length) return null;
    const v = [...xs].sort((a, b) => a - b);
    const at = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
    return { p50: at(0.5), p90: at(0.9), n: v.length };
  };
  return {
    'proposal → paint': q(painted.filter((s) => s.proposalTs !== undefined).map((s) => s.paintOpportunityAt! - s.proposalTs!)),
    'receive → paint': q(painted.map((s) => s.paintOpportunityAt! - s.receivedAt)),
    'receive → draw': q(painted.map((s) => s.drawnAt! - s.receivedAt)),
  };
}
