//! The reader's loop (Linux: it maps the node's ring).

use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use clap::{parser::ValueSource, CommandFactory, FromArgMatches, Parser};
use mpamm_chain::Rpc;
use mpamm_ring::{
    sdk::{self, Polled, Reader, Ring},
    Config, MissingReason, Output, Tracker,
};

use crate::{
    files::{self, Cursor, Files},
    repair::Repairer,
    stats::{pct, Authors, Health, Line, RingInfo, Summary, Totals, Window},
};

#[derive(Debug, Parser)]
#[command(
    name = "mpamm-reader",
    about = "Execution-event reader: block timeline, arrival delay, gaps and their repair"
)]
struct Cli {
    /// Settings file: its `[reader]` table fills in any flag not given here.
    #[arg(long, env = "MPAMM_CONFIG", default_value = "/var/lib/mpamm/mpamm.toml")]
    config: PathBuf,
    /// Event ring file written by monad-execution (`--exec-event-ring`).
    #[arg(long, default_value = sdk::DEFAULT_RING)]
    ring: PathBuf,
    /// Directory for the daily block and summary files, cursor.json,
    /// health.json and authors.json.
    #[arg(long, default_value = "/var/lib/mpamm/reader")]
    out_dir: PathBuf,
    /// The local node's JSON-RPC, used to repair heights the ring lost.
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    rpc_url: String,
    /// Environment variable holding a hosted archive RPC URL, the repair
    /// fallback for heights the node lacks. Its value is never printed.
    #[arg(long, default_value = "MPAMM_ARCHIVE_RPC_URL")]
    archive_url_env: String,
    /// Seconds between summary lines.
    #[arg(long, default_value_t = 60)]
    summary_secs: u64,
    /// Stop after this many seconds (0 = run until SIGTERM).
    #[arg(long, default_value_t = 0)]
    duration_secs: u64,
    /// Seconds without any event before the writer is reported as stalled.
    #[arg(long, default_value_t = 5)]
    stall_secs: u64,
    /// Pin the reader (and its repair thread) to this CPU.
    #[arg(long)]
    cpu: Option<usize>,
    /// Days of daily files to keep.
    #[arg(long, default_value_t = 30)]
    keep_days: u32,
    /// How long a finalized height waits for its block before it is read
    /// over RPC instead.
    #[arg(long, default_value_t = 2000)]
    finalize_wait_ms: u64,
    /// Ignore cursor.json and start at the newest block.
    #[arg(long)]
    fresh: bool,
    /// Test only: after this many seconds, stop reading for
    /// --debug-pause-secs, so the writer laps the reader and the gap and
    /// repair paths run on the live ring.
    #[arg(long, hide = true)]
    debug_pause_after_secs: Option<u64>,
    #[arg(long, hide = true, default_value_t = 0)]
    debug_pause_secs: u64,
}

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

fn pin_to(cpu: usize) -> Result<(), String> {
    // SAFETY: a zeroed cpu_set_t is a valid empty set; sched_setaffinity
    // reads it and pins the calling thread (threads spawned later inherit it).
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        libc::CPU_SET(cpu, &mut set);
        if libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

struct App {
    files: Files,
    tracker: Tracker,
    repair: Repairer,
    /// Final heights waiting for BLOCK_VERIFIED (at most 10 s): line, BLOCK_START time.
    awaiting: BTreeMap<u64, (Line, u64, Instant)>,
    /// Heights sent for repair, with why the ring couldn't serve them.
    unrepaired: BTreeMap<u64, MissingReason>,
    window: Window,
    totals: Totals,
    authors: Authors,
    newest: Option<u64>,
    saved_cursor: Option<u64>,
}

impl App {
    fn consume(&mut self) {
        for o in self.tracker.take() {
            match o {
                Output::Executed { number, .. } => self.newest = Some(self.newest.map_or(number, |n| n.max(number))),
                Output::Voted { .. } => {}
                Output::Final(b) => {
                    self.awaiting.insert(b.start.number, (Line::from_block(&b, "final"), b.start_ns, Instant::now()));
                }
                Output::Missing { number, reason } => {
                    self.window.missing += 1;
                    self.totals.missing += 1;
                    self.unrepaired.insert(number, reason);
                    let _ = self.repair.requests.send(number);
                }
                Output::Abandoned(b) => self.write(Line::from_block(&b, "abandoned")),
                Output::Verified { number, t_ns } => {
                    if let Some((mut line, start_ns, _)) = self.awaiting.remove(&number) {
                        line.set_verified(start_ns, t_ns);
                        self.write(line);
                    }
                }
            }
        }
    }

    /// Counts an event and any sequence numbers skipped before it.
    fn saw(&mut self, seqno: u64, last_seqno: &mut u64) {
        if *last_seqno != 0 && seqno > *last_seqno + 1 {
            let skipped = seqno - *last_seqno - 1;
            self.window.skipped_seqnos += skipped;
            self.totals.skipped_seqnos += skipped;
        }
        *last_seqno = seqno;
        self.window.events += 1;
        self.totals.events += 1;
    }

    fn write(&mut self, line: Line) {
        self.window.record(&line);
        match line.outcome {
            "final" => {
                self.totals.finals += 1;
                self.authors.add(&line);
            }
            "repaired" => self.totals.repaired += 1,
            _ => self.totals.abandoned += 1,
        }
        if let Ok(json) = serde_json::to_string(&line) {
            self.files.block_line(&json);
        }
    }

    /// Repairs that came back, and final heights whose verification never came.
    fn housekeeping(&mut self) {
        while let Ok(r) = self.repair.results.try_recv() {
            if let Some(reason) = self.unrepaired.remove(&r.number) {
                self.write(Line::repaired(&r.header, reason, r.source));
            }
        }
        let late: Vec<u64> = self
            .awaiting
            .iter()
            .filter(|(_, (_, _, at))| at.elapsed() > Duration::from_secs(10))
            .map(|(n, _)| *n)
            .collect();
        for n in late {
            if let Some((line, _, _)) = self.awaiting.remove(&n) {
                self.write(line);
            }
        }
    }

    /// The first height not yet written: resuming there loses nothing (a
    /// few lines after it may be written twice; readers keep the last).
    fn cursor(&self) -> Option<u64> {
        let mut c = self.tracker.next_final()?;
        if let Some(n) = self.awaiting.keys().next() {
            c = c.min(*n);
        }
        if let Some(n) = self.unrepaired.keys().next() {
            c = c.min(*n);
        }
        Some(c)
    }

    fn persist(&mut self) {
        self.files.flush();
        let Some(c) = self.cursor() else { return };
        if Some(c) == self.saved_cursor {
            return;
        }
        let json = serde_json::to_string(&Cursor { next: c }).unwrap_or_default();
        match files::write_atomic(&self.files.path("cursor.json"), &json) {
            Ok(()) => self.saved_cursor = Some(c),
            Err(e) => eprintln!("mpamm-reader: write cursor: {e}"),
        }
    }

    fn health(&self, status: &'static str, last_event: Option<Instant>, reader_seqno: u64, writer_seqno: Option<u64>) {
        let h = Health {
            at_unix: now_ns() / 1_000_000_000,
            status: if status == "ok" && !self.unrepaired.is_empty() { "repairing" } else { status },
            last_event_age_ms: last_event.map(|t| t.elapsed().as_millis() as u64),
            reader_seqno,
            writer_seqno,
            lag_events: writer_seqno.map(|w| w.saturating_sub(reader_seqno)),
            next_height: self.tracker.next_final(),
            held_blocks: self.tracker.held(),
            awaiting_verified: self.awaiting.len(),
            unrepaired: self.unrepaired.len(),
            oldest_unrepaired: self.unrepaired.keys().next().copied(),
            totals: &self.totals,
        };
        if let Ok(json) = serde_json::to_string(&h) {
            let _ = files::write_atomic(&self.files.path("health.json"), &json);
        }
    }

    /// Writes what is held (finals not yet verified go out without it), the
    /// cursor and a last health line.
    fn shutdown(&mut self) {
        self.housekeeping();
        for (_, (line, _, _)) in std::mem::take(&mut self.awaiting) {
            self.write(line);
        }
        self.persist();
    }
}

/// Places a reader for the tracker's next height: replay from just below it
/// when it is still in the ring, else from the oldest block the ring holds
/// (the heights in between are repaired), else at the newest block.
fn position<'r>(ring: &'r Ring, next: Option<u64>) -> Reader<'r> {
    let Some(n) = next else { return ring.reader_at_newest_block() };
    if let Some(r) = ring.reader_before(n) {
        return r;
    }
    if let Some((r, oldest)) = ring.newest_block().and_then(|newest| ring.reader_at_oldest(newest)) {
        eprintln!("mpamm-reader: height {n} has left the ring; replaying from {oldest}, repairing the rest over RPC");
        return r;
    }
    ring.reader_at_newest_block()
}

pub fn main() -> ExitCode {
    let matches = Cli::command().get_matches();
    let mut cli = match Cli::from_arg_matches(&matches) {
        Ok(c) => c,
        Err(e) => e.exit(),
    };
    let file = match crate::config::load(&cli.config) {
        Ok(f) => f.reader,
        Err(e) => {
            eprintln!("mpamm-reader: {e}");
            return ExitCode::FAILURE;
        }
    };
    let given = |id: &str| matches.value_source(id) == Some(ValueSource::CommandLine);
    macro_rules! from_file {
        ($($field:ident),*) => {$(
            if !given(stringify!($field)) {
                if let Some(v) = file.$field.clone() {
                    cli.$field = v.into();
                }
            }
        )*};
    }
    from_file!(ring, out_dir, rpc_url, archive_url_env, summary_secs, stall_secs, cpu, keep_days, finalize_wait_ms);
    if let Some(cpu) = cli.cpu {
        if let Err(e) = pin_to(cpu) {
            eprintln!("mpamm-reader: pin to CPU {cpu}: {e}");
            return ExitCode::FAILURE;
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        if let Err(e) = signal_hook::flag::register(sig, stop.clone()) {
            eprintln!("mpamm-reader: signal handler: {e}");
            return ExitCode::FAILURE;
        }
    }
    let files = match Files::open(&cli.out_dir, cli.keep_days, Utc::now()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("mpamm-reader: {e}");
            return ExitCode::FAILURE;
        }
    };
    let resume = if cli.fresh { None } else { files::read_cursor(&files.path("cursor.json")).map(|c| c.next) };
    let local = Rpc::new("local", cli.rpc_url.clone(), Duration::from_secs(5));
    let archive = std::env::var(&cli.archive_url_env)
        .ok()
        .filter(|u| !u.is_empty())
        .map(|u| Rpc::new("archive", u, Duration::from_secs(15)));
    eprintln!(
        "mpamm-reader: starting {}; archive fallback {}",
        resume.map_or("at the newest block".to_string(), |n| format!("from height {n}")),
        if archive.is_some() { "configured" } else { "not configured" }
    );
    let cfg = Config { finalize_wait_ns: cli.finalize_wait_ms * 1_000_000, require_headers: false };
    let mut app = App {
        files,
        tracker: Tracker::new(cfg, resume),
        repair: Repairer::spawn(local, archive),
        awaiting: BTreeMap::new(),
        unrepaired: BTreeMap::new(),
        window: Window::default(),
        totals: Totals::default(),
        authors: Authors::default(),
        newest: None,
        saved_cursor: resume,
    };

    let started = Instant::now();
    let summary_every = Duration::from_secs(cli.summary_secs.max(1));
    let stall_after = Duration::from_secs(cli.stall_secs.max(1));
    let mut window_started = Instant::now();
    let mut last_event: Option<Instant> = None;
    let mut reader_seqno = 0u64;
    let mut paused = false;
    let mut opened_once = false;
    let mut no_ring_logged: Option<Instant> = None;

    'outer: while !stop.load(Ordering::Relaxed) {
        let ring = match Ring::open(&cli.ring) {
            Ok(r) => r,
            Err(e) => {
                if no_ring_logged.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
                    eprintln!("mpamm-reader: cannot open the ring: {e}; retrying every second");
                    no_ring_logged = Some(Instant::now());
                }
                app.housekeeping();
                app.persist();
                app.health("no_ring", last_event, reader_seqno, None);
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        if opened_once {
            app.totals.reopens += 1;
        }
        opened_once = true;
        no_ring_logged = None;
        let mut reader = position(&ring, app.tracker.next_final());
        let mut last_seqno = 0u64;
        let mut stalled = false;
        let mut tick_at = Instant::now();
        let mut second_at = Instant::now();

        loop {
            match sdk::poll(&mut reader) {
                Polled::Event { seqno, t_ns, event } => {
                    app.saw(seqno, &mut last_seqno);
                    reader_seqno = seqno;
                    last_event = Some(Instant::now());
                    stalled = false;
                    app.tracker.handle(event, t_ns);
                    app.consume();
                }
                Polled::Skipped { seqno } => {
                    app.saw(seqno, &mut last_seqno);
                    reader_seqno = seqno;
                    last_event = Some(Instant::now());
                    stalled = false;
                }
                Polled::Gap => {
                    app.tracker.gap();
                    app.window.gaps += 1;
                    app.totals.gaps += 1;
                    eprintln!("mpamm-reader: sequence gap after seqno {last_seqno}; continuing at the newest event");
                    last_seqno = 0;
                }
                Polled::Expired { seqno } => {
                    app.tracker.gap();
                    app.window.expired += 1;
                    app.totals.expired += 1;
                    eprintln!(
                        "mpamm-reader: payload of seqno {seqno} expired while read; continuing at the newest event"
                    );
                    last_seqno = 0;
                }
                Polled::Idle => {
                    if !stalled && last_event.is_none_or(|t| t.elapsed() > stall_after) {
                        stalled = true;
                        app.totals.stalls += 1;
                        eprintln!("mpamm-reader: no events for {}s; execution may be stalled", cli.stall_secs);
                    }
                    std::thread::sleep(Duration::from_micros(20));
                }
            }

            if tick_at.elapsed() >= Duration::from_millis(10) {
                tick_at = Instant::now();
                app.tracker.tick(now_ns());
                app.consume();
                app.housekeeping();
            }

            if second_at.elapsed() >= Duration::from_secs(1) {
                second_at = Instant::now();
                app.files.roll(Utc::now());
                app.persist();
                let header = ring.header();
                app.health(
                    if stalled { "stalled" } else { "ok" },
                    last_event,
                    reader_seqno,
                    header.map(|h| h.last_seqno),
                );
                // A node restart recreates the ring (or restarts its sequence).
                let restarted = header.is_some_and(|h| last_seqno != 0 && h.last_seqno < last_seqno);
                if stalled && (ring.replaced() || restarted) {
                    eprintln!("mpamm-reader: the ring was recreated; reopening");
                    app.tracker.gap();
                    continue 'outer;
                }
                if stop.load(Ordering::Relaxed) {
                    break 'outer;
                }
                if let (Some(after), false) = (cli.debug_pause_after_secs, paused) {
                    if started.elapsed() >= Duration::from_secs(after) {
                        paused = true;
                        eprintln!("mpamm-reader: debug pause for {}s", cli.debug_pause_secs);
                        std::thread::sleep(Duration::from_secs(cli.debug_pause_secs));
                    }
                }
            }

            if window_started.elapsed() >= summary_every {
                let secs = window_started.elapsed().as_secs_f64();
                let header = ring.header();
                let probe_started = Instant::now();
                let oldest = app.newest.and_then(|n| ring.oldest_block(n));
                let now = now_ns();
                let info = RingInfo {
                    descriptor_capacity: header.map(|h| h.descriptor_capacity),
                    payload_buf_bytes: header.map(|h| h.payload_buf_bytes),
                    newest_block: app.newest,
                    oldest_block: oldest.map(|o| o.0),
                    depth_blocks: oldest.zip(app.newest).map(|(o, n)| n.saturating_sub(o.0)),
                    depth_secs: oldest.map(|o| ((now as f64 - o.1 as f64) / 1e9 * 10.0).round() / 10.0),
                    probe_ms: (probe_started.elapsed().as_secs_f64() * 1e5).round() / 100.0,
                };
                let mut w = std::mem::take(&mut app.window);
                app.totals.record_errors = app.tracker.stats().record_errors;
                let summary = Summary {
                    at_unix: now / 1_000_000_000,
                    window_secs: (secs * 100.0).round() / 100.0,
                    events_per_sec: (w.events as f64 / secs).round(),
                    finals: w.finals,
                    repaired: w.repaired,
                    missing: w.missing,
                    unrepaired: app.unrepaired.len(),
                    abandoned: w.abandoned,
                    gaps: w.gaps,
                    expired_payloads: w.expired,
                    skipped_seqnos: w.skipped_seqnos,
                    reader_lag_events: header.map(|h| h.last_seqno.saturating_sub(reader_seqno)),
                    held_blocks: app.tracker.held(),
                    arrival_ms: pct(&mut w.arrival),
                    exec_ms: pct(&mut w.exec),
                    voted_ms: pct(&mut w.voted),
                    finalized_ms: pct(&mut w.finalized),
                    verified_ms: pct(&mut w.verified),
                    ring: info,
                    totals: &app.totals,
                };
                if let Ok(json) = serde_json::to_string(&summary) {
                    println!("{json}");
                    app.files.summary_line(&json);
                }
                let _ = files::write_atomic(&app.files.path("authors.json"), &app.authors.to_json());
                window_started = Instant::now();
                if cli.duration_secs > 0 && started.elapsed().as_secs() >= cli.duration_secs {
                    break 'outer;
                }
            }
        }
    }

    app.shutdown();
    app.health("stopped", last_event, reader_seqno, None);
    eprintln!("mpamm-reader: stopped; next height {}", app.cursor().map_or("unknown".to_string(), |n| n.to_string()));
    ExitCode::SUCCESS
}
