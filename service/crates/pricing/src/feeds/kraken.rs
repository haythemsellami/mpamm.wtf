//! Kraken WS v2: USD books for the xStocks plus USD stablecoin crosses,
//! ported from server/src/kraken.ts.
//!
//! The instrument channel's status gates every market (24/5 xStock
//! closures); the engine status gates them all. Each book is checked against
//! Kraken's CRC32 after every message, using the exact decimal text Kraken
//! sent. A book that fails is dropped and repaired on the same connection
//! (unsubscribe, then subscribe with a fresh snapshot), retried every 30 s;
//! the other books keep quoting. A reference never substitutes a ticker or a
//! last trade for a missing book: only `settled_mid`, which values trades
//! that already happened, does.

use std::{collections::HashMap, sync::Arc};

use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};

use super::{ws, Exchange, Sym, TextLevel};
use crate::{book::Px, kraken_checksum::checksum};

pub const WS_URL: &str = "wss://ws.kraken.com/v2";
pub const DEPTH: usize = 25;
const REPAIR_RETRY_MS: u64 = 30_000;

#[derive(Debug, Clone)]
struct Repair {
    req_id: Option<u64>,
    unsubscribing: bool,
    retry_at: u64,
}

#[derive(Debug, Default)]
pub struct Kraken {
    symbols: Vec<String>,
    repairs: HashMap<String, Repair>,
    next_req_id: u64,
}

#[derive(Deserialize)]
struct Msg<'a> {
    channel: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(borrow)]
    data: Option<&'a RawValue>,
    method: Option<String>,
    req_id: Option<u64>,
    success: Option<bool>,
    symbol: Option<String>,
    error: Option<Value>,
}

#[derive(Deserialize)]
struct Level<'a> {
    #[serde(borrow)]
    price: &'a RawValue,
    #[serde(borrow)]
    qty: &'a RawValue,
}

#[derive(Deserialize)]
struct BookData<'a> {
    symbol: String,
    #[serde(default, borrow)]
    bids: Vec<Level<'a>>,
    #[serde(default, borrow)]
    asks: Vec<Level<'a>>,
    checksum: Option<u32>,
}

fn text(v: &RawValue) -> String {
    v.get().trim_matches('"').to_string()
}

/// Applies one book message to a symbol's levels and checks the result.
fn apply_book(s: &mut Sym, d: &BookData<'_>, snapshot: bool) -> Result<(), String> {
    if snapshot {
        s.kbids.clear();
        s.kasks.clear();
    } else if !s.has_book {
        return Err(format!("book update before snapshot for {}", d.symbol));
    }
    for (levels, map) in [(&d.asks, &mut s.kasks), (&d.bids, &mut s.kbids)] {
        for l in levels {
            let (pt, qt) = (text(l.price), text(l.qty));
            let (price, qty) = (pt.parse::<f64>().unwrap_or(f64::NAN), qt.parse::<f64>().unwrap_or(f64::NAN));
            if !price.is_finite() || price <= 0.0 || !qty.is_finite() || qty < 0.0 {
                return Err(format!("invalid level for {}", d.symbol));
            }
            if qty == 0.0 {
                map.remove(&Px(price));
            } else {
                map.insert(Px(price), TextLevel { price: pt, qty: qt, size: qty });
            }
        }
    }
    while s.kasks.len() > DEPTH {
        let worst = *s.kasks.keys().next_back().unwrap();
        s.kasks.remove(&worst);
    }
    while s.kbids.len() > DEPTH {
        let worst = *s.kbids.keys().next().unwrap();
        s.kbids.remove(&worst);
    }
    let crc = checksum(
        s.kasks.values().map(|l| (l.price.as_str(), l.qty.as_str())),
        s.kbids.values().rev().map(|l| (l.price.as_str(), l.qty.as_str())),
    );
    if d.checksum != Some(crc) {
        let top = |side: Vec<&TextLevel>| {
            side.iter().take(10).map(|l| format!("{}@{}", l.price, l.qty)).collect::<Vec<_>>().join(" ")
        };
        return Err(format!(
            "book checksum mismatch for {} (got {:?}, computed {crc}; asks {} | bids {})",
            d.symbol,
            d.checksum,
            top(s.kasks.values().collect()),
            top(s.kbids.values().rev().collect())
        ));
    }
    s.has_book = true;
    Ok(())
}

impl Kraken {
    pub fn new(symbols: Vec<String>) -> Self {
        Self { symbols, ..Self::default() }
    }

    fn book_request(&self, method: &str, req_id: u64, symbol: &str, snapshot: bool) -> String {
        let mut params = json!({ "channel": "book", "symbol": [symbol], "depth": DEPTH });
        if snapshot {
            params["snapshot"] = true.into();
        }
        json!({ "method": method, "req_id": req_id, "params": params }).to_string()
    }

    /// Sends the first step of every due repair (unsubscribe).
    fn retry(&mut self, now: u64) -> Vec<String> {
        let mut out = Vec::new();
        let mut ids = Vec::new();
        for (symbol, r) in self.repairs.iter_mut() {
            if now < r.retry_at {
                continue;
            }
            self.next_req_id += 1;
            r.retry_at = now + REPAIR_RETRY_MS;
            r.unsubscribing = true;
            r.req_id = Some(self.next_req_id);
            ids.push((symbol.clone(), self.next_req_id));
        }
        for (symbol, id) in ids {
            out.push(self.book_request("unsubscribe", id, &symbol, false));
        }
        out
    }

    /// One message: returns what to send back (repair requests).
    pub fn apply(&mut self, ex: &Exchange, raw: &str, now: u64) -> Result<Vec<String>, String> {
        ex.touch(now);
        let m: Msg<'_> = serde_json::from_str(raw).map_err(|e| format!("invalid message: {e}"))?;
        if let (Some(req_id), Some(method)) = (m.req_id, m.method.as_deref()) {
            if method == "subscribe" || method == "unsubscribe" {
                let mut out = Vec::new();
                if let Some((symbol, r)) = self.repairs.iter_mut().find(|(_, r)| r.req_id == Some(req_id)) {
                    if method == "unsubscribe" && r.unsubscribing {
                        // Even a rejection may mean it was already gone: a
                        // verified snapshot is required either way.
                        r.unsubscribing = false;
                        let symbol = symbol.clone();
                        out.push(self.book_request("subscribe", req_id, &symbol, true));
                    } else if method == "subscribe" && m.success == Some(false) {
                        tracing::warn!(target: "feeds", "kraken: {symbol} resubscribe rejected; retrying within 30 s");
                    }
                }
                return Ok(out);
            }
        }
        if m.success == Some(false) {
            // One rejected symbol leaves only its own book unavailable.
            if let Some(sym) = m.symbol.as_deref().filter(|s| self.symbols.iter().any(|x| x == s)) {
                ex.update(sym, now, |s| {
                    s.kbids.clear();
                    s.kasks.clear();
                    s.has_book = false;
                });
                tracing::warn!(target: "feeds", "kraken: {sym} subscription rejected ({:?}); its reference stays unavailable", m.error);
                return Ok(Vec::new());
            }
            return Err(format!("subscription failed: {:?}", m.error));
        }
        let Some(data) = m.data else { return Ok(Vec::new()) };
        match m.channel.as_deref() {
            Some("status") => {
                let d: Value = serde_json::from_str(data.get()).unwrap_or(Value::Null);
                let system = d[0]["system"].as_str();
                ex.set_engine(system == Some("online"));
            }
            Some("instrument") => {
                let d: Value = serde_json::from_str(data.get()).unwrap_or(Value::Null);
                for p in d["pairs"].as_array().into_iter().flatten() {
                    if let (Some(sym), Some(st)) = (p["symbol"].as_str(), p["status"].as_str()) {
                        ex.update(sym, now, |s| s.status = Some(st.to_string()));
                    }
                }
            }
            Some("ticker") => {
                let d: Value = serde_json::from_str(data.get()).unwrap_or(Value::Null);
                for t in d.as_array().into_iter().flatten() {
                    let Some(sym) = t["symbol"].as_str() else { continue };
                    let (bid, ask, last) = (
                        t["bid"].as_f64().unwrap_or(0.0),
                        t["ask"].as_f64().unwrap_or(0.0),
                        t["last"].as_f64().unwrap_or(0.0),
                    );
                    // The bid/ask mid, else the last trade: an illiquid xStock
                    // can go a day without a trade and still be quoted.
                    let px = if bid > 0.0 && ask > bid { (bid + ask) / 2.0 } else { last.max(0.0) };
                    ex.update(sym, now, |s| {
                        if let Some(c) = t["change_pct"].as_f64() {
                            s.change_pct = c;
                        }
                        if px > 0.0 {
                            s.last_ticker = px;
                        }
                    });
                }
            }
            Some("book") => {
                let snapshot = m.kind.as_deref() == Some("snapshot");
                let books: Vec<BookData<'_>> =
                    serde_json::from_str(data.get()).map_err(|e| format!("book data: {e}"))?;
                let mut failed = false;
                for d in &books {
                    if !self.symbols.iter().any(|s| s == &d.symbol) {
                        continue;
                    }
                    let repairing = self.repairs.get(&d.symbol).cloned();
                    if let Some(r) = &repairing {
                        // While repairing, only the requested snapshot counts.
                        if !snapshot || r.unsubscribing {
                            continue;
                        }
                    }
                    let mut result = Ok(());
                    ex.update(&d.symbol, now, |s| {
                        result = apply_book(s, d, snapshot);
                        if result.is_err() {
                            s.kbids.clear();
                            s.kasks.clear();
                            s.has_book = false;
                        }
                    });
                    match result {
                        Ok(()) => {
                            self.repairs.remove(&d.symbol);
                        }
                        Err(why) if repairing.is_some() => {
                            tracing::warn!(target: "feeds", "kraken: {why}; repair snapshot rejected, retrying within 30 s");
                        }
                        Err(why) => {
                            tracing::warn!(target: "feeds", "kraken: {why}; awaiting a fresh {} snapshot", d.symbol);
                            self.repairs
                                .insert(d.symbol.clone(), Repair { req_id: None, unsubscribing: false, retry_at: now });
                            failed = true;
                        }
                    }
                }
                if failed {
                    return Ok(self.retry(now));
                }
            }
            _ => {}
        }
        Ok(Vec::new())
    }
}

impl ws::Session for Kraken {
    fn subscribe(&mut self) -> Vec<String> {
        self.repairs.clear();
        vec![
            json!({ "method": "subscribe", "params": { "channel": "instrument", "include_tokenized_assets": true } })
                .to_string(),
            json!({ "method": "subscribe", "params": { "channel": "book", "symbol": self.symbols, "depth": DEPTH } })
                .to_string(),
            json!({ "method": "subscribe", "params": { "channel": "ticker", "symbol": self.symbols } }).to_string(),
        ]
    }
    fn handle(&mut self, ex: &Exchange, raw: &str, now: u64) -> Result<Vec<String>, String> {
        self.apply(ex, raw, now)
    }
    fn tick(&mut self, _ex: &Exchange, now: u64) -> Vec<String> {
        self.retry(now)
    }
}

pub async fn run(ex: Arc<Exchange>, url: String, stop: tokio::sync::watch::Receiver<bool>) {
    let session = Kraken::new(ex.symbols());
    let prepare = || async { url.clone() };
    ws::run_loop("kraken", ex.clone(), stop, prepare, session).await;
}
