//! Following the node's ring for the service (Linux): the reader thread's
//! whole loop. It never waits on anything downstream: outputs go to `sink`,
//! which must not block (an unbounded channel).
//!
//! Reopens a recreated ring (node restart), positions itself for the
//! tracker's next height on every (re)open, applies a new watch set as soon
//! as the pipeline publishes one, and keeps live numbers in `FollowStats`.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use arc_swap::ArcSwap;

pub use crate::live::{now_ms, FollowStats, FollowView};
use crate::{
    sdk::{self, Polled, Reader, Ring},
    Output, Tracker, WatchSet,
};

pub struct FollowConfig {
    pub ring: PathBuf,
    /// No event for this long counts as a stall (and prompts a check for a
    /// recreated ring).
    pub stall: Duration,
}

fn position<'r>(ring: &'r Ring, next: Option<u64>) -> Reader<'r> {
    let Some(n) = next else { return ring.reader_at_newest_block() };
    if let Some(r) = ring.reader_before(n) {
        return r;
    }
    if let Some((r, oldest)) = ring.newest_block().and_then(|newest| ring.reader_at_oldest(newest)) {
        tracing::warn!(target: "ring", "height {n} has left the ring; replaying from {oldest}, the rest over RPC");
        return r;
    }
    ring.reader_at_newest_block()
}

/// Follows the ring until `stop` is set or `sink` returns false.
pub fn follow(
    cfg: &FollowConfig,
    mut tracker: Tracker,
    watch: &ArcSwap<WatchSet>,
    stats: &FollowStats,
    stop: &AtomicBool,
    mut sink: impl FnMut(Output) -> bool,
) {
    let mut applied: Arc<WatchSet> = watch.load_full();
    sdk::set_watch(applied.clone());
    let mut opened_once = false;
    let mut last_error_log: Option<Instant> = None;
    let mut alive = true;

    'outer: while alive && !stop.load(Ordering::Relaxed) {
        let ring = match Ring::open(&cfg.ring) {
            Ok(r) => r,
            Err(e) => {
                stats.ring_open.store(false, Ordering::Relaxed);
                if last_error_log.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
                    tracing::error!(target: "ring", "cannot open the ring: {e}; retrying every second");
                    last_error_log = Some(Instant::now());
                }
                tracker.tick(now_ms() * 1_000_000);
                for o in tracker.take() {
                    alive &= sink(o);
                }
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        if opened_once {
            stats.reopens.fetch_add(1, Ordering::Relaxed);
        }
        opened_once = true;
        last_error_log = None;
        stats.ring_open.store(true, Ordering::Relaxed);
        let mut reader = position(&ring, tracker.next_final());
        let mut last_seqno = 0u64;
        let mut last_event = Instant::now();
        let mut stalled = false;
        let mut tick_at = Instant::now();
        let mut second_at = Instant::now();

        loop {
            match sdk::poll(&mut reader) {
                Polled::Event { seqno, t_ns, event } => {
                    last_seqno = seqno;
                    stats.saw(seqno);
                    last_event = Instant::now();
                    stalled = false;
                    if let crate::Event::BlockStart(s) = &event {
                        stats.newest_block.fetch_max(s.number, Ordering::Relaxed);
                    }
                    tracker.handle(event, t_ns);
                    for o in tracker.take() {
                        alive &= sink(o);
                    }
                }
                Polled::Skipped { seqno } => {
                    last_seqno = seqno;
                    stats.saw(seqno);
                    last_event = Instant::now();
                    stalled = false;
                }
                Polled::Gap => {
                    tracker.gap();
                    stats.gaps.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(target: "ring", "sequence gap after seqno {last_seqno}; the lost heights will be read over RPC");
                    last_seqno = 0;
                }
                Polled::Expired { seqno } => {
                    tracker.gap();
                    stats.expired.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(target: "ring", "payload of seqno {seqno} expired while read");
                    last_seqno = 0;
                }
                Polled::Idle => {
                    if !stalled && last_event.elapsed() > cfg.stall {
                        stalled = true;
                        stats.stalls.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(target: "ring", "no events for {:?}; execution may be stalled", cfg.stall);
                    }
                    std::thread::sleep(Duration::from_micros(20));
                }
            }

            if tick_at.elapsed() >= Duration::from_millis(10) {
                tick_at = Instant::now();
                tracker.tick(now_ms() * 1_000_000);
                for o in tracker.take() {
                    alive &= sink(o);
                }
                let current = watch.load();
                if !Arc::ptr_eq(&current, &applied) {
                    applied = current.clone();
                    sdk::set_watch(applied.clone());
                    tracing::info!(target: "ring", "watch set updated: {} log addresses", applied.logs.len());
                }
                if !alive || stop.load(Ordering::Relaxed) {
                    break 'outer;
                }
            }

            if second_at.elapsed() >= Duration::from_secs(1) {
                second_at = Instant::now();
                let header = ring.header();
                if let Some(h) = header {
                    stats.writer_seqno.store(h.last_seqno, Ordering::Relaxed);
                }
                let restarted = header.is_some_and(|h| last_seqno != 0 && h.last_seqno < last_seqno);
                if stalled && (ring.replaced() || restarted) {
                    tracing::warn!(target: "ring", "the ring was recreated (node restart); reopening");
                    tracker.gap();
                    continue 'outer;
                }
            }
        }
    }
    stats.ring_open.store(false, Ordering::Relaxed);
}
