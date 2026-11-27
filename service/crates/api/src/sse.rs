//! `GET /api/depth/stream?market=`: one market's depth curves as server-sent
//! events. The first viewer starts the market's computation and every other
//! viewer shares it; a connecting viewer gets the last completed curve at
//! once (EventSource reconnects by itself, and the replay repaints the curve
//! rather than leaving a stale one). Never compressed: a compressor buffers,
//! which would hold the events back.
//!
//! The source's watch keeps only the latest curve, and the body is polled
//! only as fast as the client reads, so a slow viewer skips curves instead of
//! queueing them: memory stays bounded without today's 1 MB cut.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::stream::{self, StreamExt};
use tokio::sync::watch;

pub(crate) fn response(mut rx: watch::Receiver<Option<Arc<str>>>, keepalive: Duration) -> Response {
    let current = rx.borrow_and_update().clone();
    let first = stream::iter(
        std::iter::once("retry: 1000\n\n".to_string()).chain(current.map(|json| format!("data: {json}\n\n"))),
    );
    let updates = stream::unfold(rx, |mut rx| async move {
        loop {
            rx.changed().await.ok()?;
            let latest = rx.borrow_and_update().clone();
            if let Some(json) = latest {
                return Some((format!("data: {json}\n\n"), rx));
            }
        }
    });
    let start = tokio::time::Instant::now() + keepalive;
    let heartbeat = stream::unfold(tokio::time::interval_at(start, keepalive), |mut tick| async move {
        tick.tick().await;
        Some((": keepalive\n\n".to_string(), tick))
    });
    let body = Body::from_stream(first.chain(stream::select(updates, heartbeat)).map(Ok::<_, Infallible>));
    let mut res = Response::new(body);
    *res.status_mut() = StatusCode::OK;
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    res
}
