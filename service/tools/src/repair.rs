//! `mpamm-tools repair`: a database's history repairs, run outside the
//! service, exactly as the service runs them (mpamm-history), on a copy of
//! the database: rehearsing a revision or an operator replay before it ships,
//! or proving one against production. `b0` is the database's cursor.
//!
//! Archive URLs come from the environment by name (they carry keys), or as
//! `--archive-url` for one that carries none (the local node, for days it
//! still holds).

use std::{sync::Arc, time::Duration};

use mpamm_chain::Rpc;
use mpamm_history::{
    boot::{prepare, run_jobs},
    exec::{Executor, Sink, Stats},
    ArchivePool, PoolConfig,
};
use mpamm_pricing::{
    archives::{closed_day::ClosedDayPrices, ArchiveConfig, Archives},
    Endpoints, Fees, Prices,
};
use mpamm_registry::Registry;
use mpamm_store::{history::DayOutcome, writer::Writer, Store, FINAL_CURSOR};
use mpamm_types::utc_day;

struct Print;

impl Sink for Print {
    fn note(&self, warn: bool, code: &str, venue: &str, msg: &str) {
        eprintln!("{} {code} {venue}: {msg}", if warn { "WARN" } else { "info" });
    }
    fn written(&self, venue: &str, day: &str, o: &DayOutcome) {
        eprintln!(
            "{venue} {day}: ${:.2}/{} → ${:.2}/{}{}",
            o.before.usd,
            o.before.swaps,
            o.after.usd,
            o.after.swaps,
            if o.through_trades { format!(" ({} new, {} gone)", o.inserted.len(), o.removed) } else { String::new() }
        );
    }
}

pub struct Args {
    pub db: std::path::PathBuf,
    pub resets: String,
    pub archive_urls: Vec<String>,
    pub rpc: String,
    pub chunk: u64,
    pub concurrency: usize,
    pub cache: std::path::PathBuf,
    pub live_prices_secs: u64,
    pub plan_only: bool,
}

pub async fn repair(a: Args) -> Result<(), String> {
    let registry = Registry::get();
    let store = Store::open(&a.db).map_err(|e| e.to_string())?;
    let b0 = store
        .cursor(FINAL_CURSOR)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{} has no cursor: repairs replay up to it", a.db.display()))?
        .block;
    let writer = Writer::spawn(store);
    let pool = Arc::new(ArchivePool::new(
        a.archive_urls
            .iter()
            .enumerate()
            .map(|(i, u)| {
                Rpc::new(
                    if i == 0 { "archive".to_string() } else { format!("archive-{i}") },
                    u,
                    Duration::from_secs(60),
                )
            })
            .collect(),
        PoolConfig { chunk: a.chunk, concurrency: a.concurrency, ..PoolConfig::default() },
    ));
    let venues = mpamm_venues::all();
    let now = || mpamm_ring::live::now_ms() as i64;
    let today = utc_day(now() as f64);
    let sink: Arc<dyn Sink> = Arc::new(Print);
    let prepared = prepare(&writer, &pool, &venues, &a.resets, &today, now(), &*sink).await?;
    let p = &prepared.plan;
    eprintln!(
        "b0 {b0}; trades stored from {}; {} adopted, {} refused; {} repair(s) to run",
        prepared.trades_from,
        p.adopt.len(),
        p.refused.len(),
        p.jobs.len()
    );
    for j in &p.jobs {
        eprintln!(
            "  {} {} ({}): {} → {}",
            j.venue,
            j.what,
            j.kind.as_str(),
            j.from,
            j.until.clone().unwrap_or_else(|| format!("block {b0}"))
        );
    }
    if a.plan_only || p.jobs.is_empty() {
        return Ok(());
    }
    if pool.is_empty() {
        return Err("no archive: set --archive-url-env (or --archive-url for a node without a key)".into());
    }
    // Live prices stand in where no archive answers (today's crypto-quoted
    // trades), as in the service.
    let prices = Prices::new(registry, Fees::default());
    if a.live_prices_secs > 0 {
        let (stop_tx, stop) = tokio::sync::watch::channel(false);
        prices.spawn(Rpc::new("local", a.rpc.clone(), Duration::from_secs(10)), Endpoints::default(), stop);
        tokio::time::sleep(Duration::from_secs(a.live_prices_secs)).await;
        std::mem::forget(stop_tx);
    }
    let archives = Archives::new(registry, ArchiveConfig::new(a.cache.clone()));
    let exec = Executor {
        pool: pool.clone(),
        writer,
        registry,
        closed: Arc::new(ClosedDayPrices::new(registry, archives)),
        prices,
        local: Rpc::new("local", a.rpc.clone(), Duration::from_secs(10)),
        venues,
        committed: prepared.committed.clone(),
        trades_from: prepared.trades_from.clone(),
        sink,
        stats: Arc::new(Stats::default()),
        now_ms: || mpamm_ring::live::now_ms() as i64,
    };
    let started = std::time::Instant::now();
    run_jobs(&exec, &p.jobs, b0, None).await?;
    for n in pool.stats() {
        eprintln!("{}: {} ok, {} failed", n.label, n.ok, n.failed);
    }
    eprintln!("done in {:.0} s", started.elapsed().as_secs_f64());
    Ok(())
}
