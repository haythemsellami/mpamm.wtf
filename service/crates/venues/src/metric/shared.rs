//! What every Metric contract generation shares (server/src/venues/
//! metric-shared.ts): the ONE venue they report as, the structural admission
//! rule, the liveness gate and the fill shape. A generation differs only in
//! its ABIs and its contract set, so anything here stays generation-agnostic.

use alloy_primitives::{Address, U256};
use mpamm_core::{FinalBlock, FinalLog};
use mpamm_registry::Registry;
use mpamm_ring::Addr;
use mpamm_types::{Fill, FillCategory, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};

use crate::util::{addr_hex, b32_hex, fill_id, from_units, short_hex};

pub const ID: &str = "metric";

/// sinceUtc = Metric's first on-chain day (the first v0 pool and its first
/// swap, 2026-03-30), the SAME anchor as the lifetime replay. One id across
/// generations: history is keyed by venue id.
pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "Metric".into(),
        color: ThemeColor { light: "#0F9D8C".into(), dark: "#0D9488".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2026-03-30".into()),
        quote_note: None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MetricPool {
    pub pool: Addr,
    /// The pool address as today's adapter spells it: the fill's `pool`
    /// label is its first 8 characters, case included (v0's funded seeds keep
    /// their checksum spelling, v1's factory answers are lower-cased).
    pub pool_str: String,
    /// v0: from the static table; v1: the pool's CURRENT provider. Only
    /// liveness and gas read it.
    pub price_provider: Addr,
    pub market: String,
    pub base_is_token0: bool,
    /// Registry key of the base asset's canonical wrapper.
    pub base_token: String,
    pub base_dec: u8,
    pub stable_sym: String,
    pub stable_dec: u8,
}

impl MetricPool {
    pub fn label(&self) -> String {
        format!("metric {}", &self.pool_str[..8])
    }
}

/// The token layout a pool reports on-chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolTokens {
    pub token0: Addr,
    pub token1: Addr,
    pub price_provider: Addr,
}

/// Why a candidate pool was not admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reject {
    Unresolved,
    NotBaseStable,
    /// `BASE/STABLE` symbols of the unregistered combination.
    UnregisteredPair(String),
    UnknownBaseToken(String),
}

/// STRUCTURAL admission: exactly one side a tracked base asset, the other a
/// stable, on a registered pair. Metric is permissionless, so anything else
/// is dropped rather than surfaced as an unbenchmarkable market.
pub fn admit_pool(
    registry: &Registry,
    pool: Addr,
    pool_str: &str,
    tokens: Option<&PoolTokens>,
) -> Result<MetricPool, Reject> {
    let im = tokens.ok_or(Reject::Unresolved)?;
    let (t0, t1) = (addr_hex(&im.token0), addr_hex(&im.token1));
    let (a0, a1) = (registry.asset_for_token(&t0), registry.asset_for_token(&t1));
    if a0.is_some() == a1.is_some() {
        return Err(Reject::NotBaseStable);
    }
    let base_is_token0 = a0.is_some();
    let base = if base_is_token0 { a0 } else { a1 }.ok_or(Reject::NotBaseStable)?;
    let stable_addr = if base_is_token0 { &t1 } else { &t0 };
    let stable = registry
        .tokens
        .values()
        .find(|t| t.stable && t.address.eq_ignore_ascii_case(stable_addr))
        .ok_or(Reject::NotBaseStable)?;
    let pair = registry
        .pair_for(&base.key, &stable.symbol)
        .ok_or_else(|| Reject::UnregisteredPair(format!("{}/{}", base.symbol, stable.symbol)))?;
    let base_tok = registry.base_token_of(&base.key).ok_or_else(|| Reject::UnknownBaseToken(base.key.clone()))?;
    Ok(MetricPool {
        pool,
        pool_str: pool_str.to_string(),
        price_provider: im.price_provider,
        market: pair.symbol.clone(),
        base_is_token0,
        base_token: base.token.clone(),
        base_dec: base_tok.decimals,
        stable_sym: stable.symbol.clone(),
        stable_dec: stable.decimals,
    })
}

/// Why a structurally valid pool is (not) quotable right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Live,
    /// The curator's shell: no inventory on one side or both.
    Unfunded,
    /// Funded, but the price provider refused (it can still trade).
    NoPrice,
    /// A token contract did not answer: funding unknown.
    Unreadable,
}

/// LIVENESS: quoted only when both sides are funded and the provider
/// returns a two-sided price. Fills are never gated on it.
pub fn pool_liveness(bal0: Option<U256>, bal1: Option<U256>, bid: Option<u128>, ask: Option<u128>) -> Liveness {
    let (Some(b0), Some(b1)) = (bal0, bal1) else { return Liveness::Unreadable };
    if b0.is_zero() || b1.is_zero() {
        return Liveness::Unfunded;
    }
    match (bid, ask) {
        (Some(b), Some(a)) if b > 0 && a > 0 => Liveness::Live,
        _ => Liveness::NoPrice,
    }
}

/// One landed swap → a trade. Both generations report the pool's NET token
/// flows with one sign convention (positive = the pool GAINED the token), so
/// the money math lives here once. `None` for a degenerate log.
pub fn metric_fill(
    p: &MetricPool,
    d0: i128,
    d1: i128,
    log: &FinalLog,
    recipient: Address,
    block: &FinalBlock,
) -> Option<Fill> {
    let (base_delta, stable_delta) = if p.base_is_token0 { (d0, d1) } else { (d1, d0) };
    let base_amount = from_units(U256::from(base_delta.unsigned_abs()), p.base_dec);
    let usd = from_units(U256::from(stable_delta.unsigned_abs()), p.stable_dec);
    if base_amount <= 0.0 || usd <= 0.0 {
        return None;
    }
    Some(Fill {
        // Generation-free: a fill's id must not depend on which generation
        // decoded it.
        id: fill_id(ID, &log.tx_hash, log.log_index),
        venue_id: ID.into(),
        market: p.market.clone(),
        // Stable INTO the pool ⇒ the trader bought the base.
        side: if stable_delta > 0 { Side::Buy } else { Side::Sell },
        // Attribution is the core's job: never claim DIRECT here.
        category: FillCategory::Unknown,
        usd,
        base_amount,
        exec_px: usd / base_amount,
        px_approx: false,
        tx_hash: b32_hex(&log.tx_hash),
        // viem hands decoded addresses checksummed; today's label keeps that case.
        to: short_hex(&recipient.to_string()),
        router: None,
        pool: p.label(),
        block_number: block.number,
        ts: block.time_ms(),
        markouts_bps: vec![None; 5],
        time_source: None,
    })
}
