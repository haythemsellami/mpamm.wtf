//! The REST and stream payloads in today's JSON shapes (`shared/src/index.ts`):
//! market state and its health fields, quote frames, depth curves, quote
//! statistics, the gas series and the stream's messages. Optional fields are
//! left out of the JSON when absent, as today, because the web app reads a
//! field's presence (`tail`, `venues` on the hello frame) as meaning.

use indexmap::IndexMap;
use serde::de::Error as _;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{DailyVolume, Fill, GasDay, QuoteRow, VenueMeta};

/// Which data source produced the state: the chain, or the simulator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataSourceMode {
    Live,
    Sim,
}

/// How much a note matters: `warn` wants a maintainer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteLevel {
    Info,
    Warn,
}

/// One entry of `MarketState::notes`: maintainer telemetry, served by
/// `GET /api/markets` and never on the stream. `code` is `<subsystem>.<event>`
/// (today's `NoteCode`), kept open as a string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateNote {
    pub ts: f64,
    pub level: NoteLevel,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    pub msg: String,
}

/// RPC failover status of one pool. Labels only: an endpoint URL embeds a key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcStatus {
    pub active: String,
    pub degraded: bool,
    pub down: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded_since_ts: Option<f64>,
}

/// How far the fill tail is behind the chain head.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailStatus {
    pub block: u64,
    pub lag_blocks: u64,
    pub lag_ms: f64,
    pub held: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuoteHeadSource {
    Http,
    Ws,
    Sim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WsStatus {
    Disabled,
    Connecting,
    Connected,
    Fallback,
}

/// Quote-pace telemetry: `GET /api/health` only, never on the stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeHealth {
    pub head_block: u64,
    pub quote_block: u64,
    pub lag_blocks: i64,
    pub frame_ms: f64,
    pub head_to_frame_ms: f64,
    pub event_loop_lag_ms: f64,
    pub coverage_pct60s: f64,
    pub coalesced_blocks60s: u64,
    pub head_source: QuoteHeadSource,
    pub ws_status: WsStatus,
}

/// One quote frame's own lifecycle (server-clock epoch ms). REST only: the
/// stream strips it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteFrameTelemetry {
    pub head_source: QuoteHeadSource,
    pub head_observed_at: f64,
    pub quote_started_at: f64,
    pub quote_completed_at: f64,
    pub emitted_at: f64,
    pub duration_ms: f64,
    pub adapter_ms: IndexMap<String, f64>,
    pub missing_venues: Vec<String>,
    pub coalesced_blocks: u64,
}

/// The quote matrix of one block-triggered frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    /// The block's proposal time (epoch ms): what `?timing=1` measures
    /// proposal → paint from. Rounded to the ms (the stream's byte budget).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_ts: Option<f64>,
    pub block: u64,
    pub mon_usd: f64,
    /// Frame emission time: the chart's timestamp.
    pub ts: f64,
    pub rows: Vec<QuoteRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<QuoteFrameTelemetry>,
}

impl QuoteSnapshot {
    /// The snapshot as either stream carries it: without `frame`.
    pub fn without_frame(&self) -> QuoteSnapshot {
        QuoteSnapshot {
            block_hash: self.block_hash.clone(),
            revision: self.revision,
            proposal_ts: self.proposal_ts,
            block: self.block,
            mon_usd: self.mon_usd,
            ts: self.ts,
            rows: self.rows.clone(),
            frame: None,
        }
    }
}

/// Equal-weight statistics of one venue's executable spreads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteStatsRow {
    pub venue_id: String,
    pub p5: f64,
    pub p25: f64,
    pub p50: f64,
    pub p75: f64,
    pub p95: f64,
    pub avg: f64,
    pub sd: f64,
    pub n: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteStatsResponse {
    pub market: String,
    pub size_usd: f64,
    /// The window is (as_of − window_ms, as_of].
    pub as_of: f64,
    pub window_ms: f64,
    pub revision: u64,
    pub rows: Vec<QuoteStatsRow>,
}

/// A whole number as today's JSON writes it (`100`, not `100.0`): a depth
/// snapshot goes to every viewer of its market every block, and its
/// notionals and time are whole dollars and milliseconds.
fn whole<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

/// One sampled notional of a depth curve. A side is absent (not 0) where the
/// venue has no executable price.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthPoint {
    #[serde(serialize_with = "whole")]
    pub notional: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bid_bps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_bps: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthCurve {
    pub venue_id: String,
    pub points: Vec<DepthPoint>,
    #[serde(serialize_with = "whole")]
    pub max_notional: f64,
}

/// Every active venue's depth curve for one market at one block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_venues: Option<Vec<String>>,
    pub market: String,
    pub as_of_block: u64,
    pub ref_mid: f64,
    #[serde(serialize_with = "whole")]
    pub ts: f64,
    pub venues: Vec<DepthCurve>,
}

/// `GET /api/gas`: the quote-update burn per day, and the venues whose MON
/// figures are sampled estimates.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct GasResponse {
    pub days: Vec<GasDay>,
    pub approx: Vec<String>,
}

/// The market state as REST serves it (`/api/markets`, `/api/bootstrap`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketState {
    pub chain_id: u64,
    pub block: u64,
    pub mon_usd: f64,
    pub mon_change_pct: f64,
    pub taker_bps: f64,
    pub markets: Vec<String>,
    pub sizes_usd: Vec<f64>,
    pub quote_cadence_ms: f64,
    pub source: DataSourceMode,
    pub venues: Vec<VenueMeta>,
    /// Discovered markets per venue, in discovery order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_markets: Option<IndexMap<String, Vec<String>>>,
    /// Maintainer telemetry: REST only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<StateNote>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc: Option<RpcStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc_archive: Option<RpcStatus>,
    /// Quote-pace telemetry: REST only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realtime: Option<RealtimeHealth>,
    /// Present only while the fill tail trails the head.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<TailStatus>,
}

/// `MarketState` as the stream carries it. It has no field for `notes` or
/// `realtime`, so maintainer telemetry cannot reach the stream; `venues` rides
/// the hello frame only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamState {
    pub chain_id: u64,
    pub block: u64,
    pub mon_usd: f64,
    pub mon_change_pct: f64,
    pub taker_bps: f64,
    pub markets: Vec<String>,
    pub sizes_usd: Vec<f64>,
    pub quote_cadence_ms: f64,
    pub source: DataSourceMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venues: Option<Vec<VenueMeta>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_markets: Option<IndexMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc: Option<RpcStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc_archive: Option<RpcStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<TailStatus>,
}

impl StreamState {
    /// The hello frame: everything but `notes` and `realtime`.
    pub fn hello(state: &MarketState) -> StreamState {
        StreamState {
            chain_id: state.chain_id,
            block: state.block,
            mon_usd: state.mon_usd,
            mon_change_pct: state.mon_change_pct,
            taker_bps: state.taker_bps,
            markets: state.markets.clone(),
            sizes_usd: state.sizes_usd.clone(),
            quote_cadence_ms: state.quote_cadence_ms,
            source: state.source,
            venues: Some(state.venues.clone()),
            quote_markets: state.quote_markets.clone(),
            rpc: state.rpc.clone(),
            rpc_archive: state.rpc_archive.clone(),
            tail: state.tail.clone(),
        }
    }

    /// Every state frame after the hello: also without the venue registry,
    /// which cannot change for the life of the process.
    pub fn tick(mut self) -> StreamState {
        self.venues = None;
        self
    }
}

/// `GET /api/markets` (and, with empty quotes and fills, `/api/bootstrap`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarketsResponse {
    pub state: MarketState,
    pub quotes: QuoteSnapshot,
    pub fills: Vec<Fill>,
    pub volume: Vec<DailyVolume>,
}

/// One message of the source's update stream, serialized as today's
/// `{ch, data}`, or `{ch, resync: true}` for the two one-off resyncs: stored
/// fills under the tape changed, or closed days' volume changed. A resync
/// tells a client holding that snapshot to reload it from REST.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamMessage {
    State(Box<StreamState>),
    Quotes(Box<QuoteSnapshot>),
    Fill(Box<Fill>),
    FillResync,
    Volume(Box<DailyVolume>),
    VolumeResync,
}

impl StreamMessage {
    /// The `ch` it travels on.
    pub fn channel(&self) -> &'static str {
        match self {
            StreamMessage::State(_) => "state",
            StreamMessage::Quotes(_) => "quotes",
            StreamMessage::Fill(_) | StreamMessage::FillResync => "fill",
            StreamMessage::Volume(_) | StreamMessage::VolumeResync => "volume",
        }
    }

    pub fn is_resync(&self) -> bool {
        matches!(self, StreamMessage::FillResync | StreamMessage::VolumeResync)
    }
}

impl Serialize for StreamMessage {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_struct("StreamMessage", 2)?;
        m.serialize_field("ch", self.channel())?;
        match self {
            StreamMessage::State(d) => m.serialize_field("data", d)?,
            StreamMessage::Quotes(d) => m.serialize_field("data", d)?,
            StreamMessage::Fill(d) => m.serialize_field("data", d)?,
            StreamMessage::Volume(d) => m.serialize_field("data", d)?,
            StreamMessage::FillResync | StreamMessage::VolumeResync => m.serialize_field("resync", &true)?,
        }
        m.end()
    }
}

impl<'de> Deserialize<'de> for StreamMessage {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            ch: String,
            #[serde(default)]
            data: Option<serde_json::Value>,
            #[serde(default)]
            resync: bool,
        }
        let raw = Raw::deserialize(d)?;
        fn data<T: serde::de::DeserializeOwned, E: serde::de::Error>(
            v: Option<serde_json::Value>,
        ) -> Result<Box<T>, E> {
            let v = v.ok_or_else(|| E::missing_field("data"))?;
            serde_json::from_value(v).map(Box::new).map_err(E::custom)
        }
        Ok(match (raw.ch.as_str(), raw.resync) {
            ("fill", true) => StreamMessage::FillResync,
            ("volume", true) => StreamMessage::VolumeResync,
            ("state", _) => StreamMessage::State(data(raw.data)?),
            ("quotes", _) => StreamMessage::Quotes(data(raw.data)?),
            ("fill", false) => StreamMessage::Fill(data(raw.data)?),
            ("volume", false) => StreamMessage::Volume(data(raw.data)?),
            (other, _) => return Err(D::Error::unknown_variant(other, &["state", "quotes", "fill", "volume"])),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FillCategory, Side, ThemeColor, VenueDaily, VenueGasDaily, VenueKind, VenueRole};
    use serde_json::{json, Value};

    /// JSON numbers compared by value: TypeScript writes `2` where serde
    /// writes `2.0` for an f64, and both parse to the same JS number.
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }

    /// Parse hand-written TypeScript-shaped JSON, write it back, and require
    /// the same document: no field renamed, dropped or added.
    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(ts: Value) -> T {
        let parsed: T = serde_json::from_value(ts.clone()).expect("parses today's JSON");
        let back = serde_json::to_value(&parsed).unwrap();
        assert!(same(&ts, &back), "\n today: {ts}\n  rust: {back}");
        parsed
    }

    fn venue() -> VenueMeta {
        VenueMeta {
            id: "poe".into(),
            name: "LFJ POE".into(),
            color: ThemeColor { light: "#111".into(), dark: "#eee".into() },
            kind: VenueKind::Amm,
            role: VenueRole::Venue,
            taker: None,
            taker_bps: None,
            since_utc: None,
            quote_note: None,
        }
    }

    fn market_state_json() -> Value {
        json!({
            "chainId": 143, "block": 12345, "monUsd": 0.0262, "monChangePct": -1.2, "takerBps": 2,
            "markets": ["MON/USDC"], "sizesUsd": [100, 1000], "quoteCadenceMs": 300, "source": "live",
            "venues": [
                { "id": "poe", "name": "LFJ POE", "color": { "light": "#111", "dark": "#eee" }, "kind": "amm", "role": "venue" },
                { "id": "bybit", "name": "Bybit", "color": { "light": "#333", "dark": "#ccc" }, "kind": "cex", "role": "reference",
                  "taker": true, "takerBps": 10, "sinceUtc": "2026-05-13", "quoteNote": "taker walk" }
            ],
            "quoteMarkets": { "poe": ["MON/USDC", "BTC/USDC"], "bybit": ["MON/USDC"] },
            "notes": [
                { "ts": 1700000000000u64, "level": "warn", "code": "quote.head.fallback", "venue": "poe", "msg": "fell back" },
                { "ts": 1700000000001u64, "level": "info", "code": "source.sim", "msg": "simulated" }
            ],
            "rpc": { "active": "backup-1", "degraded": true, "down": false, "degradedSinceTs": 1700000000000u64 },
            "rpcArchive": { "active": "archive", "degraded": false, "down": false },
            "realtime": {
                "headBlock": 12345, "quoteBlock": 12344, "lagBlocks": 1, "frameMs": 210, "headToFrameMs": 190,
                "eventLoopLagMs": 3, "coveragePct60s": 99.2, "coalescedBlocks60s": 4, "headSource": "ws", "wsStatus": "connected"
            },
            "tail": { "block": 121585293, "lagBlocks": 1021587, "lagMs": 306476100, "held": true }
        })
    }

    #[test]
    fn market_state_matches_todays_shape() {
        round_trip::<MarketState>(market_state_json());
        // a `Value` sorts its keys, so the order check reads the text itself
        let text = r#"{"chainId":143,"block":1,"monUsd":0.02,"monChangePct":0,"takerBps":1,"markets":[],"sizesUsd":[],
            "quoteCadenceMs":300,"source":"live","venues":[],"quoteMarkets":{"poe":["MON/USDC"],"bybit":["MON/USDC"]}}"#;
        let s: MarketState = serde_json::from_str(text).unwrap();
        assert_eq!(
            s.quote_markets.as_ref().unwrap().keys().collect::<Vec<_>>(),
            ["poe", "bybit"],
            "discovery order kept"
        );
        assert!(serde_json::to_string(&s).unwrap().contains(r#""quoteMarkets":{"poe":["MON/USDC"],"bybit""#));
        // the lean variant: no optional field invented when absent
        let lean = json!({
            "chainId": 143, "block": 1, "monUsd": 0.024, "monChangePct": 0, "takerBps": 1, "markets": [],
            "sizesUsd": [1000], "quoteCadenceMs": 300, "source": "sim", "venues": []
        });
        let s: MarketState = round_trip(lean);
        assert!(s.notes.is_none() && s.tail.is_none() && s.realtime.is_none() && s.quote_markets.is_none());
    }

    #[test]
    fn stream_state_never_carries_telemetry_and_venues_only_on_hello() {
        let state: MarketState = serde_json::from_value(market_state_json()).unwrap();
        let hello = serde_json::to_value(StreamState::hello(&state)).unwrap();
        assert!(hello.get("notes").is_none() && hello.get("realtime").is_none());
        assert_eq!(hello["venues"][1]["takerBps"], json!(10.0));
        assert_eq!(hello["tail"]["held"], json!(true));
        let tick = serde_json::to_value(StreamState::hello(&state).tick()).unwrap();
        assert!(tick.get("venues").is_none());
        // a frame that carries notes is still a valid StreamState: they are dropped on read
        let parsed: StreamState = serde_json::from_value(market_state_json()).unwrap();
        assert!(serde_json::to_value(parsed).unwrap().get("notes").is_none());
    }

    #[test]
    fn quote_snapshot_matches_todays_shape() {
        let ts = json!({
            "blockHash": format!("0x{}", "ab".repeat(32)), "revision": 3, "block": 12345, "monUsd": 0.0262, "ts": 100,
            "rows": [{
                "venueId": "poe", "market": "MON/USDC", "sizeUsd": 1000, "bidBps": -25.11, "askBps": 26.18,
                "bidPx": 0.01555, "askPx": 0.01563, "spreadBps": 51.29, "filledFull": true, "feeBps": 21.28,
                "ts": 100, "cexAskBps": 15.1, "cexBidBps": 14.2
            }, {
                "venueId": "clober", "market": "MON/USDC", "sizeUsd": 1000, "bidBps": -1, "askBps": 1, "bidPx": 0,
                "askPx": 0.0156, "spreadBps": 2, "filledFull": false, "oneSided": true, "feeBps": 0, "ts": 99
            }],
            "frame": {
                "headSource": "ws", "headObservedAt": 80, "quoteStartedAt": 81, "quoteCompletedAt": 99, "emittedAt": 100,
                "durationMs": 18, "adapterMs": { "poe": 17.2, "clober": 4 }, "missingVenues": ["clober"], "coalescedBlocks": 0
            }
        });
        let q: QuoteSnapshot = round_trip(ts);
        let lean = serde_json::to_value(q.without_frame()).unwrap();
        assert!(lean.get("frame").is_none());
        assert_eq!(lean["ts"], json!(100.0));
        round_trip::<QuoteSnapshot>(json!({ "block": 1, "monUsd": 0.02, "ts": 1, "rows": [] }));
    }

    #[test]
    fn stats_depth_and_gas_match_todays_shapes() {
        round_trip::<QuoteStatsResponse>(json!({
            "market": "MON/USDC", "sizeUsd": 1000, "asOf": 1700000000000u64, "windowMs": 300000, "revision": 0,
            "rows": [{ "venueId": "poe", "p5": 1, "p25": 2, "p50": 3, "p75": 4, "p95": 5, "avg": 3, "sd": 1.2, "n": 5 }]
        }));
        let d: DepthSnapshot = round_trip(json!({
            "blockHash": "0x01", "revision": 1, "missingVenues": ["clober"], "market": "MON/USDC", "asOfBlock": 7,
            "refMid": 0.024, "ts": 100,
            "venues": [{ "venueId": "poe", "maxNotional": 10000,
                "points": [{ "notional": 100, "bidBps": -3, "askBps": 4 }, { "notional": 1000, "askBps": 9 }] }]
        }));
        assert_eq!(d.venues[0].points[1].bid_bps, None, "a missing side stays absent, not 0");
        let text = serde_json::to_string(&d).unwrap();
        assert!(text.contains(r#""notional":100,"#) && text.contains(r#""maxNotional":10000}"#), "{text}");
        assert!(text.contains(r#""ts":100,"#) && text.contains(r#""refMid":0.024,"#), "whole numbers as today: {text}");
        round_trip::<DepthSnapshot>(
            json!({ "market": "BTC/USDC", "asOfBlock": 1, "refMid": 1, "ts": 1, "venues": [] }),
        );
        let g: GasResponse = round_trip(json!({
            "days": [{ "utcDay": "2026-11-26", "byVenue": { "poe": { "mon": 1.5, "txs": 12 } }, "partial": false }],
            "approx": ["poe"]
        }));
        assert_eq!(g.days[0].by_venue["poe"], VenueGasDaily { mon: 1.5, txs: 12 });
    }

    fn fill() -> Fill {
        Fill {
            id: "poe-0xab-3".into(),
            venue_id: "poe".into(),
            market: "MON/USDC".into(),
            side: Side::Sell,
            category: FillCategory::Router,
            usd: 12.5,
            base_amount: 400.0,
            exec_px: 0.03125,
            px_approx: false,
            tx_hash: "0xab".into(),
            to: "KyberSwap".into(),
            router: Some("KyberSwap".into()),
            pool: "MON/USDC".into(),
            block_number: 7,
            ts: 1_795_762_412_000.0,
            markouts_bps: vec![Some(1.5), None, None, None, None],
            time_source: None,
        }
    }

    #[test]
    fn stream_messages_serialize_as_todays_channels() {
        let resync = serde_json::to_value(StreamMessage::FillResync).unwrap();
        assert_eq!(resync, json!({ "ch": "fill", "resync": true }));
        assert_eq!(
            serde_json::to_value(StreamMessage::VolumeResync).unwrap(),
            json!({ "ch": "volume", "resync": true })
        );

        let f = serde_json::to_value(StreamMessage::Fill(Box::new(fill()))).unwrap();
        assert_eq!(f["ch"], "fill");
        assert_eq!(f["data"]["category"], "ROUTER");
        assert!(f.get("resync").is_none());

        let day = DailyVolume {
            utc_day: "2026-11-27".into(),
            by_venue: [("poe".to_string(), VenueDaily { usd: 10.0, swaps: 2 })].into(),
            partial: true,
        };
        let v = serde_json::to_value(StreamMessage::Volume(Box::new(day.clone()))).unwrap();
        assert!(same(
            &v,
            &json!({ "ch": "volume", "data": { "utcDay": "2026-11-27", "byVenue": { "poe": { "usd": 10, "swaps": 2 } }, "partial": true } })
        ));

        // today's JSON reads back into the same message
        for (text, want) in [
            (r#"{"ch":"fill","resync":true}"#, StreamMessage::FillResync),
            (r#"{"ch":"volume","resync":true}"#, StreamMessage::VolumeResync),
        ] {
            assert_eq!(serde_json::from_str::<StreamMessage>(text).unwrap(), want);
        }
        assert_eq!(serde_json::from_value::<StreamMessage>(v).unwrap(), StreamMessage::Volume(Box::new(day)));
        let state = StreamState::hello(&serde_json::from_value(market_state_json()).unwrap()).tick();
        let s = serde_json::to_value(StreamMessage::State(Box::new(state.clone()))).unwrap();
        assert_eq!(s["ch"], "state");
        assert_eq!(serde_json::from_value::<StreamMessage>(s).unwrap(), StreamMessage::State(Box::new(state)));
        assert!(serde_json::from_str::<StreamMessage>(r#"{"ch":"depth","data":{}}"#).is_err());
        assert!(serde_json::from_str::<StreamMessage>(r#"{"ch":"fill"}"#).is_err());
    }

    #[test]
    fn markets_response_matches_todays_shape() {
        let mut state = market_state_json();
        state.as_object_mut().unwrap().remove("realtime");
        let body = json!({
            "state": state,
            "quotes": { "block": 12345, "monUsd": 0.0262, "ts": 1, "rows": [] },
            "fills": [serde_json::to_value(fill()).unwrap()],
            "volume": [{ "utcDay": "2026-11-27", "byVenue": {}, "partial": true }]
        });
        let m: MarketsResponse = round_trip(body);
        assert_eq!(m.state.venues[0], venue());
    }
}
