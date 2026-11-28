//! `/stream` over a real WebSocket: the router served on 127.0.0.1:0 and a
//! tokio-tungstenite client. Ports today's stream-egress, stream-v2 and
//! backpressure assertions that depend on the wire: negotiation, envelopes,
//! what never rides the stream, shared compression, close codes and cuts.
//! The ordering and coalescing rules are tested on the gateway itself
//! (src/gateway.rs), where the order of events is deterministic.

mod common;

use std::io::Read;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use indexmap::IndexMap;
use mpamm_api::testing::{sample_state, FakeSource};
use mpamm_api::ApiSource;
use mpamm_types::{StreamMessage, StreamState, TailStatus};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const GZIP: &str = "mpamm.v2.gzip";
const JSON_PROTOCOL: &str = "mpamm.v2.json";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn listen(s: &Server) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = s.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

async fn open(addr: SocketAddr, protocols: &[&str]) -> Result<(Ws, Option<String>), String> {
    let mut req = format!("ws://{addr}/stream").into_client_request().unwrap();
    if !protocols.is_empty() {
        req.headers_mut().insert("sec-websocket-protocol", HeaderValue::from_str(&protocols.join(", ")).unwrap());
    }
    let (ws, res) = tokio_tungstenite::connect_async(req).await.map_err(|e| e.to_string())?;
    let protocol = res.headers().get("sec-websocket-protocol").map(|v| v.to_str().unwrap().to_string());
    Ok((ws, protocol))
}

/// A connected client whose reader records every message.
struct Client {
    sink: SplitSink<Ws, Message>,
    protocol: Option<String>,
    frames: Arc<Mutex<Vec<Value>>>,
    /// (binary?, bytes on the wire after WebSocket framing is removed, decoded text)
    raw: Arc<Mutex<Vec<(bool, usize, String)>>>,
    close: Arc<Mutex<Option<u16>>>,
    ended: Arc<AtomicBool>,
}

impl Client {
    async fn connect(addr: SocketAddr, protocols: &[&str]) -> Client {
        let (ws, protocol) = open(addr, protocols).await.unwrap();
        let (sink, stream) = ws.split();
        let c = Client {
            sink,
            protocol,
            frames: Arc::default(),
            raw: Arc::default(),
            close: Arc::default(),
            ended: Arc::default(),
        };
        tokio::spawn(read(stream, c.frames.clone(), c.raw.clone(), c.close.clone(), c.ended.clone()));
        c
    }

    async fn subscribe(&mut self, topics: Value) {
        let text = json!({ "type": "subscribe", "topics": topics }).to_string();
        self.sink.send(Message::text(text)).await.unwrap();
    }

    fn frames(&self) -> Vec<Value> {
        self.frames.lock().clone()
    }

    fn count(&self) -> usize {
        self.frames.lock().len()
    }

    fn binaries(&self) -> usize {
        self.raw.lock().iter().filter(|(binary, _, _)| *binary).count()
    }

    fn wire_text(&self) -> String {
        self.raw.lock().iter().map(|(_, _, t)| t.as_str()).collect::<Vec<_>>().join("\n")
    }

    fn channel(&self, ch: &str) -> Vec<Value> {
        self.frames().into_iter().filter(|f| f["message"]["ch"] == ch).collect()
    }
}

async fn read(
    mut stream: SplitStream<Ws>,
    frames: Arc<Mutex<Vec<Value>>>,
    raw: Arc<Mutex<Vec<(bool, usize, String)>>>,
    close: Arc<Mutex<Option<u16>>>,
    ended: Arc<AtomicBool>,
) {
    while let Some(Ok(message)) = stream.next().await {
        let (binary, len, text) = match message {
            Message::Text(t) => (false, t.len(), t.to_string()),
            Message::Binary(b) => {
                let mut text = String::new();
                flate2::read::GzDecoder::new(&b[..]).read_to_string(&mut text).unwrap();
                (true, b.len(), text)
            }
            Message::Close(frame) => {
                *close.lock() = frame.map(|f| u16::from(f.code));
                continue;
            }
            _ => continue,
        };
        frames.lock().push(serde_json::from_str(&text).unwrap());
        raw.lock().push((binary, len, text));
    }
    ended.store(true, Ordering::SeqCst);
}

fn quotes_topic(market: &str, size: u32) -> Value {
    json!({ "channel": "quotes", "market": market, "sizeUsd": size, "baseline": false })
}

/// Today's test source: one venue's MON/USDC and BTC/USDC rows at $1,000,
/// a MON/USDC row at $100, a block hash, and a private note.
fn source() -> Arc<FakeSource> {
    let mut state = sample_state();
    state.markets = vec!["MON/USDC".into(), "BTC/USDC".into()];
    state.notes = Some(vec![mpamm_types::StateNote {
        ts: 0.0,
        level: mpamm_types::NoteLevel::Info,
        code: "source.sim".into(),
        venue: None,
        msg: "private diagnostic".into(),
    }]);
    state.quote_markets = Some([("poe".to_string(), vec!["MON/USDC".to_string()])].into_iter().collect());
    let source = FakeSource::new(state);
    source.with(|d| {
        d.quotes = quotes(
            1,
            vec![row("poe", "MON/USDC", 1000.0), row("poe", "BTC/USDC", 1000.0), row("poe", "MON/USDC", 100.0)],
        );
        d.quotes.frame = Some(frame_telemetry());
    });
    source
}

fn push_quotes(source: &FakeSource, block: u64) {
    let q = source.with(|d| {
        d.quotes.block = block;
        d.quotes.clone()
    });
    source.push(StreamMessage::Quotes(Box::new(q)));
}

fn push_state(s: &Server, block: u64, edit: impl FnOnce(&mut StreamState)) {
    // past the once-a-second state throttle
    s.clock.advance(1_001);
    let mut state = StreamState::hello(&s.source.state());
    state.block = block;
    edit(&mut state);
    s.source.push(StreamMessage::State(Box::new(state)));
}

async fn health(s: &Server) -> Value {
    get_json(&s.router, "/api/health").await.1["stream"].clone()
}

// ── negotiation and envelopes ──────────────────────────────────────────────

#[tokio::test]
async fn negotiates_a_v2_encoding_and_delivers_versioned_frames() {
    for (offered, selected) in [
        (vec![GZIP], GZIP),
        (vec![JSON_PROTOCOL], JSON_PROTOCOL),
        (vec!["mpamm.future", JSON_PROTOCOL], JSON_PROTOCOL),
        (vec![JSON_PROTOCOL, GZIP], GZIP),
    ] {
        let s = server(source());
        let addr = listen(&s).await;
        let mut c = Client::connect(addr, &offered).await;
        assert_eq!(c.protocol.as_deref(), Some(selected));
        c.subscribe(json!([quotes_topic("MON/USDC", 1000)])).await;
        wait_for(|| c.count() == 1).await;
        let first = &c.frames()[0];
        assert_eq!(
            (first["v"].clone(), first["seq"].clone(), first["snapshot"].clone()),
            (json!(2), json!(0), json!(true))
        );
        assert_eq!(first["topic"], "quotes:MON/USDC:1000:0");
        assert_eq!(first["epoch"].as_str().unwrap().len(), 36);
        assert_eq!(
            first["message"]["data"]["rows"],
            json!([serde_json::to_value(row("poe", "MON/USDC", 1000.0)).unwrap()])
        );
        push_quotes(&s.source, 2);
        wait_for(|| c.count() == 2).await;
        let second = &c.frames()[1];
        assert_eq!((second["seq"].clone(), second["message"]["data"]["block"].clone()), (json!(1), json!(2)));
        assert!(second.get("snapshot").is_none());
        assert_eq!(second["epoch"], first["epoch"]);
        assert_eq!(c.binaries(), if selected == GZIP { 2 } else { 0 }, "{offered:?}");
    }
}

#[tokio::test]
async fn refuses_a_client_that_offers_no_v2_encoding() {
    let s = server(source());
    let addr = listen(&s).await;
    for offered in [vec!["mpamm.future"], vec![]] {
        let Err(err) = open(addr, &offered).await else { panic!("{offered:?} was accepted") };
        assert!(err.contains("400"), "{offered:?}: {err}");
    }
}

// ── egress: what never rides the stream ───────────────────────────────────

#[tokio::test]
async fn the_registry_rides_only_the_first_state_frame_and_notes_never() {
    let s = server(FakeSource::new(busy_state()));
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[JSON_PROTOCOL]).await;
    c.subscribe(json!([{ "channel": "state" }])).await;
    wait_for(|| c.count() == 1).await;
    push_state(&s, 12_346, |_| {});
    wait_for(|| c.count() == 2).await;
    let states: Vec<Value> = c.channel("state").iter().map(|f| f["message"]["data"].clone()).collect();
    assert_eq!(
        states[0]["venues"],
        serde_json::to_value(sample_state().venues).unwrap(),
        "the hello: the client renders from it"
    );
    assert!(states[1].get("venues").is_none(), "every later frame: it cannot have changed");
    for state in &states {
        assert!(state.get("notes").is_none() && state.get("realtime").is_none());
    }
    // …and not merely absent from the parsed object: no note text on the wire
    assert!(!c.wire_text().contains("xxxx"));
    // the lean frame is a diet, not a different message
    let tick = &states[1];
    for (k, v) in
        [("chainId", json!(143)), ("block", json!(12_346)), ("monUsd", json!(0.024)), ("source", json!("sim"))]
    {
        assert_eq!(tick[k], v, "{k}");
    }
    for k in ["monChangePct", "takerBps", "markets", "sizesUsd", "quoteCadenceMs"] {
        assert!(tick.get(k).is_some(), "{k}");
    }
}

#[tokio::test]
async fn a_state_tick_costs_an_order_of_magnitude_less_than_the_frame_it_replaced() {
    let s = server(FakeSource::new(busy_state()));
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[JSON_PROTOCOL]).await;
    c.subscribe(json!([{ "channel": "state" }])).await;
    wait_for(|| c.count() == 1).await;
    push_state(&s, 12_346, |_| {});
    wait_for(|| c.count() == 2).await;
    let before = json!({ "ch": "state", "data": busy_state() }).to_string().len();
    let tick = c.raw.lock()[1].1;
    assert!(before > 18_000, "what prod used to ship ~6x/s: {before}");
    assert!(tick < before / 10, "{tick} vs {before}");
}

#[tokio::test]
async fn quote_pace_telemetry_never_rides_the_stream() {
    let source = source();
    source.with(|d| d.state.realtime = Some(realtime()));
    let s = server(source);
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[JSON_PROTOCOL]).await;
    c.subscribe(json!([{ "channel": "state" }, quotes_topic("MON/USDC", 1000)])).await;
    wait_for(|| c.count() == 2).await;
    push_quotes(&s.source, 2);
    wait_for(|| c.count() == 3).await;
    push_state(&s, 2, |_| {});
    wait_for(|| c.count() == 4).await;
    let (states, quotes) = (c.channel("state"), c.channel("quotes"));
    assert_eq!((states.len(), quotes.len()), (2, 2));
    for f in &states {
        assert!(f["message"]["data"].get("realtime").is_none());
    }
    for f in &quotes {
        assert!(f["message"]["data"].get("frame").is_none());
        assert_eq!(f["message"]["data"]["ts"], 100.0, "the chart's timestamp stays");
        assert_eq!(f["message"]["data"]["rows"].as_array().unwrap().len(), 1);
    }
    let wire = c.wire_text();
    assert!(!["coveragePct60s", "adapterMs", "missingVenues", "private diagnostic"].iter().any(|t| wire.contains(t)));
    assert!(s.source.quotes().frame.is_some(), "the source's own snapshot (REST) is untouched");
}

/// The fill tail's lag is the one conditional health field: present only
/// while the tail is behind, so a healthy tick carries no `tail` key at all.
#[tokio::test]
async fn carries_the_tail_lag_only_while_the_source_reports_one() {
    let s = server(source());
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[GZIP]).await;
    c.subscribe(json!([{ "channel": "state" }])).await;
    wait_for(|| c.count() == 1).await;
    let tail = TailStatus { block: 121_585_293, lag_blocks: 1_021_587, lag_ms: 306_476_100.0, held: true };
    push_state(&s, 2, |st| st.tail = Some(tail.clone()));
    wait_for(|| c.count() == 2).await;
    push_state(&s, 3, |_| {});
    wait_for(|| c.count() == 3).await;
    let states = c.channel("state");
    assert_eq!(states[1]["message"]["data"]["tail"], serde_json::to_value(&tail).unwrap());
    assert!(states[2]["message"]["data"].get("tail").is_none());
}

// ── shared encoding ────────────────────────────────────────────────────────

#[tokio::test]
async fn filters_before_encoding_and_shares_compression() {
    let s = server(source());
    let addr = listen(&s).await;
    let topic = json!([quotes_topic("MON/USDC", 1000)]);
    let (mut a, mut b) = (Client::connect(addr, &[GZIP]).await, Client::connect(addr, &[GZIP]).await);
    a.subscribe(topic.clone()).await;
    wait_for(|| a.count() == 1).await;
    b.subscribe(topic).await;
    wait_for(|| b.count() == 1).await;
    assert_eq!((a.binaries(), b.binaries()), (1, 1));
    assert_eq!(a.frames()[0], b.frames()[0]);
    assert_eq!(health(&s).await["encodes"], 1, "one compression for both snapshots");
    let mut historical = Client::connect(addr, &[GZIP]).await;
    historical.subscribe(json!([{ "channel": "state" }])).await;
    wait_for(|| historical.count() == 1).await;
    let initial = health(&s).await["encodes"].as_u64().unwrap();
    assert!(!historical.wire_text().contains("private diagnostic"));
    push_quotes(&s.source, 2);
    wait_for(|| a.count() == 2 && b.count() == 2).await;
    assert_eq!(a.frames()[1], b.frames()[1]);
    assert_eq!(a.frames()[1]["seq"], 1);
    assert_eq!(a.binaries(), 2);
    assert!(historical.frames().iter().all(|f| f["message"]["ch"] == "state"));
    let after = health(&s).await;
    assert_eq!(after["encodes"].as_u64().unwrap() - initial, 1, "one compression for every subscriber");
    assert_eq!(after["protocol"], "v2");
    assert_eq!(after["connections"], 3);
}

#[tokio::test]
async fn compresses_state_quote_and_depth_snapshots_once_for_identical_subscribers() {
    let source = source();
    let large: IndexMap<String, Vec<String>> =
        (0..40).map(|i| (format!("venue-{i}"), vec!["MON/USDC".to_string(), "BTC/USDC".to_string()])).collect();
    source.with(|d| d.state.quote_markets = Some(large));
    let points: Vec<Value> = (0..25).map(|i| json!({ "notional": 10 * (i + 1), "bidBps": -i, "askBps": i })).collect();
    let depth = json!({ "market": "MON/USDC", "asOfBlock": 1, "refMid": 0.024, "ts": 100,
        "venues": [{ "venueId": "poe", "maxNotional": 100000, "points": points }] });
    source.publish_depth("MON/USDC", depth.to_string());
    let s = server(source);
    let addr = listen(&s).await;
    let topics =
        json!([{ "channel": "state" }, quotes_topic("MON/USDC", 1000), { "channel": "depth", "market": "MON/USDC" }]);
    let (mut a, mut b) = (Client::connect(addr, &[GZIP]).await, Client::connect(addr, &[GZIP]).await);
    a.subscribe(topics.clone()).await;
    wait_for(|| a.count() == 3).await;
    b.subscribe(topics).await;
    wait_for(|| b.count() == 3).await;
    assert_eq!((a.binaries(), b.binaries()), (3, 3));
    assert_eq!(a.frames(), b.frames());
    assert!(a.frames().iter().all(|f| f["snapshot"] == true && f["seq"] == 0));
    let state = &a.channel("state")[0]["message"]["data"];
    assert!(state.get("venues").is_some() && state.get("notes").is_none());
    assert_eq!(a.channel("depth")[0]["message"]["data"], depth);
    assert_eq!(health(&s).await["encodes"], 3);
}

#[tokio::test]
async fn keeps_a_small_live_update_behind_its_compressed_snapshot() {
    let source = source();
    // the update lands exactly while the snapshot is being taken
    let fired = Arc::new(AtomicBool::new(false));
    let (src, f) = (Arc::downgrade(&source), fired.clone());
    source.with(|d| {
        d.on_quotes = Some(Arc::new(move || {
            if !f.swap(true, Ordering::SeqCst) {
                if let Some(src) = src.upgrade() {
                    src.push(StreamMessage::Quotes(Box::new(quotes(2, vec![]))));
                }
            }
        }))
    });
    let s = server(source);
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[GZIP]).await;
    c.subscribe(json!([quotes_topic("MON/USDC", 1000)])).await;
    wait_for(|| c.count() == 2).await;
    let f = c.frames();
    assert_eq!(c.binaries(), 1);
    assert_eq!(
        (f[0]["snapshot"].clone(), f[0]["seq"].clone(), f[0]["message"]["data"]["block"].clone()),
        (json!(true), json!(0), json!(1))
    );
    assert_eq!((f[1]["seq"].clone(), f[1]["message"]["data"]["block"].clone()), (json!(1), json!(2)));
    assert!(f[1].get("snapshot").is_none());
}

#[tokio::test]
async fn reads_the_baseline_registry_once_per_publication_across_quote_topics() {
    let s = server(source());
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[JSON_PROTOCOL]).await;
    let topics: Vec<Value> = ["MON/USDC", "BTC/USDC"]
        .iter()
        .flat_map(|m| [100, 1000, 10_000, 100_000].map(|z| quotes_topic(m, z)))
        .collect();
    c.subscribe(Value::Array(topics.clone())).await;
    wait_for(|| c.count() == topics.len()).await;
    s.source.calls.venues.store(0, Ordering::SeqCst);
    push_quotes(&s.source, 2);
    wait_for(|| c.count() == topics.len() * 2).await;
    assert_eq!(s.source.calls.venues.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn baseline_rows_go_only_to_baseline_topics() {
    let source = source();
    source.with(|d| d.quotes.rows.push(row("uniswap", "MON/USDC", 1000.0)));
    let s = server(source);
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[JSON_PROTOCOL]).await;
    let with_baseline = json!({ "channel": "quotes", "market": "MON/USDC", "sizeUsd": 1000, "baseline": true });
    c.subscribe(json!([quotes_topic("MON/USDC", 1000), with_baseline])).await;
    wait_for(|| c.count() == 2).await;
    let venues = |topic: &str| -> Vec<String> {
        let f = c.frames().into_iter().find(|f| f["topic"] == topic).unwrap();
        f["message"]["data"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["venueId"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(venues("quotes:MON/USDC:1000:0"), ["poe"]);
    assert_eq!(venues("quotes:MON/USDC:1000:1"), ["poe", "uniswap"]);
}

#[tokio::test]
async fn changes_subscriptions_without_leaking_rows_from_the_previous_market() {
    let s = server(source());
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[GZIP]).await;
    c.subscribe(json!([quotes_topic("MON/USDC", 1000)])).await;
    wait_for(|| c.count() == 1).await;
    c.subscribe(json!([quotes_topic("BTC/USDC", 1000)])).await;
    wait_for(|| c.count() == 2).await;
    push_quotes(&s.source, 2);
    wait_for(|| c.count() == 3).await;
    for f in &c.frames()[1..] {
        let markets: Vec<&str> =
            f["message"]["data"]["rows"].as_array().unwrap().iter().map(|r| r["market"].as_str().unwrap()).collect();
        assert_eq!(markets, ["BTC/USDC"]);
    }
    assert_eq!(health(&s).await["topics"], 1);
}

// ── limits ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn rejects_arbitrary_sizes_instead_of_creating_unbounded_demand() {
    let s = server(source());
    let addr = listen(&s).await;
    let mut c = Client::connect(addr, &[GZIP]).await;
    c.subscribe(json!([{ "channel": "state" }])).await;
    wait_for(|| c.count() == 1).await;
    c.subscribe(json!([quotes_topic("MON/USDC", 12_345)])).await;
    wait_for(|| c.ended.load(Ordering::SeqCst)).await;
    assert_eq!(*c.close.lock(), Some(1008));
    let h = health(&s).await;
    assert_eq!((h["connections"].clone(), h["topics"].clone()), (json!(0), json!(0)));
}

#[tokio::test]
async fn closes_on_too_many_topics_or_a_message_that_is_not_a_subscription() {
    let s = server(source());
    let addr = listen(&s).await;
    let many: Vec<Value> = (0..129).map(|_| json!({ "channel": "state" })).collect();
    for bad in [
        json!({ "type": "subscribe", "topics": many }).to_string(),
        "hello".to_string(),
        json!({ "type": "ping" }).to_string(),
    ] {
        let mut c = Client::connect(addr, &[JSON_PROTOCOL]).await;
        c.sink.send(Message::text(bad)).await.unwrap();
        wait_for(|| c.ended.load(Ordering::SeqCst)).await;
        assert_eq!(*c.close.lock(), Some(1008));
    }
}

#[tokio::test]
async fn a_peer_that_never_answers_a_ping_is_cut() {
    let s = server_with(source(), |c| c.heartbeat = Duration::from_millis(50));
    let addr = listen(&s).await;
    // reads, so its library answers every ping
    let mut live = Client::connect(addr, &[JSON_PROTOCOL]).await;
    live.subscribe(json!([{ "channel": "fill" }])).await;
    // never reads, so it never answers
    let (mut silent, _) = open(addr, &[JSON_PROTOCOL]).await.unwrap();
    silent
        .send(Message::text(json!({ "type": "subscribe", "topics": [{ "channel": "volume" }] }).to_string()))
        .await
        .unwrap();
    let mut h = health(&s).await;
    for _ in 0..100 {
        if h["connections"] == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        h = health(&s).await;
    }
    assert_eq!((h["connections"].clone(), h["topics"].clone()), (json!(1), json!(1)), "only the silent peer went");
    assert!(!live.ended.load(Ordering::SeqCst));
    drop(silent);
}

#[tokio::test]
async fn a_peer_that_stops_reading_is_cut_not_buffered() {
    let source = source();
    // ~100 KB per frame: a JSON peer gets every one uncompressed
    let rows: Vec<_> = (0..300).map(|_| row("poe", "MON/USDC", 1000.0)).collect();
    source.with(|d| d.quotes.rows = rows);
    let s = server(source);
    let addr = listen(&s).await;
    let (mut stalled, _) = open(addr, &[JSON_PROTOCOL]).await.unwrap();
    stalled
        .send(Message::text(json!({ "type": "subscribe", "topics": [quotes_topic("MON/USDC", 1000)] }).to_string()))
        .await
        .unwrap();
    let mut block = 2;
    let cut = Arc::new(AtomicUsize::new(0));
    while block < 2_000 {
        push_quotes(&s.source, block);
        block += 1;
        if block % 20 == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let h = health(&s).await;
            if h["slowClients"] == 1 {
                cut.store(block as usize, Ordering::SeqCst);
                break;
            }
        }
    }
    assert!(cut.load(Ordering::SeqCst) > 0, "the stalled peer was never cut");
    let h = health(&s).await;
    assert_eq!((h["connections"].clone(), h["topics"].clone()), (json!(0), json!(0)));
    drop(stalled);
}
