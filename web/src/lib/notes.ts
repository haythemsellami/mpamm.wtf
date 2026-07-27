/**
 * Classify a state.notes entry as routine (boot/discovery count) vs a real
 * degradation. Routine lines come from ctx.log() in venue adapters and always
 * contain a numeric count followed by a plural noun with "(s)" — e.g.
 * "POE: 1 base/stable pool(s)", "Uniswap v4: 5 baseline pool(s) (...)".
 * Everything else (feed starvation, RPC failover, backfill paused, archive
 * missing, etc.) is a degradation and surfaces in the chip count.
 */
export function isRoutineNote(note: string): boolean {
  return /\b\d+\b.*\(s\)/.test(note);
}
