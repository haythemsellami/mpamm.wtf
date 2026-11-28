//! ERC-4626 rates of the wrapped xStocks (`convertToAssets(1 share)`), read
//! from the node every minute, ported from server/src/wrapper-rates.ts. A
//! failed read keeps the last good rate for 5 minutes; after that the pair
//! has no reference (never a guessed rate). Reads may overlap: each is
//! stamped when sent, and an answer older than the one on record is dropped.

use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};

use mpamm_chain::Rpc;
use mpamm_registry::Registry;
use parking_lot::RwLock;
use serde_json::json;

use crate::{history::MidHistory, reference::Rates};

pub const REFRESH_MS: u64 = 60_000;
pub const MAX_AGE_MS: u64 = 5 * 60_000;
/// `convertToAssets(uint256)`.
const CONVERT_TO_ASSETS: &str = "07a2d13a";

#[derive(Debug, Clone, Copy)]
struct Read {
    per_share: f64,
    at: u64,
    seq: u64,
}

pub struct WrapperRates {
    registry: &'static Registry,
    last: RwLock<HashMap<String, Read>>,
    history: RwLock<HashMap<String, MidHistory>>,
    sent: AtomicU64,
    now: fn() -> u64,
}

impl WrapperRates {
    pub fn new(registry: &'static Registry) -> Self {
        Self::with_clock(registry, crate::feeds::now_ms)
    }

    pub fn with_clock(registry: &'static Registry, now: fn() -> u64) -> Self {
        Self {
            registry,
            last: RwLock::new(HashMap::new()),
            history: RwLock::new(HashMap::new()),
            sent: AtomicU64::new(0),
            now,
        }
    }

    /// Every wrapper token a registered pair trades.
    pub fn tokens(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .registry
            .tokens
            .iter()
            .filter(|(_, t)| t.underlying_x_stock.is_some())
            .map(|(k, _)| k.clone())
            .collect();
        keys.sort();
        keys
    }

    fn is_wrapper(&self, key: &str) -> bool {
        self.registry.tokens.get(key).is_some_and(|t| t.underlying_x_stock.is_some())
    }

    /// Records one wrapper's answer to request `seq` sent at `at`.
    pub fn record(&self, key: &str, per_share: f64, at: u64, seq: u64) {
        if !(per_share.is_finite() && per_share > 0.0) {
            return;
        }
        let mut last = self.last.write();
        if last.get(key).is_some_and(|r| r.seq > seq) {
            return;
        }
        last.insert(key.to_string(), Read { per_share, at, seq });
        self.history
            .write()
            .entry(key.to_string())
            .or_insert_with(|| MidHistory::new(crate::feeds::HISTORY_MS * 8.0, 100_000))
            .push(at as f64, per_share);
    }

    /// Reads every wrapper's rate in one batch. Never fails: a wrapper that
    /// didn't answer keeps its last rate until it is too old.
    pub async fn refresh(&self, rpc: &Rpc) {
        let keys = self.tokens();
        if keys.is_empty() {
            return;
        }
        let seq = self.sent.fetch_add(1, Ordering::Relaxed) + 1;
        let at = (self.now)();
        let calls: Vec<(&str, serde_json::Value)> = keys
            .iter()
            .map(|k| {
                let t = &self.registry.tokens[k];
                let one = 10u128.pow(u32::from(t.decimals));
                let data = format!("0x{CONVERT_TO_ASSETS}{one:064x}");
                ("eth_call", json!([{ "to": t.address, "data": data, "gas": "0x7a1200" }, "latest"]))
            })
            .collect();
        let Ok(results) = rpc.batch(&calls).await else { return };
        for (k, r) in keys.iter().zip(results) {
            let Ok(v) = r else { continue };
            // One uint256 word; any real rate fits in its low 128 bits.
            let Some(word) = v.as_str().and_then(|s| s.strip_prefix("0x")).filter(|h| h.len() == 64) else { continue };
            if word[..32].bytes().any(|b| b != b'0') {
                continue;
            }
            let Ok(n) = u128::from_str_radix(&word[32..], 16) else { continue };
            let decimals = self.registry.tokens[k].decimals;
            self.record(k, n as f64 / 10f64.powi(i32::from(decimals)), at, seq);
        }
    }

    /// The rate at a past time, for pricing a late block.
    pub fn rate_at(&self, key: &str, t_ms: f64) -> f64 {
        if !self.is_wrapper(key) {
            return 1.0;
        }
        self.history.read().get(key).and_then(|h| h.at(t_ms, MAX_AGE_MS as f64)).unwrap_or(0.0)
    }
}

impl Rates for WrapperRates {
    fn rate(&self, key: &str) -> f64 {
        if !self.is_wrapper(key) {
            return 1.0;
        }
        match self.last.read().get(key) {
            Some(r) if (self.now)().saturating_sub(r.at) <= MAX_AGE_MS => r.per_share,
            _ => 0.0,
        }
    }
}

/// Wrapper rates as of a past time.
pub struct RatesAt<'a> {
    pub rates: &'a WrapperRates,
    pub t_ms: f64,
}

impl Rates for RatesAt<'_> {
    fn rate(&self, key: &str) -> f64 {
        self.rates.rate_at(key, self.t_ms)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NOW: AtomicU64 = AtomicU64::new(1_000_000);
    fn clock() -> u64 {
        NOW.load(Ordering::Relaxed)
    }

    #[test]
    fn rates_expire_and_late_answers_never_roll_back() {
        let r = WrapperRates::with_clock(Registry::get(), clock);
        assert_eq!(r.rate("USDC"), 1.0, "not a wrapper");
        assert_eq!(r.rate("WSPYX"), 0.0, "no read yet");
        r.record("WSPYX", 1.02, 1_000_000, 2);
        r.record("WSPYX", 1.01, 999_000, 1); // an older request answering late
        assert_eq!(r.rate("WSPYX"), 1.02);
        NOW.store(1_000_000 + MAX_AGE_MS + 1, Ordering::Relaxed);
        assert_eq!(r.rate("WSPYX"), 0.0, "too old");
        assert_eq!(r.rate_at("WSPYX", 1_000_500.0), 1.02);
        assert_eq!(r.rate_at("WSPYX", 900_000.0), 0.0, "before the first read");
        assert_eq!(r.rate_at("WBTC", 1.0), 1.0);
        assert_eq!(r.tokens().len(), 10);
    }
}
