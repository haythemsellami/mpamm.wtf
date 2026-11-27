//! Capricorn pAMM, ported from server/src/venues/capricorn.ts: Capricorn's
//! Proactive AMM. A pool prices off an oracle, not a curve (the engine is
//! closed-source), so nothing here models its math:
//!
//!   Factory.PoolCreated(token0, token1, feeBps, pool) → the pool set
//!   Pool.getTokens() / feeBps() / paused()            → layout, fee, liveness
//!   Pool.quoteExactIn(tokenIn, amountIn)              → the discovery probe
//!   Pool.Swap(…, amount0, amount1, reserve0, reserve1) → the fill
//!
//! The factory has no enumeration, so the pools that existed at port time are
//! seeded (and re-read at every discovery) and the factory's `PoolCreated` is
//! followed in decode, which runs once per final block in order: a pool
//! announced in a block is admitted from the event before that block's
//! swaps, and recorded in the venue's committed state so a restart keeps it.
//!
//! Gas: the pools read Capricorn's own push feed (PricingEngine →
//! OracleRegistry → the feed, one hop further than either receives update
//! transactions). The keeper's pushes emit one event each; the contract is
//! unverified, so that event is known only by its topic0.
//!
//! Quotes: `quoteExactIn` per quotable pool × size × side, the executable
//! fee-inclusive output, one `eth_call` per leg (~0.2M gas, measured
//! 2026-11-27) in one batch pinned to the block. It SATURATES rather than
//! reverting: asked for more than the pool holds, it returns the remaining
//! reserve (a $100k bid on a $2.1k pool quoted ~68,000 bps out), so a leg
//! beyond ±2000 bps of the pair mid is an exhausted reserve, not depth, and
//! is dropped.

use std::collections::{BTreeSet, HashMap, HashSet};

use alloy_primitives::{address, b256, Address, U256};
use alloy_sol_types::sol;
use async_trait::async_trait;
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, GasSources, QuoteCx, Venue, VenueError, VenueState};
use mpamm_registry::Registry;
use mpamm_ring::{Addr, TopicFilter, WatchSet, B32};
use mpamm_types::{Fill, FillCategory, QuoteRow, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call_many, At},
    logs, quote_health,
    util::{addr_hex, b32_hex, fill_id, from_addr, from_units, short_hex, to_addr, to_f64, to_units},
};

pub const ID: &str = "capricorn";
/// CapricornPammFactory.
pub const FACTORY: Address = address!("010cf4f9e3a79dd2fe11760d76a75df6c0656631");
/// The push price feed (a proxy) behind every pool's quote; one EOA pushes it
/// every few minutes at a flat 99,650 gas limit.
pub const PUSH_FEED: Address = address!("7ddf62c41e9b3fbfd5ac77ae7f387fd91487ba8a");
pub const PUSH_FEED_UPDATE_TOPIC: B32 = b256!("34b3a9772b8366e24c6c25cd6ccf6ffad5b57015a64ef0ea726b3b5cfc159425").0;
/// The pools that existed at port time, re-read at every discovery. A seed
/// that stops resolving fails discovery; a later pool that misbehaves is
/// only skipped.
pub const SEED_POOLS: [Address; 2] = [
    address!("63093325c05cd32b18034d3ea29199fb7098e4df"), // USDC/WMON
    address!("91c483fbe8feef4dad525781e6d65d2e668b3a47"), // AUSD/WMON
];
/// Probe notional for the discovery-time quotability gate (stable units).
const QUOTE_PROBE_USD: f64 = 100.0;
/// Per-side sanity band against the pair reference (see the header).
const PER_SIDE_BAND_BPS: f64 = 2_000.0;
/// Venue-state key: the factory's pools seen in decode, with their layout.
const STATE_CREATED: &str = "created";

sol! {
    function getTokens() view returns (address token0, address token1);
    function feeBps() view returns (uint256);
    function paused() view returns (bool);
    function quoteExactIn(address tokenIn, uint256 amountIn) view returns (uint256 amountOut);
    // Deltas are POOL-SIGNED: the leg the pool received is positive.
    event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint256 reserve0, uint256 reserve1);
    event PoolCreated(address indexed token0, address indexed token1, uint256 indexed feeBps, address pool);
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    pub pool: Addr,
    pub market: String,
    pub base_is_token0: bool,
    /// Registry key of the base asset's canonical wrapper.
    pub base_token: String,
    pub base_dec: u8,
    pub base_addr: Addr,
    pub stable_sym: String,
    pub stable_dec: u8,
    pub stable_addr: Addr,
    /// Read on chain, never a docs number.
    pub fee_bps: f64,
}

/// Why a candidate pool was not admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reject {
    Unresolved,
    NotBaseStable,
    UnregisteredPair(String),
    UnknownBaseToken(String),
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        // The DB key of this venue's history: only the display name moves.
        id: ID.into(),
        name: "Capricorn pAMM".into(),
        color: ThemeColor { light: "#BE123C".into(), dark: "#FB7185".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2026-04-01".into()),
        quote_note: None,
    }
}

/// Structural admission: exactly one side a tracked base asset, the other a
/// registered stable, and the pair registered. Everything else is dropped
/// rather than surfaced as an unbenchmarkable market.
pub fn admit(
    registry: &Registry,
    pool: Addr,
    tokens: Option<(Addr, Addr)>,
    fee_bps: Option<f64>,
) -> Result<Pool, Reject> {
    let (Some((t0, t1)), Some(fee_bps)) = (tokens, fee_bps) else { return Err(Reject::Unresolved) };
    let (a0, a1) = (registry.asset_for_token(&addr_hex(&t0)), registry.asset_for_token(&addr_hex(&t1)));
    if a0.is_some() == a1.is_some() {
        return Err(Reject::NotBaseStable);
    }
    let base_is_token0 = a0.is_some();
    let base = a0.or(a1).expect("one side is an asset");
    let stable_addr = if base_is_token0 { t1 } else { t0 };
    let stable =
        registry.tokens.values().find(|t| t.stable && t.address_bytes() == stable_addr).ok_or(Reject::NotBaseStable)?;
    let pair = registry
        .pair_for(&base.key, &stable.symbol)
        .ok_or_else(|| Reject::UnregisteredPair(format!("{}/{}", base.symbol, stable.symbol)))?;
    let base_tok = registry.base_token_of(&base.key).ok_or_else(|| Reject::UnknownBaseToken(base.key.clone()))?;
    Ok(Pool {
        pool,
        market: pair.symbol.clone(),
        base_is_token0,
        base_token: base.token.clone(),
        base_dec: base_tok.decimals,
        base_addr: if base_is_token0 { t0 } else { t1 },
        stable_sym: stable.symbol.clone(),
        stable_dec: stable.decimals,
        stable_addr,
        fee_bps,
    })
}

/// A factory announcement: the pool and its layout, as the event states it.
#[derive(Debug, Clone, PartialEq)]
struct Created {
    pool: Addr,
    token0: Addr,
    token1: Addr,
    fee_bps: U256,
}

fn read_created(state: &VenueState) -> Vec<Created> {
    let Some(raw) = state.get(ID, STATE_CREATED) else { return Vec::new() };
    let parse = |v: &serde_json::Value| {
        let a = |i: usize| mpamm_registry::parse_address(v.get(i)?.as_str()?);
        Some(Created {
            pool: a(0)?,
            token0: a(1)?,
            token1: a(2)?,
            fee_bps: U256::from_str_radix(v.get(3)?.as_str()?, 10).ok()?,
        })
    };
    match serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
        Ok(rows) => rows.iter().filter_map(parse).collect(),
        Err(e) => {
            tracing::warn!(target: "venues", "Capricorn pAMM: unreadable venue state ({e}); ignoring it");
            Vec::new()
        }
    }
}

fn write_created(state: &VenueState, rows: &[Created]) {
    let v: Vec<serde_json::Value> = rows
        .iter()
        .map(|c| {
            serde_json::json!([addr_hex(&c.pool), addr_hex(&c.token0), addr_hex(&c.token1), c.fee_bps.to_string()])
        })
        .collect();
    state.set(ID, STATE_CREATED, &serde_json::Value::Array(v).to_string());
}

#[derive(Debug, Default)]
struct Inner {
    /// Every pool address known: the seeds and every factory announcement.
    candidates: Vec<Addr>,
    /// Admitted pools, by address. Monotonic and keyed on admission, not
    /// quotability: an unquotable pool still trades (the Metric #61 lesson).
    by_addr: HashMap<Addr, Pool>,
    /// Admitted and answering a priced quote at the last discovery (for the
    /// quote engine).
    quotable: Vec<Addr>,
    discovered: bool,
    /// The committed state's pools have been merged in.
    state_loaded: bool,
}

impl Inner {
    fn add_candidate(&mut self, pool: Addr) -> bool {
        if self.candidates.contains(&pool) {
            return false;
        }
        self.candidates.push(pool);
        true
    }

    /// Admits a factory-announced pool from the event itself.
    fn admit_created(&mut self, registry: &Registry, c: &Created) {
        self.add_candidate(c.pool);
        match admit(registry, c.pool, Some((c.token0, c.token1)), Some(to_f64(c.fee_bps))) {
            Ok(p) => {
                self.by_addr.insert(c.pool, p);
            }
            Err(Reject::UnregisteredPair(d)) => tracing::warn!(
                target: "venues",
                "Capricorn pAMM: pool {} ({d}) is not a registered pair — skipped",
                short_hex(&addr_hex(&c.pool))
            ),
            Err(_) => {}
        }
    }
}

pub struct Capricorn {
    inner: RwLock<Inner>,
}

/// Wall-clock milliseconds, today's `Date.now()`.
fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

impl Default for Capricorn {
    fn default() -> Self {
        let inner = Inner { candidates: SEED_POOLS.iter().map(|a| to_addr(*a)).collect(), ..Inner::default() };
        Self { inner: RwLock::new(inner) }
    }
}

/// What one discovery read, per candidate pool (in `candidates` order).
pub struct Reads {
    pub pools: Vec<Addr>,
    pub tokens: Vec<Option<(Addr, Addr)>>,
    pub fees: Vec<Option<f64>>,
}

impl Capricorn {
    /// A venue already discovered with these pools (tests and tools).
    pub fn with_pools(pools: Vec<Pool>) -> Self {
        let v = Self::default();
        {
            let mut inner = v.inner.write();
            for p in pools {
                inner.add_candidate(p.pool);
                inner.by_addr.insert(p.pool, p);
            }
            inner.discovered = true;
        }
        v
    }

    pub fn candidates(&self) -> Vec<Addr> {
        self.inner.read().candidates.clone()
    }

    /// Admits what one discovery read. A seed that can't be resolved fails
    /// closed; admitted pools are merged, never removed. Returns the admitted
    /// pools, for the quotability probe.
    pub fn apply(&self, registry: &Registry, reads: &Reads) -> Result<Vec<Pool>, VenueError> {
        let mut admitted = Vec::new();
        for (i, pool) in reads.pools.iter().enumerate() {
            let tokens = reads.tokens.get(i).copied().flatten();
            let fee = reads.fees.get(i).copied().flatten();
            match admit(registry, *pool, tokens, fee) {
                Ok(p) => admitted.push(p),
                Err(Reject::Unresolved) if SEED_POOLS.iter().any(|s| to_addr(*s) == *pool) => {
                    return Err(VenueError::Chain(format!(
                        "Capricorn pAMM read failed for seed pool {}",
                        addr_hex(pool)
                    )));
                }
                Err(Reject::UnregisteredPair(d)) => tracing::warn!(
                    target: "venues",
                    "Capricorn pAMM: pool {} ({d}) is not a registered pair — skipped",
                    short_hex(&addr_hex(pool))
                ),
                Err(_) => {}
            }
        }
        let mut inner = self.inner.write();
        for p in &admitted {
            inner.by_addr.insert(p.pool, p.clone());
        }
        inner.discovered = true;
        Ok(admitted)
    }

    /// Records the quotability probe: not paused and answering a priced quote.
    pub fn set_quotable(&self, admitted: &[Pool], paused: &[Option<bool>], quotes: &[Option<U256>]) {
        let (mut live, mut n_paused, mut no_quote) = (Vec::new(), 0, 0);
        for (i, p) in admitted.iter().enumerate() {
            if paused.get(i).copied().flatten().unwrap_or(false) {
                n_paused += 1;
                continue;
            }
            if !quotes.get(i).copied().flatten().is_some_and(|q| !q.is_zero()) {
                no_quote += 1;
                continue;
            }
            live.push(p.pool);
        }
        let why: Vec<String> = [(n_paused, "paused"), (no_quote, "not quoting")]
            .iter()
            .filter(|(n, _)| *n > 0)
            .map(|(n, w)| format!("{n} {w}"))
            .collect();
        tracing::info!(
            target: "venues",
            "Capricorn pAMM: {}/{} admitted pool(s) quotable{}",
            live.len(),
            admitted.len(),
            if why.is_empty() { String::new() } else { format!(" ({})", why.join(", ")) }
        );
        if no_quote > 0 {
            tracing::warn!(
                target: "venues",
                "Capricorn pAMM: {no_quote} unpaused pool(s) are not returning a quote — quoteExactIn is not answering, \
                 so they cannot be quoted (they can still trade, and their fills are still tailed)"
            );
        }
        self.inner.write().quotable = live;
    }

    /// Pools the committed state knows but memory doesn't (after a restart).
    fn load_state(&self, cx: &DecodeCx<'_>) {
        if self.inner.read().state_loaded {
            return;
        }
        let rows = read_created(cx.state);
        let mut inner = self.inner.write();
        for c in &rows {
            if !inner.by_addr.contains_key(&c.pool) {
                inner.admit_created(cx.registry, c);
            }
        }
        inner.state_loaded = true;
    }
}

#[async_trait]
impl Venue for Capricorn {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let pools = self.candidates();
        let tok_calls: Vec<(Address, getTokensCall)> =
            pools.iter().map(|p| (Address::from(*p), getTokensCall {})).collect();
        let fee_calls: Vec<(Address, feeBpsCall)> = pools.iter().map(|p| (Address::from(*p), feeBpsCall {})).collect();
        let tokens = call_many(cx.rpc, &tok_calls, At::Latest).await?;
        let fees = call_many(cx.rpc, &fee_calls, At::Latest).await?;
        let reads = Reads {
            pools,
            tokens: tokens.into_iter().map(|r| r.ok().map(|t| (to_addr(t.token0), to_addr(t.token1)))).collect(),
            fees: fees.into_iter().map(|r| r.ok().map(to_f64)).collect(),
        };
        let admitted = self.apply(cx.registry, &reads)?;

        // Quotability: not paused AND the pool's own quoteExactIn prices a
        // probe (a PAMM with no oracle price reverts rather than quoting wide).
        let paused_calls: Vec<(Address, pausedCall)> =
            admitted.iter().map(|p| (Address::from(p.pool), pausedCall {})).collect();
        let quote_calls: Vec<(Address, quoteExactInCall)> = admitted
            .iter()
            .map(|p| {
                let amount_in = to_units(QUOTE_PROBE_USD, p.stable_dec);
                (Address::from(p.pool), quoteExactInCall { tokenIn: Address::from(p.stable_addr), amountIn: amount_in })
            })
            .collect();
        let paused = call_many(cx.rpc, &paused_calls, At::Latest).await?;
        let quotes = call_many(cx.rpc, &quote_calls, At::Latest).await?;
        self.set_quotable(
            &admitted,
            &paused.into_iter().map(|r| r.ok()).collect::<Vec<_>>(),
            &quotes.into_iter().map(|r| r.ok()).collect::<Vec<_>>(),
        );
        Ok(())
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        let inner = self.inner.read();
        if !inner.discovered {
            return Err(VenueError::NotReady("Capricorn discovery unavailable".into()));
        }
        let mut w = WatchSet::default();
        // Always followed, even with no admitted pool: a missed PoolCreated
        // makes that pool's swaps undecodable.
        w.logs.insert(to_addr(FACTORY), TopicFilter::Topics(HashSet::from([logs::topic0::<PoolCreated>()])));
        // Admitted, not quotable: an unpriceable pool still trades.
        for addr in inner.by_addr.keys() {
            w.logs.insert(*addr, TopicFilter::Topics(HashSet::from([logs::topic0::<Swap>()])));
        }
        w.logs.insert(to_addr(PUSH_FEED), TopicFilter::Topics(HashSet::from([PUSH_FEED_UPDATE_TOPIC])));
        Ok(w)
    }

    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        self.load_state(cx);
        // A pool announced in this block is admitted before its swaps.
        let (factory, created_topic) = (to_addr(FACTORY), logs::topic0::<PoolCreated>());
        for l in block.logs.iter().filter(|l| l.address == factory && l.topic0() == Some(&created_topic)) {
            let Some(e) = logs::decode::<PoolCreated>(l) else { continue };
            let c = Created {
                pool: to_addr(e.pool),
                token0: to_addr(e.token0),
                token1: to_addr(e.token1),
                fee_bps: e.feeBps,
            };
            let mut recorded = read_created(cx.state);
            if !recorded.iter().any(|r| r.pool == c.pool) {
                recorded.push(c.clone());
                write_created(cx.state, &recorded);
            }
            let mut inner = self.inner.write();
            if !inner.candidates.contains(&c.pool) {
                tracing::info!(
                    target: "venues",
                    "Capricorn pAMM: factory deployed pool {} at block {}",
                    short_hex(&addr_hex(&c.pool)),
                    block.number
                );
                inner.admit_created(cx.registry, &c);
            }
        }

        let inner = self.inner.read();
        let mut out = Vec::new();
        for l in &block.logs {
            let Some(p) = inner.by_addr.get(&l.address) else { continue };
            let Some(s) = logs::decode::<Swap>(l) else { continue };
            let (base_delta, stable_delta) =
                if p.base_is_token0 { (s.amount0, s.amount1) } else { (s.amount1, s.amount0) };
            if base_delta.is_zero() || stable_delta.is_zero() {
                continue;
            }
            // A real swap moves the legs in opposite directions; same-sign is
            // a donation/skim shape, not a trade to price.
            if base_delta.is_positive() == stable_delta.is_positive() {
                continue;
            }
            let base_amount = from_units(base_delta.unsigned_abs(), p.base_dec);
            let usd = from_units(stable_delta.unsigned_abs(), p.stable_dec);
            if base_amount <= 0.0 || usd <= 0.0 {
                continue;
            }
            out.push(Fill {
                id: fill_id(ID, &l.tx_hash, l.log_index),
                venue_id: ID.into(),
                market: p.market.clone(),
                // The pool gained base ⇒ the taker sold.
                side: if base_delta.is_positive() { Side::Sell } else { Side::Buy },
                // Attribution is the core's job: never claim DIRECT here.
                category: FillCategory::Unknown,
                usd,
                base_amount,
                exec_px: usd / base_amount,
                px_approx: false,
                tx_hash: b32_hex(&l.tx_hash),
                // viem hands decoded addresses checksummed; today's label keeps that case.
                to: short_hex(&s.recipient.to_string()),
                router: None,
                pool: format!("cap {}", &addr_hex(&p.pool)[..8]),
                block_number: block.number,
                ts: block.time_ms(),
                markouts_bps: vec![None; 5],
                time_source: None,
            });
        }
        Ok(out)
    }

    /// quoteExactIn per quotable pool × size × side, pinned to the block:
    /// buying the base spends `size` of the stable, selling spends the base
    /// worth `size`. Price = stable per base, all-in. Several pools on one
    /// market (the factory keys pools on token pair AND fee) make one row
    /// with the best price per side.
    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        let pools: Vec<Pool> = {
            let inner = self.inner.read();
            inner.quotable.iter().filter_map(|a| inner.by_addr.get(a).cloned()).collect()
        };
        struct Leg {
            pool: usize,
            size: f64,
            buy: bool,
            in_raw: U256,
            mid: f64,
        }
        let mut legs = Vec::new();
        let mut calls = Vec::new();
        for (i, p) in pools.iter().enumerate() {
            // The bps anchor is the pair-terms reference mid (wrap basis and
            // stable cross), not a raw USDT price.
            let mid = cx.pricer.pair_mid(&p.market);
            if mid <= 0.0 {
                continue;
            }
            for &size in sizes_usd {
                let buy_in = to_units(size, p.stable_dec);
                let sell_in = to_units(cx.pricer.token_for_usd(&p.base_token, size), p.base_dec);
                for (buy, token_in, in_raw) in [(true, p.stable_addr, buy_in), (false, p.base_addr, sell_in)] {
                    // An unsized leg can't make a row: not asked.
                    if in_raw.is_zero() {
                        continue;
                    }
                    calls.push((
                        from_addr(&p.pool),
                        quoteExactInCall { tokenIn: from_addr(&token_in), amountIn: in_raw },
                    ));
                    legs.push(Leg { pool: i, size, buy, in_raw, mid });
                }
            }
        }
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let res = call_many(cx.rpc, &calls, At::Hash(cx.block.hash)).await?;
        // Every leg failing is venue-wide (paused, oracle down, ABI drift),
        // not a per-pair gap: name it instead of vanishing.
        quote_health::check_outage(&meta().name, &res)?;
        let ts = now_ms();
        let mut rows: Vec<QuoteRow> = Vec::new();
        for (l, r) in legs.iter().zip(res) {
            let Ok(out) = r else { continue };
            if out.is_zero() {
                continue;
            }
            let p = &pools[l.pool];
            let (in_dec, out_dec) = if l.buy { (p.stable_dec, p.base_dec) } else { (p.base_dec, p.stable_dec) };
            let (in_h, out_h) = (from_units(l.in_raw, in_dec), from_units(out, out_dec));
            if in_h <= 0.0 || out_h <= 0.0 {
                continue;
            }
            let px = if l.buy { in_h / out_h } else { out_h / in_h };
            let bps = (px / l.mid - 1.0) * 1e4;
            // A saturated leg (the pool handed back its whole reserve) is not
            // a comparable execution.
            if !bps.is_finite() || bps.abs() > PER_SIDE_BAND_BPS {
                continue;
            }
            let idx = match rows.iter().position(|x| x.market == p.market && x.size_usd == l.size) {
                Some(i) => i,
                None => {
                    rows.push(QuoteRow {
                        venue_id: ID.into(),
                        market: p.market.clone(),
                        size_usd: l.size,
                        bid_bps: 0.0,
                        ask_bps: 0.0,
                        bid_px: 0.0,
                        ask_px: 0.0,
                        spread_bps: 0.0,
                        // A leg inside the band consumed only part of the
                        // reserve: it is the full requested notional.
                        filled_full: true,
                        one_sided: None,
                        fee_bps: 0.0,
                        cex_ask_bps: None,
                        cex_bid_bps: None,
                        ts,
                    });
                    rows.len() - 1
                }
            };
            let row = &mut rows[idx];
            // Cheapest ask and richest bid across the market's pools: a taker
            // routes to the best, and the row must not depend on call order.
            if l.buy {
                if row.ask_px == 0.0 || px < row.ask_px {
                    row.ask_bps = bps;
                    row.ask_px = px;
                }
            } else if px > row.bid_px {
                row.bid_bps = bps;
                row.bid_px = px;
            }
            // One fee for a row from two pools can only be the worse one.
            row.fee_bps = row.fee_bps.max(p.fee_bps);
        }
        for row in &mut rows {
            if row.ask_px > 0.0 && row.bid_px > 0.0 {
                row.spread_bps = row.ask_bps - row.bid_bps;
            } else {
                // One real leg and one exhausted: a genuine half-market.
                row.one_sided = Some(true);
            }
        }
        // The registry's pair order, then size (today's follows the pools,
        // which list the same way).
        let pair_at = |m: &str| cx.registry.pairs.iter().position(|p| p.symbol == m);
        let size_at = |s: f64| sizes_usd.iter().position(|x| *x == s);
        rows.sort_by_key(|r| (pair_at(&r.market), size_at(r.size_usd)));
        Ok(rows)
    }

    fn markets(&self) -> Vec<String> {
        let set: BTreeSet<String> = self.inner.read().by_addr.values().map(|p| p.market.clone()).collect();
        set.into_iter().collect()
    }

    /// The pools themselves: Capricorn's own router has no published mainnet
    /// address, so nothing is claimed that could mislabel third-party flow.
    fn entry_points(&self) -> Vec<EntryPoint> {
        self.inner.read().by_addr.keys().map(|a| EntryPoint { address: *a, router: None }).collect()
    }

    /// The keeper's pushes to the feed, by their event (~300 a day).
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(Some(GasSources { logs: vec![(to_addr(PUSH_FEED), PUSH_FEED_UPDATE_TOPIC)], ..GasSources::default() }))
    }

    /// The factory's first PoolCreated: block 65,199,911.
    fn history_from_utc(&self) -> Option<&'static str> {
        Some("2026-04-01")
    }
}
