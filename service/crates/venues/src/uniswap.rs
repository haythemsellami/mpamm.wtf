//! Uniswap v4, ported from server/src/venues/uniswap.ts: the standard-DEX
//! comparison band on the Execution page (role Baseline). Quote-only: no
//! trades, no volume, no markouts, so it watches nothing and decodes nothing.
//!
//!   StateView.getSlot0 / getLiquidity(poolId) → discovery: the deepest
//!                                               initialized hookless tier
//!   V4Quoter.quoteExactInputSingle(…)         → one leg, fee-inclusive
//!
//! v4 is a singleton: a pool is a PoolKey inside the PoolManager and its id
//! is keccak(abi.encode(key)). Native MON is currency 0x0 (the live Monad
//! pools are native; the WMON ones are empty). Hooked pools are excluded: a
//! hook can price anything, and the band must be vanilla AMM math.
//!
//! Gas (measured 2026-11-27): today's adapter sends the quoter legs as
//! Multicall3 aggregates of 12 (viem's 4,096-byte chunks), and an aggregate
//! pays for all of its legs. A leg the pool can fill costs 40k–2.8M. A leg
//! larger than the pool can fill walks the tick bitmap toward the price
//! limit: 3.8–4.3M before reverting NotEnoughLiquidity on a drained 0.05%
//! pool, and more than the node's 30M cap on a 1-tick-spacing pool, where
//! each walker takes 63/64 of what the aggregate has left. Hence today's 22M
//! aggregates, and the 150M ones that fail outright under a lower cap with
//! their healthy neighbours. Here every leg is its own `eth_call` at 8M gas,
//! all of them in one JSON-RPC batch the node runs in parallel: filling legs
//! fit with room to spare, walkers still fail (out of gas instead of a
//! revert: no row for that side either way), and a leg no longer fails
//! because another one shared its call. A leg that would answer only after
//! a walk past 8M (8–15M: crossing thousands of empty bitmap words) now
//! fails; today every such answer is thousands of bps outside the ±20% band,
//! so its row is the same. Discovery's reads are one small call each.

use std::collections::HashMap;

use alloy_primitives::{address, aliases::I24, aliases::U24, keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolValue};
use async_trait::async_trait;
use mpamm_chain::Rpc;
use mpamm_core::{ChainCx, DecodeCx, FinalBlock, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{Addr, WatchSet};
use mpamm_types::{Fill, QuoteRow, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call_many, At},
    util::{from_addr, to_f64},
};

pub const ID: &str = "uniswap-v4";

/// Uniswap v4 on Monad (developers.uniswap.org/contracts/v4/deployments).
const STATE_VIEW: Address = address!("77395f3b2e73ae90843717371294fa97cc419d64");
const QUOTER: Address = address!("a222dd357a9076d1091ed6aa2e16c9742dd26891");

/// The standard fee tiers (pips) with their conventional tick spacings.
const TIERS: [(u32, i32); 4] = [(100, 1), (500, 10), (3000, 60), (10_000, 200)];

/// Per-side sanity band against the pair reference: a "quote" thousands of
/// bps out (a drained pool, dust liquidity) is not a comparable execution.
const PER_SIDE_BAND_BPS: f64 = 2000.0;

sol! {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
    function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) view returns (uint128);
    function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate);
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "Uniswap v4".into(),
        // Olive/lime in both themes, validated (CVD/contrast) against the
        // venue palette and Binance gold, which it is co-plotted with.
        color: ThemeColor { light: "#3F6212".into(), dark: "#4D7C0F".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Baseline,
        taker: None,
        taker_bps: None,
        since_utc: None,
        quote_note: None,
    }
}

/// A hookless pool's key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub currency0: Addr,
    pub currency1: Addr,
    /// Pips: 500 = 0.05%.
    pub fee: u32,
    pub tick_spacing: i32,
}

impl Key {
    fn sol(&self) -> PoolKey {
        PoolKey {
            currency0: from_addr(&self.currency0),
            currency1: from_addr(&self.currency1),
            fee: U24::from(self.fee),
            tickSpacing: I24::try_from(self.tick_spacing).expect("a standard tick spacing fits int24"),
            hooks: Address::ZERO,
        }
    }

    /// keccak256(abi.encode(key)).
    pub fn pool_id(&self) -> B256 {
        keccak256(self.sol().abi_encode())
    }
}

/// The pool quoted for a registered market.
#[derive(Debug, Clone, PartialEq)]
pub struct UniMarket {
    pub market: String,
    pub key: Key,
    /// The pool's tier in bps (500 pips → 5).
    pub fee_bps: f64,
    pub base_is_currency0: bool,
    pub base_dec: u8,
    pub quote_dec: u8,
    /// Registry token keys for USD sizing.
    pub base_tok: String,
    pub quote_tok: String,
}

/// A pair side's on-chain currency, decimals and pricer key. Display symbols
/// map to their on-chain representation: MON → native 0x0 (where v4's MON
/// liquidity lives), ETH → WETH, BTC → WBTC, cbBTC → CBBTC, XAUt → XAUT0;
/// the rest are their upper-cased token keys. A side that resolves to
/// nothing skips the whole market.
fn currency_for(registry: &Registry, display: &str) -> Option<(Addr, u8, String)> {
    if display == "MON" {
        return Some((parse_address(&registry.native_mon)?, 18, "MON".into()));
    }
    let key = match display {
        "ETH" => "WETH".to_string(),
        "BTC" => "WBTC".to_string(),
        "cbBTC" => "CBBTC".to_string(),
        "XAUt" => "XAUT0".to_string(),
        other => other.to_uppercase(),
    };
    registry.tokens.get(&key).map(|t| (t.address_bytes(), t.decimals, key))
}

/// Every registered pair × standard hookless tier, in registry order.
pub fn candidates(registry: &Registry) -> Vec<UniMarket> {
    let mut out = Vec::new();
    for pair in &registry.pairs {
        let Some((b_sym, q_sym)) = pair.symbol.split_once('/') else { continue };
        let (Some(base), Some(quote)) = (currency_for(registry, b_sym), currency_for(registry, q_sym)) else {
            continue;
        };
        for (fee, tick_spacing) in TIERS {
            let (currency0, currency1) = if base.0 <= quote.0 { (base.0, quote.0) } else { (quote.0, base.0) };
            out.push(UniMarket {
                market: pair.symbol.clone(),
                key: Key { currency0, currency1, fee, tick_spacing },
                fee_bps: f64::from(fee) / 100.0,
                base_is_currency0: currency0 == base.0,
                base_dec: base.1,
                quote_dec: quote.1,
                base_tok: base.2.clone(),
                quote_tok: quote.2.clone(),
            });
        }
    }
    out
}

/// 10^d exactly, as JavaScript's `10 ** d` (exact up to 10^22).
fn pow10(d: u8) -> f64 {
    10f64.powi(i32::from(d))
}

/// Today's `BigInt(Math.round(x * 10 ** d))`: rounding, not `toUnits`
/// truncation (half rounds up; x is positive).
fn raw_amount(x: f64, d: u8) -> u128 {
    (x * pow10(d)).round() as u128
}

/// One quoter leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LegRead {
    pub key: Key,
    pub zero_for_one: bool,
    pub exact_amount: u128,
}

/// The chain reads. Per-entry `None` = that read failed; an `Err` is the
/// transport.
#[async_trait]
pub trait UniswapReads: Send + Sync {
    /// (sqrtPriceX96, liquidity) per pool id, at the latest block.
    async fn pool_states(&self, ids: &[B256]) -> Result<Vec<Option<(U256, u128)>>, VenueError>;
    /// `amountOut` per leg.
    async fn quote_legs(&self, legs: &[LegRead], at: At) -> Result<Vec<Option<U256>>, VenueError>;
}

pub struct RpcReads<'a>(pub &'a Rpc);

#[async_trait]
impl UniswapReads for RpcReads<'_> {
    async fn pool_states(&self, ids: &[B256]) -> Result<Vec<Option<(U256, u128)>>, VenueError> {
        let slots: Vec<_> = ids.iter().map(|id| (STATE_VIEW, getSlot0Call { poolId: *id })).collect();
        let liqs: Vec<_> = ids.iter().map(|id| (STATE_VIEW, getLiquidityCall { poolId: *id })).collect();
        let slots = call_many(self.0, &slots, At::Latest).await?;
        let liqs = call_many(self.0, &liqs, At::Latest).await?;
        Ok(slots
            .into_iter()
            .zip(liqs)
            .map(|(s, l)| match (s, l) {
                (Ok(s), Ok(l)) => Some((U256::from(s.sqrtPriceX96), l)),
                _ => None,
            })
            .collect())
    }

    async fn quote_legs(&self, legs: &[LegRead], at: At) -> Result<Vec<Option<U256>>, VenueError> {
        let calls: Vec<_> = legs
            .iter()
            .map(|l| {
                let params = QuoteExactSingleParams {
                    poolKey: l.key.sol(),
                    zeroForOne: l.zero_for_one,
                    exactAmount: l.exact_amount,
                    hookData: Bytes::new(),
                };
                (QUOTER, quoteExactInputSingleCall { params })
            })
            .collect();
        Ok(call_many(self.0, &calls, at).await?.into_iter().map(|r| r.ok().map(|q| q.amountOut)).collect())
    }
}

#[derive(Default)]
pub struct Uniswap {
    /// One pool per market, merged across discoveries (a later pass may
    /// re-pick a deeper tier; it never drops a market).
    markets: RwLock<Vec<UniMarket>>,
}

impl Uniswap {
    /// One discovery pass: the deepest initialized hookless tier per pair
    /// (the first tier wins a tie). A pool whose reads fail is skipped.
    pub async fn refresh(&self, reads: &dyn UniswapReads, registry: &Registry) -> Result<(), VenueError> {
        let cands = candidates(registry);
        let ids: Vec<B256> = cands.iter().map(|c| c.key.pool_id()).collect();
        let states = reads.pool_states(&ids).await?;
        let mut best: Vec<(&UniMarket, u128)> = Vec::new();
        for (c, s) in cands.iter().zip(states) {
            // Uninitialized, or no in-range liquidity.
            let Some((sqrt_p, liq)) = s else { continue };
            if sqrt_p.is_zero() || liq == 0 {
                continue;
            }
            match best.iter_mut().find(|(b, _)| b.market == c.market) {
                Some(slot) if liq > slot.1 => *slot = (c, liq),
                Some(_) => {}
                None => best.push((c, liq)),
            }
        }
        let n = best.len();
        let mut markets = self.markets.write();
        for (m, _) in best {
            match markets.iter_mut().find(|x| x.market == m.market) {
                Some(slot) => *slot = m.clone(),
                None => markets.push(m.clone()),
            }
        }
        tracing::info!(target: "venues", "Uniswap v4: {n} baseline pool(s) (deepest hookless tier per pair)");
        Ok(())
    }

    /// Both sides of every market × size, all legs pinned to `at`. Buying
    /// the base spends the quote leg worth `size`; selling spends the base
    /// worth `size`. Price = quote per base, fee-inclusive.
    pub async fn quote_with(
        &self,
        reads: &dyn UniswapReads,
        pricer: &dyn Pricer,
        at: At,
        sizes_usd: &[f64],
    ) -> Result<Vec<QuoteRow>, VenueError> {
        let markets = self.markets.read().clone();
        struct Leg<'m> {
            m: &'m UniMarket,
            size: f64,
            buy: bool,
            in_human: f64,
        }
        let mut legs = Vec::new();
        let mut reads_in = Vec::new();
        for m in &markets {
            // Reference not warm: no comparable row.
            if pricer.pair_mid(&m.market) <= 0.0 {
                continue;
            }
            for &size in sizes_usd {
                let quote_in = pricer.token_for_usd(&m.quote_tok, size);
                let base_in = pricer.token_for_usd(&m.base_tok, size);
                if quote_in <= 0.0 || base_in <= 0.0 {
                    continue;
                }
                legs.push(Leg { m, size, buy: true, in_human: quote_in });
                reads_in.push(LegRead {
                    key: m.key,
                    zero_for_one: !m.base_is_currency0,
                    exact_amount: raw_amount(quote_in, m.quote_dec),
                });
                legs.push(Leg { m, size, buy: false, in_human: base_in });
                reads_in.push(LegRead {
                    key: m.key,
                    zero_for_one: m.base_is_currency0,
                    exact_amount: raw_amount(base_in, m.base_dec),
                });
            }
        }
        if reads_in.is_empty() {
            return Ok(Vec::new());
        }
        let res = reads.quote_legs(&reads_in, at).await?;
        if res.iter().all(Option::is_none) {
            return Err(VenueError::Chain(format!("Uniswap v4: all {} quote legs failed", res.len())));
        }
        let mut rows: Vec<QuoteRow> = Vec::new();
        let mut row_of: HashMap<(&str, u64), usize> = HashMap::new();
        for (l, r) in legs.iter().zip(res) {
            // The pool can't serve this leg (drained side): one-sided or absent.
            let Some(out) = r else { continue };
            if out.is_zero() {
                continue;
            }
            let mid = pricer.pair_mid(&l.m.market);
            let px = if l.buy {
                l.in_human / (to_f64(out) / pow10(l.m.base_dec))
            } else {
                (to_f64(out) / pow10(l.m.quote_dec)) / l.in_human
            };
            let bps = (px / mid - 1.0) * 1e4;
            if !bps.is_finite() || bps.abs() > PER_SIDE_BAND_BPS {
                continue;
            }
            let idx = *row_of.entry((l.m.market.as_str(), l.size.to_bits())).or_insert_with(|| {
                rows.push(QuoteRow {
                    venue_id: ID.into(),
                    market: l.m.market.clone(),
                    size_usd: l.size,
                    bid_bps: 0.0,
                    ask_bps: 0.0,
                    bid_px: 0.0,
                    ask_px: 0.0,
                    spread_bps: 0.0,
                    filled_full: true,
                    one_sided: None,
                    fee_bps: l.m.fee_bps,
                    cex_ask_bps: None,
                    cex_bid_bps: None,
                    ts: 0.0,
                });
                rows.len() - 1
            });
            let row = &mut rows[idx];
            if l.buy {
                row.ask_bps = bps;
                row.ask_px = px;
            } else {
                row.bid_bps = bps;
                row.bid_px = px;
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
                // One leg failed the band or the quoter: show the real side only.
                r.one_sided = Some(true);
            }
            r.ts = ts;
        }
        rows.retain(|r| r.bid_px > 0.0 || r.ask_px > 0.0);
        Ok(rows)
    }

    /// The markets' pools (tests and tools).
    pub fn pools(&self) -> Vec<UniMarket> {
        self.markets.read().clone()
    }
}

#[async_trait]
impl Venue for Uniswap {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        self.refresh(&RpcReads(cx.rpc), cx.registry).await
    }

    /// Quote-only: nothing to copy out of the ring, ever.
    fn watch(&self) -> Result<WatchSet, VenueError> {
        Ok(WatchSet::default())
    }

    fn decode(&self, _cx: &DecodeCx<'_>, _block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        Ok(Vec::new())
    }

    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        self.quote_with(&RpcReads(cx.rpc), cx.pricer, At::Hash(cx.block.hash), sizes_usd).await
    }

    fn markets(&self) -> Vec<String> {
        self.markets.read().iter().map(|m| m.market.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    };

    use mpamm_core::NoPrices;
    use parking_lot::Mutex;

    use super::*;

    fn reg() -> &'static Registry {
        Registry::get()
    }

    fn token(key: &str) -> Addr {
        reg().tokens[key].address_bytes()
    }

    const NATIVE: Addr = [0; 20];

    type States = Box<dyn Fn(&Key) -> Option<(U256, u128)> + Send + Sync>;
    type Quotes = Box<dyn Fn(&LegRead) -> Option<U256> + Send + Sync>;

    /// Discovery answers per pool key; quotes per leg. Records what it read.
    struct Stub {
        unavailable: AtomicBool,
        states: States,
        quotes: Quotes,
        legs: Mutex<Vec<LegRead>>,
        pinned: Mutex<Vec<String>>,
    }

    impl Stub {
        fn new(
            states: impl Fn(&Key) -> Option<(U256, u128)> + Send + Sync + 'static,
            quotes: impl Fn(&LegRead) -> Option<U256> + Send + Sync + 'static,
        ) -> Self {
            Self {
                unavailable: AtomicBool::new(false),
                states: Box::new(states),
                quotes: Box::new(quotes),
                legs: Mutex::new(Vec::new()),
                pinned: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl UniswapReads for Stub {
        async fn pool_states(&self, ids: &[B256]) -> Result<Vec<Option<(U256, u128)>>, VenueError> {
            let keys: HashMap<B256, Key> = candidates(reg()).into_iter().map(|c| (c.key.pool_id(), c.key)).collect();
            Ok(ids
                .iter()
                .map(|id| if self.unavailable.load(Ordering::SeqCst) { None } else { (self.states)(&keys[id]) })
                .collect())
        }

        async fn quote_legs(&self, legs: &[LegRead], at: At) -> Result<Vec<Option<U256>>, VenueError> {
            self.legs.lock().extend_from_slice(legs);
            self.pinned.lock().push(format!("{at:?}"));
            Ok(legs.iter().map(|l| (self.quotes)(l)).collect())
        }
    }

    /// Fixed USD per token and pair mids.
    struct Prices(HashMap<&'static str, f64>, HashMap<&'static str, f64>);

    impl Pricer for Prices {
        fn usd_per_token(&self, k: &str) -> f64 {
            self.0.get(k).copied().unwrap_or(0.0)
        }
        fn usd_for_token(&self, k: &str, amount: f64) -> f64 {
            amount * self.usd_per_token(k)
        }
        fn pair_mid(&self, m: &str) -> f64 {
            self.1.get(m).copied().unwrap_or(0.0)
        }
    }

    fn e18(x: u128) -> U256 {
        U256::from(x) * U256::from(10u128.pow(18))
    }

    #[test]
    fn pool_id_is_keccak_of_the_encoded_key() {
        // MON/USDC 0.05%: StateView reports in-range liquidity for this id.
        let k = Key { currency0: NATIVE, currency1: token("USDC"), fee: 500, tick_spacing: 10 };
        assert_eq!(k.pool_id().to_string(), "0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954");
    }

    #[test]
    fn sides_resolve_to_their_on_chain_currencies() {
        let cands = candidates(reg());
        // Every registered pair resolves, four tiers each.
        assert_eq!(cands.len(), reg().pairs.len() * 4);
        let first = |m: &str| cands.iter().find(|c| c.market == m).unwrap().clone();
        let mon = first("MON/USDC");
        assert_eq!((mon.key.currency0, mon.key.currency1), (NATIVE, token("USDC")));
        assert!(mon.base_is_currency0);
        assert_eq!((mon.base_tok.as_str(), mon.base_dec, mon.quote_dec), ("MON", 18, 6));
        // USDC sorts below WETH: the base is currency1.
        let eth = first("ETH/USDC");
        assert_eq!((eth.key.currency0, eth.key.currency1), (token("USDC"), token("WETH")));
        assert!(!eth.base_is_currency0);
        assert_eq!(eth.base_tok, "WETH");
        let xau = first("XAUt/USDT0");
        assert_eq!((xau.base_tok.as_str(), xau.base_dec), ("XAUT0", 6));
        assert_eq!(first("cbBTC/MON").base_tok, "CBBTC");
        assert_eq!(first("BTC/ETH").quote_tok, "WETH");
        assert_eq!(first("wANTx/USDC").base_tok, "WANTX");
        let tiers: Vec<(u32, i32, f64)> = cands
            .iter()
            .filter(|c| c.market == "MON/USDC")
            .map(|c| (c.key.fee, c.key.tick_spacing, c.fee_bps))
            .collect();
        assert_eq!(tiers, vec![(100, 1, 1.0), (500, 10, 5.0), (3000, 60, 30.0), (10_000, 200, 100.0)]);
    }

    #[test]
    fn amounts_round_like_math_round() {
        // BigInt(Math.round(x * 10 ** d)), as node prints it.
        assert_eq!(raw_amount(1000.0 / 3.0, 18), 333_333_333_333_333_311_488);
        assert_eq!(raw_amount(100.0 / 0.0213, 18), 4_694_835_680_751_173_763_072);
        assert_eq!(raw_amount(2.0000005, 6), 2_000_001); // toUnits would truncate to 2000000
        assert_eq!(raw_amount(1000.0 / 7.0, 8), 14_285_714_286);
        assert_eq!(raw_amount(100.0 / 2650.5, 6), 37_729);
        for d in 0..=22u8 {
            assert_eq!(pow10(d), format!("1e{d}").parse::<f64>().unwrap());
        }
    }

    /// Port of uniswap.discovery.test.ts: a pass that cannot read any pool
    /// keeps every admitted market.
    #[tokio::test]
    async fn retains_admitted_markets_when_discovery_cannot_read_any_pool() {
        let reads = Stub::new(|_| Some((U256::from(1u8), 1)), |_| None);
        let venue = Uniswap::default();
        venue.refresh(&reads, reg()).await.unwrap();
        let markets = venue.markets();
        assert!(!markets.is_empty());
        reads.unavailable.store(true, Ordering::SeqCst);
        venue.refresh(&reads, reg()).await.unwrap();
        assert_eq!(venue.markets(), markets);
        // No reference: nothing to quote and nothing read.
        assert_eq!(venue.quote_with(&reads, &NoPrices, At::Hash([7; 32]), &[100.0]).await.unwrap(), vec![]);
        assert!(reads.legs.lock().is_empty());
        reads.unavailable.store(false, Ordering::SeqCst);
        venue.refresh(&reads, reg()).await.unwrap();
        assert_eq!(venue.markets(), markets);
    }

    #[tokio::test]
    async fn picks_the_deepest_initialized_tier_and_merges() {
        let mon_usdc = (NATIVE, token("USDC"));
        let eth_usdc = (token("USDC"), token("WETH"));
        let pass = Arc::new(AtomicU8::new(1));
        let p = pass.clone();
        let reads = Stub::new(
            move |k| {
                let pair = (k.currency0, k.currency1);
                let one = U256::from(1u8);
                match (p.load(Ordering::SeqCst), k.fee) {
                    // Uninitialized (sqrtP 0) never wins, however deep.
                    (_, 100) if pair == mon_usdc => Some((U256::ZERO, 1_000)),
                    // A tie: the first tier wins.
                    (1, 500 | 3000) if pair == mon_usdc => Some((one, 20)),
                    (2, 500) if pair == mon_usdc => Some((one, 20)),
                    (2, 3000) if pair == mon_usdc => Some((one, 30)),
                    // No in-range liquidity.
                    (1, 500) if pair == eth_usdc => Some((one, 0)),
                    (1, 10_000) if pair == eth_usdc => Some((one, 5)),
                    _ => None,
                }
            },
            |_| None,
        );
        let venue = Uniswap::default();
        venue.refresh(&reads, reg()).await.unwrap();
        assert_eq!(venue.markets(), vec!["MON/USDC", "ETH/USDC"]);
        let fees: Vec<u32> = venue.pools().iter().map(|m| m.key.fee).collect();
        assert_eq!(fees, vec![500, 10_000]);
        // The next pass re-picks MON/USDC's deeper tier and reads nothing for
        // ETH/USDC: that market stays, with its pool.
        pass.store(2, Ordering::SeqCst);
        venue.refresh(&reads, reg()).await.unwrap();
        assert_eq!(venue.markets(), vec!["MON/USDC", "ETH/USDC"]);
        let pools = venue.pools();
        assert_eq!((pools[0].key.fee, pools[0].fee_bps, pools[1].key.fee), (3000, 30.0, 10_000));
    }

    fn three_markets() -> Uniswap {
        let c = candidates(reg());
        let pick = |m: &str, fee: u32| c.iter().find(|x| x.market == m && x.key.fee == fee).unwrap().clone();
        Uniswap { markets: RwLock::new(vec![pick("MON/USDC", 500), pick("ETH/USDC", 3000), pick("XAUt/USDC", 100)]) }
    }

    #[tokio::test]
    async fn quotes_both_sides_in_pair_terms() {
        let prices = Prices(
            HashMap::from([("USDC", 1.0), ("MON", 0.02), ("WETH", 2500.0), ("XAUT0", 4000.0)]),
            HashMap::from([("MON/USDC", 0.02), ("ETH/USDC", 2500.0), ("XAUt/USDC", 4000.0)]),
        );
        let reads = Stub::new(
            |_| None,
            |l| {
                let pair = (l.key.currency0, l.key.currency1);
                if pair == (NATIVE, token("USDC")) {
                    // Base is currency0: buying spends USDC (1 → 0).
                    return match (l.zero_for_one, l.exact_amount) {
                        (false, 100_000_000) => Some(e18(4990)),
                        (true, a) if a == 5_000 * 10u128.pow(18) => Some(U256::from(99_500_000u64)),
                        // $1000: the buy side is drained.
                        (false, _) => None,
                        (true, _) => Some(U256::from(995_000_000u64)),
                    };
                }
                if pair == (token("USDC"), token("WETH")) {
                    // The ask is 30% out (no comparable execution); the bid answers 0.
                    return Some(if l.zero_for_one { U256::from(30_769_230_769_230_769u128) } else { U256::ZERO });
                }
                None
            },
        );
        let venue = three_markets();
        let at = At::Hash([9; 32]);
        let mut rows = venue.quote_with(&reads, &prices, at, &[100.0, 1000.0]).await.unwrap();
        rows.sort_by(|a, b| a.size_usd.total_cmp(&b.size_usd));
        assert_eq!(rows.len(), 2);
        let r = &rows[0];
        assert_eq!((r.venue_id.as_str(), r.market.as_str(), r.size_usd), (ID, "MON/USDC", 100.0));
        // Today's arithmetic: quote in / (Number(out) / 10 ** 18).
        let ask = 100.0 / (4.99e21 / 1e18);
        assert_eq!(r.ask_px, ask);
        assert_eq!(r.ask_bps, (ask / 0.02 - 1.0) * 1e4);
        assert_eq!(r.bid_px, 99.5 / 5000.0);
        assert_eq!(r.bid_bps, (99.5 / 5000.0 / 0.02 - 1.0) * 1e4);
        assert_eq!(r.spread_bps, r.ask_bps - r.bid_bps);
        assert_eq!((r.fee_bps, r.filled_full, r.one_sided), (5.0, true, None));
        assert!(r.ts > 0.0);
        let r = &rows[1];
        assert_eq!((r.size_usd, r.ask_px, r.ask_bps, r.spread_bps, r.one_sided), (1000.0, 0.0, 0.0, 0.0, Some(true)));
        assert_eq!(r.bid_px, 995.0 / 50_000.0);
        // One batch pinned to the block; directions and exact-in amounts.
        assert_eq!(*reads.pinned.lock(), vec![format!("{at:?}")]);
        let legs = reads.legs.lock().clone();
        assert_eq!(legs.len(), 12);
        assert_eq!((legs[4].zero_for_one, legs[4].exact_amount), (true, 100_000_000));
        assert_eq!((legs[5].zero_for_one, legs[5].exact_amount), (false, 40_000_000_000_000_000));
        // 1000 / 4000 XAUt0 at 6 decimals.
        assert_eq!((legs[11].zero_for_one, legs[11].exact_amount), (true, 250_000));
    }

    #[tokio::test]
    async fn every_leg_failing_is_an_outage() {
        let prices = Prices(HashMap::from([("USDC", 1.0), ("MON", 0.02)]), HashMap::from([("MON/USDC", 0.02)]));
        let reads = Stub::new(|_| None, |_| None);
        let err = three_markets().quote_with(&reads, &prices, At::Hash([0; 32]), &[100.0]).await.unwrap_err();
        assert_eq!(err, VenueError::Chain("Uniswap v4: all 2 quote legs failed".into()));
    }

    #[test]
    fn quote_only() {
        let venue = Uniswap::default();
        assert_eq!(venue.watch().unwrap(), WatchSet::default());
        let m = meta();
        assert_eq!((m.id.as_str(), m.name.as_str()), (ID, "Uniswap v4"));
        assert_eq!((m.role, m.kind), (VenueRole::Baseline, VenueKind::Amm));
        assert_eq!((m.color.light.as_str(), m.color.dark.as_str()), ("#3F6212", "#4D7C0F"));
    }
}
