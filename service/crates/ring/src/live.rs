//! The reader's live numbers, shared with the health endpoint. Plain
//! atomics, so this builds everywhere (the follower itself is Linux-only).

use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Default)]
pub struct FollowStats {
    pub events: AtomicU64,
    pub gaps: AtomicU64,
    pub expired: AtomicU64,
    pub reopens: AtomicU64,
    pub stalls: AtomicU64,
    pub reader_seqno: AtomicU64,
    pub writer_seqno: AtomicU64,
    pub last_event_unix_ms: AtomicU64,
    pub newest_block: AtomicU64,
    pub ring_open: AtomicBool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowView {
    pub ring_open: bool,
    pub events: u64,
    pub gaps: u64,
    pub expired: u64,
    pub reopens: u64,
    pub stalls: u64,
    pub lag_events: u64,
    pub last_event_age_ms: Option<u64>,
    pub newest_block: u64,
}

impl FollowStats {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn saw(&self, seqno: u64) {
        self.reader_seqno.store(seqno, Ordering::Relaxed);
        self.events.fetch_add(1, Ordering::Relaxed);
        self.last_event_unix_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn view(&self) -> FollowView {
        let last = self.last_event_unix_ms.load(Ordering::Relaxed);
        FollowView {
            ring_open: self.ring_open.load(Ordering::Relaxed),
            events: self.events.load(Ordering::Relaxed),
            gaps: self.gaps.load(Ordering::Relaxed),
            expired: self.expired.load(Ordering::Relaxed),
            reopens: self.reopens.load(Ordering::Relaxed),
            stalls: self.stalls.load(Ordering::Relaxed),
            lag_events: self
                .writer_seqno
                .load(Ordering::Relaxed)
                .saturating_sub(self.reader_seqno.load(Ordering::Relaxed)),
            last_event_age_ms: (last > 0).then(|| now_ms().saturating_sub(last)),
            newest_block: self.newest_block.load(Ordering::Relaxed),
        }
    }
}
