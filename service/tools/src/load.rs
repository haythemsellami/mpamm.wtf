//! `mpamm-tools stream-load`: many viewers on the stream at once, each
//! subscribed as an Execution tab is (state and one quote topic), for a
//! load test of the fan-out (docs/rebuild-plan.md → M14). Per viewer it
//! counts messages and bytes, sequence gaps per topic, and whether the
//! server cut it; for quote frames it records proposal → receive, read on
//! the same host's clock as the server's when run beside it.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[derive(Default)]
struct Totals {
    connected: AtomicU64,
    failed: AtomicU64,
    cut: AtomicU64,
    messages: AtomicU64,
    bytes: AtomicU64,
    gaps: AtomicU64,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn gunzip(b: &[u8]) -> Option<String> {
    use std::io::Read;
    let mut s = String::new();
    flate2::read::GzDecoder::new(b).read_to_string(&mut s).ok()?;
    Some(s)
}

async fn viewer(url: String, topics: Value, secs: u64, totals: Arc<Totals>, lat: Arc<parking_lot::Mutex<Vec<f64>>>) {
    let mut req = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(_) => {
            totals.failed.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    req.headers_mut().insert("Sec-WebSocket-Protocol", "mpamm.v2.gzip".parse().unwrap());
    let Ok((mut ws, _)) = tokio_tungstenite::connect_async(req).await else {
        totals.failed.fetch_add(1, Ordering::Relaxed);
        return;
    };
    totals.connected.fetch_add(1, Ordering::Relaxed);
    if ws.send(Message::text(json!({ "type": "subscribe", "topics": topics }).to_string())).await.is_err() {
        totals.failed.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let mut seq: HashMap<String, u64> = HashMap::new();
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let msg = match tokio::time::timeout_at(end.into(), ws.next()).await {
            Err(_) => break,
            Ok(None) | Ok(Some(Err(_))) => {
                totals.cut.fetch_add(1, Ordering::Relaxed);
                return;
            }
            Ok(Some(Ok(m))) => m,
        };
        let text = match &msg {
            Message::Text(t) => {
                totals.bytes.fetch_add(t.len() as u64, Ordering::Relaxed);
                t.to_string()
            }
            Message::Binary(b) => {
                totals.bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                match gunzip(b) {
                    Some(s) => s,
                    None => continue,
                }
            }
            Message::Close(_) => {
                totals.cut.fetch_add(1, Ordering::Relaxed);
                return;
            }
            _ => continue,
        };
        let received = now_ms();
        totals.messages.fetch_add(1, Ordering::Relaxed);
        let Ok(env) = serde_json::from_str::<Value>(&text) else { continue };
        let (Some(topic), Some(n)) = (env["topic"].as_str(), env["seq"].as_u64()) else { continue };
        if let Some(prev) = seq.insert(topic.to_string(), n) {
            if env["snapshot"] != json!(true) && n > prev + 1 {
                totals.gaps.fetch_add(n - prev - 1, Ordering::Relaxed);
            }
        }
        if env["message"]["ch"] == "quotes" && env["snapshot"] != json!(true) {
            if let Some(p) = env["message"]["data"]["proposalTs"].as_f64() {
                lat.lock().push(received - p);
            }
        }
    }
    let _ = ws.close(None).await;
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() - 1) as f64 * p).round() as usize]
}

pub async fn run(url: &str, clients: usize, secs: u64, ramp_ms: u64, market: &str, size: f64) -> Result<(), String> {
    let topics = json!([
        { "channel": "state" },
        { "channel": "quotes", "market": market, "sizeUsd": size, "baseline": false },
    ]);
    let totals = Arc::new(Totals::default());
    let lat = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let started = Instant::now();
    let mut tasks = Vec::new();
    for i in 0..clients {
        tasks.push(tokio::spawn(viewer(url.to_string(), topics.clone(), secs, totals.clone(), lat.clone())));
        if ramp_ms > 0 && i + 1 < clients {
            tokio::time::sleep(Duration::from_millis(ramp_ms)).await;
        }
    }
    for t in tasks {
        let _ = t.await;
    }
    let elapsed = started.elapsed().as_secs_f64();
    let n = totals.connected.load(Ordering::Relaxed).max(1) as f64;
    let bytes = totals.bytes.load(Ordering::Relaxed) as f64;
    let mut l = lat.lock().clone();
    println!(
        "{} viewer(s) connected, {} failed, {} cut; {:.1} msg/s and {:.2} KB/s per viewer ({:.1} MB in all over {:.0} s); {} seq gap(s); proposal → receive p50 {:.0} ms, p90 {:.0} ms, p99 {:.0} ms ({} frames)",
        totals.connected.load(Ordering::Relaxed),
        totals.failed.load(Ordering::Relaxed),
        totals.cut.load(Ordering::Relaxed),
        totals.messages.load(Ordering::Relaxed) as f64 / n / secs as f64,
        bytes / n / secs as f64 / 1024.0,
        bytes / 1e6,
        elapsed,
        totals.gaps.load(Ordering::Relaxed),
        pct(&mut l, 0.5),
        pct(&mut l, 0.9),
        pct(&mut l, 0.99),
        l.len()
    );
    if totals.failed.load(Ordering::Relaxed) > 0 || totals.cut.load(Ordering::Relaxed) > 0 {
        return Err("some viewers failed or were cut".into());
    }
    Ok(())
}
