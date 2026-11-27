//! Weak ETags on every buffered response, as Express's `res.send` sets them,
//! and `304 Not Modified` for a matching `If-None-Match` on a 2xx: a client
//! re-polling an unchanged body (gas, volume) gets headers only. Computed on
//! the uncompressed body, so one tag covers every encoding (weak comparison).
//! Streams (SSE) and responses that set their own tag are left alone.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

pub(crate) fn weak_tag(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    format!("W/\"{:x}-{}\"", body.len(), &hex::encode(digest)[..27])
}

/// Express's `fresh`: `If-None-Match` names the tag (or `*`) and the request
/// doesn't ask to bypass caches.
pub(crate) fn fresh(if_none_match: Option<&str>, no_cache: bool, tag: &str) -> bool {
    let Some(inm) = if_none_match else { return false };
    if no_cache {
        return false;
    }
    let strip = |t: &str| t.trim().trim_start_matches("W/").to_string();
    inm.trim() == "*" || inm.split(',').any(|t| strip(t) == strip(tag))
}

pub(crate) async fn layer(req: Request, next: Next) -> Response {
    let cacheable = matches!(*req.method(), Method::GET | Method::HEAD);
    let inm = req.headers().get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).map(str::to_string);
    let no_cache = req
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("no-cache"));
    let res = next.run(req).await;
    let streaming = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    if !cacheable || streaming || res.headers().contains_key(header::ETAG) {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let tag = weak_tag(&bytes);
    if let Ok(v) = HeaderValue::from_str(&tag) {
        parts.headers.insert(header::ETAG, v);
    }
    if parts.status.is_success() && fresh(inm.as_deref(), no_cache, &tag) {
        parts.status = StatusCode::NOT_MODIFIED;
        for h in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::TRANSFER_ENCODING] {
            parts.headers.remove(h);
        }
        return Response::from_parts(parts, Body::empty());
    }
    Response::from_parts(parts, Body::from(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freshness_matches_express() {
        let tag = weak_tag(b"{}");
        assert!(tag.starts_with("W/\"2-") && tag.ends_with('"'));
        assert!(fresh(Some(&tag), false, &tag));
        assert!(fresh(Some(&format!("\"x\", {}", tag.trim_start_matches("W/"))), false, &tag), "weak comparison");
        assert!(fresh(Some("*"), false, &tag));
        assert!(!fresh(Some(&tag), true, &tag), "Cache-Control: no-cache bypasses");
        assert!(!fresh(Some("W/\"other\""), false, &tag));
        assert!(!fresh(None, false, &tag));
    }
}
