//! USD prices learned from the chain's own trades, ported from
//! server/src/fill-time-prices.ts: every stable-quoted trade of an asset is a
//! USD print of it at its own time. Used for a block decoded late when the
//! exchange history doesn't reach back that far (after a restart): the
//! median of an asset's newest prints, so one off-market swap can't set the
//! price of every crypto-quoted trade after it.

use std::collections::HashMap;

use mpamm_registry::Registry;
use mpamm_types::Fill;

/// A batch's price for an asset is the median of its prints from the last
/// five minutes before its newest one.
const PRINT_SPAN_MS: f64 = 300_000.0;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Print {
    px: f64,
    ts: f64,
}

#[derive(Debug, Default)]
pub struct FillTimePrices {
    last: HashMap<String, Print>,
    /// Recent prints per asset, for the median.
    recent: HashMap<String, Vec<Print>>,
}

fn median(xs: &mut [f64]) -> f64 {
    xs.sort_by(|a, b| a.total_cmp(b));
    let m = xs.len() / 2;
    if xs.len() % 2 == 1 {
        xs[m]
    } else {
        (xs[m - 1] + xs[m]) / 2.0
    }
}

impl FillTimePrices {
    /// Learns from committed trades (in block order). Only a stable-quoted
    /// trade with an exact price is a print.
    pub fn observe(&mut self, registry: &Registry, fills: &[Fill]) {
        let mut touched = Vec::new();
        for f in fills {
            if f.px_approx || !(f.exec_px.is_finite() && f.exec_px > 0.0) {
                continue;
            }
            let Some(pair) = registry.pair_of(&f.market) else { continue };
            if pair.is_asset_quoted() {
                continue;
            }
            let r = self.recent.entry(pair.base.clone()).or_default();
            if r.last().is_some_and(|p| p.ts > f.ts) {
                continue;
            }
            r.push(Print { px: f.exec_px, ts: f.ts });
            touched.push(pair.base.clone());
        }
        for asset in touched {
            let r = self.recent.get_mut(&asset).expect("touched");
            let newest = r.last().map_or(0.0, |p| p.ts);
            r.retain(|p| p.ts >= newest - PRINT_SPAN_MS);
            let mut pxs: Vec<f64> = r.iter().map(|p| p.px).collect();
            self.last.insert(asset, Print { px: median(&mut pxs), ts: newest });
        }
    }

    /// The asset's USD price as of `at_ms`, when a print is nearer to it
    /// than `now_ms` (otherwise the live price is the better observation).
    pub fn usd_at(&self, asset: &str, at_ms: f64, now_ms: f64) -> Option<f64> {
        let p = self.last.get(asset)?;
        ((at_ms - p.ts).abs() <= (now_ms - at_ms).abs()).then_some(p.px)
    }
}

#[cfg(test)]
mod tests {
    use mpamm_types::{FillCategory, Side};

    use super::*;

    fn fill(market: &str, px: f64, ts: f64) -> Fill {
        Fill {
            id: format!("{market}-{ts}"),
            venue_id: "v".into(),
            market: market.into(),
            side: Side::Buy,
            category: FillCategory::Direct,
            usd: 1.0,
            base_amount: 1.0,
            exec_px: px,
            px_approx: false,
            tx_hash: "0x".into(),
            to: "x".into(),
            router: None,
            pool: "p".into(),
            block_number: 1,
            ts,
            markouts_bps: vec![],
            time_source: None,
        }
    }

    #[test]
    fn median_of_recent_stable_quoted_prints() {
        let reg = Registry::get();
        let mut p = FillTimePrices::default();
        p.observe(
            reg,
            &[fill("MON/USDC", 0.030, 1_000.0), fill("MON/AUSD", 0.031, 2_000.0), fill("MON/USDC", 0.500, 3_000.0)],
        );
        assert_eq!(p.usd_at("MON", 3_000.0, 10_000.0), Some(0.031), "an outlier doesn't set the price");
        // Crypto-quoted and approximate trades are not prints.
        let mut approx = fill("BTC/USDC", 1.0, 4_000.0);
        approx.px_approx = true;
        p.observe(reg, &[fill("MON/ETH", 0.00001, 4_000.0), approx]);
        assert_eq!(p.usd_at("BTC", 4_000.0, 10_000.0), None);
        // A print is used only when nearer than now.
        assert_eq!(p.usd_at("MON", 9_000.0, 10_000.0), None);
        // Old prints leave the median window.
        p.observe(reg, &[fill("MON/USDC", 0.040, 400_000.0)]);
        assert_eq!(p.usd_at("MON", 400_000.0, 500_000.0), Some(0.040));
    }
}
