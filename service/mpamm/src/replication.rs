//! Replication: the database's write-ahead log copied off the host,
//! continuously, by Litestream (docs/rebuild-spec.md → Object storage), run
//! as the service's child so that one unit stays the one thing to operate.
//!
//! Fail-open on purpose: a missing bucket, a bad key or a crashed copier
//! never stops quotes or trades. The service restarts the copier with a
//! back-off and says so on `/api/health` (`replication`, and the alert
//! `replication_down`).
//!
//! Two copiers on one database can leave a replica that won't restore
//! (Litestream's docs, "Multiple applications replicating into location can
//! corrupt"). So the copier inherits an exclusive lock from the service and
//! holds it until it exits: a restarted service waits for the previous
//! copier's final sync instead of starting a second one. On Linux the copier
//! is also told to stop when the thread that started it dies (a tokio worker,
//! which lives as long as the service).
//!
//! Litestream adds two tables to the database (`_litestream_seq`,
//! `_litestream_lock`) and a directory beside it (`.mpamm.db-litestream`);
//! nothing in the service reads them.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use mpamm_ring::live::now_ms;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::{Child, Command},
    sync::watch,
};

pub const RESTART_MIN: Duration = Duration::from_secs(1);
pub const RESTART_MAX: Duration = Duration::from_secs(60);
/// A copier that ran this long resets the back-off.
pub const STABLE: Duration = Duration::from_secs(60);
/// How often the copier's metrics are read.
pub const POLL: Duration = Duration::from_secs(5);
/// Litestream's own shutdown-sync timeout: its final copy of the log.
pub const STOP_WAIT: Duration = Duration::from_secs(30);
/// Not copying for this long pages someone.
pub const DOWN_MS: u64 = 30_000;
/// A copier error this recent, with no recovery logged since, pages.
pub const ERROR_MS: u64 = 60_000;
/// The copier's position (or, with object storage, its uploads) not moving
/// for this long while the store commits pages.
pub const STUCK_MS: u64 = 120_000;
/// The store counts as committing when its last commit is this recent.
const COMMITTING_MS: u64 = 10_000;

/// What the copier runs with. The replica URL can name a bucket, so it is
/// never printed; the bucket's keys reach Litestream from the environment
/// it inherits (`LITESTREAM_ACCESS_KEY_ID` / `LITESTREAM_SECRET_ACCESS_KEY`).
#[derive(Clone)]
pub struct Config {
    pub bin: PathBuf,
    pub config: PathBuf,
    /// Litestream's metrics listener (`addr` in its config).
    pub addr: SocketAddr,
    pub db: PathBuf,
    pub replica_url: String,
    /// The first restart's delay (doubling to `RESTART_MAX`), and how often a
    /// held lock is retried.
    pub restart_min: Duration,
}

/// The copier's Prometheus counters that health reports.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    /// Litestream's local transaction id: one per sync that carried changes.
    pub txid: u64,
    pub db_bytes: u64,
    pub wal_bytes: u64,
    pub syncs: u64,
    pub sync_errors: u64,
    pub checkpoints: u64,
    /// Uploads to object storage (none for a file replica, which Litestream
    /// doesn't count).
    pub puts: Option<u64>,
    pub put_bytes: u64,
    pub replica_errors: u64,
}

/// Litestream's `/metrics` text, summed over its series (one database).
pub fn parse_metrics(text: &str) -> Metrics {
    let mut m = Metrics::default();
    for line in text.lines().filter(|l| !l.starts_with('#')) {
        let Some((series, value)) = line.rsplit_once(' ') else { continue };
        let Ok(v) = value.trim().parse::<f64>() else { continue };
        let v = if v.is_finite() && v > 0.0 { v.round() as u64 } else { 0 };
        let (name, labels) = series.split_once('{').unwrap_or((series, ""));
        let put = labels.contains("operation=\"PUT\"");
        match name {
            "litestream_txid" => m.txid = m.txid.max(v),
            "litestream_db_size" => m.db_bytes += v,
            "litestream_wal_size" => m.wal_bytes += v,
            "litestream_sync_count" => m.syncs += v,
            "litestream_sync_error_count" => m.sync_errors += v,
            "litestream_checkpoint_count" => m.checkpoints += v,
            "litestream_replica_operation_total" if put => *m.puts.get_or_insert(0) += v,
            "litestream_replica_operation_bytes" if put => m.put_bytes += v,
            "litestream_replica_operation_errors_total" => m.replica_errors += v,
            _ => {}
        }
    }
    m
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Line {
    Error,
    Warn,
    /// Syncing (`sync recovered`) or uploading (`replica sync recovered`)
    /// resumed after consecutive errors.
    Recovered,
    Info,
    Debug,
}

/// One line of Litestream's log (slog text, `time=… level=… msg=… k=v`): its
/// kind, and the line without the time (the service's log stamps its own).
pub fn classify(line: &str) -> (Line, String) {
    let text = match line.split_once(' ') {
        Some((first, rest)) if first.starts_with("time=") => rest.trim(),
        _ => line.trim(),
    };
    let level = text.split_whitespace().find_map(|w| w.strip_prefix("level=")).unwrap_or("");
    let kind = if text.contains("sync recovered") {
        Line::Recovered
    } else {
        match level {
            "ERROR" => Line::Error,
            "WARN" => Line::Warn,
            "DEBUG" => Line::Debug,
            "INFO" => Line::Info,
            // Before its logger is up Litestream prints plain text
            // ("error: …") and exits.
            _ if text.to_ascii_lowercase().starts_with("error") => Line::Error,
            _ => Line::Info,
        }
    };
    (kind, text.to_string())
}

#[derive(Default)]
struct State {
    off: Option<String>,
    running: bool,
    waiting: bool,
    starts: u64,
    /// When the current state (running, or not) began.
    since_ms: u64,
    last_exit: Option<String>,
    /// The latest error or warning line: an exit's likely reason.
    last_complaint: Option<String>,
    errors: u64,
    last_error: Option<String>,
    last_error_ms: u64,
    recovered_ms: u64,
    metrics: Option<Metrics>,
    metrics_ms: u64,
    txid_ms: u64,
    puts_ms: u64,
}

/// The copier's state, shared with health.
#[derive(Default)]
pub struct ReplicationStats {
    s: Mutex<State>,
}

/// `replication` on `/api/health`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationView {
    /// `off` (see `reason`), `waiting` (a previous copier still holds the
    /// database), `running` or `restarting`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// How long it has been in this state.
    pub for_ms: u64,
    pub starts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit: Option<String>,
    /// Error lines the copier has logged, and the latest.
    pub errors: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_age_ms: Option<u64>,
    /// The latest error came after the latest recovery.
    pub error_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Metrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics_age_ms: Option<u64>,
    /// Since the copier's position last moved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub txid_age_ms: Option<u64>,
    /// Since its last upload to object storage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub puts_age_ms: Option<u64>,
}

impl ReplicationStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Configured but unable to run (no replica URL, say).
    pub fn off(&self, reason: String) {
        let mut s = self.s.lock();
        s.off = Some(reason);
        s.since_ms = now_ms();
    }

    fn waiting(&self, now: u64) {
        let mut s = self.s.lock();
        if !s.waiting {
            s.waiting = true;
            if s.since_ms == 0 {
                s.since_ms = now;
            }
        }
    }

    fn started(&self, now: u64) {
        let mut s = self.s.lock();
        s.running = true;
        s.waiting = false;
        s.starts += 1;
        s.since_ms = now;
        s.last_complaint = None;
        s.metrics = None;
        s.metrics_ms = 0;
    }

    fn exited(&self, why: String, now: u64) {
        let mut s = self.s.lock();
        let why = match s.last_complaint.take() {
            Some(c) => format!("{why}: {c}"),
            None => why,
        };
        s.last_exit = Some(crate::notes::scrub(&why));
        if s.running || s.since_ms == 0 {
            s.since_ms = now;
        }
        s.running = false;
    }

    fn line(&self, kind: Line, text: &str, now: u64) {
        let mut s = self.s.lock();
        match kind {
            Line::Error => {
                s.errors += 1;
                s.last_error = Some(crate::notes::scrub(text));
                s.last_error_ms = now;
                s.last_complaint = Some(text.to_string());
            }
            Line::Warn => s.last_complaint = Some(text.to_string()),
            Line::Recovered => s.recovered_ms = now,
            Line::Info | Line::Debug => {}
        }
    }

    fn metrics(&self, m: Metrics, now: u64) {
        let mut s = self.s.lock();
        let prev = s.metrics;
        if prev.is_none_or(|p| p.txid != m.txid) {
            s.txid_ms = now;
        }
        if m.puts.is_some() && prev.is_none_or(|p| p.puts != m.puts) {
            s.puts_ms = now;
        }
        s.metrics = Some(m);
        s.metrics_ms = now;
    }

    pub fn view(&self, now: u64) -> ReplicationView {
        let s = self.s.lock();
        let age = |t: u64| (t > 0).then(|| now.saturating_sub(t));
        let state = if s.off.is_some() {
            "off"
        } else if s.running {
            "running"
        } else if s.waiting {
            "waiting"
        } else {
            "restarting"
        };
        ReplicationView {
            state,
            reason: s.off.clone(),
            for_ms: now.saturating_sub(s.since_ms),
            starts: s.starts,
            last_exit: s.last_exit.clone(),
            errors: s.errors,
            last_error: s.last_error.clone(),
            last_error_age_ms: age(s.last_error_ms),
            error_open: s.last_error_ms > 0 && s.last_error_ms > s.recovered_ms,
            metrics: s.metrics,
            metrics_age_ms: age(s.metrics_ms),
            txid_age_ms: s.metrics.and(age(s.txid_ms)),
            puts_age_ms: s.metrics.and_then(|m| m.puts).and(age(s.puts_ms)),
        }
    }
}

/// Why replication needs a human, if it does (pure, for the tests).
/// `last_commit_ms` is the store's last commit: a quiet chain moves nothing,
/// so the position only has to move while the store does.
pub fn trouble(v: &ReplicationView, last_commit_ms: u64, now: u64) -> Option<String> {
    match v.state {
        "off" => return Some(format!("replication off: {}", v.reason.as_deref().unwrap_or("not configured"))),
        "waiting" if v.for_ms > DOWN_MS => {
            return Some(format!("not copying for {} s: a previous copier still holds the database", v.for_ms / 1000))
        }
        "restarting" if v.for_ms > DOWN_MS => {
            return Some(format!(
                "not copying for {} s: {}",
                v.for_ms / 1000,
                v.last_exit.as_deref().unwrap_or("the copier has not started")
            ))
        }
        _ => {}
    }
    if v.error_open && v.last_error_age_ms.is_some_and(|a| a < ERROR_MS) {
        return Some(format!("copier error: {}", v.last_error.as_deref().unwrap_or("")));
    }
    let committing = last_commit_ms > 0 && now.saturating_sub(last_commit_ms) < COMMITTING_MS;
    if v.state == "running" && committing && v.for_ms > STUCK_MS {
        match (v.txid_age_ms, v.puts_age_ms) {
            (None, _) => return Some("no metrics from the copier while the store commits".into()),
            (Some(a), _) if a > STUCK_MS => {
                return Some(format!("the copier's position hasn't moved for {} s while the store commits", a / 1000))
            }
            (_, Some(a)) if a > STUCK_MS => {
                return Some(format!("no upload to object storage for {} s while the store commits", a / 1000))
            }
            _ => {}
        }
    }
    None
}

/// The lock beside the database that the copier holds for its whole life.
pub fn lock_path(db: &Path) -> PathBuf {
    let name = db.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "db".into());
    db.with_file_name(format!(".{name}-litestream.lock"))
}

struct Lock(std::fs::File);

impl Lock {
    /// `None` while another copier holds it.
    fn acquire(path: &Path) -> std::io::Result<Option<Self>> {
        use std::os::fd::AsRawFd;
        let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path)?;
        // SAFETY: flock on a descriptor this function owns.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(Self(f)));
        }
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Ok(None)
        } else {
            Err(e)
        }
    }

    /// The child keeps the descriptor (and so the lock) across exec, and on
    /// Linux stops when its parent thread dies.
    fn hand_to(&self, cmd: &mut Command) {
        use std::os::fd::AsRawFd;
        let fd = self.0.as_raw_fd();
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

/// Sleeps, unless asked to stop first; true when asked to stop.
async fn pause(stop: &mut watch::Receiver<bool>, d: Duration) -> bool {
    if *stop.borrow() {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(d) => *stop.borrow(),
        _ = stop.changed() => true,
    }
}

fn forward(stream: impl AsyncRead + Unpin + Send + 'static, stats: Arc<ReplicationStats>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let (kind, text) = classify(&line);
            stats.line(kind, &text, now_ms());
            match kind {
                // Warnings become `replication.warn` notes.
                Line::Error | Line::Warn => tracing::warn!(target: "replication", "litestream: {text}"),
                // Compaction and retention run every 15–30 s: routine.
                Line::Info if text.contains("compaction complete") || text.contains("retention") => {
                    tracing::debug!(target: "replication", "litestream: {text}")
                }
                Line::Recovered | Line::Info => tracing::info!(target: "replication", "litestream: {text}"),
                Line::Debug => tracing::debug!(target: "replication", "litestream: {text}"),
            }
        }
    });
}

/// SIGTERM, then the copier's final sync, then SIGKILL if it overruns.
async fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SAFETY: signalling our own child by its pid.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    }
    if tokio::time::timeout(STOP_WAIT, child.wait()).await.is_err() {
        tracing::warn!(target: "replication", "litestream still copying after {STOP_WAIT:?}; killing it");
        let _ = child.kill().await;
    }
}

/// Runs the copier until `stop` turns true (or its sender drops), then lets
/// it finish its last sync.
pub async fn run(cfg: Config, stats: Arc<ReplicationStats>, mut stop: watch::Receiver<bool>) {
    let lock = lock_path(&cfg.db);
    let http = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().expect("http client");
    let metrics_url = format!("http://{}/metrics", cfg.addr);
    let mut delay = cfg.restart_min;
    loop {
        if *stop.borrow() {
            return;
        }
        let held = match Lock::acquire(&lock) {
            Ok(Some(l)) => l,
            Ok(None) => {
                stats.waiting(now_ms());
                if pause(&mut stop, cfg.restart_min).await {
                    return;
                }
                continue;
            }
            Err(e) => {
                stats.exited(format!("lock {}: {e}", lock.display()), now_ms());
                if pause(&mut stop, delay).await {
                    return;
                }
                delay = (delay * 2).min(RESTART_MAX);
                continue;
            }
        };
        let mut cmd = Command::new(&cfg.bin);
        cmd.arg("replicate")
            .arg("-config")
            .arg(&cfg.config)
            .env("MPAMM_DB", &cfg.db)
            .env("MPAMM_REPLICA_URL", &cfg.replica_url)
            .env("MPAMM_LITESTREAM_ADDR", cfg.addr.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        held.hand_to(&mut cmd);
        let spawned = cmd.spawn();
        // The child holds the lock now (or nobody does).
        drop(held);
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let why = format!("start {}: {e}", cfg.bin.display());
                tracing::warn!(target: "replication", "{why}; retrying in {delay:?}");
                stats.exited(why, now_ms());
                if pause(&mut stop, delay).await {
                    return;
                }
                delay = (delay * 2).min(RESTART_MAX);
                continue;
            }
        };
        let started = Instant::now();
        stats.started(now_ms());
        tracing::info!(target: "replication", "litestream started (pid {})", child.id().unwrap_or(0));
        if let Some(out) = child.stdout.take() {
            forward(out, stats.clone());
        }
        if let Some(err) = child.stderr.take() {
            forward(err, stats.clone());
        }
        let mut tick = tokio::time::interval(POLL);
        let exit = loop {
            tokio::select! {
                status = child.wait() => break Some(status),
                _ = stop.changed() => break None,
                _ = tick.tick() => {
                    if let Ok(r) = http.get(&metrics_url).send().await {
                        if let Ok(text) = r.text().await {
                            stats.metrics(parse_metrics(&text), now_ms());
                        }
                    }
                }
            }
        };
        let Some(status) = exit else {
            tracing::info!(target: "replication", "stopping litestream (its final sync)");
            terminate(&mut child).await;
            return;
        };
        // Let the readers drain the last lines (the exit's reason).
        tokio::time::sleep(Duration::from_millis(100)).await;
        let why = match status {
            Ok(s) => format!("litestream exited ({s})"),
            Err(e) => format!("litestream: {e}"),
        };
        if started.elapsed() >= STABLE {
            delay = cfg.restart_min;
        }
        tracing::warn!(target: "replication", "{why}; restarting in {delay:?}");
        stats.exited(why, now_ms());
        if pause(&mut stop, delay).await {
            return;
        }
        delay = (delay * 2).min(RESTART_MAX);
    }
}

#[cfg(test)]
mod tests;
