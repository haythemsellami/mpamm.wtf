//! The Rust reference answers as server/src/venues/reference.ts does for the
//! same exchange mids and books: every registered pair's mid and every
//! reference row (`reference-golden.json`, written by
//! `server/scripts/reference-golden.ts`).

use std::collections::HashMap;

use mpamm_pricing::{book::walk_levels, Exchanges, Fees, Rates, Reference, Side, Walk};
use mpamm_registry::{Cex, Registry};
use serde_json::Value;

/// (bids high→low, asks low→high) as (price, size).
type Levels = (Vec<(f64, f64)>, Vec<(f64, f64)>);

struct Golden {
    mids: HashMap<(Cex, String), f64>,
    books: HashMap<(Cex, String), Levels>,
}

fn cex(s: &str) -> Cex {
    match s {
        "bybit" => Cex::Bybit,
        "binance" => Cex::Binance,
        _ => Cex::Kraken,
    }
}

impl Exchanges for Golden {
    fn mid(&self, c: Cex, s: &str) -> f64 {
        self.mids.get(&(c, s.to_string())).copied().unwrap_or(0.0)
    }
    fn walk(&self, c: Cex, s: &str, side: Side, base: f64) -> Walk {
        let fallback = if c == Cex::Kraken { 0.0 } else { self.mid(c, s) };
        match self.books.get(&(c, s.to_string())) {
            Some((bids, asks)) => {
                walk_levels(if side == Side::Buy { asks.clone() } else { bids.clone() }, base, fallback)
            }
            None => walk_levels([], base, fallback),
        }
    }
}

struct Rate(f64);
impl Rates for Rate {
    fn rate(&self, key: &str) -> f64 {
        if key.starts_with('W') && key.ends_with('X') {
            self.0
        } else {
            1.0
        }
    }
}

fn levels(v: &Value) -> Vec<(f64, f64)> {
    v.as_array().unwrap().iter().map(|l| (l[0].as_f64().unwrap(), l[1].as_f64().unwrap())).collect()
}

fn same(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1e-9)
}

#[test]
fn matches_typescript_for_every_pair_and_row() {
    let g: Value = serde_json::from_str(include_str!("reference-golden.json")).unwrap();
    let mut ex = Golden { mids: HashMap::new(), books: HashMap::new() };
    for (c, syms) in g["mids"].as_object().unwrap() {
        for (s, m) in syms.as_object().unwrap() {
            ex.mids.insert((cex(c), s.clone()), m.as_f64().unwrap());
        }
    }
    for (c, syms) in g["books"].as_object().unwrap() {
        for (s, b) in syms.as_object().unwrap() {
            ex.books.insert((cex(c), s.clone()), (levels(&b[0]), levels(&b[1])));
        }
    }
    let rates = Rate(g["rate"].as_f64().unwrap());
    let r = Reference { registry: Registry::get(), ex: &ex, rates: &rates };

    for row in g["midForPair"].as_array().unwrap() {
        let (m, want) = (row[0].as_str().unwrap(), row[1].as_f64().unwrap());
        assert!(same(r.mid_for_pair(m), want), "{m}: rust {} ts {want}", r.mid_for_pair(m));
    }

    let sizes: Vec<f64> = g["sizes"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let rows = r.quote(&sizes, None, &Fees::default(), 0.0);
    let want = g["rows"].as_array().unwrap();
    assert_eq!(rows.len(), want.len());
    for (got, w) in rows.iter().zip(want) {
        assert_eq!(
            (got.venue_id.as_str(), got.market.as_str(), got.size_usd),
            (w[0].as_str().unwrap(), w[1].as_str().unwrap(), w[2].as_f64().unwrap())
        );
        for (name, a, b) in [
            ("bidPx", got.bid_px, &w[3]),
            ("askPx", got.ask_px, &w[4]),
            ("bidBps", got.bid_bps, &w[5]),
            ("askBps", got.ask_bps, &w[6]),
            ("spreadBps", got.spread_bps, &w[7]),
            ("feeBps", got.fee_bps, &w[9]),
        ] {
            assert!(same(a, b.as_f64().unwrap()), "{} {} {name}: rust {a} ts {b}", got.market, got.size_usd);
        }
        assert_eq!(got.filled_full, w[8].as_bool().unwrap(), "{} {}", got.market, got.size_usd);
    }
}
