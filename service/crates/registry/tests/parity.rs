//! The Rust lookups answer exactly as shared/src/index.ts does: `golden.json`
//! holds today's TypeScript answers for every base × quote, every token
//! address, every pair's basis and every asset's exchange.

use mpamm_registry::Registry;
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden.json")).unwrap()
}

fn s(v: &Value) -> Option<&str> {
    v.as_str()
}

#[test]
fn pair_for_matches_typescript() {
    let r = Registry::get();
    for row in golden()["pairFor"].as_array().unwrap() {
        let got = r.pair_for(row[0].as_str().unwrap(), row[1].as_str().unwrap()).map(|p| p.symbol.as_str());
        assert_eq!(got, s(&row[2]), "pairFor({}, {})", row[0], row[1]);
    }
}

#[test]
fn asset_for_token_matches_typescript() {
    let r = Registry::get();
    for row in golden()["assetForToken"].as_array().unwrap() {
        let got = r.asset_for_token(row[0].as_str().unwrap()).map(|a| a.key.as_str());
        assert_eq!(got, s(&row[1]), "assetForToken({})", row[0]);
    }
}

#[test]
fn wrap_basis_cex_base_token_and_mon_match_typescript() {
    let r = Registry::get();
    let g = golden();
    for row in g["wrapBasisFor"].as_array().unwrap() {
        let pair = r.pair_of(row[0].as_str().unwrap()).unwrap();
        assert_eq!(r.wrap_basis_for(pair), s(&row[1]), "wrapBasisFor({})", row[0]);
    }
    for row in g["cexForBase"].as_array().unwrap() {
        assert_eq!(Some(r.cex_for_base(row[0].as_str().unwrap()).id()), s(&row[1]), "cexForBase({})", row[0]);
    }
    for row in g["baseTokenOf"].as_array().unwrap() {
        assert_eq!(r.base_token_of(row[0].as_str().unwrap()).map(|t| t.symbol.as_str()), s(&row[1]));
    }
    for row in g["isMonAddress"].as_array().unwrap() {
        assert_eq!(r.is_mon_address(row[0].as_str().unwrap()), row[1].as_bool().unwrap(), "isMonAddress({})", row[0]);
    }
}
