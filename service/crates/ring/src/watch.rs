//! What the reader copies out of the ring. Everything else is skipped without
//! an allocation: at 10k transactions a second the reader has about 10 µs per
//! event, so the filter runs on the payload head before any copy.

use std::collections::{HashMap, HashSet};

use crate::event::{Addr, B32};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopicFilter {
    /// Every log from the address.
    Any,
    /// Logs whose topic0 is in the set.
    Topics(HashSet<B32>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchSet {
    /// Logs to copy, by emitting address.
    pub logs: HashMap<Addr, TopicFilter>,
    /// Copy every log (capture tools and tests; never the live service).
    pub all_logs: bool,
    /// Copy every transaction's header (hash, sender, `to`, fees). Needed by
    /// anything that names a transaction: trade ids, gas, attribution.
    pub txn_headers: bool,
    /// Transactions whose calldata is copied too, by `to`.
    pub txn_input: HashSet<Addr>,
}

impl WatchSet {
    pub fn wants_log(&self, address: &Addr, topic0: Option<&B32>) -> bool {
        if self.all_logs {
            return true;
        }
        match self.logs.get(address) {
            None => false,
            Some(TopicFilter::Any) => true,
            Some(TopicFilter::Topics(set)) => topic0.is_some_and(|t| set.contains(t)),
        }
    }

    pub fn wants_input(&self, to: Option<&Addr>) -> bool {
        to.is_some_and(|a| self.txn_input.contains(a))
    }

    /// Adds `other` to this set. Discovery only ever grows the watch set: a
    /// failed read must never stop watching a market that exists.
    pub fn merge(&mut self, other: &WatchSet) {
        for (addr, filter) in &other.logs {
            match (self.logs.get_mut(addr), filter) {
                (None, f) => {
                    self.logs.insert(*addr, f.clone());
                }
                (Some(TopicFilter::Any), _) => {}
                (Some(slot), TopicFilter::Any) => *slot = TopicFilter::Any,
                (Some(TopicFilter::Topics(mine)), TopicFilter::Topics(theirs)) => mine.extend(theirs.iter().copied()),
            }
        }
        self.all_logs |= other.all_logs;
        self.txn_headers |= other.txn_headers;
        self.txn_input.extend(other.txn_input.iter().copied());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: Addr = [1; 20];
    const B: Addr = [2; 20];
    const T1: B32 = [10; 32];
    const T2: B32 = [11; 32];

    #[test]
    fn matches_by_address_and_topic0() {
        let mut w = WatchSet::default();
        w.logs.insert(A, TopicFilter::Topics([T1].into()));
        w.logs.insert(B, TopicFilter::Any);
        assert!(w.wants_log(&A, Some(&T1)));
        assert!(!w.wants_log(&A, Some(&T2)));
        assert!(!w.wants_log(&A, None));
        assert!(w.wants_log(&B, None));
        assert!(w.wants_log(&B, Some(&T2)));
        assert!(!w.wants_log(&[3; 20], Some(&T1)));
    }

    #[test]
    fn merge_only_grows() {
        let mut w = WatchSet::default();
        w.logs.insert(A, TopicFilter::Topics([T1].into()));
        let mut other = WatchSet::default();
        other.logs.insert(A, TopicFilter::Topics([T2].into()));
        other.logs.insert(B, TopicFilter::Topics([T1].into()));
        other.txn_headers = true;
        other.txn_input.insert(B);
        w.merge(&other);
        assert!(w.wants_log(&A, Some(&T1)) && w.wants_log(&A, Some(&T2)));
        assert!(w.wants_log(&B, Some(&T1)));
        assert!(w.txn_headers && w.wants_input(Some(&B)));

        // An empty set merged in removes nothing, and Any is never narrowed.
        let mut any = WatchSet::default();
        any.logs.insert(A, TopicFilter::Any);
        w.merge(&any);
        w.merge(&other);
        w.merge(&WatchSet::default());
        assert_eq!(w.logs.get(&A), Some(&TopicFilter::Any));
        assert!(w.txn_headers);
    }
}
