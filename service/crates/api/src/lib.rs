//! Today's HTTP API and `/stream` WebSocket protocol, served by axum, so the
//! web app works unchanged against the Rust service.
//!
//! - REST: every route of `server/src/server.ts`, with its paths, query
//!   parameters, status codes, headers and JSON. Responses are compressed
//!   here (brotli or gzip, 1 KB and up): the hosting edge forwards bytes as
//!   they are, so an uncompressed body is billed at full size.
//! - `/stream`: the v2 subscription protocol (`mpamm.v2.gzip`,
//!   `mpamm.v2.json`). Each topic's message is encoded once and the same bytes
//!   go to every subscriber; a slow viewer is cut rather than buffered.
//!   Maintainer telemetry (notes, quote pace, frame timings) never rides the
//!   stream, and the venue registry rides only the first state message: the
//!   stream fans out to every open tab several times a second, so every byte
//!   in a frame is multiplied by that.
//!
//! The service plugs its data in through [`ApiSource`]; [`testing::FakeSource`]
//! drives the tests and the `fake` example.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mpamm_types::{
    DailyVolume, Fill, GasResponse, LeaderboardResponse, MarketState, MarkoutCurvesResponse, QuoteSnapshot,
    QuoteStatsResponse, StreamMessage, VenueMeta,
};
use tokio::sync::{broadcast, watch};

mod etag;
mod gateway;
mod health;
mod publications;
mod query;
mod rest;
mod sse;
pub mod testing;
pub mod topics;
mod ws;

pub use gateway::StreamMetrics;
pub use health::health_body;
pub use topics::{parse_topics, StreamTopic, MAX_STREAM_TOPICS, STREAM_PATH, STREAM_V2_GZIP, STREAM_V2_JSON};

/// An error from the source; the route answers with its own status and never
/// shows the message (it may name an endpoint).
pub type SourceError = Box<dyn std::error::Error + Send + Sync>;

/// Epoch milliseconds. Injected so tests can move time (the state throttle,
/// `?days=` windows).
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// What the routes and the stream read. Modelled on today's `DataSource`:
/// the synchronous methods are in-memory reads (they run under the stream's
/// lock, so they must not block), the async ones may read the database.
#[async_trait]
pub trait ApiSource: Send + Sync + 'static {
    /// The market state REST serves, notes and quote pace included. The
    /// stream derives its own copy without them.
    fn state(&self) -> MarketState;

    /// False until persisted history is available: `/api/bootstrap`,
    /// `/api/fills`, the leaderboard and the curves answer 503 with
    /// `Retry-After: 1` until then.
    fn ready(&self) -> bool {
        true
    }

    /// The latest quote frame, possibly a deadline frame some venue missed.
    /// Quote topics take their snapshot from it.
    fn quotes(&self) -> QuoteSnapshot;

    /// A complete matrix for `/api/quotes` and `/api/markets`. An error
    /// answers 503.
    async fn full_quotes(&self) -> Result<QuoteSnapshot, SourceError> {
        Ok(self.quotes())
    }

    /// The last ~60 s of quote frames for one market and size, oldest first,
    /// each holding only that selection's rows.
    fn quote_history(&self, market: &str, size_usd: f64) -> Vec<QuoteSnapshot>;

    /// Rolling spread statistics for one registered market and size.
    fn quote_stats(&self, market: &str, size_usd: f64) -> QuoteStatsResponse;

    /// The in-memory recent tape (`/api/markets`).
    fn recent_fills(&self) -> Vec<Fill>;

    /// Stored fills, newest first: those at or after `since_ms` when given,
    /// at most `limit` (already capped at 50,000).
    async fn fills(&self, since_ms: Option<f64>, limit: usize) -> Result<Vec<Fill>, SourceError>;

    /// Daily volume, oldest first; the last day is today's partial bucket.
    fn volume(&self) -> Vec<DailyVolume>;

    /// The quote-update gas series.
    async fn gas(&self) -> Result<GasResponse, SourceError>;

    /// Leaderboard aggregates over a window of 1, 7 or 30 days.
    async fn leaderboard(&self, days: u32) -> Result<LeaderboardResponse, SourceError>;

    /// Markout curves over a window of 1, 7 or 30 days.
    async fn markout_curves(&self, days: u32) -> Result<MarkoutCurvesResponse, SourceError>;

    /// The last completed depth snapshot for a market, already serialized
    /// (a `DepthSnapshot`), so any number of viewers costs no JSON work.
    fn depth(&self, market: &str) -> Option<Arc<str>>;

    /// Depth demand. The receiver holds the latest publication and changes
    /// with every new one; it keeps only the latest, so a slow viewer never
    /// queues curves. The first watcher of a market starts its computation,
    /// and dropping the last receiver is the signal to stop it.
    fn watch_depth(&self, market: &str) -> watch::Receiver<Option<Arc<str>>>;

    /// Live updates: state, quote frames, fills and volume (and the two
    /// resyncs). The gateway reads one receiver for the life of the router.
    fn messages(&self) -> broadcast::Receiver<StreamMessage>;

    /// The body of `GET /api/health` (see [`health_body`]); the router adds
    /// `stream`, the gateway's own counters.
    fn health(&self) -> serde_json::Value;

    /// False answers `/api/health` with 503: the service needs a human
    /// (a deploy's health gate and the host's monitor read the status).
    fn healthy(&self) -> bool {
        true
    }

    /// The venue registry (`/api/venues`). Immutable for the life of the
    /// process.
    fn venues(&self) -> Vec<VenueMeta> {
        self.state().venues
    }
}

/// Settings that tests and the host change.
#[derive(Clone)]
pub struct ApiConfig {
    /// Wall clock in epoch ms.
    pub clock: Clock,
    /// Send `Strict-Transport-Security` (production behind TLS only; never
    /// for localhost).
    pub hsts: bool,
    /// A stream client is pinged this often and cut when the previous ping
    /// is still unanswered.
    pub heartbeat: Duration,
    /// Comment line on an idle depth SSE stream.
    pub depth_keepalive: Duration,
}

impl Default for ApiConfig {
    fn default() -> Self {
        ApiConfig {
            clock: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
            }),
            hsts: false,
            heartbeat: Duration::from_secs(30),
            depth_keepalive: Duration::from_secs(15),
        }
    }
}

/// Every route of today's server, `/stream` included, with the default
/// settings. Call it inside a Tokio runtime: it starts the task that feeds
/// the source's messages to the stream.
pub fn router(source: Arc<dyn ApiSource>) -> axum::Router {
    router_with(source, ApiConfig::default())
}

/// [`router`] with explicit settings.
pub fn router_with(source: Arc<dyn ApiSource>, config: ApiConfig) -> axum::Router {
    rest::router(source, config)
}
