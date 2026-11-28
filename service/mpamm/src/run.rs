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

use crate::{health, settings::Settings, source::ServiceSource};

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

pub fn run(s: Settings, notes: Arc<crate::notes::NoteBuffer>) -> ExitCode {
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
    let venue_state = match store.all_venue_state() {
        Ok(m) => mpamm_core::VenueState::new(m),
        Err(e) => {
            tracing::error!("read venue state: {e}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(
        "store {}; {}; {} pairs registered; archive fallback {}",
        s.db.display(),
        resume.map_or("no cursor: starting at the newest block".into(), |n| format!("resuming at block {n}")),
        registry.pairs.len(),
        if s.archive_url.is_some() { "configured" } else { "not configured" }
    );

    let venues: Vec<Arc<dyn Venue>> = mpamm_venues::all();
    let local = Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(10));
    // Discovery comes first: the reader must know what to copy from the
    // first block. A venue that can't discover holds the start (fail-closed).
    let boot = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let hot = s.hot_url.clone().map(|u| Rpc::new("hot", u, Duration::from_secs(10)));
    boot.block_on(discover_all(&venues, &local, hot.as_ref(), registry, true));
    drop(boot);
    let watch = match watch_of(&venues) {
        Ok(w) => Arc::new(ArcSwap::from_pointee(w)),
        Err(e) => {
            tracing::error!("watch set: {e}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!("{} venue(s); watching {} log address(es)", venues.len(), watch.load().logs.len());
    let (tx, rx) = mpsc::unbounded_channel::<Input>();
    // Fallback mode feeds the pipeline too (heights read over RPC).
    let feed_tx = tx.clone();
    let (exec_tx, mut exec_rx) = mpsc::unbounded_channel::<(mpamm_core::BlockRef, u128)>();
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
                    Output::Executed { id, number, hash, proposal_ns, .. } => {
                        let _ = exec_tx.send((mpamm_core::BlockRef { number, id, hash }, proposal_ns));
                        true
                    }
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
        let (committed, _) = broadcast::channel(4096);
        let mut committed_rx = committed.subscribe();
        let source_rx = committed.subscribe();
        let history_rx = committed.subscribe();
        let writer = Writer::spawn(store);
        let (stop_feeds, feeds_stop) = tokio::sync::watch::channel(false);
        let prices = Prices::new(registry, Fees::default());
        prices.spawn(Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(10)), Endpoints::default(), feeds_stop);
        let skip_local = Arc::new(AtomicBool::new(false));
        let fallback_stats = s.hot_url.as_ref().map(|_| Arc::new(crate::fallback::FallbackStats::default()));
        let pipeline = Pipeline {
            writer: writer.clone(),
            venues,
            fetcher: Fetcher {
                local: Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(10)),
                hot: s.hot_url.clone().map(|u| Rpc::new("hot", u, Duration::from_secs(10))),
                archive: s.archive_url.clone().map(|u| Rpc::new("archive", u, Duration::from_secs(30))),
                skip_local: skip_local.clone(),
            },
            registry,
            prices: prices.clone(),
            watch,
            state: std::sync::Mutex::new(venue_state),
            refetch_through: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            rediscover: Arc::new(tokio::sync::Notify::new()),
            stats: stats.clone(),
            committed,
            retry_min: Duration::from_millis(250),
            retry_max: Duration::from_secs(30),
        };
        let refetch = pipeline.refetch_through.clone();
        let asked = pipeline.rediscover.clone();
        let rediscover_watch = pipeline.watch.clone();
        let rediscover_venues = pipeline.venues.clone();
        let rediscover_ring = ring_stats.clone();
        // A client made on this runtime (the boot one's connections died with it).
        let local = Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(10));
        let rediscover_hot = s.hot_url.clone().map(|u| Rpc::new("hot", u, Duration::from_secs(10)));
        let quote_venues = pipeline.venues.clone();
        let depth_venues = pipeline.venues.clone();
        let source_venues = pipeline.venues.clone();
        let pipe = tokio::spawn(pipeline.run(rx));

        // The hosted archive nodes, in order: history repairs read them.
        let pool = Arc::new(mpamm_history::ArchivePool::new(
            [("archive", &s.archive_url), ("archive-backup", &s.archive_backup_url)]
                .into_iter()
                .filter_map(|(label, url)| url.as_ref().map(|u| Rpc::new(label, u.clone(), Duration::from_secs(60))))
                .collect(),
            mpamm_history::PoolConfig { concurrency: s.archive_concurrency, ..Default::default() },
        ));
        let history_stats = Arc::new(mpamm_history::Stats::default());
        // The exchanges' archives: markouts after the fact, and the prices
        // history repairs decode closed days with.
        let archives = mpamm_pricing::archives::Archives::new(
            registry,
            mpamm_pricing::archives::ArchiveConfig::new(s.archive_cache.clone()),
        );

        // Quotes: every proposed block that finished executing is quoted by
        // every venue, pinned to its hash. Blocks replayed from the ring after
        // a restart are history, not news: only fresh ones are quoted.
        let engine = mpamm_quotes::Engine::new(
            quote_venues,
            Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(2)),
            prices.clone(),
            registry,
            Duration::from_millis(s.quote_deadline_ms),
        );
        // Depth curves: the same venues over a 25-size grid, for the markets
        // someone watches, following the same executed blocks, on a client
        // of their own (today's depth runs in its own process and connection).
        let depth = mpamm_quotes::depth::Depth::new(
            depth_venues,
            Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(2)),
            prices.clone(),
            registry,
            Duration::from_millis(s.quote_deadline_ms),
            Duration::from_millis(s.depth_min_interval_ms),
        );
        let notes_buffer = notes.clone();
        // Replication: Litestream copies the database off the host, as this
        // service's child (fail-open; see replication.rs).
        let replication = s.litestream.as_ref().map(|_| crate::replication::ReplicationStats::new());
        let (stop_replication, replication_rx) = tokio::sync::watch::channel(false);
        let replication_task = match (&s.litestream, &replication, &s.replica_url) {
            (Some(bin), Some(stats), Some(url)) => Some(tokio::spawn(crate::replication::run(
                crate::replication::Config {
                    bin: bin.clone(),
                    config: s.litestream_config.clone(),
                    addr: s.litestream_addr,
                    db: std::fs::canonicalize(&s.db).unwrap_or_else(|_| s.db.clone()),
                    replica_url: url.clone(),
                    restart_min: crate::replication::RESTART_MIN,
                },
                stats.clone(),
                replication_rx,
            ))),
            (Some(_), Some(stats), None) => {
                tracing::warn!("replication off: no replica URL ({})", s.replica_url_env);
                stats.off(format!("no replica URL ({})", s.replica_url_env));
                None
            }
            _ => {
                tracing::info!("replication off: no Litestream binary configured");
                None
            }
        };
        // The dashboard's source: frames, tape, volume, state, depth, the store.
        let source = ServiceSource::new(
            registry,
            source_venues,
            prices.clone(),
            depth.clone(),
            health::Health {
                ring: ring_stats.clone(),
                pipeline: stats.clone(),
                prices: prices.clone(),
                quotes: engine.clone(),
                depth: depth.clone(),
                started: Instant::now(),
                stall_ms: s.stall_secs.max(1) * 1000,
                history: Some(crate::history::HistoryHealth { stats: history_stats.clone(), pool: pool.clone() }),
                fallback: fallback_stats.clone(),
                replication: replication.clone(),
            },
            s.db.clone(),
            notes,
        );
        source.start(&engine, source_rx);

        // Fallback mode: heads, quotes and final blocks from the hosted hot
        // node while the local one is down (only with a hot node configured).
        match (&s.hot_url, &fallback_stats) {
            (Some(url), Some(fstats)) => {
                tokio::spawn(
                    crate::fallback::Driver {
                        hot: Rpc::new("hot", url.clone(), Duration::from_secs(2)),
                        hot_quotes: Rpc::new("hot", url.clone(), Duration::from_secs(2)),
                        local_quotes: Rpc::new("local", s.rpc_url.clone(), Duration::from_secs(2)),
                        engine: engine.clone(),
                        ring: ring_stats.clone(),
                        pipeline: stats.clone(),
                        feed: feed_tx,
                        skip_local,
                        stats: fstats.clone(),
                        notes: notes_buffer.clone(),
                    }
                    .run(),
                );
            }
            _ => {
                drop(feed_tx);
                tracing::info!("fallback mode off: no hosted hot node ({})", s.hot_url_env);
            }
        }

        let quotes = engine.clone();
        tokio::spawn(async move {
            while let Some((block, proposal_ns)) = exec_rx.recv().await {
                let age_ms = mpamm_ring::live::now_ms() as f64 - proposal_ns as f64 / 1e6;
                if age_ms < 2_000.0 {
                    quotes.on_executed(block, proposal_ns);
                    depth.on_executed(block);
                }
            }
        });

        // Markouts after the fact: the marks the live history couldn't give
        // (trades repaired after an outage, from before a restart), from the
        // exchanges' archives once they're published.
        let marks_source = source.clone();
        tokio::spawn(crate::marks::run(
            archives.clone(),
            writer.clone(),
            Duration::from_secs(120),
            || mpamm_ring::live::now_ms() as f64,
            move |changed| marks_source.on_markouts(changed),
        ));

        // History repairs: planned once the first block is known, then run
        // beside the pipeline; the trades they insert get their markouts.
        let (inserted_tx, inserted_rx) = mpsc::unbounded_channel();
        tokio::spawn(crate::history::mark_inserted(archives.clone(), writer.clone(), inserted_rx, source.clone()));
        tokio::spawn(crate::history::run(crate::history::Inputs {
            pool,
            writer: writer.clone(),
            registry,
            prices: prices.clone(),
            archives: archives.clone(),
            rpc_url: s.rpc_url.clone(),
            resets: s.history_reset.clone(),
            boot_cursor: cursor.as_ref().map(|c| c.block),
            first_commit: history_rx,
            stats: history_stats,
            sink: Arc::new(crate::history::ServiceSink {
                notes: notes_buffer.clone(),
                source: source.clone(),
                inserted: inserted_tx,
                changed: Default::default(),
            }),
        }));

        // Markouts: every committed trade is aged against the reference
        // history; a restart resumes the trades still within their horizons.
        let aging_prices = prices.clone();
        let aging_source = source.clone();
        tokio::spawn(async move {
            let mut aging = mpamm_markouts::Aging::default();
            let since = mpamm_ring::live::now_ms() as f64 - 90_000.0;
            if let Ok(recent) = writer.run(move |st| st.trades_aging(since)).await {
                for f in &recent {
                    aging.add(registry, f);
                }
            }
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            loop {
                tokio::select! {
                    c = committed_rx.recv() => match c {
                        Ok(c) => c.trades.iter().for_each(|f| aging.add(registry, f)),
                        Err(broadcast::error::RecvError::Lagged(n)) => tracing::warn!("markouts missed {n} committed block(s)"),
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                    _ = tick.tick() => {
                        let now = mpamm_ring::live::now_ms() as f64;
                        let updates = aging.tick(now, |m, t| aging_prices.pair_mid_at(m, t));
                        if updates.is_empty() {
                            continue;
                        }
                        let marked: Vec<(String, Vec<Option<f64>>)> =
                            updates.iter().filter_map(|u| u.markouts.clone().map(|m| (u.id.clone(), m))).collect();
                        let r = writer
                            .run(move |st| {
                                for u in &updates {
                                    if let Some(mk) = &u.markouts {
                                        st.set_markouts(&u.id, mk)?;
                                    }
                                    if let Some(c) = &u.curve {
                                        st.set_curve(&u.id, c)?;
                                    }
                                }
                                Ok(())
                            })
                            .await;
                        match r {
                            Ok(()) => aging_source.on_markouts(&marked),
                            Err(e) => tracing::warn!("write markouts: {e}"),
                        }
                    }
                }
            }
        });
        // Rediscovery every 10 minutes, merge-only. A grown watch set applies
        // from the reader's next event; blocks up to just past the newest one
        // seen are read over RPC with the new set.
        tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(600));
            every.tick().await;
            loop {
                // Every 10 minutes, or at once when a held block asks (at most
                // every 5 s, so a stuck venue can't hammer the node).
                tokio::select! {
                    _ = every.tick() => {}
                    _ = asked.notified() => tokio::time::sleep(Duration::from_secs(5)).await,
                }
                discover_all(&rediscover_venues, &local, rediscover_hot.as_ref(), registry, false).await;
                match watch_of(&rediscover_venues) {
                    Ok(w) if w != **rediscover_watch.load() => {
                        let newest = rediscover_ring.newest_block.load(Ordering::Relaxed);
                        refetch.fetch_max(newest + 3, Ordering::Relaxed);
                        tracing::info!(
                            "watch set grew to {} log address(es); blocks through {} read over RPC",
                            w.logs.len(),
                            newest + 3
                        );
                        rediscover_watch.store(Arc::new(w));
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("watch set after rediscovery: {e}; keeping the current one"),
                }
            }
        });

        let mut app = mpamm_api::router(source.clone());
        if let Some(dist) = &s.web_dist {
            // The dashboard, same-origin with its API (unknown paths are the
            // app's own routes).
            let files = tower_http::services::ServeDir::new(dist)
                .fallback(tower_http::services::ServeFile::new(dist.join("index.html")));
            app = app.fallback_service(files).layer(tower_http::compression::CompressionLayer::new());
            tracing::info!("serving the dashboard from {}", dist.display());
        }
        let listener = match tokio::net::TcpListener::bind(s.http).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("listen on {}: {e}", s.http);
                stop.store(true, Ordering::Relaxed);
                return ExitCode::FAILURE;
            }
        };
        tracing::info!("API on http://{}/api (health: /api/health)", s.http);
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
        // The copier last: its final sync carries the last commit.
        let _ = stop_replication.send(true);
        if let Some(t) = replication_task {
            let _ = tokio::time::timeout(crate::replication::STOP_WAIT + Duration::from_secs(5), t).await;
        }
        let _ = stop_feeds.send(true);
        server.abort();
        ExitCode::SUCCESS
    });
    tracing::info!("stopped");
    code
}

/// Discovers every venue. At boot each is retried until it succeeds; later
/// a failure keeps what the venue already holds (discovery only merges).
/// With the local node down, the hosted hot node answers instead.
async fn discover_all(
    venues: &[Arc<dyn Venue>],
    rpc: &Rpc,
    hot: Option<&Rpc>,
    registry: &'static Registry,
    boot: bool,
) {
    let cx = mpamm_core::ChainCx { rpc, registry };
    for v in venues {
        let mut delay = Duration::from_secs(1);
        loop {
            let r = match v.discover(&cx).await {
                Err(local) => match hot {
                    Some(h) => v
                        .discover(&mpamm_core::ChainCx { rpc: h, registry })
                        .await
                        .map_err(|e| format!("local: {local}; hot: {e}")),
                    None => Err(local.to_string()),
                },
                Ok(()) => Ok(()),
            };
            match r {
                Ok(()) => break,
                Err(e) if boot => {
                    tracing::warn!("discover {}: {e}; retrying in {delay:?}", v.id());
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(60));
                }
                Err(e) => {
                    tracing::warn!("rediscover {}: {e}; keeping what it holds", v.id());
                    break;
                }
            }
        }
    }
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}
