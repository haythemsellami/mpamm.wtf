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
//! value quarantines the pool (it is no longer watched or decoded).
//!
//! Quotes: the pool's own exact-input quoters (quoteXToY / quoteYToX),
//! called from the whitelisted route (address(0): the production fee tier),
//! so a proxy upgrade can never stale a local math port. One batch per
//! frame, pinned to the block: each pool's validation reads (as discovery's)
//! beside its legs; the reads gate the legs (valid, live, whitelist route
//! open, state fresh) and a gated pool's legs are discarded. Each read
//! carries the 8M gas limit; a leg measured 88–99k while the pool was live
//! (2026-07) and 69k paused.
//!
//! A quote frame never writes the decode cache or the watch set. Today's
//! quote() re-admits and quarantines pools from its reads; here quote jobs
//! read proposed blocks (which can be abandoned) while final blocks decode
//! in order, so letting them move what is watched would make which trades
//! count depend on quote timing. Discovery (every 10 minutes) and decode
//! keep that job; a frame whose reads say a pool is invalid hides its quote.
//! Rows come only from the frame's own reads, so today's discard of a frame
//! older than the cached snapshot has nothing left to guard.

use std::collections::{HashMap, HashSet};

use alloy_primitives::{address, Address, U256};
use alloy_sol_types::{sol, SolCall};
use async_trait::async_trait;
use mpamm_chain::{parse_b32, quantity, Rpc, RpcError};
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, FinalLog, GasSources, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_ring::{Addr, TopicFilter, WatchSet, B32};
use mpamm_types::{Fill, FillCategory, QuoteRow, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;
use serde_json::{json, Value};

use crate::{
    chain::{At, CALL_GAS},
    logs, quote_health,
    util::{b32_hex, fill_id, from_units, short_hex, to_addr, to_f64, to_units},
};

/// Per-side sanity band (bps from the pair mid): a curve can price an exact
/// input against a nearly exhausted reserve; a side that far off is not a
/// comparable execution.
pub const PER_SIDE_BAND_BPS: f64 = 2000.0;

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
    function quoteXToY(uint256 amountIn) view returns (uint256 amountOut, uint160 sqrtPriceNext, uint256 fee);
    function quoteYToX(uint256 amountIn) view returns (uint256 amountOut, uint160 sqrtPriceNext, uint256 fee);
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

/// Where a read is pinned, as the JSON-RPC block parameter (chain::At's).
fn block_tag(at: At) -> Value {
    match at {
        At::Latest => json!("latest"),
        At::Number(n) => json!(quantity(n)),
        At::Hash(h) => json!({ "blockHash": format!("0x{}", mpamm_ring::hex(&h)), "requireCanonical": false }),
    }
}

/// One eth_call carrying the explicit gas every read carries (CALL_GAS: the
/// node's pool for light calls).
fn eth_call<C: SolCall>(to: &Addr, call: &C, from: Option<&Addr>, at: &Value) -> (&'static str, Value) {
    let mut req = json!({
        "to": addr_str(to),
        "data": format!("0x{}", mpamm_ring::hex(&call.abi_encode())),
        "gas": quantity(CALL_GAS),
    });
    if let Some(from) = from {
        req["from"] = json!(addr_str(from));
    }
    ("eth_call", json!([req, at]))
}

fn decode_ret<C: SolCall>(r: Option<&Result<Value, RpcError>>) -> Option<C::Return> {
    let bytes = mpamm_core::block::hex_bytes(r?.as_ref().ok()?.as_str()?)?;
    C::abi_decode_returns(&bytes).ok()
}

/// Where one pool's gate reads sit in a batch.
struct GateIdx {
    start: usize,
    x_dec: Option<usize>,
    y_dec: Option<usize>,
    slot: usize,
}

/// Today's readPoolsAtBlock reads of one pool (its views, the tokens'
/// decimals, the ERC-1967 implementation slot), appended to a batch.
fn gate_calls(c: &PoolConfig, at: &Value, calls: &mut Vec<(&'static str, Value)>) -> GateIdx {
    let p = &c.pool;
    let start = calls.len();
    calls.extend([
        eth_call(p, &XCall {}, None, at),
        eth_call(p, &YCall {}, None, at),
        eth_call(p, &stateCall {}, None, at),
        eth_call(p, &getXReserveCall {}, None, at),
        eth_call(p, &getYReserveCall {}, None, at),
        eth_call(p, &concentrationKCall {}, None, at),
        eth_call(p, &blockDelayCall {}, None, at),
        eth_call(p, &pausedCall {}, None, at),
        eth_call(p, &blacklistFeeMultiplierCall {}, None, at),
        eth_call(p, &isWhitelistedCall { account: Address::from(c.whitelist_caller) }, None, at),
    ]);
    let mut decimals = |token: &Addr| {
        (*token != ZERO).then(|| {
            calls.push(eth_call(token, &decimalsCall {}, None, at));
            calls.len() - 1
        })
    };
    let (x_dec, y_dec) = (decimals(&c.expected_x), decimals(&c.expected_y));
    calls.push(("eth_getStorageAt", json!([addr_str(p), ERC1967_IMPLEMENTATION_SLOT, at])));
    GateIdx { start, x_dec, y_dec, slot: calls.len() - 1 }
}

/// What the gate reads returned; a failed call is an unreadable value.
fn gate_reads(r: &[Result<Value, RpcError>], ix: &GateIdx) -> PoolReads {
    let at = |i: usize| r.get(ix.start + i);
    let u256_of = |v: alloy_primitives::Uint<112, 2>| U256::from(v);
    PoolReads {
        x: decode_ret::<XCall>(at(0)).map(to_addr),
        y: decode_ret::<YCall>(at(1)).map(to_addr),
        state: decode_ret::<stateCall>(at(2)).map(|s| {
            (
                U256::from(s.anchorPrice),
                s.feeAskX24.to::<u32>(),
                s.feeBidX24.to::<u32>(),
                s.latestUpdateBlock.to::<u64>(),
            )
        }),
        reserve_x: decode_ret::<getXReserveCall>(at(3)).map(u256_of),
        reserve_y: decode_ret::<getYReserveCall>(at(4)).map(u256_of),
        concentration_k: decode_ret::<concentrationKCall>(at(5)),
        block_delay: decode_ret::<blockDelayCall>(at(6)).map(|d| d.to::<u64>()),
        paused: decode_ret::<pausedCall>(at(7)),
        blacklist_fee_multiplier: decode_ret::<blacklistFeeMultiplierCall>(at(8)),
        whitelist_probe: decode_ret::<isWhitelistedCall>(at(9)),
        x_decimals: ix.x_dec.and_then(|i| decode_ret::<decimalsCall>(r.get(i))),
        y_decimals: ix.y_dec.and_then(|i| decode_ret::<decimalsCall>(r.get(i))),
        implementation_slot: r.get(ix.slot).and_then(|v| v.as_ref().ok()).and_then(parse_b32),
    }
}

/// The first failed gate read's error: what "unreadable" stands for.
fn gate_error(r: &[Result<Value, RpcError>], ix: &GateIdx) -> Option<String> {
    r.get(ix.start..=ix.slot)?.iter().find_map(|x| x.as_ref().err()).map(ToString::to_string)
}

/// The pinned-block reads of one pool in one batch (today's multicall): a
/// failed batch fails discovery; a failed call is an unreadable value.
async fn read_pool(rpc: &Rpc, c: &PoolConfig, block: u64) -> Result<PoolReads, VenueError> {
    let mut calls = Vec::new();
    let ix = gate_calls(c, &block_tag(At::Number(block)), &mut calls);
    let r = rpc.batch(&calls).await.map_err(|e| VenueError::Chain(format!("Lunarbase pool reads: {e}")))?;
    Ok(gate_reads(&r, &ix))
}

/// The node's answer for a block whose state it cannot read yet.
const NOT_READABLE: &str = "Block requested not found";

/// One batch pinned to `at`. A just-proposed block's state is readable a few
/// ms after its announcement, so a hash-pinned batch retries that error with
/// chain::call_many's pauses (≈ 40 ms in all) before failing.
async fn batch_at(rpc: &Rpc, calls: &[(&str, Value)], at: At) -> Result<Vec<Result<Value, RpcError>>, VenueError> {
    const PAUSES_MS: [u64; 6] = [2, 3, 5, 8, 10, 12];
    let not_readable = |e: &RpcError| e.to_string().contains(NOT_READABLE);
    let mut pauses = PAUSES_MS.into_iter().take(if matches!(at, At::Hash(_)) { PAUSES_MS.len() } else { 0 });
    loop {
        let out = rpc.batch(calls).await;
        let unreadable = match &out {
            Ok(items) => items.iter().any(|r| r.as_ref().is_err_and(not_readable)),
            Err(e) => not_readable(e),
        };
        match pauses.next().filter(|_| unreadable) {
            Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
            None => return out.map_err(|e| VenueError::Chain(format!("Lunarbase quote reads: {e}"))),
        }
    }
}

/// Which pool quoter a side uses (today's lunarbaseQuoteDirection): `true`
/// is quoteXToY. Selling the base spends X when the base is X.
pub fn quote_x_to_y(config: &PoolConfig, sell: bool) -> bool {
    if sell {
        config.base_is_x
    } else {
        !config.base_is_x
    }
}

/// One exact-input quoter leg as a price (stable per base) and its fee in
/// bps of the gross output, to 1e-5 bp (today's quoteLunarbaseLeg after the
/// read). `None`: nothing comes out.
pub fn leg_quote(config: &PoolConfig, sell: bool, amount_in: U256, amount_out: U256, fee: U256) -> Option<(f64, f64)> {
    if amount_in.is_zero() || amount_out.is_zero() {
        return None;
    }
    let (in_dec, out_dec) =
        if sell { (config.base_dec, config.stable_dec) } else { (config.stable_dec, config.base_dec) };
    let (input, output) = (from_units(amount_in, in_dec), from_units(amount_out, out_dec));
    if input <= 0.0 || output <= 0.0 {
        return None;
    }
    let gross = amount_out.saturating_add(fee);
    let fee_bps = if gross.is_zero() {
        0.0
    } else {
        to_f64(fee.saturating_mul(U256::from(1_000_000_000u64)) / gross) / 100_000.0
    };
    Some((if sell { output / input } else { input / output }, fee_bps))
}

/// Why a pool whose reads answered is not quoted at `block`, or `None` when
/// it quotes (today's validation, then its paused / whitelist / stale gate).
fn hidden(v: &Validation, block: u64) -> Option<String> {
    match v {
        Validation::Valid(p) => {
            let s = &p.snapshot;
            if s.paused {
                Some("pool paused".into())
            } else if !s.whitelist_probe {
                Some("whitelist route unavailable".into())
            } else if block >= s.latest_update_block.saturating_add(s.block_delay) {
                Some("state stale".into())
            } else {
                None
            }
        }
        Validation::Invalid(reason) => Some(reason.clone()),
        Validation::Unreadable(_) => None,
    }
}

/// One quoter leg, from the whitelisted route.
fn leg_call(c: &PoolConfig, sell: bool, amount_in: U256, at: &Value) -> (&'static str, Value) {
    if quote_x_to_y(c, sell) {
        eth_call(&c.pool, &quoteXToYCall { amountIn: amount_in }, Some(&c.whitelist_caller), at)
    } else {
        eth_call(&c.pool, &quoteYToXCall { amountIn: amount_in }, Some(&c.whitelist_caller), at)
    }
}

/// A leg's (amountOut, fee), or why it failed: its call, then the node's
/// error (as chain::call_many names a failed read).
fn leg_answer(c: &PoolConfig, sell: bool, r: &Result<Value, RpcError>) -> Result<(U256, U256), VenueError> {
    fn decode<C: SolCall>(r: &Result<Value, RpcError>) -> Result<C::Return, VenueError> {
        let v = r.as_ref().map_err(|e| VenueError::Chain(format!("{}: {e}", C::SIGNATURE)))?;
        let bytes = v
            .as_str()
            .and_then(mpamm_core::block::hex_bytes)
            .ok_or_else(|| VenueError::Chain(format!("{}: eth_call result", C::SIGNATURE)))?;
        C::abi_decode_returns(&bytes).map_err(|e| VenueError::Chain(format!("{}: {e}", C::SIGNATURE)))
    }
    if quote_x_to_y(c, sell) {
        decode::<quoteXToYCall>(r).map(|q| (q.amountOut, q.fee))
    } else {
        decode::<quoteYToXCall>(r).map(|q| (q.amountOut, q.fee))
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

impl Lunarbase {
    /// One quote frame at `block`, every read pinned by `at` (today's
    /// quote()): each admitted pool's validation reads and its legs in ONE
    /// batch. A sell spends the base worth `size`, a buy `size` of the
    /// stable. The reads gate the legs: a pool that is invalid, paused, off
    /// the whitelist route or stale is hidden (said once, the heal
    /// announced) and its legs discarded. A side priced beyond ±2000 bps of
    /// the pair mid is dropped, leaving a one-sided row; the quoters are
    /// exact-input, so a row always fills in full. Every pool unreadable, or
    /// every leg of the live pools failing, is the venue's error.
    pub async fn quote_at(
        &self,
        rpc: &Rpc,
        registry: &Registry,
        pricer: &dyn Pricer,
        at: At,
        block: u64,
        sizes_usd: &[f64],
    ) -> Result<Vec<QuoteRow>, VenueError> {
        let mut pools: Vec<PoolConfig> = {
            let inner = self.inner.read();
            if !inner.discovered {
                return Ok(Vec::new());
            }
            inner.by_address.values().map(|p| p.config.clone()).collect()
        };
        if pools.is_empty() {
            return Ok(Vec::new());
        }
        // Rows in registry pair order.
        let order = |m: &str| registry.pairs.iter().position(|p| p.symbol == m).unwrap_or(usize::MAX);
        pools.sort_by_key(|c| (order(&c.market), c.pool));

        struct Size {
            usd: f64,
            sell: Option<(usize, U256)>,
            buy: Option<(usize, U256)>,
        }
        let tag = block_tag(at);
        let mut calls = Vec::new();
        let mut plans: Vec<(GateIdx, Vec<Size>)> = Vec::new();
        for c in &pools {
            let gate = gate_calls(c, &tag, &mut calls);
            let mut sizes = Vec::new();
            for &usd in sizes_usd {
                let mut leg = |sell: bool, amount: U256| {
                    // A side that cannot be sized is not asked.
                    (!amount.is_zero()).then(|| {
                        calls.push(leg_call(c, sell, amount, &tag));
                        (calls.len() - 1, amount)
                    })
                };
                let sell = leg(true, to_units(pricer.token_for_usd(&c.base_token, usd), c.base_dec));
                let buy = leg(false, to_units(usd, c.stable_dec));
                sizes.push(Size { usd, sell, buy });
            }
            plans.push((gate, sizes));
        }
        let r = batch_at(rpc, &calls, at).await?;

        let ts = now_ms();
        let mut rows = Vec::new();
        let mut unreadable: Vec<Result<(), VenueError>> = Vec::new();
        let mut live_legs: Vec<Result<(), VenueError>> = Vec::new();
        let mut inner = self.inner.write();
        for (c, (gate, sizes)) in pools.iter().zip(&plans) {
            let v = validate(registry, c, &gate_reads(&r, gate), block);
            if let Validation::Unreadable(reason) = &v {
                inner.note_once(
                    format!("unread:{}", c.pool_str),
                    &format!("Lunarbase {} state unreadable: {reason}", c.market),
                );
                let why = gate_error(&r, gate).unwrap_or_else(|| reason.clone());
                unreadable.push(Err(VenueError::Chain(format!("{} state unreadable: {why}", c.market))));
                continue;
            }
            inner.recovered(&format!("unread:{}", c.pool_str), &format!("Lunarbase {} state readable again", c.market));
            if let Some(why) = hidden(&v, block) {
                inner.note_once(
                    format!("inactive:{}", c.pool_str),
                    &format!("Lunarbase {} quote hidden: {why}", c.market),
                );
                continue;
            }
            inner.recovered(
                &format!("inactive:{}", c.pool_str),
                &format!("Lunarbase {} quoting again (pool live, whitelist route open, state fresh)", c.market),
            );
            let mid = pricer.pair_mid(&c.market);
            if mid.is_nan() || mid <= 0.0 {
                continue;
            }
            for s in sizes {
                let mut side = |leg: Option<(usize, U256)>, sell: bool| {
                    let (i, amount) = leg?;
                    let answer = leg_answer(c, sell, r.get(i)?);
                    live_legs.push(answer.as_ref().map(|_| ()).map_err(Clone::clone));
                    let (out, fee) = answer.ok()?;
                    leg_quote(c, sell, amount, out, fee)
                };
                let (bid, ask) = (side(s.sell, true), side(s.buy, false));
                let bps = |q: Option<(f64, f64)>| q.map_or(0.0, |(px, _)| (px / mid - 1.0) * 1e4);
                let real =
                    |q: Option<(f64, f64)>| q.is_some() && bps(q).is_finite() && bps(q).abs() <= PER_SIDE_BAND_BPS;
                let (bid_real, ask_real) = (real(bid), real(ask));
                if !bid_real && !ask_real {
                    continue;
                }
                let both = bid_real && ask_real;
                let (bid_bps, ask_bps) = (if bid_real { bps(bid) } else { 0.0 }, if ask_real { bps(ask) } else { 0.0 });
                let px = |q: Option<(f64, f64)>, real: bool| if real { q.map_or(0.0, |(px, _)| px) } else { 0.0 };
                let fee = |q: Option<(f64, f64)>| q.map_or(0.0, |(_, f)| f);
                rows.push(QuoteRow {
                    venue_id: ID.into(),
                    market: c.market.clone(),
                    size_usd: s.usd,
                    bid_bps,
                    ask_bps,
                    bid_px: px(bid, bid_real),
                    ask_px: px(ask, ask_real),
                    spread_bps: if both { ask_bps - bid_bps } else { 0.0 },
                    // Exact-input quoters: `oneSided` is availability, not a partial fill.
                    filled_full: true,
                    one_sided: Some(!both),
                    // Both legs' fee, an out-of-band side's included, as today.
                    fee_bps: fee(bid).max(fee(ask)),
                    cex_ask_bps: None,
                    cex_bid_bps: None,
                    ts,
                });
            }
        }
        drop(inner);
        // No pool could be read: the chain's fault, named.
        if unreadable.len() == pools.len() {
            let why = quote_health::outage_reason(&unreadable).unwrap_or_default();
            return Err(VenueError::Chain(format!("{} quotes unavailable — {why}", meta().name)));
        }
        quote_health::check_outage(&meta().name, &live_legs)?;
        Ok(rows)
    }
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

    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        self.quote_at(cx.rpc, cx.registry, cx.pricer, At::Hash(cx.block.hash), cx.block.number, sizes_usd).await
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
