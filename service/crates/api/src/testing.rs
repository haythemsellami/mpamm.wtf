//! An in-memory [`ApiSource`] for tests and the `fake` example: every answer
//! is data the test set, every update is pushed by hand, and it counts the
//! reads a test asserts on.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use mpamm_registry::Registry;
use mpamm_types::{
    DailyVolume, DataSourceMode, Fill, GasResponse, LeaderboardResponse, MarketState, MarkoutCurvesResponse,
    QuoteSnapshot, QuoteStatsResponse, StreamMessage, TailStatus, ThemeColor, VenueKind, VenueMeta, VenueRole,
    CURVE_OFFSETS_S, CURVE_QUIET_MOVE_BPS,
};
use parking_lot::Mutex;
use tokio::sync::{broadcast, watch};

use crate::{health_body, ApiSource, SourceError};

/// What the fake answers. Tests change it with [`FakeSource::with`].
#[derive(Clone)]
pub struct FakeData {
    pub state: MarketState,
    pub ready: bool,
    pub quotes: QuoteSnapshot,
    /// `full_quotes` fails (503) while set.
    pub full_quotes_unavailable: bool,
    /// Quote frames `quote_history` filters by market and size.
    pub history: Vec<QuoteSnapshot>,
    pub stats: Option<QuoteStatsResponse>,
    /// The recent tape, in any order.
    pub fills: Vec<Fill>,
    pub volume: Vec<DailyVolume>,
    pub gas: GasResponse,
    pub tail: Option<TailStatus>,
    /// Leaderboards by window; a window without one answers an empty board.
    pub leaderboards: HashMap<u32, LeaderboardResponse>,
    pub curves: HashMap<u32, MarkoutCurvesResponse>,
    /// The aggregations, fills and gas fail while set.
    pub fail: bool,
    /// Runs after every `quotes()` read, outside the fake's lock: lets a
    /// test land an update exactly while a quote snapshot is being taken.
    pub on_quotes: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// Reads the tests count.
#[derive(Default)]
pub struct Calls {
    pub state: AtomicUsize,
    pub venues: AtomicUsize,
    pub leaderboard: AtomicUsize,
    pub quotes: AtomicUsize,
    /// The last `fills(since_ms, limit)` query.
    pub last_fills: Mutex<Option<(Option<f64>, usize)>>,
}

pub struct FakeSource {
    data: Mutex<FakeData>,
    tx: broadcast::Sender<StreamMessage>,
    depth: Mutex<HashMap<String, watch::Sender<Option<Arc<str>>>>>,
    pub calls: Calls,
}

/// A venue registry entry.
pub fn venue(id: &str, name: &str, kind: VenueKind, role: VenueRole) -> VenueMeta {
    VenueMeta {
        id: id.into(),
        name: name.into(),
        color: ThemeColor { light: "#111111".into(), dark: "#eeeeee".into() },
        kind,
        role,
        taker: (role == VenueRole::Reference).then_some(true),
        taker_bps: None,
        since_utc: None,
        quote_note: None,
    }
}

/// A plausible state: every registered market and size, two venues, a
/// baseline and a reference.
pub fn sample_state() -> MarketState {
    let registry = Registry::get();
    MarketState {
        chain_id: registry.chain_id,
        block: 1,
        mon_usd: 0.024,
        mon_change_pct: 0.0,
        taker_bps: 1.0,
        markets: registry.markets().map(str::to_string).collect(),
        sizes_usd: registry.sizes_usd.clone(),
        quote_cadence_ms: 300.0,
        source: DataSourceMode::Sim,
        venues: vec![
            venue("poe", "LFJ POE", VenueKind::Amm, VenueRole::Venue),
            venue("clober", "Clober", VenueKind::Clob, VenueRole::Venue),
            venue("uniswap", "Uniswap", VenueKind::Amm, VenueRole::Baseline),
            venue("bybit", "Bybit", VenueKind::Cex, VenueRole::Reference),
        ],
        quote_markets: None,
        notes: None,
        rpc: None,
        rpc_archive: None,
        realtime: None,
        tail: None,
    }
}

/// An empty board of the right shape.
pub fn empty_leaderboard(days: u32, generated_at: f64) -> LeaderboardResponse {
    let groups = ["protocol", "pool", "to", "category"].iter().map(|g| (g.to_string(), BTreeMap::new())).collect();
    LeaderboardResponse { days, generated_at, total_fills: 0, groups, top_swaps: BTreeMap::new(), outliers: vec![] }
}

pub fn empty_curves(days: u32, generated_at: f64) -> MarkoutCurvesResponse {
    MarkoutCurvesResponse {
        days,
        generated_at,
        offsets_s: CURVE_OFFSETS_S.to_vec(),
        quiet_move_bps: CURVE_QUIET_MOVE_BPS,
        cells: vec![],
        coverage: BTreeMap::new(),
    }
}

impl FakeSource {
    pub fn new(state: MarketState) -> Arc<FakeSource> {
        let quotes = QuoteSnapshot {
            block_hash: None,
            revision: None,
            block: state.block,
            mon_usd: state.mon_usd,
            ts: 0.0,
            rows: vec![],
            frame: None,
        };
        let data = FakeData {
            state,
            ready: true,
            quotes,
            full_quotes_unavailable: false,
            history: vec![],
            stats: None,
            fills: vec![],
            volume: vec![],
            gas: GasResponse::default(),
            tail: None,
            leaderboards: HashMap::new(),
            curves: HashMap::new(),
            fail: false,
            on_quotes: None,
        };
        let (tx, _) = broadcast::channel(4096);
        Arc::new(FakeSource { data: Mutex::new(data), tx, depth: Mutex::new(HashMap::new()), calls: Calls::default() })
    }

    /// Change what the fake answers.
    pub fn with<R>(&self, f: impl FnOnce(&mut FakeData) -> R) -> R {
        f(&mut self.data.lock())
    }

    /// Send an update to the stream.
    pub fn push(&self, message: StreamMessage) {
        let _ = self.tx.send(message);
    }

    fn depth_sender(&self, market: &str) -> watch::Sender<Option<Arc<str>>> {
        self.depth.lock().entry(market.to_string()).or_insert_with(|| watch::channel(None).0).clone()
    }

    /// Complete a depth pass: the latest snapshot, sent to every watcher.
    pub fn publish_depth(&self, market: &str, json: impl Into<Arc<str>>) {
        self.depth_sender(market).send_replace(Some(json.into()));
    }

    /// Open depth watches of a market: the demand the source would compute for.
    pub fn depth_watchers(&self, market: &str) -> usize {
        self.depth_sender(market).receiver_count()
    }
}

fn fail() -> SourceError {
    "the fake source was told to fail".into()
}

#[async_trait]
impl ApiSource for FakeSource {
    fn state(&self) -> MarketState {
        self.calls.state.fetch_add(1, Ordering::Relaxed);
        self.data.lock().state.clone()
    }

    fn ready(&self) -> bool {
        self.data.lock().ready
    }

    fn quotes(&self) -> QuoteSnapshot {
        self.calls.quotes.fetch_add(1, Ordering::Relaxed);
        let (quotes, hook) = {
            let d = self.data.lock();
            (d.quotes.clone(), d.on_quotes.clone())
        };
        if let Some(hook) = hook {
            hook();
        }
        quotes
    }

    async fn full_quotes(&self) -> Result<QuoteSnapshot, SourceError> {
        let d = self.data.lock();
        if d.full_quotes_unavailable {
            return Err("no complete frame".into());
        }
        Ok(d.quotes.clone())
    }

    fn quote_history(&self, market: &str, size_usd: f64) -> Vec<QuoteSnapshot> {
        let d = self.data.lock();
        d.history
            .iter()
            .map(|q| {
                let mut q = q.clone();
                q.rows.retain(|r| r.market == market && r.size_usd == size_usd);
                q.frame = None;
                q
            })
            .collect()
    }

    fn quote_stats(&self, market: &str, size_usd: f64) -> QuoteStatsResponse {
        let d = self.data.lock();
        d.stats.clone().filter(|s| s.market == market && s.size_usd == size_usd).unwrap_or(QuoteStatsResponse {
            market: market.into(),
            size_usd,
            as_of: d.quotes.ts,
            window_ms: 300_000.0,
            revision: d.quotes.revision.unwrap_or(0),
            rows: vec![],
        })
    }

    fn recent_fills(&self) -> Vec<Fill> {
        self.data.lock().fills.clone()
    }

    async fn fills(&self, since_ms: Option<f64>, limit: usize) -> Result<Vec<Fill>, SourceError> {
        *self.calls.last_fills.lock() = Some((since_ms, limit));
        let d = self.data.lock();
        if d.fail {
            return Err(fail());
        }
        let mut fills: Vec<Fill> = d.fills.iter().filter(|f| since_ms.is_none_or(|s| f.ts >= s)).cloned().collect();
        fills.sort_by(|a, b| b.ts.total_cmp(&a.ts));
        fills.truncate(limit);
        Ok(fills)
    }

    fn volume(&self) -> Vec<DailyVolume> {
        self.data.lock().volume.clone()
    }

    async fn gas(&self) -> Result<GasResponse, SourceError> {
        let d = self.data.lock();
        if d.fail {
            return Err(fail());
        }
        Ok(d.gas.clone())
    }

    async fn leaderboard(&self, days: u32) -> Result<LeaderboardResponse, SourceError> {
        self.calls.leaderboard.fetch_add(1, Ordering::Relaxed);
        let d = self.data.lock();
        if d.fail {
            return Err(fail());
        }
        Ok(d.leaderboards.get(&days).cloned().unwrap_or_else(|| empty_leaderboard(days, d.quotes.ts)))
    }

    async fn markout_curves(&self, days: u32) -> Result<MarkoutCurvesResponse, SourceError> {
        let d = self.data.lock();
        if d.fail {
            return Err(fail());
        }
        Ok(d.curves.get(&days).cloned().unwrap_or_else(|| empty_curves(days, d.quotes.ts)))
    }

    fn depth(&self, market: &str) -> Option<Arc<str>> {
        self.depth_sender(market).borrow().clone()
    }

    fn watch_depth(&self, market: &str) -> watch::Receiver<Option<Arc<str>>> {
        self.depth_sender(market).subscribe()
    }

    fn messages(&self) -> broadcast::Receiver<StreamMessage> {
        self.tx.subscribe()
    }

    fn health(&self) -> serde_json::Value {
        let d = self.data.lock();
        let mode = match d.state.source {
            DataSourceMode::Live => "live",
            DataSourceMode::Sim => "sim",
        };
        health_body(mode, &d.state, d.tail.as_ref(), &d.quotes, &d.fills)
    }

    fn venues(&self) -> Vec<VenueMeta> {
        self.calls.venues.fetch_add(1, Ordering::Relaxed);
        self.data.lock().state.venues.clone()
    }
}
