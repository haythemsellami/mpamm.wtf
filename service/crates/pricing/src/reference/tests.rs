use std::collections::HashMap;

use super::*;
use crate::book::{walk_levels, Book};

#[derive(Default)]
struct Fake {
    mids: HashMap<(Cex, &'static str), f64>,
    books: HashMap<(Cex, &'static str), Book>,
    settled: HashMap<&'static str, f64>,
    closed: Vec<&'static str>,
}

impl Exchanges for Fake {
    fn mid(&self, cex: Cex, symbol: &str) -> f64 {
        self.mids.iter().find(|((c, s), _)| *c == cex && *s == symbol).map_or(0.0, |(_, m)| *m)
    }
    fn walk(&self, cex: Cex, symbol: &str, side: Side, base: f64) -> Walk {
        let mid = self.mid(cex, symbol);
        self.books
            .iter()
            .find(|((c, s), _)| *c == cex && *s == symbol)
            .map_or(Walk::EMPTY, |(_, b)| b.walk(side, base, mid))
    }
    fn settled_mid(&self, cex: Cex, symbol: &str) -> f64 {
        let live = self.mid(cex, symbol);
        if live > 0.0 {
            live
        } else {
            self.settled.get(symbol).copied().unwrap_or(0.0)
        }
    }
    fn market_closed(&self, _cex: Cex, symbol: &str) -> bool {
        self.closed.contains(&symbol)
    }
}

struct Rate(f64);
impl Rates for Rate {
    fn rate(&self, token_key: &str) -> f64 {
        let reg = Registry::get();
        if reg.tokens.get(token_key).is_some_and(|t| t.underlying_x_stock.is_some()) {
            self.0
        } else {
            1.0
        }
    }
}

fn market() -> Fake {
    let mut f = Fake::default();
    for (cex, sym, m) in [
        (Cex::Bybit, "MONUSDT", 0.03),
        (Cex::Bybit, "USDCUSDT", 1.0002),
        (Cex::Bybit, "USD1USDT", 0.9990),
        (Cex::Binance, "BTCUSDT", 90_000.0),
        (Cex::Binance, "ETHUSDT", 3_000.0),
        (Cex::Binance, "XAUTUSDT", 4_000.0),
        (Cex::Binance, "WBTCBTC", 0.9995),
        (Cex::Binance, "USDCUSDT", 1.0001),
        (Cex::Kraken, "SPYx/USD", 700.0),
        (Cex::Kraken, "USDC/USD", 0.9998),
        (Cex::Kraken, "USDT/USD", 1.0010),
        (Cex::Kraken, "AUSD/USD", 0.9990),
    ] {
        f.mids.insert((cex, sym), m);
    }
    f
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.0)
}

#[test]
fn pair_terms_for_every_kind_of_pair() {
    let f = market();
    let r = Reference { registry: Registry::get(), ex: &f, rates: &Rate(1.25) };
    let cases: &[(&str, f64)] = &[
        // Bybit base, stable quote with a Bybit cross.
        ("MON/USDC", 0.03 / 1.0002),
        ("MON/USD1", 0.03 / 0.9990),
        // USDT0 is USDT; AUSD on a crypto pair is approximated as USDT.
        ("MON/USDT0", 0.03),
        ("MON/AUSD", 0.03),
        // Binance base with the WBTC basis and Binance's own USDC cross.
        ("BTC/USDC", 90_000.0 * 0.9995 / 1.0001),
        // cbBTC: parity, no basis.
        ("cbBTC/USDC", 90_000.0 / 1.0001),
        // Crypto-quoted: the quote asset's own mid.
        ("MON/ETH", 0.03 / 3_000.0),
        ("BTC/MON", 90_000.0 * 0.9995 / 0.03),
        // Asset quote with its own wrapper basis.
        ("XAUt/BTC", 4_000.0 / (90_000.0 * 0.9995)),
        // Kraken base (USD) with a stable quote: Kraken's USD cross.
        ("SPYx/USDC", 700.0 / 0.9998),
        ("SPYx/AUSD", 700.0 / 0.9990),
        // Kraken base vs a USDT-quoted asset: crossed through USDT/USD.
        ("SPYx/MON", 700.0 / (0.03 * 1.0010)),
        ("SPYx/BTC", 700.0 / (90_000.0 * 1.0010 * 0.9995)),
        // A wrapped xStock: the underlying book × the share rate.
        ("wSPYx/USDC", 700.0 * 1.25 / 0.9998),
    ];
    for (market, want) in cases {
        let got = r.mid_for_pair(market);
        assert!(close(got, *want), "{market}: got {got}, want {want}");
    }
    assert_eq!(r.mid_for_pair("NOPE/USDC"), 0.0);
    assert!(close(r.asset_usd("wSPYx"), 875.0));
    assert!(close(r.asset_usd("MON"), 0.03));
}

#[test]
fn a_missing_leg_makes_the_reference_unavailable() {
    let mut f = market();
    f.mids.remove(&(Cex::Bybit, "USDCUSDT"));
    f.mids.remove(&(Cex::Kraken, "USDT/USD"));
    let r = Reference { registry: Registry::get(), ex: &f, rates: &Rate(0.0) };
    assert_eq!(r.mid_for_pair("MON/USDC"), 0.0, "stable cross missing");
    assert_eq!(r.mid_for_pair("SPYx/MON"), 0.0, "USDT/USD missing");
    assert_eq!(r.mid_for_pair("wSPYx/USDC"), 0.0, "share rate missing");
    assert!(r.mid_for_pair("SPYx/USDC") > 0.0, "a pair without those legs is unaffected");
    // The base wrapper basis falls back to parity at cold start (today's convention).
    f.mids.remove(&(Cex::Binance, "WBTCBTC"));
    let r = Reference { registry: Registry::get(), ex: &f, rates: &Rate(1.0) };
    assert!(close(r.mid_for_pair("BTC/USDC"), 90_000.0 / 1.0001));
    // ...but an asset quote's basis is required.
    assert_eq!(r.mid_for_pair("XAUt/BTC"), 0.0);
}

#[test]
fn settled_usd_keeps_a_closed_markets_last_price() {
    let mut f = market();
    f.mids.remove(&(Cex::Kraken, "SPYx/USD"));
    f.settled.insert("SPYx/USD", 690.0);
    f.closed.push("SPYx/USD");
    let r = Reference { registry: Registry::get(), ex: &f, rates: &Rate(1.5) };
    assert_eq!(r.asset_usd("SPYx"), 0.0, "no live reference while closed");
    assert!(close(r.settled_usd("SPYx"), 690.0));
    assert!(close(r.settled_usd("wSPYx"), 690.0 * 1.5));
    assert!(r.market_closed("SPYx") && !r.market_closed("MON"));
    assert!(close(r.settled_usd("MON"), 0.03));
}

#[test]
fn reference_rows_walk_once_and_convert_into_pair_terms() {
    let mut f = market();
    let mut b = Book::default();
    for (p, s) in [(0.0299, 1_000_000.0), (0.0298, 5_000_000.0)] {
        b.set(Side::Sell, p, s);
    }
    for (p, s) in [(0.0301, 1_000_000.0), (0.0302, 5_000_000.0)] {
        b.set(Side::Buy, p, s);
    }
    f.books.insert((Cex::Bybit, "MONUSDT"), b.clone());
    let r = Reference { registry: Registry::get(), ex: &f, rates: &Rate(1.0) };
    let only = |m: &str| m == "MON/USDC" || m == "MON/USDT0";
    let rows = r.quote(&[100.0, 100_000.0], Some(&only), &Fees::default(), 7.0);
    assert_eq!(rows.len(), 4);
    let row = rows.iter().find(|x| x.market == "MON/USDC" && x.size_usd == 100_000.0).unwrap();
    let factor = 1.0 / 1.0002;
    let base = 100_000.0 / 0.03;
    let buy = walk_levels([(0.0301, 1_000_000.0), (0.0302, 5_000_000.0)], base, 0.03);
    let ask = buy.price * factor * (1.0 + 4.5e-4);
    assert!(close(row.ask_px, ask));
    assert!(close(row.ask_bps, (ask / (0.03 * factor) - 1.0) * 1e4));
    assert!(close(row.spread_bps, (row.ask_px - row.bid_px) / (0.03 * factor) * 1e4));
    assert_eq!((row.venue_id.as_str(), row.fee_bps, row.filled_full, row.ts), ("bybit", 4.5, true, 7.0));
    // No book (a symbol never walked): fallback price is the mid, not filled.
    f.books.clear();
    let r = Reference { registry: Registry::get(), ex: &f, rates: &Rate(1.0) };
    let rows = r.quote(&[100.0], Some(&only), &Fees::default(), 0.0);
    assert!(rows.iter().all(|x| !x.filled_full));
}
