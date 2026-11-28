//! The leaderboard (`computeLeaderboard`): TAKER-signed tallies per grouping ×
//! horizon, the top groups by volume with their markout percentiles and a
//! cumulative-PnL sparkline, the biggest single swaps and the 24 h outliers.
//! The MAKER view is a sign flip the client derives, so nothing is computed
//! twice.

use std::collections::{BTreeMap, HashMap};

use indexmap::{IndexMap, IndexSet};
use mpamm_types::{
    Fill, FillCategory, LeaderboardGroupRow, LeaderboardResponse, TopSwaps, LEADERBOARD_GROUPINGS,
    LEADERBOARD_HORIZON_IDX,
};
use serde::{Deserialize, Serialize};

use crate::js;

/// The UI renders the top 12 groups by volume.
const TOP_GROUPS: usize = 12;
/// The largest TOP SWAPS pill (10/25/50).
const TOP_SWAPS: usize = 50;
/// The Markouts tab's outlier feed depth.
const OUTLIERS: usize = 18;
/// Downsampled cumulative-PnL sparkline length.
const SPARK_POINTS: u64 = 80;

/// The light row the aggregation reads: a `Fill`'s columns it needs and no
/// more. The window is already pxApprox-excluded and ascending by (ts, id):
/// row order decides every tie.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LbRow {
    pub id: String,
    pub ts: f64,
    pub venue_id: String,
    pub market: String,
    pub category: FillCategory,
    pub pool: String,
    pub to: String,
    pub usd: f64,
    pub markouts_bps: Vec<Option<f64>>,
}

impl From<&Fill> for LbRow {
    fn from(f: &Fill) -> Self {
        LbRow {
            id: f.id.clone(),
            ts: f.ts,
            venue_id: f.venue_id.clone(),
            market: f.market.clone(),
            category: f.category,
            pool: f.pool.clone(),
            to: f.to.clone(),
            usd: f.usd,
            markouts_bps: f.markouts_bps.clone(),
        }
    }
}

/// A row's key in one grouping. Category keys are the client's: `direct` for
/// DIRECT, the wire spelling for the rest.
fn group_key<'a>(grouping: &str, r: &'a LbRow) -> &'a str {
    match grouping {
        "protocol" => &r.venue_id,
        "pool" => &r.pool,
        "to" => &r.to,
        "category" if r.category == FillCategory::Direct => "direct",
        "category" => r.category.as_str(),
        other => panic!("leaderboard grouping {other} has no key"),
    }
}

#[derive(Default)]
struct Tally {
    vol: f64,
    swaps: u64,
    pnl: f64,
}

/// Whether every value seen was the same one (a JS `Set` of size 1).
struct Uniq<'a> {
    first: &'a str,
    many: bool,
}

impl<'a> Uniq<'a> {
    fn add(this: &mut Option<Self>, v: &'a str) {
        match this {
            None => *this = Some(Uniq { first: v, many: false }),
            Some(u) => u.many |= u.first != v,
        }
    }

    fn one(this: &Option<Self>) -> Option<String> {
        this.as_ref().filter(|u| !u.many).map(|u| u.first.to_string())
    }
}

/// Presentation metadata of a pool key: a contract that served several
/// venues or markets gets no single label rather than a first-seen one.
#[derive(Default)]
struct PoolMeta<'a> {
    venue: Option<Uniq<'a>>,
    market: Option<Uniq<'a>>,
}

/// Percentile and sparkline inputs of one top group.
struct Cell {
    mks: Vec<f64>,
    stride: u64,
    cum: f64,
    cnt: u64,
    spark: Vec<f64>,
}

/// Linear-interpolated percentile over an already sorted slice (`pctOf`).
fn pct_of(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = (sorted.len() - 1) as f64 * p;
    let (lo, hi) = (i.floor() as usize, i.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo as f64)
}

/// A swap candidate: its PnL at one horizon and its row.
type Cand = (f64, usize);

/// The first `cap` candidates under a stable sort with a TS comparator.
fn top(mut v: Vec<Cand>, cap: usize, cmp: impl Fn(&Cand, &Cand) -> f64) -> Vec<Cand> {
    v.sort_by(|a, b| js::cmp(cmp(a, b)));
    v.truncate(cap);
    v
}

/// Aggregate one window. `full_fills` resolves the selected swaps' ids to
/// full rows (once, with every id the feeds need); an id it doesn't return
/// is left out of the feeds.
pub fn compute_leaderboard(
    rows: &[LbRow],
    days: u32,
    now_ms: f64,
    full_fills: impl FnOnce(&[String]) -> Vec<Fill>,
) -> LeaderboardResponse {
    let hz = LEADERBOARD_HORIZON_IDX;
    let groupings = LEADERBOARD_GROUPINGS;
    let day_since = now_ms - 86_400_000.0;
    let markout = |r: &LbRow, hi: usize| r.markouts_bps.get(hi).copied().flatten();

    // Scalars per (grouping, horizon, key), keys in first-seen order: that
    // order breaks volume ties.
    let mut tallies: Vec<Vec<IndexMap<&str, Tally>>> =
        groupings.iter().map(|_| hz.iter().map(|_| IndexMap::new()).collect()).collect();
    let mut pool_meta: Vec<IndexMap<&str, PoolMeta>> = hz.iter().map(|_| IndexMap::new()).collect();
    let mut winners: Vec<Vec<Cand>> = vec![Vec::new(); hz.len()];
    let mut losers: Vec<Vec<Cand>> = vec![Vec::new(); hz.len()];
    let mut outs: Vec<Cand> = Vec::new();

    for (i, r) in rows.iter().enumerate() {
        for (h, &hi) in hz.iter().enumerate() {
            // No realized markout at this horizon: the fill isn't in it, never a 0.
            let Some(mk) = markout(r, hi) else { continue };
            let pnl = (mk / 1e4) * r.usd;
            // Strict: a PnL of 0 is neither.
            if pnl > 0.0 {
                winners[h].push((pnl, i));
            } else if pnl < 0.0 {
                losers[h].push((pnl, i));
            }
            if hi == 0 && r.ts >= day_since {
                outs.push((pnl, i));
            }
            let pm = pool_meta[h].entry(r.pool.as_str()).or_default();
            Uniq::add(&mut pm.venue, &r.venue_id);
            Uniq::add(&mut pm.market, &r.market);
            for (g, grouping) in groupings.iter().enumerate() {
                let t = tallies[g][h].entry(group_key(grouping, r)).or_default();
                t.vol += r.usd;
                t.swaps += 1;
                t.pnl += pnl;
            }
        }
    }

    // The top groups by volume per (grouping, horizon).
    let top_lists: Vec<Vec<Vec<&str>>> = tallies
        .iter()
        .map(|by_hz| {
            by_hz
                .iter()
                .map(|m| {
                    let mut ranked: Vec<(&str, f64)> = m.iter().map(|(k, t)| (*k, t.vol)).collect();
                    ranked.sort_by(|a, b| js::cmp(b.1 - a.1));
                    ranked.into_iter().take(TOP_GROUPS).map(|(k, _)| k).collect()
                })
                .collect()
        })
        .collect();

    // Percentile and sparkline inputs for the top groups only.
    let mut cells: Vec<Vec<HashMap<&str, Cell>>> = top_lists
        .iter()
        .enumerate()
        .map(|(g, by_hz)| {
            by_hz
                .iter()
                .enumerate()
                .map(|(h, keys)| {
                    keys.iter()
                        .map(|k| {
                            let swaps = tallies[g][h][k].swaps;
                            let cell = Cell {
                                mks: Vec::with_capacity(swaps as usize),
                                stride: swaps.div_ceil(SPARK_POINTS).max(1),
                                cum: 0.0,
                                cnt: 0,
                                spark: Vec::new(),
                            };
                            (*k, cell)
                        })
                        .collect()
                })
                .collect()
        })
        .collect();

    for r in rows {
        for (h, &hi) in hz.iter().enumerate() {
            let Some(mk) = markout(r, hi) else { continue };
            let pnl = (mk / 1e4) * r.usd;
            for (g, grouping) in groupings.iter().enumerate() {
                let Some(c) = cells[g][h].get_mut(group_key(grouping, r)) else { continue };
                c.mks.push(mk);
                c.cum += pnl;
                c.cnt += 1;
                // The downsampled cumulative PnL.
                if c.cnt.is_multiple_of(c.stride) {
                    c.spark.push(c.cum);
                }
            }
        }
    }

    let mut groups = BTreeMap::new();
    for (g, grouping) in groupings.iter().enumerate() {
        let mut by_hz = BTreeMap::new();
        for (h, hi) in hz.iter().enumerate() {
            let table = top_lists[g][h]
                .iter()
                .map(|key| {
                    let t = &tallies[g][h][key];
                    let mut c = cells[g][h].remove(key).expect("every top group has a cell");
                    // The sparkline always ends at the total.
                    if c.cnt > 0 && !c.cnt.is_multiple_of(c.stride) {
                        c.spark.push(c.cum);
                    }
                    // Float64Array's sort: numeric, −0 before +0.
                    c.mks.sort_by(f64::total_cmp);
                    let pm = if *grouping == "pool" { pool_meta[h].get(key) } else { None };
                    LeaderboardGroupRow {
                        key: key.to_string(),
                        venue_id: pm.and_then(|pm| Uniq::one(&pm.venue)),
                        market: pm.and_then(|pm| Uniq::one(&pm.market)),
                        vol: t.vol,
                        swaps: t.swaps,
                        p5: pct_of(&c.mks, 0.05),
                        p25: pct_of(&c.mks, 0.25),
                        p50: pct_of(&c.mks, 0.5),
                        p75: pct_of(&c.mks, 0.75),
                        p95: pct_of(&c.mks, 0.95),
                        pnl: t.pnl,
                        spark: c.spark,
                    }
                })
                .collect::<Vec<_>>();
            by_hz.insert(hi.to_string(), table);
        }
        groups.insert(grouping.to_string(), by_hz);
    }

    // Top swaps per horizon (strict winners descending, losers ascending) and
    // the 24 h outlier feed (|T+0 PnL| descending), ties in row order.
    let win_sel: Vec<Vec<Cand>> = winners.into_iter().map(|v| top(v, TOP_SWAPS, |a, b| b.0 - a.0)).collect();
    let los_sel: Vec<Vec<Cand>> = losers.into_iter().map(|v| top(v, TOP_SWAPS, |a, b| a.0 - b.0)).collect();
    let out_sel = top(outs, OUTLIERS, |a, b| b.0.abs() - a.0.abs());

    let mut want: IndexSet<&str> = IndexSet::new();
    for sel in win_sel.iter().chain(&los_sel).chain(std::iter::once(&out_sel)) {
        want.extend(sel.iter().map(|&(_, i)| rows[i].id.as_str()));
    }
    let want: Vec<String> = want.into_iter().map(str::to_string).collect();
    let by_id: HashMap<String, Fill> = full_fills(&want).into_iter().map(|f| (f.id.clone(), f)).collect();
    let resolve =
        |sel: &[Cand]| -> Vec<Fill> { sel.iter().filter_map(|&(_, i)| by_id.get(&rows[i].id).cloned()).collect() };

    let top_swaps = hz
        .iter()
        .enumerate()
        .map(|(h, hi)| (hi.to_string(), TopSwaps { winners: resolve(&win_sel[h]), losers: resolve(&los_sel[h]) }))
        .collect();

    LeaderboardResponse {
        days,
        generated_at: now_ms,
        total_fills: rows.len() as u64,
        groups,
        top_swaps,
        outliers: resolve(&out_sel),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, ts: f64, to: &str, usd: f64, mk: Option<f64>) -> LbRow {
        LbRow {
            id: id.into(),
            ts,
            venue_id: "v".into(),
            market: "MON/USDC".into(),
            category: FillCategory::Direct,
            pool: "p".into(),
            to: to.into(),
            usd,
            markouts_bps: vec![mk, None, mk, mk, mk],
        }
    }

    #[test]
    fn ties_keep_first_seen_order_and_spark_ends_at_the_total() {
        let rows: Vec<LbRow> =
            (0..13).map(|i| row(&format!("f{i:02}"), i as f64, &format!("t{i:02}"), 10.0, Some(1.0))).collect();
        let lb = compute_leaderboard(&rows, 1, 100.0, |_| Vec::new());
        let to = &lb.groups["to"]["0"];
        assert_eq!(to.len(), 12);
        assert!(to.iter().enumerate().all(|(i, r)| r.key == format!("t{i:02}")));
        let cat = &lb.groups["category"]["0"][0];
        assert_eq!((cat.key.as_str(), cat.swaps), ("direct", 13));
        assert_eq!(cat.spark.len(), 13);
        assert_eq!(*cat.spark.last().unwrap(), cat.pnl);
        let pool = &lb.groups["pool"]["0"][0];
        assert_eq!((pool.venue_id.as_deref(), pool.market.as_deref()), (Some("v"), Some("MON/USDC")));
        assert!(lb.groups["protocol"]["0"][0].venue_id.is_none());
    }

    #[test]
    fn missing_markouts_stay_out_and_zero_pnl_is_neither_winner_nor_loser() {
        let rows = vec![row("a", 0.0, "x", 10.0, None), row("b", 1.0, "x", 10.0, Some(0.0))];
        let lb = compute_leaderboard(&rows, 1, 100.0, |ids| {
            assert_eq!(ids, ["b"]);
            Vec::new()
        });
        assert_eq!(lb.total_fills, 2);
        assert_eq!(lb.groups["to"]["0"][0].swaps, 1);
        assert!(lb.groups["to"]["2"][0].swaps == 1 && lb.top_swaps["0"].winners.is_empty());
    }
}
