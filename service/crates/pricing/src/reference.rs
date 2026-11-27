//! The pair-terms reference (docs/architecture.md → The reference is in the
//! pair's own terms), ported from server/src/venues/reference.ts.
//!
//! Crypto books are quoted in USDT, Kraken's xStock books in USD. A pair's
//! reference mid = base book mid × base wrapper basis × share rate ÷ quote
//! leg, where the quote leg is the stable's own cross (USDCUSDT, USDC/USD…),
//! or for a crypto-quoted pair the quote asset's own mid (crossed through
//! USDT/USD when the two books are in different dollars, times its wrapper
//! basis). Any required leg missing makes the reference unavailable (0):
//! never a guess.
//!
//! The math runs over `Exchanges`, so the same code serves the live books
//! and the price history at a past time.

use mpamm_registry::{Cex, Pair, Registry};
use mpamm_types::{QuoteRow, ThemeColor, VenueKind, VenueMeta, VenueRole};

use crate::book::{Side, Walk};

/// What the reference reads from the exchange feeds. Every price is 0 when
/// unavailable.
pub trait Exchanges {
    fn mid(&self, cex: Cex, symbol: &str) -> f64;
    /// Taking `base` units from the book.
    fn walk(&self, _cex: Cex, _symbol: &str, _side: Side, _base: f64) -> Walk {
        Walk::EMPTY
    }
    /// For valuing a settled trade: the live mid, or a closed market's last
    /// good one (Kraken's 24/5 xStocks). Never a reference.
    fn settled_mid(&self, cex: Cex, symbol: &str) -> f64 {
        self.mid(cex, symbol)
    }
    /// The exchange itself reports the market as not trading.
    fn market_closed(&self, _cex: Cex, _symbol: &str) -> bool {
        false
    }
    fn change_pct(&self, _cex: Cex, _symbol: &str) -> f64 {
        0.0
    }
}

/// ERC-4626 underlying per share for a wrapper token (1 for any other
/// token; 0 when the wrapper's rate is missing or stale).
pub trait Rates {
    fn rate(&self, token_key: &str) -> f64;
}

/// The three exchanges as the dashboard lists them (today's reference
/// registry), each with the taker fee its rows include.
pub fn reference_venues(fees: &Fees) -> Vec<VenueMeta> {
    let meta = |id: &str, name: &str, light: &str, dark: &str, taker_bps: f64| VenueMeta {
        id: id.into(),
        name: name.into(),
        color: ThemeColor { light: light.into(), dark: dark.into() },
        kind: VenueKind::Cex,
        role: VenueRole::Reference,
        taker: Some(true),
        taker_bps: Some(taker_bps),
        since_utc: None,
        quote_note: None,
    };
    vec![
        meta("bybit", "Bybit (Supreme VIP)", "#8A8375", "#B9BCC6", fees.bybit),
        meta("binance", "Binance (VIP9)", "#B58A1B", "#F0B90B", fees.binance),
        meta("kraken", "Kraken Pro xStocks ($1B+)", "#503714", "#FFD0AC", fees.kraken),
    ]
}

/// Taker fees the reference rows add, in bps.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fees {
    pub bybit: f64,
    pub binance: f64,
    pub kraken: f64,
}

impl Default for Fees {
    /// Published advanced-tier taker fees (Bybit Supreme VIP, Binance VIP9,
    /// Kraken xStocks at $1B+), today's defaults.
    fn default() -> Self {
        Self { bybit: 4.5, binance: 2.25, kraken: 2.5 }
    }
}

impl Fees {
    pub fn of(&self, cex: Cex) -> f64 {
        match cex {
            Cex::Bybit => self.bybit,
            Cex::Binance => self.binance,
            Cex::Kraken => self.kraken,
        }
    }
}

/// The USDT/USD book on Kraken, which crosses USDT- and USD-quoted legs.
pub const USDT_USD: &str = "USDT/USD";

pub struct Reference<'a, E: Exchanges, R: Rates> {
    pub registry: &'a Registry,
    pub ex: &'a E,
    pub rates: &'a R,
}

impl<E: Exchanges, R: Rates> Reference<'_, E, R> {
    /// An asset's own book mid (USDT for crypto, USD for xStocks).
    pub fn raw_mid(&self, base: &str) -> f64 {
        self.registry.asset_of(base).map_or(0.0, |a| self.ex.mid(a.cex, &a.cex_symbol))
    }

    /// Underlying per share for a wrapped-xStock asset; 1 otherwise.
    pub fn share_rate(&self, base: &str) -> f64 {
        self.registry.asset_of(base).map_or(0.0, |a| self.rates.rate(&a.token))
    }

    fn wrap_factor(&self, pair: &Pair) -> f64 {
        match self.registry.wrap_basis_for(pair) {
            None => 1.0,
            Some(sym) => {
                let m = self.ex.mid(Cex::Binance, sym);
                // Today's cold-start convention for the base wrapper.
                if m > 0.0 {
                    m
                } else {
                    1.0
                }
            }
        }
    }

    fn quote_leg(&self, pair: &Pair) -> f64 {
        let r = self.registry;
        let usd_base = r.cex_for_base(&pair.base) == Cex::Kraken;
        if pair.is_asset_quoted() {
            let mut m = self.raw_mid(&pair.quote) * self.share_rate(&pair.quote);
            let usd_quote = r.cex_for_base(&pair.quote) == Cex::Kraken;
            if usd_base != usd_quote {
                let usdt_usd = self.ex.mid(Cex::Kraken, USDT_USD);
                if usdt_usd <= 0.0 {
                    return 0.0;
                }
                m = if usd_base { m * usdt_usd } else { m / usdt_usd };
            }
            if let Some(sym) = &pair.quote_wrap_basis_symbol {
                let wrap = self.ex.mid(Cex::Binance, sym);
                if wrap <= 0.0 {
                    return 0.0;
                }
                m *= wrap;
            }
            return if m > 0.0 { m } else { 0.0 };
        }
        let Some(token) = r.tokens.get(&pair.quote) else { return 0.0 };
        if usd_base {
            return token.usd_cross.as_deref().map_or(0.0, |s| self.ex.mid(Cex::Kraken, s));
        }
        // No cross: USDT0 is USDT; AUSD is approximated as USDT for crypto.
        let Some(sym) = token.usdt_cross.as_deref() else { return 1.0 };
        let m = match r.cex_for_base(&pair.base) {
            Cex::Binance => self.ex.mid(Cex::Binance, sym),
            _ => self.ex.mid(Cex::Bybit, sym),
        };
        if m > 0.0 {
            m
        } else {
            0.0
        }
    }

    fn pair_factor(&self, pair: &Pair) -> f64 {
        let q = self.quote_leg(pair);
        if q > 0.0 {
            self.share_rate(&pair.base) * self.wrap_factor(pair) / q
        } else {
            0.0
        }
    }

    /// The pair's reference mid in its own terms: the bps anchor and the
    /// markout mark. 0 when any leg is unavailable.
    pub fn mid_for_pair(&self, market: &str) -> f64 {
        let Some(pair) = self.registry.pair_of(market) else { return 0.0 };
        let (mid, factor) = (self.raw_mid(&pair.base), self.pair_factor(pair));
        if mid > 0.0 && factor > 0.0 {
            mid * factor
        } else {
            0.0
        }
    }

    /// USD (≈USDT) price of a base asset: sizing and the header, not anchors.
    pub fn asset_usd(&self, base: &str) -> f64 {
        self.raw_mid(base) * self.share_rate(base)
    }

    /// USD for valuing a settled trade: `asset_usd`, except that a Kraken
    /// market in a closure keeps its last good price.
    pub fn settled_usd(&self, base: &str) -> f64 {
        match self.registry.asset_of(base) {
            Some(a) if a.cex == Cex::Kraken => self.ex.settled_mid(a.cex, &a.cex_symbol) * self.share_rate(base),
            Some(_) => self.raw_mid(base),
            None => 0.0,
        }
    }

    pub fn market_closed(&self, base: &str) -> bool {
        self.registry
            .asset_of(base)
            .is_some_and(|a| a.cex == Cex::Kraken && self.ex.market_closed(a.cex, &a.cex_symbol))
    }

    pub fn change_pct(&self, base: &str) -> f64 {
        self.registry.asset_of(base).map_or(0.0, |a| self.ex.change_pct(a.cex, &a.cex_symbol))
    }

    /// Taker-walk benchmark rows for every registered pair (or those in
    /// `markets`), tagged with the pair's exchange and converted into the
    /// pair's terms. A base's walk is computed once per size and reused for
    /// every pair it is quoted against.
    pub fn quote(
        &self,
        sizes_usd: &[f64],
        markets: Option<&dyn Fn(&str) -> bool>,
        fees: &Fees,
        ts: f64,
    ) -> Vec<QuoteRow> {
        let mut rows = Vec::new();
        let mut walks: std::collections::HashMap<(Cex, String, u64), (Walk, Walk)> = std::collections::HashMap::new();
        for pair in &self.registry.pairs {
            if markets.is_some_and(|f| !f(&pair.symbol)) {
                continue;
            }
            let Some(a) = self.registry.asset_of(&pair.base) else { continue };
            let (mid, factor) = (self.raw_mid(&pair.base), self.pair_factor(pair));
            if mid <= 0.0 || factor <= 0.0 {
                continue;
            }
            let px_mid = mid * factor;
            let fee_bps = fees.of(a.cex);
            let fee = fee_bps / 1e4;
            for &size in sizes_usd {
                let (buy, sell) = *walks.entry((a.cex, a.cex_symbol.clone(), size.to_bits())).or_insert_with(|| {
                    let base = size / mid;
                    (
                        self.ex.walk(a.cex, &a.cex_symbol, Side::Buy, base),
                        self.ex.walk(a.cex, &a.cex_symbol, Side::Sell, base),
                    )
                });
                let ask_px = buy.price * factor * (1.0 + fee);
                let bid_px = sell.price * factor * (1.0 - fee);
                rows.push(QuoteRow {
                    venue_id: a.cex.id().to_string(),
                    market: pair.symbol.clone(),
                    size_usd: size,
                    bid_bps: (bid_px / px_mid - 1.0) * 1e4,
                    ask_bps: (ask_px / px_mid - 1.0) * 1e4,
                    bid_px,
                    ask_px,
                    spread_bps: ((ask_px - bid_px) / px_mid) * 1e4,
                    filled_full: buy.filled_full && sell.filled_full,
                    one_sided: None,
                    fee_bps,
                    cex_ask_bps: None,
                    cex_bid_bps: None,
                    ts,
                });
            }
        }
        rows
    }
}

#[cfg(test)]
mod tests;
