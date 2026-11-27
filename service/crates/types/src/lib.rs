//! The service's data types. Their JSON is the contract the web app already
//! reads (`shared/src/index.ts`): the same field names (camelCase), the same
//! enum spellings and the same optional fields, so REST stays compatible
//! while the frontend moves to the new stream.

use serde::{Deserialize, Serialize};

/// Buy or sell of the base asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

/// How a trade's transaction reached the venue. `Unknown` = the attribution
/// source was unavailable, never guessed as direct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FillCategory {
    #[serde(rename = "DIRECT")]
    Direct,
    #[serde(rename = "ROUTER")]
    Router,
    #[serde(rename = "AGG")]
    Agg,
    #[serde(rename = "MEV")]
    Mev,
    #[serde(rename = "CEX/DEX")]
    CexDex,
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

impl FillCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            FillCategory::Direct => "DIRECT",
            FillCategory::Router => "ROUTER",
            FillCategory::Agg => "AGG",
            FillCategory::Mev => "MEV",
            FillCategory::CexDex => "CEX/DEX",
            FillCategory::Unknown => "UNKNOWN",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "DIRECT" => FillCategory::Direct,
            "ROUTER" => FillCategory::Router,
            "AGG" => FillCategory::Agg,
            "MEV" => FillCategory::Mev,
            "CEX/DEX" => FillCategory::CexDex,
            "UNKNOWN" => FillCategory::Unknown,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeColor {
    pub light: String,
    pub dark: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VenueKind {
    Amm,
    Clob,
    Vault,
    Cex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VenueRole {
    /// A propAMM: trades, volume, markouts, leaderboard.
    Venue,
    /// An exchange benchmark (Execution only).
    Reference,
    /// A quote-only standard-DEX comparison band.
    Baseline,
}

/// A venue's identity, shipped to the web app so nothing about a venue is
/// hard-coded there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueMeta {
    pub id: String,
    pub name: String,
    pub color: ThemeColor,
    pub kind: VenueKind,
    pub role: VenueRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taker: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taker_bps: Option<f64>,
    /// First UTC day the venue existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_utc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_note: Option<String>,
}

/// Where a trade's time came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeSource {
    /// The block's `proposal_epoch_nanos` (read from the ring).
    Proposal,
    /// The 1-second block timestamp: a block repaired over RPC, whose header
    /// has seconds only. Markouts of such trades are marked approximate.
    Block,
    /// Migrated from today's database (second resolution).
    Migrated,
}

/// One trade on a tracked venue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    /// `venue-txHash-logIndex`, with the block-level log index.
    pub id: String,
    pub venue_id: String,
    pub market: String,
    pub side: Side,
    pub category: FillCategory,
    /// USD value of the trade.
    pub usd: f64,
    pub base_amount: f64,
    /// Quote per base.
    pub exec_px: f64,
    /// `exec_px`/`base_amount` aren't a realized price: exact USD, no markouts.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub px_approx: bool,
    pub tx_hash: String,
    /// Label of the taker (the transaction sender once attributed).
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub router: Option<String>,
    pub pool: String,
    pub block_number: u64,
    /// Epoch ms; fractional when it is the proposal time.
    pub ts: f64,
    /// Markout bps at each horizon; `None` until aged.
    pub markouts_bps: Vec<Option<f64>>,
    /// Not in today's JSON: where `ts` came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_source: Option<TimeSource>,
}

/// One quote for (venue, market, size).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRow {
    pub venue_id: String,
    pub market: String,
    pub size_usd: f64,
    pub bid_bps: f64,
    pub ask_bps: f64,
    pub bid_px: f64,
    pub ask_px: f64,
    pub spread_bps: f64,
    pub filled_full: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub one_sided: Option<bool>,
    pub fee_bps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cex_ask_bps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cex_bid_bps: Option<f64>,
    pub ts: f64,
}

/// One venue's slice of a day.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct VenueDaily {
    pub usd: f64,
    pub swaps: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyVolume {
    pub utc_day: String,
    pub by_venue: std::collections::BTreeMap<String, VenueDaily>,
    pub partial: bool,
}

/// One venue's quote-update gas for one day.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct VenueGasDaily {
    pub mon: f64,
    pub txs: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GasDay {
    pub utc_day: String,
    pub by_venue: std::collections::BTreeMap<String, VenueGasDaily>,
    pub partial: bool,
}

/// `YYYY-MM-DD` (UTC) of an epoch time in ms.
pub fn utc_day(ms: f64) -> String {
    let days = (ms / 86_400_000.0).floor() as i64;
    // Civil-from-days (Howard Hinnant), proleptic Gregorian.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_json_matches_todays_shape() {
        let f = Fill {
            id: "metric-0xab-3".into(),
            venue_id: "metric".into(),
            market: "MON/USDC".into(),
            side: Side::Buy,
            category: FillCategory::CexDex,
            usd: 12.5,
            base_amount: 400.0,
            exec_px: 0.03125,
            px_approx: false,
            tx_hash: "0xab".into(),
            to: "0x12…34".into(),
            router: None,
            pool: "MON/USDC".into(),
            block_number: 7,
            ts: 1_795_762_412_345.5,
            markouts_bps: vec![Some(1.5), None, None, None, None],
            time_source: None,
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["venueId"], "metric");
        assert_eq!(v["category"], "CEX/DEX");
        assert_eq!(v["side"], "buy");
        assert_eq!(v["markoutsBps"], serde_json::json!([1.5, null, null, null, null]));
        assert!(v.get("pxApprox").is_none() && v.get("router").is_none() && v.get("timeSource").is_none());
        let back: Fill = serde_json::from_value(v).unwrap();
        assert_eq!(back, f);
        assert_eq!(FillCategory::parse("MEV"), Some(FillCategory::Mev));
        assert_eq!(FillCategory::Unknown.as_str(), "UNKNOWN");
    }

    #[test]
    fn utc_days() {
        assert_eq!(utc_day(0.0), "1970-01-01");
        assert_eq!(utc_day(1_795_762_412_000.0), "2026-11-27");
        assert_eq!(utc_day(951_782_400_000.0), "2000-02-29");
        assert_eq!(utc_day(951_868_799_999.0), "2000-02-29");
        assert_eq!(utc_day(951_868_800_000.0), "2000-03-01");
    }
}
