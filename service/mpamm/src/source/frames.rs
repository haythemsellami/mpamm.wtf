//! Quote frames: the engine announces each venue's answer for a proposed
//! block as it finishes; the dashboard draws one frame per block. A frame is
//! emitted the moment every venue has answered (rows, nothing to quote, or
//! a miss), or at the deadline with the silent ones listed missing. The
//! exchanges' reference rows arrive first, with the job's start.
//!
//! Identity: a frame is a (height, hash). A second proposal at a height
//! already framed, or a proposal below the newest one (a rollback to an
//! ancestor), bumps the revision: clients and the execution history drop
//! everything from that height and take the new frame. A late answer for a
//! frame already emitted is dropped; a pending frame on an abandoned fork is
//! never emitted.

use std::collections::{BTreeMap, VecDeque};

use indexmap::IndexMap;
use mpamm_quotes::{Outcome, VenueQuote};
use mpamm_types::{QuoteFrameTelemetry, QuoteHeadSource, QuoteRow, QuoteSnapshot};

/// Heights remembered to tell a late answer from a new proposal.
const SEEN_HEIGHTS: usize = 64;

struct Pending {
    number: u64,
    hash: [u8; 32],
    proposal_ms: f64,
    started_ms: f64,
    completed_ms: f64,
    /// venue → its rows, in arrival order.
    rows: IndexMap<String, Vec<QuoteRow>>,
    /// venue → (ms, outcome) for every engine venue that answered.
    answered: IndexMap<String, (f64, Outcome)>,
}

pub struct Assembler {
    /// The engine's venues, in registry order: the frame's row order, and
    /// who a complete frame waits for.
    expected: Vec<String>,
    /// How long after its start a frame waits for silent venues.
    deadline_ms: f64,
    pending: Option<Pending>,
    seen: BTreeMap<u64, [u8; 32]>,
    /// Hashes of blocks on abandoned forks: their late answers are dropped.
    abandoned: VecDeque<[u8; 32]>,
    revision: u64,
}

impl Assembler {
    pub fn new(expected: Vec<String>, deadline_ms: f64) -> Self {
        Self { expected, deadline_ms, pending: None, seen: BTreeMap::new(), abandoned: VecDeque::new(), revision: 0 }
    }

    #[cfg(test)]
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// One announced answer; returns the frames it completes (the previous
    /// block's, cut short by this one, and this one's when complete).
    pub fn on_quote(&mut self, q: &VenueQuote, now: f64, mon_usd: f64) -> Vec<QuoteSnapshot> {
        let (n, h) = (q.block, q.block_ref.hash);
        let mut out = Vec::new();
        let ours = self.pending.as_ref().is_some_and(|p| p.number == n && p.hash == h);
        if !ours {
            if self.seen.get(&n) == Some(&h) || self.abandoned.contains(&h) {
                return out; // late for a frame already emitted, or abandoned
            }
            let newest = self.seen.keys().next_back().copied();
            if newest.is_some_and(|top| n <= top) {
                // A new proposal at a framed height, or a rollback below it.
                self.revision += 1;
                let dropped: Vec<[u8; 32]> = self.seen.split_off(&n).into_values().collect();
                self.abandoned.extend(dropped);
                while self.abandoned.len() > SEEN_HEIGHTS {
                    self.abandoned.pop_front();
                }
                if self.pending.as_ref().is_some_and(|p| p.number >= n) {
                    self.pending = None; // on the abandoned fork
                }
            }
            if let Some(p) = self.pending.take() {
                out.push(self.emit(p, now, mon_usd));
            }
            self.seen.insert(n, h);
            while self.seen.len() > SEEN_HEIGHTS {
                self.seen.pop_first();
            }
            self.pending = Some(Pending {
                number: n,
                hash: h,
                proposal_ms: q.proposal_ms,
                started_ms: q.started_ms,
                completed_ms: q.started_ms,
                rows: IndexMap::new(),
                answered: IndexMap::new(),
            });
        }
        let expected = &self.expected;
        let p = self.pending.as_mut().expect("pending");
        if !q.rows.is_empty() {
            p.rows.entry(q.venue.clone()).or_default().extend(q.rows.iter().cloned());
        }
        if expected.contains(&q.venue) {
            p.answered.insert(q.venue.clone(), (q.done_ms - q.started_ms, q.outcome));
            p.completed_ms = p.completed_ms.max(q.done_ms);
        }
        if expected.iter().all(|v| p.answered.contains_key(v)) {
            let p = self.pending.take().unwrap();
            out.push(self.emit(p, now, mon_usd));
        }
        out
    }

    /// The pending frame, once its deadline has passed.
    pub fn tick(&mut self, now: f64, mon_usd: f64) -> Option<QuoteSnapshot> {
        let due = self.pending.as_ref().is_some_and(|p| now >= p.started_ms + self.deadline_ms);
        if due {
            let p = self.pending.take().unwrap();
            return Some(self.emit(p, now, mon_usd));
        }
        None
    }

    fn emit(&self, p: Pending, now: f64, mon_usd: f64) -> QuoteSnapshot {
        let published = |v: &str| p.answered.get(v).is_some_and(|(_, o)| *o == Outcome::Published);
        let missing: Vec<String> = self.expected.iter().filter(|v| !published(v)).cloned().collect();
        let adapter_ms: IndexMap<String, f64> = self
            .expected
            .iter()
            .filter_map(|v| p.answered.get(v).filter(|(_, o)| *o == Outcome::Published).map(|(ms, _)| (v.clone(), *ms)))
            .collect();
        // Rows in the engine's venue order, the exchanges' after them.
        let mut rows: Vec<QuoteRow> = Vec::new();
        for v in &self.expected {
            rows.extend(p.rows.get(v).into_iter().flatten().cloned());
        }
        let mut others: Vec<&String> = p.rows.keys().filter(|v| !self.expected.contains(v)).collect();
        others.sort();
        for v in others {
            rows.extend(p.rows[v].iter().cloned());
        }
        QuoteSnapshot {
            block_hash: Some(format!("0x{}", mpamm_ring::hex(&p.hash))),
            revision: Some(self.revision),
            block: p.number,
            mon_usd,
            ts: now,
            rows,
            frame: Some(QuoteFrameTelemetry {
                // The ring's proposal is a push, like today's WS head.
                head_source: QuoteHeadSource::Ws,
                head_observed_at: p.proposal_ms,
                quote_started_at: p.started_ms,
                quote_completed_at: p.completed_ms,
                emitted_at: now,
                duration_ms: p.completed_ms - p.started_ms,
                adapter_ms,
                missing_venues: missing,
                coalesced_blocks: 0,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use mpamm_core::BlockRef;

    use super::*;

    fn row(venue: &str) -> QuoteRow {
        QuoteRow {
            venue_id: venue.into(),
            market: "MON/USDC".into(),
            size_usd: 1000.0,
            bid_bps: -1.0,
            ask_bps: 1.0,
            bid_px: 1.0,
            ask_px: 1.0,
            spread_bps: 2.0,
            filled_full: true,
            one_sided: None,
            fee_bps: 0.0,
            cex_ask_bps: None,
            cex_bid_bps: None,
            ts: 0.0,
        }
    }

    fn q(venue: &str, n: u64, hash: u8, done: f64, outcome: Outcome, rows: usize) -> VenueQuote {
        VenueQuote {
            venue: venue.into(),
            block: n,
            block_ref: BlockRef { number: n, id: [hash; 32], hash: [hash; 32] },
            proposal_ms: 990.0,
            started_ms: 1000.0,
            done_ms: done,
            rows: (0..rows).map(|_| row(venue)).collect(),
            outcome,
        }
    }

    fn asm() -> Assembler {
        Assembler::new(vec!["poe".into(), "hanji".into(), "woofi".into()], 160.0)
    }

    #[test]
    fn a_frame_goes_out_when_every_venue_has_answered() {
        let mut a = asm();
        assert!(a.on_quote(&q("bybit", 10, 1, 1000.0, Outcome::Published, 2), 1000.0, 0.03).is_empty());
        assert!(a.on_quote(&q("hanji", 10, 1, 1004.0, Outcome::Published, 1), 1004.0, 0.03).is_empty());
        assert!(a.on_quote(&q("woofi", 10, 1, 1006.0, Outcome::Published, 0), 1006.0, 0.03).is_empty());
        let f = a.on_quote(&q("poe", 10, 1, 1009.0, Outcome::Published, 1), 1009.5, 0.03);
        assert_eq!(f.len(), 1);
        let f = &f[0];
        let venues: Vec<&str> = f.rows.iter().map(|r| r.venue_id.as_str()).collect();
        assert_eq!(venues, ["poe", "hanji", "bybit", "bybit"], "engine order, exchanges after");
        assert_eq!((f.block, f.revision, f.ts, f.mon_usd), (10, Some(0), 1009.5, 0.03));
        assert_eq!(f.block_hash.as_deref(), Some(format!("0x{}", "01".repeat(32)).as_str()));
        let t = f.frame.as_ref().unwrap();
        assert!(t.missing_venues.is_empty(), "nothing to quote is an answer, not a miss");
        assert_eq!(t.adapter_ms.keys().collect::<Vec<_>>(), ["poe", "hanji", "woofi"]);
        assert_eq!((t.duration_ms, t.head_observed_at, t.emitted_at), (9.0, 990.0, 1009.5));
        assert!(a.tick(5000.0, 0.03).is_none(), "nothing pending");
    }

    #[test]
    fn misses_and_the_deadline_list_the_silent_venues() {
        let mut a = asm();
        a.on_quote(&q("poe", 10, 1, 1003.0, Outcome::Published, 1), 1003.0, 0.03);
        a.on_quote(&q("hanji", 10, 1, 1150.0, Outcome::Late, 0), 1150.0, 0.03);
        assert!(a.tick(1159.0, 0.03).is_none(), "before the deadline");
        let f = a.tick(1160.0, 0.03).expect("deadline frame");
        assert_eq!(f.frame.as_ref().unwrap().missing_venues, ["hanji", "woofi"]);
        assert_eq!(f.rows.len(), 1);
        // The next block cuts a pending frame short instead.
        a.on_quote(&q("poe", 11, 2, 1403.0, Outcome::Failed, 0), 1403.0, 0.03);
        let f = a.on_quote(&q("poe", 12, 3, 1803.0, Outcome::Published, 1), 1803.0, 0.03);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].block, 11);
        assert_eq!(f[0].frame.as_ref().unwrap().missing_venues, ["poe", "hanji", "woofi"]);
    }

    #[test]
    fn a_late_answer_is_dropped() {
        let mut a = asm();
        for v in ["poe", "hanji", "woofi"] {
            a.on_quote(&q(v, 10, 1, 1001.0, Outcome::Published, 1), 1001.0, 0.03);
        }
        a.on_quote(&q("poe", 11, 2, 1401.0, Outcome::Published, 1), 1401.0, 0.03);
        assert!(a.on_quote(&q("bybit", 10, 1, 1402.0, Outcome::Published, 1), 1402.0, 0.03).is_empty());
        assert_eq!(a.pending.as_ref().unwrap().number, 11, "11 still pending");
        assert_eq!(a.revision(), 0);
    }

    #[test]
    fn a_new_proposal_at_a_framed_height_or_below_bumps_the_revision() {
        let mut a = asm();
        for v in ["poe", "hanji", "woofi"] {
            a.on_quote(&q(v, 10, 1, 1001.0, Outcome::Published, 1), 1001.0, 0.03);
        }
        a.on_quote(&q("poe", 11, 2, 1401.0, Outcome::Published, 1), 1401.0, 0.03);
        // Another block at 11 (a re-proposal): 11's pending frame is on the
        // abandoned fork and never goes out.
        let f = a.on_quote(&q("poe", 11, 9, 1801.0, Outcome::Published, 1), 1801.0, 0.03);
        assert!(f.is_empty());
        assert_eq!(a.revision(), 1);
        for v in ["hanji", "woofi"] {
            a.on_quote(&q(v, 11, 9, 1802.0, Outcome::Published, 1), 1802.0, 0.03);
        }
        // A rollback to 10 under yet another hash.
        let f = a.on_quote(&q("poe", 10, 7, 2201.0, Outcome::Published, 1), 2201.0, 0.03);
        assert!(f.is_empty());
        assert_eq!(a.revision(), 2);
        let f = a.tick(2400.0, 0.03).unwrap();
        assert_eq!((f.block, f.revision), (10, Some(2)));
        // A late answer from the abandoned 11 opens nothing.
        assert!(a.on_quote(&q("hanji", 11, 9, 2402.0, Outcome::Published, 1), 2402.0, 0.03).is_empty());
        assert!(a.pending.is_none());
        assert_eq!(a.revision(), 2);
    }
}
