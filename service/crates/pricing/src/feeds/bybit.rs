//! Bybit V5 spot: the MONUSDT order book (`orderbook.50`, snapshot then
//! deltas), the top of book of the stable crosses (USDCUSDT, USD1USDT:
//! `orderbook.1`), and tickers for the last price and 24 h change.
//!
//! The crosses need the top-of-book stream: Bybit's spot ticker stream
//! carries no bid or ask, so a cross fed by tickers alone keeps the best bid
//! and ask of its REST snapshot until the next reconnect. Today's system does
//! exactly that, and its MON/USDC and MON/USD1 references sit up to a tick
//! (about 0.5 bp) off the live cross.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{now_ms, ws, Exchange};
use crate::book::Side;

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub rest: String,
    pub ws: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self { rest: "https://api.bybit.com".into(), ws: "wss://stream.bybit.com/v5/public/spot".into() }
    }
}

/// The symbol whose full book is kept (the others are tickers only).
pub const BOOK_SYMBOL: &str = "MONUSDT";

fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn levels(v: &Value) -> Vec<(f64, f64)> {
    v.as_array().map(|a| a.iter().map(|l| (num(&l[0]), num(&l[1]))).collect()).unwrap_or_default()
}

fn recompute_best(s: &mut super::Sym) {
    if let Some(b) = s.book.best_bid() {
        s.best_bid = b;
    }
    if let Some(a) = s.book.best_ask() {
        s.best_ask = a;
    }
}

fn apply_book(ex: &Exchange, symbol: &str, bids: &Value, asks: &Value, snapshot: bool, now: u64) {
    ex.update(symbol, now, |s| {
        if snapshot {
            s.book.clear();
        }
        for (p, q) in levels(bids) {
            s.book.set(Side::Sell, p, q);
        }
        for (p, q) in levels(asks) {
            s.book.set(Side::Buy, p, q);
        }
        recompute_best(s);
    });
}

fn apply_ticker(ex: &Exchange, symbol: &str, d: &Value, now: u64) {
    ex.update(symbol, now, |s| {
        if !d["lastPrice"].is_null() {
            s.last = num(&d["lastPrice"]);
        }
        if !d["price24hPcnt"].is_null() {
            s.change_pct = num(&d["price24hPcnt"]) * 100.0;
        }
        if !d["bid1Price"].is_null() && num(&d["bid1Price"]) > 0.0 {
            s.best_bid = num(&d["bid1Price"]);
        }
        if !d["ask1Price"].is_null() && num(&d["ask1Price"]) > 0.0 {
            s.best_ask = num(&d["ask1Price"]);
        }
    });
}

#[derive(Deserialize)]
struct Msg {
    topic: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    data: Value,
}

/// Applies one WebSocket message.
pub fn apply(ex: &Exchange, raw: &str, now: u64) {
    ex.touch(now);
    let Ok(m) = serde_json::from_str::<Msg>(raw) else { return };
    let Some(topic) = m.topic else { return };
    if let Some(sym) = topic.strip_prefix("orderbook.50.") {
        apply_book(ex, sym, &m.data["b"], &m.data["a"], m.kind.as_deref() == Some("snapshot"), now);
    } else if let Some(sym) = topic.strip_prefix("orderbook.1.") {
        // Top of book only: every message is the whole (one-level) book.
        apply_book(ex, sym, &m.data["b"], &m.data["a"], true, now);
    } else if let Some(sym) = topic.strip_prefix("tickers.") {
        apply_ticker(ex, sym, &m.data, now);
    }
}

/// REST cold start: the book and every ticker.
pub async fn snapshot(ex: &Exchange, http: &reqwest::Client, ep: &Endpoints) -> Result<(), String> {
    let get = |url: String| async move {
        http.get(url)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?
            .json::<Value>()
            .await
            .map_err(|e| e.without_url().to_string())
    };
    let book = get(format!("{}/v5/market/orderbook?category=spot&symbol={BOOK_SYMBOL}&limit=50", ep.rest)).await?;
    let r = &book["result"];
    apply_book(ex, BOOK_SYMBOL, &r["b"], &r["a"], true, now_ms());
    for sym in ex.symbols() {
        let t = get(format!("{}/v5/market/tickers?category=spot&symbol={sym}", ep.rest)).await?;
        if let Some(row) = t["result"]["list"].get(0) {
            apply_ticker(ex, &sym, row, now_ms());
        }
    }
    ex.touch(now_ms());
    Ok(())
}

struct Bybit {
    subscribe: String,
}

impl ws::Session for Bybit {
    fn subscribe(&mut self) -> Vec<String> {
        vec![self.subscribe.clone()]
    }
    fn handle(&mut self, ex: &Exchange, raw: &str, now: u64) -> Result<Vec<String>, String> {
        apply(ex, raw, now);
        Ok(Vec::new())
    }
    /// The public stream needs a ping every 20 s.
    fn ping(&self) -> Option<(std::time::Duration, String)> {
        Some((std::time::Duration::from_secs(20), json!({ "op": "ping" }).to_string()))
    }
}

pub async fn run(ex: Arc<Exchange>, ep: Endpoints, stop: tokio::sync::watch::Receiver<bool>) {
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().expect("http client");
    let mut args = vec![format!("orderbook.50.{BOOK_SYMBOL}")];
    args.extend(ex.symbols().iter().filter(|s| *s != BOOK_SYMBOL).map(|s| format!("orderbook.1.{s}")));
    args.extend(ex.symbols().iter().map(|s| format!("tickers.{s}")));
    let session = Bybit { subscribe: json!({ "op": "subscribe", "args": args }).to_string() };
    let prepare = || async {
        if let Err(e) = snapshot(&ex, &http, &ep).await {
            tracing::warn!(target: "feeds", "bybit snapshot: {e}");
        }
        ep.ws.clone()
    };
    ws::run_loop("bybit", ex.clone(), stop, prepare, session).await;
}
