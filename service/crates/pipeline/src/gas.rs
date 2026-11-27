//! Exact quote-update gas (docs/rebuild-spec.md → Exact gas): every
//! transaction of a final block that a venue's gas rules claim is costed at
//! gas limit × price paid (Monad charges the limit, reverted transactions
//! included) and added to that venue's day in the block's own commit.
//! Today's tracker sampled receipts and scaled by a stride; here every
//! transaction is seen.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use mpamm_core::{FinalBlock, Venue, VenueError};
use mpamm_ring::{Addr, B32};
use mpamm_store::GasAccrual;

struct Relay {
    to: Addr,
    selector: [u8; 4],
    word: usize,
    targets: HashSet<Addr>,
    venue: String,
}

/// Which transactions belong to which venue's quoting.
#[derive(Default)]
pub struct GasRules {
    by_dest: HashMap<Addr, String>,
    relays: Vec<Relay>,
    by_log: HashMap<(Addr, B32), String>,
    /// Venues skipped because a destination was already claimed.
    pub conflicts: Vec<String>,
}

impl GasRules {
    /// Every venue's rules. A venue not ready yet holds (its gas would be
    /// undercounted); a venue claiming a destination another already owns
    /// is skipped and reported, as today.
    pub fn of(venues: &[Arc<dyn Venue>]) -> Result<Self, VenueError> {
        let mut r = Self::default();
        for v in venues {
            let Some(g) = v.gas_sources()? else { continue };
            let id = v.meta().first().map(|m| m.id.clone()).unwrap_or_else(|| v.id().to_string());
            if g.destinations.iter().any(|d| r.by_dest.get(d).is_some_and(|owner| owner != &id)) {
                tracing::warn!(target: "gas", "{id}: a gas destination is already tracked by another venue; skipped");
                r.conflicts.push(id);
                continue;
            }
            for d in &g.destinations {
                r.by_dest.insert(*d, id.clone());
            }
            let targets: HashSet<Addr> = g.destinations.iter().copied().collect();
            for rel in g.relays {
                r.relays.push(Relay {
                    to: rel.address,
                    selector: rel.selector,
                    word: rel.target_word,
                    targets: targets.clone(),
                    venue: id.clone(),
                });
            }
            for (addr, topic0) in g.logs {
                r.by_log.insert((addr, topic0), id.clone());
            }
        }
        Ok(r)
    }

    /// Whose quote update this transaction is through a relay: `to` is the
    /// relay, calldata opens with its selector, and head word `word` is a
    /// clean address (upper 12 bytes zero) among the relay's targets.
    fn relayed(&self, to: &Addr, input: &[u8]) -> Option<&str> {
        for r in &self.relays {
            if &r.to != to || input.len() < 4 || input[..4] != r.selector {
                continue;
            }
            let at = 4 + 32 * r.word;
            let Some(w) = input.get(at..at + 32) else { continue };
            if w[..12].iter().all(|b| *b == 0) {
                let a: Addr = w[12..].try_into().unwrap();
                if r.targets.contains(&a) {
                    return Some(&r.venue);
                }
            }
        }
        None
    }

    /// Each venue's quote-update gas in the block. A transaction counts once.
    pub fn accrue(&self, block: &FinalBlock) -> Vec<GasAccrual> {
        if self.by_dest.is_empty() && self.relays.is_empty() && self.by_log.is_empty() {
            return Vec::new();
        }
        let mut by_txn_log: HashMap<u32, &str> = HashMap::new();
        for l in &block.logs {
            if let Some(t0) = l.topic0() {
                if let Some(v) = self.by_log.get(&(l.address, *t0)) {
                    by_txn_log.entry(l.txn_index).or_insert(v);
                }
            }
        }
        let mut acc: Vec<GasAccrual> = Vec::new();
        for t in &block.txns {
            let venue =
                t.to.and_then(|to| self.by_dest.get(&to).map(String::as_str).or_else(|| self.relayed(&to, &t.input)))
                    .or_else(|| by_txn_log.get(&t.index).copied());
            let Some(venue) = venue else { continue };
            let mon = t.cost_wei(block.base_fee) as f64 / 1e18;
            match acc.iter_mut().find(|a| a.venue_id == venue) {
                Some(a) => {
                    a.mon += mon;
                    a.txs += 1;
                }
                None => acc.push(GasAccrual { venue_id: venue.to_string(), mon, txs: 1 }),
            }
        }
        acc
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mpamm_core::{ChainCx, DecodeCx, FinalLog, FinalTxn, GasRelay, GasSources, Origin};
    use mpamm_ring::WatchSet;
    use mpamm_types::{Fill, ThemeColor, VenueKind, VenueMeta, VenueRole};

    use super::*;

    struct V(&'static str, GasSources);

    #[async_trait]
    impl Venue for V {
        fn id(&self) -> &str {
            self.0
        }
        fn meta(&self) -> Vec<VenueMeta> {
            vec![VenueMeta {
                id: self.0.into(),
                name: self.0.into(),
                color: ThemeColor { light: "#000".into(), dark: "#fff".into() },
                kind: VenueKind::Amm,
                role: VenueRole::Venue,
                taker: None,
                taker_bps: None,
                since_utc: None,
                quote_note: None,
            }]
        }
        async fn discover(&self, _: &ChainCx<'_>) -> Result<(), VenueError> {
            Ok(())
        }
        fn watch(&self) -> Result<WatchSet, VenueError> {
            Ok(WatchSet::default())
        }
        fn decode(&self, _: &DecodeCx<'_>, _: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
            Ok(vec![])
        }
        fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
            Ok(Some(self.1.clone()))
        }
    }

    fn txn(i: u32, to: Addr, kind: u8, input: Vec<u8>) -> FinalTxn {
        FinalTxn {
            index: i,
            hash: [i as u8; 32],
            from: [9; 20],
            to: Some(to),
            kind,
            gas_limit: 100_000,
            max_fee_per_gas: 200_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
            input,
        }
    }

    #[test]
    fn destinations_relays_and_emitted_logs_each_count_once() {
        let (oracle, relay, keeper_target, emitter) = ([1u8; 20], [2u8; 20], [3u8; 20], [4u8; 20]);
        let topic: B32 = [7; 32];
        let a = V("a", GasSources { destinations: vec![oracle], ..GasSources::default() });
        let b = V(
            "b",
            GasSources {
                destinations: vec![keeper_target],
                relays: vec![GasRelay { address: relay, selector: [0xaa, 0xbb, 0xcc, 0xdd], target_word: 1 }],
                logs: vec![(emitter, topic)],
            },
        );
        let venues: Vec<Arc<dyn Venue>> = vec![Arc::new(a), Arc::new(b)];
        let rules = GasRules::of(&venues).unwrap();
        let mut relayed = vec![0xaa, 0xbb, 0xcc, 0xdd];
        relayed.extend([0u8; 32]);
        relayed.extend([0u8; 12]);
        relayed.extend(keeper_target);
        let mut dirty = relayed.clone();
        dirty[4 + 32] = 1; // upper bytes not clean: not an address
        let block = FinalBlock {
            number: 1,
            hash: [0; 32],
            parent_hash: [0; 32],
            timestamp: 0,
            proposal_ns: None,
            base_fee: 100_000_000_000,
            txns: vec![
                txn(0, oracle, 2, vec![]),
                txn(1, oracle, 0, vec![]),
                txn(2, relay, 2, relayed),
                txn(3, relay, 2, dirty),
                txn(4, [5; 20], 2, vec![]),
                txn(5, keeper_target, 2, vec![]),
            ],
            logs: vec![
                FinalLog {
                    log_index: 0,
                    txn_index: 4,
                    tx_hash: [4; 32],
                    address: emitter,
                    topics: vec![topic],
                    data: vec![],
                },
                // tx 5 matches both a destination and an emitted log: once.
                FinalLog {
                    log_index: 1,
                    txn_index: 5,
                    tx_hash: [5; 32],
                    address: emitter,
                    topics: vec![topic],
                    data: vec![],
                },
            ],
            origin: Origin::Ring,
        };
        let acc = rules.accrue(&block);
        let get = |v: &str| acc.iter().find(|a| a.venue_id == v).unwrap();
        // EIP-1559 pays min(cap, base + tip) = 101 gwei; legacy pays its gasPrice (200 gwei).
        let eip1559 = 100_000.0 * 101e9 / 1e18;
        let legacy = 100_000.0 * 200e9 / 1e18;
        assert_eq!(get("a").txs, 2);
        assert!((get("a").mon - (eip1559 + legacy)).abs() < 1e-15);
        assert_eq!(get("b").txs, 3, "relayed, log-emitting and direct; the dirty relay call doesn't count");
        assert!((get("b").mon - 3.0 * eip1559).abs() < 1e-15);
    }

    #[test]
    fn a_claimed_destination_skips_the_second_venue() {
        let a = V("a", GasSources { destinations: vec![[1; 20]], ..GasSources::default() });
        let b = V("b", GasSources { destinations: vec![[1; 20]], ..GasSources::default() });
        let venues: Vec<Arc<dyn Venue>> = vec![Arc::new(a), Arc::new(b)];
        let rules = GasRules::of(&venues).unwrap();
        assert_eq!(rules.conflicts, ["b"]);
    }
}
