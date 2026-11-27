//! Phase 1 of the rebuild (docs/rebuild-spec.md → Rollout): follow the node's
//! execution-event ring and record, per block, what the phase gate needs —
//! how long a proposal took to reach this node, how long the block took to
//! execute, when it was voted / finalized / verified, and whether the reader
//! ever lost events. It decodes no venue data: it is the event reader's
//! skeleton, proven on the live ring before anything depends on it.
//!
//! Output, under `--out-dir`:
//! - `blocks.jsonl`: one line per settled block (verified, or abandoned when
//!   another proposal finalized at its height);
//! - `summary.jsonl` (and stdout): one line per interval with percentiles,
//!   gaps, reader lag and how far back the ring still reaches;
//! - `authors.json`: arrival delay per proposer key, rewritten each interval,
//!   to join with validator locations.
//!
//! Times: `proposal_epoch_nanos` is the proposer's clock, every other time is
//! this host's `record_epoch_nanos`; arrival therefore includes the two
//! clocks' offset (both NTP-disciplined), the rest are same-clock intervals.

use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clap::Parser;
use monad_event_ring::{DecodedEventRing, EventNextResult, EventPayloadResult, EventRingPath};
use monad_exec_events::{ExecEventReaderExt, ExecEventRef, ExecEventRing, ExecEventType};
use serde::Serialize;

const DEFAULT_RING: &str =
    "/var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings/monad-exec-events";

#[derive(Debug, Parser)]
#[command(name = "mpamm-reader", about = "Phase-1 execution-event reader")]
struct Cli {
    /// Event ring file written by monad-execution (`--exec-event-ring`).
    #[arg(long, default_value = DEFAULT_RING)]
    ring: PathBuf,
    /// Directory for blocks.jsonl, summary.jsonl and authors.json.
    #[arg(long, default_value = "/var/lib/mpamm/reader")]
    out_dir: PathBuf,
    /// Seconds between summary lines.
    #[arg(long, default_value_t = 60)]
    summary_secs: u64,
    /// Stop after this many seconds (0 = run until killed).
    #[arg(long, default_value_t = 0)]
    duration_secs: u64,
    /// Seconds without any event before the writer is reported as stalled.
    #[arg(long, default_value_t = 5)]
    stall_secs: u64,
}

/// The few payload fields this phase needs, copied out of shared memory by
/// the zero-copy filter (a payload can be overwritten while it is read; the
/// SDK discards the copy if that happened).
#[derive(Debug, Clone, Copy)]
enum Ev {
    Start {
        number: u64,
        id: [u8; 32],
        round: u64,
        proposal_ns: u128,
        author_parity: u8,
        author_x: [u8; 32],
        txns: u64,
        timestamp: u64,
    },
    End,
    Reject,
    Qc { id: [u8; 32] },
    Finalized { number: u64, id: [u8; 32] },
    Verified { number: u64 },
    TxnOut { logs: u32 },
    RecordError,
}

fn pick(event: ExecEventRef<'_>) -> Option<Ev> {
    match event {
        ExecEventRef::BlockStart(s) => Some(Ev::Start {
            number: s.block_tag.block_number,
            id: s.block_tag.id.bytes,
            round: s.round,
            // bindgen may render __uint128_t as u128 or as [u64; 2]; both are
            // 16 little-endian bytes on x86_64.
            proposal_ns: unsafe { std::mem::transmute_copy::<_, u128>(&s.proposal_epoch_nanos) },
            author_parity: s.author.y_parity,
            author_x: s.author.x.bytes,
            txns: s.eth_block_input.txn_count,
            timestamp: s.eth_block_input.timestamp,
        }),
        ExecEventRef::BlockEnd(_) => Some(Ev::End),
        ExecEventRef::BlockReject(_) => Some(Ev::Reject),
        ExecEventRef::BlockQC(q) => Some(Ev::Qc { id: q.block_tag.id.bytes }),
        ExecEventRef::BlockFinalized(f) => Some(Ev::Finalized { number: f.block_number, id: f.id.bytes }),
        ExecEventRef::BlockVerified(v) => Some(Ev::Verified { number: v.block_number }),
        ExecEventRef::TxnEvmOutput { output, .. } => Some(Ev::TxnOut { logs: output.receipt.log_count }),
        ExecEventRef::RecordError(_) => Some(Ev::RecordError),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct Block {
    number: u64,
    id: [u8; 32],
    round: u64,
    author: [u8; 33],
    txns: u64,
    timestamp: u64,
    proposal_ns: u128,
    start_ns: u64,
    end_ns: Option<u64>,
    logs: u64,
    rejected: bool,
    qc_ns: Option<u64>,
    finalized_ns: Option<u64>,
}

#[derive(Serialize)]
struct Settled {
    number: u64,
    id: String,
    outcome: &'static str,
    round: u64,
    author: String,
    txns: u64,
    logs: u64,
    timestamp: u64,
    /// BLOCK_START record time minus the proposer's proposal time.
    arrival_ms: Option<f64>,
    /// BLOCK_START → BLOCK_END.
    exec_ms: Option<f64>,
    /// After BLOCK_START.
    voted_ms: Option<f64>,
    finalized_ms: Option<f64>,
    verified_ms: Option<f64>,
    rejected: bool,
}

#[derive(Default)]
struct Window {
    events: u64,
    arrival: Vec<f64>,
    exec: Vec<f64>,
    voted: Vec<f64>,
    finalized: Vec<f64>,
    verified: Vec<f64>,
    settled: u64,
    abandoned: u64,
    rejected: u64,
    gaps: u64,
    expired: u64,
    record_errors: u64,
    skipped_seqnos: u64,
}

#[derive(Default, Serialize)]
struct Totals {
    events: u64,
    settled: u64,
    abandoned: u64,
    rejected: u64,
    gaps: u64,
    expired: u64,
    record_errors: u64,
    skipped_seqnos: u64,
    stalls: u64,
}

#[derive(Serialize)]
struct Pct {
    n: usize,
    p10: Option<f64>,
    p50: Option<f64>,
    p90: Option<f64>,
    p99: Option<f64>,
    max: Option<f64>,
}

#[derive(Serialize)]
struct RingInfo {
    descriptor_capacity: Option<u64>,
    payload_buf_bytes: Option<u64>,
    newest_block: Option<u64>,
    oldest_block: Option<u64>,
    depth_blocks: Option<u64>,
    depth_secs: Option<f64>,
    probe_ms: f64,
}

#[derive(Serialize)]
struct Summary<'a> {
    at_unix: u64,
    window_secs: f64,
    events_per_sec: f64,
    blocks_settled: u64,
    abandoned: u64,
    rejected: u64,
    gaps: u64,
    expired_payloads: u64,
    record_errors: u64,
    skipped_seqnos: u64,
    reader_lag_events: Option<u64>,
    arrival_ms: Pct,
    exec_ms: Pct,
    voted_ms: Pct,
    finalized_ms: Pct,
    verified_ms: Pct,
    ring: RingInfo,
    totals: &'a Totals,
}

fn pct(values: &mut [f64]) -> Pct {
    values.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f64| -> Option<f64> {
        if values.is_empty() {
            return None;
        }
        let i = ((values.len() as f64 * q).ceil() as usize).clamp(1, values.len()) - 1;
        Some((values[i] * 100.0).round() / 100.0)
    };
    Pct { n: values.len(), p10: at(0.10), p50: at(0.50), p90: at(0.90), p99: at(0.99), max: values.last().copied() }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ns() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

fn ms(later: u64, earlier: u64) -> f64 {
    (later as f64 - earlier as f64) / 1e6
}

/// The ring header's fixed layout (category/core/event/event_ring.h): magic[6],
/// content type u16, schema hash[32], then descriptor capacity, payload buffer
/// size and context size (u64 each), then the writer's control block, 64-byte
/// aligned, whose first field is the last allocated sequence number.
struct RingHeader {
    descriptor_capacity: u64,
    payload_buf_bytes: u64,
    last_seqno: u64,
}

fn read_header(path: &EventRingPath) -> Option<RingHeader> {
    let mut buf = [0u8; 72];
    path.open().ok()?.read_exact(&mut buf).ok()?;
    if &buf[0..4] != b"RING" {
        return None;
    }
    let u64_at = |o: usize| u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
    Some(RingHeader { descriptor_capacity: u64_at(40), payload_buf_bytes: u64_at(48), last_seqno: u64_at(64) })
}

/// Oldest block whose BLOCK_START is still in the ring, by binary search over
/// block numbers (absent below the oldest retained block, present above it).
fn oldest_block(ring: &ExecEventRing, newest: u64) -> Option<(u64, u64)> {
    let probe = |n: u64| -> Option<u64> {
        let mut reader = ring.create_reader();
        reader
            .block_number_prev(n, Some(ExecEventType::BlockStart))
            .map(|d| d.info().record_epoch_nanos)
    };
    let mut hi = newest;
    let mut hi_ns = probe(hi)?;
    let mut lo = newest.saturating_sub(4_000_000);
    if let Some(ns) = probe(lo) {
        return Some((lo, ns));
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        match probe(mid) {
            Some(ns) => {
                hi = mid;
                hi_ns = ns;
            }
            None => lo = mid,
        }
    }
    Some((hi, hi_ns))
}

struct State {
    blocks: HashMap<[u8; 32], Block>,
    by_number: BTreeMap<u64, Vec<[u8; 32]>>,
    finalized: BTreeMap<u64, [u8; 32]>,
    current: Option<[u8; 32]>,
    newest: Option<u64>,
    window: Window,
    totals: Totals,
    authors: HashMap<[u8; 33], Vec<f32>>,
    out: BufWriter<File>,
}

impl State {
    fn settle(&mut self, id: [u8; 32], outcome: &'static str, verified_ns: Option<u64>) {
        let Some(b) = self.blocks.remove(&id) else { return };
        if let Some(ids) = self.by_number.get_mut(&b.number) {
            ids.retain(|x| x != &id);
            if ids.is_empty() {
                self.by_number.remove(&b.number);
            }
        }
        let arrival = (b.proposal_ns > 0).then(|| (b.start_ns as f64 - b.proposal_ns as f64) / 1e6);
        let exec = b.end_ns.map(|e| ms(e, b.start_ns));
        let voted = b.qc_ns.map(|t| ms(t, b.start_ns));
        let finalized = b.finalized_ns.map(|t| ms(t, b.start_ns));
        let verified = verified_ns.map(|t| ms(t, b.start_ns));
        if outcome == "verified" {
            self.window.settled += 1;
            self.totals.settled += 1;
            if let Some(a) = arrival {
                self.window.arrival.push(a);
                self.authors.entry(b.author).or_default().push(a as f32);
            }
            exec.map(|x| self.window.exec.push(x));
            voted.map(|x| self.window.voted.push(x));
            finalized.map(|x| self.window.finalized.push(x));
            verified.map(|x| self.window.verified.push(x));
        } else {
            self.window.abandoned += 1;
            self.totals.abandoned += 1;
        }
        let line = Settled {
            number: b.number,
            id: hex(&b.id),
            outcome,
            round: b.round,
            author: hex(&b.author),
            txns: b.txns,
            logs: b.logs,
            timestamp: b.timestamp,
            arrival_ms: arrival,
            exec_ms: exec,
            voted_ms: voted,
            finalized_ms: finalized,
            verified_ms: verified,
            rejected: b.rejected,
        };
        if let Ok(json) = serde_json::to_string(&line) {
            let _ = writeln!(self.out, "{json}");
        }
    }

    fn handle(&mut self, ev: Ev, t: u64) {
        match ev {
            Ev::Start { number, id, round, proposal_ns, author_parity, author_x, txns, timestamp } => {
                let mut author = [0u8; 33];
                author[0] = 2 + (author_parity & 1);
                author[1..].copy_from_slice(&author_x);
                self.blocks.insert(id, Block {
                    number,
                    id,
                    round,
                    author,
                    txns,
                    timestamp,
                    proposal_ns,
                    start_ns: t,
                    end_ns: None,
                    logs: 0,
                    rejected: false,
                    qc_ns: None,
                    finalized_ns: None,
                });
                self.by_number.entry(number).or_default().push(id);
                self.current = Some(id);
                self.newest = Some(self.newest.map_or(number, |n| n.max(number)));
            }
            Ev::TxnOut { logs } => {
                if let Some(b) = self.current.and_then(|id| self.blocks.get_mut(&id)) {
                    b.logs += u64::from(logs);
                }
            }
            Ev::End => {
                if let Some(b) = self.current.take().and_then(|id| self.blocks.get_mut(&id)) {
                    b.end_ns = Some(t);
                }
            }
            Ev::Reject => {
                if let Some(b) = self.current.and_then(|id| self.blocks.get_mut(&id)) {
                    b.rejected = true;
                    self.window.rejected += 1;
                    self.totals.rejected += 1;
                }
            }
            Ev::Qc { id } => {
                if let Some(b) = self.blocks.get_mut(&id) {
                    b.qc_ns.get_or_insert(t);
                }
            }
            Ev::Finalized { number, id } => {
                if let Some(b) = self.blocks.get_mut(&id) {
                    b.finalized_ns.get_or_insert(t);
                }
                self.finalized.insert(number, id);
                // Monad never announces a losing proposal: another id
                // finalizing at its height is the only signal.
                let losers: Vec<[u8; 32]> = self
                    .by_number
                    .get(&number)
                    .map(|ids| ids.iter().filter(|x| *x != &id).copied().collect())
                    .unwrap_or_default();
                for loser in losers {
                    self.settle(loser, "abandoned", None);
                }
            }
            Ev::Verified { number } => {
                if let Some(id) = self.finalized.remove(&number) {
                    self.settle(id, "verified", Some(t));
                }
            }
            Ev::RecordError => {
                self.window.record_errors += 1;
                self.totals.record_errors += 1;
            }
        }
    }

    /// Drops state for blocks far behind the head (partial blocks seen at
    /// start-up, or a finalization the reader never saw verified).
    fn prune(&mut self) {
        let Some(newest) = self.newest else { return };
        let cutoff = newest.saturating_sub(10_000);
        let old: Vec<u64> = self.by_number.range(..cutoff).map(|(n, _)| *n).collect();
        for n in old {
            for id in self.by_number.remove(&n).unwrap_or_default() {
                self.blocks.remove(&id);
            }
        }
        self.finalized = self.finalized.split_off(&cutoff);
    }
}

fn write_authors(path: &Path, authors: &HashMap<[u8; 33], Vec<f32>>) {
    #[derive(Serialize)]
    struct Author {
        author: String,
        n: usize,
        arrival_p50_ms: f64,
        arrival_p90_ms: f64,
    }
    let mut rows: Vec<Author> = authors
        .iter()
        .map(|(k, v)| {
            let mut v: Vec<f64> = v.iter().map(|x| f64::from(*x)).collect();
            let p = pct(&mut v);
            Author { author: hex(k), n: p.n, arrival_p50_ms: p.p50.unwrap_or(f64::NAN), arrival_p90_ms: p.p90.unwrap_or(f64::NAN) }
        })
        .collect();
    rows.sort_by(|a, b| b.n.cmp(&a.n));
    if let Ok(json) = serde_json::to_string_pretty(&rows) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(tmp, path);
        }
    }
}

fn main() -> Result<(), String> {
    let cli = Cli::parse();
    fs::create_dir_all(&cli.out_dir).map_err(|e| format!("create {}: {e}", cli.out_dir.display()))?;
    let append = |name: &str| -> Result<File, String> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(cli.out_dir.join(name))
            .map_err(|e| format!("open {name}: {e}"))
    };
    let mut summaries = append("summary.jsonl")?;
    let ring_path = EventRingPath::resolve(&cli.ring)?;
    let ring = ExecEventRing::new(&ring_path)?;
    let mut reader = ring.create_reader();
    // Start on a block boundary: a live reader begins at the newest event,
    // usually in the middle of a block.
    reader.consensus_prev(Some(ExecEventType::BlockStart));

    let mut st = State {
        blocks: HashMap::new(),
        by_number: BTreeMap::new(),
        finalized: BTreeMap::new(),
        current: None,
        newest: None,
        window: Window::default(),
        totals: Totals::default(),
        authors: HashMap::new(),
        out: BufWriter::new(append("blocks.jsonl")?),
    };
    let started = Instant::now();
    let mut window_started = Instant::now();
    let mut last_event = Instant::now();
    let mut stalled = false;
    let mut last_seqno: u64 = 0;
    let summary_every = Duration::from_secs(cli.summary_secs.max(1));

    loop {
        match reader.next_descriptor() {
            EventNextResult::Gap => {
                st.window.gaps += 1;
                st.totals.gaps += 1;
                st.current = None;
                eprintln!("mpamm-reader: sequence gap after seqno {last_seqno}; resetting to the newest event");
                reader.reset();
            }
            EventNextResult::NotReady => {
                if !stalled && last_event.elapsed() > Duration::from_secs(cli.stall_secs) {
                    stalled = true;
                    st.totals.stalls += 1;
                    eprintln!("mpamm-reader: no events for {}s; execution may be stalled", cli.stall_secs);
                }
                std::thread::sleep(Duration::from_micros(20));
            }
            EventNextResult::Ready(desc) => {
                let info = desc.info();
                if last_seqno != 0 && info.seqno > last_seqno + 1 {
                    let skipped = info.seqno - last_seqno - 1;
                    st.window.skipped_seqnos += skipped;
                    st.totals.skipped_seqnos += skipped;
                }
                last_seqno = info.seqno;
                last_event = Instant::now();
                stalled = false;
                st.window.events += 1;
                st.totals.events += 1;
                match desc.try_filter_map(pick) {
                    EventPayloadResult::Expired => {
                        st.window.expired += 1;
                        st.totals.expired += 1;
                        st.current = None;
                        reader.reset();
                    }
                    EventPayloadResult::Ready(Some(ev)) => st.handle(ev, info.record_epoch_nanos),
                    EventPayloadResult::Ready(None) => {}
                }
            }
        }

        if window_started.elapsed() >= summary_every {
            let secs = window_started.elapsed().as_secs_f64();
            let header = read_header(&ring_path);
            let probe_started = Instant::now();
            let oldest = st.newest.and_then(|n| oldest_block(&ring, n));
            let now = now_ns();
            let ring_info = RingInfo {
                descriptor_capacity: header.as_ref().map(|h| h.descriptor_capacity),
                payload_buf_bytes: header.as_ref().map(|h| h.payload_buf_bytes),
                newest_block: st.newest,
                oldest_block: oldest.map(|o| o.0),
                depth_blocks: oldest.zip(st.newest).map(|(o, n)| n.saturating_sub(o.0)),
                depth_secs: oldest.map(|o| (now as f64 - o.1 as f64) / 1e9),
                probe_ms: probe_started.elapsed().as_secs_f64() * 1e3,
            };
            let mut w = std::mem::take(&mut st.window);
            let summary = Summary {
                at_unix: (now / 1_000_000_000) as u64,
                window_secs: secs,
                events_per_sec: w.events as f64 / secs,
                blocks_settled: w.settled,
                abandoned: w.abandoned,
                rejected: w.rejected,
                gaps: w.gaps,
                expired_payloads: w.expired,
                record_errors: w.record_errors,
                skipped_seqnos: w.skipped_seqnos,
                reader_lag_events: header.map(|h| h.last_seqno.saturating_sub(last_seqno)),
                arrival_ms: pct(&mut w.arrival),
                exec_ms: pct(&mut w.exec),
                voted_ms: pct(&mut w.voted),
                finalized_ms: pct(&mut w.finalized),
                verified_ms: pct(&mut w.verified),
                ring: ring_info,
                totals: &st.totals,
            };
            if let Ok(json) = serde_json::to_string(&summary) {
                println!("{json}");
                let _ = writeln!(summaries, "{json}");
            }
            let _ = st.out.flush();
            write_authors(&cli.out_dir.join("authors.json"), &st.authors);
            st.prune();
            window_started = Instant::now();
            if cli.duration_secs > 0 && started.elapsed().as_secs() >= cli.duration_secs {
                return Ok(());
            }
        }
    }
}
