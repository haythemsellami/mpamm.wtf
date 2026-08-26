import { NOTE_LEVEL, RETRACTS, type NoteCode, type StateNote } from '@shared';

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
 *  `venue` scopes the note to one venue id when it is about one; `key` names
 *  WHICH condition of that venue it is about, when the venue can hold several
 *  at once (@shared: RETRACTS — a recovery retracts by `code + venue + key`). */
export type NoteFn = (code: NoteCode, msg: string, venue?: string, key?: string) => void;

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
 * A note as the window HOLDS it: the served note, plus the condition key that
 * scopes retraction. The key stays here rather than on `StateNote` because
 * `StateNote` is the shape served on /api/markets — the key is core
 * bookkeeping, and one venue's internal dedupe names are not part of the
 * public contract.
 */
interface HeldNote {
  note: StateNote;
  /** which condition of this (code, venue) the note is about, when the venue
   *  can hold several at once (Lunarbase: `head`, `snapshot`, `unread:<pool>`,
   *  `inactive:<pool>`). Absent for the codes that only ever have one. */
  key?: string;
}

/**
 * The served notes window. Owns sanitizing, stamping, dedupe, retraction and
 * the cap; every note in the process goes through one of these.
 */
export class NoteBuffer {
  private items: HeldNote[] = [];

  constructor(
    private readonly max: number = NOTES_MAX,
    /** where a note goes the moment it is raised (tests inject a collector). */
    private readonly sink: (n: StateNote) => void = printNote,
    private readonly now: () => number = Date.now,
  ) {}

  /** the window as served, oldest first (condition keys stay internal). */
  list(): StateNote[] { return this.items.map((h) => h.note); }

  /** whether the window holds this code for this venue, raised no earlier than
   *  `since`. Lets a generic backstop stand down when a subsystem has already
   *  explained the same event in more detail (datasource/live.ts:
   *  checkQuoteOutage vs an adapter's own venue.quote.unavailable). Pass the
   *  moment the condition being reported STARTED: notes are an append log that
   *  is rarely retracted, so an unscoped read answers "has anyone ever said
   *  this", which stays true long after the event it described ended. */
  holds(code: NoteCode, venue?: string, since = 0): boolean {
    const v = venue || undefined;
    return this.items.some(({ note: n }) => n.code === code && n.venue === v && n.ts >= since);
  }

  /** raise a note. */
  note(code: NoteCode, msg: string, venue?: string, key?: string): void {
    this.push(code, scrubNote(msg), venue, key);
  }

  /** raise a note at most once: per-tick drop reasons must not spam the window. */
  noteOnce(code: NoteCode, msg: string, venue?: string, key?: string): void {
    const s = scrubNote(msg);
    const v = venue || undefined;
    // Retract BEFORE the dedupe check. A recovery is worded the same way every
    // time, so the second time a condition heals the announcement is a repeat
    // and gets swallowed here — and swallowing it must not leave the healed
    // condition standing, which is the whole bug this pairing exists to fix.
    this.retract(code, v, key);
    if (this.items.some((h) => h.note.code === code && h.note.msg === s
      && h.note.venue === v && h.key === key)) return;
    this.push(code, s, venue, key);
  }

  /** retract a note that no longer describes reality (a recovered
   *  degradation). Matched on code + venue + the SCRUBBED message, so the
   *  retraction hits exactly the note that was raised. */
  drop(code: NoteCode, msg: string, venue?: string): void {
    const s = scrubNote(msg);
    const v = venue || undefined;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const n = this.items[i].note;
      if (n.code === code && n.msg === s && n.venue === v) this.items.splice(i, 1);
    }
  }

  /**
   * Drop the condition `code` recovers, if it is one (@shared: RETRACTS).
   *
   * The match is `code + venue + key` — NOT `code + venue`. One venue holds
   * several distinct conditions at once (Lunarbase raises four, all stamped
   * `venue: 'lunarbase'` because `StateNote` has no field finer than the
   * venue), so a venue-wide retraction would let "chain head readable again"
   * erase a still-true "MON/USDC quote hidden: pool paused". The key is what
   * makes the retraction hit the condition that actually cleared.
   */
  private retract(code: NoteCode, venue?: string, key?: string): void {
    const condition = RETRACTS[code];
    if (condition === undefined) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const h = this.items[i];
      if (h.note.code === condition && h.note.venue === venue && h.key === key) this.items.splice(i, 1);
    }
  }

  private push(code: NoteCode, msg: string, venue?: string, key?: string): void {
    const v = venue || undefined;
    this.retract(code, v, key);
    const n: StateNote = { ts: this.now(), level: NOTE_LEVEL[code], code, ...(v ? { venue: v } : {}), msg };
    this.items.push(key === undefined ? { note: n } : { note: n, key });
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
    for (const { note: n } of this.items) {
      const sub = noteSubsystem(n.code);
      counts.set(sub, (counts.get(sub) ?? 0) + 1);
    }
    let loudest = '';
    let most = 0;
    for (const [sub, c] of counts) if (c > most) { most = c; loudest = sub; }
    const mine = (h: HeldNote) => noteSubsystem(h.note.code) === loudest;
    const info = this.items.findIndex((h) => mine(h) && h.note.level === 'info');
    return info >= 0 ? info : this.items.findIndex(mine);
  }
}
