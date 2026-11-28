//! Trade attribution, ported from server/src/attribution.ts: turn a venue's
//! honest UNKNOWN into a provable label from what the transaction entered
//! through (`tx.to`):
//!
//!   the venue itself (an entry point without a router name) → DIRECT
//!   the venue's own periphery (an entry point with a name)  → ROUTER + name
//!   a known aggregator                                      → ROUTER + brand
//!   searcher-only MEV infrastructure                        → MEV + brand
//!   a known searcher operator wallet (tx.from), last resort → MEV + brand
//!   anything else                                           → stays UNKNOWN
//!
//! Only UNKNOWN trades are touched (a venue with richer, log-based labels
//! keeps them), and `to` becomes the transaction's initiator. Today's code
//! looks each transaction up over RPC and leaves a trade UNKNOWN when the
//! lookup fails; the final block carries every transaction header, so here
//! the lookup can't fail.

use std::collections::HashMap;

use mpamm_core::{FinalBlock, Venue};
use mpamm_ring::{hex, Addr};
use mpamm_types::{Fill, FillCategory};

pub struct Attributor {
    routers: HashMap<Addr, String>,
    mev: HashMap<Addr, String>,
    operators: HashMap<Addr, String>,
}

impl Default for Attributor {
    fn default() -> Self {
        // Today's tables, read from the file generated from them (mpamm-registry).
        let t = mpamm_registry::attribution::attribution();
        Self { routers: t.routers.clone(), mev: t.mev.clone(), operators: t.operators.clone() }
    }
}

/// venue id → (entry address → router name, `None` for the venue itself).
pub type Entries = HashMap<String, HashMap<Addr, Option<String>>>;

/// Every venue's entry points, under each venue id it reports.
pub fn entries(venues: &[std::sync::Arc<dyn Venue>]) -> Entries {
    let mut out = Entries::new();
    for v in venues {
        let m: HashMap<Addr, Option<String>> = v.entry_points().into_iter().map(|e| (e.address, e.router)).collect();
        for meta in v.meta() {
            out.insert(meta.id, m.clone());
        }
    }
    out
}

fn short_lower(a: &Addr) -> String {
    let h = format!("0x{}", hex(a));
    format!("{}…{}", &h[..6], &h[h.len() - 4..])
}

impl Attributor {
    /// Labels the block's UNKNOWN trades in place.
    pub fn attribute(&self, fills: &mut [Fill], block: &FinalBlock, entries: &Entries) {
        if !fills.iter().any(|f| f.category == FillCategory::Unknown) {
            return;
        }
        let by_hash: HashMap<String, (Option<Addr>, Addr)> =
            block.txns.iter().map(|t| (format!("0x{}", hex(&t.hash)), (t.to, t.from))).collect();
        for f in fills.iter_mut().filter(|f| f.category == FillCategory::Unknown) {
            let Some((to, from)) = by_hash.get(&f.tx_hash.to_ascii_lowercase()) else { continue };
            f.to = short_lower(from);
            let entry = to.and_then(|to| entries.get(&f.venue_id).and_then(|m| m.get(&to)));
            if let Some(router) = entry {
                match router {
                    None => f.category = FillCategory::Direct,
                    Some(name) => {
                        f.category = FillCategory::Router;
                        f.router = Some(name.clone());
                    }
                }
                continue;
            }
            if let Some(brand) = to.and_then(|to| self.routers.get(&to)) {
                f.category = FillCategory::Router;
                f.router = Some(brand.clone());
                continue;
            }
            if let Some(brand) = to.and_then(|to| self.mev.get(&to)) {
                f.category = FillCategory::Mev;
                f.router = Some(brand.clone());
                continue;
            }
            if let Some(brand) = self.operators.get(from) {
                f.category = FillCategory::Mev;
                f.router = Some(brand.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use mpamm_core::{FinalTxn, Origin};
    use mpamm_registry::parse_address;
    use mpamm_types::Side;

    use super::*;

    fn txn(i: u32, to: Option<&str>, from: &str) -> FinalTxn {
        FinalTxn {
            index: i,
            hash: [i as u8 + 1; 32],
            from: parse_address(from).unwrap(),
            to: to.map(|t| parse_address(t).unwrap()),
            kind: 2,
            gas_limit: 1,
            max_fee_per_gas: 1,
            max_priority_fee_per_gas: 0,
            input: vec![],
        }
    }

    fn fill(i: u32, cat: FillCategory) -> Fill {
        Fill {
            id: format!("v-{i}"),
            venue_id: "v".into(),
            market: "MON/USDC".into(),
            side: Side::Buy,
            category: cat,
            usd: 1.0,
            base_amount: 1.0,
            exec_px: 1.0,
            px_approx: false,
            tx_hash: format!("0x{}", hex(&[i as u8 + 1; 32])),
            to: "0xRecipient".into(),
            router: None,
            pool: "p".into(),
            block_number: 1,
            ts: 0.0,
            markouts_bps: vec![],
            time_source: None,
        }
    }

    #[test]
    fn labels_follow_todays_order_of_evidence() {
        let pool = "0x1111111111111111111111111111111111111111";
        let periphery = "0x2222222222222222222222222222222222222222";
        let user = "0xabcdef0000000000000000000000000000001234";
        let block = FinalBlock {
            number: 1,
            hash: [0; 32],
            parent_hash: [0; 32],
            timestamp: 0,
            proposal_ns: None,
            base_fee: 0,
            txns: vec![
                txn(0, Some(pool), user),
                txn(1, Some(periphery), user),
                txn(2, Some("0x6131b5fae19ea4f9d964eac0408e4408b66337b5"), user),
                txn(3, Some("0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58"), user),
                txn(
                    4,
                    Some("0x9999999999999999999999999999999999999999"),
                    "0x256efafed786d24163bedf15d583ea5dbdb4757c",
                ),
                txn(5, Some("0x9999999999999999999999999999999999999999"), user),
                txn(6, None, user),
            ],
            logs: vec![],
            origin: Origin::Ring,
        };
        let mut entries = Entries::new();
        entries.insert(
            "v".into(),
            HashMap::from([
                (parse_address(pool).unwrap(), None),
                (parse_address(periphery).unwrap(), Some("V Router".into())),
            ]),
        );
        let mut fills: Vec<Fill> = (0..7).map(|i| fill(i, FillCategory::Unknown)).collect();
        fills.push(fill(0, FillCategory::CexDex)); // evidence-based label: untouched
        Attributor::default().attribute(&mut fills, &block, &entries);
        let got: Vec<(FillCategory, Option<&str>)> = fills.iter().map(|f| (f.category, f.router.as_deref())).collect();
        assert_eq!(
            got,
            [
                (FillCategory::Direct, None),
                (FillCategory::Router, Some("V Router")),
                (FillCategory::Router, Some("KyberSwap")),
                (FillCategory::Mev, Some("FastLane")),
                (FillCategory::Mev, Some("Kubera")),
                (FillCategory::Unknown, None),
                (FillCategory::Unknown, None),
                (FillCategory::CexDex, None),
            ]
        );
        assert_eq!(fills[0].to, "0xabcd…1234", "the initiator, lower-case as today");
        assert_eq!(fills[7].to, "0xRecipient");
    }
}
