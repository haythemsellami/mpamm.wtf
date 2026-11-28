//! Gap repair: heights the ring could not deliver whole are read over RPC,
//! from the local node first and the hosted archive second. The reader thread
//! never waits on this: it sends heights and picks up results between events.
//!
//! A height is retried until it is repaired (backing off to 30 s); one that
//! never repairs stays in the health file as unrepaired, which is what the
//! phase-1 gate counts.

use std::{
    collections::BTreeMap,
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

use mpamm_chain::{BlockHeader, Rpc};

#[derive(Debug, Clone)]
pub struct Repaired {
    pub number: u64,
    pub header: BlockHeader,
    /// The client's label: "local" or "archive".
    pub source: String,
}

pub struct Repairer {
    pub requests: Sender<u64>,
    pub results: Receiver<Repaired>,
}

const BATCH: usize = 100;

impl Repairer {
    pub fn spawn(local: Rpc, archive: Option<Rpc>) -> Self {
        let (req_tx, req_rx) = mpsc::channel::<u64>();
        let (res_tx, res_rx) = mpsc::channel::<Repaired>();
        thread::Builder::new()
            .name("repair".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
                rt.block_on(run(local, archive, req_rx, res_tx));
            })
            .expect("spawn repair thread");
        Self { requests: req_tx, results: res_rx }
    }
}

/// Heights waiting for a retry, with the time of the next attempt and the
/// current backoff.
type Retry = BTreeMap<u64, (Instant, Duration)>;

async fn run(local: Rpc, archive: Option<Rpc>, requests: Receiver<u64>, results: Sender<Repaired>) {
    let mut queue: Retry = BTreeMap::new();
    loop {
        // Wait for work: a new height, or the earliest retry coming due.
        let wait = queue.values().map(|(at, _)| at.saturating_duration_since(Instant::now())).min();
        let first = match wait {
            Some(d) if d.is_zero() => None,
            Some(d) => match requests.recv_timeout(d) {
                Ok(n) => Some(n),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match requests.recv() {
                Ok(n) => Some(n),
                Err(_) => return,
            },
        };
        let now = Instant::now();
        for n in first.into_iter().chain(requests.try_iter()) {
            queue.entry(n).or_insert((now, Duration::from_millis(500)));
        }
        let due: Vec<u64> = queue.iter().filter(|(_, (at, _))| *at <= now).map(|(n, _)| *n).take(BATCH).collect();
        if due.is_empty() {
            continue;
        }
        let mut got = fetch(&local, &due).await;
        let still: Vec<u64> = due.iter().copied().filter(|n| !got.contains_key(n)).collect();
        if let (Some(archive), false) = (&archive, still.is_empty()) {
            got.extend(fetch(archive, &still).await);
        }
        for n in due {
            match got.remove(&n) {
                Some((header, source)) => {
                    queue.remove(&n);
                    if results.send(Repaired { number: n, header, source }).is_err() {
                        return;
                    }
                }
                None => {
                    let slot = queue.get_mut(&n).expect("queued");
                    slot.1 = (slot.1 * 2).min(Duration::from_secs(30));
                    slot.0 = Instant::now() + slot.1;
                }
            }
        }
    }
}

/// Headers for `numbers` from one client; heights it lacks or fails on are
/// left out (the caller retries or falls back).
async fn fetch(rpc: &Rpc, numbers: &[u64]) -> BTreeMap<u64, (BlockHeader, String)> {
    let mut out = BTreeMap::new();
    match rpc.block_headers(numbers).await {
        Ok(results) => {
            for (n, r) in numbers.iter().zip(results) {
                match r {
                    Ok(Some(h)) if h.number == *n => {
                        out.insert(*n, (h, rpc.label().to_string()));
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("mpamm-reader: repair {n} on {}: {e}", rpc.label()),
                }
            }
        }
        Err(e) => eprintln!("mpamm-reader: repair batch on {}: {e}", rpc.label()),
    }
    out
}

#[cfg(test)]
mod tests {
    use std::{
        net::SocketAddr,
        sync::{
            atomic::{AtomicU32, Ordering},
            Arc,
        },
    };

    use axum::{extract::State, routing::post, Json, Router};
    use serde_json::{json, Value};

    use super::*;

    /// A node that knows blocks up to `max` and fails the first `fail_first`
    /// requests outright.
    #[derive(Clone)]
    struct Node {
        max: u64,
        fail_first: Arc<AtomicU32>,
    }

    async fn handle(State(node): State<Node>, Json(req): Json<Value>) -> Json<Value> {
        if node.fail_first.load(Ordering::SeqCst) > 0 {
            node.fail_first.fetch_sub(1, Ordering::SeqCst);
            return Json(json!({ "jsonrpc": "2.0", "id": 0, "error": { "code": -32000, "message": "busy" } }));
        }
        let calls = req.as_array().cloned().unwrap_or_default();
        Json(Value::Array(
            calls
                .iter()
                .map(|c| {
                    let n = mpamm_chain::parse_quantity(&c["params"][0]).unwrap();
                    let result = (n <= node.max).then(|| {
                        json!({
                            "number": format!("{n:#x}"), "hash": format!("0x{n:064x}"), "parentHash": format!("0x{:064x}", n - 1),
                            "timestamp": "0x1", "transactions": [], "gasUsed": "0x0",
                        })
                    });
                    json!({ "jsonrpc": "2.0", "id": c["id"], "result": result })
                })
                .collect(),
        ))
    }

    fn serve(node: Node) -> SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            tokio::runtime::Runtime::new().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                axum::serve(listener, Router::new().route("/", post(handle)).with_state(node)).await.unwrap();
            })
        });
        addr
    }

    fn rpc(label: &str, addr: SocketAddr) -> Rpc {
        Rpc::new(label, format!("http://{addr}/"), Duration::from_secs(2))
    }

    fn collect(r: &Repairer, count: usize) -> Vec<(u64, String)> {
        let mut got: Vec<(u64, String)> = (0..count)
            .map(|_| {
                let x = r.results.recv_timeout(Duration::from_secs(10)).expect("repair result");
                (x.number, x.source)
            })
            .collect();
        got.sort();
        got
    }

    #[test]
    fn falls_back_to_the_archive_for_heights_the_node_lacks() {
        let local = serve(Node { max: 10, fail_first: Arc::new(AtomicU32::new(0)) });
        let archive = serve(Node { max: 1000, fail_first: Arc::new(AtomicU32::new(0)) });
        let r = Repairer::spawn(rpc("local", local), Some(rpc("archive", archive)));
        for n in [5, 50, 9] {
            r.requests.send(n).unwrap();
        }
        assert_eq!(collect(&r, 3), [(5, "local".into()), (9, "local".into()), (50, "archive".into())]);
    }

    #[test]
    fn retries_until_the_node_answers() {
        let local = serve(Node { max: 100, fail_first: Arc::new(AtomicU32::new(2)) });
        let r = Repairer::spawn(rpc("local", local), None);
        let started = Instant::now();
        r.requests.send(7).unwrap();
        assert_eq!(collect(&r, 1), [(7, "local".into())]);
        // Two failures back off 1 s then 2 s.
        assert!(started.elapsed() >= Duration::from_millis(900), "{:?}", started.elapsed());
    }

    #[test]
    fn batches_many_heights() {
        let local = serve(Node { max: 10_000, fail_first: Arc::new(AtomicU32::new(0)) });
        let r = Repairer::spawn(rpc("local", local), None);
        for n in 1..=350 {
            r.requests.send(n).unwrap();
        }
        let got = collect(&r, 350);
        assert_eq!(got.first().unwrap().0, 1);
        assert_eq!(got.last().unwrap().0, 350);
    }
}
