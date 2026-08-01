// state.notes classification (shared isRoutineNote, consumed by the TopBar chip).
// The bug this covers: the first version classified a note as routine whenever it held a
// count and a plural "(s)". The server's real strings break that in both directions, so
// four real degradations were hidden from the chip and two backfill progress lines kept it
// amber for the process lifetime. Every string below is the actual format from the source,
// cited by file, so a change to an emitter shows up here.
import { describe, expect, it } from 'vitest';
import { isRoutineNote } from '@shared';

/** Discovery, progress and completion lines. The chip does not count these. */
const ROUTINE: [string, string][] = [
  ['POE: 3 base/stable pool(s)', 'venues/poe.ts'],
  ['POE: 0 base/stable pool(s)', 'venues/poe.ts'],
  ['Metric: 2 base/stable pool(s)', 'venues/metric.ts'],
  ['Uniswap v4: 5 baseline pool(s) (deepest hookless tier per pair)', 'venues/uniswap.ts'],
  ['Hanji: 4 market(s), taker fee 10bps (on-chain config)', 'venues/hanji.ts'],
  ['Lunarbase: 3/5 validated production pool(s), whitelist fee mode', 'venues/lunarbase.ts'],
  ['Clober: subgraph discovery (7 vault book(s))', 'venues/clober.ts'],
  ['MyVenue: discovered 12 market(s)', 'venues/_template.ts'],
  ['Clober: backfill complete — 30 day(s) seeded', 'datasource/live.ts'],
  ['Hanji: onboarding fill scan complete — 812 historical fill(s) persisted', 'datasource/live.ts'],
  ['Clober MON/USDC: markouts backfilled for 44 fill(s)', 'datasource/live.ts'],
  ['seeded 14 closed day-row(s) from adapter backfill; on-chain-only venues accumulate forward', 'datasource/live.ts'],
  ['Clober: on-chain backfill 2026-07-04 — blocks 12000→13000', 'datasource/live.ts:551'],
  ['Hanji: onboarding fill scan 2026-07-04 — blocks 12000→13000', 'datasource/live.ts:759'],
  ['bybit feed recovered: MONUSDT mid is back — MON pairs visible again (hidden for ~37m)', 'datasource/live.ts'],
];

/** Everything the chip must count, including the four the old heuristic swallowed. */
const DEGRADED: [string, string][] = [
  ['Metric: push oracle serves 6 feed(s) but Metric uses 4 — burn attribution may overcount', 'venues/metric.ts:156'],
  [
    'Clober backfill: RPC archive could not serve blocks near 9000 — skipping unreadable range(s); affected day(s) may undercount',
    'datasource/live.ts:595',
  ],
  ['attribution: relabeled 12 retained unevidenced DIRECT fill(s) to UNKNOWN', 'datasource/live.ts:275'],
  ['attribution: reclassified 3 FastLane fill(s) ROUTER → MEV', 'datasource/live.ts:283'],
  ['pruned 5 volume row(s) + 9 fill(s) for removed venue(s)', 'datasource/live.ts'],
  ['Clober discovery failed: HTTP 429', 'datasource/live.ts'],
  ['Hanji backfill unavailable (timeout after 30s); history grows forward', 'datasource/live.ts'],
  ['resuming: gap-filling 1200 block(s) since last run', 'datasource/live.ts'],
  ['gap exceeds 5000 blocks — resuming at tip (interim fills not decoded)', 'datasource/live.ts'],
  ['cold start — today builds forward from now', 'datasource/live.ts'],
  ["dropped backfill volume for foreign venue 'ghost'", 'datasource/live.ts'],
  ['backfill reset applied (all) — re-scanning: clober, hanji', 'datasource/live.ts'],
  ['Clober: authoritative discovery unavailable; holding Take ranges until rediscovery succeeds', 'venues/clober.ts'],
  ['Clober: subgraph discovery failed; trying recent Open logs', 'venues/clober.ts'],
  ['Hanji: FOO/BAR is not a registered pair — skipped', 'venues/hanji.ts'],
  ['Metric: pool 0x1234abcd… (WBTC/USDC) is not a registered pair — skipped', 'venues/metric.ts'],
  ['Lunarbase MON/USDC implementation changed 0x1111111111… → 0x2222222222…', 'venues/lunarbase.ts'],
  ['Clober: gas series removed — venue no longer declares quote-update sources', 'gas.ts'],
  ['Clober: quote-update gas tail paused (RPC 500); retried next pass', 'gas.ts'],
  ['Clober: verifying quote-update coverage — rebuilding from 2026-07-01', 'gas.ts'],
  ['Clober: deepening quote-update gas history to 2026-06-01 — re-scanning', 'gas.ts'],
  ['Clober: quote-update destination added — rebuilding from 2026-07-01 (earlier history unaffected)', 'gas.ts'],
  ['Clober: quote-update destination set changed — re-scanning venue lifetime', 'gas.ts'],
];

describe('isRoutineNote', () => {
  it.each(ROUTINE)('routine: %s (%s)', (note) => {
    expect(isRoutineNote(note)).toBe(true);
  });

  it.each(DEGRADED)('degradation: %s (%s)', (note) => {
    expect(isRoutineNote(note)).toBe(false);
  });

  it('hides nothing it has not recognized', () => {
    // An unclassified note counts as a degradation: the chip is the only place a note
    // surfaces at all, so an unknown string must raise it rather than sit under DISCOVERY.
    expect(isRoutineNote('some future note nobody has seen yet with 4 thing(s)')).toBe(false);
    expect(isRoutineNote('')).toBe(false);
  });

  it('the chip stays hidden on a clean boot and raises on the archive skip', () => {
    // The regression in one assertion: discovery plus progress is a quiet chip, and the
    // note whose only symptom is undercounted days is what the chip exists to show.
    const cleanBoot = ROUTINE.map(([n]) => n);
    expect(cleanBoot.filter((n) => !isRoutineNote(n))).toEqual([]);
    const withArchiveSkip = [...cleanBoot, DEGRADED[1][0]];
    expect(withArchiveSkip.filter((n) => !isRoutineNote(n))).toEqual([DEGRADED[1][0]]);
  });
});
