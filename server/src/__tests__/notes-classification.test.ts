// state.notes classification (shared isRoutineNote, consumed by the TopBar chip).
// The bug this covers: the first version classified a note as routine whenever it held a
// count and a plural "(s)". The server's real strings break that in both directions, so
// four real degradations were hidden from the chip and two backfill progress lines kept it
// amber for the process lifetime. There is one row here per note() / noteOnce() / ctx.log()
// call site in the tree, cited by file and line, with the real format and a representative
// interpolation, so a change to an emitter shows up here.
import { describe, expect, it } from 'vitest';
import { isRoutineNote } from '@shared';

/** Discovery, progress and completion lines. The chip does not count these. */
const ROUTINE: [string, string][] = [
  ['POE: 0 base/stable pool(s)', 'venues/poe.ts:105'],
  ['POE: 3 base/stable pool(s)', 'venues/poe.ts:138'],
  ['Metric: 2 base/stable pool(s)', 'venues/metric.ts:122'],
  ['Uniswap v4: 5 baseline pool(s) (deepest hookless tier per pair)', 'venues/uniswap.ts:135'],
  ['Hanji: 4 market(s), taker fee 10bps (on-chain config)', 'venues/hanji.ts:149'],
  ['Lunarbase: 3/5 validated production pool(s), whitelist fee mode', 'venues/lunarbase.ts:439'],
  ['Clober: subgraph discovery (7 vault book(s))', 'venues/clober.ts:481'],
  ['MyVenue: discovered 12 market(s)', 'venues/_template.ts:51'],
  ['ThogAMM: 7 registered market(s) across 12 on-chain token(s) at block 84500000', 'venues/thogamm.ts:245'],
  ['seeded 14 closed day-row(s) from adapter backfill; on-chain-only venues accumulate forward', 'live.ts:347'],
  ['Clober: on-chain backfill 2026-07-04 — blocks 12000→13000', 'live.ts:551'],
  ['Clober: backfill complete — 30 day(s) seeded', 'live.ts:653'],
  ['Hanji: onboarding fill scan 2026-07-04 — blocks 12000→13000', 'live.ts:759'],
  ['Hanji: onboarding fill scan complete — 812 historical fill(s) persisted', 'live.ts:839'],
  ['Clober MON/USDC: markouts backfilled for 44 fill(s)', 'live.ts:899'],
  ['bybit feed recovered: MONUSDT mid is back — MON pairs visible again (hidden for ~37m)', 'live.ts:55'],
  ['Clober: quote-update gas scan from 2026-07-01 — blocks 12000→13000', 'gas.ts:306'],
];

/** Everything the chip must count, including the four the old heuristic swallowed. */
const DEGRADED: [string, string][] = [
  ['Clober discovery failed: HTTP 429', 'live.ts:155'],
  ['markout onboarding stopped: HTTP 429; retried automatically', 'live.ts:198'],
  ['Clober re-discovery failed: HTTP 429', 'live.ts:240'],
  ['pruned 5 volume row(s) + 9 fill(s) for removed venue(s)', 'live.ts:269'],
  ['attribution: relabeled 12 retained unevidenced DIRECT fill(s) to UNKNOWN', 'live.ts:275'],
  ['attribution: reclassified 3 FastLane fill(s) ROUTER → MEV', 'live.ts:283'],
  ["dropped backfill volume for foreign venue 'ghost'", 'live.ts:317'],
  ["dropped backfill fill for foreign venue 'ghost'", 'live.ts:328'],
  ['Hanji backfill unavailable (timeout after 30s); history grows forward', 'live.ts:332'],
  ['resuming: gap-filling 1200 block(s) since last run', 'live.ts:365'],
  ['gap exceeds 5000 blocks — resuming at tip (interim fills not decoded)', 'live.ts:368'],
  ['cold start — today builds forward from now', 'live.ts:368'],
  ['persist failed (database is locked); retrying', 'live.ts:393'],
  ["Clober emitted a fill for foreign venue 'ghost' — dropped", 'live.ts:437'],
  ['backfill reset applied (all) — re-scanning: clober, hanji', 'live.ts:479'],
  ['Clober backfill deferred — pools not discovered yet', 'live.ts:502'],
  ['Clober backfill paused (HTTP 429); retried automatically', 'live.ts:504'],
  ["Clober backfill: invalid backfillFromUtc 'yesterday'", 'live.ts:512'],
  ['Clober backfill held while on backup RPC — resumed on primary', 'live.ts:558'],
  ['Clober backfill: RPC archive could not serve blocks near 9000 — skipping unreadable range(s); affected day(s) may undercount', 'live.ts:595'],
  ['Clober backfill: block timestamps unresolved near 9000 — chunk skipped', 'live.ts:631'],
  ['markout retry sweep failed: HTTP 429; retried on the next sweep', 'live.ts:703'],
  ['Clober markout onboarding deferred — no fill sources exposed (pools quarantined?)', 'live.ts:719'],
  ['Clober markout onboarding paused (HTTP 429); retried automatically', 'live.ts:724'],
  ['Hanji onboarding scan held while on backup RPC — resumed on primary', 'live.ts:765'],
  ['Hanji onboarding: RPC could not serve blocks near 9000 — a small range was skipped', 'live.ts:778'],
  ['Hanji onboarding: block timestamps unresolved near 9000 — chunk skipped', 'live.ts:810'],
  ['Clober MON/USDC: markout backfill paused (HTTP 429); resumes next boot', 'live.ts:854'],
  ['Clober MON/USDC: CEX price archive for 2026-07-04 not published yet — markouts resume later', 'live.ts:880'],
  ['tail failed — holding cursor, retrying: HTTP 429', 'live.ts:959'],
  ['bybit feed has no MONUSDT mid — MON pairs are hidden (reference/markouts unavailable)', 'live.ts:42'],
  ["Clober log source 'take' failed — holding cursor, retrying", 'live.ts:1046'],
  ['block timestamp lookup failed — holding cursor, retrying: HTTP 429', 'live.ts:1067'],
  ['Clober decode error — holding cursor, retrying: unknown event', 'live.ts:1082'],
  ["dropped fill for unknown venue 'ghost'", 'live.ts:1111'],
  ["fill market 'FOO/BAR' is not a registered pair — markouts skipped", 'live.ts:1167'],
  // RPC breaker events, routed into state.notes by live.ts:144.
  ['RPC serving again (on primary)', 'failover.ts:113'],
  ['RPC backup-1 dropped at boot: chainId 1 != 143', 'failover.ts:149'],
  ['RPC primary unreachable at boot — starting on backup-1', 'failover.ts:170'],
  ['RPC endpoint unreachable (no backups configured) — chain data frozen until it recovers', 'failover.ts:204'],
  ['RPC: all 3 endpoints unreachable — chain data frozen until one recovers', 'failover.ts:205'],
  ['RPC failover: primary unhealthy — switched to backup-1', 'failover.ts:216'],
  ['RPC recovered: back on primary (was on backup-1 for ~12m)', 'failover.ts:230'],
  ['Clober: gas series removed — venue no longer declares quote-update sources', 'gas.ts:169'],
  ["Hanji: gas destination 0x1234abcd… already tracked by 'clober' — venue skipped until the collision is resolved", 'gas.ts:189'],
  ['Clober: quote-update gas tail paused (RPC 500); retried next pass', 'gas.ts:197'],
  ["Clober: mixed gas-source modes — using 'logs' sources only", 'gas.ts:215'],
  ['Clober: verifying quote-update coverage — rebuilding from 2026-07-01', 'gas.ts:283'],
  ['Clober: deepening quote-update gas history to 2026-06-01 — re-scanning', 'gas.ts:297'],
  ['Clober: quote-update destination added — rebuilding from 2026-07-01 (earlier history unaffected)', 'gas.ts:347'],
  ['Clober: quote-update destination set changed — re-scanning venue lifetime', 'gas.ts:354'],
  ['Clober: gas scan could not read blocks near 9000 — a small range was skipped', 'gas.ts:418'],
  ['Clober: gas scan block timestamps unresolved near 9000 — chunk skipped', 'gas.ts:441'],
  ['Clober: gas scan receipts unavailable near 9000 — chunk skipped', 'gas.ts:473'],
  ['Clober: subgraph discovery failed; trying recent Open logs', 'venues/clober.ts:483'],
  ['Clober: authoritative discovery unavailable; holding Take ranges until rediscovery succeeds', 'venues/clober.ts:493'],
  ['Hanji: FOO/BAR is not a registered pair — skipped', 'venues/hanji.ts:135'],
  ['Lunarbase MON/USDC quarantined: proxy upgrade observed — revalidating', 'venues/lunarbase.ts:416'],
  ['Lunarbase MON/USDC implementation changed 0x1111111111… → 0x2222222222…', 'venues/lunarbase.ts:421'],
  ['Lunarbase quote unavailable: HTTP 429', 'venues/lunarbase.ts:448'],
  ['Lunarbase quote refresh failed: HTTP 429', 'venues/lunarbase.ts:473'],
  ['Lunarbase MON/USDC quote hidden: pool paused', 'venues/lunarbase.ts:489'],
  ['Metric: pool 0x1234abcd… (WBTC/USDC) is not a registered pair — skipped', 'venues/metric.ts:110'],
  ['Metric: push oracle serves 6 feed(s) but Metric uses 4 — burn attribution may overcount', 'venues/metric.ts:156'],
  ['ThogAMM: token 0x7547…b603 is not in @shared TOKENS; its pairs remain unlisted', 'venues/thogamm.ts:229'],
  ['ThogAMM: proxy upgraded to 0x1111…1111 — re-verify quote/fill/gas ABIs against the new implementation', 'venues/thogamm.ts:365'],
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

  it('a completion that reports skipped ranges is a degradation, not a completion', () => {
    // live.ts:653 appends the caveat to the SAME note, so a head-only anchor read the
    // caveat variant as routine and hid the undercounted days under DISCOVERY.
    expect(isRoutineNote('Clober: backfill complete — 30 day(s) seeded')).toBe(true);
    expect(isRoutineNote(
      'Clober: backfill complete — 30 day(s) seeded (4096 block(s) unreadable on the RPC archive and skipped — those windows may undercount)',
    )).toBe(false);
  });

  it('the chip stays hidden on a clean boot and raises on the archive skip', () => {
    // The regression in one assertion: discovery plus progress is a quiet chip, and the
    // note whose only symptom is undercounted days is what the chip exists to show.
    const archiveSkip = DEGRADED.find(([, src]) => src === 'live.ts:595')![0];
    const cleanBoot = ROUTINE.map(([n]) => n);
    expect(cleanBoot.filter((n) => !isRoutineNote(n))).toEqual([]);
    expect([...cleanBoot, archiveSkip].filter((n) => !isRoutineNote(n))).toEqual([archiveSkip]);
  });
});
