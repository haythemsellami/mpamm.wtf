//! Markout curves (`computeMarkoutCurves`): each fill's TAKER-signed markout
//! from 5 s before to 15 s after it, summed USD-weighted per venue × flow ×
//! route × category, with each venue's coverage beside it.
//!
//! A fill's curve is captured live while the in-memory reference still
//! covers it, or never; one that never got one stays out of the cells and
//! only lowers coverage.

use std::collections::{BTreeMap, HashSet};

use indexmap::IndexMap;
use mpamm_registry::Registry;
use mpamm_types::{
    curve_flow, Coverage, CurveFlow, CurveRoute, Fill, FillCategory, MarkoutCurveCell, MarkoutCurvesResponse, Side,
    CURVE_OFFSETS_S, CURVE_QUIET_MOVE_BPS, CURVE_SECOND_MID_MS,
};
use serde::{Deserialize, Serialize};

use crate::js;

/// Absolute mark time of curve offset `offset_s` for a fill stamped `ts`
/// (`curveMarkMs`): the middle of the fill's block second.
pub fn curve_mark_ms(ts: f64, offset_s: i32) -> f64 {
    ts + CURVE_SECOND_MID_MS + f64::from(offset_s) * 1000.0
}

/// TAKER-signed curve points for one fill (`curvePoints`), the same sign as
/// `Fill::markouts_bps`, rounded to 0.01 bp. A point with no honest reference
/// stays `None`, never a fabricated zero.
pub fn curve_points(ts: f64, side: Side, exec_px: f64, mut mid_at: impl FnMut(f64) -> Option<f64>) -> Vec<Option<f64>> {
    let ss = if side == Side::Buy { 1.0 } else { -1.0 };
    CURVE_OFFSETS_S
        .iter()
        .map(|&h| {
            let mid = mid_at(curve_mark_ms(ts, h))?;
            // A mid or price at or below 0 (or NaN) has no honest point.
            (mid > 0.0 && exec_px > 0.0).then(|| js::round(ss * (mid / exec_px - 1.0) * 1e6) / 100.0)
        })
        .collect()
}

/// The curve's points when it has one finite point per offset.
fn complete(curve: Option<&[Option<f64>]>) -> Option<&[Option<f64>]> {
    curve.filter(|c| c.len() == CURVE_OFFSETS_S.len() && c.iter().all(|v| v.is_some_and(f64::is_finite)))
}

/// Whether a stored curve has a finite point at every offset (`curveComplete`).
pub fn curve_complete(curve: Option<&[Option<f64>]>) -> bool {
    complete(curve).is_some()
}

/// The light row the aggregation reads. pxApprox rows take part in their
/// transaction's route (they are real legs) but never in the stats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurveRow {
    pub id: String,
    pub ts: f64,
    pub venue_id: String,
    pub market: String,
    pub category: FillCategory,
    pub side: Side,
    pub pool: String,
    pub usd: f64,
    pub tx_hash: String,
    #[serde(default)]
    pub px_approx: bool,
    pub curve: Option<Vec<Option<f64>>>,
}

impl CurveRow {
    pub fn from_fill(f: &Fill, curve: Option<Vec<Option<f64>>>) -> Self {
        CurveRow {
            id: f.id.clone(),
            ts: f.ts,
            venue_id: f.venue_id.clone(),
            market: f.market.clone(),
            category: f.category,
            side: f.side,
            pool: f.pool.clone(),
            usd: f.usd,
            tx_hash: f.tx_hash.clone(),
            px_approx: f.px_approx,
            curve,
        }
    }

    pub fn leg(&self) -> RouteLeg<'_> {
        RouteLeg { venue_id: &self.venue_id, pool: &self.pool, market: &self.market, side: self.side }
    }
}

/// What `route_of` reads of one leg.
#[derive(Debug, Clone, Copy)]
pub struct RouteLeg<'a> {
    pub venue_id: &'a str,
    pub pool: &'a str,
    pub market: &'a str,
    pub side: Side,
}

/// Route class of one transaction's tracked legs (`routeOf`). Fills on one
/// pool and market are one leg (a book sweeping several orders emits a log per
/// order), so they stay `Single`; the market is part of the leg because a
/// singleton contract labels every market with one pool. Both directions in
/// one base asset is `TwoSided`, whatever else the transaction did.
pub fn route_of<'a>(legs: impl IntoIterator<Item = RouteLeg<'a>>) -> CurveRoute {
    let registry = Registry::get();
    let mut sides: IndexMap<&str, (bool, bool)> = IndexMap::new();
    // Keyed by the joined string, as today: distinct legs whose labels
    // contain `|` can share a key there, so they share one here too.
    let mut pools: HashSet<String> = HashSet::new();
    for l in legs {
        pools.insert(format!("{}|{}|{}", l.venue_id, l.pool, l.market));
        let base = registry.pair_of(l.market).map_or(l.market, |p| p.base.as_str());
        let s = sides.entry(base).or_default();
        match l.side {
            Side::Buy => s.0 = true,
            Side::Sell => s.1 = true,
        }
    }
    if sides.values().any(|&(buy, sell)| buy && sell) {
        CurveRoute::TwoSided
    } else if pools.len() > 1 {
        CurveRoute::Split
    } else {
        CurveRoute::Single
    }
}

struct CellAcc<'a> {
    venue_id: &'a str,
    flow: CurveFlow,
    route: CurveRoute,
    category: FillCategory,
    fills: u64,
    usd: f64,
    usd_bps: Vec<f64>,
}

/// Aggregate one window of rows ascending by (ts, id). A transaction's fills
/// share its block's timestamp, so each equal-ts run holds whole
/// transactions; legs group by transaction within it.
pub fn compute_markout_curves(rows: &[CurveRow], days: u32, now_ms: f64) -> MarkoutCurvesResponse {
    let n = CURVE_OFFSETS_S.len();
    // Cells and coverage in first-seen order (the key's parts can't contain
    // each other's `|`, so the tuple is today's string key).
    let mut cells: IndexMap<(&str, CurveFlow, CurveRoute, FillCategory), CellAcc> = IndexMap::new();
    let mut coverage: IndexMap<&str, (u64, f64)> = IndexMap::new();

    for run in rows.chunk_by(|a, b| a.ts == b.ts) {
        let mut by_tx: IndexMap<&str, Vec<&CurveRow>> = IndexMap::new();
        for r in run {
            by_tx.entry(r.tx_hash.as_str()).or_default().push(r);
        }
        for legs in by_tx.values() {
            let route = route_of(legs.iter().map(|r| r.leg()));
            for r in legs.iter().filter(|r| !r.px_approx) {
                let cov = coverage.entry(r.venue_id.as_str()).or_insert((0, 0.0));
                cov.0 += 1;
                cov.1 += r.usd;
                let Some(curve) = complete(r.curve.as_deref()) else { continue };
                let flow = curve_flow(curve).expect("a complete curve has a flow");
                let c = cells.entry((r.venue_id.as_str(), flow, route, r.category)).or_insert_with(|| CellAcc {
                    venue_id: &r.venue_id,
                    flow,
                    route,
                    category: r.category,
                    fills: 0,
                    usd: 0.0,
                    usd_bps: vec![0.0; n],
                });
                c.fills += 1;
                c.usd += r.usd;
                for (acc, v) in c.usd_bps.iter_mut().zip(curve) {
                    *acc += r.usd * v.expect("complete");
                }
            }
        }
    }

    MarkoutCurvesResponse {
        days,
        generated_at: now_ms,
        offsets_s: CURVE_OFFSETS_S.to_vec(),
        quiet_move_bps: CURVE_QUIET_MOVE_BPS,
        cells: cells
            .into_values()
            .map(|c| MarkoutCurveCell {
                venue_id: c.venue_id.to_string(),
                flow: c.flow,
                route: c.route,
                category: c.category,
                fills: c.fills,
                usd: js::round_to(c.usd, 100.0),
                usd_bps: c.usd_bps.into_iter().map(|v| js::round_to(v, 10.0)).collect(),
            })
            .collect(),
        coverage: coverage
            .into_iter()
            .map(|(k, (fills, usd))| (k.to_string(), Coverage { fills, usd: js::round_to(usd, 100.0) }))
            .collect::<BTreeMap<_, _>>(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, tx: &str, venue: &str, pool: &str, market: &str, side: Side) -> CurveRow {
        CurveRow {
            id: id.into(),
            ts: 1_000_000.0,
            venue_id: venue.into(),
            market: market.into(),
            category: FillCategory::Direct,
            side,
            pool: pool.into(),
            usd: 1.5,
            tx_hash: tx.into(),
            px_approx: false,
            curve: Some(vec![Some(-1.5); CURVE_OFFSETS_S.len()]),
        }
    }

    #[test]
    fn routes() {
        let a = row("a", "t", "v", "p", "MON/USDC", Side::Buy);
        let route = |rs: &[&CurveRow]| route_of(rs.iter().map(|r| r.leg()));
        assert_eq!(route(&[&a, &row("b", "t", "v", "p", "MON/USDC", Side::Buy)]), CurveRoute::Single);
        assert_eq!(route(&[&a, &row("b", "t", "v", "p", "MON/USDT0", Side::Buy)]), CurveRoute::Split);
        // cbBTC's base asset is BTC: a buy there and a sell of BTC is two-sided.
        let cb = row("c", "t", "v", "p", "cbBTC/USDC", Side::Buy);
        assert_eq!(route(&[&cb, &row("d", "t", "w", "q", "BTC/USDT0", Side::Sell)]), CurveRoute::TwoSided);
        assert_eq!(route(&[&a, &row("e", "t", "w", "q", "MON/ETH", Side::Sell)]), CurveRoute::TwoSided);
    }

    #[test]
    fn rounds_a_negative_half_like_math_round() {
        let res = compute_markout_curves(&[row("a", "t", "v", "p", "MON/USDC", Side::Buy)], 1, 0.0);
        // 1.5 × −1.5 = −2.25 → Math.round(−22.5) = −22, where f64::round gives −23.
        assert!(res.cells[0].usd_bps.iter().all(|&v| v == -2.2));
        assert_eq!(res.cells[0].flow, CurveFlow::Quiet);
        assert_eq!(res.coverage["v"], Coverage { fills: 1, usd: 1.5 });
    }

    #[test]
    fn points_mark_mid_second_and_round_like_math_round() {
        let mut asked = Vec::new();
        let pts = curve_points(10_000.0, Side::Buy, 1.0, |t| {
            asked.push(t);
            Some(0.9921875)
        });
        assert_eq!(asked[0], 10_000.0 + 500.0 - 5000.0);
        // −1/128 × 1e6 = −7812.5 → −7812 → −78.12
        assert!(pts.iter().all(|&p| p == Some(-78.12)));
        assert!(curve_points(0.0, Side::Sell, 0.0, |_| Some(1.0)).iter().all(Option::is_none));
        assert!(!curve_complete(Some(&pts[1..])) && curve_complete(Some(&pts)));
    }
}
