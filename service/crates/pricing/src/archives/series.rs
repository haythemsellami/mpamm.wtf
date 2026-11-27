//! Price series read from the archives, ported from server/src/history/cex.ts.
//!
//! A markout series is a carry-forward step series with a staleness cap:
//! `at(t)` is the last print at or before `t`, or `None` when there is none
//! within the cap, or when that print is an outage marker (NaN: the book was
//! one-sided or crossed from then). A gap yields a null markout, never a
//! fabricated one.
//!
//! A closed day's asset price (`DayPrices`) always answers instead: a trade
//! has to be valued, where a markout can be left out.

/// A base leg (book mids, 1-second klines): two minutes without a print is no
/// price.
pub const STALE_BASE_MS: f64 = 120_000.0;
/// Cross and wrap legs (1-minute klines, or a quiet stable book that records
/// only changes).
pub const STALE_SLOW_MS: f64 = 30.0 * 60_000.0;
/// Two kline closes further apart than this are not joined by a line: the
/// exchange was down in between, and the last close before it is carried.
pub const KLINE_JOIN_MS: f64 = 2.0 * 60_000.0;

/// Raw points of a series: times (epoch ms, ascending) and prices; a NaN
/// price marks that the source had no price from that time.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Points {
    pub ts: Vec<f64>,
    pub px: Vec<f64>,
}

impl Points {
    pub fn len(&self) -> usize {
        self.ts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ts.is_empty()
    }

    pub fn push(&mut self, t: f64, px: f64) {
        self.ts.push(t);
        self.px.push(px);
    }

    /// The points with `from <= t < to`, appended to `self` (days are
    /// appended in order, so the result stays sorted).
    pub fn extend_within(&mut self, other: &Points, from: f64, to: f64) {
        let lo = other.ts.partition_point(|&t| t < from);
        let hi = other.ts.partition_point(|&t| t < to);
        self.ts.extend_from_slice(&other.ts[lo..hi]);
        self.px.extend_from_slice(&other.px[lo..hi]);
    }

    /// Index of the last point at or before `t`.
    fn last_at_or_before(&self, t: f64) -> Option<usize> {
        self.ts.partition_point(|&x| x <= t).checked_sub(1)
    }
}

/// Carry-forward with a staleness cap.
#[derive(Debug, Clone, PartialEq)]
pub struct StepSeries {
    pub points: Points,
    pub stale_ms: f64,
}

impl StepSeries {
    pub fn new(points: Points, stale_ms: f64) -> Self {
        Self { points, stale_ms }
    }

    /// The print in effect at `t`: the last at or before it, if no older than
    /// the cap and not an outage marker.
    pub fn at(&self, t: f64) -> Option<f64> {
        let i = self.points.last_at_or_before(t)?;
        if t - self.points.ts[i] > self.stale_ms {
            return None;
        }
        let px = self.points.px[i];
        (!px.is_nan()).then_some(px)
    }
}

/// One asset's USD price across one UTC day, from the archives: what a
/// history replay values a crypto-quoted trade with (`assetUsdDay`).
#[derive(Debug, Clone, PartialEq)]
pub struct DayPrices {
    points: Points,
    /// Join consecutive closes by a straight line (Binance 1-minute closes);
    /// otherwise the last price at or before the time (a book's mids).
    join: bool,
}

impl DayPrices {
    /// Outage markers are dropped: the price before one is carried over it.
    /// `None` when no price is left.
    pub fn new(points: &Points, join: bool) -> Option<Self> {
        let mut kept = Points::default();
        for (t, px) in points.ts.iter().zip(&points.px) {
            if *px > 0.0 {
                kept.push(*t, *px);
            }
        }
        (!kept.is_empty()).then_some(Self { points: kept, join })
    }

    /// The price at `t`. Before the day's first price, that first price; no
    /// staleness cap (through an outage the last price before it is still far
    /// nearer the trade than the day of the replay).
    pub fn at(&self, t: f64) -> f64 {
        let (ts, px) = (&self.points.ts, &self.points.px);
        let Some(i) = self.points.last_at_or_before(t) else { return px[0] };
        let next = i + 1;
        if !self.join || next >= ts.len() || ts[next] - ts[i] > KLINE_JOIN_MS {
            return px[i];
        }
        px[i] + (px[next] - px[i]) * (t - ts[i]) / (ts[next] - ts[i])
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts(v: &[(f64, f64)]) -> Points {
        let mut p = Points::default();
        for &(t, px) in v {
            p.push(t, px);
        }
        p
    }

    #[test]
    fn carries_forward_within_the_cap() {
        let s = StepSeries::new(pts(&[(1_000.0, 10.0), (2_000.0, 11.0), (2_000.0, 12.0), (5_000.0, 13.0)]), 1_500.0);
        assert_eq!(s.at(999.0), None, "before the first print");
        assert_eq!(s.at(1_000.0), Some(10.0), "at a print's own time");
        assert_eq!(s.at(1_999.9), Some(10.0));
        assert_eq!(s.at(2_000.0), Some(12.0), "the last of equal times");
        assert_eq!(s.at(3_500.0), Some(12.0), "exactly at the cap");
        assert_eq!(s.at(3_500.1), None, "past the cap: no price, never the carried one");
        assert_eq!(s.at(5_000.0), Some(13.0));
        assert_eq!(s.at(1e12), None);
    }

    #[test]
    fn an_outage_marker_reads_none_until_the_next_print() {
        let s = StepSeries::new(pts(&[(1_000.0, 10.0), (2_000.0, f64::NAN), (9_000.0, 10.0)]), f64::INFINITY);
        assert_eq!(s.at(1_500.0), Some(10.0));
        assert_eq!(s.at(2_000.0), None, "not the price before the outage");
        assert_eq!(s.at(8_999.0), None);
        assert_eq!(s.at(9_000.0), Some(10.0));
        let empty = StepSeries::new(Points::default(), f64::INFINITY);
        assert_eq!(empty.at(0.0), None);
    }

    #[test]
    fn extend_within_keeps_order_and_bounds() {
        let day1 = pts(&[(1.0, 1.0), (5.0, 2.0), (9.0, 3.0)]);
        let day2 = pts(&[(10.0, 4.0), (15.0, 5.0)]);
        let mut p = Points::default();
        p.extend_within(&day1, 5.0, 12.0);
        p.extend_within(&day2, 5.0, 12.0);
        assert_eq!(p.ts, vec![5.0, 9.0, 10.0]);
        assert_eq!(p.px, vec![2.0, 3.0, 4.0]);
    }

    #[test]
    fn day_prices_join_kline_closes_and_carry_book_mids() {
        const MIN: f64 = 60_000.0;
        let closes = pts(&[(MIN - 1.0, 100.0), (2.0 * MIN - 1.0, 101.0), (9.0 * MIN - 1.0, 110.0)]);
        let k = DayPrices::new(&closes, true).unwrap();
        assert_eq!(k.at(0.0), 100.0, "before the first close: the first price");
        assert_eq!(k.at(MIN - 1.0), 100.0);
        assert!((k.at(1.5 * MIN - 1.0) - 100.5).abs() < 1e-12, "halfway along the line");
        assert_eq!(k.at(2.0 * MIN - 1.0), 101.0);
        assert_eq!(k.at(5.0 * MIN), 101.0, "closes 7 minutes apart are not joined");
        assert_eq!(k.at(1e15), 110.0, "the last close carries to the end");
        let book = pts(&[(1_000.0, 0.03), (2_000.0, f64::NAN), (3_000.0, 0.04)]);
        let b = DayPrices::new(&book, false).unwrap();
        assert_eq!(b.len(), 2, "outage markers dropped");
        assert_eq!(b.at(2_500.0), 0.03, "carried over the outage");
        assert_eq!(b.at(2_999.0), 0.03, "a book is never joined");
        assert_eq!(b.at(3_000.0), 0.04);
        assert!(DayPrices::new(&pts(&[(1.0, f64::NAN)]), false).is_none());
    }
}
