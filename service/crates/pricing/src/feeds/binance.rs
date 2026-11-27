//! Binance spot through its public data mirror (geo-unrestricted): a 20-level
//! book every 100 ms (a full snapshot each push) and the book ticker for the
//! best bid and ask, for the crypto bases, the stable crosses and the wrapper
//! bases (WBTCBTC).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::{now_ms, ws, Exchange};
use crate::book::Side;

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub rest: String,
    pub ws: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        // api.binance.com answers HTTP 451 from US IPs; the official data
        // mirror serves everyone.
        Self { rest: "https://data-api.binance.vision".into(), ws: "wss://data-stream.binance.vision".into() }
    }
}

fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn replace_book(ex: &Exchange, symbol: &str, bids: &Value, asks: &Value, now: u64) {
    ex.update(symbol, now, |s| {
        s.book.clear();
        for l in bids.as_array().into_iter().flatten() {
            s.book.set(Side::Sell, num(&l[0]), num(&l[1]));
        }
        for l in asks.as_array().into_iter().flatten() {
            s.book.set(Side::Buy, num(&l[0]), num(&l[1]));
        }
        if let Some(b) = s.book.best_bid() {
            s.best_bid = b;
        }
        if let Some(a) = s.book.best_ask() {
            s.best_ask = a;
        }
    });
}

#[derive(Deserialize)]
struct Msg {
    stream: Option<String>,
    #[serde(default)]
    data: Value,
}

pub fn apply(ex: &Exchange, raw: &str, now: u64) {
    ex.touch(now);
    let Ok(m) = serde_json::from_str::<Msg>(raw) else { return };
    let Some(stream) = m.stream else { return };
    let Some((sym, kind)) = stream.split_once('@') else { return };
    let sym = sym.to_ascii_uppercase();
    if kind.starts_with("depth") {
        replace_book(ex, &sym, &m.data["bids"], &m.data["asks"], now);
    } else if kind == "bookTicker" {
        ex.update(&sym, now, |s| {
            if num(&m.data["b"]) > 0.0 {
                s.best_bid = num(&m.data["b"]);
            }
            if num(&m.data["a"]) > 0.0 {
                s.best_ask = num(&m.data["a"]);
            }
        });
    }
}

pub async fn snapshot(ex: &Exchange, http: &reqwest::Client, ep: &Endpoints) -> Result<(), String> {
    for sym in ex.symbols() {
        let get = |url: String| async move {
            http.get(url)
                .send()
                .await
                .map_err(|e| e.without_url().to_string())?
                .json::<Value>()
                .await
                .map_err(|e| e.without_url().to_string())
        };
        let d = get(format!("{}/api/v3/depth?symbol={sym}&limit=20", ep.rest)).await?;
        replace_book(ex, &sym, &d["bids"], &d["asks"], now_ms());
        let t = get(format!("{}/api/v3/ticker/24hr?symbol={sym}", ep.rest)).await?;
        ex.update(&sym, now_ms(), |s| {
            if num(&t["lastPrice"]) > 0.0 {
                s.last = num(&t["lastPrice"]);
            }
            s.change_pct = num(&t["priceChangePercent"]);
        });
    }
    ex.touch(now_ms());
    Ok(())
}

struct Binance;

impl ws::Session for Binance {
    fn subscribe(&mut self) -> Vec<String> {
        Vec::new()
    }
    fn handle(&mut self, ex: &Exchange, raw: &str, now: u64) -> Result<Vec<String>, String> {
        apply(ex, raw, now);
        Ok(Vec::new())
    }
}

pub async fn run(ex: Arc<Exchange>, ep: Endpoints, stop: tokio::sync::watch::Receiver<bool>) {
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().expect("http client");
    let streams: Vec<String> = ex
        .symbols()
        .iter()
        .flat_map(|s| {
            let l = s.to_ascii_lowercase();
            [format!("{l}@depth20@100ms"), format!("{l}@bookTicker")]
        })
        .collect();
    let url = format!("{}/stream?streams={}", ep.ws, streams.join("/"));
    let prepare = || async {
        if let Err(e) = snapshot(&ex, &http, &ep).await {
            tracing::warn!(target: "feeds", "binance snapshot: {e}");
        }
        url.clone()
    };
    ws::run_loop("binance", ex.clone(), stop, prepare, Binance).await;
}
