//! Settings: command-line flags, then the `[service]` table of
//! `/var/lib/mpamm/mpamm.toml`, then defaults. Secrets (hosted RPC URLs)
//! come only from the environment, by the variable names configured here,
//! and are never printed.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use clap::Parser;
use serde::Deserialize;

#[derive(Debug, Parser)]
#[command(name = "mpamm", about = "The mpamm.wtf service: event reader, trade pipeline, store and API")]
pub struct Cli {
    /// Settings file; its `[service]` table fills in any flag not given.
    #[arg(long, env = "MPAMM_CONFIG", default_value = "/var/lib/mpamm/mpamm.toml")]
    pub config: PathBuf,
    /// SQLite database.
    #[arg(long)]
    pub db: Option<PathBuf>,
    /// Event ring file written by monad-execution.
    #[arg(long)]
    pub ring: Option<PathBuf>,
    /// The local node's JSON-RPC.
    #[arg(long)]
    pub rpc_url: Option<String>,
    /// Environment variable holding the hosted archive RPC URL.
    #[arg(long)]
    pub archive_url_env: Option<String>,
    /// Environment variable holding the backup archive RPC URL.
    #[arg(long)]
    pub archive_backup_url_env: Option<String>,
    /// Environment variable holding the hosted hot node's RPC URL (fallback
    /// mode; unset: no fallback).
    #[arg(long)]
    pub hot_url_env: Option<String>,
    /// Archive requests in flight (the primary refuses about 8).
    #[arg(long)]
    pub archive_concurrency: Option<usize>,
    /// Operator replays, today's `BACKFILL_RESET` grammar:
    /// `venue[:from][@nonce]`, comma-separated; each runs once.
    #[arg(long, env = "MPAMM_HISTORY_RESET")]
    pub history_reset: Option<String>,
    /// Pin the ring reader thread to this CPU.
    #[arg(long)]
    pub reader_cpu: Option<usize>,
    /// Address the API (REST, stream, health) listens on.
    #[arg(long)]
    pub http: Option<SocketAddr>,
    /// The built dashboard (`web/dist`), served beside the API.
    #[arg(long, env = "WEB_DIST")]
    pub web_dist: Option<PathBuf>,
    #[arg(long)]
    pub finalize_wait_ms: Option<u64>,
    #[arg(long)]
    pub stall_secs: Option<u64>,
    /// Each venue's deadline per block (ms).
    #[arg(long)]
    pub quote_deadline_ms: Option<u64>,
    /// Least time between two depth passes (ms); 0 follows every block.
    #[arg(long)]
    pub depth_min_interval_ms: Option<u64>,
    /// Where the exchanges' archives are cached (markouts after the fact).
    #[arg(long)]
    pub archive_cache: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ServiceFile {
    pub db: Option<PathBuf>,
    pub ring: Option<PathBuf>,
    pub rpc_url: Option<String>,
    pub archive_url_env: Option<String>,
    pub archive_backup_url_env: Option<String>,
    pub hot_url_env: Option<String>,
    pub archive_concurrency: Option<usize>,
    pub history_reset: Option<String>,
    pub reader_cpu: Option<usize>,
    pub http: Option<SocketAddr>,
    pub web_dist: Option<PathBuf>,
    pub finalize_wait_ms: Option<u64>,
    pub stall_secs: Option<u64>,
    pub quote_deadline_ms: Option<u64>,
    pub depth_min_interval_ms: Option<u64>,
    pub archive_cache: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    #[serde(default)]
    service: ServiceFile,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub db: PathBuf,
    pub ring: PathBuf,
    pub rpc_url: String,
    pub archive_url_env: String,
    /// The archive URL itself, from the environment (never printed).
    pub archive_url: Option<String>,
    pub archive_backup_url_env: String,
    pub archive_backup_url: Option<String>,
    pub hot_url_env: String,
    /// The hosted hot node's URL, from the environment (never printed).
    pub hot_url: Option<String>,
    pub archive_concurrency: usize,
    pub history_reset: String,
    pub reader_cpu: Option<usize>,
    pub http: SocketAddr,
    pub web_dist: Option<PathBuf>,
    pub finalize_wait_ms: u64,
    pub stall_secs: u64,
    pub quote_deadline_ms: u64,
    pub depth_min_interval_ms: u64,
    pub archive_cache: PathBuf,
}

pub const DEFAULT_RING: &str = "/var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings/monad-exec-events";

fn read_file(path: &Path) -> Result<ServiceFile, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => toml::from_str::<FileConfig>(&s).map(|f| f.service).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ServiceFile::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

impl Settings {
    pub fn load(cli: Cli, env: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let f = read_file(&cli.config)?;
        let archive_url_env =
            cli.archive_url_env.or(f.archive_url_env).unwrap_or_else(|| "MPAMM_ARCHIVE_RPC_URL".into());
        let archive_backup_url_env = cli
            .archive_backup_url_env
            .or(f.archive_backup_url_env)
            .unwrap_or_else(|| "MPAMM_ARCHIVE_RPC_BACKUP_URL".into());
        let hot_url_env = cli.hot_url_env.or(f.hot_url_env).unwrap_or_else(|| "MPAMM_HOT_RPC_URL".into());
        Ok(Self {
            db: cli.db.or(f.db).unwrap_or_else(|| "/var/lib/mpamm/data/mpamm.db".into()),
            ring: cli.ring.or(f.ring).unwrap_or_else(|| DEFAULT_RING.into()),
            rpc_url: cli.rpc_url.or(f.rpc_url).unwrap_or_else(|| "http://127.0.0.1:8080".into()),
            archive_url: env(&archive_url_env).filter(|u| !u.is_empty()),
            archive_url_env,
            archive_backup_url: env(&archive_backup_url_env).filter(|u| !u.is_empty()),
            archive_backup_url_env,
            hot_url: env(&hot_url_env).filter(|u| !u.is_empty()),
            hot_url_env,
            archive_concurrency: cli.archive_concurrency.or(f.archive_concurrency).unwrap_or(4).max(1),
            history_reset: cli.history_reset.or(f.history_reset).unwrap_or_default(),
            reader_cpu: cli.reader_cpu.or(f.reader_cpu),
            http: cli.http.or(f.http).unwrap_or_else(|| "127.0.0.1:8787".parse().unwrap()),
            web_dist: cli.web_dist.or(f.web_dist),
            finalize_wait_ms: cli.finalize_wait_ms.or(f.finalize_wait_ms).unwrap_or(2000),
            stall_secs: cli.stall_secs.or(f.stall_secs).unwrap_or(5),
            quote_deadline_ms: cli.quote_deadline_ms.or(f.quote_deadline_ms).unwrap_or(150),
            depth_min_interval_ms: cli.depth_min_interval_ms.or(f.depth_min_interval_ms).unwrap_or(0),
            archive_cache: cli.archive_cache.or(f.archive_cache).unwrap_or_else(|| "/var/lib/mpamm/archives".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(args: &[&str]) -> Cli {
        Cli::parse_from(std::iter::once("mpamm").chain(args.iter().copied()))
    }

    #[test]
    fn flags_beat_the_file_and_the_file_beats_defaults() {
        let dir = std::env::temp_dir().join(format!("mpamm-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("mpamm.toml");
        std::fs::write(&p, "[reader]\ncpu = 0\n\n[service]\nreader_cpu = 3\nhttp = \"127.0.0.1:9000\"\narchive_url_env = \"ARCHIVE\"\n").unwrap();
        let env = |k: &str| (k == "ARCHIVE").then(|| "https://key.example/".to_string());
        let s = Settings::load(cli(&["--config", p.to_str().unwrap(), "--reader-cpu", "5"]), env).unwrap();
        assert_eq!(s.reader_cpu, Some(5));
        assert_eq!(s.http, "127.0.0.1:9000".parse().unwrap());
        assert_eq!(s.archive_url.as_deref(), Some("https://key.example/"));
        assert_eq!(s.db, PathBuf::from("/var/lib/mpamm/data/mpamm.db"));
        assert_eq!(s.rpc_url, "http://127.0.0.1:8080");
        assert_eq!(s.web_dist, None);
        assert_eq!(s.depth_min_interval_ms, 0, "depth follows every block by default");
        assert_eq!(s.archive_cache, PathBuf::from("/var/lib/mpamm/archives"));
        assert_eq!((s.archive_backup_url.as_deref(), s.archive_concurrency), (None, 4));
        assert_eq!(s.history_reset, "");
        assert_eq!((s.hot_url_env.as_str(), s.hot_url.as_deref()), ("MPAMM_HOT_RPC_URL", None));
        let backup = |k: &str| (k == "MPAMM_ARCHIVE_RPC_BACKUP_URL").then(|| "https://b.example/".to_string());
        let s = Settings::load(cli(&["--config", p.to_str().unwrap(), "--history-reset", "poe:2026-11-01"]), backup)
            .unwrap();
        assert_eq!(
            (s.archive_backup_url.as_deref(), s.history_reset.as_str()),
            (Some("https://b.example/"), "poe:2026-11-01")
        );

        std::fs::write(&p, "[service]\nreader_cpus = 3\n").unwrap();
        assert!(Settings::load(cli(&["--config", p.to_str().unwrap()]), |_| None).unwrap_err().contains("reader_cpus"));
        let s = Settings::load(cli(&["--config", dir.join("absent.toml").to_str().unwrap()]), |_| None).unwrap();
        assert_eq!((s.reader_cpu, s.archive_url), (None, None));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
