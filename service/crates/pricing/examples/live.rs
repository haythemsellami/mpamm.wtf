//! Runs the three exchange feeds for a while and prints every pair's
//! reference mid: a live smoke test.
//!   cargo run -p mpamm-pricing --example live -- 30

use std::time::Duration;

use mpamm_pricing::{
    feeds::{binance, bybit, kraken, Feeds},
    Rates, Reference,
};
use mpamm_registry::Registry;

struct NoWrappers;
impl Rates for NoWrappers {
    fn rate(&self, key: &str) -> f64 {
        if Registry::get().tokens.get(key).is_some_and(|t| t.underlying_x_stock.is_some()) {
            0.0
        } else {
            1.0
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(20);
    let reg = Registry::get();
    let feeds = Feeds::new(reg);
    let (stop_tx, stop) = tokio::sync::watch::channel(false);
    tokio::spawn(bybit::run(feeds.bybit.clone(), bybit::Endpoints::default(), stop.clone()));
    tokio::spawn(binance::run(feeds.binance.clone(), binance::Endpoints::default(), stop.clone()));
    tokio::spawn(kraken::run(feeds.kraken.clone(), kraken::WS_URL.into(), stop.clone()));
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let r = Reference { registry: reg, ex: &feeds, rates: &NoWrappers };
    let mut priced = 0;
    for p in &reg.pairs {
        let m = r.mid_for_pair(&p.symbol);
        if m > 0.0 {
            priced += 1;
        }
        println!("{:<14} {:>16.8} closed={}", p.symbol, m, r.market_closed(&p.base));
    }
    let hist: usize = ["MONUSDT"].iter().map(|s| feeds.bybit.read(s, |x| x.history.len()).unwrap_or(0)).sum();
    println!("priced {priced}/{} pairs; MON history points {hist}", reg.pairs.len());
    let _ = stop_tx.send(true);
}
