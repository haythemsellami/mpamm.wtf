import type { QuoteRow, QuoteSnapshot } from '@shared';

/** docs/rebuild-spec.md → Render rules: a venue that misses a block stays on
 *  screen with its last rows, greyed and labelled with their age, for up to
 *  3 blocks (~1 s), so one miss doesn't make it flicker; after that it is
 *  hidden until it quotes again. Late rows never enter a comparison (the ★,
 *  rankings): only the newest frame's rows do. */
export const LATE_MAX_BLOCKS = 3;

export interface LateVenue {
  venueId: string;
  rows: QuoteRow[];
  /** The block its rows are from, and how many blocks old they are. */
  block: number;
  age: number;
}

export interface LateState {
  market: string;
  size: number;
  seen: Record<string, { rows: QuoteRow[]; block: number }>;
}

/** Folds one frame of the watched market into the state: venues with rows
 *  in it are fresh; a venue without keeps its last rows while they are at
 *  most `LATE_MAX_BLOCKS` old. A frame for another market or size starts
 *  over. */
export function trackLate(
  prev: LateState | null,
  frame: QuoteSnapshot,
  market: string,
  size: number,
): { state: LateState; late: LateVenue[] } {
  const seen: LateState['seen'] = prev && prev.market === market && prev.size === size ? { ...prev.seen } : {};
  const fresh = new Map<string, QuoteRow[]>();
  for (const r of frame.rows) {
    if (r.market !== market) continue;
    const rows = fresh.get(r.venueId);
    if (rows) rows.push(r);
    else fresh.set(r.venueId, [r]);
  }
  for (const [venueId, rows] of fresh) seen[venueId] = { rows, block: frame.block };
  const late: LateVenue[] = [];
  for (const [venueId, last] of Object.entries(seen)) {
    if (fresh.has(venueId)) continue;
    const age = frame.block - last.block;
    // A replacement frame (same or lower height) isn't news about lateness.
    if (age <= 0) continue;
    if (age > LATE_MAX_BLOCKS) {
      delete seen[venueId];
      continue;
    }
    late.push({ venueId, rows: last.rows, block: last.block, age });
  }
  return { state: { market, size, seen }, late };
}
