//! Markouts (docs/rebuild-spec.md → Markouts): each trade is marked against
//! its pair's reference mid at each horizon (0, 5, 10, 30, 60 s) and, once,
//! along its curve (−5 s … +15 s). TAKER-signed bps:
//! side × (mid / execPx − 1) × 10⁴.
//!
//! The mark is the reference in effect at the mark time, read from the
//! exchange history (every update, not today's 100 ms samples), so it is
//! taken once the mark time is safely past (`settle_ms`). A trade with its
//! proposal time is marked at that time exactly; one stamped with a whole
//! block second (repaired over RPC, or migrated) keeps today's convention:
//! horizons at the second, curve points at its middle. A mark the history
//! can't give (before it starts, during an outage) stays null, never 0.
//! Approximate-price trades are never marked.

pub mod archive;

use mpamm_registry::Registry;
use mpamm_types::{Fill, Side, TimeSource, CURVE_OFFSETS_S, CURVE_SECOND_MID_MS, MARKOUT_HORIZONS_S};

/// JavaScript's `Math.round` (halves round toward +∞), for rounded outputs
/// that must match today's.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// TAKER-signed markout in bps; `None` without an honest mid.
pub fn markout_bps(side: Side, exec_px: f64, mid: f64) -> Option<f64> {
    if !(mid > 0.0 && exec_px > 0.0) {
        return None;
    }
    let s = if side == Side::Buy { 1.0 } else { -1.0 };
    Some(s * (mid / exec_px - 1.0) * 1e4)
}

fn precise(f: &Fill) -> bool {
    matches!(f.time_source, Some(TimeSource::Proposal) | None)
}

/// When horizon `h` (seconds) of a trade is marked.
pub fn horizon_mark_ms(f: &Fill, h: u32) -> f64 {
    f.ts + f64::from(h) * 1000.0
}

/// When curve offset `o` (seconds) of a trade is marked.
pub fn curve_mark_ms(f: &Fill, o: i32) -> f64 {
    let base = if precise(f) { f.ts } else { f.ts + CURVE_SECOND_MID_MS };
    base + f64::from(o) * 1000.0
}

/// TAKER-signed curve points rounded to 0.01 bp, as today's `curvePoints`.
pub fn curve_points(f: &Fill, mid_at: impl Fn(f64) -> Option<f64>) -> Vec<Option<f64>> {
    let s = if f.side == Side::Buy { 1.0 } else { -1.0 };
    CURVE_OFFSETS_S
        .iter()
        .map(|o| {
            let mid = mid_at(curve_mark_ms(f, *o))?;
            (mid > 0.0 && f.exec_px > 0.0).then(|| js_round(s * (mid / f.exec_px - 1.0) * 1e6) / 100.0)
        })
        .collect()
}

pub fn curve_complete(curve: &[Option<f64>]) -> bool {
    curve.len() == CURVE_OFFSETS_S.len() && curve.iter().all(|v| v.is_some_and(f64::is_finite))
}

/// What one tick decided for a trade.
#[derive(Debug, Clone, PartialEq)]
pub struct Update {
    pub id: String,
    /// The trade's markouts, when a horizon was marked this tick.
    pub markouts: Option<Vec<Option<f64>>>,
    /// The complete curve, the one time it is taken.
    pub curve: Option<Vec<f64>>,
}

struct Pending {
    fill: Fill,
    horizons_done: bool,
    curve_done: bool,
}

/// Trades whose horizons or curve are still ahead.
pub struct Aging {
    pending: Vec<Pending>,
    /// A mark is taken this long after its time, so every exchange update up
    /// to it has arrived.
    pub settle_ms: f64,
}

impl Default for Aging {
    fn default() -> Self {
        Self { pending: Vec::new(), settle_ms: 500.0 }
    }
}

impl Aging {
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Starts aging a committed trade (unless it can never be marked).
    pub fn add(&mut self, registry: &Registry, f: &Fill) {
        if f.px_approx || registry.pair_of(&f.market).is_none() {
            return;
        }
        let mut fill = f.clone();
        fill.markouts_bps.resize(MARKOUT_HORIZONS_S.len(), None);
        self.pending.push(Pending { fill, horizons_done: false, curve_done: false });
    }

    /// Marks every horizon and curve whose time has settled. `mid_at` is the
    /// pair's reference mid at a past time (`None` when the history can't say).
    pub fn tick(&mut self, now_ms: f64, mid_at: impl Fn(&str, f64) -> Option<f64>) -> Vec<Update> {
        let settle = self.settle_ms;
        let mut out = Vec::new();
        for p in &mut self.pending {
            let f = &mut p.fill;
            let mut changed = false;
            if !p.horizons_done {
                let mut all_past = true;
                for (i, h) in MARKOUT_HORIZONS_S.iter().enumerate() {
                    if f.markouts_bps[i].is_some() {
                        continue;
                    }
                    let at = horizon_mark_ms(f, *h);
                    if now_ms < at + settle {
                        all_past = false;
                        continue;
                    }
                    if let Some(bps) = mid_at(&f.market, at).and_then(|m| markout_bps(f.side, f.exec_px, m)) {
                        f.markouts_bps[i] = Some(bps);
                        changed = true;
                    }
                }
                p.horizons_done = all_past;
            }
            let mut curve = None;
            let last = *CURVE_OFFSETS_S.last().unwrap();
            if !p.curve_done && now_ms >= curve_mark_ms(f, last) + settle {
                p.curve_done = true;
                let pts = curve_points(f, |t| mid_at(&f.market, t));
                if curve_complete(&pts) {
                    curve = Some(pts.into_iter().map(|v| v.unwrap()).collect());
                }
            }
            if changed || curve.is_some() {
                out.push(Update { id: f.id.clone(), markouts: changed.then(|| f.markouts_bps.clone()), curve });
            }
        }
        self.pending.retain(|p| !(p.horizons_done && p.curve_done));
        out
    }
}

#[cfg(test)]
mod tests {
    use mpamm_types::FillCategory;

    use super::*;

    fn fill(side: Side, ts: f64, src: TimeSource) -> Fill {
        Fill {
            id: "t".into(),
            venue_id: "v".into(),
            market: "MON/USDC".into(),
            side,
            category: FillCategory::Direct,
            usd: 10.0,
            base_amount: 100.0,
            exec_px: 0.1,
            px_approx: false,
            tx_hash: "0x".into(),
            to: "x".into(),
            router: None,
            pool: "p".into(),
            block_number: 1,
            ts,
            markouts_bps: vec![None; 5],
            time_source: Some(src),
        }
    }

    #[test]
    fn signs_rounding_and_mark_times() {
        assert_eq!(markout_bps(Side::Buy, 0.1, 0.101), Some((0.101 / 0.1 - 1.0) * 1e4));
        assert_eq!(markout_bps(Side::Sell, 0.1, 0.101), Some(-(0.101 / 0.1 - 1.0) * 1e4));
        assert_eq!(markout_bps(Side::Buy, 0.1, 0.0), None);
        assert_eq!(js_round(-2.5), -2.0, "JavaScript rounds halves toward +∞");
        assert_eq!(js_round(2.5), 3.0);
        let p = fill(Side::Buy, 1_000.0, TimeSource::Proposal);
        let b = fill(Side::Buy, 1_000.0, TimeSource::Block);
        assert_eq!((curve_mark_ms(&p, -5), curve_mark_ms(&b, -5)), (-4_000.0, -3_500.0));
        assert_eq!(horizon_mark_ms(&p, 5), 6_000.0);
    }

    #[test]
    fn horizons_and_curve_age_and_leave() {
        let reg = Registry::get();
        let mut a = Aging::default();
        let t0 = 100_000.0;
        a.add(reg, &fill(Side::Buy, t0, TimeSource::Proposal));
        let mut approx = fill(Side::Buy, t0, TimeSource::Proposal);
        approx.px_approx = true;
        a.add(reg, &approx);
        assert_eq!(a.len(), 1, "approximate prices are never marked");
        // The reference drifts +1 bp a second; a gap from t0+20 s to t0+40 s.
        let mid = |_: &str, t: f64| {
            let s = (t - t0) / 1000.0;
            (!(20.0..40.0).contains(&s)).then_some(0.1 * (1.0 + s * 1e-4))
        };
        let u = a.tick(t0 + 400.0, mid);
        assert!(u.is_empty(), "nothing settled yet");
        let u = a.tick(t0 + 600.0, mid);
        assert_eq!(u.len(), 1);
        let mk = u[0].markouts.as_ref().unwrap();
        assert!((mk[0].unwrap() - 0.0).abs() < 1e-9 && mk[1].is_none());
        let u = a.tick(t0 + 16_000.0, mid);
        let mk = u[0].markouts.as_ref().unwrap();
        assert!((mk[1].unwrap() - 5.0).abs() < 1e-6 && (mk[2].unwrap() - 10.0).abs() < 1e-6);
        let curve = u[0].curve.as_ref().expect("the curve is taken once complete");
        assert_eq!(curve.len(), 14);
        assert_eq!(curve[0], -5.0, "−5 s: the reference was 5 bp lower");
        assert_eq!(curve[13], 15.0);
        let u = a.tick(t0 + 61_000.0, mid);
        let mk = u[0].markouts.as_ref().unwrap();
        assert!(mk[3].is_none(), "30 s fell in the gap: null, not 0");
        assert!((mk[4].unwrap() - 60.0).abs() < 1e-6);
        assert!(a.is_empty(), "every horizon past and the curve taken");
    }

    #[test]
    fn an_incomplete_curve_is_not_kept() {
        let reg = Registry::get();
        let mut a = Aging::default();
        a.add(reg, &fill(Side::Sell, 10_000.0, TimeSource::Block));
        let u = a.tick(100_000.0, |_, t| (t > 8_000.0).then_some(0.1));
        assert!(u.iter().all(|x| x.curve.is_none()), "the −5 s point had no history");
        assert!(a.is_empty());
    }
}
