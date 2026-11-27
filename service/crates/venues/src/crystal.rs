//! Crystal Vault, ported from server/src/venues/crystal.ts. Crystal is a
//! multi-market on-chain CLOB whose core contract logs every market's events
//! (market in topic1). On WMON/USDC the passive side is the protocol's
//! CrystalVault, repriced by its owner-keeper: a propAMM quoting through a
//! book.
//!
//!   scope:  ONLY the vault's MAKER legs count. The book is open (outside
//!           makers rest orders on it) and the vault also TAKES for its own
//!           arbitrage; counting every Trade would book both as venue volume.
//!   fills:  `Fill(market, maker, fillInfo, fillAmount)` per maker order a
//!           taker consumes, then ONE `Trade(market, taker, isBuy, …)` per
//!           taker order, in that log order. The vault's legs of a trade are
//!           summed into one trade keyed on the Trade's log index.
//!             fillInfo   = takerSells << 252 | price << 168 | orderId << 112 | left
//!             fillAmount = paidToMaker << 128 | paidToTaker
//!           A taker BUY pays USDC and receives WMON; a SELL the reverse.
//!   units:  the raw token amounts (USDC 6 dp, WMON 18), never the price word.
//!   fees:   the taker fee is around the legs, so USD is the GROSS USDC leg;
//!           the maker rebate is inside them, so execPx is the realized price.
//!   gas:    the keeper's `execute` pushes, sent straight to the vault until
//!           2026-11-07, since then relayed by FastLane's shared handler to the
//!           keeper's own (EIP-7702) account, named in calldata word 5.
//!
//! The vault can only trade its market, whose tokens are immutable, and can
//! only move to a new market for the same pair: a vault leg on any market is
//! WMON/USDC (verified at discovery, which holds the cursor until it has).

use std::collections::HashSet;

use alloy_primitives::{address, Address, U256};
use async_trait::async_trait;
use mpamm_core::{
    ChainCx, DecodeCx, EntryPoint, FinalBlock, FinalLog, GasRelay, GasSources, HistoryRevision, Venue, VenueError,
};
use mpamm_registry::Registry;
use mpamm_ring::{Addr, TopicFilter, WatchSet, B32};
use mpamm_types::{Fill, FillCategory, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call, At},
    logs,
    util::{addr_hex, b32_hex, fill_id, short_hex, to_addr, to_f64},
};

pub const ID: &str = "crystal";
pub const CRYSTAL: Address = address!("508254c838b2e936b0631440c5c6e3ab3a4a98bd");
pub const VAULT: Address = address!("020f863a6212a9ed5caa73a087e62acd371b7334");
/// The vault's immutable owner, the keeper. Since 2026-11-07 (its EIP-7702
/// delegation) its pushes go through FastLane with the keeper itself as the
/// searcher, so it is the relayed destination.
pub const KEEPER: Address = address!("af9ed4d3153d821046885b4aea0f778addbb3de5");
pub const FASTLANE_AUCTION_HANDLER: Address = address!("d32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58");
/// `flashExecutionBid`; word 5 is `searcherToAddress`.
pub const FASTLANE_SELECTOR: [u8; 4] = [0x0c, 0x7a, 0xbd, 0x22];
const FASTLANE_TARGET_WORD: usize = 5;

const BASE_TOK: &str = "WMON";
const QUOTE_TOK: &str = "USDC";

pub mod abi {
    alloy_sol_types::sol! {
        struct MarketInfo {
            address quoteAsset;
            address baseAsset;
            uint256 marketType;
            uint256 highestBid;
            uint256 lowestAsk;
            uint256 scaleFactor;
            uint256 tickSize;
            uint256 maxPrice;
            uint256 minSize;
            uint256 takerFee;
            uint256 makerRebate;
            uint256 reserveQuote;
            uint256 reserveBase;
            bool isAMMEnabled;
        }
        function getMarket(address market) view returns (MarketInfo info);
        event Fill(address indexed market, address indexed user, uint256 fillInfo, uint256 fillAmount);
        event Trade(address indexed market, address indexed user, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 startPrice, uint256 endPrice);

        function market() view returns (address);
        function quoteAsset() view returns (address);
        function baseAsset() view returns (address);
    }
}
use abi::{baseAssetCall, getMarketCall, marketCall, quoteAssetCall, MarketInfo, Trade};

/// The vault's market, as discovery verified it.
#[derive(Debug, Clone, PartialEq)]
pub struct Book {
    pub market: Addr,
    /// The registered pair's symbol (MON/USDC).
    pub symbol: String,
    /// Human quote-per-base → raw book price (scaleFactor × 10^qDec / 10^bDec).
    pub px_scale: f64,
    pub fee_bps: f64,
}

#[derive(Default)]
pub struct Crystal {
    book: RwLock<Option<Book>>,
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "Crystal Vault".into(),
        color: ThemeColor { light: "#AD2B62".into(), dark: "#D14781".into() },
        kind: VenueKind::Clob,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2026-09-22".into()),
        quote_note: None,
    }
}

/// `10^d` as JavaScript's `10 ** d` (exact for any token's decimals).
fn pow10(d: u8) -> f64 {
    format!("1e{d}").parse().unwrap_or(f64::NAN)
}

/// Checks the vault's and its market's tokens against the registry (every
/// unit in decode assumes WMON/USDC) and returns the book. Fails closed.
pub fn verify_book(
    registry: &Registry,
    market: Address,
    vault_base: Address,
    vault_quote: Address,
    info: &MarketInfo,
) -> Result<Book, VenueError> {
    let pair = registry
        .pair_for("MON", QUOTE_TOK)
        .ok_or_else(|| VenueError::Chain("Crystal Vault: MON/USDC is not a registered pair".into()))?;
    let token = |k: &str| {
        registry.tokens.get(k).ok_or_else(|| VenueError::Chain(format!("Crystal Vault: no token {k} in the registry")))
    };
    let (base, quote) = (token(BASE_TOK)?, token(QUOTE_TOK)?);
    let (b, q) = (Address::from(base.address_bytes()), Address::from(quote.address_bytes()));
    if vault_base != b || vault_quote != q || info.baseAsset != b || info.quoteAsset != q {
        return Err(VenueError::Chain(format!(
            "Crystal Vault: vault {vault_base}/{vault_quote} on market {market} ({}/{}) is not {BASE_TOK}/{QUOTE_TOK}",
            info.baseAsset, info.quoteAsset
        )));
    }
    Ok(Book {
        market: to_addr(market),
        symbol: pair.symbol.clone(),
        px_scale: to_f64(info.scaleFactor) * pow10(quote.decimals) / pow10(base.decimals),
        fee_bps: (100_000.0 - to_f64(info.takerFee)) / 10.0,
    })
}

impl Crystal {
    /// A venue already discovered (tests and tools).
    pub fn with_book(book: Book) -> Self {
        Self { book: RwLock::new(Some(book)) }
    }

    pub fn book(&self) -> Option<Book> {
        self.book.read().clone()
    }
}

/// One maker leg: (fillInfo, fillAmount).
type Leg = (U256, U256);

#[async_trait]
impl Venue for Crystal {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let n = cx.rpc.block_number().await.map_err(|e| VenueError::Chain(format!("Crystal block number: {e}")))?;
        let at = At::Number(n);
        let market = call(cx.rpc, VAULT, &marketCall {}, at).await?;
        let quote_asset = call(cx.rpc, VAULT, &quoteAssetCall {}, at).await?;
        let base_asset = call(cx.rpc, VAULT, &baseAssetCall {}, at).await?;
        let info = call(cx.rpc, CRYSTAL, &getMarketCall { market }, at).await?;
        let book = verify_book(cx.registry, market, base_asset, quote_asset, &info)?;
        let maker_bps = (100_000.0 - to_f64(info.makerRebate)) / 10.0;
        let mut slot = self.book.write();
        if let Some(old) = slot.as_ref().filter(|o| o.market != book.market) {
            tracing::warn!(target: "venues", "Crystal Vault: vault moved from market {} to {}", addr_hex(&old.market), addr_hex(&book.market));
        }
        if info.isAMMEnabled {
            // The AMM leg would quote beside the vault; trades stay the vault's own.
            tracing::warn!(target: "venues", "Crystal Vault: market {} has its AMM enabled — quotes include AMM liquidity", addr_hex(&book.market));
        }
        tracing::info!(
            target: "venues",
            "Crystal Vault: {} market {}, taker fee {}bps + maker {maker_bps}bps (on-chain)",
            book.symbol,
            short_hex(&addr_hex(&book.market)),
            book.fee_bps
        );
        *slot = Some(book);
        Ok(())
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        if self.book.read().is_none() {
            // Hold the cursor until the vault's tokens are verified.
            return Err(VenueError::NotReady("Crystal Vault discovery unavailable".into()));
        }
        let mut w = WatchSet::default();
        // Every market's Fill/Trade; decode keeps the vault's.
        w.logs.insert(
            to_addr(CRYSTAL),
            TopicFilter::Topics(HashSet::from([logs::topic0::<abi::Fill>(), logs::topic0::<Trade>()])),
        );
        for a in [VAULT, KEEPER, FASTLANE_AUCTION_HANDLER] {
            w.txn_input.insert(to_addr(a));
        }
        Ok(w)
    }

    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let crystal = to_addr(CRYSTAL);
        let mut book_logs: Vec<&FinalLog> = block.logs.iter().filter(|l| l.address == crystal).collect();
        if book_logs.is_empty() {
            return Ok(Vec::new());
        }
        let Some(pair) = cx.registry.pair_for("MON", QUOTE_TOK) else { return Ok(Vec::new()) };
        let dec = |k: &str| {
            cx.registry.tokens.get(k).map(|t| t.decimals).ok_or_else(|| VenueError::Decode(format!("no token {k}")))
        };
        let (base_dec, quote_dec) = (dec(BASE_TOK)?, dec(QUOTE_TOK)?);
        let vault = to_addr(VAULT);
        let mask = (U256::from(1u8) << 128) - U256::from(1u8);
        // Fills precede their Trade: walk the block in log order.
        book_logs.sort_by_key(|l| l.log_index);
        // The vault's legs per (tx, market), closed by that market's next Trade.
        let mut open: Vec<((B32, Addr), Vec<Leg>)> = Vec::new();
        let mut out = Vec::new();
        for l in book_logs {
            if let Some(f) = logs::decode::<abi::Fill>(l) {
                if to_addr(f.user) != vault {
                    continue;
                }
                let key = (l.tx_hash, to_addr(f.market));
                match open.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, legs)) => legs.push((f.fillInfo, f.fillAmount)),
                    None => open.push((key, vec![(f.fillInfo, f.fillAmount)])),
                }
                continue;
            }
            let Some(t) = logs::decode::<Trade>(l) else { continue };
            let key = (l.tx_hash, to_addr(t.market));
            // No vault leg: an outside maker's trade.
            let Some(i) = open.iter().position(|(k, _)| *k == key) else { continue };
            let (_, legs) = open.remove(i);
            // The vault as its own taker would be a wash (none on record).
            if to_addr(t.user) == vault {
                continue;
            }
            let taker_sells = if t.isBuy { U256::ZERO } else { U256::from(1u8) };
            if legs.iter().any(|(info, _)| (*info >> 252) & U256::from(1u8) != taker_sells) {
                tracing::warn!(target: "venues", "Crystal Vault: fill legs disagree with their Trade's side in {} — skipped", b32_hex(&l.tx_hash));
                continue;
            }
            let (mut q, mut b) = (U256::ZERO, U256::ZERO);
            for (_, amount) in &legs {
                let (to_maker, to_taker) = (*amount >> 128, *amount & mask);
                if t.isBuy {
                    q = q.saturating_add(to_maker);
                    b = b.saturating_add(to_taker);
                } else {
                    b = b.saturating_add(to_maker);
                    q = q.saturating_add(to_taker);
                }
            }
            let base_amount = to_f64(b) / pow10(base_dec);
            let quote_amount = to_f64(q) / pow10(quote_dec);
            if base_amount <= 0.0 || quote_amount <= 0.0 {
                continue;
            }
            let usd = cx.pricer.usd_for_token(QUOTE_TOK, quote_amount);
            if usd <= 0.0 {
                return Err(VenueError::Decode("Crystal Vault: no USD price for USDC (feeds warming?)".into()));
            }
            out.push(Fill {
                id: fill_id(ID, &l.tx_hash, l.log_index),
                venue_id: ID.into(),
                market: pair.symbol.clone(),
                side: if t.isBuy { Side::Buy } else { Side::Sell },
                category: FillCategory::Unknown,
                usd,
                base_amount,
                exec_px: quote_amount / base_amount,
                px_approx: false,
                tx_hash: b32_hex(&l.tx_hash),
                // viem hands decoded addresses checksummed; today's labels keep that case.
                to: short_hex(&t.user.to_string()),
                router: None,
                pool: format!("book {}", &t.market.to_string()[..8]),
                block_number: block.number,
                ts: block.time_ms(),
                markouts_bps: vec![None; 5],
                time_source: None,
            });
        }
        // A vault leg whose Trade never arrived: the block is incomplete
        // (every taker order closes its fills with a Trade). Hold the cursor.
        if let Some(((tx, market), _)) = open.first() {
            return Err(VenueError::Decode(format!(
                "Crystal Vault: {} vault fill group(s) without their Trade (first: {}|{})",
                open.len(),
                b32_hex(tx),
                addr_hex(market)
            )));
        }
        Ok(out)
    }

    fn markets(&self) -> Vec<String> {
        self.book.read().as_ref().map(|b| vec![b.symbol.clone()]).unwrap_or_default()
    }

    /// Takers enter through Crystal itself (marketOrder, swap and the
    /// router-style entry points all live on the core contract).
    fn entry_points(&self) -> Vec<EntryPoint> {
        vec![EntryPoint { address: to_addr(CRYSTAL), router: None }]
    }

    /// One keeper, two routes: `execute` straight to the vault, and the same
    /// push relayed by FastLane to the keeper's own account (word 5 names the
    /// keeper; the vault sits off the word grid, inside searcherCallData).
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(Some(GasSources {
            destinations: vec![to_addr(VAULT), to_addr(KEEPER)],
            relays: vec![GasRelay {
                address: to_addr(FASTLANE_AUCTION_HANDLER),
                selector: FASTLANE_SELECTOR,
                target_word: FASTLANE_TARGET_WORD,
            }],
            ..GasSources::default()
        }))
    }

    fn history_revisions(&self) -> Vec<HistoryRevision> {
        // The replay finished on the adapter's deploy day before the core
        // re-read a new venue's deploy day: that day's earlier hours were
        // never decoded.
        vec![HistoryRevision { id: "deploy-day", from: Some("2026-10-27"), markets: &[] }]
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        // The market's first trade (an outside maker's): the replay covers the
        // whole book even though only the vault's legs count.
        Some("2026-09-20")
    }
}
