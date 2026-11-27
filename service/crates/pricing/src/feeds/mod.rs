//! Live exchange feeds (Bybit, Binance, Kraken) and the state they keep:
//! per symbol an order book, the best bid and ask, 24 h change, and every
//! mid it had for the last hours.
//!
//! A feed that stops ticking is worse than one that disconnects: a half-open
//! connection would keep the last mids "fresh" forever. Every read checks the
//! feed's last message time and answers 0 (unavailable) after 30 s of
//! silence, and the connection loop reconnects.

pub mod binance;
pub mod bybit;
pub mod kraken;
mod ws;

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use mpamm_registry::{Cex, Registry};
use parking_lot::RwLock;

use crate::{
    book::{walk_levels, Book, Px, Side, Walk},
    history::MidHistory,
    reference::Exchanges,
};

/// A feed that sent nothing for this long is unavailable.
pub const STALE_MS: u64 = 30_000;
/// How far back each symbol's mid history reaches.
pub const HISTORY_MS: f64 = 3.0 * 3600.0 * 1000.0;
const HISTORY_MAX_POINTS: usize = 2_000_000;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A Kraken level as sent: the exact decimal text (the checksum needs it)
/// and its value.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLevel {
    pub price: String,
    pub qty: String,
    pub size: f64,
}

/// One exchange symbol.
#[derive(Debug, Clone)]
pub struct Sym {
    pub book: Book,
    pub best_bid: f64,
    pub best_ask: f64,
    pub last: f64,
    pub change_pct: f64,
    pub history: MidHistory,
    /// Kraken: the instrument status (`online` when trading).
    pub status: Option<String>,
    /// Kraken: levels with their text, for the checksum.
    pub kbids: BTreeMap<Px, TextLevel>,
    pub kasks: BTreeMap<Px, TextLevel>,
    /// Kraken: a checksum-valid book is held (a failed one is dropped).
    pub has_book: bool,
    /// Kraken: the last validated book mid and the ticker's price, which only
    /// value settled trades through a closure or outage.
    pub last_valid_mid: f64,
    pub last_ticker: f64,
}

impl Sym {
    fn new() -> Self {
        Self {
            book: Book::default(),
            best_bid: 0.0,
            best_ask: 0.0,
            last: 0.0,
            change_pct: 0.0,
            history: MidHistory::new(HISTORY_MS, HISTORY_MAX_POINTS),
            status: None,
            kbids: BTreeMap::new(),
            kasks: BTreeMap::new(),
            has_book: false,
            last_valid_mid: 0.0,
            last_ticker: 0.0,
        }
    }
}

/// One exchange's state, shared between its connection task and readers.
pub struct Exchange {
    pub cex: Cex,
    syms: RwLock<HashMap<String, Sym>>,
    last_msg_ms: AtomicU64,
    /// Kraken's engine status is `online` (always true for the others).
    engine_online: AtomicBool,
    /// Kraken reported an engine status other than online over a live link.
    engine_down_reported: AtomicBool,
}

impl Exchange {
    pub fn new(cex: Cex, symbols: &[String]) -> Arc<Self> {
        Arc::new(Self {
            cex,
            syms: RwLock::new(symbols.iter().map(|s| (s.clone(), Sym::new())).collect()),
            last_msg_ms: AtomicU64::new(0),
            engine_online: AtomicBool::new(cex != Cex::Kraken),
            engine_down_reported: AtomicBool::new(false),
        })
    }

    pub fn symbols(&self) -> Vec<String> {
        let mut v: Vec<String> = self.syms.read().keys().cloned().collect();
        v.sort();
        v
    }

    pub fn touch(&self, now: u64) {
        self.last_msg_ms.store(now, Ordering::Relaxed);
    }

    pub fn fresh(&self, now: u64) -> bool {
        now.saturating_sub(self.last_msg_ms.load(Ordering::Relaxed)) <= STALE_MS
    }

    pub fn last_msg_ms(&self) -> u64 {
        self.last_msg_ms.load(Ordering::Relaxed)
    }

    /// Runs `f` on a symbol's state and records its mid in the history.
    pub fn update(&self, symbol: &str, now: u64, f: impl FnOnce(&mut Sym)) -> bool {
        let mut syms = self.syms.write();
        let Some(s) = syms.get_mut(symbol) else { return false };
        f(s);
        let mid = self.sym_mid(s);
        if mid > 0.0 {
            s.history.push(now as f64, mid);
            if self.cex == Cex::Kraken {
                s.last_valid_mid = mid;
            }
        } else {
            // A closed or broken market has no price from now on.
            s.history.mark_unavailable(now as f64);
        }
        true
    }

    pub fn read<R>(&self, symbol: &str, f: impl FnOnce(&Sym) -> R) -> Option<R> {
        self.syms.read().get(symbol).map(f)
    }

    /// Drops every book (a reconnect must start from fresh snapshots); keeps
    /// history and the last good prices.
    pub fn reset_books(&self) {
        // Prices stopped when the feed last spoke plus the silence limit (or
        // now, if that is sooner): no lookup carries a price across the gap.
        let last = self.last_msg_ms.load(Ordering::Relaxed);
        let from = if last == 0 { now_ms() } else { (last + STALE_MS).min(now_ms()) };
        for s in self.syms.write().values_mut() {
            s.history.mark_unavailable(from as f64);
            s.book.clear();
            s.kbids.clear();
            s.kasks.clear();
            s.has_book = false;
            s.status = None;
        }
        if self.cex == Cex::Kraken {
            self.engine_online.store(false, Ordering::Relaxed);
            self.engine_down_reported.store(false, Ordering::Relaxed);
        }
    }

    pub fn set_engine(&self, online: bool) {
        self.engine_online.store(online, Ordering::Relaxed);
        self.engine_down_reported.store(!online, Ordering::Relaxed);
    }

    /// The symbol's mid, ignoring freshness.
    fn sym_mid(&self, s: &Sym) -> f64 {
        match self.cex {
            Cex::Kraken => {
                if !self.engine_online.load(Ordering::Relaxed) || s.status.as_deref() != Some("online") || !s.has_book {
                    return 0.0;
                }
                match (s.kbids.keys().next_back(), s.kasks.keys().next()) {
                    (Some(b), Some(a)) if b.0 < a.0 => (b.0 + a.0) / 2.0,
                    _ => 0.0,
                }
            }
            _ => {
                if s.best_bid > 0.0 && s.best_ask > 0.0 {
                    (s.best_bid + s.best_ask) / 2.0
                } else if s.last > 0.0 {
                    s.last
                } else if s.best_bid > 0.0 {
                    s.best_bid
                } else {
                    s.best_ask
                }
            }
        }
    }

    pub fn mid(&self, symbol: &str, now: u64) -> f64 {
        if !self.fresh(now) {
            return 0.0;
        }
        self.read(symbol, |s| self.sym_mid(s)).unwrap_or(0.0)
    }

    pub fn walk(&self, symbol: &str, side: Side, base: f64, now: u64) -> Walk {
        if !self.fresh(now) {
            return Walk::EMPTY;
        }
        self.read(symbol, |s| match self.cex {
            Cex::Kraken => {
                if self.sym_mid(s) <= 0.0 || base.is_nan() || base <= 0.0 {
                    return Walk::EMPTY;
                }
                match side {
                    Side::Buy => walk_levels(s.kasks.iter().map(|(p, l)| (p.0, l.size)), base, 0.0),
                    Side::Sell => walk_levels(s.kbids.iter().rev().map(|(p, l)| (p.0, l.size)), base, 0.0),
                }
            }
            _ => s.book.walk(side, base, self.sym_mid(s)),
        })
        .unwrap_or(Walk::EMPTY)
    }

    pub fn settled_mid(&self, symbol: &str, now: u64) -> f64 {
        let live = self.mid(symbol, now);
        if live > 0.0 || self.cex != Cex::Kraken {
            return live;
        }
        self.read(symbol, |s| if s.last_valid_mid > 0.0 { s.last_valid_mid } else { s.last_ticker }).unwrap_or(0.0)
    }

    /// Kraken itself reports the market as not trading, over a live link.
    pub fn market_closed(&self, symbol: &str, now: u64) -> bool {
        if self.cex != Cex::Kraken || !self.fresh(now) {
            return false;
        }
        if self.engine_down_reported.load(Ordering::Relaxed) {
            return true;
        }
        self.read(symbol, |s| matches!(s.status.as_deref(), Some(st) if st != "online" && st != "delisted"))
            .unwrap_or(false)
    }

    pub fn change_pct(&self, symbol: &str, now: u64) -> f64 {
        if !self.fresh(now) {
            return 0.0;
        }
        self.read(symbol, |s| s.change_pct).unwrap_or(0.0)
    }

    /// The mid in effect at `t_ms`, from the history.
    pub fn mid_at(&self, symbol: &str, t_ms: f64, stale_ms: f64) -> Option<f64> {
        self.read(symbol, |s| s.history.at(t_ms, stale_ms)).flatten()
    }

    /// Whether this symbol's history reaches back to `t_ms`.
    pub fn covers(&self, symbol: &str, t_ms: f64) -> bool {
        self.read(symbol, |s| s.history.covers(t_ms)).unwrap_or(false)
    }
}

/// The three exchanges, as the reference reads them.
#[derive(Clone)]
pub struct Feeds {
    pub bybit: Arc<Exchange>,
    pub binance: Arc<Exchange>,
    pub kraken: Arc<Exchange>,
}

/// Which symbols each exchange must carry for the registry's pairs, as
/// today's reference subscribes them.
pub fn symbols_for(registry: &Registry) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut bybit: Vec<String> = Vec::new();
    let mut binance: Vec<String> = Vec::new();
    let mut kraken: Vec<String> = vec![crate::reference::USDT_USD.to_string()];
    let push = |v: &mut Vec<String>, s: &str| {
        if !v.iter().any(|x| x == s) {
            v.push(s.to_string())
        }
    };
    for a in registry.assets.values() {
        match a.cex {
            Cex::Bybit => push(&mut bybit, &a.cex_symbol),
            Cex::Binance => push(&mut binance, &a.cex_symbol),
            Cex::Kraken => push(&mut kraken, &a.cex_symbol),
        }
    }
    for p in &registry.pairs {
        if let Some(w) = registry.wrap_basis_for(p) {
            push(&mut binance, w);
        }
        if let Some(w) = &p.quote_wrap_basis_symbol {
            push(&mut binance, w);
        }
        if p.is_asset_quoted() {
            continue;
        }
        let Some(t) = registry.tokens.get(&p.quote) else { continue };
        match registry.cex_for_base(&p.base) {
            Cex::Bybit => {
                if let Some(c) = &t.usdt_cross {
                    push(&mut bybit, c)
                }
            }
            Cex::Binance => {
                if let Some(c) = &t.usdt_cross {
                    push(&mut binance, c)
                }
            }
            Cex::Kraken => {
                if let Some(c) = &t.usd_cross {
                    push(&mut kraken, c)
                }
            }
        }
    }
    (bybit, binance, kraken)
}

impl Feeds {
    pub fn new(registry: &Registry) -> Self {
        let (by, bi, kr) = symbols_for(registry);
        Self {
            bybit: Exchange::new(Cex::Bybit, &by),
            binance: Exchange::new(Cex::Binance, &bi),
            kraken: Exchange::new(Cex::Kraken, &kr),
        }
    }

    pub fn exchange(&self, cex: Cex) -> &Exchange {
        match cex {
            Cex::Bybit => &self.bybit,
            Cex::Binance => &self.binance,
            Cex::Kraken => &self.kraken,
        }
    }

    /// The feeds as they were at `t_ms`, from the histories.
    pub fn at(&self, t_ms: f64) -> At<'_> {
        At { feeds: self, t_ms }
    }
}

impl Exchanges for Feeds {
    fn mid(&self, cex: Cex, symbol: &str) -> f64 {
        self.exchange(cex).mid(symbol, now_ms())
    }
    fn walk(&self, cex: Cex, symbol: &str, side: Side, base: f64) -> Walk {
        self.exchange(cex).walk(symbol, side, base, now_ms())
    }
    fn settled_mid(&self, cex: Cex, symbol: &str) -> f64 {
        self.exchange(cex).settled_mid(symbol, now_ms())
    }
    fn market_closed(&self, cex: Cex, symbol: &str) -> bool {
        self.exchange(cex).market_closed(symbol, now_ms())
    }
    fn change_pct(&self, cex: Cex, symbol: &str) -> f64 {
        self.exchange(cex).change_pct(symbol, now_ms())
    }
}

/// How old the mid in effect at `t` may be. A quiet book can go minutes
/// without a change and still be the price; outages and closures are
/// recorded in the history as such (`mark_unavailable`), so no cap is
/// needed to keep a dead feed's last price from being carried forward.
pub const AT_STALE_BASE_MS: f64 = f64::INFINITY;

/// The exchanges as of a past time: each mid is the one in effect then. No
/// books (nothing walks the past).
pub struct At<'a> {
    feeds: &'a Feeds,
    t_ms: f64,
}

impl Exchanges for At<'_> {
    fn mid(&self, cex: Cex, symbol: &str) -> f64 {
        self.feeds.exchange(cex).mid_at(symbol, self.t_ms, AT_STALE_BASE_MS).unwrap_or(0.0)
    }
    fn settled_mid(&self, cex: Cex, symbol: &str) -> f64 {
        // A closed market's last price stays its value however long ago.
        self.feeds.exchange(cex).mid_at(symbol, self.t_ms, f64::INFINITY).unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests;
