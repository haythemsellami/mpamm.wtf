//! `GET /api/health`'s body as today's server builds it. `ok` is liveness and
//! nothing else: it is the deploy healthcheck, and failing it on a held tail
//! would block the deploy that fixes one. The tail is reported instead, with
//! the newest fill held beside it ("no fill since Tuesday" is what a monitor
//! can alert on without knowing the head). This is also the one home of the
//! quote-pace telemetry the stream doesn't carry.

use mpamm_types::{Fill, MarketState, QuoteSnapshot, TailStatus};
use serde_json::{json, Map, Value};

/// The body without `stream`, which the router adds. `tail` is absent for a
/// source without one (sim); `lastFillTs` is absent, never 0, before any
/// fill; `quoteFrame` is absent before the first frame.
pub fn health_body(
    source_mode: &str,
    state: &MarketState,
    tail: Option<&TailStatus>,
    quotes: &QuoteSnapshot,
    fills: &[Fill],
) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), json!(true));
    body.insert("source".into(), json!(source_mode));
    body.insert("block".into(), json!(state.block));
    if let Some(tail) = tail {
        let mut t = serde_json::to_value(tail).expect("serializes");
        // the tape is not ordered by time: the newest is found, not assumed last
        let newest = fills.iter().map(|f| f.ts).fold(None, |m: Option<f64>, ts| Some(m.map_or(ts, |m| m.max(ts))));
        if let (Some(ts), Some(t)) = (newest, t.as_object_mut()) {
            t.insert("lastFillTs".into(), json!(ts));
        }
        body.insert("tail".into(), t);
    }
    if let Some(realtime) = &state.realtime {
        body.insert("realtime".into(), serde_json::to_value(realtime).expect("serializes"));
    }
    if let Some(frame) = &quotes.frame {
        let mut f = Map::new();
        f.insert("block".into(), json!(quotes.block));
        if let Value::Object(fields) = serde_json::to_value(frame).expect("serializes") {
            f.extend(fields);
        }
        body.insert("quoteFrame".into(), Value::Object(f));
    }
    Value::Object(body)
}
