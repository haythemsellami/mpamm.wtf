//! The ring adapter (`sdk.rs`) and the tracker against a real recorded ring:
//! the SDK's own test snapshot (31 Ethereum mainnet blocks re-executed by
//! Monad, 8,582 logs), checked against the SDK's expected block output. This
//! is what proves the block-level log index, transaction headers and log
//! payloads come out of the ring exactly as RPC would report them.
#![cfg(target_os = "linux")]

use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use monad_event_ring::{DecodedEventRing, EventRingPath, SnapshotEventRing};
use monad_exec_events::ExecEventDecoder;
use mpamm_ring::{
    hex,
    sdk::{self, Polled},
    Config, Output, Tracker, WatchSet,
};
use serde_json::Value;

/// The SDK's test data, from the cargo git checkout of the pinned Monad repo.
fn sdk_test_data(name: &str) -> PathBuf {
    let home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").expect("HOME")).join(".cargo"));
    let checkouts = home.join("git").join("checkouts");
    for repo in std::fs::read_dir(&checkouts).expect("cargo git checkouts").flatten() {
        if !repo.file_name().to_string_lossy().starts_with("monad-") {
            continue;
        }
        for rev in std::fs::read_dir(repo.path()).into_iter().flatten().flatten() {
            let dir = rev.path().join("rust/crates/monad-exec-events/test/data").join(name);
            if dir.join("snapshot.zst").exists() {
                return dir;
            }
        }
    }
    panic!("SDK test data {name} not found under {}", checkouts.display());
}

fn expected(dir: &Path) -> Vec<Value> {
    let mut json = String::new();
    zstd::Decoder::new(std::fs::File::open(dir.join("expected.json.zst")).unwrap())
        .unwrap()
        .read_to_string(&mut json)
        .unwrap();
    serde_json::from_str(&json).unwrap()
}

fn h(v: &Value) -> String {
    v.as_str().unwrap().trim_start_matches("0x").to_lowercase()
}

#[test]
fn snapshot_replays_into_final_blocks_matching_the_sdk() {
    let dir = sdk_test_data("exec-events-emn-30b-15m");
    let path = EventRingPath::resolve(dir.join("snapshot.zst")).unwrap();
    let snapshot = SnapshotEventRing::<ExecEventDecoder>::new_from_zstd_path(&path, None).unwrap();

    sdk::set_watch(Arc::new(WatchSet { all_logs: true, txn_headers: true, ..WatchSet::default() }));
    let mut reader = snapshot.create_reader();
    let mut tracker = Tracker::new(Config { require_headers: true, ..Config::default() }, None);
    let mut finals = Vec::new();
    let mut missing = Vec::new();
    loop {
        match sdk::poll(&mut reader) {
            Polled::Event { t_ns, event, .. } => tracker.handle(event, t_ns),
            Polled::Skipped { .. } => {}
            Polled::Idle => break,
            other => panic!("a snapshot cannot gap: {other:?}"),
        }
        for o in tracker.take() {
            match o {
                Output::Final(b) => finals.push(b),
                Output::Missing { number, reason } => missing.push((number, reason)),
                _ => {}
            }
        }
    }
    assert!(missing.is_empty(), "missing heights: {missing:?}");

    let executed: Vec<&Value> =
        expected(&dir).iter().filter_map(|x| x.get("Executed")).cloned().collect::<Vec<_>>().leak().iter().collect();
    assert!(finals.len() >= 25, "only {} final blocks", finals.len());
    let mut logs_checked = 0;
    for b in &finals {
        let want = executed
            .iter()
            .find(|e| e["block_tag"]["block_number"].as_u64() == Some(b.start.number))
            .unwrap_or_else(|| panic!("block {} not in the expected output", b.start.number));
        assert_eq!(hex(&b.end.unwrap().hash), h(&want["eth_block_hash"]), "hash of {}", b.start.number);
        let txns = want["transactions"].as_array().unwrap();
        assert_eq!(b.txns.len(), txns.len(), "transactions in {}", b.start.number);

        // Headers: hash, sender, `to`.
        for (t, w) in b.txns.iter().zip(txns) {
            let hdr = t.header.as_ref().expect("header");
            assert_eq!(hex(&hdr.hash), h(&w["txn_envelope"]["hash"]));
            assert_eq!(hex(&hdr.sender), h(&w["sender"]));
            match w["txn_envelope"]["to"].as_str() {
                Some(to) => assert_eq!(hdr.to.map(|a| hex(&a)), Some(h(&Value::from(to)))),
                None => assert_eq!(hdr.to, None),
            }
        }

        // Logs, flattened in block order: the position is RPC's `logIndex`.
        let want_logs: Vec<&Value> =
            txns.iter().flat_map(|t| t["receipt"]["logs"].as_array().unwrap().iter()).collect();
        assert_eq!(b.log_count as usize, want_logs.len(), "log count of {}", b.start.number);
        assert_eq!(b.logs.len(), want_logs.len(), "copied logs of {}", b.start.number);
        for (i, (log, idx)) in b.logs.iter().zip(&b.log_index).enumerate() {
            assert_eq!(*idx as usize, i, "block-level index in {}", b.start.number);
            let w = want_logs[i];
            assert_eq!(hex(&log.address), h(&w["address"]));
            let topics: Vec<String> = log.topics.iter().map(|t| hex(t)).collect();
            let want_topics: Vec<String> = w["topics"].as_array().unwrap().iter().map(h).collect();
            assert_eq!(topics, want_topics);
            assert_eq!(hex(&log.data), h(&w["data"]));
            logs_checked += 1;
        }
    }
    assert!(logs_checked > 5_000, "only {logs_checked} logs checked");
}
