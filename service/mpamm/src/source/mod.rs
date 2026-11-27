//! The service behind today's REST routes and v2 stream (`mpamm-api`):
//! what the dashboard reads, built from the service's own parts.
//!
//! - Quote frames: the engine's per-venue answers assembled per block
//!   (`frames`), kept for the Execution tab's chart and statistics
//!   (`history`).
//! - The tape: trades as the pipeline commits them, and again when their
//!   markouts arrive (the client upserts by id).
//! - Volume: re-read from the store after a block with trades; the stream
//!   carries today's bucket.
//! - Fills, gas and the analytics windows: the store, read on blocking
//!   threads through their own read-only connections (WAL: commits never
//!   wait on a reader).
//! - Market state: rebuilt every second.
//! - Depth curves: the depth engine's latest snapshot per market, computed
//!   while someone watches it (`mpamm_quotes::depth`); REST reads it, the
//!   SSE route and stream topic watch it.
//!
//! The API calls the in-memory methods under its stream lock, so they only
//! copy what is here; anything that touches SQLite is one of the async ones.

mod frames;
mod history;

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use indexmap::IndexMap;
use mpamm_api::{ApiSource, SourceError};
use mpamm_core::Venue;
use mpamm_pipeline::Committed;
use mpamm_pricing::Prices;
use mpamm_quotes::{depth::Depth, Engine};
use mpamm_registry::Registry;
use mpamm_ring::live::now_ms;
use mpamm_store::Store;
use mpamm_types::{
    utc_day, DailyVolume, DataSourceMode, Fill, GasResponse, LeaderboardResponse, MarketState, MarkoutCurvesResponse,
    QuoteSnapshot, QuoteStatsResponse, StreamMessage, StreamState, TailStatus, VenueMeta,
};
use parking_lot::Mutex;
use tokio::sync::{broadcast, watch};

pub use frames::Assembler;
pub use history::ExecutionHistory;

#[cfg(test)]
mod tests;

/// Trades the tape keeps (today's `/api/markets` carries 400).
const TAPE: usize = 400;
/// Chain time the committed tip may trail the newest proposal and still
/// read as live (today's): finality is ~3 blocks, a restart's catch-up is
/// seconds. Only past it does the state carry `tail` (the stream's budget).
const TAIL_LAG_SHOWN_MS: f64 = 120_000.0;
/// Behind by that much and nothing committed for this long is held: the
/// state that needs a human, as opposed to catching up.
const TAIL_HELD_MS: u64 = 120_000;
/// Monad's block time: one quote frame per block.
const QUOTE_CADENCE_MS: f64 = 400.0;
/// How long an aggregation is reused (today's publication cache).
const LEADERBOARD_TTL: Duration = Duration::from_secs(5);
const CURVES_TTL: Duration = Duration::from_secs(30);

struct Live {
    state: MarketState,
    /// The newest frame, possibly one a venue missed.
    quotes: QuoteSnapshot,
    /// The newest frame every venue answered.
    full: Option<QuoteSnapshot>,
    history: ExecutionHistory,
    /// Newest last.
    tape: VecDeque<Fill>,
    volume: Vec<DailyVolume>,
}

type Cached<T> = Mutex<HashMap<u32, (Instant, Arc<T>)>>;

pub struct ServiceSource {
    venues: Vec<Arc<dyn Venue>>,
    prices: Arc<Prices>,
    health: crate::health::Health,
    db: PathBuf,
    notes: Arc<crate::notes::NoteBuffer>,
    live: Mutex<Live>,
    tx: broadcast::Sender<StreamMessage>,
    depth: Arc<Depth>,
    ready: AtomicBool,
    leaderboards: Cached<LeaderboardResponse>,
    curves: Cached<MarkoutCurvesResponse>,
}

impl ServiceSource {
    pub fn new(
        registry: &'static Registry,
        venues: Vec<Arc<dyn Venue>>,
        prices: Arc<Prices>,
        depth: Arc<Depth>,
        health: crate::health::Health,
        db: PathBuf,
        notes: Arc<crate::notes::NoteBuffer>,
    ) -> Arc<Self> {
        let (tx, _) = broadcast::channel(4096);
        let empty = QuoteSnapshot {
            block_hash: None,
            revision: None,
            block: 0,
            mon_usd: 0.0,
            ts: 0.0,
            rows: vec![],
            frame: None,
        };
        let s = Arc::new(Self {
            venues,
            prices,
            health,
            db,
            notes,
            live: Mutex::new(Live {
                state: MarketState {
                    chain_id: registry.chain_id,
                    block: 0,
                    mon_usd: 0.0,
                    mon_change_pct: 0.0,
                    taker_bps: 0.0,
                    markets: registry.markets().map(str::to_string).collect(),
                    sizes_usd: registry.sizes_usd.clone(),
                    quote_cadence_ms: QUOTE_CADENCE_MS,
                    source: DataSourceMode::Live,
                    venues: vec![],
                    quote_markets: None,
                    notes: None,
                    rpc: None,
                    rpc_archive: None,
                    realtime: None,
                    tail: None,
                },
                quotes: empty,
                full: None,
                history: ExecutionHistory::new(registry),
                tape: VecDeque::new(),
                volume: vec![],
            }),
            tx,
            depth,
            ready: AtomicBool::new(false),
            leaderboards: Mutex::new(HashMap::new()),
            curves: Mutex::new(HashMap::new()),
        });
        s.refresh_state();
        s
    }

    /// Every venue's registry entry, the exchanges' after them.
    fn venue_metas(&self) -> Vec<VenueMeta> {
        let mut v: Vec<VenueMeta> = self.venues.iter().flat_map(|v| v.meta()).collect();
        v.extend(mpamm_pricing::reference_venues(&self.prices.fees));
        v
    }

    fn refresh_state(&self) {
        let r = self.prices.reference();
        let ring = self.health.ring.view();
        let pipeline = self.health.pipeline.view();
        let quote_markets: IndexMap<String, Vec<String>> = self
            .venues
            .iter()
            .flat_map(|v| {
                let markets = v.markets();
                v.meta().into_iter().map(move |m| (m.id, markets.clone()))
            })
            .collect();
        let newest = ring.newest_block.max(pipeline.cursor);
        let tail = (pipeline.cursor > 0)
            .then(|| tail_status(pipeline.cursor, newest, pipeline.last_commit_unix_ms, now_ms()))
            .filter(|t| t.lag_ms > TAIL_LAG_SHOWN_MS);
        let mut live = self.live.lock();
        let st = &mut live.state;
        st.block = newest;
        st.mon_usd = r.asset_usd("MON");
        st.mon_change_pct = r.change_pct("MON");
        st.taker_bps = self.prices.fees.bybit;
        st.venues = self.venue_metas();
        st.quote_markets = Some(quote_markets);
        st.tail = tail;
    }

    /// Starts the tasks that keep the source current: frames from the
    /// engine, the tape and volume from commits, the state every second,
    /// and the depth passes for watched markets.
    pub fn start(self: &Arc<Self>, engine: &Arc<Engine>, mut committed: broadcast::Receiver<Committed>) {
        tokio::spawn(self.depth.clone().run());

        let deadline_ms = engine.deadline.as_secs_f64() * 1000.0 + 30.0;
        let mut published = engine.published.subscribe();
        let mut asm = Assembler::new(engine.venue_ids(), deadline_ms);
        let me = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                let frames = tokio::select! {
                    q = published.recv() => match q {
                        Ok(q) => asm.on_quote(&q, now_ms() as f64, me.prices.reference().asset_usd("MON")),
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!("quote frames missed {n} venue answer(s)");
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                    _ = tick.tick() => asm.tick(now_ms() as f64, me.prices.reference().asset_usd("MON")).into_iter().collect(),
                };
                for f in frames {
                    me.on_frame(f);
                }
            }
        });

        let me = self.clone();
        tokio::spawn(async move {
            // The tape starts with the newest stored trades, as today's does.
            match me.read(|s| s.trades_between(0.0, f64::MAX, TAPE)).await {
                Ok(newest_first) => me.live.lock().tape = newest_first.into_iter().rev().collect(),
                Err(e) => tracing::warn!("read the tape: {e}"),
            }
            if let Err(e) = me.reload_volume().await {
                tracing::warn!("read volume: {e}");
            }
            me.ready.store(true, Ordering::Relaxed);
            loop {
                match committed.recv().await {
                    Ok(c) if !c.trades.is_empty() => {
                        me.on_trades(&c.trades);
                        if let Err(e) = me.reload_volume().await {
                            tracing::warn!("read volume: {e}");
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("the tape missed {n} committed block(s); clients reload it");
                        let _ = me.tx.send(StreamMessage::FillResync);
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });

        let me = self.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(1));
            loop {
                every.tick().await;
                me.refresh_state();
                let hello = StreamState::hello(&me.live.lock().state);
                let _ = me.tx.send(StreamMessage::State(Box::new(hello)));
            }
        });
    }

    fn on_frame(&self, f: QuoteSnapshot) {
        let now = now_ms() as f64;
        {
            let mut live = self.live.lock();
            live.history.record(&f, now);
            if f.frame.as_ref().is_some_and(|t| t.missing_venues.is_empty()) {
                live.full = Some(f.clone());
            }
            live.quotes = f.clone();
        }
        let _ = self.tx.send(StreamMessage::Quotes(Box::new(f)));
    }

    fn on_trades(&self, trades: &[Fill]) {
        {
            let mut live = self.live.lock();
            for f in trades {
                live.tape.push_back(f.clone());
            }
            while live.tape.len() > TAPE {
                live.tape.pop_front();
            }
        }
        for f in trades {
            let _ = self.tx.send(StreamMessage::Fill(Box::new(f.clone())));
        }
    }

    /// Markouts aged for trades on the tape: the tape row is updated and sent
    /// again (clients upsert by id).
    pub fn on_markouts(&self, updates: &[(String, Vec<Option<f64>>)]) {
        let mut changed = Vec::new();
        {
            let mut live = self.live.lock();
            for (id, mk) in updates {
                if let Some(f) = live.tape.iter_mut().rev().find(|f| &f.id == id) {
                    f.markouts_bps = mk.clone();
                    changed.push(f.clone());
                }
            }
        }
        for f in changed {
            let _ = self.tx.send(StreamMessage::Fill(Box::new(f)));
        }
    }

    async fn reload_volume(&self) -> Result<(), SourceError> {
        let today = utc_day(now_ms() as f64);
        let t = today.clone();
        let days = self.read(move |s| s.volume_days(&t)).await?;
        let today_row = days.iter().find(|d| d.utc_day == today).cloned();
        self.live.lock().volume = days;
        if let Some(d) = today_row {
            let _ = self.tx.send(StreamMessage::Volume(Box::new(d)));
        }
        Ok(())
    }

    /// One store read on a blocking thread, on its own read-only connection.
    async fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Store) -> mpamm_store::Result<T> + Send + 'static,
    ) -> Result<T, SourceError> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || -> Result<T, SourceError> {
            let s = Store::open_readonly(&db)?;
            Ok(f(&s)?)
        })
        .await?
    }

    fn cached<T>(cache: &Cached<T>, days: u32, ttl: Duration) -> Option<Arc<T>> {
        cache.lock().get(&days).filter(|(at, _)| at.elapsed() < ttl).map(|(_, v)| v.clone())
    }
}

/// The committed tip against the newest proposal, in chain time (blocks ×
/// the block time), as today's `tailStatusOf`.
fn tail_status(cursor: u64, newest: u64, last_commit_ms: u64, now: u64) -> TailStatus {
    let lag_blocks = newest.saturating_sub(cursor);
    let lag_ms = lag_blocks as f64 * QUOTE_CADENCE_MS;
    TailStatus {
        block: cursor,
        lag_blocks,
        lag_ms,
        held: lag_ms > TAIL_LAG_SHOWN_MS && now.saturating_sub(last_commit_ms) > TAIL_HELD_MS,
    }
}

#[async_trait]
impl ApiSource for ServiceSource {
    /// With the notes window: REST only (the stream's hello and ticks are
    /// built without it).
    fn state(&self) -> MarketState {
        MarketState { notes: Some(self.notes.list()), ..self.live.lock().state.clone() }
    }

    fn ready(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }

    fn quotes(&self) -> QuoteSnapshot {
        self.live.lock().quotes.clone()
    }

    async fn full_quotes(&self) -> Result<QuoteSnapshot, SourceError> {
        self.live.lock().full.clone().ok_or_else(|| "no complete quote frame yet".into())
    }

    fn quote_history(&self, market: &str, size_usd: f64) -> Vec<QuoteSnapshot> {
        self.live.lock().history.history(market, size_usd, now_ms() as f64)
    }

    fn quote_stats(&self, market: &str, size_usd: f64) -> QuoteStatsResponse {
        self.live.lock().history.stats(market, size_usd, now_ms() as f64)
    }

    fn recent_fills(&self) -> Vec<Fill> {
        self.live.lock().tape.iter().rev().cloned().collect()
    }

    async fn fills(&self, since_ms: Option<f64>, limit: usize) -> Result<Vec<Fill>, SourceError> {
        self.read(move |s| s.trades_between(since_ms.unwrap_or(0.0), f64::MAX, limit)).await
    }

    fn volume(&self) -> Vec<DailyVolume> {
        self.live.lock().volume.clone()
    }

    async fn gas(&self) -> Result<GasResponse, SourceError> {
        let today = utc_day(now_ms() as f64);
        let (days, not_exact) = self.read(move |s| s.gas_days(&today)).await?;
        let mut approx: Vec<String> = not_exact.into_iter().map(|(_, venue, _)| venue).collect();
        approx.sort();
        approx.dedup();
        Ok(GasResponse { days, approx })
    }

    async fn leaderboard(&self, days: u32) -> Result<LeaderboardResponse, SourceError> {
        if let Some(v) = Self::cached(&self.leaderboards, days, LEADERBOARD_TTL) {
            return Ok((*v).clone());
        }
        let now = now_ms() as f64;
        let since = now - f64::from(days) * 86_400_000.0;
        let out = self
            .read(move |s| {
                // Today's order (time, then id: it breaks volume ties), and
                // without approximate prices.
                let mut fills = s.trades_between(since, f64::MAX, usize::MAX >> 1)?;
                fills.reverse();
                let rows: Vec<mpamm_analytics::LbRow> =
                    fills.iter().filter(|f| !f.px_approx).map(mpamm_analytics::LbRow::from).collect();
                let by_id: HashMap<&str, &Fill> = fills.iter().map(|f| (f.id.as_str(), f)).collect();
                Ok(mpamm_analytics::compute_leaderboard(&rows, days, now, |ids| {
                    ids.iter().filter_map(|id| by_id.get(id.as_str()).map(|f| (*f).clone())).collect()
                }))
            })
            .await?;
        self.leaderboards.lock().insert(days, (Instant::now(), Arc::new(out.clone())));
        Ok(out)
    }

    async fn markout_curves(&self, days: u32) -> Result<MarkoutCurvesResponse, SourceError> {
        if let Some(v) = Self::cached(&self.curves, days, CURVES_TTL) {
            return Ok((*v).clone());
        }
        let now = now_ms() as f64;
        let since = now - f64::from(days) * 86_400_000.0;
        let out = self
            .read(move |s| {
                let rows: Vec<mpamm_analytics::CurveRow> = s
                    .trades_with_curves(since, f64::MAX)?
                    .into_iter()
                    .map(|(f, c)| mpamm_analytics::CurveRow::from_fill(&f, c))
                    .collect();
                Ok(mpamm_analytics::compute_markout_curves(&rows, days, now))
            })
            .await?;
        self.curves.lock().insert(days, (Instant::now(), Arc::new(out.clone())));
        Ok(out)
    }

    fn depth(&self, market: &str) -> Option<Arc<str>> {
        self.depth.latest(market)
    }

    fn watch_depth(&self, market: &str) -> watch::Receiver<Option<Arc<str>>> {
        self.depth.watch(market)
    }

    fn messages(&self) -> broadcast::Receiver<StreamMessage> {
        self.tx.subscribe()
    }

    fn health(&self) -> serde_json::Value {
        serde_json::to_value(crate::health::body(&self.health).0).expect("health serializes")
    }

    fn healthy(&self) -> bool {
        crate::health::body(&self.health).1
    }
}
