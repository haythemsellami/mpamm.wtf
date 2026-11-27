use super::*;
use crate::event::{Log, TxnHeader, TxnOutput};

const WAIT: u64 = 2_000_000_000;

fn id(n: u64, variant: u8) -> B32 {
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&n.to_be_bytes());
    b[31] = variant;
    b
}

fn hash(n: u64, variant: u8) -> B32 {
    let mut b = id(n, variant);
    b[30] = 0xee;
    b
}

fn start(n: u64, variant: u8, parent: B32, txns: u32) -> Event {
    Event::BlockStart(Box::new(BlockStart {
        id: id(n, variant),
        number: n,
        round: n * 10 + u64::from(variant),
        epoch: 1,
        proposal_ns: 1_000,
        author: [2; 33],
        parent_hash: parent,
        timestamp: 1_700_000_000 + n,
        base_fee: 100,
        gas_limit: 30_000_000,
        txn_count: txns,
    }))
}

fn out(index: u32, log_count: u32) -> Event {
    Event::TxnOutput(TxnOutput { index, status: true, log_count, gas_used: 21_000 })
}

fn header(index: u32) -> Event {
    Event::TxnHeader(Box::new(TxnHeader {
        index,
        hash: [index as u8; 32],
        sender: [1; 20],
        to: Some([2; 20]),
        kind: 2,
        gas_limit: 100_000,
        max_fee_per_gas: 200,
        max_priority_fee_per_gas: 1,
        input: Vec::new(),
    }))
}

fn log(txn_index: u32, index_in_txn: u32) -> Event {
    Event::Log(Box::new(Log { txn_index, index_in_txn, address: [9; 20], topics: vec![[7; 32]], data: vec![1, 2] }))
}

fn end(n: u64, variant: u8) -> Event {
    Event::BlockEnd { hash: hash(n, variant), gas_used: 0 }
}

fn fin(n: u64, variant: u8) -> Event {
    Event::Finalized { id: id(n, variant), number: n }
}

/// Feeds a full, empty block `n` (one variant) whose parent is `n - 1` variant 0.
fn block(t: &mut Tracker, n: u64, variant: u8, at: u64) {
    t.handle(start(n, variant, hash(n - 1, 0), 0), at);
    t.handle(end(n, variant), at + 1);
}

fn summary(outs: &[Output]) -> Vec<String> {
    outs.iter()
        .map(|o| match o {
            Output::Executed { number, complete, .. } => {
                format!("exec {number}{}", if *complete { "" } else { " incomplete" })
            }
            Output::Voted { number, .. } => format!("voted {number}"),
            Output::Final(b) => format!("final {} v{}", b.start.number, b.start.id[31]),
            Output::Missing { number, reason } => format!("missing {number} {reason:?}"),
            Output::Abandoned(b) => format!("abandoned {} v{}", b.start.number, b.start.id[31]),
            Output::Verified { number, .. } => format!("verified {number}"),
        })
        .collect()
}

fn finals(outs: &[Output]) -> Vec<String> {
    summary(outs).into_iter().filter(|s| s.starts_with("final") || s.starts_with("missing")).collect()
}

#[test]
fn normal_lifecycle_in_order() {
    let mut t = Tracker::new(Config::default(), None);
    t.handle(start(10, 0, hash(9, 0), 2), 100);
    t.handle(out(1, 0), 101);
    t.handle(out(0, 3), 102);
    t.handle(end(10, 0), 110);
    t.handle(Event::Qc { id: id(10, 0), number: 10 }, 400);
    t.handle(fin(10, 0), 650);
    t.handle(Event::Verified { number: 10 }, 1_500);
    let outs = t.take();
    assert_eq!(summary(&outs), ["exec 10", "voted 10", "final 10 v0", "verified 10"]);
    let Output::Final(b) = &outs[2] else { unreachable!() };
    assert_eq!((b.start_ns, b.end.unwrap().end_ns, b.qc_ns, b.finalized_ns), (100, 110, Some(400), Some(650)));
    assert_eq!(b.log_count, 3);
    assert_eq!(t.next_final(), Some(11));
    assert_eq!(t.held(), 0);
}

#[test]
fn block_level_log_index_counts_earlier_transactions() {
    let mut t = Tracker::new(Config { require_headers: true, ..Config::default() }, None);
    t.handle(start(5, 0, hash(4, 0), 4), 0);
    for i in 0..4 {
        t.handle(header(i), 1);
    }
    // Transaction events interleave; outputs and logs arrive out of order.
    t.handle(out(2, 3), 2);
    t.handle(log(2, 1), 3);
    t.handle(out(0, 2), 4);
    t.handle(log(0, 1), 5);
    t.handle(Event::TxnReject { index: 1 }, 6);
    t.handle(out(3, 1), 7);
    t.handle(log(3, 0), 8);
    t.handle(end(5, 0), 9);
    t.handle(fin(5, 0), 10);
    let outs = t.take();
    let Some(Output::Final(b)) = outs.iter().find(|o| matches!(o, Output::Final(_))) else { panic!("no final") };
    // txn0 has logs 0..2, txn1 is rejected (none), txn2 has 2..5, txn3 has 5.
    let got: Vec<(u32, u32, u32)> =
        b.logs.iter().zip(&b.log_index).map(|(l, i)| (l.txn_index, l.index_in_txn, *i)).collect();
    assert_eq!(got, [(0, 1, 1), (2, 1, 3), (3, 0, 5)]);
    assert_eq!(b.log_count, 6);
}

#[test]
fn losing_proposal_is_abandoned_at_finalization() {
    let mut t = Tracker::new(Config::default(), None);
    block(&mut t, 10, 1, 0);
    block(&mut t, 10, 2, 10);
    block(&mut t, 11, 2, 20);
    t.handle(fin(10, 2), 30);
    assert_eq!(finals(&t.take()), ["final 10 v2"]);
    let mut t = Tracker::new(Config::default(), None);
    block(&mut t, 10, 1, 0);
    block(&mut t, 10, 2, 10);
    t.handle(fin(10, 2), 30);
    let s = summary(&t.take());
    assert!(s.contains(&"abandoned 10 v1".to_string()), "{s:?}");
    assert_eq!(t.stats().abandoned, 1);
}

#[test]
fn rejected_proposal_never_commits() {
    let mut t = Tracker::new(Config::default(), None);
    t.handle(start(10, 1, hash(9, 0), 0), 0);
    t.handle(Event::BlockReject, 1);
    block(&mut t, 10, 2, 5);
    t.handle(fin(10, 2), 9);
    let s = summary(&t.take());
    assert_eq!(s, ["exec 10", "abandoned 10 v1", "final 10 v2"]);
}

#[test]
fn gap_mid_block_makes_that_height_missing() {
    let mut t = Tracker::new(Config::default(), None);
    block(&mut t, 10, 0, 0);
    t.handle(start(11, 0, hash(10, 0), 1), 10);
    t.gap();
    // Events after the gap but before the next start are orphaned.
    t.handle(out(0, 1), 11);
    t.handle(end(11, 0), 12);
    block(&mut t, 12, 0, 20);
    t.handle(fin(10, 0), 30);
    t.handle(fin(11, 0), 31);
    t.handle(fin(12, 0), 32);
    assert_eq!(finals(&t.take()), ["final 10 v0", "missing 11 Incomplete", "final 12 v0"]);
    assert_eq!(t.stats().gaps, 1);
}

#[test]
fn record_error_or_absent_receipt_is_incomplete() {
    let mut t = Tracker::new(Config::default(), None);
    t.handle(start(10, 0, hash(9, 0), 1), 0);
    t.handle(Event::RecordError, 1);
    t.handle(out(0, 0), 2);
    t.handle(end(10, 0), 3);
    t.handle(start(11, 0, hash(10, 0), 2), 4);
    t.handle(out(0, 0), 5);
    t.handle(end(11, 0), 6);
    t.handle(fin(10, 0), 7);
    t.handle(fin(11, 0), 8);
    assert_eq!(finals(&t.take()), ["missing 10 Incomplete", "missing 11 Incomplete"]);
}

#[test]
fn missing_header_is_incomplete_when_headers_are_required() {
    let mut t = Tracker::new(Config { require_headers: true, ..Config::default() }, None);
    t.handle(start(10, 0, hash(9, 0), 1), 0);
    t.handle(out(0, 0), 1);
    t.handle(end(10, 0), 2);
    t.handle(fin(10, 0), 3);
    assert_eq!(finals(&t.take()), ["missing 10 Incomplete"]);
}

#[test]
fn lost_finalizations_are_recovered_from_parent_hashes() {
    let mut t = Tracker::new(Config::default(), None);
    block(&mut t, 10, 0, 0);
    // A losing proposal at 11 with a different hash must not be picked.
    t.handle(start(11, 7, hash(10, 0), 0), 9);
    t.handle(end(11, 7), 10);
    block(&mut t, 11, 0, 11);
    block(&mut t, 12, 0, 20);
    t.handle(fin(12, 0), 30);
    assert_eq!(finals(&t.take()), ["final 10 v0", "final 11 v0", "final 12 v0"]);
}

#[test]
fn unresolvable_lost_finalization_is_missing_after_the_wait() {
    let mut t = Tracker::new(Config::default(), None);
    block(&mut t, 10, 0, 0);
    // Height 11 never arrives (lost in a gap).
    block(&mut t, 12, 0, 20);
    t.handle(fin(12, 0), 30);
    assert_eq!(finals(&t.take()), Vec::<String>::new(), "waits before declaring a height missing");
    t.tick(30 + WAIT);
    assert_eq!(finals(&t.take()), ["missing 10 Unresolved", "missing 11 Unresolved", "final 12 v0"]);
}

#[test]
fn finalization_before_execution_ends_waits_for_block_end() {
    let mut t = Tracker::new(Config::default(), None);
    t.handle(start(10, 0, hash(9, 0), 0), 0);
    t.handle(fin(10, 0), 5);
    assert!(finals(&t.take()).is_empty());
    t.handle(end(10, 0), 50);
    assert_eq!(finals(&t.take()), ["final 10 v0"]);
}

#[test]
fn finalized_block_that_never_arrives_times_out() {
    let mut t = Tracker::new(Config::default(), Some(10));
    t.handle(fin(10, 0), 100);
    t.tick(100 + WAIT - 1);
    assert!(finals(&t.take()).is_empty());
    t.tick(100 + WAIT);
    assert_eq!(finals(&t.take()), ["missing 10 Timeout"]);
    assert_eq!(t.next_final(), Some(11));
}

#[test]
fn resume_ignores_committed_heights_and_reports_from_the_cursor() {
    let mut t = Tracker::new(Config::default(), Some(100));
    block(&mut t, 98, 0, 0);
    t.handle(fin(98, 0), 1);
    block(&mut t, 99, 0, 2);
    t.handle(fin(99, 0), 3);
    block(&mut t, 100, 0, 4);
    block(&mut t, 101, 0, 6);
    t.handle(fin(100, 0), 8);
    t.handle(fin(101, 0), 9);
    assert_eq!(finals(&t.take()), ["final 100 v0", "final 101 v0"]);
}

#[test]
fn resume_with_heights_already_out_of_the_ring() {
    // Resuming at 100 when the ring only reaches back to 103: the earlier
    // heights have no events at all and must be reported missing, in order.
    let mut t = Tracker::new(Config::default(), Some(100));
    block(&mut t, 103, 0, 0);
    t.handle(fin(103, 0), 10);
    t.tick(10 + WAIT);
    assert_eq!(
        finals(&t.take()),
        ["missing 100 Unresolved", "missing 101 Unresolved", "missing 102 Unresolved", "final 103 v0"]
    );
}

#[test]
fn fresh_start_begins_at_the_first_block_seen() {
    let mut t = Tracker::new(Config::default(), None);
    // Consensus events for blocks before the first start are ignored.
    t.handle(fin(49, 0), 0);
    block(&mut t, 50, 0, 1);
    t.handle(fin(50, 0), 3);
    assert_eq!(finals(&t.take()), ["final 50 v0"]);
}

#[test]
fn every_height_is_reported_exactly_once_in_order() {
    // A long mixed run: re-proposals, a gap, lost finalizations.
    let mut t = Tracker::new(Config::default(), None);
    let mut at = 0;
    let mut reported = Vec::new();
    for n in 1..=200u64 {
        at += 300;
        if n % 17 == 0 {
            t.handle(start(n, 9, hash(n - 1, 0), 0), at);
            t.handle(end(n, 9), at + 1);
        }
        if n % 41 == 0 {
            t.handle(start(n, 0, hash(n - 1, 0), 1), at + 2);
            t.gap();
        } else {
            t.handle(start(n, 0, hash(n - 1, 0), 0), at + 2);
            t.handle(end(n, 0), at + 3);
        }
        if n % 13 != 0 {
            t.handle(fin(n, 0), at + 4);
        }
        t.tick(at + 5);
        for o in t.take() {
            match o {
                Output::Final(b) => reported.push(b.start.number),
                Output::Missing { number, .. } => reported.push(number),
                _ => {}
            }
        }
    }
    t.tick(at + 10 * WAIT);
    for o in t.take() {
        match o {
            Output::Final(b) => reported.push(b.start.number),
            Output::Missing { number, .. } => reported.push(number),
            _ => {}
        }
    }
    let expected: Vec<u64> = (1..=200).collect();
    assert_eq!(reported, expected);
    // Heights touched by the gap are the only missing ones; lost
    // finalizations were recovered from parent hashes.
    assert_eq!(t.stats().missing, (1..=200).filter(|n| n % 41 == 0).count() as u64);
}
