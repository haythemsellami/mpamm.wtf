use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{atomic::AtomicU32, Mutex as StdMutex},
};

use axum::{routing::post, Json, Router};
use mpamm_chain::Rpc;
use mpamm_core::{FinalBlock, Origin};
use mpamm_ring::{hex, BlockStart, Config, Event, Log, Output, TopicFilter, Tracker, TxnHeader, TxnOutput};
use mpamm_store::{Store, FINAL_CURSOR};
use mpamm_types::{FillCategory, Side, TimeSource, VenueMeta};
use serde_json::{json, Value};

use super::*;

const VENUE: [u8; 20] = [0xaa; 20];
const SWAP: [u8; 32] = [0x77; 32];
// 2026-11-27 07:00:00 UTC.
const T0: u64 = 1_795_762_800;

/// A venue that turns every watched log into a $1 trade, and can be told to
/// fail decoding a block a number of times, or to start watching another
/// address when it decodes a given block (a factory announcing a pool).
struct TestVenue {
    fail: StdMutex<HashMap<u64, u32>>,
    grow_at: StdMutex<Option<u64>>,
    grown: std::sync::atomic::AtomicBool,
    /// Gas sources not ready until a decode has run (WOOFi loads its
    /// persisted oracles in decode).
    gas_waits_for_decode: std::sync::atomic::AtomicBool,
    decoded: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl Venue for TestVenue {
    fn id(&self) -> &str {
        "test"
    }
    async fn discover(&self, _cx: &mpamm_core::ChainCx<'_>) -> Result<(), VenueError> {
        Ok(())
    }
    fn meta(&self) -> Vec<VenueMeta> {
        vec![]
    }
    fn watch(&self) -> Result<WatchSet, VenueError> {
        let mut w = WatchSet::default();
        w.logs.insert(VENUE, TopicFilter::Topics([SWAP].into()));
        if self.grown.load(Ordering::Relaxed) {
            w.logs.insert([0xcc; 20], TopicFilter::Any);
        }
        Ok(w)
    }
    fn gas_sources(&self) -> Result<Option<mpamm_core::GasSources>, VenueError> {
        if self.gas_waits_for_decode.load(Ordering::Relaxed) && !self.decoded.load(Ordering::Relaxed) {
            return Err(VenueError::NotReady("gas source loaded by decode".into()));
        }
        Ok(None)
    }
    fn decode(&self, cx: &DecodeCx<'_>, b: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        if let Some(n) = self.fail.lock().unwrap().get_mut(&b.number) {
            if *n > 0 {
                *n -= 1;
                return Err(VenueError::NotReady("injected".into()));
            }
        }
        cx.state.set("test", "last", &b.number.to_string());
        self.decoded.store(true, Ordering::Relaxed);
        if *self.grow_at.lock().unwrap() == Some(b.number) {
            self.grown.store(true, Ordering::Relaxed);
        }
        Ok(b.logs
            .iter()
            .map(|l| Fill {
                id: format!("test-0x{}-{}", hex(&l.tx_hash), l.log_index),
                venue_id: "test".into(),
                market: "MON/USDC".into(),
                side: Side::Buy,
                category: FillCategory::Direct,
                usd: 1.0,
                base_amount: 30.0,
                exec_px: 1.0 / 30.0,
                px_approx: false,
                tx_hash: format!("0x{}", hex(&l.tx_hash)),
                to: "x".into(),
                router: None,
                pool: "p".into(),
                block_number: b.number,
                ts: b.time_ms(),
                markouts_bps: vec![None; 5],
                time_source: Some(if b.proposal_ns.is_some() { TimeSource::Proposal } else { TimeSource::Block }),
            })
            .collect())
    }
}

fn hash_of(n: u64) -> [u8; 32] {
    let mut h = [0u8; 32];
    h[..8].copy_from_slice(&n.to_be_bytes());
    h[31] = 0xee;
    h
}

fn tx_hash(n: u64, i: u32) -> [u8; 32] {
    let mut h = hash_of(n);
    h[30] = i as u8 + 1;
    h
}

/// A complete ring block `n` with `swaps` watched logs, one per transaction.
fn ring_block(n: u64, swaps: u32) -> Box<Block> {
    let mut t = Tracker::new(Config { require_headers: true, ..Config::default() }, Some(n));
    t.handle(
        Event::BlockStart(Box::new(BlockStart {
            id: [n as u8; 32],
            number: n,
            round: n,
            epoch: 1,
            proposal_ns: u128::from(T0) * 1_000_000_000 + 123_000_000,
            author: [2; 33],
            parent_hash: hash_of(n - 1),
            timestamp: T0,
            base_fee: 100,
            gas_limit: 1,
            txn_count: swaps,
        })),
        0,
    );
    for i in 0..swaps {
        t.handle(
            Event::TxnHeader(Box::new(TxnHeader {
                index: i,
                hash: tx_hash(n, i),
                sender: [1; 20],
                to: Some(VENUE),
                kind: 2,
                gas_limit: 1,
                max_fee_per_gas: 1,
                max_priority_fee_per_gas: 0,
                input: vec![],
            })),
            0,
        );
        t.handle(Event::TxnOutput(TxnOutput { index: i, status: true, log_count: 1, gas_used: 1 }), 0);
        t.handle(
            Event::Log(Box::new(Log {
                txn_index: i,
                index_in_txn: 0,
                address: VENUE,
                topics: vec![SWAP],
                data: vec![],
            })),
            0,
        );
    }
    t.handle(Event::BlockEnd { hash: hash_of(n), gas_used: 1 }, 1);
    t.handle(Event::Finalized { id: [n as u8; 32], number: n }, 2);
    t.take().into_iter().find_map(|o| if let Output::Final(b) = o { Some(b) } else { None }).expect("final")
}

/// A node that serves the same blocks over RPC; it fails the first
/// `fail_first` requests.
async fn node(fail_first: Arc<AtomicU32>) -> SocketAddr {
    let h = |b: [u8; 32]| format!("0x{}", hex(&b));
    let handler = move |Json(req): Json<Value>| {
        let fail = fail_first.clone();
        async move {
            if fail.load(Ordering::SeqCst) > 0 {
                fail.fetch_sub(1, Ordering::SeqCst);
                return Json(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "busy" } }));
            }
            let result = match req["method"].as_str().unwrap() {
                "eth_getBlockByNumber" => {
                    let n = mpamm_chain::parse_quantity(&req["params"][0]).unwrap();
                    json!({
                        "number": format!("{n:#x}"), "hash": h(hash_of(n)), "parentHash": h(hash_of(n - 1)),
                        "timestamp": format!("{T0:#x}"), "baseFeePerGas": "0x64",
                        "transactions": [{ "transactionIndex": "0x0", "hash": h(tx_hash(n, 0)), "from": format!("0x{}", "01".repeat(20)),
                            "to": format!("0x{}", hex(&VENUE)), "type": "0x2", "gas": "0x1", "maxFeePerGas": "0x1",
                            "maxPriorityFeePerGas": "0x0", "input": "0x" }],
                    })
                }
                "eth_getLogs" => {
                    let bh = req["params"][0]["blockHash"].as_str().unwrap().to_string();
                    let n = u64::from_str_radix(&bh[2..18], 16).unwrap();
                    json!([
                        { "blockHash": bh, "logIndex": "0x0", "transactionIndex": "0x0", "transactionHash": h(tx_hash(n, 0)),
                          "address": format!("0x{}", hex(&VENUE)), "topics": [h(SWAP)], "data": "0x" },
                        { "blockHash": bh, "logIndex": "0x1", "transactionIndex": "0x0", "transactionHash": h(tx_hash(n, 0)),
                          "address": format!("0x{}", hex(&VENUE)), "topics": [format!("0x{}", "11".repeat(32))], "data": "0x" },
                    ])
                }
                m => panic!("unexpected {m}"),
            };
            Json(json!({ "jsonrpc": "2.0", "id": req["id"], "result": result }))
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, Router::new().route("/", post(handler))).await.unwrap() });
    addr
}

struct Harness {
    pipeline: Pipeline,
    venue: Arc<TestVenue>,
    rx: broadcast::Receiver<Committed>,
}

async fn harness(fail_first: u32) -> Harness {
    let addr = node(Arc::new(AtomicU32::new(fail_first))).await;
    let venue = Arc::new(TestVenue {
        fail: StdMutex::new(HashMap::new()),
        grow_at: StdMutex::new(None),
        grown: std::sync::atomic::AtomicBool::new(false),
        gas_waits_for_decode: std::sync::atomic::AtomicBool::new(false),
        decoded: std::sync::atomic::AtomicBool::new(false),
    });
    let venues: Vec<Arc<dyn Venue>> = vec![venue.clone()];
    let watch = watch_of(&venues).unwrap();
    let (tx, rx) = broadcast::channel(64);
    let pipeline = Pipeline {
        writer: Writer::spawn(Store::memory().unwrap()),
        venues,
        fetcher: Fetcher { local: Rpc::new("local", format!("http://{addr}/"), Duration::from_secs(2)), archive: None },
        registry: Registry::get(),
        prices: mpamm_pricing::Prices::new(Registry::get(), mpamm_pricing::Fees::default()),
        watch: Arc::new(ArcSwap::from_pointee(watch)),
        state: Mutex::new(VenueState::default()),
        refetch_through: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        rediscover: Arc::new(tokio::sync::Notify::new()),
        stats: Arc::new(Stats::default()),
        committed: tx,
        retry_min: Duration::from_millis(10),
        retry_max: Duration::from_millis(40),
    };
    Harness { pipeline, venue, rx }
}

#[tokio::test]
async fn commits_ring_and_repaired_blocks_in_order() {
    let mut h = harness(0).await;
    h.pipeline.process(Input::Final(ring_block(100, 2))).await;
    h.pipeline.process(Input::Missing { number: 101, reason: MissingReason::Timeout }).await;
    h.pipeline.process(Input::Final(ring_block(102, 0))).await;

    let (cursor, volume, t101) = h
        .pipeline
        .writer
        .run(|s| {
            Ok((
                s.cursor(FINAL_CURSOR)?.unwrap().block,
                s.volume_days("2026-11-27")?[0].by_venue["test"],
                s.trade(&format!("test-0x{}-0", hex(&tx_hash(101, 0))))?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(cursor, 102);
    assert_eq!((volume.usd, volume.swaps), (3.0, 3), "2 ring trades + 1 repaired; the unwatched topic is dropped");
    let t101 = t101.expect("the repaired block's trade");
    assert_eq!(t101.time_source, Some(TimeSource::Block), "RPC has no proposal time");
    assert_eq!(t101.ts, T0 as f64 * 1000.0);
    let v = h.pipeline.stats.view();
    assert_eq!((v.cursor, v.from_ring, v.from_rpc, v.trades, v.held), (102, 2, 1, 3, None));

    let got: Vec<(u64, usize)> = (0..3).map(|_| h.rx.try_recv().unwrap()).map(|c| (c.number, c.trades.len())).collect();
    assert_eq!(got, [(100, 2), (101, 1), (102, 0)]);
}

#[tokio::test]
async fn holds_on_a_failing_read_or_decode_then_commits() {
    let h = harness(3).await;
    h.venue.fail.lock().unwrap().insert(51, 2);
    h.pipeline.process(Input::Missing { number: 50, reason: MissingReason::Unresolved }).await;
    h.pipeline.process(Input::Final(ring_block(51, 1))).await;
    let v = h.pipeline.stats.view();
    assert_eq!(v.cursor, 51);
    assert_eq!(v.holds, 2, "one hold for the read, one for the decode");
    assert_eq!(v.held, None, "both cleared");
}

#[tokio::test]
async fn a_resume_replay_of_a_stored_block_is_skipped() {
    let mut h = harness(0).await;
    h.pipeline.process(Input::Final(ring_block(10, 1))).await;
    h.pipeline.process(Input::Final(ring_block(11, 1))).await;
    // The tracker resumes from the cursor; a replay of 10 is harmless.
    h.pipeline.process(Input::Final(ring_block(10, 1))).await;
    let v = h.pipeline.stats.view();
    assert_eq!((v.cursor, v.trades), (11, 2));
    assert_eq!(h.rx.try_recv().unwrap().number, 10);
    assert_eq!(h.rx.try_recv().unwrap().number, 11);
    assert!(h.rx.try_recv().is_err(), "nothing published for the skipped replay");
}

#[tokio::test]
async fn two_producers_never_hold_on_a_gap_nor_read_twice() {
    let mut h = harness(0).await;
    h.pipeline.process(Input::Final(ring_block(20, 1))).await;
    // Fallback mode jumps ahead: 21 and 22 are read over RPC first.
    h.pipeline.process(Input::Missing { number: 23, reason: MissingReason::Fallback }).await;
    // The ring catches up with heights already committed: dropped.
    h.pipeline.process(Input::Final(ring_block(22, 1))).await;
    h.pipeline.process(Input::Final(ring_block(24, 1))).await;
    let v = h.pipeline.stats.view();
    assert_eq!((v.cursor, v.from_ring, v.from_rpc, v.held), (24, 2, 3, None));
    let got: Vec<u64> = (0..5).map(|_| h.rx.try_recv().unwrap().number).collect();
    assert_eq!(got, [20, 21, 22, 23, 24]);
    assert!(h.rx.try_recv().is_err());
}

#[tokio::test]
async fn the_fetched_block_matches_the_ring_block() {
    let h = harness(0).await;
    let watch = h.pipeline.watch.load_full();
    let rpc = h.pipeline.fetcher.block(77, &watch).await.unwrap();
    let ring = FinalBlock::from_ring(&ring_block(77, 1)).unwrap();
    assert_eq!(rpc.origin, Origin::Rpc("local".into()));
    assert_eq!(rpc.logs, ring.logs);
    assert_eq!(rpc.txns, ring.txns);
    assert_eq!((rpc.hash, rpc.parent_hash, rpc.timestamp), (ring.hash, ring.parent_hash, ring.timestamp));
}

#[tokio::test]
async fn run_drains_the_channel_in_order() {
    let h = harness(0).await;
    let stats = h.pipeline.stats.clone();
    let (tx, rx) = mpsc::unbounded_channel();
    for n in 1..=20 {
        tx.send(Input::Final(ring_block(n, 1))).unwrap();
    }
    drop(tx);
    h.pipeline.run(rx).await;
    assert_eq!(stats.view().cursor, 20);
    assert_eq!(stats.view().trades, 20);
}

#[tokio::test]
async fn venue_state_commits_with_its_block() {
    let h = harness(0).await;
    h.venue.fail.lock().unwrap().insert(2, 1);
    h.pipeline.process(Input::Final(ring_block(1, 1))).await;
    h.pipeline.process(Input::Final(ring_block(2, 1))).await;
    let stored = h.pipeline.writer.run(|s| s.venue_state("test", "last")).await.unwrap();
    assert_eq!(stored.as_deref(), Some("2"));
    assert_eq!(h.pipeline.state.lock().unwrap().get("test", "last").as_deref(), Some("2"));
    assert!(h.pipeline.state.lock().unwrap().take_pending().is_empty(), "the failed attempt's write was discarded");
}

#[tokio::test]
async fn blocks_copied_with_an_older_watch_set_are_read_over_rpc() {
    let h = harness(0).await;
    h.pipeline.refetch_through.store(30, Ordering::Relaxed);
    h.pipeline.process(Input::Final(ring_block(30, 1))).await;
    h.pipeline.process(Input::Final(ring_block(31, 1))).await;
    let v = h.pipeline.stats.view();
    assert_eq!((v.from_rpc, v.from_ring), (1, 1));
}

#[tokio::test]
async fn a_held_block_is_read_again_once_discovery_grows_the_watch_set() {
    let h = harness(0).await;
    h.venue.fail.lock().unwrap().insert(40, 1);
    // Rediscovery lands while block 40 is held: the watch set is replaced.
    let watch = h.pipeline.watch.clone();
    let notify = h.pipeline.rediscover.clone();
    tokio::spawn(async move {
        notify.notified().await;
        let mut w = (*watch.load_full()).clone();
        w.logs.insert([0xbb; 20], TopicFilter::Any);
        watch.store(Arc::new(w));
    });
    h.pipeline.process(Input::Final(ring_block(40, 1))).await;
    let v = h.pipeline.stats.view();
    assert_eq!(v.from_rpc, 1, "the held block was read again over RPC: {v:?}");
}

#[tokio::test]
async fn a_source_learned_while_decoding_grows_the_watch_set_at_once() {
    let h = harness(0).await;
    *h.venue.grow_at.lock().unwrap() = Some(60);
    h.pipeline.process(Input::Final(ring_block(60, 1))).await;
    h.pipeline.process(Input::Final(ring_block(61, 1))).await;
    let v = h.pipeline.stats.view();
    assert!(h.pipeline.watch.load().logs.contains_key(&[0xcc; 20]), "published to the reader");
    assert_eq!(v.from_rpc, 2, "the block itself and the next one are read again with the new set: {v:?}");
    assert!(h.pipeline.refetch_through.load(Ordering::Relaxed) >= 60 + 64);
}

#[tokio::test]
async fn a_gas_source_the_decode_loads_does_not_hold_the_first_block() {
    let h = harness(0).await;
    h.venue.gas_waits_for_decode.store(true, Ordering::Relaxed);
    h.pipeline.process(Input::Final(ring_block(70, 1))).await;
    let v = h.pipeline.stats.view();
    assert_eq!((v.cursor, v.holds, v.held.as_deref()), (70, 0, None), "gas rules are read after the decode");
}
