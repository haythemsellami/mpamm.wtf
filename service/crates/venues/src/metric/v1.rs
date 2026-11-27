//! Metric v1, the LIVE deployment (server/src/venues/metric-v1.ts; since
//! 2026-09-15, first swap 2026-10-04). An oracle-anchored bin AMM,
//! permissionless: anyone can run a pool on Metric's factory.
//!
//!   Factory.nextPoolIdx()/idxToPool(i)   → the full pool set (enumerable)
//!   Pool.getImmutables()                 → token layout (admission)
//!   SwapQuoter.quoteLiveExactInSingle(…) → realized amounts (eth_call)
//!   Pool.Swap(…, amountDeltas, …)        → the landed fill (PACKED deltas)
//!
//! The live quote reads the oracle INSIDE the quoter, and the attributed
//! oracles serve that read only when tx.origin is zero: an `eth_call`
//! without `from`, as `crate::chain` sends it. Give the call a sender and
//! every leg reverts.
//!
//! Swap packs both token deltas into one word (Packed2Int128: token0 in the
//! high int128, token1 in the low; positive = the pool gained it).
//!
//! THREE sets, three questions (conflating them let real fills go uncounted,
//! issue #61): candidates = every pool the factory lists; admitted =
//! structurally understood (a registered base/stable pair), what is watched
//! and decoded; live = priceable right now, what will be quoted.
//!
//! A pool the factory announces mid-stream (`PoolCreated`) holds the block
//! until a discovery pass has decided it: today's decode re-runs discovery on
//! the spot, but decode here reads no chain, so the block waits for the next
//! pass (which also grows the watch set with the pool, if admitted).

use std::collections::{HashMap, HashSet};

use alloy_primitives::{address, Address, U256};
use alloy_sol_types::sol;
use async_trait::async_trait;
use mpamm_chain::Rpc;
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, FinalLog, GasSources, Pricer, QuoteCx, VenueError};
use mpamm_registry::Registry;
use mpamm_ring::{Addr, TopicFilter, WatchSet};
use mpamm_types::{Fill, QuoteRow};
use parking_lot::{Mutex, RwLock};

use super::shared::{admit_pool, metric_fill, pool_liveness, Liveness, MetricPool, PoolTokens, Reject};
use crate::{
    chain::{call, call_many, At},
    generations::{Generation, Span},
    logs,
    quote_health::{check_outage, leg_reason, OutageLatch},
    util::{addr_hex, from_addr, from_units, short_hex, to_addr, to_units, token_addr},
};

pub const V1_FACTORY: Address = address!("2a53833cc95548cf52c7b159110e22d3a9018f32");
/// v1 factory creation: no v1 pool (or its logs) can predate it.
pub const V1_FACTORY_BLOCK: u64 = 105_093_536;
pub const V1_DATA_PROVIDER: Address = address!("83d66c5934b1525ee82e6e772c76c7acc778bbb7");
/// MetricOmmSimpleRouter: Metric's own periphery (single/multi-hop swaps).
pub const V1_SIMPLE_ROUTER: Address = address!("02201e6f13c41506c7bb635d7543f98826229ab7");
/// The PAUSE-AWARE quoter (SDK 0.6.4+, 2026-10-13): a paused pool answers
/// PoolPaused(pool, level) instead of whatever its oracle read hits first.
pub const V1_QUOTER: Address = address!("3b9ea79f482094323d06064e637a7f4528560fcb");

/// Price-limit sentinels (Q64.64) so a quote walks the full binned liquidity
/// for the size: no upper bound buying token0, no lower bound selling it
/// (the SDK's defaultPriceLimitX64).
pub const PRICE_LIMIT_UP: u128 = u128::MAX;
pub const PRICE_LIMIT_DOWN: u128 = 0;

/// Consecutive full frames without a reference before the venue says so:
/// long enough to sit out a cold start, well under the core's backstop.
pub const NO_REFERENCE_FRAMES: u32 = 10;

sol! {
    struct Immutables {
        address factory;
        address token0;
        address token1;
        uint256 token0ScaleMultiplier;
        uint256 token1ScaleMultiplier;
        uint256 initialScaledToken0PerShareE18;
        uint256 initialScaledToken1PerShareE18;
        uint256 minimalOperationalLiquidity;
        address immutablePriceProvider;
        int256 lowestBin;
        int256 highestBin;
        address extension1;
        address extension2;
        address extension3;
        address extension4;
        address extension5;
        address extension6;
        address extension7;
        uint256 beforeAddLiquidityOrder;
        uint256 afterAddLiquidityOrder;
        uint256 beforeRemoveLiquidityOrder;
        uint256 afterRemoveLiquidityOrder;
        uint256 beforeSwapOrder;
        uint256 afterSwapOrder;
    }
    struct ExtensionOrders {
        uint256 beforeAddLiquidity;
        uint256 afterAddLiquidity;
        uint256 beforeRemoveLiquidity;
        uint256 afterRemoveLiquidity;
        uint256 beforeSwap;
        uint256 afterSwap;
    }
    function getImmutables() view returns (Immutables);
    function getSellAndBuyPrices() view returns (uint128 sellPriceX64, uint128 buyPriceX64);
    function nextPoolIdx() view returns (uint256);
    function idxToPool(uint256 idx) view returns (address);
    function priceProvider(address pool) view returns (address);
    function offchainOracle() view returns (address);
    function balanceOf(address owner) view returns (uint256);
    // Non-view on-chain (the oracle is read through a revert path), but only
    // ever eth_call'ed: mutability is not part of the selector or encoding.
    function quoteLiveExactInSingle(address pool, address sender, bool zeroForOne, uint128 amountIn, uint128 priceLimitX64) view returns (uint256 amountIn, uint256 amountOut);
    event Swap(address indexed sender, address indexed recipient, uint256 details, uint256 amountDeltas, uint256 platformFees);
    event PoolCreated(address indexed poolAddress, address indexed token0, address indexed token1, uint256 poolIdx, address factory, address admin, address priceProvider, address[] extensions, ExtensionOrders extensionOrders, uint256 priceProviderTimelock, uint256 initialScaledAmount0PerE18Shares, uint256 initialScaledAmount1PerE18Shares, uint256 minimalOperationalLiquidity, uint24 spreadProtocolFeeE6, uint24 protocolNotionalFeeE8, uint24 adminSpreadFeeE6, uint24 adminNotionalFeeE8, address adminFeeDestination, int24 curBinDistFromProvidedPriceE6, uint256[] nonNegativeBinDataArray, uint256[] negativeBinDataArray);
}

/// Packed2Int128 → (token0 delta, token1 delta): high and low int128.
pub fn unpack_amount_deltas(packed: U256) -> (i128, i128) {
    let hi: U256 = packed >> 128;
    let lo: U256 = packed & U256::from(u128::MAX);
    (u128::try_from(hi).unwrap_or(0) as i128, u128::try_from(lo).unwrap_or(0) as i128)
}

/// The pool a `PoolCreated` log announces: its first indexed topic. Today's
/// decoder reads indexed fields even when the data does not decode, and
/// drops the log when a topic is missing; so does this.
pub fn announced_pool(l: &FinalLog) -> Option<Addr> {
    if l.address != to_addr(V1_FACTORY) || l.topic0() != Some(&logs::topic0::<PoolCreated>()) || l.topics.len() < 4 {
        return None;
    }
    Some(l.topics[1][12..].try_into().expect("20 bytes"))
}

/// What a pool's `getImmutables` tells admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolImmutables {
    pub factory: Addr,
    pub token0: Addr,
    pub token1: Addr,
    pub immutable_price_provider: Addr,
}

/// One `quoteLiveExactInSingle` leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuoteCall {
    pub pool: Addr,
    pub zero_for_one: bool,
    pub amount_in: U256,
    pub price_limit_x64: u128,
}

/// The chain reads discovery and quoting make. Each discovery batch answers
/// per entry (`None` = that read failed) unless noted; an `Err` is the
/// transport, which fails the whole pass (or quote).
#[async_trait]
pub trait V1Reads: Send + Sync {
    async fn next_pool_idx(&self) -> Result<u64, VenueError>;
    /// All or nothing: one failed index fails the pass.
    async fn idx_to_pool(&self, idxs: &[u64]) -> Result<Vec<Addr>, VenueError>;
    async fn immutables(&self, pools: &[Addr]) -> Result<Vec<Option<PoolImmutables>>, VenueError>;
    /// The pools' CURRENT price providers, from the data provider.
    async fn price_providers(&self, pools: &[Addr]) -> Result<Vec<Option<Addr>>, VenueError>;
    /// `token.balanceOf(holder)` for each (token, holder).
    async fn balances(&self, probes: &[(Addr, Addr)]) -> Result<Vec<Option<U256>>, VenueError>;
    /// `pool.getSellAndBuyPrices()`.
    async fn prices(&self, pools: &[Addr]) -> Result<Vec<Option<(u128, u128)>>, VenueError>;
    async fn offchain_oracles(&self, providers: &[Addr]) -> Result<Vec<Option<Addr>>, VenueError>;
    /// The quoter's (amount in used, amount out) per leg, every leg pinned to
    /// one block hash; a leg's own failure is its entry's `Err`.
    async fn quote_live(
        &self,
        legs: &[QuoteCall],
        block_hash: [u8; 32],
    ) -> Result<Vec<Result<(U256, U256), VenueError>>, VenueError>;
}

/// The reads against a node: discovery at its latest block, quotes at the
/// block they are pinned to.
pub struct RpcReads<'a>(pub &'a Rpc);

fn each<T, U>(r: Vec<Result<T, VenueError>>, f: impl Fn(T) -> U) -> Vec<Option<U>> {
    r.into_iter().map(|x| x.ok().map(&f)).collect()
}

#[async_trait]
impl V1Reads for RpcReads<'_> {
    async fn next_pool_idx(&self) -> Result<u64, VenueError> {
        let n = call(self.0, V1_FACTORY, &nextPoolIdxCall {}, At::Latest).await?;
        u64::try_from(n).map_err(|_| VenueError::Chain(format!("Metric nextPoolIdx {n}")))
    }

    async fn idx_to_pool(&self, idxs: &[u64]) -> Result<Vec<Addr>, VenueError> {
        let calls: Vec<_> = idxs.iter().map(|i| (V1_FACTORY, idxToPoolCall { idx: U256::from(*i) })).collect();
        call_many(self.0, &calls, At::Latest).await?.into_iter().map(|r| r.map(to_addr)).collect()
    }

    async fn immutables(&self, pools: &[Addr]) -> Result<Vec<Option<PoolImmutables>>, VenueError> {
        let calls: Vec<_> = pools.iter().map(|p| (from_addr(p), getImmutablesCall {})).collect();
        Ok(each(call_many(self.0, &calls, At::Latest).await?, |im| PoolImmutables {
            factory: to_addr(im.factory),
            token0: to_addr(im.token0),
            token1: to_addr(im.token1),
            immutable_price_provider: to_addr(im.immutablePriceProvider),
        }))
    }

    async fn price_providers(&self, pools: &[Addr]) -> Result<Vec<Option<Addr>>, VenueError> {
        let calls: Vec<_> =
            pools.iter().map(|p| (V1_DATA_PROVIDER, priceProviderCall { pool: from_addr(p) })).collect();
        Ok(each(call_many(self.0, &calls, At::Latest).await?, to_addr))
    }

    async fn balances(&self, probes: &[(Addr, Addr)]) -> Result<Vec<Option<U256>>, VenueError> {
        let calls: Vec<_> = probes.iter().map(|(t, h)| (from_addr(t), balanceOfCall { owner: from_addr(h) })).collect();
        Ok(each(call_many(self.0, &calls, At::Latest).await?, |b| b))
    }

    async fn prices(&self, pools: &[Addr]) -> Result<Vec<Option<(u128, u128)>>, VenueError> {
        let calls: Vec<_> = pools.iter().map(|p| (from_addr(p), getSellAndBuyPricesCall {})).collect();
        Ok(each(call_many(self.0, &calls, At::Latest).await?, |r| (r.sellPriceX64, r.buyPriceX64)))
    }

    async fn offchain_oracles(&self, providers: &[Addr]) -> Result<Vec<Option<Addr>>, VenueError> {
        let calls: Vec<_> = providers.iter().map(|p| (from_addr(p), offchainOracleCall {})).collect();
        Ok(each(call_many(self.0, &calls, At::Latest).await?, to_addr))
    }

    async fn quote_live(
        &self,
        legs: &[QuoteCall],
        block_hash: [u8; 32],
    ) -> Result<Vec<Result<(U256, U256), VenueError>>, VenueError> {
        let calls: Vec<_> = legs
            .iter()
            .map(|l| {
                let c = quoteLiveExactInSingleCall {
                    pool: from_addr(&l.pool),
                    sender: Address::ZERO,
                    zeroForOne: l.zero_for_one,
                    // A uint128 argument: today's encoder refuses a larger
                    // one, which no USD size reaches.
                    amountIn: u128::try_from(l.amount_in).unwrap_or(u128::MAX),
                    priceLimitX64: l.price_limit_x64,
                };
                (V1_QUOTER, c)
            })
            .collect();
        Ok(call_many(self.0, &calls, At::Hash(block_hash))
            .await?
            .into_iter()
            .map(|r| r.map(|q| (q.amountIn, q.amountOut)))
            .collect())
    }
}

#[derive(Debug)]
struct Inner {
    /// Every pool the factory listed, in index order.
    candidates: Vec<Addr>,
    candidate_set: HashSet<Addr>,
    /// Next factory index to read (1-based; 0 is unused).
    next_idx: u64,
    /// getImmutables answers, cached: they cannot change.
    immutables: HashMap<Addr, PoolImmutables>,
    admitted: Vec<MetricPool>,
    /// Priceable right now: what the quote engine will quote.
    live: Vec<MetricPool>,
    /// MONOTONIC decode map, keyed on admission, never on liveness.
    by_addr: HashMap<Addr, MetricPool>,
    /// Candidates a SUCCESSFUL pass has decided (admitted or rejected).
    settled: HashSet<Addr>,
    discovered: bool,
    /// The no-price warning on the record (latched).
    no_price_warned: Option<String>,
    /// Every oracle an admitted pool's provider reads: sorted, deduplicated,
    /// never shrinking (a removed gas destination reads as a removal).
    push_oracles: Vec<Addr>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            candidates: Vec::new(),
            candidate_set: HashSet::new(),
            next_idx: 1,
            immutables: HashMap::new(),
            admitted: Vec::new(),
            live: Vec::new(),
            by_addr: HashMap::new(),
            settled: HashSet::new(),
            discovered: false,
            no_price_warned: None,
            push_oracles: Vec::new(),
        }
    }
}

/// What quoting keeps between blocks: today's quote-health latches.
#[derive(Debug, Default)]
struct QuoteHealth {
    /// One per market × side ("MON/USDC|buy"): a pool can refuse ONE
    /// direction while the other trades (the stop-loss extension refused
    /// every MON-out leg for ~2 minutes on 2026-10-12).
    sides: Vec<(String, OutageLatch)>,
    /// Live pools and no reference for any of their markets (an xStock's
    /// market closed for the weekend, a cold feed, a missing wrapper rate):
    /// only the venue knows that THIS is why it is silent.
    no_reference: OutageLatch,
    unreferenced_frames: u32,
}

#[derive(Default)]
pub struct MetricV1 {
    inner: RwLock<Inner>,
    health: Mutex<QuoteHealth>,
}

impl MetricV1 {
    /// One full discovery pass. Candidates, the next index and the
    /// immutables cache grow as they are read (as today); everything else is
    /// assigned at the end, so a failed pass leaves the previous state in force.
    pub async fn refresh(&self, reads: &dyn V1Reads, registry: &Registry) -> Result<(), VenueError> {
        let zero = [0u8; 20];
        // 1. enumerate: the factory is the authoritative pool list.
        let next = reads.next_pool_idx().await?;
        let from = self.inner.read().next_idx;
        if next > from {
            let idxs: Vec<u64> = (from..next).collect();
            let listed = reads.idx_to_pool(&idxs).await?;
            let mut inner = self.inner.write();
            let mut added = 0;
            for p in listed {
                if p != zero && inner.candidate_set.insert(p) {
                    inner.candidates.push(p);
                    added += 1;
                }
            }
            inner.next_idx = next;
            if added > 0 && inner.discovered {
                tracing::info!(target: "venues", "Metric: factory lists {added} new pool(s)");
            }
        }

        // 2. resolve: getImmutables once per pool. Every candidate is a real
        // pool, so an unanswered read is the RPC: fail rather than drop it.
        let unresolved: Vec<Addr> = {
            let inner = self.inner.read();
            inner.candidates.iter().filter(|p| !inner.immutables.contains_key(*p)).copied().collect()
        };
        if !unresolved.is_empty() {
            let res = reads.immutables(&unresolved).await?;
            let mut inner = self.inner.write();
            for (p, r) in unresolved.iter().zip(res) {
                let im = r.ok_or_else(|| {
                    VenueError::Chain(format!("Metric getImmutables failed for factory pool {}", addr_hex(p)))
                })?;
                inner.immutables.insert(*p, im);
            }
        }

        // 3. admit: registered base/stable pairs, bound to their CURRENT provider.
        let structural: Vec<MetricPool> = {
            let inner = self.inner.read();
            let mut out = Vec::new();
            for p in &inner.candidates {
                let im = inner.immutables[p];
                if im.factory != to_addr(V1_FACTORY) {
                    continue;
                }
                let tokens =
                    PoolTokens { token0: im.token0, token1: im.token1, price_provider: im.immutable_price_provider };
                match admit_pool(registry, *p, &addr_hex(p), Some(&tokens)) {
                    Ok(pool) => out.push(pool),
                    Err(Reject::UnregisteredPair(detail)) => tracing::info!(
                        target: "venues",
                        "Metric: pool {} ({detail}) is not a registered pair — skipped",
                        short_hex(&addr_hex(p))
                    ),
                    Err(_) => {}
                }
            }
            out
        };
        // No fallback to the creation-time provider: after a provider change it
        // names the OBSOLETE one, whose oracle would join the gas set for good.
        let pools: Vec<Addr> = structural.iter().map(|p| p.pool).collect();
        let providers = if pools.is_empty() { Vec::new() } else { reads.price_providers(&pools).await? };
        let admitted = structural
            .into_iter()
            .zip(providers.into_iter().chain(std::iter::repeat(None)))
            .map(|(p, r)| match r {
                Some(prov) => Ok(MetricPool { price_provider: prov, ..p }),
                None => Err(VenueError::Chain(format!("Metric priceProvider read failed for pool {}", p.pool_str))),
            })
            .collect::<Result<Vec<_>, _>>()?;

        // 4. liveness: funded + two-sided price (quoting only).
        let mut live = Vec::new();
        let (mut unfunded, mut no_price, mut unreadable) = (0, 0, 0);
        if !admitted.is_empty() {
            let probes: Vec<(Addr, Addr)> = admitted
                .iter()
                .flat_map(|p| {
                    let base = token_addr(registry, &p.base_token).unwrap_or_default();
                    let stable = registry
                        .tokens
                        .values()
                        .find(|t| t.symbol == p.stable_sym)
                        .map(|t| t.address_bytes())
                        .unwrap_or_default();
                    [(base, p.pool), (stable, p.pool)]
                })
                .collect();
            let bals = reads.balances(&probes).await?;
            let pxs = reads.prices(&admitted.iter().map(|p| p.pool).collect::<Vec<_>>()).await?;
            for (i, p) in admitted.iter().enumerate() {
                let px = pxs.get(i).copied().flatten();
                let bal = |j: usize| bals.get(j).copied().flatten();
                match pool_liveness(bal(2 * i), bal(2 * i + 1), px.map(|x| x.0), px.map(|x| x.1)) {
                    Liveness::Live => live.push(p.clone()),
                    Liveness::Unfunded => unfunded += 1,
                    Liveness::NoPrice => no_price += 1,
                    Liveness::Unreadable => unreadable += 1,
                }
            }
        }

        // 5. gas destinations: every oracle an ADMITTED pool's provider reads
        // (admitted, not live: the set must not shrink when a pool drains).
        let mut providers: Vec<Addr> = Vec::new();
        for p in &admitted {
            if p.price_provider != zero && !providers.contains(&p.price_provider) {
                providers.push(p.price_provider);
            }
        }
        let oracles: Vec<Addr> = if providers.is_empty() {
            Vec::new()
        } else {
            reads.offchain_oracles(&providers).await?.into_iter().flatten().filter(|o| *o != zero).collect()
        };

        let mut inner = self.inner.write();
        for p in &admitted {
            inner.by_addr.insert(p.pool, p.clone());
        }
        let candidates = inner.candidates.clone();
        inner.settled.extend(candidates);
        // Merged, never replaced.
        inner.push_oracles.extend(oracles);
        inner.push_oracles.sort();
        inner.push_oracles.dedup();
        inner.admitted = admitted;
        inner.live = live;
        inner.discovered = true;

        let why: Vec<String> =
            [(unfunded, "unfunded"), (no_price, "funded but no oracle price"), (unreadable, "unreadable")]
                .iter()
                .filter(|(n, _)| *n > 0)
                .map(|(n, w)| format!("{n} {w}"))
                .collect();
        let why = if why.is_empty() { String::new() } else { format!(" (+{}; not quoted)", why.join(", ")) };
        tracing::info!(target: "venues", "Metric: {} live base/stable pool(s){why}", inner.live.len());
        // Funded capital we cannot price is a degradation: warn once per episode,
        // and announce the heal.
        if no_price > 0 {
            let msg = format!(
                "Metric: {no_price} funded pool(s) have no oracle price — they cannot be quoted (their fills are still tailed)"
            );
            if inner.no_price_warned.as_deref() != Some(msg.as_str()) {
                tracing::warn!(target: "venues", "{msg}");
                inner.no_price_warned = Some(msg);
            }
        } else if inner.no_price_warned.take().is_some() {
            tracing::info!(target: "venues", "Metric quoting again — oracle price back for funded pool(s)");
        }
        Ok(())
    }

    /// Admitted pools (what is watched and decoded), in factory order.
    pub fn admitted(&self) -> Vec<MetricPool> {
        self.inner.read().admitted.clone()
    }

    /// Markets of the pools that are priceable right now.
    pub fn live_markets(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in &self.inner.read().live {
            if !out.contains(&p.market) {
                out.push(p.market.clone());
            }
        }
        out
    }

    /// The no-price warning on the record, if any.
    pub fn no_price_warning(&self) -> Option<String> {
        self.inner.read().no_price_warned.clone()
    }

    /// The no-reference outage on the record, if any.
    pub fn no_reference_outage(&self) -> Option<String> {
        self.health.lock().no_reference.current().map(str::to_string)
    }

    /// The refused sides on the record: ("MON/USDC|buy", reason).
    pub fn side_outages(&self) -> Vec<(String, String)> {
        let h = self.health.lock();
        h.sides.iter().filter_map(|(k, l)| l.current().map(|r| (k.clone(), r.to_string()))).collect()
    }

    /// quoteLiveExactInSingle for each live pool × size × side, pinned to
    /// the block: buying the base spends `size` of the stable; selling spends
    /// the base worth `size`. Price = stable per base, all-in.
    pub async fn quote_with(
        &self,
        reads: &dyn V1Reads,
        pricer: &dyn Pricer,
        block_hash: [u8; 32],
        sizes_usd: &[f64],
    ) -> Result<Vec<QuoteRow>, VenueError> {
        let pools = self.inner.read().live.clone();
        if pools.is_empty() {
            return Ok(Vec::new());
        }
        struct Leg {
            market: String,
            size: f64,
            buy: bool,
            req_in: U256,
            base_dec: u8,
            stable_dec: u8,
            base_px: f64,
        }
        let mut legs = Vec::new();
        let mut calls = Vec::new();
        for p in &pools {
            // bps anchor = the pair-terms reference mid, never a raw USDT price.
            let base_px = pricer.pair_mid(&p.market);
            if base_px <= 0.0 {
                continue;
            }
            // token0 in ⇒ selling the base when the base is token0.
            let sell_zero_for_one = p.base_is_token0;
            for &size in sizes_usd {
                // BUY base: exact-in the stable. SELL base: exact-in base worth `size`.
                let buy_in = to_units(size, p.stable_dec);
                let sell_in = to_units(pricer.token_for_usd(&p.base_token, size), p.base_dec);
                for (buy, amount_in, zero_for_one) in
                    [(true, buy_in, !sell_zero_for_one), (false, sell_in, sell_zero_for_one)]
                {
                    legs.push(Leg {
                        market: p.market.clone(),
                        size,
                        buy,
                        req_in: amount_in,
                        base_dec: p.base_dec,
                        stable_dec: p.stable_dec,
                        base_px,
                    });
                    let price_limit_x64 = if zero_for_one { PRICE_LIMIT_DOWN } else { PRICE_LIMIT_UP };
                    calls.push(QuoteCall { pool: p.pool, zero_for_one, amount_in, price_limit_x64 });
                }
            }
        }
        if calls.is_empty() {
            self.no_reference_frame(&pools);
            return Ok(Vec::new());
        }
        let res = reads.quote_live(&calls, block_hash).await?;
        check_outage("Metric", &res)?;

        // A whole SIDE refusing (every size of one direction on one market) is
        // a venue state, not thin liquidity: say why, once, and announce the
        // heal. The other side is still published, one-sided.
        let mut by_side: Vec<(String, Vec<usize>)> = Vec::new();
        for (i, l) in legs.iter().enumerate() {
            let k = format!("{}|{}", l.market, if l.buy { "buy" } else { "sell" });
            match by_side.iter_mut().find(|(x, _)| *x == k) {
                Some((_, idx)) => idx.push(i),
                None => by_side.push((k, vec![i])),
            }
        }
        self.side_health(&by_side, &res);

        let mut rows: Vec<QuoteRow> = Vec::new();
        for (l, r) in legs.iter().zip(&res) {
            let Ok((used_in, out)) = r else { continue };
            let (base_raw, stable_raw) = if l.buy { (*out, *used_in) } else { (*used_in, *out) };
            let base_h = from_units(base_raw, l.base_dec);
            let stable_h = from_units(stable_raw, l.stable_dec);
            if base_h <= 0.0 || stable_h <= 0.0 {
                continue;
            }
            let px = stable_h / base_h;
            let bps = (px / l.base_px - 1.0) * 1e4;
            // Filled full when the exact-input leg consumed (almost) the whole
            // requested input: the quoter stops at the inventory's edge.
            let full = *used_in >= l.req_in * U256::from(999u32) / U256::from(1000u32);
            // One row per market and size, whichever live pool answered.
            let idx = match rows.iter().position(|x| x.market == l.market && x.size_usd == l.size) {
                Some(i) => i,
                None => {
                    rows.push(QuoteRow {
                        venue_id: super::ID.into(),
                        market: l.market.clone(),
                        size_usd: l.size,
                        bid_bps: 0.0,
                        ask_bps: 0.0,
                        bid_px: 0.0,
                        ask_px: 0.0,
                        spread_bps: 0.0,
                        filled_full: true,
                        one_sided: None,
                        fee_bps: 0.0,
                        cex_ask_bps: None,
                        cex_bid_bps: None,
                        ts: 0.0,
                    });
                    rows.len() - 1
                }
            };
            let row = &mut rows[idx];
            if l.buy {
                row.ask_bps = bps;
                row.ask_px = px;
            } else {
                row.bid_bps = bps;
                row.bid_px = px;
            }
            row.filled_full &= full;
        }
        // One real side and one refused side is a genuine half-market: keep the
        // real side, one-sided, rather than drop a venue that still trades.
        let ts = now_ms();
        for r in &mut rows {
            if r.ask_px > 0.0 && r.bid_px > 0.0 {
                r.spread_bps = r.ask_bps - r.bid_bps;
            } else {
                r.one_sided = Some(true);
            }
            r.ts = ts;
        }
        rows.retain(|r| r.ask_px > 0.0 || r.bid_px > 0.0);
        // The no-reference episode ends with a ROW, not with legs that
        // answered: a leg can answer zero and build nothing.
        if !rows.is_empty() {
            let mut h = self.health.lock();
            h.unreferenced_frames = 0;
            h.no_reference.report("Metric", None);
        }
        Ok(rows)
    }

    /// A frame with live pools and no reference for any of them: said once
    /// the gap outlasts a cold start.
    fn no_reference_frame(&self, pools: &[MetricPool]) {
        let mut h = self.health.lock();
        h.unreferenced_frames += 1;
        if h.unreferenced_frames < NO_REFERENCE_FRAMES {
            return;
        }
        let mut markets: Vec<&str> = pools.iter().map(|p| p.market.as_str()).collect();
        markets.sort_unstable();
        markets.dedup();
        let unreferenced = markets.join(", ");
        let msg = format!(
            "Metric is not quoted — its live pool(s) trade {unreferenced}, which has no CEX reference right now (market closed, feed cold, or a missing wrapper rate)"
        );
        h.no_reference.report("Metric", Some((&format!("no reference for {unreferenced}"), &msg)));
    }

    /// Each market × side: refused when every one of its legs failed.
    fn side_health(&self, by_side: &[(String, Vec<usize>)], res: &[Result<(U256, U256), VenueError>]) {
        let mut h = self.health.lock();
        for (k, idx) in by_side {
            let (market, side) = k.split_once('|').expect("market|side");
            let name = format!("Metric {market} {side}s");
            let slot = match h.sides.iter().position(|(x, _)| x == k) {
                Some(i) => i,
                None => {
                    h.sides.push((k.clone(), OutageLatch::default()));
                    h.sides.len() - 1
                }
            };
            let latch = &mut h.sides[slot].1;
            if idx.iter().any(|i| res[*i].is_ok()) {
                latch.report(&name, None);
                continue;
            }
            // Today names the leg's custom error (OracleStopLossTriggered, say)
            // from the revert data; the node's error here carries its message.
            let reason = res[idx[0]].as_ref().err().map_or_else(|| "call failed".to_string(), leg_reason);
            let msg =
                format!("{name} unavailable — every {side} leg failed with \"{reason}\"; quoting the other side only");
            latch.report(&name, Some((&reason, &msg)));
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[async_trait]
impl Generation for MetricV1 {
    fn span(&self) -> Span {
        Span { from: Some(V1_FACTORY_BLOCK), until: None }
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        self.refresh(&RpcReads(cx.rpc), cx.registry).await
    }

    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        self.quote_with(&RpcReads(cx.rpc), cx.pricer, cx.block.hash, sizes_usd).await
    }

    /// The factory is ALWAYS watched, even with no admitted pool: it is how a
    /// new deployment reaches us between discovery passes.
    fn watch(&self) -> Result<WatchSet, VenueError> {
        let inner = self.inner.read();
        if !inner.discovered {
            return Err(VenueError::NotReady("Metric v1 discovery unavailable".into()));
        }
        let mut w = WatchSet::default();
        w.logs.insert(to_addr(V1_FACTORY), TopicFilter::Topics(HashSet::from([logs::topic0::<PoolCreated>()])));
        for p in &inner.admitted {
            w.logs.insert(p.pool, TopicFilter::Topics(HashSet::from([logs::topic0::<Swap>()])));
        }
        w.txn_input.extend(inner.push_oracles.iter().copied());
        Ok(w)
    }

    fn decode(&self, _cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let inner = self.inner.read();
        if !inner.discovered {
            return Err(VenueError::NotReady("Metric v1 discovery unavailable".into()));
        }
        // Against SETTLED, not candidates: a pass that failed after
        // enumerating the pool leaves it undecided, and the block must wait.
        let announced: Vec<Addr> =
            block.logs.iter().filter_map(announced_pool).filter(|p| !inner.settled.contains(p)).collect();
        if !announced.is_empty() {
            let names: Vec<String> = announced.iter().map(|p| short_hex(&addr_hex(p))).collect();
            return Err(VenueError::NotReady(format!(
                "Metric: factory deployed {} new pool(s) ({}) — holding until discovery decides them",
                announced.len(),
                names.join(", ")
            )));
        }
        let mut out = Vec::new();
        for l in &block.logs {
            let Some(p) = inner.by_addr.get(&l.address) else { continue };
            let Some(s) = logs::decode::<Swap>(l) else { continue };
            let (d0, d1) = unpack_amount_deltas(s.amountDeltas);
            out.extend(metric_fill(p, d0, d1, l, s.recipient, block));
        }
        Ok(out)
    }

    fn markets(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in &self.inner.read().admitted {
            if !out.contains(&p.market) {
                out.push(p.market.clone());
            }
        }
        out
    }

    /// The pools themselves (DIRECT) and Metric's own SimpleRouter.
    fn entry_points(&self) -> Vec<EntryPoint> {
        let inner = self.inner.read();
        let mut out: Vec<EntryPoint> =
            inner.admitted.iter().map(|p| EntryPoint { address: p.pool, router: None }).collect();
        out.push(EntryPoint { address: to_addr(V1_SIMPLE_ROUTER), router: Some("Metric".into()) });
        out
    }

    /// The push oracle(s) v1 providers read, fed by publisher EOAs: every
    /// transaction to them is a quote update. Held (never partial) until one
    /// resolves.
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        let inner = self.inner.read();
        if inner.push_oracles.is_empty() {
            return Err(VenueError::NotReady("Metric v1 push oracle not resolved yet".into()));
        }
        Ok(Some(GasSources { destinations: inner.push_oracles.clone(), ..GasSources::default() }))
    }
}
