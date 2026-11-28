//! Clober, ported from server/src/venues/clober.ts: the oracle vault
//! (LiquidityVault + SimpleOracleStrategy) running one-directional Clober V2
//! books. The vault IS the venue (its books carry ~100% of Clober's volume),
//! so only Takes on the vault's books count; the id keeps its historical
//! value `clober-vault`.
//!
//!   BookManager.Take        → the trade (quote leg exact: unit × unitSize)
//!   BookManager.Open        → a book's immutable key
//!   LiquidityVault.Open     → the vault pairing two books (open() is
//!                             permissionless and adopts already-open books)
//!   RouterGateway.Swap      → routed-flow attribution for the same tx
//!
//! Whether a Take is vault flow: it is exactly when the book's FIRST
//! LiquidityVault.Open comes before the Take (bookPair goes from 0 to the
//! mirror once and is never cleared). Today's adapter asks the chain inside
//! decode (bookPair at head − 5, then at the Take's block − 1). Decode here
//! reads nothing: it answers from what it has seen (the adoption table, every
//! Open in the blocks it decoded or discovery scanned, and the chain answers
//! discovery read). A Take it cannot settle holds the block (fail-closed,
//! `NotReady`) and asks discovery, which reads the chain as today's decode
//! does; the block is decoded once the answer is in. Discovery also reads
//! ahead for every book Taken in its scan window, so a held block is the
//! exception: a book first Taken after boot whose key or pairing nothing
//! seen settles.
//!
//! Quotes: BookViewer.getExpectedOutput on each vault book, limit at the
//! book's lowest price, every leg one eth_call in one batch pinned to the
//! block. A leg's sweep measured at most ~610k gas (the MON/USDC stable book
//! at $1k–$100k while the vault was live, 2026-09-27; ~460k on 2026-11-27),
//! far under the 8M each call carries. What is quoted is every vault book
//! discovery knows: the adoption table's books get their keys read at
//! discovery, so quoting never waits on a Take or the subgraph.
//!
//! Not ported: the subgraph discovery (today it only decided what is quoted
//! at boot; Goldsky 404s and Ormi 429s, so today quotes no Clober book until
//! decode meets one).

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::Arc,
};

use alloy_primitives::{address, Address, U256};
use alloy_sol_types::{sol, SolEvent};
use async_trait::async_trait;
use mpamm_chain::{parse_b32, parse_quantity, quantity, Rpc};
use mpamm_core::{
    ChainCx, DecodeCx, EntryPoint, FinalBlock, FinalLog, GasSources, HistoryRevision, Pricer, QuoteCx, RevisionSource,
    Venue, VenueError,
};
use mpamm_registry::{parse_address, Pair, Registry};
use mpamm_ring::{hex, Addr, TopicFilter, WatchSet, B32};
use mpamm_types::{Fill, FillCategory, QuoteRow, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::{Mutex, RwLock};
use serde_json::json;

use crate::{
    chain::{call_many, At},
    logs,
    quote_health::{self, OutageLatch},
    util::{addr_hex, b32_hex, from_units, short_hex, to_addr, to_units},
};

pub const ID: &str = "clober-vault";

// Clober V2 on Monad (shared/src/index.ts ADDR).
pub const BOOK_MANAGER: Address = address!("6657d192273731C3cAc646cc82D5F28D0CBE8CCC");
pub const BOOK_VIEWER: Address = address!("e424c211e2Ed8a5B6d1C57FA493C41715568D238");
pub const CONTROLLER: Address = address!("19b68a2b909D96c05B623050C276FBD457De8e83");
pub const ROUTER_GATEWAY: Address = address!("7B58A24C5628881a141D630f101Db433D419B372");
pub const LIQUIDITY_VAULT: Address = address!("B09684f5486d1af80699BbC27f14dd5A905da873");
pub const SIMPLE_ORACLE_STRATEGY: Address = address!("54cd5332b1689b6506Ce089DA5651B1A814e9E7D");
/// BookManager deploy block: the start of on-chain history.
pub const CLOBER_DEPLOY_BLOCK: u64 = 31_662_843;

/// Reads stay this many blocks behind the head: Monad logs and state at the
/// tip can still mutate away, and a vault verdict is cached for good.
pub const FINALITY_MARGIN: u64 = 5;
/// Discovery's first scan covers this many getLogs windows back from the
/// head (100k blocks on a node allowing 1000-block ranges): every book Taken
/// there is classified before decode meets it.
const SCAN_WINDOWS: u64 = 100;
/// A later scan resumes where the last one ended unless the gap is wider than
/// this, in which case it starts a fresh window.
const MAX_SCAN_GAP: u64 = 200_000;
/// Clober's lowest book price: every quote leg's limit, so a leg walks the
/// whole book (today's CLOBER_MIN_PRICE).
pub const MIN_PRICE: u64 = 1_350_587;
/// Per-side sanity band (bps from the pair mid): a side priced beyond it is a
/// far-tick backstop or a mispriced resting order, not executable liquidity.
pub const PER_SIDE_BAND_BPS: f64 = 2000.0;

sol! {
    struct BookKey { address base; uint64 unitSize; address quote; uint24 makerPolicy; address hooks; uint24 takerPolicy; }

    interface BookManager {
        event Take(uint192 indexed bookId, address indexed user, int24 tick, uint64 unit);
        event Open(uint192 indexed id, address indexed base, address indexed quote, uint64 unitSize, uint24 makerPolicy, uint24 takerPolicy, address hooks);
        function getBookKey(uint192 id) view returns (BookKey memory);
    }

    interface LiquidityVault {
        event Open(bytes32 indexed key, uint192 indexed bookIdA, uint192 indexed bookIdB, bytes32 salt, address strategy);
        function bookPair(uint192 bookId) view returns (uint192);
    }

    interface RouterGateway {
        event Swap(address indexed user, address indexed inToken, address indexed outToken, uint256 amountIn, uint256 amountOut, address router, bytes4 method);
    }

    interface SimpleOracleStrategy {
        event UpdatePosition(bytes32 indexed key, uint256 oraclePrice, int24 tickA, int24 tickB, uint256 rate);
    }

    struct TakeInputParams { uint192 id; uint256 limitPrice; uint256 baseAmount; uint256 minQuoteAmount; bytes hookData; }

    interface BookViewer {
        function getExpectedOutput(TakeInputParams params) view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount);
    }
}

pub type BookId = U256;

/// A log's place in the chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
    pub block: u64,
    pub log_index: u32,
}

/// The FIRST LiquidityVault.Open of each book the vault has paired, as
/// today's CLOBER_VAULT_ADOPTIONS: a Vault.Open scan of blocks 37,272,487
/// (the proxy's creation) to 38,486,629 found these two and no other. Both
/// adopted already-open books (no BookManager.Open in either tx), so a Take
/// on one of them before its Open was never the vault's.
pub const CLOBER_VAULT_ADOPTIONS: [(&str, Pos, [&str; 2]); 2] = [
    // tx 0x9d7465903e76cada5878f61df0706f8d9f32d58a3c792905f5d68d165da95835, 2025-11-22 15:02 UTC
    (
        "WETH/USDC",
        Pos { block: 37_278_311, log_index: 2 },
        [
            "680091963353999958661303284433884846705699901928885914311",
            "6215929461771924482215683498685754109371513948112281158916",
        ],
    ),
    // tx 0xb8cb6e2356321e67e49939c2cf71206e4c27b5e1b6a34dfd96bf4091658f9e3a, 2025-11-25 10:52 UTC
    (
        "MON/USDC",
        Pos { block: 37_886_929, log_index: 8 },
        [
            "5954885684956363054050231031211743946744177791604395877538",
            "3875727077379471850923186002296331935053867847116966170720",
        ],
    ),
];

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "Clober".into(),
        color: ThemeColor { light: "#0284C7".into(), dark: "#0284C7".into() },
        kind: VenueKind::Vault,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2025-10-28".into()),
        quote_note: None,
    }
}

fn lower_hex(a: &Addr) -> String {
    addr_hex(a)
}

/// A base/stable book (today's CloberBook).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Book {
    pub book_id: BookId,
    /// Token addresses (native MON is the zero address).
    pub base: Addr,
    pub quote: Addr,
    pub unit_size: u64,
    pub base_sym: Option<String>,
    pub quote_sym: Option<String>,
    pub is_vault: bool,
}

/// A book's key as the chain states it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawKey {
    pub base: Addr,
    pub quote: Addr,
    pub unit_size: u64,
}

/// A base/stable market of books (today's CloberMarket).
#[derive(Debug, Clone, PartialEq)]
pub struct CloberMarket {
    pub market: String,
    pub stable: String,
    pub base_asset: String,
    /// Wrapper token key used for sizing (`WMON`, `WBTC`, `CBBTC`…).
    pub base_token: String,
    pub base_dec: u8,
    /// Base = the base asset (quote = stable): quotes SELL base.
    pub base_book: Option<Book>,
    /// Base = the stable (quote = the base asset): quotes BUY base.
    pub stable_book: Option<Book>,
}

fn sym_by_addr(registry: &Registry, a: &Addr) -> Option<String> {
    registry.token_by_address(a).map(|(_, t)| t.symbol.clone())
}

fn is_stable_sym(registry: &Registry, sym: &str) -> bool {
    // Indexed by symbol, as today (`TOKENS[stableSym]?.stable`).
    registry.tokens.get(sym).is_some_and(|t| t.stable)
}

/// The registered pair a book's base-asset token trades against `stable_sym`
/// (today's cloberPairForToken): an alternative wrapper (cbBTC) maps to its
/// own pair, the canonical wrapper or native MON to the canonical one.
pub fn pair_for_token<'r>(registry: &'r Registry, token: &Addr, stable_sym: &str) -> Option<(&'r Pair, String)> {
    let addr = lower_hex(token);
    let asset = registry.asset_for_token(&addr)?;
    let alt = registry.tokens.iter().find(|(_, t)| t.base_asset.is_some() && t.address.eq_ignore_ascii_case(&addr));
    let pair = match alt {
        Some((_, t)) => {
            let symbol = format!("{}/{stable_sym}", t.symbol);
            registry.pairs.iter().find(|p| p.symbol == symbol && p.base == asset.key && p.quote == stable_sym)
        }
        None => registry.pair_for(&asset.key, stable_sym),
    }?;
    Some((pair, alt.map_or_else(|| asset.token.clone(), |(k, _)| k.clone())))
}

/// A base/stable book from its key, or `None` outside that scope (today's
/// cloberBookFromOpen).
pub fn book_from_key(registry: &Registry, id: BookId, key: &RawKey, is_vault: bool) -> Option<Book> {
    let base_side = registry.asset_for_token(&lower_hex(&key.base)).is_some();
    let quote_side = registry.asset_for_token(&lower_hex(&key.quote)).is_some();
    if base_side == quote_side {
        return None;
    }
    let base_sym = sym_by_addr(registry, &key.base);
    let quote_sym = sym_by_addr(registry, &key.quote);
    let stable_sym = if base_side { quote_sym.as_deref() } else { base_sym.as_deref() };
    if !stable_sym.is_some_and(|s| is_stable_sym(registry, s)) {
        return None;
    }
    Some(Book {
        book_id: id,
        base: key.base,
        quote: key.quote,
        unit_size: key.unit_size,
        base_sym,
        quote_sym,
        is_vault,
    })
}

/// What decoding needs of a book's registered pair (today's registeredBookPair).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookPair {
    pub market: String,
    pub base_is_book_base: bool,
    pub base_dec: u8,
    pub stable_sym: String,
    pub stable_dec: u8,
}

/// The REGISTERED pair a book trades, or `None`: exactly one side a tracked
/// base asset, the other a real stable, and the combination registered.
pub fn registered_book_pair(registry: &Registry, book: &Book) -> Option<BookPair> {
    let base_side = registry.asset_for_token(&lower_hex(&book.base)).is_some();
    let quote_side = registry.asset_for_token(&lower_hex(&book.quote)).is_some();
    if base_side == quote_side {
        return None;
    }
    let stable_sym = if base_side { book.quote_sym.clone() } else { book.base_sym.clone() }?;
    if !is_stable_sym(registry, &stable_sym) {
        return None;
    }
    let (pair, token_key) = pair_for_token(registry, if base_side { &book.base } else { &book.quote }, &stable_sym)?;
    let base_tok = registry.tokens.get(&token_key)?;
    Some(BookPair {
        market: pair.symbol.clone(),
        base_is_book_base: base_side,
        base_dec: base_tok.decimals,
        stable_dec: registry.tokens[&stable_sym].decimals,
        stable_sym,
    })
}

/// Markets for exactly the registered pairs, preferring a vault book per
/// direction (today's assembleCloberMarkets). Books iterate in id order.
pub fn assemble_markets<'b>(registry: &Registry, books: impl Iterator<Item = &'b Book> + Clone) -> Vec<CloberMarket> {
    let mut out = Vec::new();
    for pair in &registry.pairs {
        let Some(asset) = registry.assets.get(&pair.base) else { continue };
        let Some(t) = registry.tokens.get(&pair.quote).filter(|t| t.stable) else { continue };
        let st = t.address_bytes();
        let (mut base_book, mut stable_book, mut token_key): (Option<&Book>, Option<&Book>, Option<String>) =
            (None, None, None);
        for b in books.clone() {
            if b.quote == st {
                if let Some((p, k)) = pair_for_token(registry, &b.base, &t.symbol) {
                    if p.symbol == pair.symbol && (base_book.is_none_or(|x| b.is_vault && !x.is_vault)) {
                        base_book = Some(b);
                        token_key = Some(k);
                    }
                }
            }
            if b.base == st {
                if let Some((p, k)) = pair_for_token(registry, &b.quote, &t.symbol) {
                    if p.symbol == pair.symbol && (stable_book.is_none_or(|x| b.is_vault && !x.is_vault)) {
                        stable_book = Some(b);
                        token_key.get_or_insert(k);
                    }
                }
            }
        }
        let Some(token_key) = token_key else { continue };
        let Some(base_tok) = registry.tokens.get(&token_key) else { continue };
        if base_book.is_some() || stable_book.is_some() {
            out.push(CloberMarket {
                market: pair.symbol.clone(),
                stable: t.symbol.clone(),
                base_asset: asset.key.clone(),
                base_token: token_key,
                base_dec: base_tok.decimals,
                base_book: base_book.cloned(),
                stable_book: stable_book.cloned(),
            });
        }
    }
    out
}

/// `x^y` as JavaScript's `Math.pow`, which V8 hands to the platform's `pow`.
/// The base is hidden from the optimiser so `pow(10, x)` is never rewritten
/// to `exp10(x)`, which can differ in the last bit.
fn js_pow(x: f64, y: f64) -> f64 {
    std::hint::black_box(x).powf(y)
}

/// Clober V2 tick → realized price, stable per base (today's
/// cloberTickToPrice): 1.0001^(±tick) × 10^(baseDec − stableDec), + when the
/// base asset is the book's base.
pub fn tick_to_price(tick: i32, base_is_book_base: bool, stable_dec: u8, base_dec: u8) -> f64 {
    let t = f64::from(tick);
    js_pow(1.0001, if base_is_book_base { t } else { -t })
        * js_pow(10.0, f64::from(i32::from(base_dec) - i32::from(stable_dec)))
}

/// Did getExpectedOutput consume the whole requested input, allowing two
/// quote units of rounding (today's cloberLegFilledFull; the quoter uses it).
pub fn leg_filled_full(req_in: U256, spent_in: U256, taken_out: U256, unit_size: U256) -> bool {
    if spent_in >= req_in {
        return true;
    }
    if taken_out.is_zero() {
        return false;
    }
    let two = U256::from(2u8);
    let unit_dust = (two * unit_size * spent_in + taken_out - U256::from(1u8)) / taken_out;
    let rel_dust = (req_in + U256::from(999_999_999u64)) / U256::from(1_000_000_000u64);
    req_in - spent_in <= unit_dust.max(rel_dust)
}

/// Routed-flow attribution for a Take whose tx also emitted a
/// RouterGateway.Swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterInfo {
    pub to: String,
    pub router: Option<String>,
}

/// One Take as decoding sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Take {
    pub book_id: BookId,
    pub user: Address,
    pub tick: i32,
    pub unit: u64,
    pub tx_hash: B32,
    pub pos: Pos,
}

/// A Take on a vault book as a trade, or `None` when out of scope (today's
/// decodeCloberTake). The quote leg is exact; price and base leg come from
/// the resting tick.
pub fn decode_take(
    registry: &Registry,
    take: &Take,
    book: &Book,
    ts: f64,
    router: Option<&RouterInfo>,
) -> Option<Fill> {
    let reg = registered_book_pair(registry, book)?;
    let quote_dec = if reg.base_is_book_base { reg.stable_dec } else { reg.base_dec };
    let quote_human = from_units(U256::from(take.unit) * U256::from(book.unit_size), quote_dec);
    if quote_human <= 0.0 {
        return None;
    }
    let exec_px = tick_to_price(take.tick, reg.base_is_book_base, reg.stable_dec, reg.base_dec);
    if !exec_px.is_finite() || exec_px <= 0.0 {
        return None;
    }
    // USD is the stable leg: exact when the book's quote IS the stable.
    let usd = if reg.base_is_book_base { quote_human } else { quote_human * exec_px };
    let base_amount = usd / exec_px;
    if usd <= 0.0 {
        return None;
    }
    let id = take.book_id.to_string();
    Some(Fill {
        id: format!("clb-0x{}-{}", hex(&take.tx_hash), take.pos.log_index),
        venue_id: ID.into(),
        market: reg.market,
        // A Take consumes resting orders: side follows the book's orientation.
        side: if reg.base_is_book_base { Side::Sell } else { Side::Buy },
        // Routed → the gateway's evidence; else UNKNOWN (the core upgrades it).
        category: if router.is_some() { FillCategory::Router } else { FillCategory::Unknown },
        usd,
        base_amount,
        exec_px,
        px_approx: false,
        tx_hash: b32_hex(&take.tx_hash),
        // viem hands decoded addresses checksummed; today's label keeps that case.
        to: router.map_or_else(|| short_hex(&take.user.to_string()), |r| r.to.clone()),
        router: router.and_then(|r| r.router.clone()),
        pool: format!("book {}", &id[..id.len().min(8)]),
        block_number: take.pos.block,
        ts,
        markouts_bps: vec![None; 5],
        time_source: None,
    })
}

/// tx hash → routed-flow attribution from RouterGateway.Swap logs; the last
/// Swap of a tx wins (today's buildRouterMap).
pub fn router_info(router: Address) -> RouterInfo {
    // Today's attribution KNOWN_ROUTERS (mpamm-registry's copy of them).
    let brand = mpamm_registry::attribution::attribution().routers.get(&router.0 .0).cloned();
    RouterInfo { to: short_hex(&router.to_string()), router: brand }
}

/// What a book's key says about its Takes.
#[derive(Debug, Clone, PartialEq, Eq)]
enum KeyInfo {
    /// A base/stable book (it trades a registered pair or not).
    InScope(Arc<Book>),
    /// Never a trade, whoever owns the book.
    OutOfScope,
}

/// What is known about one book. Every field is a fact about the chain, so
/// recording one is never undone (a retried block sees the same facts).
#[derive(Debug, Clone, Default)]
struct BookState {
    /// The book's first LiquidityVault.Open.
    adopted: Option<Pos>,
    /// bookPair was 0 at the end of this block.
    unpaired_through: Option<u64>,
    /// bookPair was set at the end of this block.
    paired_by: Option<u64>,
    /// Its BookManager.Open: nothing pairs a book before it is opened.
    opened: Option<Pos>,
    /// The first LiquidityVault.Open seen naming it.
    first_open: Option<Pos>,
    key: Option<KeyInfo>,
}

impl BookState {
    fn is_vault(&self) -> bool {
        self.adopted.is_some() || self.paired_by.is_some() || self.first_open.is_some()
    }
}

/// The blocks whose LiquidityVault.Opens have all been seen: discovery's
/// scans, and the run of consecutive blocks decode has seen.
#[derive(Debug, Clone, Copy, Default)]
struct Coverage {
    scan: Option<(u64, u64)>,
    decoded: Option<(u64, u64)>,
}

impl Coverage {
    /// The last block of the covered run that contains `from`.
    fn through_from(&self, from: u64) -> Option<u64> {
        let mut ivs: Vec<(u64, u64)> = [self.scan, self.decoded].into_iter().flatten().collect();
        ivs.sort();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for (a, b) in ivs {
            match merged.last_mut() {
                Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
                _ => merged.push((a, b)),
            }
        }
        merged.iter().find(|(a, b)| *a <= from && from <= *b).map(|(_, b)| *b)
    }

    fn decoded(&mut self, n: u64) {
        self.decoded = match self.decoded {
            Some((a, b)) if n == b + 1 => Some((a, n)),
            Some((a, b)) if a <= n && n <= b => Some((a, b)),
            _ => Some((n, n)),
        };
    }

    fn scanned(&mut self, from: u64, to: u64) {
        self.scan = match self.scan {
            Some((a, b)) if a <= from && from <= b + 1 => Some((a, b.max(to))),
            _ => Some((from, to)),
        };
    }
}

#[derive(Debug, Default)]
struct Inner {
    books: BTreeMap<BookId, BookState>,
    coverage: Coverage,
    /// Books decode could not settle: read bookPair + key at or after the
    /// newest Take block asking.
    pending_books: BTreeMap<BookId, u64>,
    /// (book, block): read bookPair at that block.
    pending_paired: BTreeSet<(BookId, u64)>,
    paired_at: HashMap<(BookId, u64), bool>,
    /// Why a book is still unsettled (a failed or contradictory read).
    errors: HashMap<BookId, String>,
    discovered: bool,
}

/// The vault's base/stable books: what is quoted and decoded.
fn vault_books(inner: &Inner) -> impl Iterator<Item = &Book> + Clone {
    inner.books.values().filter(|s| s.is_vault()).filter_map(|s| match &s.key {
        Some(KeyInfo::InScope(b)) => Some(b.as_ref()),
        _ => None,
    })
}

impl Inner {
    fn seeded() -> Self {
        let mut inner = Inner::default();
        for (_, pos, ids) in CLOBER_VAULT_ADOPTIONS {
            for id in ids {
                let s = inner.books.entry(id.parse().expect("book id")).or_default();
                s.adopted = Some(pos);
                s.first_open = Some(pos);
            }
        }
        inner
    }

    fn set_key(&mut self, registry: &Registry, id: BookId, key: &RawKey) {
        let s = self.books.entry(id).or_default();
        if s.key.is_none() {
            s.key = Some(match book_from_key(registry, id, key, true) {
                Some(b) => KeyInfo::InScope(Arc::new(b)),
                None => KeyInfo::OutOfScope,
            });
        }
    }

    fn observe_vault_open(&mut self, id: BookId, pos: Pos) {
        let s = self.books.entry(id).or_default();
        if s.first_open.is_none_or(|o| pos < o) {
            s.first_open = Some(pos);
        }
    }

    fn observe_book_open(&mut self, registry: &Registry, id: BookId, pos: Pos, key: &RawKey) {
        let s = self.books.entry(id).or_default();
        if s.opened.is_none_or(|o| pos < o) {
            s.opened = Some(pos);
        }
        self.set_key(registry, id, key);
    }

    /// Is a Take at `pos` on `id` vault flow? `None`: the chain must say.
    /// `Err`: what was seen contradicts what the chain said.
    fn flow(&mut self, id: BookId, pos: Pos) -> Result<Option<bool>, String> {
        let cov = self.coverage;
        let s = self.books.entry(id).or_default();
        if let Some(a) = s.adopted {
            return Ok(Some(pos > a));
        }
        if s.unpaired_through.is_some_and(|u| u >= pos.block) {
            return Ok(Some(false));
        }
        // From `from` on every Open of the book has been seen, and none
        // before it can exist: the first one seen is its adoption.
        let from = match (s.unpaired_through, s.opened) {
            (Some(u), Some(o)) => Some((u + 1).max(o.block)),
            (Some(u), None) => Some(u + 1),
            (None, Some(o)) => Some(o.block),
            (None, None) => None,
        };
        if let Some(upto) = from.and_then(|f| cov.through_from(f)) {
            let from = from.unwrap_or_default();
            match s.first_open {
                Some(o) if o.block < from => {
                    return Err(match s.unpaired_through {
                        Some(u) if o.block <= u => {
                            format!(
                                "book {id} has a Vault.Open at block {} but no LiquidityVault.bookPair at block {u}",
                                o.block
                            )
                        }
                        _ => format!("book {id} has a Vault.Open at block {} before its BookManager.Open", o.block),
                    });
                }
                Some(o) if o.block <= upto => {
                    s.adopted = Some(o);
                    return Ok(Some(pos > o));
                }
                _ => {
                    s.unpaired_through = Some(s.unpaired_through.map_or(upto, |u| u.max(upto)));
                    if upto >= pos.block {
                        return Ok(Some(false));
                    }
                }
            }
        }
        if s.paired_by.is_some_and(|p| pos.block > p) {
            return Ok(Some(true));
        }
        Ok(None)
    }

    /// Today's answer to "was the book paired at the end of `n − 1`", for
    /// Takes in block `n` the rest could not settle.
    fn apply_paired_at(&mut self, id: BookId, n: u64, paired: bool) -> Result<(), String> {
        let cov = self.coverage;
        let s = self.books.entry(id).or_default();
        let open = s.first_open;
        if !paired {
            if let Some(o) = open.filter(|o| o.block < n) {
                return Err(format!(
                    "book {id} has a Vault.Open at block {} but no LiquidityVault.bookPair at block {}",
                    o.block,
                    n - 1
                ));
            }
        }
        if paired {
            s.paired_by = Some(s.paired_by.map_or(n - 1, |p| p.min(n - 1)));
        } else if let Some(o) = open.filter(|o| o.block == n || cov.through_from(n).is_some_and(|t| t >= o.block)) {
            s.adopted = Some(o);
            s.paired_by = None;
        } else {
            s.unpaired_through = Some(s.unpaired_through.map_or(n, |u| u.max(n)));
        }
        Ok(())
    }

    /// A read of bookPair and the key at block `at`.
    fn apply_verdict(
        &mut self,
        registry: &Registry,
        id: BookId,
        at: u64,
        pair: U256,
        key: &RawKey,
    ) -> Result<(), String> {
        let s = self.books.entry(id).or_default();
        if pair.is_zero() {
            let seen_paired = s.adopted.is_some_and(|a| a.block <= at)
                || s.first_open.is_some_and(|o| o.block <= at)
                || s.paired_by.is_some_and(|p| p <= at);
            if seen_paired {
                return Err(format!("vault book {id} has no LiquidityVault.bookPair at block {at}"));
            }
            s.unpaired_through = Some(s.unpaired_through.map_or(at, |u| u.max(at)));
        } else {
            // The vault opens both books before it pairs them: a zero key is a bad read.
            if key.unit_size == 0 {
                return Err(format!("vault book {id} has no BookManager key"));
            }
            if s.adopted.is_none() {
                s.paired_by = Some(s.paired_by.map_or(at, |p| p.min(at)));
            }
        }
        // A key never changes once the book is open (all zero before).
        if key.unit_size != 0 {
            self.set_key(registry, id, key);
        }
        Ok(())
    }
}

/// What decoding a block found it needs from the chain.
#[derive(Debug, Default)]
struct Needs {
    books: BTreeMap<BookId, u64>,
    paired: BTreeSet<(BookId, u64)>,
}

/// The chain reads Clober's discovery makes (an RPC node in the service; a
/// stub in tests).
#[async_trait]
pub trait CloberChain: Send + Sync {
    async fn head(&self) -> Result<u64, VenueError>;
    /// LiquidityVault.bookPair and BookManager.getBookKey of each book at
    /// `at`, all or nothing.
    async fn books(&self, ids: &[BookId], at: u64) -> Result<Vec<(U256, RawKey)>, VenueError>;
    /// Whether LiquidityVault.bookPair of each book was set at `at`.
    async fn paired(&self, ids: &[BookId], at: u64) -> Result<Vec<bool>, VenueError>;
    /// BookManager Take/Open and LiquidityVault.Open logs over [from, to],
    /// with their block numbers, in chain order.
    async fn logs(&self, from: u64, to: u64) -> Result<Vec<(u64, FinalLog)>, VenueError>;
    /// Blocks per getLogs request.
    fn window(&self) -> u64 {
        1000
    }
}

/// [`CloberChain`] over a JSON-RPC node.
pub struct RpcChain<'a> {
    pub rpc: &'a Rpc,
    window: std::sync::atomic::AtomicU64,
}

impl<'a> RpcChain<'a> {
    pub fn new(rpc: &'a Rpc) -> Self {
        Self { rpc, window: std::sync::atomic::AtomicU64::new(1000) }
    }
}

fn parse_log(l: &serde_json::Value) -> Option<(u64, FinalLog)> {
    Some((
        parse_quantity(&l["blockNumber"])?,
        FinalLog {
            log_index: parse_quantity(&l["logIndex"])? as u32,
            txn_index: parse_quantity(&l["transactionIndex"])? as u32,
            tx_hash: parse_b32(&l["transactionHash"])?,
            address: parse_address(l["address"].as_str()?)?,
            topics: l["topics"].as_array()?.iter().map(parse_b32).collect::<Option<Vec<_>>>()?,
            data: mpamm_core::block::hex_bytes(l["data"].as_str()?)?,
        },
    ))
}

#[async_trait]
impl CloberChain for RpcChain<'_> {
    async fn head(&self) -> Result<u64, VenueError> {
        self.rpc.block_number().await.map_err(|e| VenueError::Chain(format!("Clober head: {e}")))
    }

    async fn books(&self, ids: &[BookId], at: u64) -> Result<Vec<(U256, RawKey)>, VenueError> {
        let pairs: Vec<(Address, LiquidityVault::bookPairCall)> = ids
            .iter()
            .map(|id| (LIQUIDITY_VAULT, LiquidityVault::bookPairCall { bookId: alloy_primitives::Uint::from(*id) }))
            .collect();
        let keys: Vec<(Address, BookManager::getBookKeyCall)> = ids
            .iter()
            .map(|id| (BOOK_MANAGER, BookManager::getBookKeyCall { id: alloy_primitives::Uint::from(*id) }))
            .collect();
        let pairs = call_many(self.rpc, &pairs, At::Number(at)).await?;
        let keys = call_many(self.rpc, &keys, At::Number(at)).await?;
        // allowFailure: false, as today: one failed leg fails the read.
        pairs
            .into_iter()
            .zip(keys)
            .map(|(p, k)| {
                let k = k?;
                Ok((U256::from(p?), RawKey { base: to_addr(k.base), quote: to_addr(k.quote), unit_size: k.unitSize }))
            })
            .collect()
    }

    async fn paired(&self, ids: &[BookId], at: u64) -> Result<Vec<bool>, VenueError> {
        let calls: Vec<(Address, LiquidityVault::bookPairCall)> = ids
            .iter()
            .map(|id| (LIQUIDITY_VAULT, LiquidityVault::bookPairCall { bookId: alloy_primitives::Uint::from(*id) }))
            .collect();
        call_many(self.rpc, &calls, At::Number(at)).await?.into_iter().map(|r| r.map(|p| !p.is_zero())).collect()
    }

    async fn logs(&self, from: u64, to: u64) -> Result<Vec<(u64, FinalLog)>, VenueError> {
        let topics: Vec<String> = [
            BookManager::Take::SIGNATURE_HASH,
            BookManager::Open::SIGNATURE_HASH,
            LiquidityVault::Open::SIGNATURE_HASH,
        ]
        .iter()
        .map(|t| t.to_string())
        .collect();
        let addresses = [BOOK_MANAGER.to_string(), LIQUIDITY_VAULT.to_string()];
        let mut out = Vec::new();
        let mut start = from;
        while start <= to {
            let window = self.window.load(std::sync::atomic::Ordering::Relaxed);
            // A batch of windows per round trip.
            let mut calls = Vec::new();
            let mut s = start;
            while s <= to && calls.len() < 25 {
                let e = (s + window - 1).min(to);
                calls.push((
                    "eth_getLogs",
                    json!([{ "fromBlock": quantity(s), "toBlock": quantity(e), "address": addresses, "topics": [topics] }]),
                ));
                s = e + 1;
            }
            let answers =
                self.rpc.batch(&calls).await.map_err(|e| VenueError::Chain(format!("Clober getLogs: {e}")))?;
            let mut narrowed = false;
            for a in answers {
                match a {
                    Ok(v) => {
                        for l in v.as_array().ok_or_else(|| VenueError::Chain("Clober getLogs answer".into()))? {
                            out.push(parse_log(l).ok_or_else(|| VenueError::Chain("Clober: malformed log".into()))?);
                        }
                    }
                    // The public RPC caps a range at 100 blocks.
                    Err(e) if window > 100 && e.to_string().contains("range") => {
                        self.window.store(100, std::sync::atomic::Ordering::Relaxed);
                        narrowed = true;
                        break;
                    }
                    Err(e) => return Err(VenueError::Chain(format!("Clober getLogs: {e}"))),
                }
            }
            if narrowed {
                out.retain(|(b, _)| *b < start);
                continue;
            }
            start = s;
        }
        out.sort_by_key(|(b, l)| (*b, l.log_index));
        Ok(out)
    }

    fn window(&self) -> u64 {
        self.window.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// The Clober vault venue.
pub struct Clober {
    inner: RwLock<Inner>,
    /// Why the vault quotes nothing although its books answer (today's
    /// createQuoteOutageLatch): said once per reason, the heal announced.
    outage: Mutex<OutageLatch>,
}

impl Default for Clober {
    fn default() -> Self {
        Self { inner: RwLock::new(Inner::seeded()), outage: Mutex::new(OutageLatch::default()) }
    }
}

/// What one quote frame says about the vault (today's `outage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// No leg could be priced: cold references say nothing about the books.
    Unknown,
    /// Rows came back.
    Quoting,
    /// Legs were asked and no row survived.
    Dark { reason: String, msg: String },
}

/// The smallest size's leg closest to executable, in a frame that produced
/// no row (today's CloberBestLeg).
#[derive(Debug, Clone, PartialEq)]
pub struct BestLeg {
    pub market: String,
    pub sell: bool,
    pub bps: f64,
    pub filled_usd: f64,
    pub full: bool,
}

/// A full fill beats a partial one; full fills rank by distance from mid,
/// partials by how much they filled (a dust leg can sit right at mid).
fn leg_beats(a: &BestLeg, b: &BestLeg) -> bool {
    if a.full != b.full {
        return a.full;
    }
    if a.full {
        a.bps.abs() < b.bps.abs()
    } else {
        a.filled_usd > b.filled_usd
    }
}

/// Why a frame whose legs did not ALL fail produced no row, as `(reason,
/// message)` (today's cloberOutage; every leg failing is `check_outage`'s
/// error instead). Some calls failing gets its own reason: those books were
/// never read, so it is not a depth outage. Otherwise every book answered
/// and no side is executable. Markets with a cold reference had no legs:
/// named, not counted. `reason` stays fixed while the vault stays in that
/// state, so a drifting price in the message never re-raises it.
pub fn outage<T>(
    res: &[Result<T, VenueError>],
    min_usd: f64,
    best: Option<&BestLeg>,
    unpriced: &[String],
) -> (String, String) {
    let name = meta().name;
    let cold = if unpriced.is_empty() {
        String::new()
    } else {
        format!("; not priced, reference cold: {}", unpriced.join(", "))
    };
    let band = format!("fills ${min_usd} within ±{PER_SIDE_BAND_BPS} bps of mid");
    let bps = |b: f64| format!("{}{} bps", if b >= 0.0 { '+' } else { '−' }, b.abs().round());
    let detail = match best {
        None => format!("every answered ${min_usd} leg returned nothing"),
        Some(b) => format!(
            "nearest: {} {} at {}{}",
            b.market,
            if b.sell { "sell" } else { "buy" },
            bps(b.bps),
            if b.full { String::new() } else { format!(", ~${:.2} of ${min_usd} filled", b.filled_usd) }
        ),
    } + &cold;
    let failed: Vec<Result<(), VenueError>> =
        res.iter().filter_map(|r| r.as_ref().err()).map(|e| Err(e.clone())).collect();
    if let Some(why) = quote_health::outage_reason(&failed) {
        return (
            format!("some book calls failed with \"{why}\""),
            format!(
                "{name} quotes unavailable — {} of {} book calls failed with \"{why}\", and no answered side {band} ({detail}): read the failed books before blaming the vault",
                failed.len(),
                res.len()
            ),
        );
    }
    let reason = format!("no vault book side {band}");
    let msg = format!(
        "{name} quotes unavailable — {reason} ({detail}): the vault's books are empty or priced away from mid, not an adapter fault"
    );
    (reason, msg)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn pos_of(block: u64, l: &FinalLog) -> Pos {
    Pos { block, log_index: l.log_index }
}

fn take_of(block: u64, l: &FinalLog) -> Option<Take> {
    let t = logs::decode::<BookManager::Take>(l)?;
    Some(Take {
        book_id: U256::from(t.bookId),
        user: t.user,
        tick: t.tick.as_i32(),
        unit: t.unit,
        tx_hash: l.tx_hash,
        pos: pos_of(block, l),
    })
}

impl Clober {
    /// Books whose keys are already known, as discovery would have learned
    /// them (tests and tools). Each is the vault's from `adopted` on.
    pub fn with_books(registry: &Registry, books: &[(BookId, RawKey, Pos)]) -> Self {
        let c = Self::default();
        {
            let mut inner = c.inner.write();
            for (id, key, pos) in books {
                inner.observe_vault_open(*id, *pos);
                let s = inner.books.entry(*id).or_default();
                s.adopted = Some(s.adopted.map_or(*pos, |a| a.min(*pos)));
                inner.set_key(registry, *id, key);
            }
            inner.discovered = true;
        }
        c
    }

    /// The vault's base/stable markets (what M9 quotes).
    pub fn clober_markets(&self, registry: &Registry) -> Vec<CloberMarket> {
        let inner = self.inner.read();
        assemble_markets(registry, vault_books(&inner))
    }

    /// Books decode is waiting on the chain for.
    pub fn pending(&self) -> (Vec<BookId>, Vec<(BookId, u64)>) {
        let inner = self.inner.read();
        (inner.pending_books.keys().copied().collect(), inner.pending_paired.iter().copied().collect())
    }

    /// Records what Opens in a block say: the vault's pairings first, then
    /// book keys (today's mergeVaultBooks order).
    fn observe(inner: &mut Inner, registry: &Registry, block: u64, logs: &[&FinalLog]) {
        for l in logs {
            if Address::from(l.address) != LIQUIDITY_VAULT {
                continue;
            }
            if let Some(o) = logs::decode::<LiquidityVault::Open>(l) {
                inner.observe_vault_open(U256::from(o.bookIdA), pos_of(block, l));
                inner.observe_vault_open(U256::from(o.bookIdB), pos_of(block, l));
            }
        }
        for l in logs {
            if Address::from(l.address) != BOOK_MANAGER {
                continue;
            }
            if let Some(o) = logs::decode::<BookManager::Open>(l) {
                let key = RawKey { base: to_addr(o.base), quote: to_addr(o.quote), unit_size: o.unitSize };
                inner.observe_book_open(registry, U256::from(o.id), pos_of(block, l), &key);
            }
        }
    }

    /// Settles each Take, or says what the chain must answer first.
    fn classify(inner: &mut Inner, takes: &[Take]) -> Result<Needs, VenueError> {
        let mut needs = Needs::default();
        for t in takes {
            let key = inner.books.get(&t.book_id).and_then(|s| s.key.clone());
            // Never a trade, whoever's book it is.
            if key == Some(KeyInfo::OutOfScope) {
                continue;
            }
            let mut flow = inner.flow(t.book_id, t.pos).map_err(VenueError::Decode)?;
            if flow.is_none() && key.is_some() {
                let n = t.pos.block;
                match inner.paired_at.get(&(t.book_id, n - 1)).copied() {
                    Some(paired) => {
                        inner.apply_paired_at(t.book_id, n, paired).map_err(VenueError::Decode)?;
                        flow = inner.flow(t.book_id, t.pos).map_err(VenueError::Decode)?;
                    }
                    None => {
                        needs.paired.insert((t.book_id, n - 1));
                        continue;
                    }
                }
            }
            match (flow, key) {
                (Some(false), _) => {}
                (Some(true), Some(_)) => {}
                // Unknown key, or a pairing nothing seen settles.
                _ => {
                    let e = needs.books.entry(t.book_id).or_insert(0);
                    *e = (*e).max(t.pos.block);
                }
            }
        }
        Ok(needs)
    }

    /// Discovery against any chain (the RPC node in the service).
    pub async fn discover_with(&self, chain: &dyn CloberChain, registry: &Registry) -> Result<(), VenueError> {
        let head = chain.head().await?;
        let at = head.saturating_sub(FINALITY_MARGIN);

        // 1. Scan the Opens and Takes since the last scan (or a fresh window),
        //    never the tip. A failed scan only defers what it would add.
        let from = {
            let inner = self.inner.read();
            match inner.coverage.scan {
                Some((_, s1)) if s1 >= at => None,
                Some((_, s1)) if at - s1 <= MAX_SCAN_GAP => Some(s1 + 1),
                _ => Some(at.saturating_sub(SCAN_WINDOWS * chain.window()) + 1),
            }
        };
        let mut scanned_takes = Vec::new();
        if let Some(from) = from {
            match chain.logs(from, at).await {
                Ok(found) => {
                    let mut inner = self.inner.write();
                    let mut by_block: BTreeMap<u64, Vec<&FinalLog>> = BTreeMap::new();
                    for (b, l) in &found {
                        by_block.entry(*b).or_default().push(l);
                    }
                    for (b, ls) in &by_block {
                        Self::observe(&mut inner, registry, *b, ls);
                    }
                    inner.coverage.scanned(from, at);
                    for (b, l) in &found {
                        if Address::from(l.address) == BOOK_MANAGER {
                            scanned_takes.extend(take_of(*b, l));
                        }
                    }
                }
                Err(e) => tracing::warn!(target: "venues", "Clober: Open/Take scan {from}..={at} failed: {e}"),
            }
        }

        // 2. Which books to ask about: those the scan's Takes can't settle,
        //    vault books without a key, and whatever decode is waiting on.
        let (asks, paired_asks) = {
            let mut inner = self.inner.write();
            let mut asks: BTreeMap<BookId, u64> = BTreeMap::new();
            if let Ok(needs) = Self::classify(&mut inner, &scanned_takes) {
                for (id, b) in needs.books {
                    let e = asks.entry(id).or_insert(0);
                    *e = (*e).max(b);
                }
            }
            let keyless: Vec<BookId> =
                inner.books.iter().filter(|(_, s)| s.is_vault() && s.key.is_none()).map(|(id, _)| *id).collect();
            for id in keyless {
                asks.entry(id).or_insert(0);
            }
            for (id, b) in &inner.pending_books {
                let e = asks.entry(*id).or_insert(0);
                *e = (*e).max(*b);
            }
            (asks, inner.pending_paired.clone())
        };

        // 3. bookPair + key, pinned FINALITY_MARGIN behind the head, or at
        //    the newest final block asking when that is later.
        let mut groups: BTreeMap<u64, Vec<BookId>> = BTreeMap::new();
        for (id, newest) in asks {
            if newest.max(at) <= head {
                groups.entry(newest.max(at)).or_default().push(id);
            }
        }
        for (block, ids) in groups {
            match chain.books(&ids, block).await {
                Ok(answers) => {
                    let mut inner = self.inner.write();
                    for (id, (pair, key)) in ids.iter().zip(answers) {
                        match inner.apply_verdict(registry, *id, block, pair, &key) {
                            Ok(()) => {
                                inner.errors.remove(id);
                                if inner.pending_books.get(id).is_some_and(|n| *n <= block) {
                                    inner.pending_books.remove(id);
                                }
                            }
                            Err(e) => {
                                tracing::warn!(target: "venues", "Clober: {e}");
                                inner.errors.insert(*id, e);
                            }
                        }
                    }
                }
                Err(e) => {
                    let mut inner = self.inner.write();
                    for id in ids {
                        inner.errors.insert(id, e.to_string());
                    }
                }
            }
        }

        // 4. bookPair at the blocks decode asked about.
        let mut by_block: BTreeMap<u64, Vec<BookId>> = BTreeMap::new();
        for (id, b) in paired_asks {
            by_block.entry(b).or_default().push(id);
        }
        for (block, ids) in by_block {
            match chain.paired(&ids, block).await {
                Ok(answers) => {
                    let mut inner = self.inner.write();
                    for (id, paired) in ids.iter().zip(answers) {
                        inner.paired_at.insert((*id, block), paired);
                        inner.pending_paired.remove(&(*id, block));
                        inner.errors.remove(id);
                    }
                }
                Err(e) => {
                    let mut inner = self.inner.write();
                    for id in ids {
                        inner.errors.insert(id, e.to_string());
                    }
                }
            }
        }

        let mut inner = self.inner.write();
        inner.discovered = true;
        tracing::info!(
            target: "venues",
            "Clober: {} vault book(s), {} market(s); {} book(s) awaiting the chain",
            inner.books.values().filter(|s| s.is_vault()).count(),
            assemble_markets(registry, vault_books(&inner)).len(),
            inner.pending_books.len() + inner.pending_paired.len()
        );
        Ok(())
    }

    /// Quotes every vault market and puts the frame's verdict on the record:
    /// a dark vault is said once per reason and its heal announced.
    pub async fn quote_with(
        &self,
        rpc: &Rpc,
        registry: &Registry,
        pricer: &dyn Pricer,
        at: At,
        sizes_usd: &[f64],
    ) -> Result<Vec<QuoteRow>, VenueError> {
        let (rows, verdict) = self.quote_frame(rpc, registry, pricer, at, sizes_usd).await?;
        let mut latch = self.outage.lock();
        match &verdict {
            Verdict::Unknown => {}
            Verdict::Quoting => latch.report(&meta().name, None),
            Verdict::Dark { reason, msg } => latch.report(&meta().name, Some((reason, msg))),
        }
        Ok(rows)
    }

    /// The reason the vault is dark, while one is on the record.
    pub fn outage_on_record(&self) -> Option<String> {
        self.outage.lock().current().map(str::to_string)
    }

    /// BookViewer.getExpectedOutput per vault book × size, every leg in one
    /// batch pinned to the block (today's quoteClober). A sell spends the
    /// base worth `size` on the base book; a buy spends `size` of the stable
    /// on the stable book. The limit is the book's lowest price, so a thin
    /// book sweeps to far ticks: a side counts only if it fills the whole
    /// size (within two quote units of rounding) inside ±PER_SIDE_BAND_BPS
    /// of the pair mid. Both sides → a two-sided row, one → a one-sided row,
    /// neither → no row. Every leg failing is the venue's error.
    pub async fn quote_frame(
        &self,
        rpc: &Rpc,
        registry: &Registry,
        pricer: &dyn Pricer,
        at: At,
        sizes_usd: &[f64],
    ) -> Result<(Vec<QuoteRow>, Verdict), VenueError> {
        let markets = self.clober_markets(registry);
        if markets.is_empty() {
            return Ok((Vec::new(), Verdict::Unknown));
        }
        struct Leg {
            market: usize,
            size: f64,
            sell: bool,
            unit_size: u64,
            in_dec: u8,
            out_dec: u8,
            req: U256,
            mid: f64,
        }
        let mut legs = Vec::new();
        let mut calls = Vec::new();
        // Cold references: no legs, so nothing learned about these books.
        let mut unpriced = Vec::new();
        for (i, m) in markets.iter().enumerate() {
            // The bps anchor is the pair-terms reference mid: book quotes are
            // in the pair's stable terms, never a raw USDT price.
            let mid = pricer.pair_mid(&m.market);
            if mid <= 0.0 {
                unpriced.push(m.market.clone());
                continue;
            }
            let Some(stable_dec) = registry.tokens.get(&m.stable).map(|t| t.decimals) else { continue };
            for &size in sizes_usd {
                let sides = [
                    // Sell base: spend base, take the stable.
                    m.base_book.as_ref().map(|b| {
                        let req = to_units(pricer.token_for_usd(&m.base_token, size), m.base_dec);
                        (b, true, m.base_dec, stable_dec, req)
                    }),
                    // Buy base: spend the stable, take the base asset.
                    m.stable_book.as_ref().map(|b| (b, false, stable_dec, m.base_dec, to_units(size, stable_dec))),
                ];
                for (book, sell, in_dec, out_dec, req) in sides.into_iter().flatten() {
                    calls.push((
                        BOOK_VIEWER,
                        BookViewer::getExpectedOutputCall {
                            params: TakeInputParams {
                                id: alloy_primitives::Uint::from(book.book_id),
                                limitPrice: U256::from(MIN_PRICE),
                                baseAmount: req,
                                minQuoteAmount: U256::ZERO,
                                hookData: Default::default(),
                            },
                        },
                    ));
                    legs.push(Leg { market: i, size, sell, unit_size: book.unit_size, in_dec, out_dec, req, mid });
                }
            }
        }
        if legs.is_empty() {
            // Only cold references: the books said nothing this frame.
            return Ok((Vec::new(), Verdict::Unknown));
        }
        let res = call_many(rpc, &calls, at).await?;
        quote_health::check_outage(&meta().name, &res)?;

        let ts = now_ms();
        let min_usd = sizes_usd.iter().copied().fold(f64::INFINITY, f64::min);
        let mut best: Option<BestLeg> = None;
        // One row per (market, size) in the order its first answered leg came,
        // with whether each side filled in full.
        let mut rows: Vec<(QuoteRow, bool, bool)> = Vec::new();
        for (l, r) in legs.iter().zip(&res) {
            let Ok(q) = r else { continue };
            let (taken, spent) = (q.takenQuoteAmount, q.spentBaseAmount);
            if taken.is_zero() || spent.is_zero() {
                continue;
            }
            let taken_h = from_units(taken, l.out_dec);
            let spent_h = from_units(spent, l.in_dec);
            // Stable per base over the FILLED portion only.
            let px = if l.sell { taken_h / spent_h } else { spent_h / taken_h };
            let bps = (px / l.mid - 1.0) * 1e4;
            let full = leg_filled_full(l.req, spent, taken, U256::from(l.unit_size));
            let m = &markets[l.market];
            if l.size == min_usd {
                let leg = BestLeg {
                    market: m.market.clone(),
                    sell: l.sell,
                    bps,
                    filled_usd: if l.sell { spent_h * l.mid } else { spent_h },
                    full,
                };
                if best.as_ref().is_none_or(|b| leg_beats(&leg, b)) {
                    best = Some(leg);
                }
            }
            let idx = match rows.iter().position(|(x, _, _)| x.market == m.market && x.size_usd == l.size) {
                Some(i) => i,
                None => {
                    rows.push((
                        QuoteRow {
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
                            fee_bps: 0.0,
                            cex_ask_bps: None,
                            cex_bid_bps: None,
                            ts,
                        },
                        false,
                        false,
                    ));
                    rows.len() - 1
                }
            };
            let (row, bid_full, ask_full) = &mut rows[idx];
            if l.sell {
                (row.bid_bps, row.bid_px, *bid_full) = (bps, px, full);
            } else {
                (row.ask_bps, row.ask_px, *ask_full) = (bps, px, full);
            }
        }

        let real = |px: f64, full: bool, bps: f64| px > 0.0 && full && bps.abs() <= PER_SIDE_BAND_BPS;
        let mut out = Vec::new();
        for (mut row, bid_full, ask_full) in rows {
            row.spread_bps = row.ask_bps - row.bid_bps;
            let bid = real(row.bid_px, bid_full, row.bid_bps);
            let ask = real(row.ask_px, ask_full, row.ask_bps);
            if bid && ask {
                row.one_sided = Some(false);
                row.filled_full = bid_full && ask_full;
            } else if bid != ask {
                // The thin side is zeroed and the row flagged.
                row.one_sided = Some(true);
                row.filled_full = if bid { bid_full } else { ask_full };
                if !bid {
                    (row.bid_px, row.bid_bps) = (0.0, 0.0);
                }
                if !ask {
                    (row.ask_px, row.ask_bps) = (0.0, 0.0);
                }
                row.spread_bps = 0.0;
            } else {
                continue;
            }
            out.push(row);
        }
        let verdict = if out.is_empty() {
            let (reason, msg) = outage(&res, min_usd, best.as_ref(), &unpriced);
            Verdict::Dark { reason, msg }
        } else {
            Verdict::Quoting
        };
        Ok((out, verdict))
    }
}

#[async_trait]
impl Venue for Clober {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        self.discover_with(&RpcChain::new(cx.rpc), cx.registry).await
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        // Today's sources never throw: the contracts are fixed.
        let mut w = WatchSet::default();
        w.logs.insert(
            to_addr(BOOK_MANAGER),
            TopicFilter::Topics(HashSet::from([
                logs::topic0::<BookManager::Take>(),
                logs::topic0::<BookManager::Open>(),
            ])),
        );
        w.logs.insert(
            to_addr(LIQUIDITY_VAULT),
            TopicFilter::Topics(HashSet::from([logs::topic0::<LiquidityVault::Open>()])),
        );
        w.logs.insert(
            to_addr(ROUTER_GATEWAY),
            TopicFilter::Topics(HashSet::from([logs::topic0::<RouterGateway::Swap>()])),
        );
        // Gas: the keeper's quote updates, recognised by the event they emit.
        w.logs.insert(
            to_addr(SIMPLE_ORACLE_STRATEGY),
            TopicFilter::Topics(HashSet::from([logs::topic0::<SimpleOracleStrategy::UpdatePosition>()])),
        );
        Ok(w)
    }

    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let n = block.number;
        let mine: Vec<&FinalLog> = block
            .logs
            .iter()
            .filter(|l| {
                let a = Address::from(l.address);
                a == BOOK_MANAGER || a == LIQUIDITY_VAULT || a == ROUTER_GATEWAY
            })
            .collect();
        let mut inner = self.inner.write();
        Self::observe(&mut inner, cx.registry, n, &mine);
        // This block's Opens are now seen too.
        inner.coverage.decoded(n);
        let takes: Vec<Take> =
            mine.iter().filter(|l| Address::from(l.address) == BOOK_MANAGER).filter_map(|l| take_of(n, l)).collect();
        if takes.is_empty() {
            return Ok(Vec::new());
        }

        let needs = Self::classify(&mut inner, &takes)?;
        if !needs.books.is_empty() || !needs.paired.is_empty() {
            let mut why = None;
            for (id, b) in &needs.books {
                let e = inner.pending_books.entry(*id).or_insert(0);
                *e = (*e).max(*b);
                why = why.or_else(|| inner.errors.get(id).cloned());
            }
            for (id, b) in &needs.paired {
                inner.pending_paired.insert((*id, *b));
                why = why.or_else(|| inner.errors.get(id).cloned());
            }
            let ids: Vec<String> =
                needs.books.keys().chain(needs.paired.iter().map(|(id, _)| id)).map(|id| id.to_string()).collect();
            return Err(match why {
                Some(e) => VenueError::NotReady(format!("unclassified Clober book(s) {}: {e}", ids.join(", "))),
                None => VenueError::NotReady(format!(
                    "unclassified Clober book(s) {}: waiting for discovery to read the chain",
                    ids.join(", ")
                )),
            });
        }

        let mut routes: HashMap<B32, RouterInfo> = HashMap::new();
        for l in &mine {
            if Address::from(l.address) == ROUTER_GATEWAY {
                if let Some(s) = logs::decode::<RouterGateway::Swap>(l) {
                    routes.insert(l.tx_hash, router_info(s.router));
                }
            }
        }
        let mut out = Vec::new();
        for t in &takes {
            let Some(KeyInfo::InScope(book)) = inner.books.get(&t.book_id).and_then(|s| s.key.clone()) else {
                continue;
            };
            if inner.flow(t.book_id, t.pos).ok().flatten() != Some(true) {
                continue;
            }
            out.extend(decode_take(cx.registry, t, &book, block.time_ms(), routes.get(&t.tx_hash)));
        }
        Ok(out)
    }

    async fn quote(&self, cx: &QuoteCx<'_>, sizes_usd: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
        self.quote_with(cx.rpc, cx.registry, cx.pricer, At::Hash(cx.block.hash), sizes_usd).await
    }

    fn markets(&self) -> Vec<String> {
        let inner = self.inner.read();
        let mut seen = HashSet::new();
        assemble_markets(mpamm_registry::Registry::get(), vault_books(&inner))
            .into_iter()
            .map(|m| m.market)
            .filter(|m| seen.insert(m.clone()))
            .collect()
    }

    fn entry_points(&self) -> Vec<EntryPoint> {
        // A tx entering at the controller or the book manager is a direct trade.
        vec![
            EntryPoint { address: to_addr(CONTROLLER), router: None },
            EntryPoint { address: to_addr(BOOK_MANAGER), router: None },
        ]
    }

    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        // Every repricing is one keeper tx emitting SimpleOracleStrategy.UpdatePosition.
        Ok(Some(GasSources {
            logs: vec![(to_addr(SIMPLE_ORACLE_STRATEGY), logs::topic0::<SimpleOracleStrategy::UpdatePosition>())],
            ..GasSources::default()
        }))
    }

    fn history_revisions(&self) -> Vec<HistoryRevision> {
        // 2026-09-18..19 re-summed from stored fills: the 09-21 replay
        // stamped a chunk straddling midnight with one block time.
        vec![HistoryRevision {
            id: "replay-0921-midnight",
            from: Some("2026-09-18"),
            source: RevisionSource::Fills { until: "2026-09-20" },
        }]
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        Some("2025-10-28")
    }
}
