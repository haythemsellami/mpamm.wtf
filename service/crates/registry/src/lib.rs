//! The market registry: tokens, base assets and tracked pairs, from
//! `shared/registry.json`, the same file today's TypeScript server and web
//! read. Compiled in, so a build and its registry can't diverge.
//!
//! The helpers answer exactly as `shared/src/index.ts` does (checked against
//! its recorded answers in `tests/golden.json`): `pair_for` returns the first
//! matching pair, so the canonical token's pair wins; `asset_for_token` maps
//! native MON and WMON to MON, then canonical wrappers, then alternative
//! wrappers (`base_asset`).

pub mod attribution;

use std::{collections::HashSet, sync::OnceLock};

use indexmap::IndexMap;
use serde::Deserialize;

pub const REGISTRY_JSON: &str = include_str!("../../../../shared/registry.json");

/// Which exchange benchmarks a base asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cex {
    Bybit,
    Binance,
    Kraken,
}

impl Cex {
    pub fn id(self) -> &'static str {
        match self {
            Cex::Bybit => "bybit",
            Cex::Binance => "binance",
            Cex::Kraken => "kraken",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Token {
    pub symbol: String,
    /// As written in the registry (checksummed where it matters to viem);
    /// compare with `address_bytes` or case-insensitively.
    pub address: String,
    pub decimals: u8,
    /// A USD stablecoin, valued at $1.
    pub stable: bool,
    /// Exchange `<STABLE>USDT` cross converting a USDT reference into this stable.
    pub usdt_cross: Option<String>,
    /// Kraken USD cross for USD-quoted xStock references.
    pub usd_cross: Option<String>,
    /// The base asset this token represents when it isn't the canonical wrapper.
    pub base_asset: Option<String>,
    /// The rebasing xStock an ERC-4626 share holds.
    pub underlying_x_stock: Option<String>,
}

impl Token {
    pub fn address_bytes(&self) -> [u8; 20] {
        parse_address(&self.address).expect("validated")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub key: String,
    pub symbol: String,
    /// Key in `tokens` of its canonical on-chain wrapper.
    pub token: String,
    pub cex: Cex,
    pub cex_symbol: String,
    /// Wrapped/native basis symbol (Binance) when the on-chain token is a
    /// wrapper whose price differs from the native asset.
    pub wrap_basis_symbol: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuoteKind {
    Asset,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pair {
    /// The market symbol, `Fill.market` / `QuoteRow.market`.
    pub symbol: String,
    /// Base asset key.
    pub base: String,
    /// A stable token key, or an asset key when `quote_kind` is `Asset`.
    pub quote: String,
    pub quote_kind: Option<QuoteKind>,
    /// `Some("")` = parity (no basis); `None` = inherit the base asset's.
    pub wrap_basis_override: Option<String>,
    /// Wrapper basis on an asset quote leg (e.g. WBTCBTC).
    pub quote_wrap_basis_symbol: Option<String>,
}

impl Pair {
    pub fn is_asset_quoted(&self) -> bool {
        self.quote_kind == Some(QuoteKind::Asset)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(rename = "$comment", default)]
    _comment: String,
    pub chain_id: u64,
    pub native_mon: String,
    pub wmon: String,
    pub sizes_usd: Vec<f64>,
    pub markout_horizons_s: Vec<u32>,
    pub tokens: IndexMap<String, Token>,
    pub assets: IndexMap<String, Asset>,
    pub pairs: Vec<Pair>,
}

/// `0x` + 40 hex digits, any case.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    if h.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, c) in h.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(c).ok()?, 16).ok()?;
    }
    Some(out)
}

impl Registry {
    pub fn parse(json: &str) -> Result<Self, String> {
        let r: Registry = serde_json::from_str(json).map_err(|e| format!("registry: {e}"))?;
        r.validate()?;
        Ok(r)
    }

    /// The registry compiled into this build.
    pub fn get() -> &'static Registry {
        static R: OnceLock<Registry> = OnceLock::new();
        R.get_or_init(|| Registry::parse(REGISTRY_JSON).expect("shared/registry.json is valid"))
    }

    /// Every reference the rest of the code relies on resolves.
    pub fn validate(&self) -> Result<(), String> {
        let mut problems = Vec::new();
        for (k, t) in &self.tokens {
            if parse_address(&t.address).is_none() {
                problems.push(format!("token {k}: bad address {}", t.address));
            }
            if t.decimals > 36 {
                problems.push(format!("token {k}: decimals {}", t.decimals));
            }
            if let Some(b) = &t.base_asset {
                if !self.assets.contains_key(b) {
                    problems.push(format!("token {k}: base asset {b} not registered"));
                }
            }
        }
        for (k, a) in &self.assets {
            if &a.key != k {
                problems.push(format!("asset {k}: key {} differs", a.key));
            }
            if !self.tokens.contains_key(&a.token) {
                problems.push(format!("asset {k}: token {} not registered", a.token));
            }
        }
        let mut symbols = HashSet::new();
        for p in &self.pairs {
            if !symbols.insert(p.symbol.as_str()) {
                problems.push(format!("pair {}: duplicate symbol", p.symbol));
            }
            if !self.assets.contains_key(&p.base) {
                problems.push(format!("pair {}: base {} not an asset", p.symbol, p.base));
            }
            let quote_ok = if p.is_asset_quoted() {
                self.assets.contains_key(&p.quote)
            } else {
                self.tokens.get(&p.quote).is_some_and(|t| t.stable)
            };
            if !quote_ok {
                problems.push(format!("pair {}: quote {} not registered for its kind", p.symbol, p.quote));
            }
        }
        if parse_address(&self.native_mon).is_none() || parse_address(&self.wmon).is_none() {
            problems.push("MON addresses".into());
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems.join("; "))
        }
    }

    pub fn markets(&self) -> impl Iterator<Item = &str> {
        self.pairs.iter().map(|p| p.symbol.as_str())
    }

    pub fn asset_of(&self, key: &str) -> Option<&Asset> {
        self.assets.get(key)
    }

    pub fn pair_of(&self, symbol: &str) -> Option<&Pair> {
        self.pairs.iter().find(|p| p.symbol == symbol)
    }

    /// The registered pair for (base asset, quote): the first match.
    pub fn pair_for(&self, base: &str, quote: &str) -> Option<&Pair> {
        self.pairs.iter().find(|p| p.base == base && p.quote == quote)
    }

    /// The canonical wrapper token of a base asset.
    pub fn base_token_of(&self, base: &str) -> Option<&Token> {
        self.tokens.get(&self.assets.get(base)?.token)
    }

    pub fn is_mon_address(&self, addr: &str) -> bool {
        addr.eq_ignore_ascii_case(&self.wmon) || addr.eq_ignore_ascii_case(&self.native_mon)
    }

    /// The base asset an on-chain token denotes.
    pub fn asset_for_token(&self, addr: &str) -> Option<&Asset> {
        if self.is_mon_address(addr) {
            return self.assets.get("MON");
        }
        let canonical = self
            .assets
            .values()
            .find(|a| self.tokens.get(&a.token).is_some_and(|t| t.address.eq_ignore_ascii_case(addr)));
        if canonical.is_some() {
            return canonical;
        }
        let alt = self.tokens.values().find(|t| t.base_asset.is_some() && t.address.eq_ignore_ascii_case(addr))?;
        self.assets.get(alt.base_asset.as_deref()?)
    }

    /// The registry key and entry of the token at `addr`.
    pub fn token_by_address(&self, addr: &[u8; 20]) -> Option<(&str, &Token)> {
        self.tokens.iter().find(|(_, t)| &t.address_bytes() == addr).map(|(k, t)| (k.as_str(), t))
    }

    /// The base wrap-basis symbol in effect for a pair (`None` = parity).
    pub fn wrap_basis_for<'a>(&'a self, pair: &'a Pair) -> Option<&'a str> {
        let sym = match &pair.wrap_basis_override {
            Some(s) => Some(s.as_str()),
            None => self.assets.get(&pair.base).and_then(|a| a.wrap_basis_symbol.as_deref()),
        };
        sym.filter(|s| !s.is_empty())
    }

    /// The exchange benchmarking a base asset (Bybit when unknown, as today).
    pub fn cex_for_base(&self, base: &str) -> Cex {
        self.assets.get(base).map_or(Cex::Bybit, |a| a.cex)
    }
}

pub fn is_mon_symbol(sym: &str) -> bool {
    sym == "WMON" || sym == "MON"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compiled_registry_is_valid() {
        let r = Registry::get();
        assert_eq!(r.chain_id, 143);
        assert_eq!(r.tokens.len(), 30);
        assert_eq!(r.assets.len(), 24);
        assert_eq!(r.pairs.len(), 161);
        // The unwrapped ANTx is asset ANTX: the wrapped share keeps the key ANTx.
        assert_eq!((r.assets["ANTX"].symbol.as_str(), r.assets["ANTx"].token.as_str()), ("ANTx", "WANTX"));
        assert_eq!(r.pair_of("ANTx/USDC").map(|p| p.base.as_str()), Some("ANTX"));
        assert_eq!(r.sizes_usd, [100.0, 1000.0, 10000.0, 100000.0]);
        assert_eq!(r.markout_horizons_s, [0, 5, 10, 30, 60]);
        assert_eq!(r.tokens["XAUT0"].address, "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", "checksum case kept");
        assert_eq!(r.tokens["WSPYX"].underlying_x_stock.as_deref(), Some("SPYx"));
    }

    #[test]
    fn validation_catches_dangling_references() {
        let mut v: serde_json::Value = serde_json::from_str(REGISTRY_JSON).unwrap();
        v["pairs"][0]["base"] = "NOPE".into();
        v["assets"]["BTC"]["token"] = "NOTATOKEN".into();
        v["pairs"][1]["symbol"] = v["pairs"][2]["symbol"].clone();
        let err = Registry::parse(&v.to_string()).unwrap_err();
        assert!(err.contains("base NOPE"), "{err}");
        assert!(err.contains("token NOTATOKEN"), "{err}");
        assert!(err.contains("duplicate symbol"), "{err}");
        let mut v: serde_json::Value = serde_json::from_str(REGISTRY_JSON).unwrap();
        v["tokens"]["USDC"]["typo"] = true.into();
        assert!(Registry::parse(&v.to_string()).is_err(), "unknown fields are rejected");
    }

    #[test]
    fn addresses() {
        assert_eq!(parse_address("0x0000000000000000000000000000000000000001").unwrap()[19], 1);
        assert!(parse_address("0x01").is_none());
        assert!(parse_address("0xzz00000000000000000000000000000000000001").is_none());
        let r = Registry::get();
        let wbtc = r.tokens["WBTC"].address_bytes();
        assert_eq!(r.token_by_address(&wbtc).map(|(k, _)| k), Some("WBTC"));
        assert!(r.is_mon_address("0x3BD359C1119DA7DA1D913D1C4D2B7C461115433A"));
        assert!(is_mon_symbol("WMON") && !is_mon_symbol("WETH"));
    }
}
