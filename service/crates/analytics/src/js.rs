//! The two JavaScript number semantics the aggregations depend on.

use std::cmp::Ordering;

/// `Math.round`: the nearest integer, a half rounding toward +∞ (−2.5 → −2,
/// where `f64::round` gives −3), and −0 for (−0.5, −0]. This is V8's own
/// algorithm, exact for every double: `ceil` and `c − 0.5` are exact below
/// 2⁵², and above it every double is already an integer.
pub fn round(x: f64) -> f64 {
    let c = x.ceil();
    if c - 0.5 <= x {
        c
    } else {
        c - 1.0
    }
}

/// `Math.round(v · 10^dp) / 10^dp` with the factor `k = 10^dp` given exactly.
pub fn round_to(v: f64, k: f64) -> f64 {
    round(v * k) / k
}

/// A TS comparator's numeric result as an ordering: negative sorts `a` first,
/// positive `b` first, zero (and NaN, which V8 treats as zero) keeps them in
/// place, as a stable sort must.
pub fn cmp(d: f64) -> Ordering {
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_halves_toward_positive_infinity() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-7812.5), -7812.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(-0.49999999999999994), 0.0);
        assert_eq!(round(4_503_599_627_370_495.5), 4_503_599_627_370_496.0);
        assert_eq!(round(-4_503_599_627_370_495.5), -4_503_599_627_370_495.0);
        assert_eq!(round(1e300), 1e300);
        assert!(round(-0.3).is_sign_negative() && round(-0.5).is_sign_negative() && round(-0.0).is_sign_negative());
        assert!(round(0.3).is_sign_positive() && round(-0.7) == -1.0);
        assert_eq!(round(f64::INFINITY), f64::INFINITY);
        assert!(round(f64::NAN).is_nan());
        assert_eq!(round_to(-2.25, 10.0), -2.2);
        assert_eq!(round_to(0.125, 100.0), 0.13);
    }

    #[test]
    fn comparator_sign() {
        assert_eq!(cmp(-1e-300), Ordering::Less);
        assert_eq!(cmp(3.0), Ordering::Greater);
        assert_eq!(cmp(-0.0), Ordering::Equal);
        assert_eq!(cmp(f64::NAN), Ordering::Equal);
    }
}
