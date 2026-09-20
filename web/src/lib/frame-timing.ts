import type { QuoteSnapshot, StreamEnvelope } from '@shared';

/** Browser-local timings cross the SharedWorker boundary, never the wire. */
export type ReceivedEnvelope = StreamEnvelope & { timing?: { receivedAt: number; decodedAt: number } };
interface FrameTiming {
  block: number;
  ts: number;
  receivedAt: number;
  decodedAt: number;
  drawnAt?: number;
  paintOpportunityAt?: number;
}
const pending = new WeakMap<QuoteSnapshot, FrameTiming>();
const samples: FrameTiming[] = [];
export const browserNow = () => performance.timeOrigin + performance.now();
const enabled = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('timing') === '1';

export function recordFrameDelivery(envelope: ReceivedEnvelope): void {
  if (!enabled() || envelope.snapshot || envelope.message.ch !== 'quotes' || !envelope.timing || document.hidden) return;
  const quote = envelope.message.data;
  pending.set(quote, { block: quote.block, ts: quote.ts, ...envelope.timing });
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
  // belong to this browser; server timestamps are never subtracted from them.
  requestAnimationFrame(() => setTimeout(() => {
    if (!document.hidden) sample.paintOpportunityAt = browserNow();
  }, 0));
  Object.assign(window, { __mpammTiming: samples });
}
