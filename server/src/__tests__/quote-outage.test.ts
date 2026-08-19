// The CORE's went-dark backstop (datasource/live.ts: checkQuoteOutage).
//
// A venue that stops quoting leaves the Execution grid with no signal, and the
// adapter-side reporter only covers adapters whose author thought about it.
// This layer covers every venue, including ones not written yet — so what it
// must get right is: no false alarm on the normal empty cycles, no silence on
// a real outage, and no duplicate of a note an adapter already raised.
import { describe, expect, it } from 'vitest';
import { QUOTE_DARK_CYCLES, checkQuoteOutage, trackQuoteFailure } from '../datasource/live.js';

const VENUES = [{ id: 'metric', name: 'Metric' }, { id: 'hanji', name: 'Hanji' }];

/** a fresh driver state: the fake-sink shape, where `explained` is a set the
 *  test controls rather than the buffer `warn` writes to. Scoping and retraction
 *  need the REAL buffer, so those live in notes.test.ts beside their siblings. */
const fresh = () => ({
  runs: new Map<string, { runs: number; since: number }>(), dark: new Map<string, string>(),
  notes: [] as { kind: 'warn' | 'announce'; id: string; msg: string }[],
  cleared: [] as { id: string; msg: string }[],
  explained: new Set<string>(), now: 1_000,
});

/** drive N cycles where `rows(id)` decides each venue's row count. */
function run(rows: (id: string) => number, cycles: number, state = fresh()) {
  const io = {
    warn: (id: string, msg: string) => state.notes.push({ kind: 'warn' as const, id, msg }),
    announce: (id: string, msg: string) => state.notes.push({ kind: 'announce' as const, id, msg }),
    clear: (id: string, msg: string) => state.cleared.push({ id, msg }),
    explained: (id: string) => state.explained.has(id),
  };
  // one tick per cycle: `since` is only meaningful against a moving clock.
  for (let i = 0; i < cycles; i++) checkQuoteOutage(VENUES, rows, state.runs, state.dark, state.now++, io);
  return state;
}

describe('checkQuoteOutage', () => {
  it('stays silent through a short gap — one blip inside a venue multicall is not an outage', () => {
    const s = run(() => 0, QUOTE_DARK_CYCLES - 1);
    expect(s.notes).toEqual([]);
  });

  it('warns once when a venue has been empty for the full run, and names both causes', () => {
    const s = run((id) => (id === 'metric' ? 0 : 4), QUOTE_DARK_CYCLES + 50);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toMatchObject({ kind: 'warn', id: 'metric' });
    expect(s.notes[0].msg).toMatch(/venue offline.*no longer matches the contract/);
  });

  it('a partial run resets — emptiness must be CONTINUOUS to count', () => {
    const s = fresh();
    run(() => 0, QUOTE_DARK_CYCLES - 1, s);   // nearly dark…
    run(() => 1, 1, s);                        // …one good cycle
    run(() => 0, QUOTE_DARK_CYCLES - 1, s);   // …and nearly dark again
    expect(s.notes).toEqual([]);
  });

  it('announces recovery, so the warning does not stand after the venue is back', () => {
    const s = fresh();
    run(() => 0, QUOTE_DARK_CYCLES, s);
    expect(s.notes.map((n) => n.kind)).toEqual(['warn', 'warn']); // both venues dark
    run(() => 3, 5, s);
    expect(s.notes.filter((n) => n.kind === 'announce').map((n) => n.id).sort()).toEqual(['hanji', 'metric']);
    // and a second outage is reported again, not swallowed by the first.
    run(() => 0, QUOTE_DARK_CYCLES, s);
    expect(s.notes.filter((n) => n.kind === 'warn' && n.id === 'metric')).toHaveLength(2);
  });

  it('stands down when the adapter already explained WHY — one event, one note', () => {
    const s = fresh(); s.explained.add('metric');
    run(() => 0, QUOTE_DARK_CYCLES + 20, s);
    expect(s.notes.map((n) => n.id)).toEqual(['hanji']); // metric's own note already says "maker: paused"
  });

  it('stands down BOTH ways for an adapter-explained venue — no second, vaguer recovery', () => {
    // the adapter that raised the detailed outage also announces the detailed
    // recovery; a generic core announcement on top would double-report one event.
    const s = fresh(); s.explained.add('metric');
    run(() => 0, QUOTE_DARK_CYCLES + 10, s);
    run(() => 2, 3, s);
    expect(s.notes.filter((n) => n.id === 'metric')).toEqual([]);
    // hanji has no adapter note, so the core owns BOTH ends of its story.
    expect(s.notes.filter((n) => n.id === 'hanji').map((n) => n.kind)).toEqual(['warn', 'announce']);
  });

  it('takes over if the adapter note is gone by the time the run completes', () => {
    // `explained` reads the served window, which can roll a note off. The venue
    // is still dark, so the backstop must speak rather than assume it is covered.
    const s = fresh(); s.explained.add('metric');
    run(() => 0, QUOTE_DARK_CYCLES - 1, s);
    s.explained.delete('metric'); // the adapter's note aged out of the window
    run(() => 0, 1, s);
    expect(s.notes.filter((n) => n.id === 'metric').map((n) => n.kind)).toEqual(['warn']);
  });
});

// The core's OTHER quote signal: a.quote() rejecting outright, which
// checkQuoteOutage never sees — a throwing adapter returns no rows, but so does
// a venue that is simply quiet, and only this path knows which happened.
describe('trackQuoteFailure', () => {
  const METRIC = { id: 'metric', name: 'Metric' };
  const fresh = () => ({
    current: new Map<string, string>(),
    notes: [] as { kind: 'warn' | 'announce'; id: string | undefined; msg: string }[],
  });
  const io = (s: ReturnType<typeof fresh>) => ({
    warn: (id: string | undefined, msg: string) => s.notes.push({ kind: 'warn' as const, id, msg }),
    announce: (id: string | undefined, msg: string) => s.notes.push({ kind: 'announce' as const, id, msg }),
  });

  it('notes a rejection once, however many cycles it lasts', () => {
    const s = fresh();
    for (let i = 0; i < 50; i++) trackQuoteFailure(METRIC, 'maker: paused', s.current, io(s));
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toMatchObject({ kind: 'warn', id: 'metric' });
    expect(s.notes[0].msg).toBe('Metric quote failed: maker: paused');
  });

  it('a CHANGED reason is a different event and gets its own note', () => {
    const s = fresh();
    trackQuoteFailure(METRIC, 'maker: paused', s.current, io(s));
    trackQuoteFailure(METRIC, 'execution reverted', s.current, io(s));
    expect(s.notes.map((n) => n.msg)).toEqual([
      'Metric quote failed: maker: paused',
      'Metric quote failed: execution reverted',
    ]);
  });

  it('announces recovery once, naming the reason that just cleared', () => {
    const s = fresh();
    trackQuoteFailure(METRIC, 'maker: paused', s.current, io(s));
    trackQuoteFailure(METRIC, null, s.current, io(s));
    expect(s.notes[1]).toMatchObject({ kind: 'announce', id: 'metric' });
    expect(s.notes[1].msg).toBe('Metric quoting again (was "maker: paused")');
  });

  it('stays silent while the venue is healthy — most cycles are', () => {
    const s = fresh();
    for (let i = 0; i < 10; i++) trackQuoteFailure(METRIC, null, s.current, io(s));
    expect(s.notes).toEqual([]);
  });

  it('re-reports the SAME reason after a recovery — a second outage is a second event', () => {
    const s = fresh();
    trackQuoteFailure(METRIC, 'maker: paused', s.current, io(s));
    trackQuoteFailure(METRIC, null, s.current, io(s));
    trackQuoteFailure(METRIC, 'maker: paused', s.current, io(s));
    expect(s.notes.filter((n) => n.kind === 'warn')).toHaveLength(2);
  });

  it('resolving with ZERO rows still clears — empty-but-quoting is the backstop\'s job', () => {
    // the caller passes null the moment the promise resolves, whatever it holds.
    const s = fresh();
    trackQuoteFailure(METRIC, 'rpc timeout', s.current, io(s));
    trackQuoteFailure(METRIC, null, s.current, io(s));
    expect(s.notes.map((n) => n.kind)).toEqual(['warn', 'announce']);
  });

  it('keys venues apart, including an adapter that declares no venue id', () => {
    const s = fresh();
    trackQuoteFailure(METRIC, 'maker: paused', s.current, io(s));
    trackQuoteFailure({ id: 'hanji', name: 'Hanji' }, 'maker: paused', s.current, io(s));
    trackQuoteFailure({ name: 'venue' }, 'maker: paused', s.current, io(s));
    expect(s.notes).toHaveLength(3);
    expect(s.notes.map((n) => n.id)).toEqual(['metric', 'hanji', undefined]);
    // …and one venue healing does not clear another's warning.
    trackQuoteFailure(METRIC, null, s.current, io(s));
    expect(s.current.get('hanji')).toBe('maker: paused');
  });
});
