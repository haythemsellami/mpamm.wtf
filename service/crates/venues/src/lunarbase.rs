//! Lunarbase, ported from server/src/venues/lunarbase.ts: an oracle-anchored
//! pool (one production pool, MON/USDC; cbBTC/USDC stays test-only). Paused
//! since 2026-08 but still decoded, so a resumption is counted.
//!
//!   Pool.SwapExecuted      → the trade (dx/dy exact)
//!   Pool state events      → a monotonic snapshot cache (quoting gates);
//!                            `Upgraded` quarantines the pool until discovery
//!                            re-validates it, and that block's swaps from it
//!                            are not counted
//!
//! Discovery validates each pool at one pinned block (tokens, decimals,
//! anchor price, whitelist route, proxy implementation). A FAILED read is
//! transient: the cached pool stays tailed. A read that answers with a wrong
//! value quarantines the pool (it is no longer watched or decoded). Quoting
//! is M9.

use std::collections::{HashMap, HashSet};

use alloy_primitives::{address, Address, U256};
use alloy_sol_types::{sol, SolCall};
use async_trait::async_trait;
use mpamm_chain::{parse_b32, quantity, Rpc};
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, FinalLog, GasSources, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_ring::{Addr, TopicFilter, WatchSet, B32};
use mpamm_types::{Fill, FillCategory, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;
use serde_json::json;

use crate::{
    logs,
    util::{b32_hex, fill_id, from_units, short_hex, to_addr},
};

pub const ID: &str = "lunarbase";
/// As written in today's adapter: the pool label keeps this spelling.
pub const MON_POOL_STR: &str = "0x0000a8fd148694aE3E17c079Ce4BBF8187758888";
pub const MON_POOL: Address = address!("0000a8fd148694aE3E17c079Ce4BBF8187758888");
const ERC1967_IMPLEMENTATION_SLOT: &str = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO: Addr = [0; 20];

sol! {
    function X() view returns (address);
    function Y() view returns (address);
    function state() view returns (uint160 anchorPrice, uint24 feeAskX24, uint24 feeBidX24, uint48 latestUpdateBlock);
    function getXReserve() view returns (uint112);
    function getYReserve() view returns (uint112);
    function concentrationK() view returns (uint32);
    function blockDelay() view returns (uint48);
    function paused() view returns (bool);
    function blacklistFeeMultiplier() view returns (uint256);
    function isWhitelisted(address account) view returns (bool);
    function decimals() view returns (uint8);
    event SwapExecuted(address recipient, bool xToY, uint256 dx, uint256 dy, uint256 fee);
    event StateUpdated(uint160 anchorPrice, uint24 feeAskX24, uint24 feeBidX24);
    event Sync(uint128 reserveX, uint128 reserveY);
    event ConcentrationKSet(uint32 concentrationK);
    event BlockDelaySet(uint48 blockDelay);
    event WhitelistSet(address indexed account, bool whitelisted);
    event BlacklistFeeMultiplierSet(uint256 multiplier);
    event Paused(address account);
    event Unpaused(address account);
    event Upgraded(address indexed implementation);
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "Lunarbase".into(),
        color: ThemeColor { light: "#036B8C".into(), dark: "#4CC9F0".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2026-04-30".into()),
        quote_note: None,
    }
}

/// One production pool (today's LunarbasePoolConfig).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolConfig {
    pub pool: Addr,
    /// The address as today's adapter spells it (labels).
    pub pool_str: &'static str,
    /// The caller whose fee tier quotes model (address(0) is whitelisted).
    pub whitelist_caller: Addr,
    pub market: String,
    pub expected_x: Addr,
    pub expected_y: Addr,
    pub base_is_x: bool,
    pub base_token: String,
    pub stable_token: String,
    pub base_dec: u8,
    pub stable_dec: u8,
}

/// Production pools only: MON/USDC.
pub fn production_pools(registry: &Registry) -> Vec<PoolConfig> {
    vec![PoolConfig {
        pool: to_addr(MON_POOL),
        pool_str: MON_POOL_STR,
        whitelist_caller: ZERO,
        market: "MON/USDC".into(),
        expected_x: registry.tokens["MON"].address_bytes(),
        expected_y: registry.tokens["USDC"].address_bytes(),
        base_is_x: true,
        base_token: "MON".into(),
        stable_token: "USDC".into(),
        base_dec: registry.tokens["MON"].decimals,
        stable_dec: registry.tokens["USDC"].decimals,
    }]
}

/// The pinned-block state quoting gates on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub block_number: u64,
    /// Observability only (the quote path calls the pool's own views).
    pub implementation: Addr,
    pub anchor_price: U256,
    pub fee_ask_x24: u32,
    pub fee_bid_x24: u32,
    pub latest_update_block: u64,
    pub reserve_x: U256,
    pub reserve_y: U256,
    pub concentration_k: u32,
    pub block_delay: u64,
    pub paused: bool,
    pub blacklist_fee_multiplier: U256,
    pub whitelist_probe: bool,
}

/// A log's place in the chain; `u64::MAX` = the end of a pinned block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LogPos {
    pub block: u64,
    pub log_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedPool {
    pub config: PoolConfig,
    pub snapshot: Snapshot,
    pub last_applied: LogPos,
    pub needs_rediscovery: bool,
}

/// What the pinned-block reads returned; `None` = that read failed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PoolReads {
    pub x: Option<Addr>,
    pub y: Option<Addr>,
    pub state: Option<(U256, u32, u32, u64)>,
    pub reserve_x: Option<U256>,
    pub reserve_y: Option<U256>,
    pub concentration_k: Option<u32>,
    pub block_delay: Option<u64>,
    pub paused: Option<bool>,
    pub blacklist_fee_multiplier: Option<U256>,
    pub whitelist_probe: Option<bool>,
    pub x_decimals: Option<u8>,
    pub y_decimals: Option<u8>,
    /// The ERC-1967 implementation slot (`None` = the read failed).
    pub implementation_slot: Option<B32>,
}

/// A pool's validation at a pinned block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Validation {
    Valid(Box<CachedPool>),
    /// A read failed: keep the cached snapshot (and keep tailing).
    Unreadable(String),
    /// The reads answered and a value is wrong: quarantine.
    Invalid(String),
}

fn addr_str(a: &Addr) -> String {
    format!("0x{}", mpamm_ring::hex(a))
}

/// Today's readPoolsAtBlock checks, in its order.
pub fn validate(registry: &Registry, config: &PoolConfig, r: &PoolReads, block: u64) -> Validation {
    let mut required_ok = r.x.is_some()
        && r.y.is_some()
        && r.state.is_some()
        && r.reserve_x.is_some()
        && r.reserve_y.is_some()
        && r.concentration_k.is_some()
        && r.block_delay.is_some()
        && r.paused.is_some()
        && r.blacklist_fee_multiplier.is_some()
        && r.whitelist_probe.is_some();
    if config.expected_x != ZERO {
        required_ok &= r.x_decimals.is_some();
    }
    if config.expected_y != ZERO {
        required_ok &= r.y_decimals.is_some();
    }
    let Some(slot) = r.implementation_slot.filter(|_| required_ok) else {
        return Validation::Unreadable("pinned-block reads unavailable — keeping the cached snapshot".into());
    };
    if registry.pair_for("MON", "USDC").map(|p| p.symbol.as_str()) != Some(config.market.as_str()) {
        return Validation::Invalid(format!("market {} is not registered", config.market));
    }
    let (x, y) = (r.x.unwrap_or_default(), r.y.unwrap_or_default());
    if x != config.expected_x || y != config.expected_y {
        return Validation::Invalid(format!("token order mismatch: X={} Y={}", addr_str(&x), addr_str(&y)));
    }
    let implementation: Addr = slot[12..].try_into().expect("20 bytes");
    if implementation == ZERO {
        return Validation::Invalid("incomplete pinned snapshot".into());
    }
    let x_dec = if x == ZERO { Some(18) } else { r.x_decimals };
    let y_dec = if y == ZERO { Some(18) } else { r.y_decimals };
    let (ex, ey) =
        if config.base_is_x { (config.base_dec, config.stable_dec) } else { (config.stable_dec, config.base_dec) };
    if x_dec != Some(ex) || y_dec != Some(ey) {
        let s = |d: Option<u8>| d.map_or("undefined".to_string(), |d| d.to_string());
        return Validation::Invalid(format!("decimals mismatch: X={} Y={}", s(x_dec), s(y_dec)));
    }
    let (anchor_price, fee_ask_x24, fee_bid_x24, latest_update_block) = r.state.unwrap_or_default();
    if anchor_price.is_zero() {
        return Validation::Invalid("anchorPrice unset".into());
    }
    if r.whitelist_probe != Some(true) {
        return Validation::Invalid(format!("whitelist caller {} is unavailable", addr_str(&config.whitelist_caller)));
    }
    Validation::Valid(Box::new(CachedPool {
        config: config.clone(),
        snapshot: Snapshot {
            block_number: block,
            implementation,
            anchor_price,
            fee_ask_x24,
            fee_bid_x24,
            latest_update_block,
            reserve_x: r.reserve_x.unwrap_or_default(),
            reserve_y: r.reserve_y.unwrap_or_default(),
            concentration_k: r.concentration_k.unwrap_or_default(),
            block_delay: r.block_delay.unwrap_or_default(),
            paused: r.paused.unwrap_or_default(),
            blacklist_fee_multiplier: r.blacklist_fee_multiplier.unwrap_or_default(),
            whitelist_probe: true,
        },
        last_applied: LogPos { block, log_index: u64::MAX },
        needs_rediscovery: false,
    }))
}

/// One state log, as `apply_state_logs` reads it.
pub struct StateLog<'a> {
    pub block: u64,
    pub log: &'a FinalLog,
}

/// Applies state events newer than each pool's last applied position, in
/// chain order, to staged copies (today's applyLunarbaseStateLogs). A
/// malformed log is skipped, but its position still counts as applied.
pub fn apply_state_logs(pools: &HashMap<Addr, CachedPool>, logs: &[StateLog<'_>]) -> HashMap<Addr, CachedPool> {
    let mut staged = pools.clone();
    let mut ordered: Vec<&StateLog<'_>> = logs.iter().collect();
    ordered.sort_by_key(|l| (l.block, l.log.log_index));
    for l in ordered {
        let Some(pool) = staged.get_mut(&l.log.address) else { continue };
        let pos = LogPos { block: l.block, log_index: u64::from(l.log.log_index) };
        if pos <= pool.last_applied {
            continue;
        }
        let applied = apply_one(pool, l.log, pos.block);
        if applied {
            pool.snapshot.block_number = pos.block;
        }
        pool.last_applied = pos;
    }
    staged
}

/// `false` when the log is malformed (nothing of it applies).
fn apply_one(pool: &mut CachedPool, log: &FinalLog, block: u64) -> bool {
    let Some(t0) = log.topic0() else { return true };
    let s = &mut pool.snapshot;
    macro_rules! ev {
        ($e:ty) => {
            match logs::decode::<$e>(log) {
                Some(e) => e,
                None => return false,
            }
        };
    }
    if *t0 == logs::topic0::<StateUpdated>() {
        let e = ev!(StateUpdated);
        let anchor = U256::from(e.anchorPrice);
        if anchor.is_zero() {
            return false;
        }
        s.anchor_price = anchor;
        s.fee_ask_x24 = e.feeAskX24.to::<u32>();
        s.fee_bid_x24 = e.feeBidX24.to::<u32>();
        s.latest_update_block = block;
    } else if *t0 == logs::topic0::<Sync>() {
        let e = ev!(Sync);
        s.reserve_x = U256::from(e.reserveX);
        s.reserve_y = U256::from(e.reserveY);
    } else if *t0 == logs::topic0::<ConcentrationKSet>() {
        s.concentration_k = ev!(ConcentrationKSet).concentrationK;
    } else if *t0 == logs::topic0::<BlockDelaySet>() {
        s.block_delay = ev!(BlockDelaySet).blockDelay.to::<u64>();
    } else if *t0 == logs::topic0::<Paused>() {
        ev!(Paused);
        s.paused = true;
    } else if *t0 == logs::topic0::<Unpaused>() {
        ev!(Unpaused);
        s.paused = false;
    } else if *t0 == logs::topic0::<BlacklistFeeMultiplierSet>() {
        s.blacklist_fee_multiplier = ev!(BlacklistFeeMultiplierSet).multiplier;
    } else if *t0 == logs::topic0::<WhitelistSet>() {
        let e = ev!(WhitelistSet);
        if to_addr(e.account) == pool.config.whitelist_caller {
            s.whitelist_probe = e.whitelisted;
        }
    } else if *t0 == logs::topic0::<Upgraded>() {
        ev!(Upgraded);
        pool.needs_rediscovery = true;
    }
    true
}

/// The state events the snapshot cache follows.
pub fn state_topics() -> [B32; 9] {
    [
        logs::topic0::<StateUpdated>(),
        logs::topic0::<Sync>(),
        logs::topic0::<ConcentrationKSet>(),
        logs::topic0::<BlockDelaySet>(),
        logs::topic0::<WhitelistSet>(),
        logs::topic0::<BlacklistFeeMultiplierSet>(),
        logs::topic0::<Paused>(),
        logs::topic0::<Unpaused>(),
        logs::topic0::<Upgraded>(),
    ]
}

/// A SwapExecuted log of `config`'s pool as a trade, or `None` when it is
/// malformed or empty (today's decodeLunarbaseSwap).
pub fn decode_swap(log: &FinalLog, config: &PoolConfig, block: u64, ts: f64) -> Option<Fill> {
    if log.address != config.pool {
        return None;
    }
    let e = logs::decode::<SwapExecuted>(log)?;
    if e.dx.is_zero() || e.dy.is_zero() {
        return None;
    }
    let (base_raw, stable_raw) = if config.base_is_x { (e.dx, e.dy) } else { (e.dy, e.dx) };
    let base_amount = from_units(base_raw, config.base_dec);
    let usd = from_units(stable_raw, config.stable_dec);
    if base_amount <= 0.0 || usd <= 0.0 {
        return None;
    }
    Some(Fill {
        id: fill_id(ID, &log.tx_hash, log.log_index),
        venue_id: ID.into(),
        market: config.market.clone(),
        side: if e.xToY == config.base_is_x { Side::Sell } else { Side::Buy },
        category: FillCategory::Unknown,
        usd,
        base_amount,
        exec_px: usd / base_amount,
        px_approx: false,
        tx_hash: b32_hex(&log.tx_hash),
        // viem hands decoded addresses checksummed; today's label keeps that case.
        to: short_hex(&e.recipient.to_string()),
        router: None,
        pool: format!("lunarbase {}", &config.pool_str[..8]),
        block_number: block,
        ts,
        markouts_bps: vec![None; 5],
        time_source: None,
    })
}

#[derive(Debug, Default)]
struct Inner {
    by_address: HashMap<Addr, CachedPool>,
    /// Admission history: kept through a quarantine (what quoting may list).
    discovered_markets: Vec<String>,
    /// The ordering boundary, kept after a quarantine drops the cache, so an
    /// older read can't re-admit an invalidated pool.
    last_validated_block: HashMap<Addr, u64>,
    /// Raised notes (`unread:<pool>`, `quarantine:<pool>`): today's latch.
    noted: HashSet<String>,
    discovered: bool,
}

impl Inner {
    fn has_newer_snapshot(&self, pool: &Addr, block: u64) -> bool {
        self.last_validated_block.get(pool).is_some_and(|b| *b > block)
            || self.by_address.get(pool).is_some_and(|p| p.snapshot.block_number > block)
    }

    fn note_once(&mut self, key: String, msg: &str) {
        if self.noted.insert(key) {
            tracing::warn!(target: "venues", "{msg}");
        }
    }

    fn recovered(&mut self, key: &str, msg: &str) {
        if self.noted.remove(key) {
            tracing::info!(target: "venues", "{msg}");
        }
    }

    fn quarantine(&mut self, config: &PoolConfig, reason: &str, block: u64) {
        if self.has_newer_snapshot(&config.pool, block) {
            return;
        }
        self.last_validated_block.insert(config.pool, block);
        self.by_address.remove(&config.pool);
        self.note_once(
            format!("quarantine:{}", config.pool_str),
            &format!("Lunarbase {} quarantined: {reason}", config.market),
        );
    }

    fn activate(&mut self, pool: CachedPool) -> bool {
        let addr = pool.config.pool;
        if self.has_newer_snapshot(&addr, pool.snapshot.block_number)
            || self.by_address.get(&addr).is_some_and(|prior| prior.last_applied > pool.last_applied)
        {
            return false;
        }
        if let Some(prior) = self.by_address.get(&addr) {
            if prior.snapshot.implementation != pool.snapshot.implementation {
                tracing::info!(
                    target: "venues",
                    "Lunarbase {} implementation changed {} → {}",
                    pool.config.market,
                    &addr_str(&prior.snapshot.implementation)[..10],
                    &addr_str(&pool.snapshot.implementation)[..10]
                );
            }
        }
        let (market, pool_str, block) = (pool.config.market.clone(), pool.config.pool_str, pool.snapshot.block_number);
        self.by_address.insert(addr, pool);
        if !self.discovered_markets.contains(&market) {
            self.discovered_markets.push(market.clone());
        }
        self.last_validated_block.insert(addr, block);
        self.recovered(
            &format!("quarantine:{pool_str}"),
            &format!("Lunarbase {market} re-admitted — the quarantine condition cleared"),
        );
        self.recovered(&format!("unread:{pool_str}"), &format!("Lunarbase {market} state readable again"));
        true
    }
}

/// The Lunarbase venue.
#[derive(Default)]
pub struct Lunarbase {
    inner: RwLock<Inner>,
}

fn call_params<C: SolCall>(to: &Addr, call: &C, block: u64) -> serde_json::Value {
    json!([
        { "to": addr_str(to), "data": format!("0x{}", mpamm_ring::hex(&call.abi_encode())) },
        quantity(block)
    ])
}

fn decode_ret<C: SolCall>(r: Option<&Result<serde_json::Value, mpamm_chain::RpcError>>) -> Option<C::Return> {
    let bytes = mpamm_core::block::hex_bytes(r?.as_ref().ok()?.as_str()?)?;
    C::abi_decode_returns(&bytes).ok()
}

/// The pinned-block reads of one pool in one batch (today's multicall): a
/// failed batch fails discovery; a failed call is an unreadable value.
async fn read_pool(rpc: &Rpc, c: &PoolConfig, block: u64) -> Result<PoolReads, VenueError> {
    let p = &c.pool;
    let mut calls: Vec<(&str, serde_json::Value)> = vec![
        ("eth_call", call_params(p, &XCall {}, block)),
        ("eth_call", call_params(p, &YCall {}, block)),
        ("eth_call", call_params(p, &stateCall {}, block)),
        ("eth_call", call_params(p, &getXReserveCall {}, block)),
        ("eth_call", call_params(p, &getYReserveCall {}, block)),
        ("eth_call", call_params(p, &concentrationKCall {}, block)),
        ("eth_call", call_params(p, &blockDelayCall {}, block)),
        ("eth_call", call_params(p, &pausedCall {}, block)),
        ("eth_call", call_params(p, &blacklistFeeMultiplierCall {}, block)),
        ("eth_call", call_params(p, &isWhitelistedCall { account: Address::from(c.whitelist_caller) }, block)),
    ];
    let x_dec = (c.expected_x != ZERO).then_some(calls.len());
    if x_dec.is_some() {
        calls.push(("eth_call", call_params(&c.expected_x, &decimalsCall {}, block)));
    }
    let y_dec = (c.expected_y != ZERO).then_some(calls.len());
    if y_dec.is_some() {
        calls.push(("eth_call", call_params(&c.expected_y, &decimalsCall {}, block)));
    }
    let r = rpc.batch(&calls).await.map_err(|e| VenueError::Chain(format!("Lunarbase pool reads: {e}")))?;
    let slot = rpc
        .call("eth_getStorageAt", json!([addr_str(p), ERC1967_IMPLEMENTATION_SLOT, quantity(block)]))
        .await
        .ok()
        .and_then(|v| parse_b32(&v));
    let u256_of = |v: alloy_primitives::Uint<112, 2>| U256::from(v);
    Ok(PoolReads {
        x: decode_ret::<XCall>(r.first()).map(to_addr),
        y: decode_ret::<YCall>(r.get(1)).map(to_addr),
        state: decode_ret::<stateCall>(r.get(2)).map(|s| {
            (
                U256::from(s.anchorPrice),
                s.feeAskX24.to::<u32>(),
                s.feeBidX24.to::<u32>(),
                s.latestUpdateBlock.to::<u64>(),
            )
        }),
        reserve_x: decode_ret::<getXReserveCall>(r.get(3)).map(u256_of),
        reserve_y: decode_ret::<getYReserveCall>(r.get(4)).map(u256_of),
        concentration_k: decode_ret::<concentrationKCall>(r.get(5)),
        block_delay: decode_ret::<blockDelayCall>(r.get(6)).map(|d| d.to::<u64>()),
        paused: decode_ret::<pausedCall>(r.get(7)),
        blacklist_fee_multiplier: decode_ret::<blacklistFeeMultiplierCall>(r.get(8)),
        whitelist_probe: decode_ret::<isWhitelistedCall>(r.get(9)),
        x_decimals: x_dec.and_then(|i| decode_ret::<decimalsCall>(r.get(i))),
        y_decimals: y_dec.and_then(|i| decode_ret::<decimalsCall>(r.get(i))),
        implementation_slot: slot,
    })
}

impl Lunarbase {
    /// Applies one discovery's validations, pinned at `block` (today's
    /// discover after its reads). Merge-only: a failed read keeps the cache.
    pub fn apply_discovery(&self, block: u64, results: Vec<(PoolConfig, Validation)>) {
        let mut inner = self.inner.write();
        let total = results.len();
        let mut valid = 0;
        for (config, v) in results {
            match v {
                Validation::Valid(pool) => {
                    valid += 1;
                    inner.activate(*pool);
                }
                Validation::Unreadable(reason) if !inner.has_newer_snapshot(&config.pool, block) => {
                    inner.note_once(
                        format!("unread:{}", config.pool_str),
                        &format!("Lunarbase {} state unreadable: {reason}", config.market),
                    );
                }
                Validation::Invalid(reason) if !inner.has_newer_snapshot(&config.pool, block) => {
                    inner.quarantine(&config, &reason, block);
                }
                _ => {}
            }
        }
        inner.discovered = true;
        tracing::info!(target: "venues", "Lunarbase: {valid}/{total} validated production pool(s), whitelist fee mode");
    }

    /// The cached pool of `market`, if admitted now.
    pub fn pool(&self, addr: &Addr) -> Option<CachedPool> {
        self.inner.read().by_address.get(addr).cloned()
    }

    /// Raised note keys (`unread:<pool>`, `quarantine:<pool>`).
    pub fn raised(&self) -> Vec<String> {
        let mut v: Vec<String> = self.inner.read().noted.iter().cloned().collect();
        v.sort();
        v
    }

    fn pools(&self) -> Vec<Addr> {
        let mut v: Vec<Addr> = self.inner.read().by_address.keys().copied().collect();
        v.sort();
        v
    }
}

#[async_trait]
impl Venue for Lunarbase {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let block = cx.rpc.block_number().await.map_err(|e| VenueError::Chain(format!("Lunarbase head: {e}")))?;
        let mut results = Vec::new();
        for c in production_pools(cx.registry) {
            let reads = read_pool(cx.rpc, &c, block).await?;
            let v = validate(cx.registry, &c, &reads, block);
            results.push((c, v));
        }
        self.apply_discovery(block, results);
        Ok(())
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        if !self.inner.read().discovered {
            return Err(VenueError::NotReady("Lunarbase discovery unavailable".into()));
        }
        let mut w = WatchSet::default();
        for p in self.pools() {
            let mut topics: HashSet<B32> = state_topics().into_iter().collect();
            topics.insert(logs::topic0::<SwapExecuted>());
            w.logs.insert(p, TopicFilter::Topics(topics));
        }
        Ok(w)
    }

    fn decode(&self, _cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let mut inner = self.inner.write();
        if inner.by_address.is_empty() {
            return Ok(Vec::new());
        }
        let topics = state_topics();
        let state: Vec<StateLog<'_>> = block
            .logs
            .iter()
            .filter(|l| inner.by_address.contains_key(&l.address) && l.topic0().is_some_and(|t| topics.contains(t)))
            .map(|log| StateLog { block: block.number, log })
            .collect();
        let staged = apply_state_logs(&inner.by_address, &state);
        let mut staged: Vec<CachedPool> = staged.into_values().collect();
        staged.sort_by_key(|p| p.config.pool);
        for pool in staged {
            if pool.needs_rediscovery {
                let (config, at) = (pool.config.clone(), pool.snapshot.block_number);
                inner.quarantine(&config, "proxy upgrade observed — revalidating", at);
            } else {
                inner.activate(pool);
            }
        }
        let swap = logs::topic0::<SwapExecuted>();
        let mut fills = Vec::new();
        for l in &block.logs {
            if l.topic0() != Some(&swap) {
                continue;
            }
            let Some(pool) = inner.by_address.get(&l.address) else { continue };
            fills.extend(decode_swap(l, &pool.config, block.number, block.time_ms()));
        }
        Ok(fills)
    }

    fn markets(&self) -> Vec<String> {
        self.inner.read().discovered_markets.clone()
    }

    fn entry_points(&self) -> Vec<EntryPoint> {
        // The pools; aggregators reach them through their own routers.
        self.pools().into_iter().map(|a| EntryPoint { address: a, router: None }).collect()
    }

    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        if !self.inner.read().discovered {
            return Err(VenueError::NotReady("Lunarbase discovery unavailable".into()));
        }
        let pools = self.pools();
        if pools.is_empty() {
            return Ok(None);
        }
        // A quote update is a StateUpdated emitted by the pool.
        Ok(Some(GasSources {
            logs: pools.into_iter().map(|p| (p, logs::topic0::<StateUpdated>())).collect(),
            ..GasSources::default()
        }))
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        Some("2026-04-30")
    }
}
