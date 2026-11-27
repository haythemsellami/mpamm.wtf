//! The reference frozen for one quote job: every pair mid and asset price
//! captured once, before any venue starts, so every row of the job is sized
//! and anchored against the same reference (today's captureReferenceFrame).

use std::collections::HashMap;

use mpamm_core::Pricer;
use mpamm_pricing::Prices;
use mpamm_registry::Registry;

pub struct FramePricer {
    registry: &'static Registry,
    pair_mids: HashMap<String, f64>,
    asset_usd: HashMap<String, f64>,
    settled_usd: HashMap<String, f64>,
}

impl FramePricer {
    pub fn capture(prices: &Prices, registry: &'static Registry) -> Self {
        let r = prices.reference();
        Self {
            registry,
            pair_mids: registry.pairs.iter().map(|p| (p.symbol.clone(), r.mid_for_pair(&p.symbol))).collect(),
            asset_usd: registry.assets.keys().map(|k| (k.clone(), r.asset_usd(k))).collect(),
            settled_usd: registry.assets.keys().map(|k| (k.clone(), r.settled_usd(k))).collect(),
        }
    }

    /// A frame from fixed values (tests).
    pub fn fixed(
        registry: &'static Registry,
        pair_mids: HashMap<String, f64>,
        asset_usd: HashMap<String, f64>,
    ) -> Self {
        Self { registry, pair_mids, settled_usd: asset_usd.clone(), asset_usd }
    }

    fn asset_of(&self, token_key: &str) -> Option<String> {
        let t = self.registry.tokens.get(token_key)?;
        self.registry.asset_for_token(&t.address).map(|a| a.key.clone())
    }
}

impl Pricer for FramePricer {
    fn usd_per_token(&self, token_key: &str) -> f64 {
        match self.registry.tokens.get(token_key) {
            Some(t) if t.stable => 1.0,
            Some(_) => self.asset_of(token_key).and_then(|a| self.asset_usd.get(&a).copied()).unwrap_or(0.0),
            None => 0.0,
        }
    }

    fn usd_for_token(&self, token_key: &str, amount: f64) -> f64 {
        match self.registry.tokens.get(token_key) {
            Some(t) if t.stable => amount,
            Some(_) => amount * self.asset_of(token_key).and_then(|a| self.settled_usd.get(&a).copied()).unwrap_or(0.0),
            None => 0.0,
        }
    }

    fn pair_mid(&self, market: &str) -> f64 {
        self.pair_mids.get(market).copied().unwrap_or(0.0)
    }
}
