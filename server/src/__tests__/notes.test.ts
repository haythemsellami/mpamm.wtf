// state.notes structure + window policy (server/src/notes.ts).
//
// What these lock down: the fields a debugger actually needs (when, how much it
// matters, what raised it) are stamped at the emit site, the sanitizer still
// runs before anything is stored, and the window's cap can no longer let one
// chatty subsystem evict the note that explains an incident.
import { describe, expect, it } from 'vitest';
import { CONDITION_CODES, NOTE_LEVEL, RETRACTS, type NoteCode, type StateNote } from '@shared';
import { NoteBuffer, noteSubsystem, scrubNote } from '../notes.js';
import { BACKSTOP_KEY, QUOTE_DARK_CYCLES, checkArchivePending, checkGapFill, checkQuoteOutage, checkReferenceStarvation } from '../datasource/live.js';

const T0 = 1_800_000_000_000;

/** a buffer with a fixed clock + the notes it printed as they were raised. */
const buf = (max = 60) => {
  const printed: StateNote[] = [];
  let t = T0;
  return { b: new NoteBuffer(max, (n) => printed.push(n), () => (t += 1_000)), printed };
};
const codesOf = (b: NoteBuffer) => b.list().map((n) => n.code);

describe('note shape', () => {
  it('stamps ts + level + code and keeps the venue the note is about', () => {
    const { b } = buf();
    b.note('rpc.failover', 'RPC failover: primary unhealthy — switched to backup-1');
    b.noteOnce('backfill.range.skipped', 'Metric backfill: RPC archive could not serve blocks near 73050000', 'metric');
    const [failover, skipped] = b.list();
    expect(failover).toMatchObject({ code: 'rpc.failover', level: 'warn' });
    expect(failover.ts).toBe(T0 + 1_000);
    expect(failover.venue).toBeUndefined();       // not about one venue
    expect(skipped).toMatchObject({ code: 'backfill.range.skipped', level: 'warn', venue: 'metric' });
    expect(skipped.ts).toBeGreaterThan(failover.ts);
  });

  it('takes the level from the code, so one event cannot be warn here and info there', () => {
    const { b } = buf();
    // the archive notice is expected and self-healing (it was 5 of the 6 amber
    // counts on a healthy prod box); a dark reference feed hides pairs.
    b.note('markout.archive.pending', 'Hanji MON/USDC: CEX price archive for 2026-07-31 not published yet');
    b.note('reference.starved', 'bybit feed has no MONUSDT mid — MON pairs are hidden');
    expect(b.list().map((n) => n.level)).toEqual(['info', 'warn']);
    expect(NOTE_LEVEL['markout.archive.pending']).toBe('info');
  });

  it('every code is dotted, so the window can group it by subsystem', () => {
    for (const code of Object.keys(NOTE_LEVEL)) {
      expect(code).toMatch(/^[a-z]+(\.[a-z]+)+$/);
      expect(noteSubsystem(code)).not.toBe(code);
    }
  });

  it('strips URLs before storing OR printing — provider errors embed the RPC key', () => {
    const { b, printed } = buf();
    b.note('tail.failed', 'tail failed — holding cursor: HTTP request failed. URL: https://node.example/rpc/deadbeefkey');
    expect(b.list()[0].msg).not.toMatch(/https?:\/\//);
    expect(b.list()[0].msg).toContain('<rpc>');
    expect(printed[0].msg).not.toMatch(/https?:\/\//);
    expect(scrubNote('x'.repeat(400))).toHaveLength(298); // 297 + the ellipsis
  });

  it('noteOnce dedupes on (code, venue, msg) and drop retracts exactly that note', () => {
    const { b } = buf();
    b.noteOnce('venue.quote.unavailable', 'quote refresh failed', 'lunarbase');
    b.noteOnce('venue.quote.unavailable', 'quote refresh failed', 'lunarbase');
    b.noteOnce('venue.quote.unavailable', 'quote refresh failed', 'hanji'); // other venue, same words
    expect(b.list()).toHaveLength(2);
    b.drop('venue.quote.unavailable', 'quote refresh failed', 'lunarbase');
    expect(b.list().map((n) => n.venue)).toEqual(['hanji']);
  });
});

describe('window cap', () => {
  it('lets a chatty subsystem evict its own notes, never the warning that explains the incident', () => {
    const { b } = buf(10);
    b.note('rpc.failover', 'RPC failover: primary unhealthy — switched to backup-1');
    b.note('reference.starved', 'bybit feed has no MONUSDT mid — MON pairs are hidden');
    // a backfill crossing an archive hole notes once per cursor: 40 notes, one window.
    for (let i = 0; i < 40; i++) b.noteOnce('backfill.range.skipped', `Metric backfill: unreadable range near ${i}`, 'metric');
    expect(b.list()).toHaveLength(10);
    // the flat shift() cap dropped these two first — they were the oldest.
    expect(codesOf(b)).toContain('rpc.failover');
    expect(codesOf(b)).toContain('reference.starved');
  });

  it('evicts an info note before a warning inside the noisy subsystem', () => {
    const { b } = buf(4);
    b.note('backfill.start', 'Metric: on-chain backfill 2026-05-13 — blocks 1→2', 'metric');
    b.note('backfill.paused', 'Metric backfill paused (rpc down); retried automatically', 'metric');
    b.note('backfill.range.skipped', 'near 1', 'metric');
    b.note('backfill.range.skipped', 'near 2', 'metric');
    b.note('backfill.range.skipped', 'near 3', 'metric');
    expect(codesOf(b)).toEqual(['backfill.paused', 'backfill.range.skipped', 'backfill.range.skipped', 'backfill.range.skipped']);
  });

  it('prints every note as it is raised, so an evicted note still exists in the logs', () => {
    const { b, printed } = buf(2);
    for (const m of ['a', 'b', 'c']) b.note('backfill.range.skipped', m, 'metric');
    expect(b.list()).toHaveLength(2);
    expect(printed.map((n) => n.msg)).toEqual(['a', 'b', 'c']);
  });
});

describe('a real call site: reference-feed starvation', () => {
  const MON = { key: 'MON', symbol: 'MON', cex: 'bybit', cexSymbol: 'MONUSDT' };

  const wired = (b: NoteBuffer) => ({
    warn: (k: string, m: string) => b.noteOnce('reference.starved', m, undefined, k),
    clear: (k: string, m: string) => b.drop('reference.starved', m),
    announce: (k: string, m: string) => b.note('reference.recovered', m, undefined, k),
  });

  it('warns once with reference.starved, then retracts it and announces recovery', () => {
    const { b } = buf();
    const io = wired(b);
    const starved = new Map<string, number>();
    checkReferenceStarvation([MON], () => 0, starved, T0, io);
    checkReferenceStarvation([MON], () => 0, starved, T0 + 1_000, io);
    expect(codesOf(b)).toEqual(['reference.starved']);
    expect(b.list()[0].level).toBe('warn');

    checkReferenceStarvation([MON], () => 0.021, starved, T0 + 7 * 60_000, io);
    // the stale scare-warning is gone, the recovery is on the record (6c3cf5b)
    expect(codesOf(b)).toEqual(['reference.recovered']);
    expect(b.list()[0].msg).toContain('hidden for ~7m');
  });

  it('one feed recovering leaves another feed\'s still-true starvation standing', () => {
    // the same trap as Lunarbase, one layer up: every asset's warning shares
    // code='reference.starved' and no venue, so without the asset key the
    // recovery's retraction would erase them all. Two dark feeds, one heals.
    const ETH = { key: 'ETH', symbol: 'ETH', cex: 'bybit', cexSymbol: 'ETHUSDT' };
    const { b } = buf();
    const io = wired(b);
    const starved = new Map<string, number>();
    checkReferenceStarvation([MON, ETH], () => 0, starved, T0, io);
    expect(b.list().filter((n) => n.code === 'reference.starved')).toHaveLength(2);

    checkReferenceStarvation([MON, ETH], (k) => (k === 'ETH' ? 1 : 0), starved, T0 + 60_000, io);
    const still = b.list().filter((n) => n.code === 'reference.starved');
    expect(still).toHaveLength(1);
    expect(still[0].msg).toContain('MONUSDT'); // MON's warning survived ETH's recovery
    expect(codesOf(b)).toContain('reference.recovered');
  });
});

describe('a real call site: archive-pending markout re-scan', () => {
  const HANJI = { vid: 'hanji', name: 'Hanji', market: 'MON/USDC', day: '2026-07-31' };

  it('warns once with markout.archive.pending, then retracts it and announces on publish', () => {
    const { b } = buf();
    // wired exactly as remarkVenueMarket does. The retract is a real
    // NoteBuffer.drop keyed on (code, venue, scrubbed msg), so it has to hit the
    // same note noteOnce stored. The fake-sink test matches raw strings, so it
    // cannot prove the scrub runs on both sides or that the code and venue line
    // up. Driving the real buffer here does.
    const io = {
      warn: (k: string, m: string) => b.noteOnce('markout.archive.pending', m, 'hanji', k),
      clear: (k: string, m: string) => b.drop('markout.archive.pending', m, 'hanji'),
      announce: (k: string, m: string) => b.note('markout.archive.published', m, 'hanji', k),
    };
    const pending = new Set<string>();
    checkArchivePending(HANJI, false, pending, io);
    checkArchivePending(HANJI, false, pending, io); // repeated sweep, still deferred
    expect(codesOf(b)).toEqual(['markout.archive.pending']);
    expect(b.list()[0]).toMatchObject({ level: 'info', venue: 'hanji' });

    checkArchivePending(HANJI, true, pending, io); // the archive lands this sweep
    // the sticky "resume later" note is gone through the real buffer, only the
    // publish is on the record. A future scrubNote change would trip this.
    expect(codesOf(b)).toEqual(['markout.archive.published']);
    expect(b.list()[0].msg).toContain('markouts resumed');
  });

  it('one archive publishing leaves the other market\'s pending note standing', () => {
    // one venue routinely defers SEVERAL (market, day) pairs at once, all
    // stamped venue='hanji' with no finer field, so without the per-deferral
    // key the publish announcement's retraction would erase every one of them.
    const OTHER = { vid: 'hanji', name: 'Hanji', market: 'WMON/USDT', day: '2026-07-31' };
    const { b } = buf();
    const io = {
      warn: (k: string, m: string) => b.noteOnce('markout.archive.pending', m, 'hanji', k),
      clear: (k: string, m: string) => b.drop('markout.archive.pending', m, 'hanji'),
      announce: (k: string, m: string) => b.note('markout.archive.published', m, 'hanji', k),
    };
    const pending = new Set<string>();
    checkArchivePending(HANJI, false, pending, io);
    checkArchivePending(OTHER, false, pending, io);
    expect(b.list().filter((n) => n.code === 'markout.archive.pending')).toHaveLength(2);

    checkArchivePending(HANJI, true, pending, io); // MON/USDC lands, WMON/USDT still missing
    const still = b.list().filter((n) => n.code === 'markout.archive.pending');
    expect(still).toHaveLength(1);
    expect(still[0].msg).toContain('WMON/USDT');
    expect(codesOf(b)).toContain('markout.archive.published');
  });
});

describe('a real call site: gap-fill tail catch-up', () => {
  const RESUME = 'resuming: gap-filling 128 block(s) since last run';

  it('retracts the boot tail.resume note and announces once the cursor reaches the boot head', () => {
    const { b } = buf();
    b.note('tail.resume', RESUME); // the boot resume note, raised the way live.ts does
    const state: { msg?: string } = { msg: RESUME };
    const io = {
      clear: (m: string) => b.drop('tail.resume', m),
      announce: (m: string) => b.note('tail.caughtup', m),
    };
    checkGapFill(900n, 1000n, state, io); // still short of the boot head, nothing changes
    expect(codesOf(b)).toEqual(['tail.resume']);

    checkGapFill(1000n, 1000n, state, io); // cursor reaches bootHead
    // the sticky boot note is gone through the real buffer. Only the catch-up
    // stays on the record. state.msg is cleared so it never re-fires.
    expect(codesOf(b)).toEqual(['tail.caughtup']);
    expect(state.msg).toBeUndefined();
    expect(b.list()[0].msg).toContain('decoded through block 1000');
  });
});

describe('conditions vs events: a recovery retracts the condition it cleared', () => {
  const msgsOf = (b: NoteBuffer) => b.list().map((n) => n.msg);

  it('drops the condition when its recovery is raised, keeping the recovery', () => {
    const { b } = buf();
    b.note('reference.starved', 'bybit feed has no MONUSDT mid — MON pairs are hidden');
    b.note('reference.recovered', 'bybit feed recovered: MONUSDT mid is back');
    expect(codesOf(b)).toEqual(['reference.recovered']);
  });

  it('leaves an EVENT standing: rpc.failover survives rpc.recovered', () => {
    // an incident record, not a stale claim about now — the window keeps both.
    const { b } = buf();
    b.note('rpc.failover', 'RPC failover: primary unhealthy — switched to backup-1');
    b.note('rpc.recovered', 'RPC primary healthy again — back on primary');
    expect(codesOf(b)).toEqual(['rpc.failover', 'rpc.recovered']);
    expect(RETRACTS['rpc.recovered']).toBeUndefined();
  });

  it('THE LUNARBASE TRAP: one venue, two live conditions, one heals — the other survives', () => {
    // All four of Lunarbase's conditions are stamped venue:'lunarbase' (a note
    // has no field finer than the venue), so a (code, venue) retraction would
    // let "chain head readable again" erase a still-true "pool paused".
    const { b } = buf();
    b.noteOnce('venue.quote.unavailable', 'Lunarbase chain head unreadable', 'lunarbase', 'head');
    b.noteOnce('venue.quote.unavailable', 'Lunarbase MON/USDC quote hidden: pool paused', 'lunarbase', 'inactive:0xpool');
    b.note('venue.quote.recovered', 'Lunarbase chain head readable again — quoting resumed', 'lunarbase', 'head');
    expect(msgsOf(b)).toEqual([
      'Lunarbase MON/USDC quote hidden: pool paused',
      'Lunarbase chain head readable again — quoting resumed',
    ]);
    b.note('venue.quote.recovered', 'Lunarbase MON/USDC quoting again', 'lunarbase', 'inactive:0xpool');
    expect(b.holds('venue.quote.unavailable', 'lunarbase')).toBe(false);
  });

  it('scopes retraction to the venue: one venue healing does not clear another', () => {
    const { b } = buf();
    b.noteOnce('venue.quote.unavailable', 'Metric quotes unavailable — maker paused', 'metric');
    b.noteOnce('venue.quote.unavailable', 'Clober quotes unavailable — book empty', 'clober');
    b.note('venue.quote.recovered', 'Metric is quoting again', 'metric');
    expect(msgsOf(b)).toEqual(['Clober quotes unavailable — book empty', 'Metric is quoting again']);
  });

  it('does not let a keyed recovery clear an unkeyed condition of the same venue', () => {
    // the backstop's own warning is keyed, so an adapter announcing recovery
    // for one of its pools cannot silence the venue-wide "not quoting" note.
    const { b } = buf();
    b.noteOnce('venue.quote.unavailable', 'Metric is not quoting — no rows for 34 cycles', 'metric', BACKSTOP_KEY);
    b.note('venue.quote.recovered', 'Metric MON/USDC quoting again', 'metric', 'inactive:0xpool');
    expect(b.holds('venue.quote.unavailable', 'metric')).toBe(true);
  });

  it('retracts on a SECOND heal, whose announcement noteOnce swallows as a repeat', () => {
    // recovery wording is fixed, so the second time a condition heals the
    // announcement is a verbatim repeat and is deduped away. If the retraction
    // rode on the announcement being stored, the healed condition would stand.
    const { b } = buf();
    const DOWN = 'Lunarbase chain head unreadable';
    const UP = 'Lunarbase chain head readable again — quoting resumed';
    b.noteOnce('venue.quote.unavailable', DOWN, 'lunarbase', 'head');
    b.noteOnce('venue.quote.recovered', UP, 'lunarbase', 'head');
    b.noteOnce('venue.quote.unavailable', DOWN, 'lunarbase', 'head'); // it breaks again
    b.noteOnce('venue.quote.recovered', UP, 'lunarbase', 'head');     // …and heals again
    expect(codesOf(b)).toEqual(['venue.quote.recovered']);
  });

  it('keeps the condition key out of the served note', () => {
    const { b, printed } = buf();
    b.noteOnce('venue.quote.unavailable', 'Lunarbase chain head unreadable', 'lunarbase', 'head');
    expect(Object.keys(b.list()[0]).sort()).toEqual(['code', 'level', 'msg', 'ts', 'venue']);
    expect(printed[0]).not.toHaveProperty('key');
  });

  it('tells two conditions apart by key even when the wording matches', () => {
    const { b } = buf();
    b.noteOnce('venue.quote.unavailable', 'Lunarbase pool state unreadable', 'lunarbase', 'unread:0xa');
    b.noteOnce('venue.quote.unavailable', 'Lunarbase pool state unreadable', 'lunarbase', 'unread:0xb');
    expect(b.list()).toHaveLength(2); // noteOnce dedupes per condition, not per sentence
    b.note('venue.quote.recovered', 'Lunarbase pool readable again', 'lunarbase', 'unread:0xa');
    expect(b.list().filter((n) => n.code === 'venue.quote.unavailable')).toHaveLength(1);
  });

  it('pairs only real codes, and every condition is a warning its recovery is not', () => {
    for (const [recovery, condition] of Object.entries(RETRACTS) as [NoteCode, NoteCode][]) {
      expect(NOTE_LEVEL[recovery]).toBeDefined();
      expect(NOTE_LEVEL[condition]).toBeDefined();
      expect(noteSubsystem(recovery)).toBe(noteSubsystem(condition));
      expect(CONDITION_CODES.has(condition)).toBe(true);
      expect(CONDITION_CODES.has(recovery)).toBe(false); // a recovery is an event
    }
  });
});

describe('a real call site: the went-dark backstop', () => {
  const VENUES = [{ id: 'metric', name: 'Metric' }];

  /** the PRODUCTION wiring, which the fake-sink tests in quote-outage.test.ts
   *  cannot model: `explained` reads the SAME buffer `warn` writes to, on the
   *  one clock poll() stamps for both the check and the adapters' own notes. */
  const wired = () => {
    let now = T0;
    const b = new NoteBuffer(60, () => {}, () => now);
    const empty = new Map<string, { runs: number; since: number }>();
    const dark = new Map<string, string>();
    const io = {
      warn: (id: string, m: string) => b.noteOnce('venue.quote.unavailable', m, id, BACKSTOP_KEY),
      announce: (id: string, m: string) => b.note('venue.quote.recovered', m, id, BACKSTOP_KEY),
      clear: (id: string, m: string) => b.drop('venue.quote.unavailable', m, id),
      explained: (id: string, since: number) => b.holds('venue.quote.unavailable', id, since),
    };
    return {
      b,
      dark,
      /** an adapter speaking from inside this tick's quote(). */
      adapterSaid: (m: string) => b.noteOnce('venue.quote.unavailable', m, 'metric'),
      cycle: (rows: number, n: number) => {
        for (let i = 0; i < n; i++) checkQuoteOutage(VENUES, () => rows, empty, dark, (now += 1_000), io);
      },
      warns: () => b.list().filter((n) => n.code === 'venue.quote.unavailable').length,
    };
  };

  it('reports a SECOND outage — the first warning is retracted, so noteOnce cannot swallow it', () => {
    const w = wired();
    w.cycle(0, QUOTE_DARK_CYCLES);
    expect(w.warns()).toBe(1);
    w.cycle(4, 1);
    // retracted, not merely announced over: the wording is identical next time.
    expect(codesOf(w.b)).toEqual(['venue.quote.recovered']);
    w.cycle(0, QUOTE_DARK_CYCLES);
    expect(w.warns()).toBe(1);
  });

  it('stands down for a note raised DURING this outage — the feature still works', () => {
    const w = wired();
    w.cycle(4, 1);                       // seen quoting: since = now
    w.adapterSaid('Metric quotes unavailable — maker paused');
    w.cycle(0, QUOTE_DARK_CYCLES + 20);
    expect(w.warns()).toBe(1);           // the adapter's, not a second generic one
    expect(w.dark.has('metric')).toBe(false);
  });

  it('is NOT stood down by a note from an outage that already ended', () => {
    const w = wired();
    w.adapterSaid('Metric quotes unavailable — maker paused'); // an EARLIER outage
    w.cycle(4, 1);                                             // …which then recovered
    w.cycle(0, QUOTE_DARK_CYCLES);
    expect(w.warns()).toBe(2);           // the stale one, plus the backstop's own
    expect(w.dark.get('metric')).toContain('is not quoting');
  });

  it('still stands down on a long outage, where a recency window would go blind', () => {
    const w = wired();
    w.cycle(4, 1);
    w.adapterSaid('Metric quotes unavailable — maker paused');
    w.cycle(0, 3_000);                   // ~50 minutes at one cycle/second
    expect(w.warns()).toBe(1);
  });

  it('takes any note for a venue never yet seen quoting — the boot/warmup case', () => {
    const w = wired();
    w.adapterSaid('Metric quotes unavailable — maker paused'); // dark since boot
    w.cycle(0, QUOTE_DARK_CYCLES + 5);
    expect(w.warns()).toBe(1);
  });

  it('retracts the string it RAISED, which is not always the threshold run', () => {
    // the warn can fire LATE: while an adapter note covers the venue the check
    // stands down but keeps counting, so the run embedded in the message is
    // whatever it had reached when that note left the window — not
    // QUOTE_DARK_CYCLES, and so not rebuildable from stable fields.
    const w = wired();
    const ADAPTER = 'Metric quotes unavailable — maker paused';
    w.cycle(4, 1);
    w.adapterSaid(ADAPTER);
    w.cycle(0, QUOTE_DARK_CYCLES + 5);
    expect(w.dark.has('metric')).toBe(false);      // stood down, still counting
    w.b.drop('venue.quote.unavailable', ADAPTER, 'metric'); // the note ages out
    w.cycle(0, 1);
    expect(w.dark.get('metric')).toContain(`${QUOTE_DARK_CYCLES + 6} consecutive cycles`);
    w.cycle(4, 1);
    expect(w.b.holds('venue.quote.unavailable', 'metric')).toBe(false);
  });

  it('retracts only the string it raised, leaving an adapter note standing', () => {
    const w = wired();
    const ADAPTER = 'Metric quotes unavailable — maker paused';
    w.adapterSaid(ADAPTER);
    w.cycle(4, 1);
    w.cycle(0, QUOTE_DARK_CYCLES);       // backstop warns despite the stale note
    w.cycle(4, 1);                       // …and recovers
    expect(w.b.holds('venue.quote.unavailable', 'metric')).toBe(true); // the adapter's survives
    expect(w.b.list().map((n) => n.msg)).toContain(ADAPTER);
    expect(w.b.list().some((n) => n.msg.includes('is not quoting'))).toBe(false);
  });
});
