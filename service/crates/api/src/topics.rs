//! Stream topics (`shared/src/stream.ts`): what a client may subscribe to,
//! validated against the registry so demand is bounded by the registry and
//! never by client input (an arbitrary size would open new quote work).

use mpamm_registry::Registry;
use serde_json::Value;

pub const STREAM_PATH: &str = "/stream";
pub const STREAM_V2_GZIP: &str = "mpamm.v2.gzip";
pub const STREAM_V2_JSON: &str = "mpamm.v2.json";
/// The most topics one subscription may name.
pub const MAX_STREAM_TOPICS: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum StreamTopic {
    State,
    Fill,
    Volume,
    Quotes { market: String, size_usd: f64, baseline: bool },
    Depth { market: String },
}

impl StreamTopic {
    /// The channel (`ch`) whose messages feed this topic.
    pub fn channel(&self) -> &'static str {
        match self {
            StreamTopic::State => "state",
            StreamTopic::Fill => "fill",
            StreamTopic::Volume => "volume",
            StreamTopic::Quotes { .. } => "quotes",
            StreamTopic::Depth { .. } => "depth",
        }
    }

    /// Today's `topicKey`: the envelope's `topic` and the client's sequence key.
    pub fn key(&self) -> String {
        match self {
            StreamTopic::Quotes { market, size_usd, baseline } => {
                format!("quotes:{market}:{}:{}", js_number(*size_usd), u8::from(*baseline))
            }
            StreamTopic::Depth { market } => format!("depth:{market}"),
            other => other.channel().to_string(),
        }
    }
}

/// A number as JavaScript prints it in a template string, for the integral
/// sizes topic keys carry (`1000`, never `1000.0`).
pub fn js_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// Today's `parseTopics`: `None` when anything is invalid (the caller closes
/// with 1008), otherwise the distinct topics in key order.
pub fn parse_topics(input: &Value, registry: &Registry) -> Option<Vec<StreamTopic>> {
    let items = input.as_array()?;
    if items.len() > MAX_STREAM_TOPICS {
        return None;
    }
    let mut unique = std::collections::BTreeMap::new();
    for item in items {
        let item = item.as_object()?;
        let channel = item.get("channel").and_then(Value::as_str)?;
        let topic = match channel {
            "state" => StreamTopic::State,
            "fill" => StreamTopic::Fill,
            "volume" => StreamTopic::Volume,
            "depth" | "quotes" => {
                let market = item.get("market").and_then(Value::as_str)?;
                registry.pair_of(market)?;
                if channel == "depth" {
                    StreamTopic::Depth { market: market.to_string() }
                } else {
                    let size_usd = item.get("sizeUsd").and_then(Value::as_f64)?;
                    if !registry.sizes_usd.contains(&size_usd) {
                        return None;
                    }
                    let baseline = item.get("baseline").and_then(Value::as_bool)?;
                    StreamTopic::Quotes { market: market.to_string(), size_usd, baseline }
                }
            }
            _ => return None,
        };
        unique.insert(topic.key(), topic);
    }
    Some(unique.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> Option<Vec<String>> {
        parse_topics(&v, Registry::get()).map(|t| t.iter().map(StreamTopic::key).collect())
    }

    #[test]
    fn keys_match_todays_topic_key() {
        let q = StreamTopic::Quotes { market: "MON/USDC".into(), size_usd: 1000.0, baseline: false };
        assert_eq!(q.key(), "quotes:MON/USDC:1000:0");
        let q = StreamTopic::Quotes { market: "BTC/USDC".into(), size_usd: 100_000.0, baseline: true };
        assert_eq!(q.key(), "quotes:BTC/USDC:100000:1");
        assert_eq!(StreamTopic::Depth { market: "MON/USDC".into() }.key(), "depth:MON/USDC");
        assert_eq!(StreamTopic::State.key(), "state");
        assert_eq!(js_number(0.5), "0.5");
    }

    #[test]
    fn validates_against_the_registry() {
        let ok = json!([
            { "channel": "state" }, { "channel": "volume" }, { "channel": "state" },
            { "channel": "quotes", "market": "MON/USDC", "sizeUsd": 1000, "baseline": false },
            { "channel": "depth", "market": "MON/USDC" }
        ]);
        assert_eq!(parse(ok).unwrap(), ["depth:MON/USDC", "quotes:MON/USDC:1000:0", "state", "volume"]);
        assert_eq!(parse(json!([])).unwrap(), Vec::<String>::new());
        // a size outside the registry would open unbounded quote work
        for bad in [
            json!([{ "channel": "quotes", "market": "MON/USDC", "sizeUsd": 12345, "baseline": false }]),
            json!([{ "channel": "quotes", "market": "MON/USDC", "sizeUsd": "1000", "baseline": false }]),
            json!([{ "channel": "quotes", "market": "MON/USDC", "sizeUsd": 1000, "baseline": 0 }]),
            json!([{ "channel": "quotes", "market": "DOGE/USDC", "sizeUsd": 1000, "baseline": false }]),
            json!([{ "channel": "depth" }]),
            json!([{ "channel": "notes" }]),
            json!(["state"]),
            json!({ "channel": "state" }),
            json!(null),
        ] {
            assert!(parse(bad.clone()).is_none(), "{bad}");
        }
        let many: Vec<Value> = (0..=MAX_STREAM_TOPICS).map(|_| json!({ "channel": "state" })).collect();
        assert!(parse(Value::Array(many)).is_none());
        let limit: Vec<Value> = (0..MAX_STREAM_TOPICS).map(|_| json!({ "channel": "state" })).collect();
        assert_eq!(parse(Value::Array(limit)).unwrap(), ["state"]);
    }
}
