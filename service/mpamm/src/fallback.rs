//! Fallback mode (docs/rebuild-spec.md → Failure modes): when the local node
//! stops, falls behind or its ring can't be read (a node upgrade the service
//! build doesn't know yet), heads, quotes and final blocks come from the
//! hosted hot node, a few hundred ms slower; when the local node is healthy
//! again for a while, everything moves back.
//!
//! - Heads: the hot node's `latest` block, polled (its `monadNewHeads`
//!   WebSocket can replace the poll), each new one quoted as the ring's
//!   executed blocks are, with quote reads pinned to its hash on the hot node.
//! - Trades: every height up to the hot node's `finalized` is handed to the
//!   pipeline as a height to read over RPC (local skipped, hot, then
//!   archive), so gas stays exact. The pipeline drops heights already
//!   committed and reads skipped ones first, so the ring taking over again
//!   needs no handshake.
//!
//! Detection is a pure state machine (`Detector`), driven every 250 ms.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use mpamm_chain::{parse_b32, parse_quantity, Rpc};
use mpamm_pipeline::{Input, Stats};
use mpamm_ring::{live::FollowStats, MissingReason};
use mpamm_types::NoteLevel;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use tokio::sync::mpsc;

use crate::notes::NoteBuffer;

/// No execution event for this long while running locally: the node is down.
pub const QUIET_MS: u64 = 5_000;
/// Our head this far behind the hosted head …
pub const BEHIND_BLOCKS: u64 = 10;
/// … for this long: the node is behind.
pub const BEHIND_MS: u64 = 30_000;
/// The local node healthy (fresh events, at the hosted head) this long: back.
pub const RECOVER_MS: u64 = 10_000;
/// Heights handed to the pipeline per tick, at most.
const FEED_MAX: u64 = 400;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Obs {
    pub now_ms: u64,
    pub ring_open: bool,
    pub last_event_age_ms: Option<u64>,
    pub ring_newest: u64,
    pub hot_head: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    Enter(String),
    Exit,
}

#[derive(Debug, Default)]
pub struct Detector {
    active: bool,
    behind_since: Option<u64>,
    quiet_since: Option<u64>,
    healthy_since: Option<u64>,
}

impl Detector {
    pub fn active(&self) -> bool {
        self.active
    }

    pub fn step(&mut self, o: Obs) -> Option<Transition> {
        let fresh = o.ring_open && o.last_event_age_ms.is_some_and(|a| a < QUIET_MS);
        let behind = o.hot_head.is_some_and(|h| h > o.ring_newest + BEHIND_BLOCKS);
        if !self.active {
            // Quiet is timed by the detector too: a ring that never opened
            // reports no age at all.
            if fresh {
                self.quiet_since = None;
            } else {
                self.quiet_since.get_or_insert(o.now_ms);
            }
            if behind {
                self.behind_since.get_or_insert(o.now_ms);
            } else {
                self.behind_since = None;
            }
            let reason = match (self.quiet_since, self.behind_since) {
                (Some(t), _) if o.now_ms - t >= QUIET_MS || o.last_event_age_ms.is_some_and(|a| a >= QUIET_MS) => {
                    Some(if o.ring_open {
                        format!(
                            "the local node has gone quiet (no execution event for {} ms)",
                            o.last_event_age_ms.unwrap_or(o.now_ms - t)
                        )
                    } else {
                        "the event ring can't be read".to_string()
                    })
                }
                (_, Some(t)) if o.now_ms - t >= BEHIND_MS => Some(format!(
                    "the local node trails the hosted head by {} blocks",
                    o.hot_head.unwrap_or(0).saturating_sub(o.ring_newest)
                )),
                _ => None,
            };
            if let Some(r) = reason {
                *self = Detector { active: true, ..Detector::default() };
                return Some(Transition::Enter(r));
            }
            return None;
        }
        let healthy = o.ring_open
            && o.last_event_age_ms.is_some_and(|a| a < 1_000)
            && o.hot_head.is_none_or(|h| o.ring_newest + 3 >= h);
        if healthy {
            let since = *self.healthy_since.get_or_insert(o.now_ms);
            if o.now_ms - since >= RECOVER_MS {
                *self = Detector::default();
                return Some(Transition::Exit);
            }
        } else {
            self.healthy_since = None;
        }
        None
    }
}

/// What `/api/health` shows.
#[derive(Debug, Default)]
pub struct FallbackStats {
    pub active: AtomicBool,
    pub since_ms: AtomicU64,
    pub hot_head: AtomicU64,
    pub heads: AtomicU64,
    pub fed: AtomicU64,
    pub reason: Mutex<Option<String>>,
    pub entered: AtomicU64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackView {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub hot_head: u64,
    /// Heads quoted and heights handed to the pipeline, over this run.
    pub heads: u64,
    pub fed: u64,
    /// Times fallback mode was entered.
    pub entered: u64,
}

impl FallbackStats {
    pub fn view(&self) -> FallbackView {
        let active = self.active.load(Ordering::Relaxed);
        FallbackView {
            active,
            since_ms: active.then(|| self.since_ms.load(Ordering::Relaxed)),
            reason: if active { self.reason.lock().clone() } else { None },
            hot_head: self.hot_head.load(Ordering::Relaxed),
            heads: self.heads.load(Ordering::Relaxed),
            fed: self.fed.load(Ordering::Relaxed),
            entered: self.entered.load(Ordering::Relaxed),
        }
    }
}

pub struct Driver {
    /// The hosted hot node: heads and finality (and its own client for quotes).
    pub hot: Rpc,
    pub hot_quotes: Rpc,
    pub local_quotes: Rpc,
    pub engine: Arc<mpamm_quotes::Engine>,
    pub ring: Arc<FollowStats>,
    pub pipeline: Arc<Stats>,
    pub feed: mpsc::UnboundedSender<Input>,
    /// Read by the pipeline's fetcher: skip the local node.
    pub skip_local: Arc<AtomicBool>,
    pub stats: Arc<FallbackStats>,
    pub notes: Arc<NoteBuffer>,
}

fn now_ms() -> u64 {
    mpamm_ring::live::now_ms()
}

async fn block_tag(rpc: &Rpc, tag: &str) -> Option<(u64, [u8; 32])> {
    let b = rpc.call("eth_getBlockByNumber", json!([tag, false])).await.ok()?;
    Some((parse_quantity(&b["number"])?, parse_b32(&b["hash"])?))
}

impl Driver {
    pub async fn run(self) {
        let mut d = Detector::default();
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        let mut last_head: Option<(u64, [u8; 32])> = None;
        let mut next_feed = 0u64;
        let mut polls = 0u64;
        loop {
            tick.tick().await;
            polls += 1;
            // The hosted head: every tick in fallback, every second otherwise.
            let hot_head = if d.active() || polls.is_multiple_of(4) {
                match self.hot.block_number().await {
                    Ok(h) => {
                        self.stats.hot_head.store(h, Ordering::Relaxed);
                        Some(h)
                    }
                    Err(_) => None,
                }
            } else {
                Some(self.stats.hot_head.load(Ordering::Relaxed)).filter(|h| *h > 0)
            };
            let ring = self.ring.view();
            let obs = Obs {
                now_ms: now_ms(),
                ring_open: ring.ring_open,
                last_event_age_ms: ring.last_event_age_ms,
                ring_newest: ring.newest_block,
                hot_head,
            };
            match d.step(obs) {
                Some(Transition::Enter(reason)) => {
                    tracing::info!(target: "fallback", "entering fallback mode: {reason}");
                    self.notes.note(
                        now_ms() as f64,
                        NoteLevel::Warn,
                        "fallback.enter",
                        None,
                        &format!("fallback mode: {reason}; heads, quotes and final blocks from the hosted node"),
                    );
                    *self.stats.reason.lock() = Some(reason);
                    self.stats.since_ms.store(now_ms(), Ordering::Relaxed);
                    self.stats.active.store(true, Ordering::Relaxed);
                    self.stats.entered.fetch_add(1, Ordering::Relaxed);
                    self.skip_local.store(true, Ordering::Relaxed);
                    self.engine.use_rpc(self.hot_quotes.clone());
                    next_feed = self.pipeline.cursor.load(Ordering::Relaxed) + 1;
                    last_head = None;
                }
                Some(Transition::Exit) => {
                    let secs = (now_ms() - self.stats.since_ms.load(Ordering::Relaxed)) / 1000;
                    tracing::info!(target: "fallback", "leaving fallback mode after {secs} s");
                    self.notes.note(
                        now_ms() as f64,
                        NoteLevel::Info,
                        "fallback.exit",
                        None,
                        &format!("back on the local node after {secs} s in fallback mode"),
                    );
                    self.stats.active.store(false, Ordering::Relaxed);
                    self.skip_local.store(false, Ordering::Relaxed);
                    self.engine.use_rpc(self.local_quotes.clone());
                }
                None => {}
            }
            if !d.active() {
                continue;
            }
            // Heads: each new proposed block, quoted on the hosted node.
            if let Some(head) = block_tag(&self.hot, "latest").await {
                if last_head != Some(head) {
                    last_head = Some(head);
                    self.stats.heads.fetch_add(1, Ordering::Relaxed);
                    let block = mpamm_core::BlockRef { number: head.0, id: head.1, hash: head.1 };
                    self.engine.on_executed(block, u128::from(now_ms()) * 1_000_000);
                }
            }
            // Final heights, handed to the pipeline in order.
            if let Some((finalized, _)) = block_tag(&self.hot, "finalized").await {
                next_feed = next_feed.max(self.pipeline.cursor.load(Ordering::Relaxed) + 1);
                let until = finalized.min(next_feed + FEED_MAX - 1);
                for n in next_feed..=until {
                    if self.feed.send(Input::Missing { number: n, reason: MissingReason::Fallback }).is_err() {
                        return;
                    }
                    self.stats.fed.fetch_add(1, Ordering::Relaxed);
                }
                next_feed = next_feed.max(until + 1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(now: u64, open: bool, age: Option<u64>, newest: u64, hot: Option<u64>) -> Obs {
        Obs { now_ms: now, ring_open: open, last_event_age_ms: age, ring_newest: newest, hot_head: hot }
    }

    #[test]
    fn a_quiet_node_enters_fallback_after_the_quiet_time() {
        let mut d = Detector::default();
        assert_eq!(d.step(obs(0, true, Some(100), 100, Some(100))), None);
        assert_eq!(d.step(obs(1_000, true, Some(4_900), 100, Some(110))), None);
        match d.step(obs(2_000, true, Some(5_100), 100, Some(112))) {
            Some(Transition::Enter(r)) => assert!(r.contains("gone quiet"), "{r}"),
            other => panic!("{other:?}"),
        }
        assert!(d.active());
    }

    #[test]
    fn a_ring_that_never_opens_enters_after_the_quiet_time() {
        let mut d = Detector::default();
        assert_eq!(d.step(obs(0, false, None, 0, Some(100))), None);
        assert_eq!(d.step(obs(4_000, false, None, 0, Some(110))), None);
        match d.step(obs(5_000, false, None, 0, Some(112))) {
            Some(Transition::Enter(r)) => assert!(r.contains("can't be read"), "{r}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_node_behind_enters_only_after_thirty_seconds() {
        let mut d = Detector::default();
        assert_eq!(d.step(obs(0, true, Some(10), 100, Some(120))), None);
        assert_eq!(d.step(obs(20_000, true, Some(10), 150, Some(170))), None);
        // Caught up for a moment: the clock restarts.
        assert_eq!(d.step(obs(25_000, true, Some(10), 175, Some(180))), None);
        assert_eq!(d.step(obs(40_000, true, Some(10), 200, Some(220))), None);
        match d.step(obs(70_000, true, Some(10), 250, Some(270))) {
            Some(Transition::Enter(r)) => assert!(r.contains("trails the hosted head by 20"), "{r}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_hosted_node_down_never_enters_on_its_own() {
        let mut d = Detector::default();
        for t in (0..100_000).step_by(250) {
            assert_eq!(d.step(obs(t, true, Some(50), 100 + t / 400, None)), None);
        }
    }

    #[test]
    fn it_leaves_only_after_ten_healthy_seconds() {
        let mut d = Detector::default();
        d.step(obs(0, true, Some(9_000), 100, Some(200)));
        assert!(d.active());
        assert_eq!(d.step(obs(1_000, true, Some(200), 198, Some(200))), None);
        // A relapse restarts the clock.
        assert_eq!(d.step(obs(6_000, true, Some(2_000), 210, Some(215))), None);
        assert_eq!(d.step(obs(7_000, true, Some(100), 216, Some(217))), None);
        assert_eq!(d.step(obs(16_000, true, Some(100), 240, Some(241))), None);
        assert_eq!(d.step(obs(17_000, true, Some(100), 243, Some(243))), Some(Transition::Exit));
        assert!(!d.active());
    }
}
