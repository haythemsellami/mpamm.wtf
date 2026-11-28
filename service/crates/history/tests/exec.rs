//! A repair end to end, against a fake archive and a fake venue: day
//! boundaries, the trades table's first day, a read failure mid-job and the
//! resume, blocks holding only gas-event logs, listed markets, and the live
//! decode state left alone.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use axum::{routing::post, Json, Router};
use mpamm_chain::Rpc;
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, GasSources, Venue, VenueError};
use mpamm_history::{
    exec::{day_start_s, Executor, Sink, Stats},
    plan::{Kind, Planned},
    ArchivePool, PoolConfig,
};
use mpamm_pricing::{
    archives::{
        closed_day::{ClosedDayPrices, DayLoader},
        ArchiveError, DayPrices,
    },
    Fees, Prices,
};
use mpamm_registry::Registry;
use mpamm_ring::{hex, TopicFilter, WatchSet};
use mpamm_store::{history::DayOutcome, writer::Writer, Store};
use mpamm_types::{
    utc_day, Fill, FillCategory, Side, ThemeColor, TimeSource, VenueDaily, VenueKind, VenueMeta, VenueRole,
};
use parking_lot::Mutex;
use serde_json::{json, Value};

const DAY0: &str = "2026-11-20";
/// Ten minutes a block: 144 blocks a day, block 1 at DAY0's midnight.
const BLOCK_S: u64 = 600;
const HEAD: u64 = 600;
const TRADE: [u8; 20] = [0xaa; 20];
const ORACLE: [u8; 20] = [0x0c; 20];
const SWAP: [u8; 32] = [0x51; 32];
const PUSH: [u8; 32] = [0x70; 32];

fn ts(n: u64) -> u64 {
    day_start_s(DAY0).unwrap() + (n - 1) * BLOCK_S
}

fn ms(n: u64) -> f64 {
    ts(n) as f64 * 1000.0
}

fn h32(tag: u8, n: u64) -> String {
    format!("0x{:02x}{:062x}", tag, n)
}

/// One log of the fake chain: (block, address, topic0, market code, usd).
type ChainLog = (u64, [u8; 20], [u8; 32], u8, u64);

fn chain_logs() -> Vec<ChainLog> {
    vec![
        (10, TRADE, SWAP, 1, 10),   // day 0
        (20, ORACLE, PUSH, 0, 0),   // gas only
        (150, TRADE, SWAP, 1, 40),  // day 1
        (151, TRADE, SWAP, 2, 5),   // day 1, BTC
        (160, ORACLE, PUSH, 0, 0),  // gas only
        (300, TRADE, SWAP, 1, 7),   // day 2
        (420, TRADE, SWAP, 1, 100), // day 2, after b0: the live pipeline's
    ]
}

fn log_json(n: u64, i: usize, addr: [u8; 20], topic: [u8; 32], market: u8, usd: u64) -> Value {
    json!({
        "blockNumber": format!("0x{n:x}"), "blockHash": h32(0xb, n), "logIndex": format!("0x{i:x}"),
        "transactionIndex": "0x0", "transactionHash": h32(0x7, n),
        "address": format!("0x{}", hex(&addr)),
        "topics": [format!("0x{}", hex(&topic)), format!("0x{:064x}", market)],
        "data": format!("0x{usd:064x}"),
    })
}

fn block_json(n: u64) -> Value {
    json!({
        "number": format!("0x{n:x}"), "hash": h32(0xb, n), "parentHash": h32(0xb, n - 1),
        "timestamp": format!("0x{:x}", ts(n)), "gasUsed": "0x0", "baseFeePerGas": "0x1",
        "transactions": [{
            "type": "0x0", "to": format!("0x{}", hex(&TRADE)), "gasPrice": "0x2", "transactionIndex": "0x0",
            "hash": h32(0x7, n), "from": format!("0x{}", hex(&[0x99; 20])), "gas": "0x5208", "input": "0x",
        }],
    })
}

struct Archive {
    url: String,
    /// Every block read in full.
    full: Arc<Mutex<Vec<u64>>>,
    /// getLogs fails for ranges reaching past block 290 while set.
    fail: Arc<AtomicBool>,
    /// Blocks below this one aren't held (a node's history starts later).
    oldest: Arc<std::sync::atomic::AtomicU64>,
}

async fn archive() -> Archive {
    let full = Arc::new(Mutex::new(Vec::new()));
    let fail = Arc::new(AtomicBool::new(false));
    let oldest = Arc::new(std::sync::atomic::AtomicU64::new(1));
    let (f, x, o) = (full.clone(), fail.clone(), oldest.clone());
    let one = move |req: &Value| -> Value {
        let id = req["id"].clone();
        let q = |v: &Value| u64::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
        let result = match req["method"].as_str().unwrap() {
            "eth_blockNumber" => json!(format!("0x{HEAD:x}")),
            "eth_getLogs" => {
                let p = &req["params"][0];
                let (from, to) = (q(&p["fromBlock"]), q(&p["toBlock"]));
                if x.load(Ordering::SeqCst) && to > 290 {
                    return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": "Internal error: error reading from db due to rate limit" } });
                }
                let wanted: HashSet<String> =
                    p["address"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_lowercase()).collect();
                let logs: Vec<Value> = chain_logs()
                    .into_iter()
                    .enumerate()
                    .filter(|(_, (n, a, ..))| (from..=to).contains(n) && wanted.contains(&format!("0x{}", hex(a))))
                    .map(|(i, (n, a, t, m, u))| log_json(n, i, a, t, m, u))
                    .collect();
                json!(logs)
            }
            "eth_getBlockByNumber" => {
                let n = q(&req["params"][0]);
                if req["params"][1] == json!(true) {
                    f.lock().push(n);
                }
                if n > HEAD || n < o.load(Ordering::SeqCst) {
                    Value::Null
                } else {
                    block_json(n)
                }
            }
            m => panic!("unexpected {m}"),
        };
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    };
    let handler = move |Json(req): Json<Value>| {
        let one = one.clone();
        async move {
            Json(match req.as_array() {
                Some(batch) => Value::Array(batch.iter().map(&one).collect()),
                None => one(&req),
            })
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, Router::new().route("/", post(handler))).await.unwrap() });
    Archive { url: format!("http://{addr}"), full, fail, oldest }
}

/// A venue whose swaps carry their market code in topic 1 and their USD in
/// the data, whose oracle pushes are gas-only, and which counts what it has
/// seen in its durable state.
struct Fake;

#[async_trait]
impl Venue for Fake {
    fn id(&self) -> &str {
        "fake"
    }
    fn meta(&self) -> Vec<VenueMeta> {
        vec![VenueMeta {
            id: "fake".into(),
            name: "Fake".into(),
            color: ThemeColor { light: "#000".into(), dark: "#fff".into() },
            kind: VenueKind::Amm,
            role: VenueRole::Venue,
            taker: None,
            taker_bps: None,
            since_utc: None,
            quote_note: None,
        }]
    }
    async fn discover(&self, _: &ChainCx<'_>) -> Result<(), VenueError> {
        Ok(())
    }
    fn watch(&self) -> Result<WatchSet, VenueError> {
        let mut w = WatchSet::default();
        w.logs.insert(TRADE, TopicFilter::Topics(HashSet::from([SWAP])));
        w.logs.insert(ORACLE, TopicFilter::Topics(HashSet::from([PUSH])));
        Ok(w)
    }
    fn entry_points(&self) -> Vec<EntryPoint> {
        vec![EntryPoint { address: TRADE, router: None }]
    }
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(Some(GasSources { logs: vec![(ORACLE, PUSH)], ..GasSources::default() }))
    }
    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let mut out = Vec::new();
        for l in block.logs.iter().filter(|l| l.address == TRADE) {
            let seen: u64 = cx.state.get("fake", "seen").map_or(0, |s| s.parse().unwrap());
            cx.state.set("fake", "seen", &(seen + 1).to_string());
            let market = if l.topics[1][31] == 2 { "BTC/USDC" } else { "MON/USDC" };
            // Asks for a crypto price, as a crypto-quoted market would.
            let _ = cx.pricer.usd_per_token("WMON");
            let usd = u64::from_be_bytes(l.data[24..32].try_into().unwrap()) as f64;
            out.push(Fill {
                id: format!("fake-0x{}-{}", hex(&l.tx_hash), l.log_index),
                venue_id: "fake".into(),
                market: market.into(),
                side: Side::Buy,
                category: FillCategory::Unknown,
                usd,
                base_amount: usd,
                exec_px: 1.0,
                px_approx: false,
                tx_hash: format!("0x{}", hex(&l.tx_hash)),
                to: String::new(),
                router: None,
                pool: market.into(),
                block_number: block.number,
                ts: 0.0,
                markouts_bps: vec![None; 5],
                time_source: None,
            });
        }
        Ok(out)
    }
}

struct NoArchive;

#[async_trait]
impl DayLoader for NoArchive {
    async fn load(&self, _: &str, _: &str) -> Result<Option<DayPrices>, ArchiveError> {
        Ok(None)
    }
}

/// An exchange archive not published yet: every load fails.
struct Unpublished;

#[async_trait]
impl DayLoader for Unpublished {
    async fn load(&self, _: &str, day: &str) -> Result<Option<DayPrices>, ArchiveError> {
        Err(ArchiveError::Io(format!("archive {day} is not published yet")))
    }
}

#[derive(Default)]
struct Recorder {
    notes: Mutex<Vec<(bool, String, String)>>,
    days: Mutex<Vec<(String, DayOutcome)>>,
}

impl Sink for Recorder {
    fn note(&self, warn: bool, code: &str, _venue: &str, msg: &str) {
        self.notes.lock().push((warn, code.into(), msg.into()));
    }
    fn written(&self, _venue: &str, day: &str, outcome: &DayOutcome) {
        self.days.lock().push((day.into(), outcome.clone()));
    }
}

fn id(n: u64, i: usize) -> String {
    format!("fake-{}-{i}", h32(0x7, n))
}

fn stored(id: String, usd: f64, n: u64) -> Fill {
    Fill {
        id: id.clone(),
        venue_id: "fake".into(),
        market: "MON/USDC".into(),
        side: Side::Buy,
        category: FillCategory::Direct,
        usd,
        base_amount: usd,
        exec_px: 1.0,
        px_approx: false,
        tx_hash: id,
        to: String::new(),
        router: None,
        pool: "MON/USDC".into(),
        block_number: n,
        ts: ms(n) + 0.5,
        markouts_bps: vec![None; 5],
        time_source: Some(TimeSource::Proposal),
    }
}

struct World {
    exec: Executor,
    writer: Writer,
    archive: Archive,
    sink: Arc<Recorder>,
}

async fn world() -> World {
    let mut store = Store::memory().unwrap();
    // Day 0 is older than the stored trades: only its volume row exists.
    store.set_volume(DAY0, "fake", VenueDaily { usd: 999.0, swaps: 9 }).unwrap();
    // Day 1 holds the trade at block 150 (with markouts, mispriced by the
    // older build) and one at block 155 that the venue no longer decodes;
    // day 2 a live trade after b0.
    store
        .insert_trades(
            &[stored(id(150, 2), 4.0, 150), stored("fake-0xdead-1".into(), 3.0, 155), stored(id(420, 6), 100.0, 420)],
            |f| utc_day(ms(f.block_number)),
        )
        .unwrap();
    store.set_markouts(&id(150, 2), &[Some(1.5), None, None, None, None]).unwrap();
    let writer = Writer::spawn(store);
    let archive = archive().await;
    let registry = Registry::get();
    let sink = Arc::new(Recorder::default());
    let exec = Executor {
        pool: Arc::new(ArchivePool::new(
            vec![Rpc::new("archive", &archive.url, Duration::from_secs(5))],
            PoolConfig { chunk: 50, rounds: 1, pause: Duration::from_millis(1), batch: 4, ..PoolConfig::default() },
        )),
        writer: writer.clone(),
        registry,
        closed: Arc::new(ClosedDayPrices::new(registry, Arc::new(NoArchive))),
        prices: Prices::new(registry, Fees::default()),
        local: Rpc::new("local", &archive.url, Duration::from_secs(5)),
        venues: vec![Arc::new(Fake)],
        committed: HashMap::new(),
        trades_from: "2026-11-21".into(),
        sink: sink.clone(),
        stats: Arc::new(Stats::default()),
        now_ms: || 1,
    };
    World { exec, writer, archive, sink }
}

fn job(kind: Kind) -> Planned {
    Planned {
        venue: "fake".into(),
        spec: format!("fake#r:{DAY0}"),
        kind,
        from: DAY0.into(),
        until: None,
        covers: vec!["fake#covered".into()],
        what: "revision r".into(),
    }
}

async fn volume(w: &Writer, day: &'static str) -> VenueDaily {
    w.run(move |s| s.volume_days("2030-01-01"))
        .await
        .unwrap()
        .into_iter()
        .find(|d| d.utc_day == day)
        .and_then(|d| d.by_venue.get("fake").copied())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_replay_writes_day_by_day_and_resumes_after_a_failure() {
    let w = world().await;
    const B0: u64 = 400;
    // Day 2 (blocks 289–432) can't be read: days 0 and 1 are written, then
    // the job stops with nothing of day 2.
    w.archive.fail.store(true, Ordering::SeqCst);
    let e = w.exec.run(&job(Kind::Replay), B0).await.unwrap_err();
    assert!(e.contains("rate limit"), "{e}");
    let j = w.writer.run(|s| s.history_job("fake", "fake#r:2026-11-20")).await.unwrap().unwrap();
    assert_eq!((j.b0, j.cursor), (B0, Some(288)), "through day 1's last block");
    assert_eq!(volume(&w.writer, "2026-11-20").await, VenueDaily { usd: 10.0, swaps: 1 }, "set from the replay");
    assert_eq!(
        volume(&w.writer, "2026-11-21").await,
        VenueDaily { usd: 45.0, swaps: 2 },
        "re-priced, the vanished trade gone, BTC found"
    );
    assert_eq!(volume(&w.writer, "2026-11-22").await, VenueDaily { usd: 100.0, swaps: 1 }, "day 2 untouched");

    // A later attempt (another boot: b0 passed again is ignored) resumes.
    w.archive.fail.store(false, Ordering::SeqCst);
    w.exec.run(&job(Kind::Replay), 999).await.unwrap();
    assert_eq!(
        volume(&w.writer, "2026-11-22").await,
        VenueDaily { usd: 107.0, swaps: 2 },
        "block 300 plus the live trade"
    );
    assert!(w.writer.run(|s| s.history_job("fake", "fake#r:2026-11-20")).await.unwrap().is_none());
    for spec in ["fake#r:2026-11-20", "fake#covered"] {
        assert!(w.writer.run(move |s| s.history_applied("fake", spec)).await.unwrap(), "{spec}");
    }

    // Trades: none for day 0; the survivor keeps its time and markouts.
    let s = |i: String| async { w.writer.run(move |s| s.trade(&i)).await.unwrap() };
    assert!(s(id(10, 0)).await.is_none());
    let kept = s(id(150, 2)).await.unwrap();
    assert_eq!((kept.usd, kept.ts, kept.markouts_bps[0]), (40.0, ms(150) + 0.5, Some(1.5)));
    assert_eq!(kept.time_source, Some(TimeSource::Proposal));
    let found = s(id(151, 3)).await.unwrap();
    assert_eq!((found.ts, found.time_source, found.category), (ms(151), Some(TimeSource::Block), FillCategory::Direct));
    assert_eq!(found.to, "0x9999…9999");
    assert!(s("fake-0xdead-1".into()).await.is_none());

    // Gas-only blocks were never read in full; no block past b0 was.
    let full = w.archive.full.lock().clone();
    assert!(!full.contains(&20) && !full.contains(&160), "{full:?}");
    assert!(full.iter().all(|n| *n <= B0));
    // The replay's state is its own.
    assert!(w.writer.run(|s| s.all_venue_state()).await.unwrap().is_empty());
    let notes = w.sink.notes.lock().clone();
    assert_eq!(notes.iter().filter(|(_, c, _)| c == "history.start").count(), 1, "{notes:?}");
    assert_eq!(notes.iter().filter(|(_, c, _)| c == "history.done").count(), 1);
    assert_eq!(
        w.sink.days.lock().iter().map(|(d, _)| d.as_str()).collect::<Vec<_>>(),
        ["2026-11-20", "2026-11-21", "2026-11-22"]
    );
}

#[tokio::test]
async fn a_listed_market_adds_only_its_trades() {
    let w = world().await;
    let mut j = job(Kind::Markets(vec!["BTC/USDC".into()]));
    j.spec = "fake#m:markets:2026-11-20:BTC/USDC".into();
    w.exec.run(&j, 400).await.unwrap();
    assert_eq!(volume(&w.writer, "2026-11-20").await, VenueDaily { usd: 999.0, swaps: 9 }, "no BTC trade on day 0");
    // Day 1 gains the BTC trade only; the mispriced MON trade stays as stored.
    assert_eq!(volume(&w.writer, "2026-11-21").await, VenueDaily { usd: 12.0, swaps: 3 });
    let i = id(151, 3);
    assert_eq!(w.writer.run(move |s| s.trade(&i)).await.unwrap().unwrap().market, "BTC/USDC");
}

#[tokio::test]
async fn a_markets_repair_stops_at_its_until_day() {
    let w = world().await;
    let mut j = job(Kind::Markets(vec!["MON/USDC".into()]));
    j.until = Some("2026-11-21".into());
    w.exec.run(&j, 400).await.unwrap();
    // Only day 0 (before the replay that owns day 1 on): its MON trade added.
    assert_eq!(volume(&w.writer, "2026-11-20").await, VenueDaily { usd: 1009.0, swaps: 10 });
    assert_eq!(volume(&w.writer, "2026-11-21").await, VenueDaily { usd: 7.0, swaps: 2 }, "untouched");
}

#[tokio::test]
async fn a_fills_revision_resums_stored_trades() {
    let w = world().await;
    let mut j = job(Kind::Fills { until: "2026-11-22".into() });
    j.from = "2026-11-21".into();
    j.spec = "fake#f:fills:2026-11-21..2026-11-22".into();
    w.writer.run(|s| s.set_volume("2026-11-21", "fake", VenueDaily { usd: 1.0, swaps: 1 })).await.unwrap();
    w.exec.run(&j, 400).await.unwrap();
    assert_eq!(volume(&w.writer, "2026-11-21").await, VenueDaily { usd: 7.0, swaps: 2 });
    assert!(w.writer.run(|s| s.history_applied("fake", "fake#f:fills:2026-11-21..2026-11-22")).await.unwrap());
    assert!(w.sink.notes.lock()[0].2.contains("2026-11-21 $1.00/1 → $7.00/2"));
}

#[tokio::test]
async fn a_node_without_early_blocks_is_never_asked_for_them() {
    let w = world().await;
    w.archive.oldest.store(250, Ordering::SeqCst);
    let mut j = job(Kind::Replay);
    j.from = "2026-11-22".into();
    w.exec.run(&j, 400).await.unwrap();
    assert_eq!(volume(&w.writer, "2026-11-22").await, VenueDaily { usd: 107.0, swaps: 2 });
    assert_eq!(volume(&w.writer, "2026-11-21").await, VenueDaily { usd: 7.0, swaps: 2 }, "untouched");
}

#[tokio::test]
async fn todays_blocks_never_wait_for_an_exchange_archive() {
    let mut w = world().await;
    w.exec.closed = Arc::new(ClosedDayPrices::new(Registry::get(), Arc::new(Unpublished)));
    // Now is day 2: its blocks are priced live; day 1 is closed and waits.
    w.exec.now_ms = || (day_start_s("2026-11-22").unwrap() * 1000 + 3_600_000) as i64;
    let mut j = job(Kind::Replay);
    j.from = "2026-11-22".into();
    w.exec.run(&j, 400).await.unwrap();
    assert_eq!(volume(&w.writer, "2026-11-22").await, VenueDaily { usd: 107.0, swaps: 2 });
    let mut j = job(Kind::Replay);
    j.spec = "fake#closed:2026-11-21".into();
    j.from = "2026-11-21".into();
    let e = w.exec.run(&j, 400).await.unwrap_err();
    assert!(e.contains("not published yet"), "{e}");
}

#[test]
fn days_start_at_midnight() {
    assert_eq!(day_start_s("2026-11-20"), Some(1_795_132_800));
    assert_eq!(day_start_s("1970-01-01"), Some(0));
    assert_eq!(utc_day(day_start_s("2024-02-29").unwrap() as f64 * 1000.0), "2024-02-29");
    assert_eq!(day_start_s("nope"), None);
}
