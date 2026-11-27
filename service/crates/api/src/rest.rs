//! The REST routes of today's server, with their query parameters, status
//! codes, cache headers and JSON. Bodies are `application/json;
//! charset=utf-8` as Express writes them.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use mpamm_registry::Registry;
use mpamm_types::{MarketsResponse, QuoteSnapshot, LEADERBOARD_WINDOW_DAYS};
use serde::Serialize;
use serde_json::json;
use tower_http::compression::predicate::{NotForContentType, Predicate, SizeAbove};
use tower_http::compression::{CompressionLayer, CompressionLevel};
use tower_http::cors::{AllowHeaders, Any, CorsLayer, Vary};

use crate::gateway::{pump, Gateway};
use crate::publications::Publications;
use crate::query::Query;
use crate::topics::STREAM_PATH;
use crate::{etag, sse, ws, ApiConfig, ApiSource};

/// Responses below this many bytes go uncompressed (Express's default).
const COMPRESS_THRESHOLD: u16 = 1024;
/// Brotli quality 4, not 11: 11 spends far more CPU per request than the
/// bytes it saves. (tower-http applies the level to gzip too.)
const COMPRESS_LEVEL: i32 = 4;
/// `/api/fills` answers at most this many fills.
const MAX_FILLS: f64 = 50_000.0;

#[derive(Clone)]
pub(crate) struct App {
    pub(crate) source: Arc<dyn ApiSource>,
    pub(crate) gateway: Gateway,
    pub(crate) config: ApiConfig,
    publications: Arc<Publications>,
}

impl App {
    fn now(&self) -> f64 {
        (self.config.clock)()
    }
}

pub(crate) fn router(source: Arc<dyn ApiSource>, config: ApiConfig) -> axum::Router {
    let gateway = Gateway::new(source.clone(), config.clock.clone());
    tokio::spawn(pump(gateway.clone(), source.messages()));
    let hsts = config.hsts;
    let app = App { source, gateway, config, publications: Arc::default() };
    let compress = SizeAbove::new(COMPRESS_THRESHOLD)
        .and(NotForContentType::GRPC)
        .and(NotForContentType::IMAGES)
        .and(NotForContentType::SSE);
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD, Method::PUT, Method::PATCH, Method::POST, Method::DELETE])
        .allow_headers(AllowHeaders::mirror_request())
        .vary(Vary::list([]));
    axum::Router::new()
        .route("/api/health", get(health))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/markets", get(markets))
        .route("/api/venues", get(venues))
        .route("/api/quotes", get(quotes))
        .route("/api/quotes/history", get(quote_history))
        .route("/api/quotes/stats", get(quote_stats))
        .route("/api/depth", get(depth))
        .route("/api/depth/stream", get(depth_stream))
        .route("/api/fills", get(fills))
        .route("/api/leaderboard/publication", get(publication))
        .route("/api/analytics/{file}", get(analytics))
        .route("/api/leaderboard", get(leaderboard))
        .route("/api/markout-curves", get(markout_curves))
        .route("/api/gas", get(gas))
        .route("/api/volume", get(volume))
        .route(STREAM_PATH, get(ws::upgrade))
        .layer(axum::middleware::from_fn(etag::layer))
        .layer(CompressionLayer::new().quality(CompressionLevel::Precise(COMPRESS_LEVEL)).compress_when(compress))
        .layer(axum::middleware::from_fn(move |req: Request, next: Next| hsts_layer(hsts, req, next)))
        .layer(cors)
        .with_state(app)
}

/// HSTS in production only: once a browser has seen it over HTTPS it forces
/// HTTPS for a year, subdomains included. No `preload`: that is a separate,
/// hard-to-reverse opt-in.
async fn hsts_layer(enabled: bool, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if enabled {
        res.headers_mut()
            .insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=31536000; includeSubDomains"));
    }
    res
}

fn json_bytes(status: StatusCode, body: Vec<u8>) -> Response {
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = status;
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    res
}

fn json_response<T: Serialize + ?Sized>(status: StatusCode, body: &T) -> Response {
    match serde_json::to_vec(body) {
        Ok(bytes) => json_bytes(status, bytes),
        Err(e) => {
            tracing::error!("response did not serialize: {e}");
            json_bytes(StatusCode::INTERNAL_SERVER_ERROR, br#"{"error":"serialization failed"}"#.to_vec())
        }
    }
}

fn ok<T: Serialize + ?Sized>(body: &T) -> Response {
    json_response(StatusCode::OK, body)
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_response(status, &json!({ "error": msg }))
}

fn with_header(mut res: Response, name: header::HeaderName, value: &'static str) -> Response {
    res.headers_mut().insert(name, HeaderValue::from_static(value));
    res
}

/// 503 with `Retry-After: 1` while persisted history is not available.
fn warming() -> Response {
    with_header(error(StatusCode::SERVICE_UNAVAILABLE, "history warming"), header::RETRY_AFTER, "1")
}

fn registered_market(q: &Query) -> Option<String> {
    q.first("market").filter(|m| Registry::get().pair_of(m).is_some()).map(str::to_string)
}

/// `?days=` as a leaderboard window (default 1), or `None` when invalid.
fn window(q: &Query) -> Option<u32> {
    let days = q.positive("days").unwrap_or(1.0);
    LEADERBOARD_WINDOW_DAYS.iter().copied().find(|w| f64::from(*w) == days)
}

async fn health(State(app): State<App>) -> Response {
    let mut body = app.source.health();
    if let Some(m) = body.as_object_mut() {
        let mut stream = serde_json::to_value(app.gateway.metrics()).expect("serializes");
        stream.as_object_mut().expect("an object").insert("protocol".into(), json!("v2"));
        m.insert("stream".into(), stream);
    }
    ok(&body)
}

async fn bootstrap(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    if !app.source.ready() {
        return warming();
    }
    let q = Query::parse(raw.as_deref());
    let mut state = app.source.state();
    state.notes = None;
    let quotes = QuoteSnapshot {
        block_hash: None,
        revision: None,
        block: state.block,
        mon_usd: state.mon_usd,
        ts: app.now(),
        rows: vec![],
        frame: None,
    };
    let volume = if q.single("volume") == Some("1") { app.source.volume() } else { vec![] };
    let body = MarketsResponse { state, quotes, fills: vec![], volume };
    with_header(ok(&body), header::CACHE_CONTROL, "no-store")
}

async fn markets(State(app): State<App>) -> Response {
    let Ok(quotes) = app.source.full_quotes().await else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "quote snapshot unavailable");
    };
    let body = MarketsResponse {
        state: app.source.state(),
        quotes,
        fills: app.source.recent_fills(),
        volume: app.source.volume(),
    };
    ok(&body)
}

/// The venue registry, for external consumers (the app reads it from state).
async fn venues(State(app): State<App>) -> Response {
    ok(&app.source.venues())
}

async fn quotes(State(app): State<App>) -> Response {
    match app.source.full_quotes().await {
        Ok(quotes) => ok(&quotes),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "quote snapshot unavailable"),
    }
}

/// The last ~60 s of quote frames for one market and size: seeds the
/// Execution chart so it never fabricates flat history.
async fn quote_history(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let market = q.single("market").unwrap_or_default();
    let size = q.positive("size");
    let Some(size) = size.filter(|_| !market.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "market and size query params required");
    };
    ok(&app.source.quote_history(market, size))
}

async fn quote_stats(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let market = registered_market(&q);
    let size = q.positive("size").filter(|s| Registry::get().sizes_usd.contains(s));
    let (Some(market), Some(size)) = (market, size) else {
        return error(StatusCode::BAD_REQUEST, "registered market and size required");
    };
    with_header(ok(&app.source.quote_stats(&market, size)), header::CACHE_CONTROL, "no-store")
}

/// A cache read only: depth is computed elsewhere, never on a request.
async fn depth(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let Some(market) = registered_market(&Query::parse(raw.as_deref())) else {
        return error(StatusCode::BAD_REQUEST, "market must be registered");
    };
    let Some(json) = app.source.depth(&market) else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "depth warming");
    };
    with_header(json_bytes(StatusCode::OK, json.as_bytes().to_vec()), header::CACHE_CONTROL, "no-store")
}

async fn depth_stream(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let Some(market) = registered_market(&Query::parse(raw.as_deref())) else {
        return error(StatusCode::BAD_REQUEST, "market must be registered");
    };
    sse::response(app.source.watch_depth(&market), app.config.depth_keepalive)
}

/// `?days=N` → the last N days; `?limit=` caps the count (default 1,000,
/// at most 50,000).
async fn fills(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    if !app.source.ready() {
        return warming();
    }
    let q = Query::parse(raw.as_deref());
    let since_ms = q.positive("days").map(|days| app.now() - days * 86_400_000.0);
    let limit = q.positive("limit").unwrap_or(1000.0).floor().min(MAX_FILLS) as usize;
    match app.source.fills(since_ms, limit).await {
        Ok(fills) => ok(&fills),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "fills unavailable"),
    }
}

/// The current leaderboard artifact of a window, by URL: the artifact itself
/// is immutable and cacheable anywhere, and this small manifest is what
/// changes.
async fn publication(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let Some(days) = window(&Query::parse(raw.as_deref())) else {
        return error(StatusCode::BAD_REQUEST, "invalid window");
    };
    if !app.source.ready() {
        return warming();
    }
    let artifact = match app.source.leaderboard(days).await {
        Ok(result) => app.publications.publish(result).await,
        Err(e) => Err(e),
    };
    match artifact {
        Ok(a) => with_header(
            ok(&json!({ "url": format!("/api/analytics/{}.json", a.revision), "generatedAt": a.generated_at })),
            header::CACHE_CONTROL,
            "public, max-age=0, s-maxage=5, must-revalidate",
        ),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "aggregation unavailable"),
    }
}

/// gzip when the client accepts it (or names no encoding at all, as
/// Express's negotiation reads a missing header).
fn accepts_gzip(headers: &HeaderMap) -> bool {
    let Some(accept) = headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()) else { return true };
    let mut gzip = None;
    let mut star = None;
    for part in accept.split(',') {
        let mut fields = part.split(';');
        let coding = fields.next().unwrap_or("").trim().to_ascii_lowercase();
        let q = fields
            .filter_map(|f| f.trim().strip_prefix("q=").or_else(|| f.trim().strip_prefix("Q=")))
            .find_map(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(1.0);
        match coding.as_str() {
            "gzip" | "x-gzip" => gzip = Some(q),
            "*" => star = Some(q),
            _ => {}
        }
    }
    gzip.or(star).is_some_and(|q| q > 0.0)
}

async fn analytics(State(app): State<App>, Path(file): Path<String>, headers: HeaderMap) -> Response {
    let artifact = file
        .strip_suffix(".json")
        .filter(|r| r.len() == 64 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .and_then(|r| app.publications.get(r));
    let Some(artifact) = artifact else {
        return with_header(
            error(StatusCode::NOT_FOUND, "revision expired; refresh publication"),
            header::CACHE_CONTROL,
            "no-store",
        );
    };
    let tag = format!("W/\"{}\"", artifact.revision);
    let mut res = if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(tag.as_str()) {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        res
    } else if accepts_gzip(&headers) {
        let mut res = json_bytes(StatusCode::OK, artifact.gzip.to_vec());
        res.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        res
    } else {
        json_bytes(StatusCode::OK, artifact.json.to_vec())
    };
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    h.insert(header::ETAG, HeaderValue::from_str(&tag).expect("hex is a valid header"));
    h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    res
}

async fn leaderboard(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let Some(days) = window(&Query::parse(raw.as_deref())) else {
        return error(StatusCode::BAD_REQUEST, &days_error());
    };
    if !app.source.ready() {
        return warming();
    }
    match app.source.leaderboard(days).await {
        Ok(result) => ok(&result),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "aggregation failed"),
    }
}

fn days_error() -> String {
    let windows: Vec<String> = LEADERBOARD_WINDOW_DAYS.iter().map(u32::to_string).collect();
    format!("days must be one of {}", windows.join(", "))
}

/// Markout curves (−5 s → +15 s) per venue/flow/route/category cell.
async fn markout_curves(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let Some(days) = window(&Query::parse(raw.as_deref())) else {
        return error(StatusCode::BAD_REQUEST, &days_error());
    };
    if !app.source.ready() {
        return warming();
    }
    match app.source.markout_curves(days).await {
        Ok(result) => {
            with_header(ok(&result), header::CACHE_CONTROL, "public, max-age=0, s-maxage=30, must-revalidate")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "aggregation failed"),
    }
}

async fn gas(State(app): State<App>) -> Response {
    match app.source.gas().await {
        Ok(series) => ok(&series),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "gas unavailable"),
    }
}

/// `?from=&to=` (YYYY-MM-DD, compared as strings). `?scope` is accepted and
/// ignored: both Clober scope columns ride every row.
async fn volume(State(app): State<App>, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let (from, to) = (q.single("from"), q.single("to"));
    let days: Vec<_> = app
        .source
        .volume()
        .into_iter()
        .filter(|d| from.is_none_or(|f| d.utc_day.as_str() >= f) && to.is_none_or(|t| d.utc_day.as_str() <= t))
        .collect();
    ok(&days)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_negotiation_matches_express() {
        let h = |v: Option<&str>| {
            let mut m = HeaderMap::new();
            if let Some(v) = v {
                m.insert(header::ACCEPT_ENCODING, HeaderValue::from_str(v).unwrap());
            }
            accepts_gzip(&m)
        };
        assert!(h(None));
        assert!(h(Some("gzip, deflate, br")));
        assert!(h(Some("*")));
        assert!(!h(Some("gzip;q=0, identity")));
        assert!(!h(Some("br")));
        assert!(!h(Some("identity")));
        assert_eq!(days_error(), "days must be one of 1, 7, 30");
    }
}
