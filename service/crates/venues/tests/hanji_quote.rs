//! Hanji quote() on RECORDED books, the TypeScript test's own fixture
//! (server/src/venues/__tests__/fixtures/hanji-books.json: the helper's
//! `assembleOrderbooksFromOrders(proxy, 60)` at the blocks the 7-day replay
//! flagged, and a wMUx book read through its xStock helper). The stub node
//! answers a book only at its block's hash, on its own helper, for its proxy
//! and 60 levels: anything else has no recording and fails.
//!
//! The books carry far-tick stub orders below the vault's ladder (MON/USDC
//! bids 1 MON @ $0.001 + 10,000 MON @ $0.0001, asks 1 MON @ $10,000 and
//! @ $24,172; a cbBTC/MON bid of 1 cbBTC @ 1 MON). Walking into them once
//! published "full two-sided" rows at −5728 and ~−9961 bps.
//!
//! Reference mids: cbBTC/MON is the replay's CEX pair mid at 110,682,151; the
//! MON/USDC mids are the vault's BBO midpoint at each block (the CEX series
//! was not recorded): the band is ±2000 bps, so a few-bps stand-in can't move
//! a level across it.

mod rpc_stub;

use std::collections::HashMap;

use alloy_primitives::{aliases::U72, Address, U256};
use alloy_sol_types::SolCall;
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::{parse_address, Registry};
use mpamm_types::QuoteRow;
use mpamm_venues::hanji::{
    assembleOrderbooksFromOrdersCall, assembleOrderbooksFromOrdersReturn, BookConfig, Hanji, BOOK_LEVELS,
};
use rpc_stub::{call_data, hex, pinned_to, reverted, Stub};
use serde_json::{json, Value};

const CONFIG: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/hanji-config.json");
const BOOKS: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/hanji-books.json");
const FAST_QUOTER_HELPER: &str = "0x237dB58fea34A35A8543b44C217d221606cE7788";
const SIZES: [f64; 4] = [100.0, 1_000.0, 10_000.0, 100_000.0];

fn a(s: &str) -> Address {
    Address::from(parse_address(s).unwrap())
}

/// The fixture's getConfig answers, in table order.
fn configs() -> Vec<BookConfig> {
    let v: Value = serde_json::from_str(CONFIG).unwrap();
    v["markets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let r = |i: usize| m["result"][i].as_str().unwrap().to_string();
            let u = |i: usize| U256::from_str_radix(&r(i), 10).unwrap();
            BookConfig {
                scaling_x: u(0),
                scaling_y: u(1),
                token_x: parse_address(&r(2)).unwrap(),
                token_y: parse_address(&r(3)).unwrap(),
                taker_fee_rate: u(9),
            }
        })
        .collect()
}

fn discovered() -> Hanji {
    Hanji::with_configs(Registry::get(), configs()).unwrap()
}

/// One recorded book: (block, market, helper, proxy, the helper's answer).
struct Book {
    block: u64,
    market: String,
    helper: Address,
    proxy: Address,
    answer: assembleOrderbooksFromOrdersReturn,
}

fn books() -> Vec<Book> {
    let v: Value = serde_json::from_str(BOOKS).unwrap();
    v["books"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            let col = |i: usize| -> Vec<u128> {
                b["result"][i].as_array().unwrap().iter().map(|x| x.as_str().unwrap().parse().unwrap()).collect()
            };
            let px = |i: usize| -> Vec<U72> { col(i).into_iter().map(U72::from).collect() };
            Book {
                block: b["block"].as_u64().unwrap(),
                market: b["market"].as_str().unwrap().to_string(),
                helper: a(b["helper"].as_str().unwrap_or(FAST_QUOTER_HELPER)),
                proxy: a(b["proxy"].as_str().unwrap()),
                answer: assembleOrderbooksFromOrdersReturn {
                    bidPrices: px(0),
                    bidShares: col(1),
                    askPrices: px(2),
                    askShares: col(3),
                },
            }
        })
        .collect()
}

/// Each recorded block's stand-in hash.
fn hash_of(block: u64) -> [u8; 32] {
    let mut h = [0x4a; 32];
    h[24..].copy_from_slice(&block.to_be_bytes());
    h
}

fn block_of(params: &Value) -> Option<u64> {
    let h = params[1]["blockHash"].as_str()?.strip_prefix("0x")?;
    u64::from_str_radix(&h[48..], 16).ok()
}

/// A node holding the recording: each book answered at its own block hash,
/// on its own helper, for exactly (proxy, 60); anything else refused loudly.
async fn recording() -> Stub {
    let books = books();
    Stub::start(move |method, params| {
        let refuse = |why: String| Err(json!({ "code": -32000, "message": why }));
        if method != "eth_call" {
            return refuse(format!("unexpected {method}"));
        }
        let Ok(c) = assembleOrderbooksFromOrdersCall::abi_decode(&call_data(params)) else {
            return refuse("not an assembleOrderbooksFromOrders".into());
        };
        let to: Address = params[0]["to"].as_str().unwrap().parse().unwrap();
        let block = block_of(params);
        let found = books.iter().find(|b| {
            Some(b.block) == block && b.helper == to && b.proxy == c.lobAddress && c.maxPriceLevels.to::<u32>() == 60
        });
        match found {
            Some(b) => Ok(hex(&assembleOrderbooksFromOrdersCall::abi_encode_returns(&b.answer))),
            None => refuse(format!("no recorded book for {} on {to} at {block:?}", c.lobAddress)),
        }
    })
    .await
}

/// The reference at a recorded block: the pair mids, and the USD per base
/// token they imply (cbBTC priced through MON).
struct Mids(HashMap<&'static str, f64>);

fn mids(block: u64) -> Mids {
    Mids(HashMap::from_iter(match block {
        124_766_750 => vec![("wMUx/USDC", 709.655)], // recorded BBO midpoint, per wrapped unit
        110_682_151 => vec![("MON/USDC", 0.032328), ("cbBTC/MON", 2_655_237.9)],
        110_960_000 => vec![("MON/USDC", 0.029299)], // bid ladder empty: just under the best ask
        112_661_510 => vec![("MON/USDC", 0.0266755)],
        _ => vec![],
    }))
}

impl Pricer for Mids {
    fn usd_per_token(&self, key: &str) -> f64 {
        let mid = |m: &str| self.0.get(m).copied().unwrap_or(0.0);
        match key {
            "WMUX" => mid("wMUx/USDC"),
            "WMON" => mid("MON/USDC"),
            "CBBTC" => mid("cbBTC/MON") * mid("MON/USDC"),
            _ => 0.0,
        }
    }
    fn usd_for_token(&self, _: &str, _: f64) -> f64 {
        0.0
    }
    fn pair_mid(&self, market: &str) -> f64 {
        self.0.get(market).copied().unwrap_or(0.0)
    }
}

async fn quote_with(stub: &Stub, pricer: &dyn Pricer, block: u64) -> Result<Vec<QuoteRow>, VenueError> {
    let rpc = stub.rpc();
    let cx = QuoteCx {
        rpc: &rpc,
        registry: Registry::get(),
        pricer,
        block: BlockRef { number: block, id: [0; 32], hash: hash_of(block) },
    };
    discovered().quote(&cx, &SIZES).await
}

/// One market's rows at a recorded block (today's test asks for that market
/// alone; here every market with a mid is quoted and the rest filtered).
async fn quote_at(block: u64, market: &str) -> Vec<QuoteRow> {
    let stub = recording().await;
    let rows = quote_with(&stub, &mids(block), block).await.unwrap();
    rows.into_iter().filter(|r| r.market == market).collect()
}

fn by_size(rows: &[QuoteRow], size: f64) -> &QuoteRow {
    rows.iter().find(|r| r.size_usd == size).unwrap_or_else(|| panic!("no ${size} row"))
}

/// vitest's `toBeCloseTo(b, digits)`.
fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

#[tokio::test]
async fn never_publishes_a_side_beyond_2000_bps_of_mid_on_any_recorded_book() {
    for b in books() {
        let rows = quote_at(b.block, &b.market).await;
        assert!(!rows.is_empty(), "{}@{}", b.market, b.block);
        for r in rows {
            let at = format!("{}@{} ${}", b.market, b.block, r.size_usd);
            if r.bid_px > 0.0 {
                assert!(r.bid_bps.abs() <= 2_001.0, "{at} bid {}", r.bid_bps);
            }
            if r.ask_px > 0.0 {
                assert!(r.ask_bps.abs() <= 2_001.0, "{at} ask {}", r.ask_bps);
            }
        }
    }
}

#[tokio::test]
async fn hand_verified_100_mon_usdc_at_112661510_best_level_plus_the_1bp_taker_fee() {
    let rows = quote_at(112_661_510, "MON/USDC").await;
    let r = by_size(&rows, 100.0);
    // 100 / 0.0266755 = 3748.8 MON: inside level 0 on both sides (72,667 bid / 63,837 ask shares).
    assert!(close(r.ask_px, 0.026678 * 1.0001, 12), "{}", r.ask_px);
    assert!(close(r.bid_px, 0.026673 * 0.9999, 12), "{}", r.bid_px);
    assert!(close(r.ask_bps, 1.94, 1));
    assert!(close(r.bid_bps, -1.94, 1));
    assert!(r.filled_full);
    assert_eq!(r.fee_bps, 1.0);
    assert_eq!(r.one_sided, None);
    assert_eq!(r.spread_bps, ((r.ask_px - r.bid_px) / 0.0266755) * 1e4);
    assert!(r.ts > 0.0 && r.cex_ask_bps.is_none() && r.cex_bid_bps.is_none());
}

#[tokio::test]
async fn a_100k_mon_usdc_at_112661510_is_a_partial_at_an_in_band_vwap() {
    let rows = quote_at(112_661_510, "MON/USDC").await;
    let r = by_size(&rows, 100_000.0);
    // The vault ladder holds ~$19k bid / ~$17k ask; past it are only the stubs.
    assert!(!r.filled_full);
    assert!(r.ask_bps > 0.0 && r.ask_bps < 30.0, "{}", r.ask_bps);
    assert!(r.bid_bps < 0.0 && r.bid_bps > -30.0, "{}", r.bid_bps);
}

#[tokio::test]
async fn a_10k_cbbtc_mon_thin_bid_at_110682151_is_a_partial_not_a_full_fill_at_minus_5728_bps() {
    let rows = quote_at(110_682_151, "cbBTC/MON").await;
    let r = by_size(&rows, 10_000.0);
    // In-band bid depth is 0.0498 cbBTC (~$4.3k); the rest was a 1-cbBTC bid @ 1 MON.
    assert!(!r.filled_full);
    assert_eq!(r.one_sided, None);
    assert!(r.bid_bps > -20.0, "{}", r.bid_bps);
    assert!(close(r.ask_bps, -0.7, 0), "{}", r.ask_bps); // the replay's ask, unchanged
                                                         // The smaller sizes fit inside the vault ladder and stay full two-sided.
    let small = by_size(&rows, 1_000.0);
    assert!(small.filled_full);
    assert_eq!(small.one_sided, None);
}

#[tokio::test]
async fn an_empty_vault_bid_ladder_at_110960000_leaves_the_row_one_sided_not_a_zero_bid() {
    let rows = quote_at(110_960_000, "MON/USDC").await;
    let r = by_size(&rows, 100.0);
    assert_eq!(r.one_sided, Some(true));
    assert!(r.filled_full);
    assert_eq!((r.bid_px, r.bid_bps, r.spread_bps), (0.0, 0.0, 0.0));
    assert!(close(r.ask_px, 0.0293 * 1.0001, 12), "{}", r.ask_px);
}

#[tokio::test]
async fn quotes_the_wmux_proxy_through_its_stock_helper_in_usdc_per_wrapped_token() {
    let rows = quote_at(124_766_750, "wMUx/USDC").await;
    let r = &rows[0];
    // $100 buys ~0.141 shares. The ask fits at level one; the bid walks two levels.
    let shares = 100.0 / 709.655;
    let bid = (0.1138 * 709.50 + (shares - 0.1138) * 709.28) / shares;
    assert!(close(r.ask_px, 709.81 * 1.0001, 9), "{}", r.ask_px);
    assert!(close(r.bid_px, bid * 0.9999, 9), "{}", r.bid_px);
    assert!(r.filled_full);
}

#[tokio::test]
async fn reads_each_book_as_its_own_call_in_one_batch_pinned_to_the_block_hash() {
    let stub = recording().await;
    let rows = quote_with(&stub, &mids(110_682_151), 110_682_151).await.unwrap();
    // Rows follow the registry's pair order, then size.
    let got: Vec<(&str, f64)> = rows.iter().map(|r| (r.market.as_str(), r.size_usd)).collect();
    let want: Vec<(&str, f64)> =
        ["MON/USDC", "cbBTC/MON"].iter().flat_map(|m| SIZES.iter().map(move |s| (*m, *s))).collect();
    assert_eq!(got, want);
    let seen = stub.seen();
    // One call per priced book: the 17-book aggregate is ~12M gas, one book 0.2–0.9M.
    assert_eq!(seen.len(), 2);
    assert!(seen.iter().all(|s| s.method == "eth_call"), "no head read of its own");
    assert!(seen.iter().all(|s| s.request == seen[0].request), "one round trip");
    assert!(seen.iter().all(|s| s.params[1] == pinned_to(hash_of(110_682_151))));
    // Every read carries the explicit gas limit (under the node's 8.1M heavy-call bar).
    assert!(seen.iter().all(|s| s.params[0]["gas"] == json!("0x7a1200")));
    let asked: Vec<(Address, Address, u32)> = seen
        .iter()
        .map(|s| {
            let c = assembleOrderbooksFromOrdersCall::abi_decode(&s.data()).unwrap();
            (s.params[0]["to"].as_str().unwrap().parse().unwrap(), c.lobAddress, c.maxPriceLevels.to::<u32>())
        })
        .collect();
    let helper = a(FAST_QUOTER_HELPER);
    assert_eq!(
        asked,
        [
            (helper, a("0x1aeD222dda944a87703c918745b11bE13f8eEf10"), BOOK_LEVELS),
            (helper, a("0x012e06b56EEE881603E47748931dC38EfaBf54eF"), BOOK_LEVELS),
        ]
    );
}

#[tokio::test]
async fn a_book_that_fails_is_skipped_and_the_others_still_quote() {
    /// The recorded mids plus one for a book the node has no recording of.
    struct WithXaut(Mids);
    impl Pricer for WithXaut {
        fn usd_per_token(&self, key: &str) -> f64 {
            if key == "XAUT0" {
                4_000.0
            } else {
                self.0.usd_per_token(key)
            }
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, market: &str) -> f64 {
            if market == "XAUt/USDC" {
                4_000.0
            } else {
                self.0.pair_mid(market)
            }
        }
    }
    let stub = recording().await;
    let rows = quote_with(&stub, &WithXaut(mids(112_661_510)), 112_661_510).await.unwrap();
    assert_eq!(stub.seen().len(), 2);
    assert!(rows.iter().all(|r| r.market == "MON/USDC"));
    assert_eq!(rows.len(), 4);
}

#[tokio::test]
async fn every_book_failing_is_an_error_naming_the_failure() {
    let stub = Stub::start(|_, _| reverted("0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000065061757365640000000000000000000000000000000000000000000000000000")).await;
    let err = quote_with(&stub, &mids(110_682_151), 110_682_151).await.unwrap_err();
    let VenueError::Chain(msg) = err else { panic!("{err:?}") };
    assert!(msg.starts_with("Hanji pAMM Vault quotes unavailable — all 2 legs failed with \""), "{msg}");
    assert!(msg.contains("reverted: Paused"), "{msg}");
}

#[tokio::test]
async fn an_unpriced_book_reads_nothing() {
    /// The mid, but no USD to size the base with.
    struct NoBaseUsd;
    impl Pricer for NoBaseUsd {
        fn usd_per_token(&self, _: &str) -> f64 {
            0.0
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, market: &str) -> f64 {
            mids(112_661_510).pair_mid(market)
        }
    }
    let stub = recording().await;
    // No mid for any book at an unrecorded block; no base USD with a mid.
    assert_eq!(quote_with(&stub, &mids(1), 1).await.unwrap(), []);
    assert_eq!(quote_with(&stub, &NoBaseUsd, 112_661_510).await.unwrap(), []);
    assert!(stub.seen().is_empty());
}
