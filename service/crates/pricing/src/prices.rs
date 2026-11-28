//! The pricing runtime: the three feeds, wrapper rates and chain prints in
//! one place, and the pricer each block is decoded with.

use std::sync::Arc;

use mpamm_chain::Rpc;
use mpamm_core::Pricer;
use mpamm_registry::Registry;
use mpamm_types::Fill;
use parking_lot::Mutex;
use tokio::sync::watch;

use crate::{
    feeds::{binance, bybit, kraken, now_ms, Feeds},
    prints::FillTimePrices,
    reference::{Fees, Reference},
    wrapper::{RatesAt, WrapperRates, REFRESH_MS},
};

#[derive(Debug, Clone, Default)]
pub struct Endpoints {
    pub bybit: bybit::Endpoints,
    pub binance: binance::Endpoints,
    pub kraken: Option<String>,
}

pub struct Prices {
    pub registry: &'static Registry,
    pub feeds: Feeds,
    pub rates: WrapperRates,
    pub prints: Mutex<FillTimePrices>,
    pub fees: Fees,
}

impl Prices {
    pub fn new(registry: &'static Registry, fees: Fees) -> Arc<Self> {
        Arc::new(Self {
            registry,
            feeds: Feeds::new(registry),
            rates: WrapperRates::new(registry),
            prints: Mutex::new(FillTimePrices::default()),
            fees,
        })
    }

    /// The live reference.
    pub fn reference(&self) -> Reference<'_, Feeds, WrapperRates> {
        Reference { registry: self.registry, ex: &self.feeds, rates: &self.rates }
    }

    /// Starts the feeds and the wrapper-rate refresh; they stop when `stop`
    /// turns true.
    pub fn spawn(self: &Arc<Self>, rpc: Rpc, ep: Endpoints, stop: watch::Receiver<bool>) {
        tokio::spawn(bybit::run(self.feeds.bybit.clone(), ep.bybit, stop.clone()));
        tokio::spawn(binance::run(self.feeds.binance.clone(), ep.binance, stop.clone()));
        tokio::spawn(kraken::run(
            self.feeds.kraken.clone(),
            ep.kraken.unwrap_or_else(|| kraken::WS_URL.into()),
            stop.clone(),
        ));
        let me = self.clone();
        let mut stop = stop;
        tokio::spawn(async move {
            let mut every = tokio::time::interval(std::time::Duration::from_millis(REFRESH_MS));
            loop {
                tokio::select! {
                    _ = every.tick() => me.rates.refresh(&rpc).await,
                    _ = stop.changed() => return,
                }
            }
        });
    }

    /// Learns USD prints from committed trades (the late-decode fallback).
    pub fn observe(&self, fills: &[Fill]) {
        self.prints.lock().observe(self.registry, fills);
    }

    /// The pair's reference mid as it was at `t_ms`, from the exchange
    /// history (`None` before the history starts or during an outage): the
    /// markout mark.
    pub fn pair_mid_at(&self, market: &str, t_ms: f64) -> Option<f64> {
        let past = self.feeds.at(t_ms);
        let rates = RatesAt { rates: &self.rates, t_ms };
        let m = Reference { registry: self.registry, ex: &past, rates: &rates }.mid_for_pair(market);
        (m > 0.0).then_some(m)
    }

    /// The pricer for a block whose trades happened at `at_ms`.
    pub fn at(&self, at_ms: f64) -> AtPricer<'_> {
        AtPricer { p: self, at_ms, now_ms: now_ms() as f64 }
    }
}

/// Prices as of one block's time: the exchange history at that time when it
/// reaches back that far, else the chain's own prints when they are nearer
/// in time than now, else the live price.
pub struct AtPricer<'a> {
    p: &'a Prices,
    at_ms: f64,
    now_ms: f64,
}

impl AtPricer<'_> {
    fn asset_usd(&self, base: &str, settled: bool) -> f64 {
        let past = self.p.feeds.at(self.at_ms);
        let rates = RatesAt { rates: &self.p.rates, t_ms: self.at_ms };
        let r = Reference { registry: self.p.registry, ex: &past, rates: &rates };
        let v = if settled { r.settled_usd(base) } else { r.asset_usd(base) };
        if v > 0.0 {
            return v;
        }
        if let Some(v) = self.p.prints.lock().usd_at(base, self.at_ms, self.now_ms) {
            return v;
        }
        let live = self.p.reference();
        if settled {
            live.settled_usd(base)
        } else {
            live.asset_usd(base)
        }
    }
}

impl Pricer for AtPricer<'_> {
    fn usd_per_token(&self, token_key: &str) -> f64 {
        let Some(t) = self.p.registry.tokens.get(token_key) else { return 0.0 };
        if t.stable {
            return 1.0;
        }
        self.p.registry.asset_for_token(&t.address).map_or(0.0, |a| self.asset_usd(&a.key.clone(), false))
    }

    fn usd_for_token(&self, token_key: &str, amount: f64) -> f64 {
        let Some(t) = self.p.registry.tokens.get(token_key) else { return 0.0 };
        if t.stable {
            return amount;
        }
        self.p.registry.asset_for_token(&t.address).map_or(0.0, |a| amount * self.asset_usd(&a.key.clone(), true))
    }

    fn pair_mid(&self, market: &str) -> f64 {
        let past = self.p.feeds.at(self.at_ms);
        let rates = RatesAt { rates: &self.p.rates, t_ms: self.at_ms };
        let m = Reference { registry: self.p.registry, ex: &past, rates: &rates }.mid_for_pair(market);
        if m > 0.0 {
            m
        } else {
            self.p.reference().mid_for_pair(market)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::bybit as by;

    #[test]
    fn a_block_is_priced_as_of_its_own_time() {
        let p = Prices::new(Registry::get(), Fees::default());
        let t = now_ms();
        by::apply(
            &p.feeds.bybit,
            r#"{"topic":"tickers.MONUSDT","data":{"bid1Price":"0.0299","ask1Price":"0.0301"}}"#,
            t - 60_000,
        );
        by::apply(
            &p.feeds.bybit,
            r#"{"topic":"tickers.MONUSDT","data":{"bid1Price":"0.0399","ask1Price":"0.0401"}}"#,
            t,
        );
        let then = p.at((t - 30_000) as f64);
        assert!((then.usd_for_token("WMON", 100.0) - 3.0).abs() < 1e-9, "the price a minute ago, not now");
        assert!((p.at(t as f64).usd_for_token("MON", 100.0) - 4.0).abs() < 1e-9);
        assert_eq!(then.usd_for_token("USDC", 12.5), 12.5);
        assert_eq!(then.usd_per_token("USDC"), 1.0);
        assert_eq!(then.usd_for_token("NOPE", 1.0), 0.0);
        // Before the history: chain prints when nearer, else live.
        let old = p.at((t - 3_600_000) as f64);
        assert!((old.usd_for_token("WMON", 100.0) - 4.0).abs() < 1e-9, "live when nothing nearer");
        p.prints.lock().usd_at("MON", 0.0, 0.0);
    }
}
