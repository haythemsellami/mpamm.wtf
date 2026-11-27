//! Every mid an exchange symbol had, with its time, for the last couple of
//! hours: what a block decoded late is priced from (as of its own proposal
//! time), and what markouts are marked against.

use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct MidHistory {
    points: VecDeque<(f64, f64)>,
    keep_ms: f64,
    max_points: usize,
}

impl MidHistory {
    pub fn new(keep_ms: f64, max_points: usize) -> Self {
        Self { points: VecDeque::new(), keep_ms, max_points }
    }

    /// Records the mid at `t_ms` (only when it changed, and never backwards
    /// in time).
    pub fn push(&mut self, t_ms: f64, mid: f64) {
        if mid.is_nan() || mid <= 0.0 || !mid.is_finite() {
            return;
        }
        if let Some(&(lt, lm)) = self.points.back() {
            if t_ms < lt || lm == mid {
                return;
            }
        }
        self.points.push_back((t_ms, mid));
        while self.points.len() > self.max_points || self.points.front().is_some_and(|&(t, _)| t < t_ms - self.keep_ms)
        {
            self.points.pop_front();
        }
    }

    /// The mid in effect at `t_ms` (the last one at or before it), if it was
    /// set no more than `stale_ms` earlier. `None` before the history starts.
    pub fn at(&self, t_ms: f64, stale_ms: f64) -> Option<f64> {
        let i = self.points.partition_point(|&(t, _)| t <= t_ms);
        if i == 0 {
            return None;
        }
        let (t, m) = self.points[i - 1];
        (t_ms - t <= stale_ms).then_some(m)
    }

    /// Whether the history reaches back to `t_ms`.
    pub fn covers(&self, t_ms: f64) -> bool {
        self.points.front().is_some_and(|&(t, _)| t <= t_ms)
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub fn latest(&self) -> Option<(f64, f64)> {
        self.points.back().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_forward_with_a_staleness_cap() {
        let mut h = MidHistory::new(10_000.0, 100);
        h.push(1_000.0, 10.0);
        h.push(1_500.0, 10.0); // unchanged: not stored
        h.push(2_000.0, 11.0);
        h.push(1_900.0, 12.0); // backwards: ignored
        assert_eq!(h.len(), 2);
        assert_eq!(h.at(999.0, 1e9), None);
        assert_eq!(h.at(1_000.0, 1e9), Some(10.0));
        assert_eq!(h.at(1_999.0, 1e9), Some(10.0));
        assert_eq!(h.at(2_000.0, 1e9), Some(11.0));
        assert_eq!(h.at(9_000.0, 5_000.0), None, "older than the cap");
        assert!(h.covers(1_000.0) && !h.covers(999.0));
    }

    #[test]
    fn trims_by_age_and_count() {
        let mut h = MidHistory::new(1_000.0, 3);
        for i in 0..10 {
            h.push(f64::from(i) * 400.0, f64::from(i) + 1.0);
        }
        assert_eq!(h.len(), 3);
        assert_eq!(h.latest(), Some((3_600.0, 10.0)));
        assert!(!h.covers(2_000.0));
        h.push(10_000.0, 0.0);
        h.push(10_000.0, f64::NAN);
        assert_eq!(h.latest(), Some((3_600.0, 10.0)), "non-positive and NaN mids are ignored");
    }
}
