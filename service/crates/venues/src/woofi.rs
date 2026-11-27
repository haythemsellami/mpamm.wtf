//! WOOFi sPMM, ported from server/src/venues/woofi.ts: WOOFi's synthetic
//! proactive market maker (WooPPV2) on Monad. One pool holds every listed
//! token against USDC and prices each swap off the Wooracle, which WOOFi's
//! keeper pushes with log-less `postStateList` calls.
//!
//!   pool.quoteToken() / wooracle()      → layout, re-read at every discovery
//!   pool.tokenInfos(t) / decimalInfo(t) → listing, fee rate, caps, decimals
//!   pool.query(from, to, amountIn)      → the executable, fee-inclusive quote
//!   pool.WooSwap(…)                     → the landed fill
//!
//! `query` runs the swap's own pricing path AND the reserve check (replayed
//! at block N−1 it reproduced 56 of 60 sampled fills to the wei); a leg the
//! pool cannot fill reverts, never a partial amount.
//!
//! BASE→BASE (WETH→WMON) is ONE pool swap routed through USDC internally,
//! with ONE WooSwap whose `swapVol` is the USDC leg: it maps to the
//! registered crypto/crypto pair and its USD is that `swapVol`, exact.
//!
//! Two things today's adapter did with chain reads inside decode or with
//! durable state inside discovery are split here, since decode reads no chain
//! and discovery has no state:
//!  - A proxy upgrade to an unverified implementation holds its block until a
//!    discovery pass read at or after it has re-checked the layout.
//!  - A Wooracle rotated in after KNOWN_WOORACLES is persisted through the
//!    venue state by the next decode, committed with that block; the gas set
//!    grows with it and waits for it (never a set a restart would shrink).

use std::collections::{HashMap, HashSet};

use alloy_primitives::{address, Address, U256};
use alloy_sol_types::sol;
use async_trait::async_trait;
use mpamm_chain::Rpc;
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, FinalLog, GasSources, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{Addr, TopicFilter, WatchSet};
use mpamm_types::{Fill, FillCategory, QuoteRow, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call, call_many, At},
    logs,
    quote_health::check_outage,
    util::{addr_hex, b32_hex, fill_id, from_addr, from_units, short_hex, to_addr, to_units},
};

pub const ID: &str = "woofi";

/// WooPPV2 (TransparentUpgradeableProxy).
pub const WOOPP: Address = address!("5520385bfcf07ec87c4c53a7d8d65595dff69fa4");

/// The implementation every ABI here was resolved and verified against: the
/// only one the proxy has ever had. Any other is announced and re-checked.
pub const VERIFIED_IMPLEMENTATION: Address = address!("6aebc663dd6b8de86129e671baf68586fb0c8fcc");

/// WooRouterV2: WOOFi's own periphery.
pub const WOO_ROUTER: Address = address!("4c4af8dbc524681930a27b2f1af5bcc8062e6fb7");

/// Every Wooracle this pool has priced from, oldest first. A rotated-out
/// oracle stays listed: a dropped gas destination reads as a removal.
///  - 0x2a3755…: from the pool's initialize until block 76,272,194.
///  - 0xf9b0c8…: since then.
pub const KNOWN_WOORACLES: [Address; 2] =
    [address!("2a375567f5e13f6bd74fda7627df3b1af6bfa5a6"), address!("f9b0c8ee13ae2fc0665764ecbdb417685dea8081")];

/// Venue-state key holding the Wooracles discovered beyond KNOWN_WOORACLES.
pub const OBSERVED_ORACLES_KEY: &str = "observed_wooracles";

/// `tokenInfos(t).feeRate` is in 1e-5: 10 = 1 bp.
const FEE_RATE_PER_BP: f64 = 10.0;

/// The pool's quote token (fixed at initialize) and the unit of `swapVol`.
const QUOTE_KEY: &str = "USDC";

sol! {
    function quoteToken() view returns (address);
    function wooracle() view returns (address);
    function tokenInfos(address token) view returns (uint192 reserve, uint16 feeRate, uint128 maxGamma, uint128 maxNotionalSwap, uint192 capBal);
    function decimalInfo(address token) view returns (uint64 priceDec, uint64 quoteDec, uint64 baseDec);
    function query(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount);
    event WooSwap(address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo, uint256 swapVol, uint256 swapFee);
    event Upgraded(address indexed implementation);
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "WOOFi sPMM".into(),
        color: ThemeColor { light: "#00613A".into(), dark: "#57B791".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2025-12-01".into()),
        quote_note: None,
    }
}

/// The persisted list, or empty when nothing is stored. Unreadable state is
/// an error: treating it as empty would shrink the gas set it exists to keep.
pub fn read_observed_oracles(raw: Option<&str>) -> Result<Vec<Addr>, String> {
    let Some(raw) = raw else { return Ok(Vec::new()) };
    let unreadable =
        || format!("WOOFi persisted Wooracle list is unreadable: {}", raw.chars().take(80).collect::<String>());
    let list: Vec<serde_json::Value> = serde_json::from_str(raw).map_err(|_| unreadable())?;
    list.iter()
        .map(|v| {
            let s = v.as_str().filter(|s| {
                s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
            });
            s.and_then(parse_address).ok_or_else(unreadable)
        })
        .collect()
}

/// A registered market the pool's tokens can form.
#[derive(Debug, Clone, PartialEq)]
pub struct WoofiMarket {
    pub market: String,
    pub base_key: String,
    pub quote_key: String,
    pub base: Addr,
    pub base_dec: u8,
    pub quote: Addr,
    pub quote_dec: u8,
    pub quote_stable: bool,
}

/// The registry keys [base, quote] of a pair's two on-chain tokens
/// (server/src/venues/pair-tokens.ts): cbBTC is an alternative BTC wrapper,
/// so the market symbol, not `Pair.base`, selects it.
pub fn token_keys_for_pair(registry: &Registry, pair: &mpamm_registry::Pair) -> Option<(String, String)> {
    let base = if pair.symbol.starts_with("cbBTC/") {
        Some("CBBTC".to_string())
    } else {
        registry.assets.get(&pair.base).map(|a| a.token.clone())
    };
    let quote = if pair.symbol.ends_with("/cbBTC") {
        Some("CBBTC".to_string())
    } else if pair.is_asset_quoted() {
        registry.assets.get(&pair.quote).map(|a| a.token.clone())
    } else {
        Some(pair.quote.clone())
    };
    Some((base?, quote?))
}

/// Direction-free key for two token addresses.
fn pair_key(a: Addr, b: Addr) -> (Addr, Addr) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Every registered pair whose two ERC-20s could meet in the pool, keyed on
/// the unordered token pair (first match wins: the canonical pair). The swap
/// names both tokens, so this, not discovery, is the whole decode table.
#[derive(Debug, Clone)]
pub struct WoofiMarkets {
    by_tokens: HashMap<(Addr, Addr), WoofiMarket>,
    /// The same markets in registry order.
    ordered: Vec<WoofiMarket>,
}

impl WoofiMarkets {
    pub fn new(registry: &Registry) -> Self {
        let native = parse_address(&registry.native_mon).unwrap_or_default();
        let mut by_tokens = HashMap::new();
        let mut ordered = Vec::new();
        for pair in &registry.pairs {
            let Some((base_key, quote_key)) = token_keys_for_pair(registry, pair) else { continue };
            let (Some(base), Some(quote)) = (registry.tokens.get(&base_key), registry.tokens.get(&quote_key)) else {
                continue;
            };
            let (b, q) = (base.address_bytes(), quote.address_bytes());
            if b == native || q == native || b == q {
                continue;
            }
            let m = WoofiMarket {
                market: pair.symbol.clone(),
                base_key,
                quote_key,
                base: b,
                base_dec: base.decimals,
                quote: q,
                quote_dec: quote.decimals,
                quote_stable: quote.stable,
            };
            if let std::collections::hash_map::Entry::Vacant(e) = by_tokens.entry(pair_key(b, q)) {
                e.insert(m.clone());
                ordered.push(m);
            }
        }
        Self { by_tokens, ordered }
    }

    /// The registered market for a swap's two tokens, in either direction.
    pub fn market_for(&self, a: Addr, b: Addr) -> Option<&WoofiMarket> {
        self.by_tokens.get(&pair_key(a, b))
    }

    pub fn iter(&self) -> impl Iterator<Item = &WoofiMarket> {
        self.ordered.iter()
    }
}

/// One WooSwap log → a trade, or `None` when it is not a priceable trade on a
/// registered pair (skipped, never an error: one odd log must not wedge the
/// cursor).
///
/// usd: a stable-quoted pair's stable leg as transferred. A crypto/crypto
/// swap has no stable leg; its notional is the pool's own USDC valuation,
/// `swapVol`: exact, and unmoved by a later replay's prices.
pub fn decode_woofi_swap(markets: &WoofiMarkets, log: &FinalLog, block_number: u64, ts: f64) -> Option<Fill> {
    if log.address != to_addr(WOOPP) || block_number == 0 {
        return None;
    }
    let s = logs::decode::<WooSwap>(log)?;
    if s.fromAmount.is_zero() || s.toAmount.is_zero() {
        return None;
    }
    let (from_token, to_token) = (to_addr(s.fromToken), to_addr(s.toToken));
    let m = markets.market_for(from_token, to_token)?;
    let sells_base = from_token == m.base;
    let base_amount = from_units(if sells_base { s.fromAmount } else { s.toAmount }, m.base_dec);
    let quote_amount = from_units(if sells_base { s.toAmount } else { s.fromAmount }, m.quote_dec);
    let usd = if m.quote_stable { quote_amount } else { from_units(s.swapVol, QUOTE_DECIMALS) };
    // from_units is never NaN, so this is today's `!(x > 0)`.
    if base_amount <= 0.0 || quote_amount <= 0.0 || usd <= 0.0 {
        return None;
    }
    Some(Fill {
        id: fill_id(ID, &log.tx_hash, log.log_index),
        venue_id: ID.into(),
        market: m.market.clone(),
        side: if sells_base { Side::Sell } else { Side::Buy },
        // Attribution is the core's job: never guess DIRECT here.
        category: FillCategory::Unknown,
        usd,
        base_amount,
        // Realized quote per base, fee-inclusive.
        exec_px: quote_amount / base_amount,
        px_approx: false,
        tx_hash: b32_hex(&log.tx_hash),
        // viem hands decoded addresses checksummed; today's label keeps that case.
        to: short_hex(&s.to.to_string()),
        router: None,
        pool: format!("woofi {}", &addr_hex(&to_addr(WOOPP))[..10]),
        block_number,
        ts,
        markouts_bps: vec![None; 5],
        time_source: None,
    })
}

/// USDC's decimals: the unit of `swapVol` (checked against the pool at
/// every discovery).
const QUOTE_DECIMALS: u8 = 6;

/// One token's listing, from `tokenInfos`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenListing {
    pub fee_rate: u16,
    pub max_notional_swap: u128,
}

/// One `query` leg: (from token, to token, amount in).
pub type QueryCall = (Addr, Addr, U256);

/// The chain reads discovery makes, all at one block, and quoting makes,
/// all at the block it is pinned to. Per-entry `None` (or `Err`) = that read
/// failed; an outer `Err` is the transport.
#[async_trait]
pub trait WoofiReads: Send + Sync {
    async fn block_number(&self) -> Result<u64, VenueError>;
    async fn quote_token(&self, at: u64) -> Result<Addr, VenueError>;
    async fn wooracle(&self, at: u64) -> Result<Addr, VenueError>;
    async fn token_infos(&self, tokens: &[Addr], at: u64) -> Result<Vec<Option<TokenListing>>, VenueError>;
    /// (priceDec, quoteDec, baseDec) per token.
    async fn decimal_infos(&self, tokens: &[Addr], at: u64) -> Result<Vec<Option<(u64, u64, u64)>>, VenueError>;
    /// `pool.query` per leg (the amount out), pinned to one block hash.
    async fn query(
        &self,
        legs: &[QueryCall],
        block_hash: [u8; 32],
    ) -> Result<Vec<Result<U256, VenueError>>, VenueError>;
}

pub struct RpcReads<'a>(pub &'a Rpc);

#[async_trait]
impl WoofiReads for RpcReads<'_> {
    async fn block_number(&self) -> Result<u64, VenueError> {
        self.0.block_number().await.map_err(|e| VenueError::Chain(format!("WOOFi block number: {e}")))
    }

    async fn quote_token(&self, at: u64) -> Result<Addr, VenueError> {
        call(self.0, WOOPP, &quoteTokenCall {}, At::Number(at)).await.map(to_addr)
    }

    async fn wooracle(&self, at: u64) -> Result<Addr, VenueError> {
        call(self.0, WOOPP, &wooracleCall {}, At::Number(at)).await.map(to_addr)
    }

    async fn token_infos(&self, tokens: &[Addr], at: u64) -> Result<Vec<Option<TokenListing>>, VenueError> {
        let calls: Vec<_> = tokens.iter().map(|t| (WOOPP, tokenInfosCall { token: from_addr(t) })).collect();
        Ok(call_many(self.0, &calls, At::Number(at))
            .await?
            .into_iter()
            .map(|r| r.ok().map(|i| TokenListing { fee_rate: i.feeRate, max_notional_swap: i.maxNotionalSwap }))
            .collect())
    }

    async fn decimal_infos(&self, tokens: &[Addr], at: u64) -> Result<Vec<Option<(u64, u64, u64)>>, VenueError> {
        let calls: Vec<_> = tokens.iter().map(|t| (WOOPP, decimalInfoCall { token: from_addr(t) })).collect();
        Ok(call_many(self.0, &calls, At::Number(at))
            .await?
            .into_iter()
            .map(|r| r.ok().map(|d| (d.priceDec, d.quoteDec, d.baseDec)))
            .collect())
    }

    async fn query(
        &self,
        legs: &[QueryCall],
        block_hash: [u8; 32],
    ) -> Result<Vec<Result<U256, VenueError>>, VenueError> {
        let calls: Vec<_> = legs
            .iter()
            .map(|(from, to, amount)| {
                (WOOPP, queryCall { fromToken: from_addr(from), toToken: from_addr(to), fromAmount: *amount })
            })
            .collect();
        call_many(self.0, &calls, At::Hash(block_hash)).await
    }
}

/// A market whose two tokens are both listed, with the swap's fee: a
/// crypto/crypto swap pays the higher of its two tokens' rates, once.
#[derive(Debug, Clone, PartialEq)]
pub struct QuoteMarket {
    pub market: WoofiMarket,
    pub fee_bps: f64,
}

#[derive(Debug, Default)]
struct Inner {
    /// Markets whose two tokens are both listed: merged, never shrunk.
    quotable: Vec<QuoteMarket>,
    /// Every Wooracle the pool has been seen pricing from, append-only and
    /// in the order seen: KNOWN, then persisted, then rotated in.
    oracles: Vec<Addr>,
    /// The oracle the pool prices from as of the last discovery.
    live_oracle: Option<Addr>,
    /// The persisted list has been read (by a decode).
    state_loaded: bool,
    /// The block the last successful discovery read the layout at.
    layout_checked_at: Option<u64>,
}

pub struct Woofi {
    markets: WoofiMarkets,
    inner: RwLock<Inner>,
}

impl Default for Woofi {
    fn default() -> Self {
        Self::new(Registry::get())
    }
}

impl Woofi {
    pub fn new(registry: &Registry) -> Self {
        let inner = Inner { oracles: KNOWN_WOORACLES.iter().map(|a| to_addr(*a)).collect(), ..Inner::default() };
        Self { markets: WoofiMarkets::new(registry), inner: RwLock::new(inner) }
    }

    pub fn markets_table(&self) -> &WoofiMarkets {
        &self.markets
    }

    /// `query` per quotable market × size × side, pinned to the block:
    /// selling spends the base worth `size`, buying the quote worth `size`.
    /// Prices are quote per base, fee-inclusive, anchored on the pair-terms
    /// reference mid.
    pub async fn quote_with(
        &self,
        reads: &dyn WoofiReads,
        pricer: &dyn Pricer,
        block_hash: [u8; 32],
        sizes_usd: &[f64],
    ) -> Result<Vec<QuoteRow>, VenueError> {
        let quotable = self.inner.read().quotable.clone();
        struct Leg {
            market: usize,
            size: f64,
            sell: bool,
            amount_in: U256,
            mid: f64,
        }
        let mut legs = Vec::new();
        let mut calls = Vec::new();
        for (i, q) in quotable.iter().enumerate() {
            let m = &q.market;
            let mid = pricer.pair_mid(&m.market);
            if mid <= 0.0 || pricer.usd_per_token(&m.base_key) <= 0.0 || pricer.usd_per_token(&m.quote_key) <= 0.0 {
                continue;
            }
            for &size in sizes_usd {
                for sell in [true, false] {
                    let (in_key, input, in_dec, output) = if sell {
                        (&m.base_key, m.base, m.base_dec, m.quote)
                    } else {
                        (&m.quote_key, m.quote, m.quote_dec, m.base)
                    };
                    let amount_in = to_units(pricer.token_for_usd(in_key, size), in_dec);
                    if amount_in.is_zero() {
                        continue;
                    }
                    calls.push((input, output, amount_in));
                    legs.push(Leg { market: i, size, sell, amount_in, mid });
                }
            }
        }
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let res = reads.query(&calls, block_hash).await?;
        check_outage("WOOFi sPMM", &res)?;

        // A leg the pool cannot fill REVERTS (short reserve, the capBal cap,
        // the per-token notional/gamma caps) and never answers a partial
        // amount: a surviving leg is the full size, and a size past the caps
        // simply has no row.
        let mut rows: Vec<QuoteRow> = Vec::new();
        for (l, r) in legs.iter().zip(&res) {
            let Ok(out) = r else { continue };
            if out.is_zero() {
                continue;
            }
            let q = &quotable[l.market];
            let m = &q.market;
            let (in_dec, out_dec) = if l.sell { (m.base_dec, m.quote_dec) } else { (m.quote_dec, m.base_dec) };
            let in_h = from_units(l.amount_in, in_dec);
            let out_h = from_units(*out, out_dec);
            if in_h <= 0.0 || out_h <= 0.0 {
                continue;
            }
            let idx = match rows.iter().position(|x| x.market == m.market && x.size_usd == l.size) {
                Some(i) => i,
                None => {
                    rows.push(QuoteRow {
                        venue_id: ID.into(),
                        market: m.market.clone(),
                        size_usd: l.size,
                        bid_bps: 0.0,
                        ask_bps: 0.0,
                        bid_px: 0.0,
                        ask_px: 0.0,
                        spread_bps: 0.0,
                        filled_full: true,
                        one_sided: None,
                        fee_bps: q.fee_bps,
                        cex_ask_bps: None,
                        cex_bid_bps: None,
                        ts: 0.0,
                    });
                    rows.len() - 1
                }
            };
            let row = &mut rows[idx];
            if l.sell {
                row.bid_px = out_h / in_h;
                row.bid_bps = (row.bid_px / l.mid - 1.0) * 1e4;
            } else {
                row.ask_px = in_h / out_h;
                row.ask_bps = (row.ask_px / l.mid - 1.0) * 1e4;
            }
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        for r in &mut rows {
            if r.bid_px > 0.0 && r.ask_px > 0.0 {
                r.spread_bps = r.ask_bps - r.bid_bps;
            } else {
                // The pool holds too little of one side, say.
                r.one_sided = Some(true);
            }
            r.ts = ts;
        }
        Ok(rows)
    }

    /// One discovery pass, every read at one block. Fails loud on a layout
    /// the decode does not understand.
    pub async fn refresh(&self, reads: &dyn WoofiReads, registry: &Registry) -> Result<(), VenueError> {
        let quote = registry.tokens.get(QUOTE_KEY).ok_or_else(|| VenueError::Chain("registry has no USDC".into()))?;
        let at = reads.block_number().await?;
        let quote_token = reads.quote_token(at).await?;
        let oracle = reads.wooracle(at).await?;
        // swapVol (the crypto/crypto notional) is denominated in this token.
        if quote_token != quote.address_bytes() {
            return Err(VenueError::Chain(format!(
                "WOOFi quote token is {}, not {} — swapVol units unverified",
                Address::from(quote_token),
                quote.symbol
            )));
        }

        // The pool's token list is a mapping, not enumerable: probe every
        // registered ERC-20. A token is listed when it has a swap cap.
        let native = parse_address(&registry.native_mon).unwrap_or_default();
        let candidates: Vec<(&String, &mpamm_registry::Token)> = registry
            .tokens
            .iter()
            .filter(|(_, t)| t.address_bytes() != native && t.address_bytes() != quote.address_bytes())
            .collect();
        let addrs: Vec<Addr> = candidates.iter().map(|(_, t)| t.address_bytes()).collect();
        let infos = reads.token_infos(&addrs, at).await?;
        let decs = reads.decimal_infos(&addrs, at).await?;
        let mut listed: HashMap<Addr, f64> = HashMap::from([(quote.address_bytes(), 0.0)]);
        for (i, (key, token)) in candidates.iter().enumerate() {
            let info = infos
                .get(i)
                .copied()
                .flatten()
                .ok_or_else(|| VenueError::Chain(format!("WOOFi tokenInfos({key}) read failed")))?;
            if info.max_notional_swap == 0 {
                continue;
            }
            // The pool's own scale must match the registry's, or every fill of
            // this token is mis-sized.
            let (_, quote_dec, base_dec) = decs.get(i).copied().flatten().unwrap_or((0, 0, 0));
            let pow = |d: u8| 10u128.checked_pow(u32::from(d));
            if Some(u128::from(base_dec)) != pow(token.decimals) || Some(u128::from(quote_dec)) != pow(quote.decimals) {
                return Err(VenueError::Chain(format!(
                    "WOOFi {key} decimals mismatch (pool base 1e{}, registry {})",
                    base_dec.to_string().len() - 1,
                    token.decimals
                )));
            }
            listed.insert(token.address_bytes(), f64::from(info.fee_rate) / FEE_RATE_PER_BP);
        }

        let mut found = Vec::new();
        for m in self.markets.iter() {
            let (Some(b), Some(q)) = (listed.get(&m.base), listed.get(&m.quote)) else { continue };
            found.push(QuoteMarket { market: m.clone(), fee_bps: b.max(*q) });
        }
        if found.is_empty() {
            return Err(VenueError::Chain("WOOFi discovered no registered markets".into()));
        }

        let mut inner = self.inner.write();
        let n = found.len();
        for q in found {
            match inner.quotable.iter_mut().find(|x| x.market.market == q.market.market) {
                Some(slot) => *slot = q,
                None => inner.quotable.push(q),
            }
        }
        inner.live_oracle = Some(oracle);
        inner.layout_checked_at = inner.layout_checked_at.max(Some(at));
        tracing::info!(
            target: "venues",
            "WOOFi sPMM: {n} registered market(s) across {} listed base token(s) at block {at}",
            listed.len() - 1
        );
        Ok(())
    }

    /// Loads the persisted oracle list and, when discovery found a live
    /// oracle not persisted yet, writes it (committed with this block) before
    /// the gas set grows with it.
    fn sync_oracles(&self, cx: &DecodeCx<'_>) -> Result<(), VenueError> {
        let raw = cx.state.get(ID, OBSERVED_ORACLES_KEY);
        let observed = read_observed_oracles(raw.as_deref()).map_err(VenueError::Decode)?;
        let known: Vec<Addr> = KNOWN_WOORACLES.iter().map(|a| to_addr(*a)).collect();
        let mut inner = self.inner.write();
        for o in &observed {
            if !inner.oracles.contains(o) {
                inner.oracles.push(*o);
            }
        }
        inner.state_loaded = true;
        let Some(live) = inner.live_oracle else { return Ok(()) };
        if known.contains(&live) || observed.contains(&live) {
            return Ok(());
        }
        let mut list: Vec<Addr> = inner.oracles.iter().filter(|o| !known.contains(o)).copied().collect();
        if !list.contains(&live) {
            list.push(live);
        }
        let json: Vec<String> = list.iter().map(addr_hex).collect();
        cx.state.set(ID, OBSERVED_ORACLES_KEY, &serde_json::to_string(&json).expect("strings serialize"));
        if !inner.oracles.contains(&live) {
            inner.oracles.push(live);
        }
        tracing::warn!(
            target: "venues",
            "WOOFi sPMM: the pool now prices off Wooracle {} — its pushes are tracked from here on; pin it in KNOWN_WOORACLES so a fresh database tracks it too",
            short_hex(&addr_hex(&live))
        );
        Ok(())
    }
}

#[async_trait]
impl Venue for Woofi {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        self.refresh(&RpcReads(cx.rpc), cx.registry).await
    }

    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        self.quote_with(&RpcReads(cx.rpc), cx.pricer, cx.block.hash, sizes_usd).await
    }

    /// One static source: the pool's swaps, and the proxy's Upgraded so an
    /// implementation change is seen in the block it happens.
    fn watch(&self) -> Result<WatchSet, VenueError> {
        let mut w = WatchSet::default();
        w.logs.insert(
            to_addr(WOOPP),
            TopicFilter::Topics(HashSet::from([logs::topic0::<WooSwap>(), logs::topic0::<Upgraded>()])),
        );
        let inner = self.inner.read();
        w.txn_input.extend(inner.oracles.iter().copied());
        w.txn_input.extend(inner.live_oracle);
        Ok(w)
    }

    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        self.sync_oracles(cx)?;
        let mut out = Vec::new();
        let mut upgraded = None;
        for l in &block.logs {
            if l.address != to_addr(WOOPP) {
                continue;
            }
            if l.topic0() == Some(&logs::topic0::<Upgraded>()) {
                let implementation: Option<Addr> = l.topics.get(1).map(|t| t[12..].try_into().expect("20 bytes"));
                if implementation == Some(to_addr(VERIFIED_IMPLEMENTATION)) {
                    continue;
                }
                // An ABI change is the one thing a refresh cannot absorb: a
                // changed WooSwap would match nothing and read like a quiet venue.
                let label = implementation.map_or("an unreadable implementation".into(), |a| short_hex(&addr_hex(&a)));
                tracing::warn!(
                    target: "venues",
                    "WOOFi sPMM: proxy upgraded to {label} — re-verify quote/fill ABIs against the new implementation"
                );
                upgraded = Some(label);
                continue;
            }
            out.extend(decode_woofi_swap(&self.markets, l, block.number, block.time_ms()));
        }
        // The layout the decode relies on must be re-checked at or after the
        // upgrade (a quote-token change fails discovery and keeps this held).
        if let Some(label) = upgraded {
            if self.inner.read().layout_checked_at < Some(block.number) {
                return Err(VenueError::NotReady(format!(
                    "WOOFi proxy upgraded to {label} at block {}: holding until discovery re-checks the pool layout",
                    block.number
                )));
            }
        }
        Ok(out)
    }

    fn markets(&self) -> Vec<String> {
        self.inner.read().quotable.iter().map(|q| q.market.market.clone()).collect()
    }

    fn entry_points(&self) -> Vec<EntryPoint> {
        vec![
            EntryPoint { address: to_addr(WOOPP), router: None },
            EntryPoint { address: to_addr(WOO_ROUTER), router: Some("WOOFi".into()) },
        ]
    }

    /// WOOFi's keeper pays for every Wooracle push, and the pushes emit no
    /// logs: every transaction to an oracle is a quote update. Held until
    /// discovery has read the live oracle and it is persisted.
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        let inner = self.inner.read();
        match inner.live_oracle {
            Some(live) if inner.state_loaded && inner.oracles.contains(&live) => {
                Ok(Some(GasSources { destinations: inner.oracles.clone(), ..GasSources::default() }))
            }
            _ => Err(VenueError::NotReady("WOOFi Wooracle not resolved yet".into())),
        }
    }

    /// The pool's first WooSwap (block 39,163,952, 2025-12-01).
    fn history_from_utc(&self) -> Option<&'static str> {
        Some("2025-12-01")
    }
}
