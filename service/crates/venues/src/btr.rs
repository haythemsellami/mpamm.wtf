//! BTR, ported from server/src/venues/btr.ts: an oracle-priced multi-asset
//! pool (BTR's "AIMM"). Every listed asset sits in one book; any two of them
//! swap in one call and emit one `Swapped`, a spoke-to-spoke swap included.
//!
//!   pool.getSwapQuote(in, out, amountIn) → the executable, fee-inclusive
//!                                          exact-in quote (`amountOut` is what
//!                                          a swap pays)
//!   pool.getAsset(t) / getRiskFlags(t)   → listing, decimals, swap-enabled bit
//!   pool.Swapped(…)                      → the trade (amounts = in | out << 128)
//!
//! Two pools, one venue: pool v2 (2026-11-13) replaced a proxy from the same
//! deployer that emitted the same `Swapped` (2026-10-02 → 11-10). Both sit in
//! one watch entry with the same decode: that history is the venue's.
//!
//! The decode table is static: a swap names both tokens, so it maps to the
//! first registered pair of those two tokens (either way round) whatever the
//! pool lists. A pair that is not registered maps to nothing and is dropped.
//! Discovery only decides what is quotable.
//!
//! Quotes: pool v2 only (the retired pool's quotes revert), every leg in one
//! batch at ~120k gas each. `getSwapQuote` does not depend on the sender, but
//! while a leg is SWAP_GATED only senders on the pool's swap gate can execute
//! it: the price is executable through them. A quote the pool cannot honour
//! (past a coverage cap, a halted leg, a stale mark) REVERTS rather than
//! filling partly, so a surviving side is the full size and a size past the
//! caps has no row.
//!
//! USD: a stable-quoted pair's stable leg; a crypto-quoted pair is valued off
//! the pricer's quote leg, else its base leg, else the block holds (no
//! price is not a zero).
//!
//! Gas: BTR's keeper pushes marks (no logs) to each proxy's IMPLEMENTATION,
//! never the proxy, so every implementation either proxy has run is a
//! destination. An `Upgraded` to any other implementation is announced: the
//! ABIs here were checked against these only.

use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

use alloy_primitives::{address, Address, U256};
use async_trait::async_trait;
use mpamm_core::{
    ChainCx, DecodeCx, EntryPoint, FinalBlock, GasSources, HistoryRevision, QuoteCx, RevisionSource, Venue, VenueError,
};
use mpamm_registry::{parse_address, Pair, Registry};
use mpamm_ring::{Addr, TopicFilter, WatchSet};
use mpamm_types::{Fill, FillCategory, QuoteRow, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call_many, At},
    logs, quote_health,
    util::{addr_hex, b32_hex, fill_id, from_addr, from_units, short_hex, to_addr, to_f64, to_units},
};

pub const ID: &str = "btr";
/// Pool v2 proxy (ERC-1967): the only pool quoted.
pub const POOL: Address = address!("bbbbbbbd7060b1ced79c381ead40d73fcb9ae0c6");
/// The proxy pool v2 replaced (Swapped from block 109,894,457 to
/// 120,916,325). Decode-only: its trades are the venue's history.
pub const RETIRED_POOL: Address = address!("bbbbbbb04f5b762a4cdd1d89e341e2537e3267e4");

/// BTR's Router (docs "Contract Addresses"): runs an off-chain keeper-chosen
/// path across the pools in one transaction. Its own periphery, so a direct
/// tx.to to it is this venue's routed flow, not an unknown aggregator.
pub const ROUTER: Address = address!("bbbbbbb17647a22d61e49d62a95445b1284b1296");

/// CoopArb v1 (the pool record's `coopArb`): the executor that swapped
/// through pool v2, named on the tape apart from BTR's other executors.
pub const COOP_ARB: Address = address!("bbbbbbb2a9c5b6da52f2cc79f6a306ebcb37e5cf");

/// Every implementation the two proxies have run, oldest first. APPEND-ONLY:
/// each is a quote-update destination, and the ABIs were checked against it.
pub const IMPLEMENTATIONS: [Address; 2] = [
    address!("154be75fff18c9dfdd15d7f902b64a7b93b2a638"), // retired pool
    address!("f1dd174b3540f298809d51e06ffc9f7f05b161f5"), // pool v2
];

/// BTR's own executors (created by the pools' deployer, each both tx.to and
/// the event's `sender`), found by tallying tx.to over every Swapped. The
/// first four fronted the retired pool; the last swaps through pool v2.
pub const EXECUTORS: [Address; 5] = [
    address!("bbbbbbb0d5cfe5bc7939ae0fce2cf21b95e806a7"),
    address!("bbbbbbb0f219f537a64d41a907192ba41b5225be"),
    address!("bbbbbbb1e1dabc155c79f4688cdb462a462f4040"),
    address!("bbbbbbb0f8c5d06406a6ff39abe1d514e25ade2e"), // 151 swaps, 2026-10-15 → 10-29
    address!("bbbbbbb2a9c5b6da52f2cc79f6a306ebcb37e5cf"), // pool v2
];

/// Pool risk-flag bit: the leg may be swapped at all.
const SWAP_ENABLED_BIT: u16 = 16;

pub mod abi {
    alloy_sol_types::sol! {
        struct Asset {
            uint128 reserves;
            uint128 liabilities;
            address anchor;
            uint96 minLiquidity;
            uint72 liquidityIndexWad;
            uint32 minDispersionPbps;
            uint16 curveId;
            uint16 minFeePbps;
            uint16 vegaBps;
            uint16 depositCapCode;
            uint8 decimals;
            uint8 deadSeedPow10;
            uint16 flags;
            uint16 maxLiabWeightBps;
            uint8 oracleBits;
            uint32 covBits;
            uint16 kneeBits;
        }
        function getAsset(address tk) view returns (Asset);
        function getRiskFlags(address tk) view returns (uint16);
        struct SwapQuote {
            uint256 amountOut;
            uint256 amountIn;
            uint16 spreadPbps;
            uint256 protoFee;
            uint256 lpFee;
            int8 skewIn;
            int8 skewOut;
            uint256 markPrice;
            uint256 midPrice;
            uint256 covToll;
            address[] routeHops;
            uint256[] hopAmounts;
            uint256[] hopPrices;
        }
        function getSwapQuote(address tokenIn, address tokenOut, uint256 amountIn) view returns (SwapQuote);
        // amounts = amountIn | amountOut << 128 (raw token units).
        event Swapped(address indexed sender, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amounts, uint256 fees, uint256 prices, uint256 outBook, uint256 outState);
        event Upgraded(address indexed implementation);
    }
}
use abi::{getAssetCall, getRiskFlagsCall, getSwapQuoteCall, Swapped, Upgraded};

/// A registered pair two pool assets can trade as.
#[derive(Debug, Clone, PartialEq)]
pub struct BtrMarket {
    pub market: String,
    pub base_key: String,
    pub quote_key: String,
    pub base: Addr,
    pub base_dec: u8,
    pub quote: Addr,
    pub quote_dec: u8,
}

/// The registry token keys `[base, quote]` a registered pair trades (today's
/// `tokenKeysForPair`): cbBTC is an alternative BTC wrapper, so the market
/// symbol, not the pair's base, selects it, on either leg.
pub fn token_keys_for_pair<'a>(registry: &'a Registry, pair: &'a Pair) -> Option<(&'a str, &'a str)> {
    let base = if pair.symbol.starts_with("cbBTC/") {
        Some("CBBTC")
    } else {
        registry.assets.get(&pair.base).map(|a| a.token.as_str())
    };
    let quote = if pair.symbol.ends_with("/cbBTC") {
        Some("CBBTC")
    } else if pair.is_asset_quoted() {
        registry.assets.get(&pair.quote).map(|a| a.token.as_str())
    } else {
        Some(pair.quote.as_str())
    };
    match (base, quote) {
        (Some(b), Some(q)) if !b.is_empty() && !q.is_empty() => Some((b, q)),
        _ => None,
    }
}

/// Direction-free key for two token addresses (a swap names them either way).
fn pair_key(a: Addr, b: Addr) -> (Addr, Addr) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Every registered pair whose two ERC-20s could meet in the pool, keyed on
/// the unordered token pair; the first registered pair wins (the canonical
/// one). This, not discovery, is the decode table.
pub fn btr_markets(registry: &Registry) -> HashMap<(Addr, Addr), BtrMarket> {
    let native = parse_address(&registry.native_mon);
    let mut out = HashMap::new();
    for pair in &registry.pairs {
        let Some((base_key, quote_key)) = token_keys_for_pair(registry, pair) else { continue };
        let (Some(base), Some(quote)) = (registry.tokens.get(base_key), registry.tokens.get(quote_key)) else {
            continue;
        };
        let (b, q) = (base.address_bytes(), quote.address_bytes());
        if Some(b) == native || Some(q) == native || b == q {
            continue;
        }
        out.entry(pair_key(b, q)).or_insert_with(|| BtrMarket {
            market: pair.symbol.clone(),
            base_key: base_key.to_string(),
            quote_key: quote_key.to_string(),
            base: b,
            base_dec: base.decimals,
            quote: q,
            quote_dec: quote.decimals,
        });
    }
    out
}

/// What the pool says about one registered token: `None` when its reads
/// failed.
pub struct Listing<'a> {
    pub token_key: &'a str,
    pub read: Option<(u8, u16)>,
}

/// The markets quotable from one discovery's reads (`(decimals, riskFlags)`
/// per registered ERC-20, in registry order). An unlisted asset reads back
/// zeroed and is skipped; a failed read or a listed asset whose decimals
/// disagree with the registry fails discovery; none found fails it too.
pub fn quotable_markets(registry: &Registry, listing: &[Listing<'_>]) -> Result<Vec<BtrMarket>, VenueError> {
    let mut enabled = HashSet::new();
    for l in listing {
        let t = registry
            .tokens
            .get(l.token_key)
            .ok_or_else(|| VenueError::Chain(format!("BTR: no token {}", l.token_key)))?;
        let Some((decimals, flags)) = l.read else {
            return Err(VenueError::Chain(format!("BTR getAsset/getRiskFlags({}) read failed", t.symbol)));
        };
        if decimals == 0 && flags == 0 {
            continue;
        }
        if decimals != t.decimals {
            return Err(VenueError::Chain(format!(
                "BTR {} decimals mismatch (pool {decimals}, registry {})",
                t.symbol, t.decimals
            )));
        }
        if flags & SWAP_ENABLED_BIT != 0 {
            enabled.insert(t.address_bytes());
        }
    }
    let found: Vec<BtrMarket> = btr_markets(registry)
        .into_values()
        .filter(|m| enabled.contains(&m.base) && enabled.contains(&m.quote))
        .collect();
    if found.is_empty() {
        return Err(VenueError::Chain("BTR discovered no registered markets".into()));
    }
    Ok(found)
}

#[derive(Default)]
pub struct Btr {
    /// Markets whose two tokens are both swap-enabled pool assets: merged,
    /// never shrunk.
    quotable: RwLock<HashMap<String, BtrMarket>>,
    table: OnceLock<HashMap<(Addr, Addr), BtrMarket>>,
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "BTR".into(),
        color: ThemeColor { light: "#1E3A8A".into(), dark: "#E0E7FF".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2026-10-01".into()),
        quote_note: None,
    }
}

impl Btr {
    /// A venue already discovered (tests and tools).
    pub fn with_quotable(markets: Vec<BtrMarket>) -> Self {
        let b = Self::default();
        b.merge(markets);
        b
    }

    fn merge(&self, markets: Vec<BtrMarket>) {
        let mut q = self.quotable.write();
        for m in markets {
            q.insert(m.market.clone(), m);
        }
    }

    /// The quotable markets in the registry's pair order (today's map keeps
    /// discovery's insertion order, which is the registry's).
    fn quotable_in_order(&self, registry: &Registry) -> Vec<BtrMarket> {
        let q = self.quotable.read();
        registry.pairs.iter().filter_map(|p| q.get(&p.symbol).cloned()).collect()
    }

    fn table(&self, registry: &Registry) -> &HashMap<(Addr, Addr), BtrMarket> {
        self.table.get_or_init(|| btr_markets(registry))
    }

    /// One `Swapped` as a trade, `Ok(None)` when it is not a priceable trade
    /// on a registered pair.
    fn swap(
        &self,
        cx: &DecodeCx<'_>,
        block: &FinalBlock,
        l: &mpamm_core::FinalLog,
        s: &Swapped,
    ) -> Result<Option<Fill>, VenueError> {
        let mask = (U256::from(1u8) << 128) - U256::from(1u8);
        let amount_in: U256 = s.amounts & mask;
        let amount_out: U256 = s.amounts >> 128;
        if amount_in.is_zero() || amount_out.is_zero() {
            return Ok(None);
        }
        let (token_in, token_out) = (to_addr(s.tokenIn), to_addr(s.tokenOut));
        let Some(m) = self.table(cx.registry).get(&pair_key(token_in, token_out)) else { return Ok(None) };
        let sells_base = token_in == m.base;
        let base_amount = from_units(if sells_base { amount_in } else { amount_out }, m.base_dec);
        let quote_amount = from_units(if sells_base { amount_out } else { amount_in }, m.quote_dec);
        if !positive(base_amount) || !positive(quote_amount) {
            return Ok(None);
        }
        let mut usd = cx.pricer.usd_for_token(&m.quote_key, quote_amount);
        if !positive(usd) {
            usd = cx.pricer.usd_for_token(&m.base_key, base_amount);
        }
        if !positive(usd) {
            return Err(VenueError::Decode(format!("BTR {}: no USD price for either fill leg", m.market)));
        }
        Ok(Some(Fill {
            id: fill_id(ID, &l.tx_hash, l.log_index),
            venue_id: ID.into(),
            market: m.market.clone(),
            side: if sells_base { Side::Sell } else { Side::Buy },
            // Attribution is the core's job: never claim DIRECT here.
            category: FillCategory::Unknown,
            usd,
            base_amount,
            // Realized quote per base, fee-inclusive.
            exec_px: quote_amount / base_amount,
            px_approx: false,
            tx_hash: b32_hex(&l.tx_hash),
            // viem hands decoded addresses checksummed; today's label keeps that case.
            to: short_hex(&s.recipient.to_string()),
            router: None,
            pool: format!("btr {}", &addr_hex(&l.address)[..10]),
            block_number: block.number,
            ts: block.time_ms(),
            markouts_bps: vec![None; 5],
            time_source: None,
        }))
    }
}

/// `x > 0`, false for NaN (today's `!(x > 0)` guards).
fn positive(x: f64) -> bool {
    x > 0.0
}

/// Wall-clock milliseconds, today's `Date.now()`.
fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn is_pool(a: &Addr) -> bool {
    *a == to_addr(POOL) || *a == to_addr(RETIRED_POOL)
}

#[async_trait]
impl Venue for Btr {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let n = cx.rpc.block_number().await.map_err(|e| VenueError::Chain(format!("BTR block number: {e}")))?;
        // The registry cannot enumerate the pool's assets, so probe every
        // registered ERC-20: a new listing is picked up with no edit here.
        let native = parse_address(&cx.registry.native_mon);
        let tokens: Vec<(&str, Address)> = cx
            .registry
            .tokens
            .iter()
            .filter(|(_, t)| Some(t.address_bytes()) != native)
            .map(|(k, t)| (k.as_str(), Address::from(t.address_bytes())))
            .collect();
        let asset_calls: Vec<(Address, getAssetCall)> =
            tokens.iter().map(|(_, a)| (POOL, getAssetCall { tk: *a })).collect();
        let flag_calls: Vec<(Address, getRiskFlagsCall)> =
            tokens.iter().map(|(_, a)| (POOL, getRiskFlagsCall { tk: *a })).collect();
        let assets = call_many(cx.rpc, &asset_calls, At::Number(n)).await?;
        let flags = call_many(cx.rpc, &flag_calls, At::Number(n)).await?;
        let listing: Vec<Listing<'_>> = tokens
            .iter()
            .zip(assets.into_iter().zip(flags))
            .map(|((key, _), (a, f))| Listing {
                token_key: key,
                read: match (a, f) {
                    (Ok(a), Ok(f)) => Some((a.decimals, f)),
                    _ => None,
                },
            })
            .collect();
        let found = quotable_markets(cx.registry, &listing)?;
        let count = found.len();
        // Merge, never replace: a market once quotable stays listed.
        self.merge(found);
        tracing::info!(target: "venues", "BTR: {count} registered market(s) at block {n}");
        Ok(())
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        // Static: both pools, the trade and the proxies' Upgraded (so an
        // implementation change is seen in the block it happens).
        let mut w = WatchSet::default();
        let topics = HashSet::from([logs::topic0::<Swapped>(), logs::topic0::<Upgraded>()]);
        for p in [POOL, RETIRED_POOL] {
            w.logs.insert(to_addr(p), TopicFilter::Topics(topics.clone()));
        }
        for i in IMPLEMENTATIONS {
            w.txn_input.insert(to_addr(i));
        }
        Ok(w)
    }

    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let mut out = Vec::new();
        for l in block.logs.iter().filter(|l| is_pool(&l.address)) {
            if let Some(u) = logs::decode::<Upgraded>(l) {
                if !IMPLEMENTATIONS.contains(&u.implementation) {
                    // An ABI change would read exactly like a quiet venue:
                    // announce it and keep decoding.
                    tracing::warn!(
                        target: "venues",
                        "BTR: proxy {} upgraded to {} — re-verify quote/fill ABIs against it and add it to IMPLEMENTATIONS (its mark pushes are untracked until then)",
                        short_hex(&addr_hex(&l.address)),
                        short_hex(&addr_hex(&to_addr(u.implementation)))
                    );
                }
                continue;
            }
            let Some(s) = logs::decode::<Swapped>(l) else { continue };
            if let Some(f) = self.swap(cx, block, l, &s)? {
                out.push(f);
            }
        }
        Ok(out)
    }

    /// getSwapQuote(tokenIn, tokenOut, amountIn) on pool v2 per quotable
    /// market × size × side, pinned to the block: selling spends the base
    /// worth `size`, buying the quote token worth `size`, each in its own
    /// units. Price = quote per base, all-in.
    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        let markets = self.quotable_in_order(cx.registry);
        struct Leg {
            market: usize,
            size: f64,
            sell: bool,
            amount_in: U256,
            mid: f64,
        }
        let mut legs = Vec::new();
        let mut calls = Vec::new();
        for (i, m) in markets.iter().enumerate() {
            // The bps anchor is the pair-terms reference mid, not a raw USDT price.
            let mid = cx.pricer.pair_mid(&m.market);
            if mid <= 0.0 || cx.pricer.usd_per_token(&m.base_key) <= 0.0 || cx.pricer.usd_per_token(&m.quote_key) <= 0.0
            {
                continue;
            }
            for &size in sizes_usd {
                for sell in [true, false] {
                    let (in_key, input, in_dec, output) = if sell {
                        (&m.base_key, m.base, m.base_dec, m.quote)
                    } else {
                        (&m.quote_key, m.quote, m.quote_dec, m.base)
                    };
                    let amount_in = to_units(cx.pricer.token_for_usd(in_key, size), in_dec);
                    if amount_in.is_zero() {
                        continue;
                    }
                    calls.push((
                        POOL,
                        getSwapQuoteCall {
                            tokenIn: from_addr(&input),
                            tokenOut: from_addr(&output),
                            amountIn: amount_in,
                        },
                    ));
                    legs.push(Leg { market: i, size, sell, amount_in, mid });
                }
            }
        }
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let res = call_many(cx.rpc, &calls, At::Hash(cx.block.hash)).await?;
        // Every leg failing is venue-wide (halted, feed gate, ABI drift), not
        // a thin market: name it instead of vanishing.
        quote_health::check_outage(&meta().name, &res)?;
        let ts = now_ms();
        // One row per (market, size) in the order its first answered leg
        // came, with each answered leg's fee.
        let mut rows: Vec<(QuoteRow, Vec<f64>)> = Vec::new();
        for (leg, r) in legs.iter().zip(res) {
            let Ok(q) = r else { continue };
            if q.amountOut.is_zero() {
                continue;
            }
            let m = &markets[leg.market];
            let (in_dec, out_dec) = if leg.sell { (m.base_dec, m.quote_dec) } else { (m.quote_dec, m.base_dec) };
            let in_h = from_units(leg.amount_in, in_dec);
            let out_h = from_units(q.amountOut, out_dec);
            if in_h <= 0.0 || out_h <= 0.0 {
                continue;
            }
            let idx = match rows.iter().position(|(x, _)| x.market == m.market && x.size_usd == leg.size) {
                Some(i) => i,
                None => {
                    rows.push((
                        QuoteRow {
                            venue_id: ID.into(),
                            market: m.market.clone(),
                            size_usd: leg.size,
                            bid_bps: 0.0,
                            ask_bps: 0.0,
                            bid_px: 0.0,
                            ask_px: 0.0,
                            spread_bps: 0.0,
                            // A leg past the pool's caps reverts: an answer is the full size.
                            filled_full: true,
                            one_sided: None,
                            fee_bps: 0.0,
                            cex_ask_bps: None,
                            cex_bid_bps: None,
                            ts,
                        },
                        Vec::new(),
                    ));
                    rows.len() - 1
                }
            };
            let (row, fees) = &mut rows[idx];
            // The fee as the pool charges it: (protocol + LP fee) over the
            // GROSS output, both in tokenOut units, to 0.001 bp.
            let fee = q.protoFee.saturating_add(q.lpFee);
            let gross = q.amountOut.saturating_add(fee);
            if !gross.is_zero() {
                fees.push(to_f64(fee.saturating_mul(U256::from(10_000_000u64)) / gross) / 1000.0);
            }
            if leg.sell {
                row.bid_px = out_h / in_h;
                row.bid_bps = (row.bid_px / leg.mid - 1.0) * 1e4;
            } else {
                row.ask_px = in_h / out_h;
                row.ask_bps = (row.ask_px / leg.mid - 1.0) * 1e4;
            }
        }
        Ok(rows
            .into_iter()
            .map(|(mut row, fees)| {
                if !fees.is_empty() {
                    row.fee_bps = fees.iter().fold(0.0, |a, b| a + b) / fees.len() as f64;
                }
                if row.bid_px > 0.0 && row.ask_px > 0.0 {
                    row.spread_bps = row.ask_bps - row.bid_bps;
                } else {
                    // E.g. the pool holds too little of one side.
                    row.one_sided = Some(true);
                }
                row
            })
            .collect())
    }

    fn markets(&self) -> Vec<String> {
        let mut m: Vec<String> = self.quotable.read().keys().cloned().collect();
        m.sort();
        m
    }

    /// Takers call a pool directly, or enter through one of BTR's own
    /// executors; an aggregator's router is attributed by the core.
    fn entry_points(&self) -> Vec<EntryPoint> {
        // Takers call a pool directly, or enter through BTR's router or one
        // of its own executors (the CoopArb executor named on its own, so its
        // flow stays separable).
        [POOL, RETIRED_POOL]
            .into_iter()
            .map(|a| EntryPoint { address: to_addr(a), router: None })
            .chain(std::iter::once(EntryPoint { address: to_addr(ROUTER), router: Some("BTR".into()) }))
            .chain(EXECUTORS.into_iter().map(|a| EntryPoint {
                address: to_addr(a),
                router: Some(if a == COOP_ARB { "BTR Coop Arb" } else { "BTR" }.into()),
            }))
            .collect()
    }

    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(Some(GasSources {
            destinations: IMPLEMENTATIONS.iter().map(|a| to_addr(*a)).collect(),
            ..GasSources::default()
        }))
    }

    fn history_revisions(&self) -> Vec<HistoryRevision> {
        // The lifetime backfill valued the crypto-quoted trades (the first on
        // 10-13) at its own day's prices; replays now price each closed day
        // as of its own blocks.
        vec![HistoryRevision { id: "fill-time-usd", from: Some("2026-10-13"), source: RevisionSource::Replay }]
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        // The retired pool's deployment day.
        Some("2026-10-01")
    }
}
