//! `state.notes`: the service's own telemetry for maintainers (today's
//! `notes.ts`), served on `GET /api/markets` and never on the stream. Every
//! warning the service logs becomes a note: `code` is the subsystem that
//! raised it (`feeds.warn`, `pipeline.warn`, …), and the message is scrubbed
//! of URLs (an RPC URL embeds a key), collapsed and capped. The log keeps the
//! full history; the buffer keeps a window, and a full window loses a note
//! of its noisiest subsystem first (an info before a warning), so a burst of
//! one kind can't evict the note that explains an incident.

use std::{fmt::Write, sync::Arc};

use mpamm_types::{NoteLevel, StateNote};
use parking_lot::Mutex;
use tracing::{field::Field, Event, Level, Subscriber};
use tracing_subscriber::{layer::Context, Layer};

/// The served window (today's `NOTES_MAX`).
pub const NOTES_MAX: usize = 60;
/// The longest message kept whole (today's `NOTE_MSG_MAX`).
pub const NOTE_MSG_MAX: usize = 300;

/// URLs out (an RPC URL carries a key), whitespace collapsed, length capped.
pub fn scrub(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    for word in msg.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        // A URL anywhere in the word (`url=https://…`, `(wss://…)`) is cut
        // from its scheme to the word's end, as today's regex does.
        let lower = word.to_ascii_lowercase();
        match ["https://", "http://", "wss://", "ws://"].iter().filter_map(|s| lower.find(s)).min() {
            Some(at) => {
                out.push_str(&word[..at]);
                out.push_str("<rpc>");
            }
            None => out.push_str(word),
        }
    }
    if out.chars().count() > NOTE_MSG_MAX {
        out = out.chars().take(NOTE_MSG_MAX - 3).collect::<String>() + "…";
    }
    out
}

fn subsystem(code: &str) -> &str {
    code.split('.').next().unwrap_or(code)
}

#[derive(Default)]
pub struct NoteBuffer {
    items: Mutex<Vec<StateNote>>,
}

impl NoteBuffer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The window as served, oldest first.
    pub fn list(&self) -> Vec<StateNote> {
        self.items.lock().clone()
    }

    /// Raises a note; a verbatim repeat of one in the window is dropped.
    pub fn note(&self, ts: f64, level: NoteLevel, code: &str, venue: Option<&str>, msg: &str) {
        let msg = scrub(msg);
        let mut items = self.items.lock();
        if items.iter().any(|n| n.code == code && n.msg == msg && n.venue.as_deref() == venue) {
            return;
        }
        items.push(StateNote { ts, level, code: code.into(), venue: venue.map(str::to_string), msg });
        while items.len() > NOTES_MAX {
            let i = evict_index(&items);
            items.remove(i);
        }
    }

    /// The tracing layer that turns every warning into a note.
    pub fn layer(self: &Arc<Self>) -> NotesLayer {
        NotesLayer(self.clone())
    }
}

/// The loudest subsystem's oldest info note, else its oldest note.
fn evict_index(items: &[StateNote]) -> usize {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for n in items {
        let sub = subsystem(&n.code);
        match counts.iter_mut().find(|(s, _)| *s == sub) {
            Some((_, c)) => *c += 1,
            None => counts.push((sub, 1)),
        }
    }
    let mut loudest = ("", 0);
    for (s, c) in counts {
        if c > loudest.1 {
            loudest = (s, c);
        }
    }
    let mine = |n: &StateNote| subsystem(&n.code) == loudest.0;
    items
        .iter()
        .position(|n| mine(n) && n.level == NoteLevel::Info)
        .or_else(|| items.iter().position(mine))
        .unwrap_or(0)
}

pub struct NotesLayer(Arc<NoteBuffer>);

#[derive(Default)]
struct Message(String);

impl tracing::field::Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.push_str(value);
        } else {
            let _ = write!(self.0, " {}={value}", field.name());
        }
    }
}

/// `mpamm::run` → `service`; a crate target keeps its last segment.
fn code_of(target: &str, level: &Level) -> String {
    let sub = match target {
        t if t.starts_with("mpamm") => "service",
        t => t.rsplit("::").next().unwrap_or(t),
    };
    let kind = if *level == Level::ERROR { "error" } else { "warn" };
    format!("{sub}.{kind}")
}

impl<S: Subscriber> Layer<S> for NotesLayer {
    fn on_event(&self, event: &Event<'_>, _cx: Context<'_, S>) {
        let level = *event.metadata().level();
        if level > Level::WARN {
            return; // info and below stay in the log
        }
        let mut m = Message::default();
        event.record(&mut m);
        let ts = mpamm_ring::live::now_ms() as f64;
        self.0.note(ts, NoteLevel::Warn, &code_of(event.metadata().target(), &level), None, &m.0);
    }
}

/// Counts per code.
#[cfg(test)]
pub fn counts(notes: &[StateNote]) -> std::collections::HashMap<String, usize> {
    let mut c = std::collections::HashMap::new();
    for n in notes {
        *c.entry(n.code.clone()).or_insert(0) += 1;
    }
    c
}

#[cfg(test)]
mod tests {
    use tracing_subscriber::prelude::*;

    use super::*;

    #[test]
    fn urls_never_survive_and_long_messages_are_cut() {
        assert_eq!(
            scrub("rpc error: url=https://node.example/rpc/SECRETKEY  failed\n twice (wss://x/y)"),
            "rpc error: url=<rpc> failed twice (<rpc>"
        );
        assert_eq!(scrub("HTTP://A/B"), "<rpc>", "any case");
        let long = "x".repeat(400);
        let s = scrub(&long);
        assert_eq!(s.chars().count(), NOTE_MSG_MAX - 2, "today's: 297 characters and the ellipsis");
        assert!(s.ends_with('…'));
    }

    #[test]
    fn repeats_are_dropped_and_the_loudest_subsystem_pays_for_overflow() {
        let b = NoteBuffer::new();
        b.note(1.0, NoteLevel::Warn, "rpc.failover", None, "primary down");
        b.note(2.0, NoteLevel::Warn, "rpc.failover", None, "primary down");
        assert_eq!(b.list().len(), 1, "a verbatim repeat");
        for i in 0..NOTES_MAX {
            let level = if i % 2 == 0 { NoteLevel::Info } else { NoteLevel::Warn };
            b.note(10.0 + i as f64, level, "backfill.skip", None, &format!("range {i}"));
        }
        let list = b.list();
        assert_eq!(list.len(), NOTES_MAX);
        assert!(list.iter().any(|n| n.code == "rpc.failover"), "the incident's note survives the burst");
        let c = counts(&list);
        assert_eq!(c["backfill.skip"], NOTES_MAX - 1);
        assert!(!list.iter().any(|n| n.msg == "range 0"), "the burst's oldest info note went first");
    }

    #[test]
    fn warnings_become_notes_and_info_stays_in_the_log() {
        let b = NoteBuffer::new();
        let subscriber = tracing_subscriber::registry().with(b.layer());
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "feeds", "kraken: connected");
            tracing::warn!(target: "feeds", "kraken: book checksum mismatch for ANTx/USD; awaiting a fresh snapshot");
            tracing::warn!("discover poe: rpc error at https://node.example/key; retrying");
            tracing::error!(target: "pipeline", "decode block 7: boom");
        });
        let list = b.list();
        let got: Vec<(&str, &str)> = list.iter().map(|n| (n.code.as_str(), n.msg.as_str())).collect();
        assert_eq!(
            got,
            [
                ("feeds.warn", "kraken: book checksum mismatch for ANTx/USD; awaiting a fresh snapshot"),
                ("service.warn", "discover poe: rpc error at <rpc> retrying"),
                ("pipeline.error", "decode block 7: boom"),
            ]
        );
        assert!(list.iter().all(|n| n.level == NoteLevel::Warn));
    }
}
