//! Metric, ported from server/src/venues/metric.ts: an oracle-anchored bin
//! AMM (propAMM), fully on-chain, every pool a tracked base asset against a
//! USD stable.
//!
//! Metric REDEPLOYED its whole protocol in September 2026 (new factory,
//! router, quoter and Swap ABI), so the venue is two contract generations
//! behind ONE venue id (`generations`):
//!   v0  2026-03-30 → 2026-09-27 · retired: decode-only, bounded at the last v0 swap.
//!   v1  2026-10-04 →            · live: discovery, fills, gas.

pub mod shared;
pub mod v0;
pub mod v1;

use std::sync::Arc;

use mpamm_core::HistoryRevision;
use mpamm_registry::Registry;

pub use shared::{meta, ID};

use crate::generations::{Generation, Generations, VenueHistory};

/// The first on-chain day: the lifetime replay starts here (= sinceUtc).
pub const HISTORY_FROM_UTC: &str = "2026-03-30";

/// wANTx/USDC was registered after its pool started trading: v1 pool #11 was
/// created at block 123,564,619 (2026-11-19) and first swapped at block
/// 123,648,251, so the revision adds the market's whole history.
pub fn history_revisions() -> Vec<HistoryRevision> {
    vec![HistoryRevision { id: "wantx-usdc", from: Some("2026-11-19"), markets: &["wANTx/USDC"] }]
}

/// Metric as the service runs it: v0 then v1 behind one venue.
pub fn venue() -> Generations {
    compose(v0::MetricV0::new(Registry::get()), Arc::new(v1::MetricV1::default()))
}

/// The venue over given generations (tests keep a handle on v1).
pub fn compose(v0: v0::MetricV0, v1: Arc<v1::MetricV1>) -> Generations {
    Generations::new(
        meta(),
        VenueHistory { from_utc: Some(HISTORY_FROM_UTC), revisions: history_revisions() },
        vec![("v0", Arc::new(v0) as Arc<dyn Generation>), ("v1", v1 as Arc<dyn Generation>)],
    )
}
