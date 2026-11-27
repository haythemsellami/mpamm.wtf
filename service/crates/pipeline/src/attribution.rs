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
use mpamm_registry::parse_address;
use mpamm_ring::{hex, Addr};
use mpamm_types::{Fill, FillCategory};

/// Known aggregator and router entry contracts → brand (attribution.ts
/// KNOWN_ROUTERS, with its provenance notes).
pub const KNOWN_ROUTERS: &[(&str, &str)] = &[
    ("0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", "Relay"),
    ("0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", "Relay"),
    ("0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "KyberSwap"),
    ("0x0000000000001ff3684f28c67538d4d072c22734", "0x"),
    ("0x18556da13313f3532c54711497a8fedac273220e", "LFJ"),
    ("0x4face5b0ef2757ceb9151d14c036a1135931c70e", "LFJ"),
    ("0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "ERC-4337"),
    ("0x0000000071727de22e5e9d8baf0edac6f37da032", "ERC-4337"),
    ("0x97caca78ac2a94c67643d07843f85afaa44a3ea5", "Bungee"),
    ("0xbd267094d3b410b33f49e8f6ba8b106672746490", "Moose Trade"),
    ("0xd1b844a2443704bcb2f737a7434513437438b65e", "Moose Trade"),
];

/// Searcher-only MEV infrastructure → brand (KNOWN_MEV).
pub const KNOWN_MEV: &[(&str, &str)] = &[
    ("0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58", "FastLane"),
    ("0x415669455d93b755efe7f20ef6f1dbdce7f68f7d", "Kubera"),
    ("0x553037bac82741e7ca05afb48e8538996fd70eca", "Searcher 0x5530"),
    ("0x2ee25bbbd6795f058876eb206c98f8a55b149d14", "Searcher 0x2ee2"),
    ("0x53d7071e15121fd2f81958fa2899f6a0f66261fb", "Searcher 0x53d7"),
];

/// Searcher operator wallets → brand, matched on tx.from only when tx.to
/// matched nothing (KNOWN_MEV_OPERATORS).
pub const KNOWN_MEV_OPERATORS: &[(&str, &str)] = &[
    ("0x256efafed786d24163bedf15d583ea5dbdb4757c", "Kubera"),
    ("0x22c6a8b73641e9a1e8066a01c71c388e52230659", "Searcher 0x5530"),
    ("0x8f1661673adb1b4524ee3436d2cb66e2ff0b6845", "Searcher 0x5530"),
    ("0x66cbc7e161c4683e48decd13ee1f4495ea848e18", "Searcher 0x5530"),
    ("0x62fd55d9d8bb20f19984b56bfec4f49a5c20f1ab", "Searcher 0x5530"),
    ("0x000e4334baea5ed508919eb74845f8557e942ccc", "Searcher 0x2ee2"),
    ("0x826e1446245a0ab5b24888b407dfeb47a4d5749d", "Searcher 0x53d7"),
];

fn table(rows: &[(&str, &str)]) -> HashMap<Addr, String> {
    rows.iter().map(|(a, b)| (parse_address(a).expect("valid address"), b.to_string())).collect()
}

pub struct Attributor {
    routers: HashMap<Addr, String>,
    mev: HashMap<Addr, String>,
    operators: HashMap<Addr, String>,
}

impl Default for Attributor {
    fn default() -> Self {
        Self { routers: table(KNOWN_ROUTERS), mev: table(KNOWN_MEV), operators: table(KNOWN_MEV_OPERATORS) }
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
