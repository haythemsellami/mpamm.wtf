//! What the reader writes: one line per settled height, interval summaries,
//! per-proposer arrival, and the health file.

use std::collections::HashMap;

use mpamm_ring::{hex, Block, MissingReason};
use serde::Serialize;

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Pct {
    pub n: usize,
    pub p10: Option<f64>,
    pub p50: Option<f64>,
    pub p90: Option<f64>,
    pub p99: Option<f64>,
    pub max: Option<f64>,
}

pub fn pct(values: &mut [f64]) -> Pct {
    values.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f64| -> Option<f64> {
        if values.is_empty() {
            return None;
        }
        let i = ((values.len() as f64 * q).ceil() as usize).clamp(1, values.len()) - 1;
        Some(round2(values[i]))
    };
    Pct {
        n: values.len(),
        p10: at(0.10),
        p50: at(0.50),
        p90: at(0.90),
        p99: at(0.99),
        max: values.last().copied().map(round2),
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn ms(later: u64, earlier: u64) -> f64 {
    round2((later as f64 - earlier as f64) / 1e6)
}

/// One line of `blocks-*.jsonl`.
#[derive(Serialize, Debug, Clone)]
pub struct Line {
    pub number: u64,
    /// `final` (from the ring), `repaired` (over RPC) or `abandoned`.
    pub outcome: &'static str,
    /// Consensus block id; unknown for a repaired height.
    pub id: Option<String>,
    /// Ethereum block hash.
    pub hash: Option<String>,
    pub round: Option<u64>,
    pub author: Option<String>,
    pub txns: u64,
    pub logs: Option<u64>,
    pub timestamp: u64,
    /// `BLOCK_START` record time minus the proposer's proposal time.
    pub arrival_ms: Option<f64>,
    /// `BLOCK_START` → `BLOCK_END`.
    pub exec_ms: Option<f64>,
    /// After `BLOCK_START`.
    pub voted_ms: Option<f64>,
    pub finalized_ms: Option<f64>,
    pub verified_ms: Option<f64>,
    /// Why a repaired height could not come from the ring.
    pub reason: Option<&'static str>,
    /// Which RPC repaired it.
    pub source: Option<String>,
}

impl Line {
    pub fn from_block(b: &Block, outcome: &'static str) -> Self {
        let arrival = (b.start.proposal_ns > 0).then(|| round2((b.start_ns as f64 - b.start.proposal_ns as f64) / 1e6));
        Self {
            number: b.start.number,
            outcome,
            id: Some(hex(&b.start.id)),
            hash: b.end.map(|e| hex(&e.hash)),
            round: Some(b.start.round),
            author: Some(hex(&b.start.author)),
            txns: u64::from(b.start.txn_count),
            logs: b.end.map(|_| b.log_count),
            timestamp: b.start.timestamp,
            arrival_ms: arrival,
            exec_ms: b.end.map(|e| ms(e.end_ns, b.start_ns)),
            voted_ms: b.qc_ns.map(|t| ms(t, b.start_ns)),
            finalized_ms: b.finalized_ns.map(|t| ms(t, b.start_ns)),
            verified_ms: None,
            reason: None,
            source: None,
        }
    }

    pub fn repaired(h: &mpamm_chain::BlockHeader, reason: MissingReason, source: String) -> Self {
        Self {
            number: h.number,
            outcome: "repaired",
            id: None,
            hash: Some(hex(&h.hash)),
            round: None,
            author: None,
            txns: u64::from(h.txn_count),
            logs: None,
            timestamp: h.timestamp,
            arrival_ms: None,
            exec_ms: None,
            voted_ms: None,
            finalized_ms: None,
            verified_ms: None,
            reason: Some(reason_name(reason)),
            source: Some(source),
        }
    }

    pub fn set_verified(&mut self, start_ns: u64, verified_ns: u64) {
        self.verified_ms = Some(ms(verified_ns, start_ns));
    }
}

pub fn reason_name(r: MissingReason) -> &'static str {
    match r {
        MissingReason::Incomplete => "incomplete",
        MissingReason::Timeout => "timeout",
        MissingReason::Unresolved => "unresolved",
    }
}

/// Distributions over one summary interval.
#[derive(Default)]
pub struct Window {
    pub events: u64,
    pub arrival: Vec<f64>,
    pub exec: Vec<f64>,
    pub voted: Vec<f64>,
    pub finalized: Vec<f64>,
    pub verified: Vec<f64>,
    pub finals: u64,
    pub repaired: u64,
    pub missing: u64,
    pub abandoned: u64,
    pub gaps: u64,
    pub expired: u64,
    pub skipped_seqnos: u64,
}

impl Window {
    pub fn record(&mut self, line: &Line) {
        match line.outcome {
            "final" => {
                self.finals += 1;
                self.arrival.extend(line.arrival_ms);
                self.exec.extend(line.exec_ms);
                self.voted.extend(line.voted_ms);
                self.finalized.extend(line.finalized_ms);
                self.verified.extend(line.verified_ms);
            }
            "repaired" => self.repaired += 1,
            "abandoned" => self.abandoned += 1,
            _ => {}
        }
    }
}

#[derive(Default, Serialize, Clone, Copy, Debug)]
pub struct Totals {
    pub events: u64,
    pub finals: u64,
    pub repaired: u64,
    pub missing: u64,
    pub abandoned: u64,
    pub gaps: u64,
    pub expired: u64,
    pub record_errors: u64,
    pub skipped_seqnos: u64,
    pub stalls: u64,
    pub reopens: u64,
}

#[derive(Serialize)]
pub struct RingInfo {
    pub descriptor_capacity: Option<u64>,
    pub payload_buf_bytes: Option<u64>,
    pub newest_block: Option<u64>,
    pub oldest_block: Option<u64>,
    pub depth_blocks: Option<u64>,
    pub depth_secs: Option<f64>,
    pub probe_ms: f64,
}

#[derive(Serialize)]
pub struct Summary<'a> {
    pub at_unix: u64,
    pub window_secs: f64,
    pub events_per_sec: f64,
    pub finals: u64,
    pub repaired: u64,
    pub missing: u64,
    pub unrepaired: usize,
    pub abandoned: u64,
    pub gaps: u64,
    pub expired_payloads: u64,
    pub skipped_seqnos: u64,
    pub reader_lag_events: Option<u64>,
    pub held_blocks: usize,
    pub arrival_ms: Pct,
    pub exec_ms: Pct,
    pub voted_ms: Pct,
    pub finalized_ms: Pct,
    pub verified_ms: Pct,
    pub ring: RingInfo,
    pub totals: &'a Totals,
}

#[derive(Serialize)]
pub struct Health<'a> {
    pub at_unix: u64,
    /// `ok`, `stalled` (no events for --stall-secs), `repairing` (heights
    /// waiting for RPC), `no_ring` (cannot open the ring), `stopped`.
    pub status: &'static str,
    pub last_event_age_ms: Option<u64>,
    pub reader_seqno: u64,
    pub writer_seqno: Option<u64>,
    pub lag_events: Option<u64>,
    pub next_height: Option<u64>,
    pub held_blocks: usize,
    pub awaiting_verified: usize,
    pub unrepaired: usize,
    pub oldest_unrepaired: Option<u64>,
    pub totals: &'a Totals,
}

/// Arrival delay per proposer key, for joining with validator locations.
#[derive(Default)]
pub struct Authors(HashMap<String, Vec<f32>>);

impl Authors {
    pub fn add(&mut self, line: &Line) {
        if let (Some(a), Some(x)) = (&line.author, line.arrival_ms) {
            self.0.entry(a.clone()).or_default().push(x as f32);
        }
    }

    pub fn to_json(&self) -> String {
        #[derive(Serialize)]
        struct Row<'a> {
            author: &'a str,
            n: usize,
            arrival_p50_ms: Option<f64>,
            arrival_p90_ms: Option<f64>,
        }
        let mut rows: Vec<Row> = self
            .0
            .iter()
            .map(|(k, v)| {
                let mut v: Vec<f64> = v.iter().map(|x| f64::from(*x)).collect();
                let p = pct(&mut v);
                Row { author: k, n: p.n, arrival_p50_ms: p.p50, arrival_p90_ms: p.p90 }
            })
            .collect();
        rows.sort_by(|a, b| b.n.cmp(&a.n).then(a.author.cmp(b.author)));
        serde_json::to_string_pretty(&rows).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_use_nearest_rank() {
        let mut v: Vec<f64> = (1..=100).map(f64::from).collect();
        let p = pct(&mut v);
        assert_eq!(
            (p.n, p.p10, p.p50, p.p90, p.p99, p.max),
            (100, Some(10.0), Some(50.0), Some(90.0), Some(99.0), Some(100.0))
        );
        assert_eq!(pct(&mut []).p50, None);
        assert_eq!(pct(&mut [3.333]).p99, Some(3.33));
    }
}
