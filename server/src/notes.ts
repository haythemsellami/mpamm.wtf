import { NOTE_LEVEL, type NoteCode, type StateNote } from '@shared';

/**
 * state.notes — the service's own telemetry, for maintainers, contributors and
 * tooling debugging the indexer (served on /api/markets, printed to stdout).
 * It is NOT a viewer-facing channel: none of it is actionable for someone
 * comparing execution quality, so nothing here reaches the dashboard UI.
 *
 * A note used to be a bare string, which threw away at the emit site the three
 * things a debugger asks first: WHEN it happened, whether it MATTERS, and WHAT
 * raised it. Every consumer then had to rebuild that by matching prose. A note
 * now carries `ts`, `level` and a dotted `code` (@shared: NoteCode), so it can
 * be filtered, grouped or alerted on directly, and an LLM reading /api/markets
 * gets the classification instead of guessing it.
 */

/** A note sink, handed to subsystems that raise notes (GasTracker, adapters).
 *  `venue` scopes the note to one venue id when it is about one. */
export type NoteFn = (code: NoteCode, msg: string, venue?: string) => void;

/** Served window size. Notes live for the process lifetime and ride every
 *  state broadcast, so the buffer keeps a recent window, never a full log. */
export const NOTES_MAX = 60;

/** the part of a code before the first dot: the subsystem that raised it. */
export function noteSubsystem(code: string): string {
  const i = code.indexOf('.');
  return i < 0 ? code : code.slice(0, i);
}

/**
 * SANITIZE anything that reaches state.notes — notes are served on
 * /api/markets, and provider error messages embed the FULL request URL,
 * including a private RPC key (viem prints "URL: https://host/rpc/<key>").
 * Strip every URL, collapse whitespace, and cap the length.
 */
export function scrubNote(msg: string): string {
  const s = msg.replace(/(?:https?|wss?):\/\/\S+/gi, '<rpc>').replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 297) + '…' : s;
}

/** Default sink: one line per note on stdout/stderr, so the full history
 *  survives in the platform's logs even after the served window drops it. */
export function printNote(n: StateNote): void {
  const line = `[mpamm] ${n.level} ${n.code}${n.venue ? ` (${n.venue})` : ''}: ${n.msg}`;
  if (n.level === 'warn') console.warn(line); else console.log(line);
}

/**
 * The served notes window. Owns sanitizing, stamping, dedupe, retraction and
 * the cap; every note in the process goes through one of these.
 */
export class NoteBuffer {
  private items: StateNote[] = [];

  constructor(
    private readonly max: number = NOTES_MAX,
    /** where a note goes the moment it is raised (tests inject a collector). */
    private readonly sink: (n: StateNote) => void = printNote,
    private readonly now: () => number = Date.now,
  ) {}

  /** the window as served, oldest first. */
  list(): StateNote[] { return this.items; }

  /** whether the window already holds this code for this venue. Lets a generic
   *  backstop stand down when a subsystem has already explained the same event
   *  in more detail (datasource/live.ts: checkQuoteOutage vs an adapter's own
   *  venue.quote.unavailable). */
  holds(code: NoteCode, venue?: string): boolean {
    const v = venue || undefined;
    return this.items.some((n) => n.code === code && n.venue === v);
  }

  /** raise a note. */
  note(code: NoteCode, msg: string, venue?: string): void {
    this.push(code, scrubNote(msg), venue);
  }

  /** raise a note at most once: per-tick drop reasons must not spam the window. */
  noteOnce(code: NoteCode, msg: string, venue?: string): void {
    const s = scrubNote(msg);
    if (this.items.some((n) => n.code === code && n.msg === s && n.venue === (venue || undefined))) return;
    this.push(code, s, venue);
  }

  /** retract a note that no longer describes reality (a recovered
   *  degradation). Matched on code + venue + the SCRUBBED message, so the
   *  retraction hits exactly the note that was raised. */
  drop(code: NoteCode, msg: string, venue?: string): void {
    const s = scrubNote(msg);
    const v = venue || undefined;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const n = this.items[i];
      if (n.code === code && n.msg === s && n.venue === v) this.items.splice(i, 1);
    }
  }

  private push(code: NoteCode, msg: string, venue?: string): void {
    const n: StateNote = { ts: this.now(), level: NOTE_LEVEL[code], code, ...(venue ? { venue } : {}), msg };
    this.items.push(n);
    this.sink(n);
    while (this.items.length > this.max) this.items.splice(this.evictIndex(), 1);
  }

  /**
   * Which note the window can best afford to lose.
   *
   * The cap used to be a flat `shift()`, so the OLDEST note went regardless of
   * who filled the window: a backfill skipping ranges chunk by chunk, or a gas
   * scan reporting per-cursor, would quietly evict the RPC failover note that
   * explained the whole incident. Overflow is charged to the noisiest
   * subsystem instead, and inside it an info note goes before a warning. Ties
   * go to the subsystem holding the oldest note (insertion order). Nothing
   * disappears silently either way: every note is printed when it is raised.
   */
  private evictIndex(): number {
    const counts = new Map<string, number>();
    for (const n of this.items) {
      const sub = noteSubsystem(n.code);
      counts.set(sub, (counts.get(sub) ?? 0) + 1);
    }
    let loudest = '';
    let most = 0;
    for (const [sub, c] of counts) if (c > most) { most = c; loudest = sub; }
    const mine = (n: StateNote) => noteSubsystem(n.code) === loudest;
    const info = this.items.findIndex((n) => mine(n) && n.level === 'info');
    return info >= 0 ? info : this.items.findIndex(mine);
  }
}
