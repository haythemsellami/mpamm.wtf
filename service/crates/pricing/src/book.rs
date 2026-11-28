//! Order books and the taker walk every exchange feed shares.

use std::{cmp::Ordering, collections::BTreeMap};

/// A positive, finite price usable as a map key.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Px(pub f64);

impl Eq for Px {}

impl PartialOrd for Px {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Px {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// The taker buys the base: consumes asks, best (lowest) first.
    Buy,
    /// The taker sells the base: consumes bids, best (highest) first.
    Sell,
}

/// The result of taking `base` units from a book.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Walk {
    /// Volume-weighted price of what filled (quote per base, before fees);
    /// the fallback when nothing filled.
    pub price: f64,
    pub filled_base: f64,
    pub filled_full: bool,
}

impl Walk {
    pub const EMPTY: Walk = Walk { price: 0.0, filled_base: 0.0, filled_full: false };
}

/// Takes `base` units from price-ordered levels, best first.
pub fn walk_levels(levels: impl IntoIterator<Item = (f64, f64)>, base: f64, fallback: f64) -> Walk {
    let (mut remaining, mut quote, mut filled) = (base, 0.0, 0.0);
    for (price, size) in levels {
        if remaining <= 0.0 {
            break;
        }
        let take = remaining.min(size);
        quote += take * price;
        filled += take;
        remaining -= take;
    }
    Walk {
        price: if filled > 0.0 { quote / filled } else { fallback },
        filled_base: filled,
        filled_full: remaining <= 1e-9 && filled > 0.0,
    }
}

/// Bids and asks, price → size.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Book {
    pub bids: BTreeMap<Px, f64>,
    pub asks: BTreeMap<Px, f64>,
}

impl Book {
    pub fn clear(&mut self) {
        self.bids.clear();
        self.asks.clear();
    }

    /// Sets a level; size 0 removes it.
    pub fn set(&mut self, side: Side, price: f64, size: f64) {
        let map = match side {
            Side::Buy => &mut self.asks,
            Side::Sell => &mut self.bids,
        };
        if size == 0.0 {
            map.remove(&Px(price));
        } else {
            map.insert(Px(price), size);
        }
    }

    pub fn best_bid(&self) -> Option<f64> {
        self.bids.keys().next_back().map(|p| p.0)
    }

    pub fn best_ask(&self) -> Option<f64> {
        self.asks.keys().next().map(|p| p.0)
    }

    /// A locked or crossed book can't price anything.
    pub fn crossed(&self) -> bool {
        matches!((self.best_bid(), self.best_ask()), (Some(b), Some(a)) if b >= a)
    }

    pub fn mid(&self) -> Option<f64> {
        match (self.best_bid(), self.best_ask()) {
            (Some(b), Some(a)) if b < a => Some((b + a) / 2.0),
            _ => None,
        }
    }

    pub fn walk(&self, side: Side, base: f64, fallback: f64) -> Walk {
        match side {
            Side::Buy => walk_levels(self.asks.iter().map(|(p, s)| (p.0, *s)), base, fallback),
            Side::Sell => walk_levels(self.bids.iter().rev().map(|(p, s)| (p.0, *s)), base, fallback),
        }
    }

    /// Keeps the best `depth` levels of each side.
    pub fn truncate(&mut self, depth: usize) {
        while self.asks.len() > depth {
            let worst = *self.asks.keys().next_back().unwrap();
            self.asks.remove(&worst);
        }
        while self.bids.len() > depth {
            let worst = *self.bids.keys().next().unwrap();
            self.bids.remove(&worst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_vwap_and_reports_partial_fills() {
        let w = walk_levels([(10.0, 1.0), (11.0, 1.0), (12.0, 5.0)], 2.5, 0.0);
        assert!((w.price - (10.0 + 11.0 + 6.0) / 2.5).abs() < 1e-12);
        assert!(w.filled_full);
        let w = walk_levels([(10.0, 1.0)], 3.0, 9.0);
        assert_eq!((w.price, w.filled_base, w.filled_full), (10.0, 1.0, false));
        assert_eq!(walk_levels([], 1.0, 9.5), Walk { price: 9.5, filled_base: 0.0, filled_full: false });
    }

    #[test]
    fn book_sides_mid_walk_and_truncate() {
        let mut b = Book::default();
        for (p, s) in [(99.0, 1.0), (98.0, 2.0), (97.0, 3.0)] {
            b.set(Side::Sell, p, s);
        }
        for (p, s) in [(101.0, 1.0), (102.0, 2.0)] {
            b.set(Side::Buy, p, s);
        }
        assert_eq!((b.best_bid(), b.best_ask(), b.mid()), (Some(99.0), Some(101.0), Some(100.0)));
        let sell = b.walk(Side::Sell, 2.0, 0.0);
        assert!((sell.price - 98.5).abs() < 1e-12, "best bids first");
        let buy = b.walk(Side::Buy, 2.0, 0.0);
        assert!((buy.price - 101.5).abs() < 1e-12, "best asks first");
        b.set(Side::Sell, 99.0, 0.0);
        assert_eq!(b.best_bid(), Some(98.0));
        b.truncate(1);
        assert_eq!((b.bids.len(), b.asks.len(), b.best_bid(), b.best_ask()), (1, 1, Some(98.0), Some(101.0)));
        b.set(Side::Sell, 101.0, 1.0);
        assert!(b.crossed() && b.mid().is_none());
    }
}
