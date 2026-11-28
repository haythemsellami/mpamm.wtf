//! Every REST route against FakeSource: status, headers and JSON as today's
//! server.ts answers them (and server/src/__tests__ asserts them).

mod common;

use std::io::Read;
use std::sync::atomic::Ordering;

use common::*;
use mpamm_api::testing::{empty_leaderboard, sample_state, FakeSource};
use mpamm_types::{
    DailyVolume, GasDay, GasResponse, QuoteStatsResponse, QuoteStatsRow, TailStatus, VenueDaily, VenueGasDaily,
};
use serde_json::{json, Value};

const JSON: &str = "application/json; charset=utf-8";

fn day(utc_day: &str, partial: bool) -> DailyVolume {
    DailyVolume {
        utc_day: utc_day.into(),
        by_venue: [("poe".to_string(), VenueDaily { usd: 10.0, swaps: 2 })].into(),
        partial,
    }
}

// ── /api/health ────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_reports_the_tail_and_the_newest_fill_beside_it() {
    let tail = TailStatus { block: 121_585_293, lag_blocks: 1_021_587, lag_ms: 306_476_100.0, held: true };
    let s = server(FakeSource::new(sample_state()));
    s.source.with(|d| {
        d.tail = Some(tail.clone());
        // the tape is not ordered by time: the newest is found, not assumed last
        d.fills = vec![fill("a", 1_794_481_000_000.0), fill("b", 1_794_481_517_000.0), fill("c", 1_794_480_000_000.0)];
    });
    let (status, body) = get_json(&s.router, "/api/health").await;
    assert_eq!(status, 200);
    assert_eq!(
        body["tail"],
        json!({ "block": 121_585_293, "lagBlocks": 1_021_587, "lagMs": 306_476_100.0, "held": true, "lastFillTs": 1_794_481_517_000.0 })
    );
    assert_eq!(body["ok"], true, "a held tail is reported, never failed: this is the deploy healthcheck");
}

#[tokio::test]
async fn health_answers_503_while_the_source_needs_a_human() {
    let s = server(FakeSource::new(sample_state()));
    s.source.with(|d| d.unhealthy = true);
    let (status, body) = get_json(&s.router, "/api/health").await;
    assert_eq!(status, 503, "a deploy's health gate fails on it");
    assert_eq!(body["source"], "sim", "the body still says why");
    s.source.with(|d| d.unhealthy = false);
    assert_eq!(get_json(&s.router, "/api/health").await.0, 200);
}

#[tokio::test]
async fn health_omits_the_newest_fill_and_the_tail_when_there_is_none() {
    let s = server(FakeSource::new(sample_state()));
    let (_, body) = get_json(&s.router, "/api/health").await;
    assert!(body.get("tail").is_none(), "no tail field for a source without one (sim)");
    assert!(body.get("quoteFrame").is_none(), "no quoteFrame before the first frame");
    assert!(body.get("realtime").is_none());
    assert_eq!(body["source"], "sim");
    s.source.with(|d| d.tail = Some(TailStatus { block: 100, lag_blocks: 5, lag_ms: 1500.0, held: false }));
    let (_, body) = get_json(&s.router, "/api/health").await;
    assert_eq!(body["tail"], json!({ "block": 100, "lagBlocks": 5, "lagMs": 1500.0, "held": false }));
}

#[tokio::test]
async fn health_serves_the_quote_pace_and_the_stream_counters() {
    let s = server(FakeSource::new(busy_state()));
    s.source
        .with(|d| d.quotes = QuoteSnapshot { block: 12_344, frame: Some(frame_telemetry()), ..quotes(12_344, vec![]) });
    let (_, body) = get_json(&s.router, "/api/health").await;
    assert_eq!(body["realtime"], serde_json::to_value(realtime()).unwrap());
    let mut want = serde_json::to_value(frame_telemetry()).unwrap();
    want.as_object_mut().unwrap().insert("block".into(), json!(12_344));
    assert_eq!(body["quoteFrame"], want);
    assert_eq!(
        body["stream"],
        json!({ "protocol": "v2", "connections": 0, "topics": 0, "encodes": 0, "rawBytes": 0, "encodedBytes": 0,
                "sentBytes": 0, "coalesced": 0, "slowClients": 0 })
    );
}

use mpamm_types::QuoteSnapshot;

// ── /api/bootstrap, /api/markets, /api/venues, /api/quotes ────────────────

#[tokio::test]
async fn bootstrap_waits_for_history_then_serves_state_without_notes() {
    let s = server(FakeSource::new(busy_state()));
    s.source.with(|d| {
        d.ready = false;
        d.volume = vec![day("2026-11-26", false), day("2026-11-27", true)];
    });
    let r = get(&s.router, "/api/bootstrap", &[]).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.header("retry-after"), Some("1"));
    assert_eq!(r.json(), json!({ "error": "history warming" }));

    s.source.with(|d| d.ready = true);
    let r = get(&s.router, "/api/bootstrap", &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert_eq!(r.header("content-type"), Some(JSON));
    let body = r.json();
    assert!(body["state"].get("notes").is_none(), "the notes buffer is not part of the bootstrap");
    assert_eq!(body["state"]["realtime"], serde_json::to_value(realtime()).unwrap());
    assert_eq!(body["state"]["venues"].as_array().unwrap().len(), 4);
    assert_eq!(body["quotes"], json!({ "block": 12_345, "monUsd": 0.024, "ts": NOW as f64, "rows": [] }));
    assert_eq!((body["fills"].clone(), body["volume"].clone()), (json!([]), json!([])));

    let (_, body) = get_json(&s.router, "/api/bootstrap?volume=1").await;
    assert_eq!(body["volume"].as_array().unwrap().len(), 2);
    let (_, body) = get_json(&s.router, "/api/bootstrap?volume=true").await;
    assert_eq!(body["volume"], json!([]));
}

#[tokio::test]
async fn markets_serves_the_full_snapshot_notes_and_frame_included() {
    let s = server(FakeSource::new(busy_state()));
    s.source.with(|d| {
        d.quotes =
            QuoteSnapshot { frame: Some(frame_telemetry()), ..quotes(12_345, vec![row("poe", "MON/USDC", 1000.0)]) };
        d.fills = vec![fill("a", 1.0)];
        d.volume = vec![day("2026-11-27", true)];
    });
    let (status, body) = get_json(&s.router, "/api/markets").await;
    assert_eq!(status, 200);
    assert_eq!(body["state"]["notes"].as_array().unwrap().len(), 60, "REST keeps the maintainer notes");
    assert!(body["quotes"].get("frame").is_some(), "REST keeps the frame telemetry");
    assert_eq!(body["quotes"]["rows"][0]["venueId"], "poe");
    assert_eq!(body["fills"][0]["id"], "a");
    assert_eq!(body["volume"][0]["utcDay"], "2026-11-27");

    s.source.with(|d| d.full_quotes_unavailable = true);
    for path in ["/api/markets", "/api/quotes"] {
        let (status, body) = get_json(&s.router, path).await;
        assert_eq!(
            (status, body),
            (axum::http::StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "quote snapshot unavailable" }))
        );
    }
}

#[tokio::test]
async fn venues_and_quotes() {
    let s = server(FakeSource::new(sample_state()));
    let (status, body) = get_json(&s.router, "/api/venues").await;
    assert_eq!(status, 200);
    assert_eq!(
        body[3],
        json!({ "id": "bybit", "name": "Bybit", "color": { "light": "#111111", "dark": "#eeeeee" }, "kind": "cex", "role": "reference", "taker": true })
    );
    s.source.with(|d| d.quotes = QuoteSnapshot { frame: Some(frame_telemetry()), ..quotes(7, vec![]) });
    let (status, body) = get_json(&s.router, "/api/quotes").await;
    assert_eq!(status, 200);
    assert_eq!(body["block"], 7);
    assert_eq!(body["frame"]["durationMs"], 18.0);
}

#[tokio::test]
async fn quote_history_needs_a_market_and_a_size() {
    let s = server(FakeSource::new(sample_state()));
    s.source.with(|d| {
        d.history =
            vec![quotes(1, vec![row("poe", "MON/USDC", 1000.0), row("poe", "BTC/USDC", 1000.0)]), quotes(2, vec![])];
    });
    for q in [
        "",
        "?market=MON%2FUSDC",
        "?size=1000",
        "?market=&size=1000",
        "?market=MON%2FUSDC&size=0",
        "?market=a&market=b&size=1000",
    ] {
        let (status, body) = get_json(&s.router, &format!("/api/quotes/history{q}")).await;
        assert_eq!(status, 400, "{q}");
        assert_eq!(body, json!({ "error": "market and size query params required" }));
    }
    let (status, body) = get_json(&s.router, "/api/quotes/history?market=MON%2FUSDC&size=1000").await;
    assert_eq!(status, 200);
    assert_eq!(body.as_array().unwrap().iter().map(|q| q["block"].as_u64().unwrap()).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(body[0]["rows"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn quote_stats_validates_the_selection() {
    let s = server(FakeSource::new(sample_state()));
    for q in [
        "",
        "?market=unknown&size=1000",
        "?market=MON%2FUSDC&size=0",
        "?market=MON%2FUSDC&size=123",
        "?market=MON%2FUSDC&size=NaN",
    ] {
        let (status, body) = get_json(&s.router, &format!("/api/quotes/stats{q}")).await;
        assert_eq!(status, 400, "{q}");
        assert_eq!(body, json!({ "error": "registered market and size required" }));
    }
    let r = get(&s.router, "/api/quotes/stats?market=MON%2FUSDC&size=1000", &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), Some("no-store"));
    let body = r.json();
    assert_eq!((body["rows"].clone(), body["windowMs"].clone()), (json!([]), json!(300_000.0)));
    let stats = QuoteStatsResponse {
        market: "MON/USDC".into(),
        size_usd: 1000.0,
        as_of: 5.0,
        window_ms: 300_000.0,
        revision: 0,
        rows: vec![QuoteStatsRow {
            venue_id: "poe".into(),
            p5: 1.0,
            p25: 2.0,
            p50: 3.0,
            p75: 4.0,
            p95: 5.0,
            avg: 3.0,
            sd: 1.0,
            n: 5,
        }],
    };
    s.source.with(|d| d.stats = Some(stats));
    let (_, body) = get_json(&s.router, "/api/quotes/stats?market=MON%2FUSDC&size=1000").await;
    assert_eq!(
        body["rows"][0],
        json!({ "venueId": "poe", "p5": 1.0, "p25": 2.0, "p50": 3.0, "p75": 4.0, "p95": 5.0, "avg": 3.0, "sd": 1.0, "n": 5 })
    );
    // the size passes as a number however the query spells it
    let (status, _) = get_json(&s.router, "/api/quotes/stats?market=MON%2FUSDC&size=1e3").await;
    assert_eq!(status, 200);
}

// ── depth ──────────────────────────────────────────────────────────────────

const DEPTH: &str = r#"{"market":"MON/USDC","asOfBlock":7,"refMid":0.024,"ts":100,"venues":[]}"#;

#[tokio::test]
async fn depth_is_a_cache_read() {
    let s = server(FakeSource::new(sample_state()));
    let (status, body) = get_json(&s.router, "/api/depth?market=DOGE%2FUSDC").await;
    assert_eq!((status.as_u16(), body), (400, json!({ "error": "market must be registered" })));
    let (status, body) = get_json(&s.router, "/api/depth?market=MON%2FUSDC").await;
    assert_eq!((status.as_u16(), body), (503, json!({ "error": "depth warming" })));
    s.source.publish_depth("MON/USDC", DEPTH);
    let r = get(&s.router, "/api/depth?market=MON%2FUSDC", &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert_eq!(r.header("content-type"), Some(JSON));
    assert_eq!(&r.body[..], DEPTH.as_bytes(), "the publication's own bytes");
}

#[tokio::test]
async fn depth_stream_replays_the_last_curve_then_streams_and_releases_demand() {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let s = server(FakeSource::new(sample_state()));
    let (status, _) = get_json(&s.router, "/api/depth/stream?market=nope").await;
    assert_eq!(status, 400);
    s.source.publish_depth("MON/USDC", DEPTH);
    let req = axum::http::Request::get("/api/depth/stream?market=MON%2FUSDC")
        .header("accept-encoding", "br, gzip")
        .body(axum::body::Body::empty())
        .unwrap();
    let res = s.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let h = res.headers();
    assert_eq!(h["content-type"], "text/event-stream");
    assert_eq!(h["cache-control"], "no-cache, no-transform");
    assert_eq!(h["x-accel-buffering"], "no");
    assert!(h.get("content-encoding").is_none(), "a compressor would buffer the events");
    assert_eq!(s.source.depth_watchers("MON/USDC"), 1, "the viewer is demand");
    let mut body = res.into_body();
    let mut text = String::new();
    let mut next =
        async || String::from_utf8(body.frame().await.unwrap().unwrap().into_data().unwrap().to_vec()).unwrap();
    while !text.contains("data: ") {
        text += &next().await;
    }
    assert_eq!(text, format!("retry: 1000\n\ndata: {DEPTH}\n\n"));
    let newer = DEPTH.replace("\"asOfBlock\":7", "\"asOfBlock\":8");
    s.source.publish_depth("MON/USDC", newer.as_str());
    assert_eq!(next().await, format!("data: {newer}\n\n"));
    drop(body);
    assert_eq!(s.source.depth_watchers("MON/USDC"), 0, "a closed viewer releases the market");
}

#[tokio::test]
async fn depth_stream_keeps_an_idle_connection_alive() {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let s = server_with(FakeSource::new(sample_state()), |c| c.depth_keepalive = std::time::Duration::from_millis(30));
    let req = axum::http::Request::get("/api/depth/stream?market=MON%2FUSDC").body(axum::body::Body::empty()).unwrap();
    let mut body = s.router.clone().oneshot(req).await.unwrap().into_body();
    let mut chunks = vec![];
    for _ in 0..2 {
        chunks.push(String::from_utf8(body.frame().await.unwrap().unwrap().into_data().unwrap().to_vec()).unwrap());
    }
    assert_eq!(
        chunks,
        ["retry: 1000\n\n", ": keepalive\n\n"],
        "no curve yet: nothing but the retry hint and keep-alives"
    );
}

// ── fills ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn fills_window_and_cap() {
    let s = server(FakeSource::new(sample_state()));
    s.source.with(|d| d.ready = false);
    let r = get(&s.router, "/api/fills?days=1", &[]).await;
    assert_eq!((r.status.as_u16(), r.header("retry-after")), (503, Some("1")));
    s.source.with(|d| {
        d.ready = true;
        d.fills = vec![fill("old", NOW as f64 - 2.0 * 86_400_000.0), fill("new", NOW as f64 - 1000.0)];
    });
    let (status, body) = get_json(&s.router, "/api/fills?days=1&limit=10").await;
    assert_eq!(status, 200);
    assert_eq!(body.as_array().unwrap().iter().map(|f| f["id"].clone()).collect::<Vec<_>>(), [json!("new")]);
    assert_eq!(*s.source.calls.last_fills.lock(), Some((Some(NOW as f64 - 86_400_000.0), 10)));
    get(&s.router, "/api/fills", &[]).await;
    assert_eq!(*s.source.calls.last_fills.lock(), Some((None, 1000)), "no window, the default count");
    get(&s.router, "/api/fills?limit=1e9&days=junk", &[]).await;
    assert_eq!(*s.source.calls.last_fills.lock(), Some((None, 50_000)), "capped; a bad window is no window");
    get(&s.router, "/api/fills?limit=7.9", &[]).await;
    assert_eq!(s.source.calls.last_fills.lock().unwrap().1, 7);
    s.source.with(|d| d.fail = true);
    let (status, body) = get_json(&s.router, "/api/fills").await;
    assert_eq!((status.as_u16(), body), (500, json!({ "error": "fills unavailable" })));
}

// ── leaderboard, publication, analytics, curves ───────────────────────────

#[tokio::test]
async fn leaderboard_windows() {
    let s = server(FakeSource::new(sample_state()));
    for q in ["?days=2", "?days=1.5", "?days=31", "?days=7&days=abc"] {
        let (status, body) = get_json(&s.router, &format!("/api/leaderboard{q}")).await;
        if q == "?days=7&days=abc" {
            assert_eq!(body["days"], 7, "a repeated key reads its first value");
            continue;
        }
        assert_eq!((status.as_u16(), body), (400, json!({ "error": "days must be one of 1, 7, 30" })), "{q}");
    }
    // as today, a value that is not a positive number falls back to the default window
    for q in ["?days=0", "?days=abc", "?days="] {
        let (status, body) = get_json(&s.router, &format!("/api/leaderboard{q}")).await;
        assert_eq!((status.as_u16(), body["days"].clone()), (200, json!(1)), "{q}");
    }
    let (status, body) = get_json(&s.router, "/api/leaderboard").await;
    assert_eq!(status, 200);
    assert_eq!(body, serde_json::to_value(empty_leaderboard(1, 0.0)).unwrap());
    let (_, body) = get_json(&s.router, "/api/leaderboard?days=30").await;
    assert_eq!(body["days"], 30);
    s.source.with(|d| d.fail = true);
    let (status, body) = get_json(&s.router, "/api/leaderboard?days=7").await;
    assert_eq!((status.as_u16(), body), (500, json!({ "error": "aggregation failed" })));
}

#[tokio::test]
async fn never_computes_or_publishes_aggregates_before_history_is_ready() {
    let s = server(FakeSource::new(sample_state()));
    s.source.with(|d| d.ready = false);
    for days in [1, 7, 30] {
        for path in ["/api/leaderboard", "/api/leaderboard/publication", "/api/markout-curves"] {
            let r = get(&s.router, &format!("{path}?days={days}"), &[]).await;
            assert_eq!((r.status.as_u16(), r.header("retry-after")), (503, Some("1")), "{path}");
            assert_eq!(r.json(), json!({ "error": "history warming" }));
        }
    }
    assert_eq!(s.source.calls.leaderboard.load(Ordering::Relaxed), 0);
    s.source.with(|d| {
        d.ready = true;
        for days in [1, 7, 30] {
            d.leaderboards
                .insert(days, mpamm_types::LeaderboardResponse { total_fills: 42, ..empty_leaderboard(days, 123.0) });
        }
    });
    for days in [1, 7, 30] {
        let (_, direct) = get_json(&s.router, &format!("/api/leaderboard?days={days}")).await;
        assert_eq!((direct["days"].clone(), direct["totalFills"].clone()), (json!(days), json!(42)));
        let (_, manifest) = get_json(&s.router, &format!("/api/leaderboard/publication?days={days}")).await;
        let artifact = get(&s.router, manifest["url"].as_str().unwrap(), &[("accept-encoding", "identity")]).await;
        assert_eq!(artifact.json(), direct);
    }
}

#[tokio::test]
async fn serves_immutable_compressed_aggregates_and_rejects_missing_revisions() {
    let s = server(FakeSource::new(sample_state()));
    let r = get(&s.router, "/api/leaderboard/publication?days=1", &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), Some("public, max-age=0, s-maxage=5, must-revalidate"));
    let manifest = r.json();
    let url = manifest["url"].as_str().unwrap().to_string();
    assert!(
        url.starts_with("/api/analytics/") && url.ends_with(".json") && url.len() == "/api/analytics/.json".len() + 64
    );
    assert_eq!(manifest["generatedAt"], 0.0);
    let (_, unchanged) = get_json(&s.router, "/api/leaderboard/publication?days=1").await;
    assert_eq!(unchanged, manifest, "an unchanged result keeps its URL");

    let r = get(&s.router, &url, &[("accept-encoding", "gzip, deflate")]).await;
    assert_eq!(r.status, 200);
    assert!(r.header("cache-control").unwrap().contains("immutable"));
    assert_eq!(r.header("content-encoding"), Some("gzip"));
    assert_eq!(r.header("vary"), Some("Accept-Encoding"));
    let mut text = String::new();
    flate2::read::GzDecoder::new(&r.body[..]).read_to_string(&mut text).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["days"], 1);
    let etag = r.header("etag").unwrap().to_string();
    assert_eq!(etag, format!("W/\"{}\"", &url["/api/analytics/".len()..url.len() - 5]));
    assert_eq!(get(&s.router, &url, &[("if-none-match", &etag)]).await.status, 304);
    let identity = get(&s.router, &url, &[("accept-encoding", "gzip;q=0, identity")]).await;
    assert_eq!(identity.header("content-encoding"), None);
    assert_eq!(identity.json()["days"], 1);

    let missing = get(&s.router, &format!("/api/analytics/{}.json", "0".repeat(64)), &[]).await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.header("cache-control"), Some("no-store"));
    assert_eq!(missing.json(), json!({ "error": "revision expired; refresh publication" }));
    assert_eq!(get(&s.router, "/api/analytics/NOT-A-REVISION.json", &[]).await.status, 404);

    let (status, body) = get_json(&s.router, "/api/leaderboard/publication?days=3").await;
    assert_eq!((status.as_u16(), body), (400, json!({ "error": "invalid window" })));
    s.source.with(|d| d.fail = true);
    let (status, body) = get_json(&s.router, "/api/leaderboard/publication?days=7").await;
    assert_eq!((status.as_u16(), body), (503, json!({ "error": "aggregation unavailable" })));
}

#[tokio::test]
async fn markout_curves() {
    let s = server(FakeSource::new(sample_state()));
    let r = get(&s.router, "/api/markout-curves?days=7", &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), Some("public, max-age=0, s-maxage=30, must-revalidate"));
    let body = r.json();
    assert_eq!(body["days"], 7);
    assert_eq!(body["offsetsS"], json!([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 7, 10, 15]));
    assert_eq!(
        (body["cells"].clone(), body["coverage"].clone(), body["quietMoveBps"].clone()),
        (json!([]), json!({}), json!(1.0))
    );
    let (status, body) = get_json(&s.router, "/api/markout-curves?days=5").await;
    assert_eq!((status.as_u16(), body), (400, json!({ "error": "days must be one of 1, 7, 30" })));
    s.source.with(|d| d.fail = true);
    let (status, body) = get_json(&s.router, "/api/markout-curves").await;
    assert_eq!((status.as_u16(), body), (500, json!({ "error": "aggregation failed" })));
}

// ── gas, volume ────────────────────────────────────────────────────────────

#[tokio::test]
async fn gas_series() {
    let s = server(FakeSource::new(sample_state()));
    s.source.with(|d| {
        d.gas = GasResponse {
            days: vec![GasDay {
                utc_day: "2026-11-27".into(),
                by_venue: [("poe".to_string(), VenueGasDaily { mon: 1.5, txs: 12 })].into(),
                partial: true,
            }],
            approx: vec!["poe".into()],
        }
    });
    let (status, body) = get_json(&s.router, "/api/gas").await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({ "days": [{ "utcDay": "2026-11-27", "byVenue": { "poe": { "mon": 1.5, "txs": 12 } }, "partial": true }], "approx": ["poe"] })
    );
    s.source.with(|d| d.fail = true);
    assert_eq!(get_json(&s.router, "/api/gas").await.0, 500);
}

#[tokio::test]
async fn volume_honours_from_and_to() {
    let s = server(FakeSource::new(sample_state()));
    s.source.with(|d| d.volume = ["2026-11-25", "2026-11-26", "2026-11-27"].iter().map(|u| day(u, false)).collect());
    let days = |body: Value| {
        body.as_array().unwrap().iter().map(|d| d["utcDay"].as_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    assert_eq!(days(get_json(&s.router, "/api/volume").await.1).len(), 3);
    assert_eq!(days(get_json(&s.router, "/api/volume?from=2026-11-26").await.1), ["2026-11-26", "2026-11-27"]);
    assert_eq!(days(get_json(&s.router, "/api/volume?to=2026-11-25&scope=vault").await.1), ["2026-11-25"]);
    assert_eq!(days(get_json(&s.router, "/api/volume?from=2026-11-26&to=2026-11-26").await.1), ["2026-11-26"]);
    let (_, body) = get_json(&s.router, "/api/volume?from=2026-11-27").await;
    assert_eq!(
        body[0],
        json!({ "utcDay": "2026-11-27", "byVenue": { "poe": { "usd": 10.0, "swaps": 2 } }, "partial": false })
    );
}

// ── transport: compression, ETag, CORS, HSTS ──────────────────────────────

/// Railway's edge forwards responses byte for byte: the app compresses.
#[tokio::test]
async fn serves_json_brotli_or_gzip_and_byte_identical_once_decoded() {
    let s = server(FakeSource::new(busy_state()));
    let plain = get(&s.router, "/api/markets", &[("accept-encoding", "identity")]).await;
    let br = get(&s.router, "/api/markets", &[("accept-encoding", "br, gzip")]).await;
    let gz = get(&s.router, "/api/markets", &[("accept-encoding", "gzip")]).await;
    assert_eq!(plain.header("content-encoding"), None);
    assert_eq!(br.header("content-encoding"), Some("br"));
    assert_eq!(gz.header("content-encoding"), Some("gzip"));
    assert_eq!(br.header("vary"), Some("accept-encoding"));
    let mut unbr = Vec::new();
    brotli::Decompressor::new(&br.body[..], 4096).read_to_end(&mut unbr).unwrap();
    let mut ungz = Vec::new();
    flate2::read::GzDecoder::new(&gz.body[..]).read_to_end(&mut ungz).unwrap();
    assert_eq!(unbr, plain.body);
    assert_eq!(ungz, plain.body);
    assert!(br.body.len() < plain.body.len() / 4, "the notes buffer is very repetitive");
    // below the 1 KB threshold a body goes as it is
    let small = get(&s.router, "/api/gas", &[("accept-encoding", "br, gzip")]).await;
    assert_eq!(small.header("content-encoding"), None);
}

#[tokio::test]
async fn an_unchanged_body_revalidates_to_304() {
    let s = server(FakeSource::new(sample_state()));
    let first = get(&s.router, "/api/gas", &[]).await;
    let tag = first.header("etag").unwrap().to_string();
    assert!(tag.starts_with("W/\""));
    let again = get(&s.router, "/api/gas", &[("if-none-match", &tag)]).await;
    assert_eq!(again.status, 304);
    assert!(again.body.is_empty());
    let bypass = get(&s.router, "/api/gas", &[("if-none-match", &tag), ("cache-control", "no-cache")]).await;
    assert_eq!(bypass.status, 200);
    let errors = get(&s.router, "/api/depth?market=x", &[("if-none-match", "*")]).await;
    assert_eq!(errors.status, 400, "only a success revalidates");
}

#[tokio::test]
async fn cors_is_open_and_hsts_is_production_only() {
    let s = server(FakeSource::new(sample_state()));
    let r = get(&s.router, "/api/venues", &[("origin", "https://example.org")]).await;
    assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    assert_eq!(r.header("strict-transport-security"), None);
    let s = server_with(FakeSource::new(sample_state()), |c| c.hsts = true);
    let r = get(&s.router, "/api/venues", &[]).await;
    assert_eq!(r.header("strict-transport-security"), Some("max-age=31536000; includeSubDomains"));
}
