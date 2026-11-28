//! Today's attribution tables (server/src/attribution.ts: KNOWN_ROUTERS,
//! KNOWN_MEV, KNOWN_MEV_OPERATORS), read from `attribution.json`, which
//! `npm -w server run attribution:golden` writes from them: one source of
//! truth until the switch-over (a server test fails while the file is
//! stale). Addresses are lower-case hex.

use std::{collections::HashMap, sync::OnceLock};

use serde::Deserialize;

use crate::parse_address;

pub const ATTRIBUTION_JSON: &str = include_str!("../attribution.json");

#[derive(Deserialize)]
struct File {
    routers: Vec<(String, String)>,
    mev: Vec<(String, String)>,
    operators: Vec<(String, String)>,
}

pub struct Attribution {
    /// Aggregator and router entry contracts → brand.
    pub routers: HashMap<[u8; 20], String>,
    /// Searcher-only MEV infrastructure → brand.
    pub mev: HashMap<[u8; 20], String>,
    /// Searcher operator wallets (matched on tx.from) → brand.
    pub operators: HashMap<[u8; 20], String>,
}

fn table(rows: &[(String, String)]) -> HashMap<[u8; 20], String> {
    rows.iter().map(|(a, b)| (parse_address(a).expect("attribution.json: an address"), b.clone())).collect()
}

/// The tables, parsed once.
pub fn attribution() -> &'static Attribution {
    static A: OnceLock<Attribution> = OnceLock::new();
    A.get_or_init(|| {
        let f: File = serde_json::from_str(ATTRIBUTION_JSON).expect("attribution.json parses");
        Attribution { routers: table(&f.routers), mev: table(&f.mev), operators: table(&f.operators) }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tables_load_with_todays_brands() {
        let a = attribution();
        let kyber = parse_address("0x6131b5fae19ea4f9d964eac0408e4408b66337b5").unwrap();
        assert_eq!(a.routers[&kyber], "KyberSwap");
        let fastlane = parse_address("0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58").unwrap();
        assert_eq!(a.mev[&fastlane], "FastLane");
        assert!(a.routers.len() >= 90 && a.mev.len() >= 30 && !a.operators.is_empty());
    }
}
