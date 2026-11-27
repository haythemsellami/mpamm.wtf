//! `parity`: the shadow run's daily check (docs/rebuild-plan.md → M8). The
//! service's trades over a block window are diffed against production's
//! public `/api/fills` for the same window, venue by venue: ids first, then
//! every field production and the service both define.
//!
//! What is compared, and why some fields aren't:
//! - ids, market, side, category, pxApprox, pool, to, router, txHash and the
//!   block number must be identical;
//! - baseAmount and execPx come from the logs alone: equal to 1e-12;
//! - usd on a stable-quoted market is exact (1e-9); on a crypto-quoted one
//!   each side priced the quote token at its own moment (production when it
//!   decoded, the service at the block's proposal), so it is compared within
//!   a tolerance, and a gap past it but under `drift_max` is reported as
//!   drift, not failed (the first shadow hour's three were production's:
//!   MON/USDC trades in the same second sided with the service's price);
//! - ts and markouts differ by design (the service stamps the proposal time
//!   and marks from it), so they are not compared.
//!
//! The window is a block range both sides have finished: from `--from-block`
//! (default: the later of the two sides' earliest trade) to the earlier of
//! the two sides' newest trade, minus a margin for production's tail lag.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use mpamm_types::{DailyVolume, Fill, VenueDaily};

/// Markets quoted in a dollar stable: their USD is the quote amount itself.
const STABLES: [&str; 4] = ["USDC", "USDT0", "AUSD", "USD1"];

#[derive(Debug, Clone, Copy)]
pub struct Window {
    pub from: u64,
    pub to: u64,
}

impl Window {
    fn contains(&self, b: u64) -> bool {
        (self.from..=self.to).contains(&b)
    }

    /// The default window: both sides' common span, `margin` blocks short of
    /// the newer end (production's tail can be a few blocks behind).
    pub fn common(prod: &[Fill], local: &[Fill], from: Option<u64>, margin: u64) -> Option<Self> {
        let (pmin, pmax) = span(prod)?;
        let (lmin, lmax) = span(local)?;
        let from = from.unwrap_or(pmin.max(lmin));
        let to = pmax.min(lmax).saturating_sub(margin);
        (from <= to).then_some(Self { from, to })
    }
}

fn span(f: &[Fill]) -> Option<(u64, u64)> {
    let min = f.iter().map(|f| f.block_number).min()?;
    Some((min, f.iter().map(|f| f.block_number).max()?))
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct VenueReport {
    pub prod: usize,
    pub local: usize,
    pub matched: usize,
    pub only_prod: Vec<String>,
    pub only_local: Vec<String>,
    /// (id, field, production, service)
    pub diffs: Vec<(String, &'static str, String, String)>,
    /// Crypto-quoted USD priced at different moments: (id, production,
    /// service). Shown, never a failure.
    pub drift: Vec<(String, f64, f64)>,
    pub prod_usd: f64,
    pub local_usd: f64,
}

impl VenueReport {
    pub fn clean(&self) -> bool {
        self.only_prod.is_empty() && self.only_local.is_empty() && self.diffs.is_empty()
    }
}

fn rel(a: f64, b: f64) -> f64 {
    if a == b {
        return 0.0;
    }
    (a - b).abs() / a.abs().max(b.abs()).max(1e-300)
}

/// Field differences between production's and the service's copy of a trade.
pub fn field_diffs(p: &Fill, l: &Fill, usd_tolerance: f64) -> Vec<(&'static str, String, String)> {
    let mut d = Vec::new();
    let mut eq = |name: &'static str, a: String, b: String| {
        if a != b {
            d.push((name, a, b));
        }
    };
    eq("market", p.market.clone(), l.market.clone());
    eq("side", format!("{:?}", p.side), format!("{:?}", l.side));
    eq("category", format!("{:?}", p.category), format!("{:?}", l.category));
    eq("pxApprox", p.px_approx.to_string(), l.px_approx.to_string());
    eq("pool", p.pool.to_lowercase(), l.pool.to_lowercase());
    eq("to", p.to.clone(), l.to.clone());
    eq("router", format!("{:?}", p.router), format!("{:?}", l.router));
    eq("txHash", p.tx_hash.to_lowercase(), l.tx_hash.to_lowercase());
    eq("blockNumber", p.block_number.to_string(), l.block_number.to_string());
    let crypto_quoted = p.market.split('/').nth(1).is_some_and(|q| !STABLES.contains(&q));
    let num = [
        ("baseAmount", p.base_amount, l.base_amount, 1e-12),
        ("execPx", p.exec_px, l.exec_px, if crypto_quoted && p.px_approx { usd_tolerance } else { 1e-12 }),
        ("usd", p.usd, l.usd, if crypto_quoted { usd_tolerance } else { 1e-9 }),
    ];
    for (name, a, b, tol) in num {
        if rel(a, b) > tol {
            d.push((name, a.to_string(), b.to_string()));
        }
    }
    d
}

/// Diffs the two sides inside `window`, per venue. `venues` limits the
/// comparison to the venues the service runs (production's others are not
/// a difference).
pub fn compare(
    prod: &[Fill],
    local: &[Fill],
    window: Window,
    venues: &BTreeSet<String>,
    usd_tolerance: f64,
    drift_max: f64,
) -> BTreeMap<String, VenueReport> {
    let keep = |f: &&Fill| window.contains(f.block_number) && venues.contains(&f.venue_id);
    let p: HashMap<&str, &Fill> = prod.iter().filter(keep).map(|f| (f.id.as_str(), f)).collect();
    let l: HashMap<&str, &Fill> = local.iter().filter(keep).map(|f| (f.id.as_str(), f)).collect();
    let mut out: BTreeMap<String, VenueReport> = venues.iter().map(|v| (v.clone(), VenueReport::default())).collect();
    for f in p.values() {
        let r = out.get_mut(&f.venue_id).unwrap();
        r.prod += 1;
        r.prod_usd += f.usd;
        match l.get(f.id.as_str()) {
            Some(x) => {
                r.matched += 1;
                let crypto_quoted = f.market.split('/').nth(1).is_some_and(|q| !STABLES.contains(&q));
                for (field, a, b) in field_diffs(f, x, usd_tolerance) {
                    if field == "usd" && crypto_quoted && rel(f.usd, x.usd) <= drift_max {
                        r.drift.push((f.id.clone(), f.usd, x.usd));
                    } else {
                        r.diffs.push((f.id.clone(), field, a, b));
                    }
                }
            }
            None => r.only_prod.push(f.id.clone()),
        }
    }
    for f in l.values() {
        let r = out.get_mut(&f.venue_id).unwrap();
        r.local += 1;
        r.local_usd += f.usd;
        if !p.contains_key(f.id.as_str()) {
            r.only_local.push(f.id.clone());
        }
    }
    for r in out.values_mut() {
        r.only_prod.sort();
        r.only_local.sort();
        r.diffs.sort();
        r.drift.sort_by(|a, b| a.0.cmp(&b.0));
    }
    out
}

/// UTC days the service holds whole: after the day of its first trade and
/// before today.
pub fn full_days(local: &[Fill], today: &str) -> BTreeSet<String> {
    let Some(first) = local.iter().map(|f| f.ts).reduce(f64::min) else { return BTreeSet::new() };
    let start = mpamm_types::utc_day(first);
    let mut out = BTreeSet::new();
    let mut t = first;
    loop {
        t += 86_400_000.0;
        let d = mpamm_types::utc_day(t);
        if d.as_str() >= today {
            break;
        }
        if d != start {
            out.insert(d);
        }
    }
    out
}

/// A venue-day whose volume differs: (day, venue, production, service).
pub type DayDiff = (String, String, Option<VenueDaily>, Option<VenueDaily>);

/// Per venue-day volume on the given days: swap counts exact, USD within
/// `usd_tolerance` (a day mixes stable- and crypto-quoted trades).
pub fn compare_volume(
    prod: &[DailyVolume],
    local: &[DailyVolume],
    days: &BTreeSet<String>,
    venues: &BTreeSet<String>,
    usd_tolerance: f64,
) -> Vec<DayDiff> {
    let get = |rows: &[DailyVolume], day: &str, v: &str| {
        rows.iter().find(|r| r.utc_day == day).and_then(|r| r.by_venue.get(v).copied())
    };
    let mut out = Vec::new();
    for day in days {
        for v in venues {
            let (p, l) = (get(prod, day, v), get(local, day, v));
            let same = match (p, l) {
                (None, None) => true,
                (Some(a), Some(b)) => a.swaps == b.swaps && rel(a.usd, b.usd) <= usd_tolerance,
                _ => false,
            };
            if !same {
                out.push((day.clone(), v.clone(), p, l));
            }
        }
    }
    out
}

/// The volume report; `true` when every venue-day matches.
pub fn print_volume(days: &BTreeSet<String>, diffs: &[DayDiff]) -> bool {
    if days.is_empty() {
        println!("volume: no whole UTC day in the service's history yet");
        return true;
    }
    println!("volume: {} whole day(s), {} to {}", days.len(), days.first().unwrap(), days.last().unwrap());
    let show = |v: &Option<VenueDaily>| v.map_or("-".into(), |v| format!("{} swaps ${:.2}", v.swaps, v.usd));
    for (day, venue, p, l) in diffs {
        println!("{day} {venue}: production {}, service {}", show(p), show(l));
    }
    println!("{}", if diffs.is_empty() { "VOLUME IDENTICAL" } else { "VOLUME DIFFERS" });
    diffs.is_empty()
}

/// The report as the operator reads it; `true` when every venue is clean.
pub fn print(window: Window, reports: &BTreeMap<String, VenueReport>) -> bool {
    println!("blocks {}..={}", window.from, window.to);
    println!(
        "{:<12} {:>7} {:>7} {:>7} {:>6} {:>6} {:>6} {:>16} {:>16}",
        "venue", "prod", "local", "match", "-prod", "-local", "diffs", "prod usd", "local usd"
    );
    for (v, r) in reports {
        println!(
            "{:<12} {:>7} {:>7} {:>7} {:>6} {:>6} {:>6} {:>16.2} {:>16.2}",
            v,
            r.prod,
            r.local,
            r.matched,
            r.only_prod.len(),
            r.only_local.len(),
            r.diffs.len(),
            r.prod_usd,
            r.local_usd
        );
    }
    for (v, r) in reports {
        for id in r.only_prod.iter().take(10) {
            println!("{v}: only in production: {id}");
        }
        for id in r.only_local.iter().take(10) {
            println!("{v}: only in the service: {id}");
        }
        for (id, field, a, b) in r.diffs.iter().take(20) {
            println!("{v}: {id} {field}: production {a}, service {b}");
        }
        for (id, a, b) in r.drift.iter().take(10) {
            println!(
                "{v}: {id} usd priced at another moment: production {a}, service {b} ({:+.2}%)",
                (b / a - 1.0) * 100.0
            );
        }
    }
    let ok = reports.values().all(VenueReport::clean);
    println!("{}", if ok { "IDENTICAL" } else { "DIFFERENCES" });
    ok
}

#[cfg(test)]
mod tests {
    use mpamm_types::{FillCategory, Side};

    use super::*;

    fn fill(id: &str, venue: &str, market: &str, block: u64, usd: f64) -> Fill {
        Fill {
            id: id.into(),
            venue_id: venue.into(),
            market: market.into(),
            side: Side::Buy,
            category: FillCategory::Direct,
            usd,
            base_amount: 10.0,
            exec_px: 0.5, // in the quote token: independent of USD on a crypto-quoted market
            px_approx: false,
            tx_hash: "0xAB".into(),
            to: "taker".into(),
            router: None,
            pool: "0xPool".into(),
            block_number: block,
            ts: 1.0,
            markouts_bps: vec![],
            time_source: None,
        }
    }

    fn venues(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_window_is_the_common_span_short_of_the_margin() {
        let p = [fill("a", "x", "MON/USDC", 100, 1.0), fill("b", "x", "MON/USDC", 200, 1.0)];
        let l = [fill("c", "x", "MON/USDC", 120, 1.0), fill("d", "x", "MON/USDC", 210, 1.0)];
        let w = Window::common(&p, &l, None, 5).unwrap();
        assert_eq!((w.from, w.to), (120, 195));
        assert_eq!(Window::common(&p, &l, Some(90), 0).unwrap().from, 90);
        assert!(Window::common(&p, &[], None, 0).is_none());
    }

    #[test]
    fn ids_fields_and_usd_by_quote_kind() {
        let w = Window { from: 0, to: 1000 };
        let mut p = vec![
            fill("same", "x", "MON/USDC", 10, 5.0),
            fill("gone", "x", "MON/USDC", 11, 5.0),
            fill("drift", "x", "WBTC/MON", 12, 100.0),
            fill("far", "x", "WBTC/MON", 13, 100.0),
            fill("moved", "x", "WBTC/MON", 17, 100.0),
            fill("stable", "x", "MON/USDC", 14, 5.0),
            fill("other-venue", "y", "MON/USDC", 15, 5.0),
            fill("late", "x", "MON/USDC", 2000, 5.0),
        ];
        let mut l = vec![
            fill("same", "x", "MON/USDC", 10, 5.0),
            fill("extra", "x", "MON/USDC", 16, 5.0),
            fill("drift", "x", "WBTC/MON", 12, 100.1),
            fill("far", "x", "WBTC/MON", 13, 101.0),
            fill("moved", "x", "WBTC/MON", 17, 100.3),
            fill("stable", "x", "MON/USDC", 14, 5.0001),
        ];
        p[0].pool = "0xPOOL".into(); // case never matters for hex
        l[0].tx_hash = "0xab".into();
        let r = compare(&p, &l, w, &venues(&["x"]), 0.002, 0.005);
        assert_eq!(r.len(), 1, "venue y isn't run by the service");
        let x = &r["x"];
        assert_eq!((x.prod, x.local, x.matched), (6, 6, 5));
        assert_eq!(x.only_prod, ["gone"]);
        assert_eq!(x.only_local, ["extra"]);
        let fields: Vec<(&str, &str)> = x.diffs.iter().map(|d| (d.0.as_str(), d.1)).collect();
        // drift: 0.1% on a MON-quoted market is within tolerance; moved
        // 0.3% is drift (shown, not failed); far is 1%; a stable-quoted
        // market's USD is exact.
        assert_eq!(fields, [("far", "usd"), ("stable", "usd")]);
        assert_eq!(x.drift.iter().map(|d| d.0.as_str()).collect::<Vec<_>>(), ["moved"]);
        assert!(!x.clean());
    }

    #[test]
    fn whole_days_and_volume_per_venue_day() {
        // First trade 2026-11-27 09:04 UTC; today 2026-11-30.
        let mut f = fill("a", "x", "MON/USDC", 1, 1.0);
        f.ts = 1_795_770_270_000.0;
        let days = full_days(&[f], "2026-11-30");
        assert_eq!(days.iter().map(String::as_str).collect::<Vec<_>>(), ["2026-11-28", "2026-11-29"]);
        assert!(full_days(&[], "2026-11-30").is_empty());

        let day = |d: &str, rows: &[(&str, u64, f64)]| DailyVolume {
            utc_day: d.into(),
            by_venue: rows
                .iter()
                .map(|(v, swaps, usd)| (v.to_string(), VenueDaily { swaps: *swaps, usd: *usd }))
                .collect(),
            partial: false,
        };
        let prod = [day("2026-11-28", &[("x", 10, 1000.0), ("y", 5, 50.0)]), day("2026-11-29", &[("x", 3, 30.0)])];
        let local = [day("2026-11-28", &[("x", 10, 1000.5)]), day("2026-11-29", &[("x", 4, 30.0), ("z", 1, 1.0)])];
        let diffs = compare_volume(&prod, &local, &days, &venues(&["x", "z"]), 0.002);
        let got: Vec<(&str, &str)> = diffs.iter().map(|d| (d.0.as_str(), d.1.as_str())).collect();
        // 0.05% USD drift is within tolerance; a swap count never is; a venue
        // only one side has differs; y isn't run by the service.
        assert_eq!(got, [("2026-11-29", "x"), ("2026-11-29", "z")]);
        assert!(!print_volume(&days, &diffs));
        assert!(print_volume(&BTreeSet::new(), &[]));
    }

    #[test]
    fn identical_sides_are_clean_and_counted() {
        let w = Window { from: 0, to: 100 };
        let p = [fill("a", "x", "MON/USDC", 1, 2.0), fill("b", "x", "MON/AUSD", 2, 3.0)];
        let r = compare(&p, &p, w, &venues(&["x", "z"]), 0.002, 0.01);
        assert!(r.values().all(VenueReport::clean));
        assert_eq!(r["x"].matched, 2);
        assert_eq!(r["x"].prod_usd, 5.0);
        assert_eq!(r["z"], VenueReport::default(), "a venue with no trades on either side is clean");
        assert!(print(w, &r));
    }
}
