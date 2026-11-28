//! Block assembly and commit states, from the reader's own events.
//!
//! The tracker turns the ring's interleaved stream into two things the rest of
//! the service acts on:
//!
//! - `Executed` at `BLOCK_END`, for every proposal: the quote engine's trigger.
//! - `Final` or `Missing`, strictly in block-number order, exactly once per
//!   height from the starting height on. `Final` carries the winning proposal's
//!   data as the ring delivered it; `Missing` means the ring cannot be trusted
//!   for that height (a gap, an expired payload, a record error, an absent
//!   receipt) and the caller must read it over RPC before committing anything
//!   above it. Nothing speculative ever reaches `Final`.
//!
//! Monad never announces a losing proposal: another id finalizing at the same
//! height is the only signal, so the losers come out as `Abandoned` then.
//! A lost `BLOCK_FINALIZED` (its event fell in a gap) is recovered from the
//! next final block's parent hash when every link is in memory; otherwise the
//! height is `Missing`. The ring's order is relied on, not its timing: if a
//! finalization arrives before its block finished executing, the tracker
//! waits for `BLOCK_END` up to `finalize_wait_ns`.

use std::collections::{BTreeMap, HashMap};

use crate::event::{BlockStart, Event, Log, TxnHeader, TxnOutput, B32};

#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// How long a finalized height may wait for its block to arrive and
    /// finish executing before it is reported `Missing`.
    pub finalize_wait_ns: u64,
    /// Every executed transaction must have its header (set when the watch set
    /// copies headers: trade ids and gas need the transaction hash and `to`).
    pub require_headers: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { finalize_wait_ns: 2_000_000_000, require_headers: false }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Txn {
    pub header: Option<TxnHeader>,
    pub output: Option<TxnOutput>,
    pub rejected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockEnd {
    pub hash: B32,
    pub gas_used: u64,
    pub end_ns: u64,
}

/// One proposal as assembled from the ring. Times are this host's record
/// times (ns since 1970); `start.proposal_ns` is the proposer's clock.
#[derive(Debug, Clone)]
pub struct Block {
    pub start: BlockStart,
    pub start_ns: u64,
    pub end: Option<BlockEnd>,
    pub qc_ns: Option<u64>,
    pub finalized_ns: Option<u64>,
    pub rejected: bool,
    /// Events were lost while it executed: never commit it from the ring.
    pub incomplete: bool,
    pub txns: Vec<Txn>,
    /// Watched logs, in block order once the block has ended.
    pub logs: Vec<Log>,
    /// Block-level index (RPC `logIndex`) of each entry of `logs`.
    pub log_index: Vec<u32>,
    /// Logs emitted by the whole block, watched or not.
    pub log_count: u64,
}

impl Block {
    fn new(start: BlockStart, start_ns: u64) -> Self {
        let txns = vec![Txn::default(); start.txn_count as usize];
        Self {
            start,
            start_ns,
            end: None,
            qc_ns: None,
            finalized_ns: None,
            rejected: false,
            incomplete: false,
            txns,
            logs: Vec::new(),
            log_index: Vec::new(),
            log_count: 0,
        }
    }

    pub fn is_complete(&self) -> bool {
        self.end.is_some() && !self.incomplete && !self.rejected
    }

    /// Checks that every receipt (and header, if required) arrived, then
    /// sorts the watched logs into block order and gives each its block-level
    /// index: the log counts of every earlier transaction plus its index
    /// within its own. A rejected transaction emits no logs.
    fn seal(&mut self, require_headers: bool) {
        let mut offsets = Vec::with_capacity(self.txns.len());
        let mut total: u64 = 0;
        for t in &self.txns {
            offsets.push(total);
            match (&t.output, t.rejected) {
                (_, true) => {}
                (Some(o), false) => total += u64::from(o.log_count),
                (None, false) => self.incomplete = true,
            }
            if require_headers && !t.rejected && t.header.is_none() {
                self.incomplete = true;
            }
        }
        self.log_count = total;
        self.logs.sort_by_key(|l| (l.txn_index, l.index_in_txn));
        self.log_index.clear();
        for l in &self.logs {
            let t = &self.txns[l.txn_index as usize];
            let count = t.output.map_or(0, |o| o.log_count);
            if t.rejected || l.index_in_txn >= count || (require_headers && t.header.is_none()) {
                self.incomplete = true;
            }
            let at = offsets[l.txn_index as usize] + u64::from(l.index_in_txn);
            self.log_index.push(u32::try_from(at).unwrap_or(u32::MAX));
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingReason {
    /// The winning proposal was touched by a gap, a record error or an absent
    /// receipt.
    Incomplete,
    /// The height finalized but its block never arrived (or never finished)
    /// within `finalize_wait_ns`.
    Timeout,
    /// The height's finalization event was lost and the parent-hash chain
    /// could not name its block.
    Unresolved,
    /// A later height reached the pipeline first (two producers: the ring
    /// and fallback mode): this one is read over RPC before it.
    Gap,
    /// Fallback mode: the local node is down, every final height is read
    /// over RPC.
    Fallback,
}

#[derive(Debug, Clone)]
pub enum Output {
    /// A proposal finished executing (Proposed state).
    Executed {
        id: B32,
        number: u64,
        hash: B32,
        proposal_ns: u128,
        start_ns: u64,
        end_ns: u64,
        complete: bool,
    },
    Voted {
        id: B32,
        number: u64,
        t_ns: u64,
    },
    /// The winning proposal at `next_final`, complete.
    Final(Box<Block>),
    /// `number` is final but the ring's copy can't be used: read it over RPC.
    Missing {
        number: u64,
        reason: MissingReason,
    },
    /// A proposal that lost at its height.
    Abandoned(Box<Block>),
    Verified {
        number: u64,
        t_ns: u64,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub events: u64,
    pub gaps: u64,
    pub record_errors: u64,
    pub finals: u64,
    pub missing: u64,
    pub abandoned: u64,
    /// Proposals discarded at a `Missing` height (which one won is unknown).
    pub dropped: u64,
}

#[derive(Debug, Clone, Copy)]
struct Pending {
    id: B32,
    at: u64,
}

enum Resolve {
    Resolved,
    Wait,
    Missing,
}

pub struct Tracker {
    cfg: Config,
    blocks: HashMap<B32, Block>,
    by_number: BTreeMap<u64, Vec<B32>>,
    current: Option<B32>,
    /// The next height to report. `None` until the first `BLOCK_START` when
    /// starting fresh; the resume height otherwise.
    next_final: Option<u64>,
    /// Finalization events not yet reported, by height.
    final_ids: BTreeMap<u64, Pending>,
    out: Vec<Output>,
    stats: Stats,
}

impl Tracker {
    /// `resume_at`: the first height to report (the last committed one + 1).
    /// Without it, reporting starts at the first `BLOCK_START` seen.
    pub fn new(cfg: Config, resume_at: Option<u64>) -> Self {
        Self {
            cfg,
            blocks: HashMap::new(),
            by_number: BTreeMap::new(),
            current: None,
            next_final: resume_at,
            final_ids: BTreeMap::new(),
            out: Vec::new(),
            stats: Stats::default(),
        }
    }

    pub fn next_final(&self) -> Option<u64> {
        self.next_final
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// Proposals held in memory (executing, or waiting for their height to finalize).
    pub fn held(&self) -> usize {
        self.blocks.len()
    }

    /// Outputs produced since the last call, in order.
    pub fn take(&mut self) -> Vec<Output> {
        std::mem::take(&mut self.out)
    }

    /// The reader lost events (sequence gap or expired payload). Whatever was
    /// executing is incomplete; events until the next `BLOCK_START` belong to
    /// a block whose start was lost and are ignored.
    pub fn gap(&mut self) {
        self.stats.gaps += 1;
        if let Some(b) = self.current.take().and_then(|id| self.blocks.get_mut(&id)) {
            b.incomplete = true;
        }
    }

    /// Advances time-based decisions (`finalize_wait_ns`) when no event arrives.
    pub fn tick(&mut self, now_ns: u64) {
        self.advance(now_ns);
    }

    pub fn handle(&mut self, ev: Event, t: u64) {
        self.stats.events += 1;
        match ev {
            Event::BlockStart(s) => self.on_start(*s, t),
            Event::BlockReject => {
                if let Some(b) = self.current.take().and_then(|id| self.blocks.get_mut(&id)) {
                    b.rejected = true;
                }
            }
            Event::TxnHeader(h) => {
                if let Some(b) = self.current_mut() {
                    match b.txns.get_mut(h.index as usize) {
                        Some(t) => t.header = Some(*h),
                        None => b.incomplete = true,
                    }
                }
            }
            Event::TxnReject { index } => {
                if let Some(b) = self.current_mut() {
                    match b.txns.get_mut(index as usize) {
                        Some(t) => t.rejected = true,
                        None => b.incomplete = true,
                    }
                }
            }
            Event::TxnOutput(o) => {
                if let Some(b) = self.current_mut() {
                    match b.txns.get_mut(o.index as usize) {
                        Some(t) => t.output = Some(o),
                        None => b.incomplete = true,
                    }
                }
            }
            Event::Log(l) => {
                if let Some(b) = self.current_mut() {
                    if (l.txn_index as usize) < b.txns.len() {
                        b.logs.push(*l);
                    } else {
                        b.incomplete = true;
                    }
                }
            }
            Event::BlockEnd { hash, gas_used } => {
                let require_headers = self.cfg.require_headers;
                if let Some(b) = self.current.take().and_then(|id| self.blocks.get_mut(&id)) {
                    b.end = Some(BlockEnd { hash, gas_used, end_ns: t });
                    b.seal(require_headers);
                    self.out.push(Output::Executed {
                        id: b.start.id,
                        number: b.start.number,
                        hash,
                        proposal_ns: b.start.proposal_ns,
                        start_ns: b.start_ns,
                        end_ns: t,
                        complete: b.is_complete(),
                    });
                }
                self.advance(t);
            }
            Event::Qc { id, number } => {
                if let Some(b) = self.blocks.get_mut(&id) {
                    b.qc_ns.get_or_insert(t);
                }
                self.out.push(Output::Voted { id, number, t_ns: t });
            }
            Event::Finalized { id, number } => {
                if let Some(b) = self.blocks.get_mut(&id) {
                    b.finalized_ns.get_or_insert(t);
                }
                if self.next_final.is_some_and(|nf| number >= nf) {
                    self.final_ids.entry(number).or_insert(Pending { id, at: t });
                }
                self.advance(t);
            }
            Event::Verified { number } => self.out.push(Output::Verified { number, t_ns: t }),
            Event::RecordError => {
                self.stats.record_errors += 1;
                if let Some(b) = self.current_mut() {
                    b.incomplete = true;
                }
            }
        }
    }

    fn current_mut(&mut self) -> Option<&mut Block> {
        self.current.and_then(|id| self.blocks.get_mut(&id))
    }

    fn on_start(&mut self, s: BlockStart, t: u64) {
        // A block that never reached BLOCK_END or BLOCK_REJECT lost its tail.
        if let Some(b) = self.current.take().and_then(|id| self.blocks.get_mut(&id)) {
            b.incomplete = true;
        }
        match self.next_final {
            None => self.next_final = Some(s.number),
            Some(nf) if s.number < nf => return,
            Some(_) => {}
        }
        let (id, number) = (s.id, s.number);
        if self.blocks.insert(id, Block::new(s, t)).is_none() {
            self.by_number.entry(number).or_default().push(id);
        }
        self.current = Some(id);
    }

    fn advance(&mut self, now: u64) {
        while let Some(n) = self.next_final {
            if let Some(p) = self.final_ids.get(&n).copied() {
                match self.blocks.get(&p.id) {
                    Some(b) if b.is_complete() => self.emit_final(n, p.id),
                    Some(b) if b.incomplete || b.rejected => self.emit_missing(n, MissingReason::Incomplete),
                    _ if now >= p.at.saturating_add(self.cfg.finalize_wait_ns) => {
                        self.emit_missing(n, MissingReason::Timeout)
                    }
                    _ => break,
                }
            } else if self.final_ids.range(n + 1..).next().is_some() {
                match self.resolve_lost(n, now) {
                    Resolve::Resolved => continue,
                    Resolve::Wait => break,
                    Resolve::Missing => self.emit_missing(n, MissingReason::Unresolved),
                }
            } else {
                break;
            }
        }
    }

    /// Height `n` has no finalization event but a higher one does, so `n`'s
    /// was lost (or preceded the reader's start). Walk parent hashes down from
    /// the lowest finalized block above `n`.
    fn resolve_lost(&mut self, n: u64, now: u64) -> Resolve {
        let (m, top) = match self.final_ids.range(n + 1..).next() {
            Some((m, p)) => (*m, *p),
            None => return Resolve::Wait,
        };
        let deadline_passed = now >= top.at.saturating_add(self.cfg.finalize_wait_ns);
        let Some(mut parent) = self.blocks.get(&top.id).map(|b| b.start.parent_hash) else {
            return if deadline_passed { Resolve::Missing } else { Resolve::Wait };
        };
        let mut found = Vec::new();
        for k in (n..m).rev() {
            let hit = self.by_number.get(&k).and_then(|ids| {
                ids.iter().copied().find(|id| self.blocks.get(id).and_then(|b| b.end).is_some_and(|e| e.hash == parent))
            });
            match hit {
                Some(id) => {
                    found.push((k, id));
                    parent = self.blocks[&id].start.parent_hash;
                }
                None => break,
            }
        }
        for (k, id) in found {
            self.final_ids.entry(k).or_insert(Pending { id, at: top.at });
        }
        if self.final_ids.contains_key(&n) {
            Resolve::Resolved
        } else if deadline_passed {
            Resolve::Missing
        } else {
            Resolve::Wait
        }
    }

    fn emit_final(&mut self, n: u64, id: B32) {
        for other in self.by_number.remove(&n).unwrap_or_default() {
            if other != id {
                if let Some(b) = self.blocks.remove(&other) {
                    self.stats.abandoned += 1;
                    self.out.push(Output::Abandoned(Box::new(b)));
                }
            }
        }
        if let Some(b) = self.blocks.remove(&id) {
            self.stats.finals += 1;
            self.out.push(Output::Final(Box::new(b)));
        }
        self.finish_height(n);
    }

    fn emit_missing(&mut self, n: u64, reason: MissingReason) {
        for id in self.by_number.remove(&n).unwrap_or_default() {
            if self.blocks.remove(&id).is_some() {
                self.stats.dropped += 1;
            }
        }
        self.stats.missing += 1;
        self.out.push(Output::Missing { number: n, reason });
        self.finish_height(n);
    }

    /// Moves past height `n`; proposals still held below it lost.
    fn finish_height(&mut self, n: u64) {
        self.final_ids.remove(&n);
        self.next_final = Some(n + 1);
        let stale: Vec<u64> = self.by_number.range(..=n).map(|(k, _)| *k).collect();
        for k in stale {
            for id in self.by_number.remove(&k).unwrap_or_default() {
                if let Some(b) = self.blocks.remove(&id) {
                    self.stats.abandoned += 1;
                    self.out.push(Output::Abandoned(Box::new(b)));
                }
            }
        }
        if self.current.is_some_and(|id| !self.blocks.contains_key(&id)) {
            self.current = None;
        }
        self.final_ids = self.final_ids.split_off(&(n + 1));
    }
}

#[cfg(test)]
mod tests;
