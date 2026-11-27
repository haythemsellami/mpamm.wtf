//! Hanji, ported from server/src/venues/hanji.ts: a fully on-chain order
//! book whose entire passive side is the protocol's LP vault, i.e. a propAMM
//! quoting through a CLOB. Seventeen books: six crypto pairs, XAUt0/USDC
//! (made by a second vault with its own quoter) and ten wrapped xStocks from
//! two deployments.
//!
//!   CLOB.getConfig()    → share scaling, token layout, taker fee; checked
//!                         against the table so a drift fails discovery
//!                         instead of mispricing every fill
//!   CLOB.OrderPlaced(…) → a trade when `aggressive_shares > 0`
//!
//! Units are SHARES: base = shares × scalingX / 10^xDec and quote = value ×
//! scalingY / 10^yDec. The event's `price` is the LIMIT (market orders carry
//! sentinels), so the realized price is quote / base. The USD notional is
//! the gross quote leg, fee excluded (each fixture fill was matched to its
//! own ERC-20 transfers).
//!
//! Gas: Hanji's keeper writes prices into a FastQuoter with log-less
//! `updatePrices(uint256)` pushes from heavily rotating EOAs, so updates are
//! keyed by destination; every direct transaction to a quoter is an update.
//! From gen8 the keeper also bids through FastLane's shared AuctionHandler,
//! matched on calldata word 5 (`searcherToAddress`), never on `to` alone.
//!
//! Quotes: the book helper's `assembleOrderbooksFromOrders(proxy, 60)` per
//! book (the proxy view includes the vault's virtual liquidity), walked
//! within ±2000 bps of the pair mid, the taker fee on top. Today's adapter
//! reads the books through Multicall3, 15 to an aggregate at viem's 1 KB
//! chunks: ~11.3M gas for the first 15 and ~12.2M for all 17 in one
//! (measured 2026-11-27; the spec's 8.72M was an earlier reading). One book
//! costs 0.22–0.90M (MON/ETH, cbBTC/MON and cbBTC/ETH the heaviest), so here
//! each book is its own `eth_call` under the 8M every read carries, all of
//! them in one JSON-RPC batch the node runs in parallel. The answers are the
//! same state, so the rows are too.

use std::collections::{HashMap, HashSet};

use alloy_primitives::{
    aliases::{U24, U72},
    Address, U256,
};
use alloy_sol_types::sol;
use async_trait::async_trait;
use mpamm_core::{
    ChainCx, DecodeCx, EntryPoint, FinalBlock, GasRelay, GasSources, HistoryRevision, QuoteCx, RevisionSource, Venue,
    VenueError,
};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{Addr, TopicFilter, WatchSet};
use mpamm_types::{Fill, FillCategory, QuoteRow, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call_many, At},
    logs, quote_health,
    util::{b32_hex, fill_id, from_addr, short_hex, to_addr, to_f64},
};

pub const ID: &str = "hanji";

sol! {
    // Verified layout, all 17 CLOBs (fixtures/hanji-config.json): scaling
    // factors, token addresses, and the 1e18-scaled taker fee rate at index 9.
    function getConfig() view returns (uint256 scalingX, uint256 scalingY, address tokenX, address tokenY, uint256 f4, uint256 f5, address a6, address a7, uint256 f8, uint256 takerFeeRate, uint256 f10, uint256 f11, uint256 f12);
    event OrderPlaced(address indexed owner, address indexed initiator, uint64 order_id, bool indexed isAsk, uint128 quantity, uint72 price, uint128 passive_shares, uint128 passive_fee, uint128 aggressive_shares, uint128 aggressive_value, uint128 aggressive_fee, bool market_only, bool post_only);
    // The book helper: each side best level first, raw prices and shares.
    function assembleOrderbooksFromOrders(address lobAddress, uint24 maxPriceLevels) view returns (uint72[] bidPrices, uint128[] bidShares, uint72[] askPrices, uint128[] askShares);
}

/// Book depth asked per quote: enough for the largest probed notional.
pub const BOOK_LEVELS: u32 = 60;

/// Per-side sanity band (bps from the pair mid): a level priced beyond it is
/// not comparable liquidity, so the walk never reaches it. The books carry
/// far-tick stub orders below the vault's ladder (MON/USDC bids of 1 MON @
/// $0.001 and 10,000 MON @ $0.0001, asks @ $10,000 and $24,172; a 1-cbBTC
/// bid @ 1 MON on cbBTC/MON); walking into them once published "full"
/// two-sided rows at −9961 and −5728 bps. With the band, a side whose
/// in-band depth runs out is a partial, and a side with none is absent.
const PER_SIDE_BAND_BPS: f64 = 2_000.0;

const FAST_QUOTER_HELPER: &str = "0x237dB58fea34A35A8543b44C217d221606cE7788";
// Each xStock deployment has its own book helper.
const STOCKS_HELPER: &str = "0x9e6092fc526AB6e0927C146911a186fbCF7Df318";
const STOCKS_2_HELPER: &str = "0x4A92a35eE23E07B3ba1C9D954DEA315Dd91030c9";

/// One configured book. `clob` keeps today's spelling: the pool label is
/// its first 8 characters, case included.
#[derive(Debug, Clone, Copy)]
pub struct Known {
    /// The registered pair symbol.
    pub market: &'static str,
    pub clob: &'static str,
    /// The taker entry point (a direct trade's `to`), and what quotes read.
    pub proxy: &'static str,
    /// Registry token keys.
    pub base_tok: &'static str,
    pub quote_tok: &'static str,
    /// The book helper quotes go through.
    pub helper: &'static str,
}

const fn book(
    market: &'static str,
    clob: &'static str,
    proxy: &'static str,
    base_tok: &'static str,
    quote_tok: &'static str,
    helper: &'static str,
) -> Known {
    Known { market, clob, proxy, base_tok, quote_tok, helper }
}

/// Hanji's books (team-provided, tokens verified on-chain via getConfig).
/// XAUt/USDC is made by a second vault (0xff0cC147…) priced by
/// XAUT_FAST_QUOTER; it traded from 2026-09-24 but went unlisted until
/// 2026-10-20 (the `xaut-book` revision). Table order is discovery order.
#[rustfmt::skip]
pub const KNOWN_MARKETS: [Known; 17] = [
    book("MON/USDC", "0xC35b1Ca1a2C398A21df5783b3a5eA6A2D56f298F", "0x1aeD222dda944a87703c918745b11bE13f8eEf10", "WMON", "USDC", FAST_QUOTER_HELPER),
    book("ETH/USDC", "0xAC652E05Ac4B2e9eCaE5C65595E4E4E2734F61Cc", "0x0ACBA24cecd750bAdB3179FB9eE3F2Cd27431778", "WETH", "USDC", FAST_QUOTER_HELPER),
    book("cbBTC/USDC", "0xbc87C6e5A9788404C143D42474508956267B253D", "0xC11805e92CA6a36cE9507902Ab6Bb5Cd11e438bf", "CBBTC", "USDC", FAST_QUOTER_HELPER),
    book("MON/ETH", "0xBe717AEdc2cdc0a4d3903B7A6a70691942E72793", "0xc4aDcB94D0dce7fc84e180fAE3621Df13ad37e06", "WMON", "WETH", FAST_QUOTER_HELPER),
    book("cbBTC/MON", "0x77ED4fcB978fa0CE78799064cB38D12FE7c3ce7d", "0x012e06b56EEE881603E47748931dC38EfaBf54eF", "CBBTC", "WMON", FAST_QUOTER_HELPER),
    book("cbBTC/ETH", "0x8A89f08d3B5aB37f634f2B4dCf2DB29Ecf9938c7", "0x05e028d33fA727168bC9396bDAc5Cab387c8a196", "CBBTC", "WETH", FAST_QUOTER_HELPER),
    book("XAUt/USDC", "0xa49d9ea941e4adb7e60aeee49fd6c9fb122925ab", "0x88687e499846ce3037e63754a6e2e7b53483c70e", "XAUT0", "USDC", FAST_QUOTER_HELPER),
    book("wTSLAx/USDC", "0x09EB706c2786eFd4a91b7a5b9EeB11ccF656f34d", "0x1a430B224c69F74587F1A8c0a24C0741B976Aefc", "WTSLAX", "USDC", STOCKS_HELPER),
    book("wNVDAx/USDC", "0xC08ef5B51b72A6F74757f04A658779BeFeF3607A", "0x6432165433eFf6611dBB124acec6Db14F93554Ad", "WNVDAX", "USDC", STOCKS_HELPER),
    book("wSPYx/USDC", "0x3A7c91C12c3190f107B1940D4154639585c7eA94", "0x76bD7aC128f9387B2a2162C8c2d5026016984B33", "WSPYX", "USDC", STOCKS_HELPER),
    book("wQQQx/USDC", "0x3f1fb72726D300B2d636c23d7513Fd6cE22dB34A", "0x3955594b8FD2aB0728f242A6dfC446D2f289B293", "WQQQX", "USDC", STOCKS_HELPER),
    book("wEWYx/USDC", "0x9b135FcB6F2cD1c963179fd63C5F4a571B9c9634", "0x65b7076C9a6b2C5c2435fC9b7b0CD6458005B114", "WEWYX", "USDC", STOCKS_HELPER),
    book("wANTx/USDC", "0x3F9adE74Cdcde8d7CA0d0BBa3B61FaE77cCB3e29", "0x4EB3333571098AEb6710fB0db9Ee91eBb9dF0295", "WANTX", "USDC", STOCKS_2_HELPER),
    book("wSPCXx/USDC", "0xC51d3678624ec9511b8A992a59746831769308e8", "0xbdf8eF217027c8AA355bA6019184b6CE67E8b526", "WSPCXX", "USDC", STOCKS_2_HELPER),
    book("wMUx/USDC", "0x16EC8F28325b6dbF171c28056814A1F3Bafb5100", "0x403A596d1E9e0ed4b7b2fEcD2c22580CD5388AB7", "WMUX", "USDC", STOCKS_2_HELPER),
    book("wSKHYx/USDC", "0x3C4713169d50c78d37A09cea043f7b83F56C4dE9", "0x91C2366B8131EF640adc3eAeC2B9C30A21b79EDe", "WSKHYX", "USDC", STOCKS_2_HELPER),
    book("wSMHx/USDC", "0x574e0853dee419D5EA6b4e660A2bc320066c4F49", "0x060Cbd657298dbE452b9Fa49D0FCE4984bC807Bc", "WSMHX", "USDC", STOCKS_2_HELPER),
];

/// Every FastQuoter generation, oldest first. Hanji redeploys it every week
/// or two and the old one simply stops receiving pushes; every generation
/// stays listed so the burn series spans the cutovers (a missing one doesn't
/// error, it flatlines the burn while the venue trades on: gen3 went 11 days
/// that way, gen5 3, gen6+gen7 14, gen8 8). The invariant across all of them
/// is `owner() == 0xA24D2aF7…`; never identify one by gas limit. NOT OURS:
/// 0xc1ff9fef…b0fc pushes the same selector but has another owner and ran
/// concurrently with gen1 — check owner() before appending anything.
const FAST_QUOTERS: [&str; 9] = [
    "0xd637b38f8436fc4974ce9236d65888a1bac64160", // gen0 — 2026-06-26 → 06-30
    "0x04fdEAC24E4e57364B4F22844106583d88F747d7", // gen1 — 2026-06-30 → 07-16
    "0x48cba27861983367c3fb063877b144a628e2b48b", // gen2 — 2026-07-16 → ~07-30
    "0x91855e7930044a8f13f10b336abf551f1f58ac7e", // gen3 — 2026-07-30
    "0xeae24c729ee1a38554037e4ad25ef1e3c9e30be0", // gen4 — 2026-08-08
    "0x103de0b5226a2a6d8b918d8192dc23248825bb55", // gen5 — 2026-08-14 → 08-22
    "0xbb3f3cb75f3a652a3ee47c5cacceef794874e046", // gen6 — 2026-08-21 → ~08-25
    "0xf5b5f7f8ef84419c030dfc44771734810ea36d70", // gen7 — 2026-08-25 → ~09-21
    "0x125f12a1938b97f11fdc35b1a5fb4d5217cda50b", // gen8 — 2026-09-21 (block 106814526), active
];

/// A second live quoter beside gen8, not after it: it prices the XAUt0/USDC
/// book only (traced). Leaving it out understated the burn by ~31%.
const XAUT_FAST_QUOTER: &str = "0x1fb37a1e6dc03a523bba106cb25e398e8608a010";
/// The xStock books' quoters, one per deployment (traced from each helper),
/// created the day each deployment's five books launched.
const STOCKS_FAST_QUOTER: &str = "0x02fe828a897b18ea37fa477436a8013578a3aa96";
const STOCKS_2_FAST_QUOTER: &str = "0xae5b4a1775f05b8818209e35c01630feac99b60b";

/// FastLane's AuctionHandler: `flashExecutionBid(…, searcherToAddress,
/// searcherCallData)` (selector 0x0c7abd22) with searcherToAddress = the
/// quoter in word 5. Shared by many searchers, and ~30% of these bids revert
/// log-less while still paying the full limit, so only calldata names them.
const FASTLANE_AUCTION_HANDLER: &str = "0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58";
const FASTLANE_SELECTOR: [u8; 4] = [0x0c, 0x7a, 0xbd, 0x22];
const FASTLANE_TARGET_WORD: usize = 5;
/// The relay's targets: only gen8+ carry `fastLaneCall` (gen0–7 bytecode
/// lacks it), so the FastLane route names only these, and adding it rebuilt
/// gas from gen8's creation day rather than the lifetime.
const FASTLANE_QUOTERS: [&str; 4] = [FAST_QUOTERS[8], XAUT_FAST_QUOTER, STOCKS_FAST_QUOTER, STOCKS_2_FAST_QUOTER];

/// One of the table's constant addresses.
fn addr(s: &str) -> Addr {
    parse_address(s).expect("constant address")
}

/// 10^d as JavaScript's `10 ** d` gives it (exact for d ≤ 22).
fn pow10(d: u8) -> f64 {
    format!("1e{d}").parse().expect("finite power of ten")
}

/// One CLOB's getConfig answer, as discovery uses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookConfig {
    pub scaling_x: U256,
    pub scaling_y: U256,
    pub token_x: Addr,
    pub token_y: Addr,
    /// 1e18-scaled.
    pub taker_fee_rate: U256,
}

impl From<getConfigReturn> for BookConfig {
    fn from(r: getConfigReturn) -> Self {
        Self {
            scaling_x: r.scalingX,
            scaling_y: r.scalingY,
            token_x: to_addr(r.tokenX),
            token_y: to_addr(r.tokenY),
            taker_fee_rate: r.takerFeeRate,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Market {
    pub market: String,
    pub clob: Addr,
    /// What quotes read (its book includes the vault's liquidity).
    pub proxy: Addr,
    /// The book helper quotes go through.
    pub helper: Addr,
    /// `lob 0x…`, from the table's spelling of the CLOB.
    pub pool: String,
    pub base_tok: String,
    pub quote_tok: String,
    /// Shares → whole base: scalingX / 10^xDec.
    pub base_share: f64,
    /// Value units → whole quote: scalingY / 10^yDec.
    pub quote_share: f64,
    /// Raw uint72 price → quote per base.
    pub px_scale: f64,
    pub fee_bps: f64,
}

#[derive(Debug, Default)]
struct Inner {
    by_clob: HashMap<Addr, Market>,
    discovered: bool,
}

#[derive(Default)]
pub struct Hanji {
    inner: RwLock<Inner>,
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "Hanji pAMM Vault".into(),
        // Fuchsia in both themes (distinct from Clober and the UI accent).
        color: ThemeColor { light: "#A21CAF".into(), dark: "#C026D3".into() },
        kind: VenueKind::Clob,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        // The CLOBs' on-chain deploy day.
        since_utc: Some("2026-06-05".into()),
        quote_note: None,
    }
}

/// The books a complete getConfig answer admits, in table order. Fails
/// closed: a configured book that doesn't answer, an unknown token key or an
/// on-chain token layout that differs from the table rejects the whole
/// answer, so a partial discovery never shrinks or corrupts what is tailed.
/// A book whose pair isn't registered is skipped.
pub fn admit(registry: &Registry, answers: Vec<Result<BookConfig, VenueError>>) -> Result<Vec<Market>, VenueError> {
    let mut answers = answers.into_iter();
    let mut found = Vec::new();
    for k in &KNOWN_MARKETS {
        let failed =
            |why: String| VenueError::Chain(format!("Hanji getConfig failed for {} ({}){why}", k.market, k.clob));
        let cfg = answers.next().ok_or_else(|| failed(String::new()))?.map_err(|e| failed(format!(": {e}")))?;
        let (Some(base), Some(quote)) = (registry.tokens.get(k.base_tok), registry.tokens.get(k.quote_tok)) else {
            return Err(VenueError::Chain(format!("Hanji {}: unknown token key", k.market)));
        };
        // A stale table would make every unit below wrong.
        if cfg.token_x != base.address_bytes() || cfg.token_y != quote.address_bytes() {
            return Err(VenueError::Chain(format!(
                "Hanji {}: on-chain tokens {}/{} don't match {}/{}",
                k.market,
                Address::from(cfg.token_x),
                Address::from(cfg.token_y),
                k.base_tok,
                k.quote_tok
            )));
        }
        if registry.pair_of(k.market).is_none() {
            tracing::warn!(target: "venues", "Hanji pAMM Vault: {} is not a registered pair — skipped", k.market);
            continue;
        }
        let base_share = to_f64(cfg.scaling_x) / pow10(base.decimals);
        let quote_share = to_f64(cfg.scaling_y) / pow10(quote.decimals);
        found.push(Market {
            market: k.market.into(),
            clob: addr(k.clob),
            proxy: addr(k.proxy),
            helper: addr(k.helper),
            pool: format!("lob {}", &k.clob[..8]),
            base_tok: k.base_tok.into(),
            quote_tok: k.quote_tok.into(),
            base_share,
            quote_share,
            px_scale: quote_share / base_share,
            fee_bps: to_f64(cfg.taker_fee_rate) / 1e14,
        });
    }
    Ok(found)
}

impl Hanji {
    /// A venue already discovered from recorded getConfig answers (tests and
    /// tools).
    pub fn with_configs(registry: &Registry, configs: Vec<BookConfig>) -> Result<Self, VenueError> {
        let h = Self::default();
        h.apply(registry, configs.into_iter().map(Ok).collect())?;
        Ok(h)
    }

    /// Admits one discovery answer (one per table row, in order) and merges
    /// it; a rejected answer changes nothing.
    pub fn apply(&self, registry: &Registry, answers: Vec<Result<BookConfig, VenueError>>) -> Result<(), VenueError> {
        let found = admit(registry, answers)?;
        let mut inner = self.inner.write();
        // Merge, never replace: discovery only adds or refreshes books.
        for m in found {
            inner.by_clob.insert(m.clob, m);
        }
        inner.discovered = true;
        Ok(())
    }
}

/// Where Hanji's quote updates go: every quoter generation, the XAUt0 and
/// xStock quoters, and the FastLane route.
fn gas() -> GasSources {
    let fast_lane: HashSet<Addr> = FASTLANE_QUOTERS.iter().map(|q| addr(q)).collect();
    let direct_only = FAST_QUOTERS.iter().map(|q| addr(q)).filter(|q| !fast_lane.contains(q));
    let destinations = direct_only.chain(FASTLANE_QUOTERS.iter().map(|q| addr(q))).collect();
    GasSources {
        destinations,
        relays: vec![GasRelay {
            address: addr(FASTLANE_AUCTION_HANDLER),
            selector: FASTLANE_SELECTOR,
            target_word: FASTLANE_TARGET_WORD,
            targets: fast_lane.into_iter().collect(),
        }],
        ..GasSources::default()
    }
}

impl Hanji {
    /// The discovered books in the registry's pair order (today's order:
    /// the table follows it).
    fn in_order(&self, registry: &Registry) -> Vec<Market> {
        let inner = self.inner.read();
        let by_market: HashMap<&str, &Market> = inner.by_clob.values().map(|m| (m.market.as_str(), m)).collect();
        registry.pairs.iter().filter_map(|p| by_market.get(p.symbol.as_str()).map(|m| (*m).clone())).collect()
    }
}

/// One side of a book walked for `base_needed`: the VWAP of what filled
/// (0 when nothing did) and whether it filled all but 0.1%.
struct Walk {
    vwap: f64,
    filled_full: bool,
}

/// Best level first, in-band levels only: raw price × px_scale is quote per
/// base, shares × base_share whole base (today's `Number(raw) * scale`).
fn walk(prices: &[U72], shares: &[u128], m: &Market, px_mid: f64, base_needed: f64) -> Walk {
    let (mut remaining, mut cost) = (base_needed, 0.0);
    for (p, s) in prices.iter().zip(shares) {
        // Today's `remaining > 0` loop guard and `!(… <= band)` skip: NaN
        // stops the walk and is never in band.
        let wanting = remaining > 0.0;
        if !wanting {
            break;
        }
        let px = to_f64(U256::from(*p)) * m.px_scale;
        let in_band = (px / px_mid - 1.0).abs() * 1e4 <= PER_SIDE_BAND_BPS;
        if !in_band {
            continue;
        }
        let take = (*s as f64 * m.base_share).min(remaining);
        cost += take * px;
        remaining -= take;
    }
    let filled = base_needed - remaining;
    Walk { vwap: if filled > 0.0 { cost / filled } else { 0.0 }, filled_full: remaining <= base_needed * 0.001 }
}

/// Wall-clock milliseconds, today's `Date.now()`.
fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[async_trait]
impl Venue for Hanji {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let calls: Vec<(Address, getConfigCall)> =
            KNOWN_MARKETS.iter().map(|k| (Address::from(addr(k.clob)), getConfigCall {})).collect();
        let answers = call_many(cx.rpc, &calls, At::Latest).await?;
        self.apply(cx.registry, answers.into_iter().map(|r| r.map(BookConfig::from)).collect())?;
        let inner = self.inner.read();
        let fee = KNOWN_MARKETS
            .iter()
            .find_map(|k| inner.by_clob.get(&addr(k.clob)))
            .map_or("?".to_string(), |m| m.fee_bps.to_string());
        tracing::info!(target: "venues", "Hanji pAMM Vault: {} market(s), taker fee {fee}bps (on-chain config)", inner.by_clob.len());
        Ok(())
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        let inner = self.inner.read();
        if !inner.discovered {
            return Err(VenueError::NotReady("Hanji discovery unavailable".into()));
        }
        let mut w = WatchSet::default();
        for clob in inner.by_clob.keys() {
            w.logs.insert(*clob, TopicFilter::Topics(HashSet::from([logs::topic0::<OrderPlaced>()])));
        }
        let g = gas();
        w.txn_input.extend(g.destinations);
        w.txn_input.extend(g.relays.iter().map(|r| r.address));
        Ok(w)
    }

    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let inner = self.inner.read();
        let mut out = Vec::new();
        for l in &block.logs {
            let Some(m) = inner.by_clob.get(&l.address) else { continue };
            let Some(e) = logs::decode::<OrderPlaced>(l) else { continue };
            // Only the aggressive portion of an order is a trade; passive
            // placements (the vault's re-quotes included) are not.
            if e.aggressive_shares == 0 || e.aggressive_value == 0 {
                continue;
            }
            let base_amount = e.aggressive_shares as f64 * m.base_share;
            let quote_amount = e.aggressive_value as f64 * m.quote_share;
            if base_amount <= 0.0 || quote_amount <= 0.0 {
                continue;
            }
            // The quote leg (exactly $1 per stable); a crypto-quoted pair
            // prices it at the fill's time, with the base leg as fallback.
            // Neither priceable fails closed rather than store a $0 trade.
            let mut usd = cx.pricer.usd_for_token(&m.quote_tok, quote_amount);
            if usd <= 0.0 {
                usd = cx.pricer.usd_for_token(&m.base_tok, base_amount);
            }
            if usd <= 0.0 {
                return Err(VenueError::Decode(format!(
                    "Hanji {}: no USD price for either leg (feeds warming?)",
                    m.market
                )));
            }
            out.push(Fill {
                id: fill_id(ID, &l.tx_hash, l.log_index),
                venue_id: ID.into(),
                market: m.market.clone(),
                // isAsk: the aggressive order sells the base into the book.
                side: if e.isAsk { Side::Sell } else { Side::Buy },
                // Attribution is the core's job: the event's owner/initiator
                // are the proxy for routed flow.
                category: FillCategory::Unknown,
                usd,
                base_amount,
                // Realized VWAP in pair terms.
                exec_px: quote_amount / base_amount,
                px_approx: false,
                tx_hash: b32_hex(&l.tx_hash),
                // viem hands decoded addresses checksummed; today's label keeps that case.
                to: short_hex(&e.initiator.to_string()),
                router: None,
                pool: m.pool.clone(),
                block_number: block.number,
                ts: block.time_ms(),
                markouts_bps: vec![None; 5],
                time_source: None,
            });
        }
        Ok(out)
    }

    /// Each priced book read through its helper (one call per book, all in
    /// one batch pinned to the block), both sides walked per size: buying
    /// the base consumes asks, selling it consumes bids. The ladder is raw
    /// prices, so the taker fee goes on top.
    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        // The bps anchor is the pair-terms reference mid; a book with no mid,
        // or whose base has no USD to size with, can't make a row: not read.
        let books: Vec<(Market, f64)> = self
            .in_order(cx.registry)
            .into_iter()
            .filter_map(|m| {
                let mid = cx.pricer.pair_mid(&m.market);
                let sized = sizes_usd.iter().any(|&s| cx.pricer.token_for_usd(&m.base_tok, s) > 0.0);
                (mid > 0.0 && sized).then_some((m, mid))
            })
            .collect();
        if books.is_empty() {
            return Ok(Vec::new());
        }
        let calls: Vec<(Address, assembleOrderbooksFromOrdersCall)> = books
            .iter()
            .map(|(m, _)| {
                (
                    from_addr(&m.helper),
                    assembleOrderbooksFromOrdersCall {
                        lobAddress: from_addr(&m.proxy),
                        maxPriceLevels: U24::from(BOOK_LEVELS),
                    },
                )
            })
            .collect();
        let res = call_many(cx.rpc, &calls, At::Hash(cx.block.hash)).await?;
        // Every book failing is venue-wide (paused, ABI drift), not a thin
        // market: name it instead of vanishing.
        quote_health::check_outage(&meta().name, &res)?;
        let ts = now_ms();
        let mut rows = Vec::new();
        for ((m, px_mid), r) in books.iter().zip(res) {
            let Ok(book) = r else { continue };
            let fee = m.fee_bps / 1e4;
            for &size in sizes_usd {
                let base_needed = cx.pricer.token_for_usd(&m.base_tok, size);
                if base_needed <= 0.0 {
                    continue;
                }
                let buy = walk(&book.askPrices, &book.askShares, m, *px_mid, base_needed);
                let sell = walk(&book.bidPrices, &book.bidShares, m, *px_mid, base_needed);
                let (has_ask, has_bid) = (buy.vwap > 0.0, sell.vwap > 0.0);
                if !has_ask && !has_bid {
                    continue;
                }
                let ask_px = if has_ask { buy.vwap * (1.0 + fee) } else { 0.0 };
                let bid_px = if has_bid { sell.vwap * (1.0 - fee) } else { 0.0 };
                rows.push(QuoteRow {
                    venue_id: ID.into(),
                    market: m.market.clone(),
                    size_usd: size,
                    bid_bps: if has_bid { (bid_px / px_mid - 1.0) * 1e4 } else { 0.0 },
                    ask_bps: if has_ask { (ask_px / px_mid - 1.0) * 1e4 } else { 0.0 },
                    bid_px,
                    ask_px,
                    spread_bps: if has_ask && has_bid { ((ask_px - bid_px) / px_mid) * 1e4 } else { 0.0 },
                    filled_full: (!has_ask || buy.filled_full) && (!has_bid || sell.filled_full),
                    one_sided: if has_ask && has_bid { None } else { Some(true) },
                    fee_bps: m.fee_bps,
                    cex_ask_bps: None,
                    cex_bid_bps: None,
                    ts,
                });
            }
        }
        Ok(rows)
    }

    fn markets(&self) -> Vec<String> {
        let inner = self.inner.read();
        KNOWN_MARKETS.iter().filter_map(|k| inner.by_clob.get(&addr(k.clob)).map(|m| m.market.clone())).collect()
    }

    /// The per-market proxies: a direct trade's `to` (the CLOBs are only
    /// reached through them).
    fn entry_points(&self) -> Vec<EntryPoint> {
        KNOWN_MARKETS.iter().map(|k| EntryPoint { address: addr(k.proxy), router: None }).collect()
    }

    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(Some(gas()))
    }

    /// Today's `historyRevisions`, same ids (applied once per database).
    fn history_revisions(&self) -> Vec<HistoryRevision> {
        vec![
            HistoryRevision {
                id: "replay-0921-midnight",
                from: Some("2026-09-17"),
                source: RevisionSource::Fills { until: "2026-09-20" },
            },
            HistoryRevision {
                id: "xaut-book",
                from: Some("2026-09-21"),
                source: RevisionSource::Markets(&["XAUt/USDC"]),
            },
            HistoryRevision {
                id: "wrapped-xstocks",
                from: Some("2026-11-08"),
                source: RevisionSource::Markets(&[
                    "wTSLAx/USDC",
                    "wNVDAx/USDC",
                    "wSPYx/USDC",
                    "wQQQx/USDC",
                    "wEWYx/USDC",
                ]),
            },
            HistoryRevision {
                id: "wrapped-xstocks-2",
                from: Some("2026-11-19"),
                source: RevisionSource::Markets(&[
                    "wANTx/USDC",
                    "wSPCXx/USDC",
                    "wMUx/USDC",
                    "wSKHYx/USDC",
                    "wSMHx/USDC",
                ]),
            },
        ]
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        Some("2026-06-05")
    }
}
