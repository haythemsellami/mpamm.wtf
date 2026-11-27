//! Ported from server/src/venues/__tests__/clober.decode.test.ts and
//! clober.classify.test.ts. Fixtures are real Monad logs; expected numbers
//! are today's adapter's own outputs, bit for bit.
//!
//! Classification: today's decode asks the chain itself; here decode holds
//! the block (`NotReady`) and discovery reads the chain. Each classify case
//! keeps today's verdicts (which Takes count) and states which reads it
//! takes. `decode_range` stands in for the service: on a hold it runs
//! discovery and retries the block.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use alloy_primitives::{
    address,
    aliases::{I24, U192},
    Address, LogData, B256, U256,
};
use alloy_sol_types::SolEvent;
use async_trait::async_trait;
use mpamm_core::{DecodeCx, FinalBlock, FinalLog, NoPrices, Origin, Venue, VenueError, VenueState};
use mpamm_registry::Registry;
use mpamm_types::{Fill, FillCategory, Side};
use mpamm_venues::clober::{self, *};

const TS_S: u64 = 1_783_600_000;
const ZERO: [u8; 20] = [0; 20];

fn reg() -> &'static Registry {
    Registry::get()
}

fn id(s: &str) -> U256 {
    s.parse().unwrap()
}

fn b32(s: &str) -> [u8; 32] {
    let h = s.strip_prefix("0x").unwrap();
    let mut out = [0u8; 32];
    for (i, c) in h.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap();
    }
    out
}

fn tok(key: &str) -> [u8; 20] {
    reg().tokens[key].address_bytes()
}

fn log_of(address: Address, data: LogData, tx: [u8; 32], log_index: u32) -> FinalLog {
    FinalLog {
        log_index,
        txn_index: 0,
        tx_hash: tx,
        address: address.into_array(),
        topics: data.topics().iter().map(|t| t.0).collect(),
        data: data.data.to_vec(),
    }
}

/// A log and the block it is in.
#[derive(Clone)]
struct L(u64, FinalLog);

fn take_log(book: U256, user: Address, tick: i32, unit: u64, tx: &str, block: u64, log_index: u32) -> L {
    let e = BookManager::Take { bookId: U192::from(book), user, tick: I24::try_from(tick).unwrap(), unit };
    L(block, log_of(BOOK_MANAGER, e.encode_log_data(), b32(tx), log_index))
}

fn vault_open(a: U256, b: U256, block: u64, log_index: u32) -> L {
    let e = LiquidityVault::Open {
        key: B256::ZERO,
        bookIdA: U192::from(a),
        bookIdB: U192::from(b),
        salt: B256::ZERO,
        strategy: SIMPLE_ORACLE_STRATEGY,
    };
    L(block, log_of(LIQUIDITY_VAULT, e.encode_log_data(), [0xaa; 32], log_index))
}

fn book_open(book: U256, key: RawKey, block: u64, log_index: u32) -> L {
    let e = BookManager::Open {
        id: U192::from(book),
        base: Address::from(key.base),
        quote: Address::from(key.quote),
        unitSize: key.unit_size,
        makerPolicy: 8_888_608u32.try_into().unwrap(),
        takerPolicy: 8_888_708u32.try_into().unwrap(),
        hooks: Address::ZERO,
    };
    L(block, log_of(BOOK_MANAGER, e.encode_log_data(), [0xaa; 32], log_index))
}

fn gateway_swap(router: Address, tx: &str, block: u64, log_index: u32) -> L {
    let e = RouterGateway::Swap {
        user: Address::ZERO,
        inToken: Address::ZERO,
        outToken: Address::ZERO,
        amountIn: U256::from(1u8),
        amountOut: U256::from(1u8),
        router,
        method: [0u8; 4].into(),
    };
    L(block, log_of(ROUTER_GATEWAY, e.encode_log_data(), b32(tx), log_index))
}

fn block_of(number: u64, logs: Vec<FinalLog>) -> FinalBlock {
    let mut logs = logs;
    logs.sort_by_key(|l| l.log_index);
    FinalBlock {
        number,
        hash: [0; 32],
        parent_hash: [0; 32],
        timestamp: TS_S,
        proposal_ns: None,
        base_fee: 0,
        txns: Vec::new(),
        logs,
        origin: Origin::Rpc("test".into()),
    }
}

fn decode_block(v: &Clober, b: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
    let state = VenueState::default();
    v.decode(&DecodeCx { registry: reg(), pricer: &NoPrices, state: &state }, b)
}

/// Logs grouped into blocks, in order.
fn blocks(logs: &[L]) -> Vec<FinalBlock> {
    let mut by: std::collections::BTreeMap<u64, Vec<FinalLog>> = Default::default();
    for L(b, l) in logs {
        by.entry(*b).or_default().push(l.clone());
    }
    by.into_iter().map(|(n, ls)| block_of(n, ls)).collect()
}

// ---------------------------------------------------------------------------
// clober.decode.test.ts

/// MON/USDC vault book (base = native MON, quote = USDC, unitSize 1).
const MON_USDC: &str = "5954885684956363054050231031211743946744177791604395877538";
const MON_USDC_MIRROR: &str = "3875727077379471850923186002296331935053867847116966170720";
const VAULT_TX: &str = "0x42991909a8e6b88ef087bf0f108ec882b191b8f1d77241cc92a3d2381547e2e7";
const VAULT_USER: Address = address!("553037Bac82741e7CA05AfB48e8538996fD70ECa");

fn mon_usdc_key() -> RawKey {
    RawKey { base: ZERO, quote: tok("USDC"), unit_size: 1 }
}

fn mon_usdc_book() -> Book {
    Book {
        book_id: id(MON_USDC),
        base: ZERO,
        quote: tok("USDC"),
        unit_size: 1,
        base_sym: Some("MON".into()),
        quote_sym: Some("USDC".into()),
        is_vault: true,
    }
}

/// The real Take (tx 0x42991909…, block 86,746,586).
fn vault_take() -> Take {
    Take {
        book_id: id(MON_USDC),
        user: VAULT_USER,
        tick: -313_882,
        unit: 296_730_680,
        tx_hash: b32(VAULT_TX),
        pos: Pos { block: 86_746_586, log_index: 6 },
    }
}

fn vault_take_log(block: u64, log_index: u32) -> L {
    take_log(id(MON_USDC), VAULT_USER, -313_882, 296_730_680, VAULT_TX, block, log_index)
}

const TS_MS: f64 = 1_783_600_000_000.0;

#[test]
fn decodes_the_real_mon_usdc_vault_take() {
    let f = decode_take(reg(), &vault_take(), &mon_usdc_book(), TS_MS, None).unwrap();
    // quote leg is exact: usd = unit × unitSize / 10^6
    assert_eq!(f.usd.to_bits(), 0x40728bb0dd82fd76);
    assert!((f.usd - 296.73068).abs() < 1e-9);
    // realized price from the resting tick (1.0001^tick × 10^(baseDec−stableDec))
    assert_eq!(f.exec_px.to_bits(), 0x3f97f28cae3076e0);
    assert!((f.exec_px - 0.023386190540000906).abs() < 1e-15);
    // base amount = usd / execPx
    assert_eq!(f.base_amount.to_bits(), 0x40c8c824a4062ebc);
    assert!((f.base_amount - 12688.28625561983).abs() < 1e-6);
    // a Take on a base-side book consumes resting bids ⇒ taker sells
    assert_eq!(f.side, Side::Sell);
    assert_eq!(f.market, "MON/USDC");
    // deterministic id (txHash:logIndex) so re-tails dedupe
    assert_eq!(f.id, format!("clb-{VAULT_TX}-6"));
    assert_eq!(f.venue_id, "clober-vault");
    assert_eq!(f.block_number, 86_746_586);
    assert_eq!(f.ts, TS_MS);
    assert_eq!(f.markouts_bps, vec![None; 5]);
    assert_eq!(f.category, FillCategory::Unknown);
    assert_eq!(f.to, "0x5530…0ECa");
    assert_eq!(f.pool, "book 59548856");
    assert!(!f.px_approx);
    assert_eq!(f.router, None);
}

#[test]
fn a_mirror_book_take_is_a_buy_priced_from_the_tick() {
    // base = USDC, quote = native MON: usd = quote × price (today's output)
    let book = Book {
        book_id: id(MON_USDC_MIRROR),
        base: tok("USDC"),
        quote: ZERO,
        unit_size: 1_000_000_000_000,
        base_sym: Some("USDC".into()),
        quote_sym: Some("MON".into()),
        is_vault: true,
    };
    let take = Take { book_id: id(MON_USDC_MIRROR), tick: 313_900, unit: 4_242_424, ..vault_take() };
    let f = decode_take(reg(), &take, &book, 0.0, None).unwrap();
    assert_eq!(f.side, Side::Buy);
    assert_eq!(f.usd.to_bits(), 0x3fb95a67ab06433e);
    assert_eq!(f.exec_px.to_bits(), 0x3f97e78667b62ad2);
    assert_eq!(f.base_amount.to_bits(), 0x4010f83dff3f0fe0);
    assert_eq!(f.pool, "book 38757270");
}

#[test]
fn a_book_outside_the_registered_pairs_decodes_to_nothing() {
    // MON/AUSD-shaped book with an unregistered quote: no pair, no fill
    let mut book = mon_usdc_book();
    book.quote = [0x42; 20];
    book.quote_sym = None;
    assert!(decode_take(reg(), &vault_take(), &book, 0.0, None).is_none());
    assert!(book_from_key(reg(), id(MON_USDC), &RawKey { base: ZERO, quote: [0x42; 20], unit_size: 1 }, true).is_none());
    // both sides base assets: not base/stable
    assert!(
        book_from_key(reg(), id(MON_USDC), &RawKey { base: ZERO, quote: tok("WBTC"), unit_size: 1 }, true).is_none()
    );
}

#[test]
fn tick_to_price_matches_today() {
    // base-side book: price = 1.0001^tick scaled by decimals
    assert_eq!(tick_to_price(-313_882, true, 6, 18).to_bits(), 0x3f97f28cae3076e0);
    // the quote-side (mirror) book inverts the tick
    assert_eq!(tick_to_price(313_882, false, 6, 18).to_bits(), 0x3f97f28cae3076e0);
    // generic over base decimals (WBTC = 8, not 18)
    assert_eq!(tick_to_price(-313_882, true, 6, 8).to_bits(), 0x3d84921a19667b96);
    assert!((tick_to_price(-313_882, true, 6, 8) - 0.023386190540000906e-10).abs() < 1e-20);
}

#[test]
fn leg_filled_full_allows_unit_size_rounding() {
    let u = |s: &str| U256::from_str_radix(s, 10).unwrap();
    // a $100 sell that leaves sub-unit dust is a full fill
    assert!(leg_filled_full(u("3867723844517501220253"), u("3867723825756573480247"), u("99883739"), u("1")));
    // an exact fill is full
    assert!(leg_filled_full(u("100000000"), u("100000000"), u("3862171404234000000000"), u("1000000000000")));
    // a real partial on a thin book is not
    assert!(!leg_filled_full(u("1000000000"), u("698370382"), u("24415081308693900000000"), u("1000000000000")));
    assert!(!leg_filled_full(u("386772384451750083826482"), u("337510314431399524539628"), u("496331042"), u("1")));
    // accepts every leg the old 1e-9 relative check accepted
    for req in ["1", "999", "100000000", "1000000001", "3867723844517501220253"] {
        let req = u(req);
        let floor = req * U256::from(999_999_999u64) / U256::from(1_000_000_000u64);
        assert!(leg_filled_full(req, floor, U256::from(1u8), U256::ZERO));
    }
    // nothing taken is never full
    assert!(!leg_filled_full(u("100"), u("99"), U256::ZERO, U256::from(1u8)));
}

fn book(n: u64, base: [u8; 20], quote: [u8; 20]) -> Book {
    let key = RawKey { base, quote, unit_size: 1 };
    book_from_key(reg(), U256::from(n), &key, true).unwrap()
}

#[test]
fn wbtc_books_assemble_into_btc_usdc_only_never_cbbtc_usdc() {
    let usdc = tok("USDC");
    let wbtc_sell = book(1, tok("WBTC"), usdc);
    let wbtc_buy = book(2, usdc, tok("WBTC"));
    let markets = assemble_markets(reg(), [&wbtc_sell, &wbtc_buy].into_iter());
    assert_eq!(markets.iter().map(|m| m.market.as_str()).collect::<Vec<_>>(), ["BTC/USDC"]);
    assert_eq!(markets[0].base_token, "WBTC");
    assert_eq!(markets[0].base_dec, 8);
}

#[test]
fn a_cbbtc_book_assembles_into_cbbtc_usdc_sized_as_cbbtc() {
    let cbbtc_sell = book(3, tok("CBBTC"), tok("USDC"));
    let markets = assemble_markets(reg(), [&cbbtc_sell].into_iter());
    assert_eq!(markets.iter().map(|m| m.market.as_str()).collect::<Vec<_>>(), ["cbBTC/USDC"]);
    assert_eq!(markets[0].base_token, "CBBTC");
    assert_eq!(markets[0].base_book.as_ref(), Some(&cbbtc_sell));
}

#[test]
fn a_take_on_a_cbbtc_book_decodes_to_cbbtc_usdc_a_wbtc_book_to_btc_usdc() {
    let usdc = tok("USDC");
    let take = |n: u64| Take { book_id: U256::from(n), tick: 0, unit: 1_000_000, ..vault_take() };
    let cb = decode_take(reg(), &take(3), &book(3, tok("CBBTC"), usdc), 0.0, None).unwrap();
    let w = decode_take(reg(), &take(1), &book(1, tok("WBTC"), usdc), 0.0, None).unwrap();
    assert_eq!(cb.market, "cbBTC/USDC");
    assert_eq!(w.market, "BTC/USDC");
}

#[test]
fn mon_books_with_a_native_side_resolve_to_the_canonical_pair() {
    let mon_buy = book(4, tok("USDC"), ZERO);
    let markets = assemble_markets(reg(), [&mon_usdc_book(), &mon_buy].into_iter());
    assert_eq!(markets.iter().map(|m| m.market.as_str()).collect::<Vec<_>>(), ["MON/USDC"]);
    assert_eq!(markets[0].base_token, "WMON");
    assert_eq!(markets[0].stable_book.as_ref(), Some(&mon_buy));
}

#[test]
fn routed_takes_carry_the_gateways_evidence() {
    let relay = address!("b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f");
    let v = Clober::with_books(reg(), &[(id(MON_USDC), mon_usdc_key(), Pos { block: 37_886_929, log_index: 8 })]);
    let logs = vec![
        vault_take_log(86_746_586, 6),
        gateway_swap(relay, VAULT_TX, 86_746_586, 9),
        // another tx in the block, through an unbranded router
        take_log(id(MON_USDC), VAULT_USER, -313_882, 1, &format!("0x{}", "11".repeat(32)), 86_746_586, 12),
        gateway_swap(
            address!("1234567890AbcdEF1234567890aBcdef12345678"),
            &format!("0x{}", "11".repeat(32)),
            86_746_586,
            13,
        ),
    ];
    let fills = decode_block(&v, &blocks(&logs)[0]).unwrap();
    assert_eq!(fills.len(), 2);
    assert_eq!(fills[0].category, FillCategory::Router);
    assert_eq!(fills[0].router.as_deref(), Some("Relay"));
    assert_eq!(fills[0].to, "0xb92f…Ff4f");
    assert_eq!(fills[1].category, FillCategory::Router);
    assert_eq!(fills[1].router, None);
    assert_eq!(fills[1].to, "0x1234…5678");
}

#[test]
fn venue_metadata_watch_gas_and_history_match_today() {
    let v = Clober::default();
    assert_eq!(v.id(), "clober-vault");
    assert_eq!(v.meta(), vec![clober::meta()]);
    let w = v.watch().unwrap();
    let take = BookManager::Take::SIGNATURE_HASH.0;
    let open = BookManager::Open::SIGNATURE_HASH.0;
    let vopen = LiquidityVault::Open::SIGNATURE_HASH.0;
    let swap = RouterGateway::Swap::SIGNATURE_HASH.0;
    let update = b32("0x6bfe82e0fc1c0e49aa5a610028c276fddb4bc3c4f8ae34f09277ce63597818f9");
    assert!(w.wants_log(&BOOK_MANAGER.into_array(), Some(&take)));
    assert!(w.wants_log(&BOOK_MANAGER.into_array(), Some(&open)));
    assert!(w.wants_log(&LIQUIDITY_VAULT.into_array(), Some(&vopen)));
    assert!(w.wants_log(&ROUTER_GATEWAY.into_array(), Some(&swap)));
    assert!(w.wants_log(&SIMPLE_ORACLE_STRATEGY.into_array(), Some(&update)));
    let gas = v.gas_sources().unwrap().unwrap();
    assert_eq!(gas.logs, vec![(SIMPLE_ORACLE_STRATEGY.into_array(), update)]);
    assert!(gas.destinations.is_empty() && gas.relays.is_empty());
    assert_eq!(
        v.entry_points().iter().map(|e| (e.address, e.router.clone())).collect::<Vec<_>>(),
        [(CONTROLLER.into_array(), None), (BOOK_MANAGER.into_array(), None)]
    );
    let revs = v.history_revisions();
    assert_eq!(revs.len(), 1);
    assert_eq!((revs[0].id, revs[0].from), ("replay-0921-midnight", Some("2026-09-18")));
    assert_eq!(revs[0].source, mpamm_core::RevisionSource::Fills { until: "2026-09-20" }, "a re-sum, never a replay");
    assert_eq!(v.history_from_utc(), Some("2025-10-28"));
    assert!(v.markets().is_empty(), "no keys read yet");
}

// ---------------------------------------------------------------------------
// clober.classify.test.ts: which Takes are the vault's, from the chain.

/// CHOG/MON, not a vault book (bookPair 0 at block 118,218,881).
const CHOG_MON: &str = "3600347544513338768057978329649925835452964932637306115424";
const CHOG_TX: &str = "0xe77d4935b186cbdca8aceb1178bc81ce60e3e756abe4376e1aac897092a30e00";
const CHOG_USER: Address = address!("C44bc3187cD5084BAc87aF0710CCB3e52041a70D");

fn chog_key() -> RawKey {
    RawKey { base: b32_20("0x350035555E10d9AfAF1566AaebfCeD5BA6C27777"), quote: ZERO, unit_size: 1_000_000_000_000 }
}

fn b32_20(s: &str) -> [u8; 20] {
    mpamm_registry::parse_address(s).unwrap()
}

/// The two Takes in tx 0xe77d4935… (block 117,814,474) that held prod's
/// tail on 2026-10-31.
fn chog_takes() -> Vec<L> {
    vec![
        take_log(id(CHOG_MON), CHOG_USER, -27_322, 1, CHOG_TX, 117_814_474, 9),
        take_log(id(CHOG_MON), CHOG_USER, -28_913, 1_487_248_567, CHOG_TX, 117_814_474, 11),
    ]
}

/// A MON/USDC-keyed book the vault adopts during a test (not in the table).
const LATE: &str = "4242424242424242424242424242424242424242424242424242424242";
const LATE_MIRROR: &str = "2424242424242424242424242424242424242424242424242424242424";

fn late_take(block: u64, log_index: u32) -> L {
    take_log(id(LATE), VAULT_USER, -313_882, 296_730_680, VAULT_TX, block, log_index)
}

fn late_open(block: u64, log_index: u32) -> L {
    vault_open(id(LATE), id(LATE_MIRROR), block, log_index)
}

const HEAD: u64 = 118_218_881;
/// Reads stay five blocks behind the head.
const READ_AT: u64 = HEAD - 5;

fn no_key() -> RawKey {
    RawKey { base: ZERO, quote: ZERO, unit_size: 0 }
}

/// `pair` is what bookPair returns from block `paired_from` on (0 before
/// it; always, when `None`).
#[derive(Clone)]
struct ChainBook {
    pair: U256,
    key: RawKey,
    paired_from: Option<u64>,
}

#[derive(Default)]
struct Chain {
    head: Mutex<u64>,
    books: Mutex<HashMap<U256, ChainBook>>,
    fail: Option<String>,
    logs: Vec<L>,
    /// A fullnode keeps recent state only.
    state_from: Option<u64>,
    /// (method, block, books) of every read.
    reads: Mutex<Vec<(&'static str, u64, Vec<U256>)>>,
    scans: Mutex<Vec<(u64, u64)>>,
}

impl Chain {
    fn new(head: u64, books: Vec<(&str, ChainBook)>) -> Arc<Self> {
        Arc::new(Chain {
            head: Mutex::new(head),
            books: Mutex::new(books.into_iter().map(|(i, b)| (id(i), b)).collect()),
            ..Chain::default()
        })
    }

    fn answer(&self, book: &U256, at: u64) -> (U256, RawKey) {
        let b = self.books.lock().unwrap().get(book).cloned().unwrap_or(ChainBook {
            pair: U256::ZERO,
            key: no_key(),
            paired_from: None,
        });
        let pair = if b.paired_from.is_none_or(|f| at >= f) { b.pair } else { U256::ZERO };
        (pair, b.key)
    }

    fn check(&self, at: u64) -> Result<(), VenueError> {
        if let Some(e) = &self.fail {
            return Err(VenueError::Chain(e.clone()));
        }
        if self.state_from.is_some_and(|f| at < f) {
            return Err(VenueError::Chain(format!("missing trie node (block {at})")));
        }
        Ok(())
    }

    /// Reads of these books, by method and block.
    fn reads_of(&self, book: &str) -> Vec<(&'static str, u64)> {
        let b = id(book);
        self.reads.lock().unwrap().iter().filter(|(_, _, ids)| ids.contains(&b)).map(|(m, at, _)| (*m, *at)).collect()
    }
}

struct ChainRef(Arc<Chain>);

#[async_trait]
impl CloberChain for ChainRef {
    async fn head(&self) -> Result<u64, VenueError> {
        Ok(*self.0.head.lock().unwrap())
    }

    async fn books(&self, ids: &[U256], at: u64) -> Result<Vec<(U256, RawKey)>, VenueError> {
        self.0.reads.lock().unwrap().push(("books", at, ids.to_vec()));
        self.0.check(at)?;
        Ok(ids.iter().map(|i| self.0.answer(i, at)).collect())
    }

    async fn paired(&self, ids: &[U256], at: u64) -> Result<Vec<bool>, VenueError> {
        self.0.reads.lock().unwrap().push(("paired", at, ids.to_vec()));
        self.0.check(at)?;
        Ok(ids.iter().map(|i| !self.0.answer(i, at).0.is_zero()).collect())
    }

    async fn logs(&self, from: u64, to: u64) -> Result<Vec<(u64, FinalLog)>, VenueError> {
        self.0.scans.lock().unwrap().push((from, to));
        Ok(self.0.logs.iter().filter(|L(b, _)| *b >= from && *b <= to).map(|L(b, l)| (*b, l.clone())).collect())
    }
}

struct Boot {
    venue: Clober,
    chain: Arc<Chain>,
}

impl Boot {
    async fn discover(&self) {
        self.venue.discover_with(&ChainRef(self.chain.clone()), reg()).await.unwrap();
    }

    /// Decodes the blocks in order as the service does: a held block is
    /// retried after a discovery, up to three times.
    async fn decode(&self, logs: &[L]) -> Result<Vec<Fill>, VenueError> {
        let mut out = Vec::new();
        for b in blocks(logs) {
            let mut tries = 0;
            loop {
                match decode_block(&self.venue, &b) {
                    Ok(f) => {
                        out.extend(f);
                        break;
                    }
                    Err(VenueError::NotReady(e)) if tries < 3 => {
                        tries += 1;
                        let _ = e;
                        self.discover().await;
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        Ok(out)
    }
}

async fn boot_with(chain: Arc<Chain>) -> Boot {
    let b = Boot { venue: Clober::default(), chain };
    b.discover().await;
    b
}

fn log_indexes(fills: &[Fill]) -> Vec<u32> {
    fills.iter().map(|f| f.id.rsplit('-').next().unwrap().parse().unwrap()).collect()
}

fn vault(pair: &str, key: RawKey, paired_from: Option<u64>) -> ChainBook {
    ChainBook { pair: id(pair), key, paired_from }
}

#[tokio::test]
async fn a_fresh_boot_quotes_nothing_until_keys_are_read() {
    let b = boot_with(Chain::new(HEAD, vec![])).await;
    assert!(b.venue.markets().is_empty());
    // the vault's four books were asked for their keys, pinned behind the head
    let (pending, _) = b.venue.pending();
    assert!(pending.is_empty());
    assert_eq!(b.chain.reads_of(MON_USDC), [("books", READ_AT)]);
    assert_eq!(b.chain.scans.lock().unwrap().first().map(|s| s.1), Some(READ_AT), "never the tip");
}

#[tokio::test]
async fn drops_the_takes_that_froze_the_tail_on_2026_10_31() {
    let b = boot_with(Chain::new(
        HEAD,
        vec![(CHOG_MON, ChainBook { pair: U256::ZERO, key: chog_key(), paired_from: None })],
    ))
    .await;
    assert!(b.decode(&chog_takes()).await.unwrap().is_empty());
    // one read, pinned behind the head
    assert_eq!(b.chain.reads_of(CHOG_MON), [("books", READ_AT)]);
}

#[tokio::test]
async fn decodes_a_vault_take_from_the_chains_book_key() {
    let b = boot_with(Chain::new(HEAD, vec![(MON_USDC, vault(MON_USDC_MIRROR, mon_usdc_key(), None))])).await;
    let fills = b.decode(&[vault_take_log(86_746_586, 6)]).await.unwrap();
    let expected = decode_take(reg(), &vault_take(), &mon_usdc_book(), TS_S as f64 * 1000.0, None).unwrap();
    assert_eq!(fills, vec![expected]);
    assert_eq!(fills[0].id, format!("clb-{VAULT_TX}-6"));
    // the book is quotable, though no subgraph said so
    assert_eq!(b.venue.markets(), ["MON/USDC"]);
}

#[tokio::test]
async fn reads_a_vault_book_once_its_verdict_never_changes() {
    let b = boot_with(Chain::new(HEAD, vec![(MON_USDC, vault(MON_USDC_MIRROR, mon_usdc_key(), None))])).await;
    b.decode(&[vault_take_log(86_746_586, 6)]).await.unwrap();
    b.decode(&[vault_take_log(HEAD + 50, 1)]).await.unwrap();
    assert_eq!(b.chain.reads_of(MON_USDC).len(), 1);
}

#[tokio::test]
async fn a_not_the_vaults_verdict_covers_takes_up_to_its_block() {
    let chain = Chain::new(HEAD, vec![(CHOG_MON, ChainBook { pair: U256::ZERO, key: no_key(), paired_from: None })]);
    let b = boot_with(chain.clone()).await;
    b.decode(&chog_takes()).await.unwrap();
    let mut at_read = chog_takes()[0].clone();
    at_read.0 = READ_AT;
    assert!(b.decode(&[at_read]).await.unwrap().is_empty());
    assert_eq!(chain.reads_of(CHOG_MON).len(), 1);
    // Past the verdict: today asks the chain again. Here every Vault.Open
    // from the verdict on has been seen (discovery scanned to it, decode
    // follows on), so no Open for the book means it is still not the vault's.
    let mut next = chog_takes()[0].clone();
    next.0 = READ_AT + 1;
    assert!(b.decode(&[next]).await.unwrap().is_empty());
    assert_eq!(chain.reads_of(CHOG_MON).len(), 1);
    // A block that does not follow what was seen is asked about again, at a
    // new head, as today.
    *chain.head.lock().unwrap() = HEAD + 10;
    let mut later = chog_takes()[0].clone();
    later.0 = READ_AT + 10;
    assert!(b.decode(&[later]).await.unwrap().is_empty());
    assert_eq!(chain.reads_of(CHOG_MON), [("books", READ_AT), ("books", READ_AT + 10)]);
}

// LiquidityVault.open() can adopt a book that is already open, and both of
// the vault's pairs were adopted. Adoption makes later Takes vault flow,
// never the ones the chain already said were not.
#[tokio::test]
async fn counts_an_adopted_book_from_the_vault_open_on() {
    let mut chain = Chain::new(HEAD, vec![(LATE, vault(LATE_MIRROR, mon_usdc_key(), Some(HEAD)))]);
    Arc::get_mut(&mut chain).unwrap().logs = vec![late_open(HEAD, 3)];
    let b = boot_with(chain.clone()).await;
    let early = late_take(117_000_000, 0);
    assert!(b.decode(std::slice::from_ref(&early)).await.unwrap().is_empty());
    *chain.head.lock().unwrap() = HEAD + 20;
    let later = late_take(HEAD + 1, 1);
    let fills = b.decode(&[late_open(HEAD, 3), later.clone()]).await.unwrap();
    assert_eq!(
        fills.iter().map(|f| (f.market.as_str(), f.id.clone())).collect::<Vec<_>>(),
        [("MON/USDC", format!("clb-{VAULT_TX}-1"))]
    );
    // a replay after the adoption still leaves the earlier Take out
    assert_eq!(b.decode(&[early, later]).await.unwrap().len(), 1);
}

#[tokio::test]
async fn counts_a_listed_books_takes_from_its_first_vault_open_reading_only_its_key() {
    let b =
        boot_with(Chain::new(HEAD, vec![(MON_USDC, vault(MON_USDC_MIRROR, mon_usdc_key(), Some(37_886_929)))])).await;
    // its Vault.Open is log 8 of block 37,886,929 (CLOBER_VAULT_ADOPTIONS)
    let takes = [
        vault_take_log(37_000_000, 1),
        vault_take_log(37_886_929, 7),
        vault_take_log(37_886_929, 9),
        vault_take_log(37_886_930, 0),
    ];
    assert_eq!(log_indexes(&b.decode(&takes).await.unwrap()), [9, 0]);
    assert_eq!(b.chain.reads_of(MON_USDC), [("books", READ_AT)]);
    let (pair, pos, books) = CLOBER_VAULT_ADOPTIONS[1];
    assert_eq!((pair, pos), ("MON/USDC", Pos { block: 37_886_929, log_index: 8 }));
    assert!(books.contains(&MON_USDC));
}

#[tokio::test]
async fn finds_an_unlisted_books_adoption_in_the_range() {
    const OPEN: u64 = 117_500_000;
    let b = boot_with(Chain::new(HEAD, vec![(LATE, vault(LATE_MIRROR, mon_usdc_key(), Some(OPEN)))])).await;
    let takes = [late_take(OPEN - 10, 1), late_take(OPEN, 2), late_take(OPEN, 7), late_take(OPEN + 10, 4)];
    let mut range = takes.to_vec();
    range.push(late_open(OPEN, 5));
    assert_eq!(log_indexes(&b.decode(&range).await.unwrap()), [7, 4]);
    // the Open is known from here on: a replay without it reads nothing more
    let reads = b.chain.reads.lock().unwrap().len();
    assert_eq!(log_indexes(&b.decode(&takes).await.unwrap()), [7, 4]);
    assert_eq!(b.chain.reads.lock().unwrap().len(), reads);
    // today reads [READ_AT, OPEN − 11]; per block, the Open's own block asks too
    assert_eq!(b.chain.reads_of(LATE), [("books", READ_AT), ("paired", OPEN - 11), ("paired", OPEN - 1)]);
}

#[tokio::test]
async fn counts_an_unlisted_vault_book_paired_before_its_takes_reading_that_once() {
    let chain = Chain::new(HEAD, vec![(LATE, vault(LATE_MIRROR, mon_usdc_key(), Some(100_000_000)))]);
    let b = boot_with(chain.clone()).await;
    assert_eq!(b.decode(&[late_take(117_000_000, 1), late_take(117_000_100, 2)]).await.unwrap().len(), 2);
    *chain.head.lock().unwrap() = HEAD + 50;
    assert_eq!(b.decode(&[late_take(HEAD + 40, 3)]).await.unwrap().len(), 1);
    assert_eq!(chain.reads_of(LATE), [("books", READ_AT), ("paired", 116_999_999)]);
}

#[tokio::test]
async fn drops_an_unlisted_vault_books_takes_from_before_its_adoption() {
    let b = boot_with(Chain::new(HEAD, vec![(LATE, vault(LATE_MIRROR, mon_usdc_key(), Some(118_000_000)))])).await;
    assert!(b.decode(&[late_take(117_000_000, 1), late_take(117_000_100, 2)]).await.unwrap().is_empty());
    assert!(b.decode(&[late_take(117_000_050, 3)]).await.unwrap().is_empty());
    // today reads [READ_AT, 116,999,999] (one range); per block, the second block asks too
    assert_eq!(b.chain.reads_of(LATE), [("books", READ_AT), ("paired", 116_999_999), ("paired", 117_000_099)]);
}

#[tokio::test]
async fn holds_when_a_vault_open_precedes_a_block_the_chain_says_its_book_was_not_paired_at() {
    let b = boot_with(Chain::new(HEAD, vec![(LATE, vault(LATE_MIRROR, mon_usdc_key(), Some(118_000_000)))])).await;
    let err = b.decode(&[late_open(116_999_000, 0), late_take(117_000_000, 1)]).await.unwrap_err();
    assert_eq!(
        err,
        VenueError::Decode(format!(
            "book {LATE} has a Vault.Open at block 116999000 but no LiquidityVault.bookPair at block 116999999"
        ))
    );
}

#[tokio::test]
async fn holds_when_an_unlisted_books_take_is_deeper_than_the_node_keeps_state() {
    let mut chain = Chain::new(HEAD, vec![(LATE, vault(LATE_MIRROR, mon_usdc_key(), Some(100_000_000)))]);
    Arc::get_mut(&mut chain).unwrap().state_from = Some(HEAD - 1_000_000);
    let b = boot_with(chain).await;
    let err = b.decode(&[late_take(90_000_000, 1)]).await.unwrap_err();
    assert!(matches!(&err, VenueError::NotReady(m) if m.contains("missing trie node (block 89999999)")), "{err}");
}

#[tokio::test]
async fn ignores_a_vault_book_outside_base_stable_scope_without_holding_or_rereading_it() {
    let b = boot_with(Chain::new(
        HEAD,
        vec![(CHOG_MON, ChainBook { pair: U256::from(1u8), key: chog_key(), paired_from: None })],
    ))
    .await;
    assert!(b.decode(&chog_takes()).await.unwrap().is_empty());
    let mut later = chog_takes()[0].clone();
    later.0 = HEAD + 100;
    assert!(b.decode(&[later]).await.unwrap().is_empty());
    assert_eq!(b.chain.reads_of(CHOG_MON).len(), 1);
}

#[tokio::test]
async fn holds_when_the_chain_read_fails() {
    let mut chain = Chain::new(HEAD, vec![]);
    Arc::get_mut(&mut chain).unwrap().fail = Some("HTTP request failed".into());
    let b = boot_with(chain).await;
    let err = b.decode(&chog_takes()).await.unwrap_err();
    assert!(matches!(&err, VenueError::NotReady(m) if m.contains("HTTP request failed")), "{err}");
    assert_eq!(b.venue.pending().0, [id(CHOG_MON)]);
}

// A vault verdict is cached for good, so it never comes from a tip block
// that can still mutate away. Today holds until head − 5 reaches the Take;
// decode only meets final blocks, so the read is pinned at the Take's own
// block instead, never at the tip.
#[tokio::test]
async fn a_take_ahead_of_head_minus_five_is_read_at_its_own_final_block() {
    let b = boot_with(Chain::new(
        117_814_478,
        vec![(CHOG_MON, ChainBook { pair: U256::ZERO, key: chog_key(), paired_from: None })],
    ))
    .await;
    assert!(b.decode(&chog_takes()).await.unwrap().is_empty());
    assert_eq!(b.chain.reads_of(CHOG_MON), [("books", 117_814_474)]);
}

#[tokio::test]
async fn holds_when_a_vault_open_names_a_book_the_chain_read_says_is_not_the_vaults() {
    // MON/USDC is in the adoption table: a zero bookPair contradicts it
    let b = boot_with(Chain::new(
        HEAD,
        vec![(MON_USDC, ChainBook { pair: U256::ZERO, key: mon_usdc_key(), paired_from: None })],
    ))
    .await;
    let err = b.decode(&[vault_take_log(86_746_586, 6)]).await.unwrap_err();
    let msg = format!("vault book {MON_USDC} has no LiquidityVault.bookPair at block {READ_AT}");
    assert!(matches!(&err, VenueError::NotReady(m) if m.contains(&msg)), "{err}");
}

#[tokio::test]
async fn a_contradicted_book_holds_only_until_the_chain_answers_consistently() {
    // MON/USDC answers and is in scope; the CHOG/MON answer contradicts its Vault.Open
    let chain = Chain::new(
        HEAD,
        vec![
            (MON_USDC, vault(MON_USDC_MIRROR, mon_usdc_key(), None)),
            (CHOG_MON, ChainBook { pair: U256::ZERO, key: chog_key(), paired_from: None }),
        ],
    );
    let b = boot_with(chain.clone()).await;
    let mut range = vec![vault_take_log(86_746_586, 6), vault_open(id(CHOG_MON), U256::from(7u8), 86_746_586, 1)];
    range.extend(chog_takes());
    let err = b.decode(&range).await.unwrap_err();
    assert!(
        matches!(&err, VenueError::NotReady(m) if m.contains(&format!("vault book {CHOG_MON} has no LiquidityVault.bookPair"))),
        "{err}"
    );
    // the vault's after all, outside base/stable scope
    chain
        .books
        .lock()
        .unwrap()
        .insert(id(CHOG_MON), ChainBook { pair: U256::from(1u8), key: chog_key(), paired_from: None });
    let fills = b.decode(&range).await.unwrap();
    assert_eq!(fills.iter().map(|f| f.market.as_str()).collect::<Vec<_>>(), ["MON/USDC"]);
    assert_eq!(b.venue.markets(), ["MON/USDC"]);
}

#[tokio::test]
async fn holds_when_a_vault_book_has_no_key_on_the_book_manager() {
    let b = boot_with(Chain::new(HEAD, vec![(MON_USDC, vault(MON_USDC_MIRROR, no_key(), None))])).await;
    let err = b.decode(&[vault_take_log(86_746_586, 6)]).await.unwrap_err();
    assert!(
        matches!(&err, VenueError::NotReady(m) if m.contains(&format!("vault book {MON_USDC} has no BookManager key"))),
        "{err}"
    );
}

/// The vault opening a book and its mirror at `block`: BookManager.Open
/// for the first (the vault opens it), then the Vault.Open pairing both.
fn opens_at(block: u64, book: &str, mirror: &str) -> Vec<L> {
    vec![book_open(id(book), mon_usdc_key(), block, 0), vault_open(id(book), id(mirror), block, 1)]
}

#[tokio::test]
async fn learns_a_vault_book_from_a_finalized_open_in_discoverys_scan() {
    let mut chain = Chain::new(HEAD, vec![]);
    Arc::get_mut(&mut chain).unwrap().logs = opens_at(READ_AT, MON_USDC, MON_USDC_MIRROR);
    let b = boot_with(chain.clone()).await;
    assert_eq!(b.venue.markets(), ["MON/USDC"]);
    assert_eq!(b.decode(&[vault_take_log(READ_AT, 6)]).await.unwrap().len(), 1);
    // its key came from the Open: never asked of the chain
    assert!(chain.reads_of(MON_USDC).is_empty());
}

// The scan never reaches the tip: an Open there can still mutate away, and
// a retracted one must count nothing.
#[tokio::test]
async fn never_learns_an_open_from_the_tip() {
    let mut chain =
        Chain::new(HEAD, vec![(LATE, ChainBook { pair: U256::ZERO, key: mon_usdc_key(), paired_from: None })]);
    Arc::get_mut(&mut chain).unwrap().logs = opens_at(HEAD - 2, LATE, LATE_MIRROR);
    let b = boot_with(chain.clone()).await;
    assert!(b.venue.markets().is_empty());
    assert!(b.decode(&[late_take(READ_AT, 0)]).await.unwrap().is_empty());
    assert_eq!(chain.reads_of(LATE), [("books", READ_AT)]);
}

#[tokio::test]
async fn counts_a_discovered_vault_book_from_its_adoption_not_over_its_whole_life() {
    const OPEN: u64 = READ_AT - 100;
    let mut chain = Chain::new(HEAD, vec![(LATE, vault(LATE_MIRROR, mon_usdc_key(), Some(OPEN)))]);
    Arc::get_mut(&mut chain).unwrap().logs = opens_at(OPEN, LATE, LATE_MIRROR);
    let b = boot_with(chain.clone()).await;
    assert_eq!(b.venue.markets(), ["MON/USDC"]);
    assert!(b.decode(&[late_take(OPEN - 100, 1)]).await.unwrap().is_empty());
    assert_eq!(b.decode(&[late_take(OPEN + 1, 2)]).await.unwrap().len(), 1);
    // every Open from the book's own BookManager.Open on was scanned: today
    // reads [OPEN − 101, OPEN], here nothing
    assert!(chain.reads_of(LATE).is_empty());
}

#[tokio::test]
async fn a_range_without_a_take_reads_nothing() {
    let b = boot_with(Chain::new(HEAD, vec![])).await;
    let before = b.chain.reads.lock().unwrap().len();
    assert!(decode_block(&b.venue, &block_of(HEAD, Vec::new())).unwrap().is_empty());
    assert!(decode_block(&b.venue, &blocks(&[late_open(HEAD + 1, 0)])[0]).unwrap().is_empty());
    assert_eq!(b.chain.reads.lock().unwrap().len(), before);
    assert_eq!(b.venue.pending(), (vec![], vec![]));
}

#[tokio::test]
async fn decode_before_discovery_holds_rather_than_guess() {
    let v = Clober::default();
    let err = decode_block(&v, &blocks(&[vault_take_log(86_746_586, 6)])[0]).unwrap_err();
    assert!(matches!(err, VenueError::NotReady(_)));
    assert_eq!(v.pending().0, [id(MON_USDC)]);
}
