//! Wiring (Linux): threads, channels, the runtime and shutdown.

use std::{
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use arc_swap::ArcSwap;
use mpamm_chain::Rpc;
use mpamm_core::Venue;
use mpamm_pipeline::{watch_of, Fetcher, Input, Pipeline, Stats};
use mpamm_pricing::{Endpoints, Fees, Prices};
use mpamm_registry::Registry;
use mpamm_ring::{
    follow::{follow, FollowConfig, FollowStats},
    Config, Output, Tracker,
};
use mpamm_store::{writer::Writer, Store, FINAL_CURSOR};
use tokio::sync::{broadcast, mpsc};

use crate::{health, settings::Settings};

fn pin_to(cpu: usize) -> Result<(), String> {
    // SAFETY: a zeroed cpu_set_t is a valid empty set; this pins the calling thread.
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        libc::CPU_SET(cpu, &mut set);
        if libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

pub fn run(s: Settings) -> ExitCode {
    let registry = Registry::get();
    let store = match Store::open(&s.db) {
        Ok(st) => st,
        Err(e) => {
            tracing::error!("open {}: {e}", s.db.display());
            return ExitCode::FAILURE;
        }
    };
    let cursor = match store.cursor(FINAL_CURSOR) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("read cursor: {e}");
            return ExitCode::FAILURE;
        }
    };
    let resume = cursor.as_ref().map(|c| c.block + 1);
    tracing::info!(
        "store {}; {}; {} pairs registered; archive fallback {}",
        s.db.display(),
        resume.map_or("no cursor: starting at the newest block".into(), |n| format!("resuming at block {n}")),
        registry.pairs.len(),
        if s.archive_url.is_some() { "configured" } else { "not configured" }
    );

    let venues: Vec<Arc<dyn Venue>> = Vec::new();
    let watch = match watch_of(&venues) {
        Ok(w) => Arc::new(ArcSwap::from_pointee(w)),
        Err(e) => {
            tracing::error!("watch set: {e}");
            return ExitCode::FAILURE;
        }
    };
    let (tx, rx) = mpsc::unbounded_channel::<Input>();
    let stop = Arc::new(AtomicBool::new(false));
    let ring_stats = Arc::new(FollowStats::default());

    let reader = {
        let (watch, stop, ring_stats) = (watch.clone(), stop.clone(), ring_stats.clone());
        let cfg = FollowConfig { ring: s.ring.clone(), stall: Duration::from_secs(s.stall_secs.max(1)) };
        let tracker_cfg = Config { finalize_wait_ns: s.finalize_wait_ms * 1_000_000, require_headers: true };
        let cpu = s.reader_cpu;
        std::thread::Builder::new()
            .name("ring-reader".into())
            .spawn(move || {
                if let Some(cpu) = cpu {
                    match pin_to(cpu) {
                        Ok(()) => tracing::info!(target: "ring", "reader pinned to CPU {cpu}"),
                        Err(e) => tracing::error!(target: "ring", "pin to CPU {cpu}: {e}; running unpinned"),
                    }
                }
                let tracker = Tracker::new(tracker_cfg, resume);
                follow(&cfg, tracker, &watch, &ring_stats, &stop, |o| match o {
                    Output::Final(b) => tx.send(Input::Final(b)).is_ok(),
                    Output::Missing { number, reason } => tx.send(Input::Missing { number, reason }).is_ok(),
                    _ => true,
                });
                tracing::info!(target: "ring", "reader stopped");
            })
            .expect("spawn reader thread")
    };

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = runtime.block_on(async move {
        let stats = Arc::new(Stats::default());
        if let Some(c) = &cursor {
            stats.cursor.store(c.block, Ordering::Relaxed);
        }
        let (committed, _) = broadcast::channel(1024);
        let (stop_feeds, feeds_stop) = tokio::sync::watch::channel(false);
        let prices = Prices::new(registry, Fees::default());
        prices.spawn(Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(10)), Endpoints::default(), feeds_stop);
        let pipeline = Pipeline {
            writer: Writer::spawn(store),
            venues,
            fetcher: Fetcher {
                local: Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(10)),
                archive: s.archive_url.clone().map(|u| Rpc::new("archive", u, Duration::from_secs(30))),
            },
            registry,
            prices: prices.clone(),
            watch,
            stats: stats.clone(),
            committed,
            retry_min: Duration::from_millis(250),
            retry_max: Duration::from_secs(30),
        };
        let pipe = tokio::spawn(pipeline.run(rx));

        let app = health::router(health::Health {
            ring: ring_stats,
            pipeline: stats,
            prices: prices.clone(),
            started: Instant::now(),
            stall_ms: s.stall_secs.max(1) * 1000,
        });
        let listener = match tokio::net::TcpListener::bind(s.http).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("listen on {}: {e}", s.http);
                stop.store(true, Ordering::Relaxed);
                return ExitCode::FAILURE;
            }
        };
        tracing::info!("health on http://{}/api/health", s.http);
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        shutdown_signal().await;
        tracing::info!("stopping: reader first, then the in-flight block");
        stop.store(true, Ordering::Relaxed);
        let _ = tokio::task::spawn_blocking(move || reader.join()).await;
        // The reader dropped its sender, so the pipeline ends once it has
        // committed what it holds. A held block is safe to abandon: nothing
        // of it was written.
        if tokio::time::timeout(Duration::from_secs(10), pipe).await.is_err() {
            tracing::warn!("pipeline still holding after 10 s; exiting (nothing partial is written)");
        }
        let _ = stop_feeds.send(true);
        server.abort();
        ExitCode::SUCCESS
    });
    tracing::info!("stopped");
    code
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}
