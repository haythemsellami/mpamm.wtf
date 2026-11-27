//! Crystal Vault quote() on RECORDED getQuote results, the TypeScript tests'
//! own fixture (server/src/venues/__tests__/fixtures/crystal.json: one
//! block's discovery reads and the eight getQuote legs at block 117,081,122).
//! The stub node answers a leg only for exactly its recorded arguments
//! (market, isBuy, isExactInput, isCompleteFill, size, worstPrice), so the
//! sizing and the band are checked by the lookup itself. Expected prices come
//! from the raw ints, not the venue.

mod rpc_stub;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_types::QuoteRow;
use mpamm_venues::crystal::{
    self,
    abi::{getQuoteCall, getQuoteReturn, MarketInfo},
    verify_book, Book, Crystal,
};
use rpc_stub::{call_data, hex, pinned_to, Answer, Stub};
use serde_json::{json, Value};

const FX: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/crystal.json");
const HASH: [u8; 32] = [0xc7; 32];
const SIZES: [f64; 4] = [100.0, 1_000.0, 10_000.0, 100_000.0];

fn fx() -> Value {
    serde_json::from_str(FX).unwrap()
}

fn u256(v: &Value) -> U256 {
    v.as_str().unwrap().parse().unwrap()
}

/// Discovery as recorded: the vault's market(), quoteAsset(), baseAsset(),
/// then the market's getMarket.
fn recorded_book() -> Book {
    let fx = fx();
    let m = &fx["discovery"]["getMarket"];
    let a = |v: &Value| v.as_str().unwrap().parse::<Address>().unwrap();
    let info = MarketInfo {
        quoteAsset: a(&m["quoteAsset"]),
        baseAsset: a(&m["baseAsset"]),
        marketType: u256(&m["marketType"]),
        highestBid: u256(&m["highestBid"]),
        lowestAsk: u256(&m["lowestAsk"]),
        scaleFactor: u256(&m["scaleFactor"]),
        tickSize: u256(&m["tickSize"]),
        maxPrice: u256(&m["maxPrice"]),
        minSize: u256(&m["minSize"]),
        takerFee: u256(&m["takerFee"]),
        makerRebate: u256(&m["makerRebate"]),
        reserveQuote: u256(&m["reserveQuote"]),
        reserveBase: u256(&m["reserveBase"]),
        isAMMEnabled: m["isAMMEnabled"].as_bool().unwrap(),
    };
    let v = &fx["discovery"]["vault"];
    verify_book(Registry::get(), a(&v[0]), a(&v[2]), a(&v[1]), &info).unwrap()
}

fn mid() -> f64 {
    fx()["quote"]["pairMid"].as_f64().unwrap()
}

/// USDC is $1 and WMON is priced at the pair mid, as the TypeScript test
/// sizes it (`usd / pairMid` WMON per leg).
struct AtMid;

impl Pricer for AtMid {
    fn usd_per_token(&self, key: &str) -> f64 {
        if key == "USDC" {
            1.0
        } else {
            mid()
        }
    }
    fn usd_for_token(&self, _: &str, amount: f64) -> f64 {
        amount
    }
    fn pair_mid(&self, _: &str) -> f64 {
        mid()
    }
}

/// One recorded leg: its arguments, as the venue must ask them, and its
/// (amountIn, amountOut).
fn recorded_legs() -> Vec<(getQuoteCall, (U256, U256))> {
    fx()["quote"]["legs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            let a = &l["args"];
            assert_eq!(l["status"], "success");
            (
                getQuoteCall {
                    market: a[0].as_str().unwrap().parse().unwrap(),
                    isBuy: a[1].as_bool().unwrap(),
                    isExactInput: a[2].as_bool().unwrap(),
                    isCompleteFill: a[3].as_bool().unwrap(),
                    size: u256(&a[4]),
                    worstPrice: u256(&a[5]),
                },
                (u256(&l["result"][0]), u256(&l["result"][1])),
            )
        })
        .collect()
}

fn same(a: &getQuoteCall, b: &getQuoteCall) -> bool {
    (a.market, a.isBuy, a.isExactInput, a.isCompleteFill, a.size, a.worstPrice)
        == (b.market, b.isBuy, b.isExactInput, b.isCompleteFill, b.size, b.worstPrice)
}

fn answer(amount_in: U256, amount_out: U256) -> Answer {
    Ok(hex(&getQuoteCall::abi_encode_returns(&getQuoteReturn { amountIn: amount_in, amountOut: amount_out })))
}

/// A node answering each getQuote leg through `leg(recorded answer, call)`;
/// a leg with no recording is refused loudly.
async fn node(leg: impl Fn((U256, U256), &getQuoteCall) -> Answer + Send + Sync + 'static) -> Stub {
    let legs = recorded_legs();
    Stub::start(move |method, params| {
        let refuse = |why: String| Err(json!({ "code": -32000, "message": why }));
        if method != "eth_call" {
            return refuse(format!("unexpected {method}"));
        }
        let Ok(c) = getQuoteCall::abi_decode(&call_data(params)) else { return refuse("not a getQuote".into()) };
        match legs.iter().find(|(r, _)| same(r, &c)) {
            Some((_, out)) => leg(*out, &c),
            None => {
                refuse(format!("unrecorded getQuote leg (buy {}, size {}, worst {})", c.isBuy, c.size, c.worstPrice))
            }
        }
    })
    .await
}

async fn recording() -> Stub {
    node(|(a, b), _| answer(a, b)).await
}

fn block() -> BlockRef {
    BlockRef { number: fx()["quote"]["block"].as_str().unwrap().parse().unwrap(), id: [0; 32], hash: HASH }
}

async fn quote_with(stub: &Stub, v: &Crystal, pricer: &dyn Pricer) -> Result<Vec<QuoteRow>, VenueError> {
    let rpc = stub.rpc();
    v.quote(&QuoteCx { rpc: &rpc, registry: Registry::get(), pricer, block: block() }, &SIZES).await
}

async fn quote(stub: &Stub) -> Result<Vec<QuoteRow>, VenueError> {
    quote_with(stub, &Crystal::with_book(recorded_book()), &AtMid).await
}

/// `Number(raw) / 10 ** decimals`.
fn human(raw: U256, decimals: i32) -> f64 {
    raw.to_string().parse::<f64>().unwrap() / 10f64.powi(decimals)
}

/// vitest's `toBeCloseTo(b, digits)`.
fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

#[tokio::test]
async fn prices_each_leg_off_get_quote_banded_partial_when_in_band_depth_runs_out() {
    let stub = recording().await;
    let rows = quote(&stub).await.unwrap();
    let legs = recorded_legs();
    let mid = mid();
    // worstPrice = mid ± 2000 bps in raw book units (scaleFactor 1e21 × 1e6 / 1e18 = 1e9).
    assert_eq!(legs[0].0.worstPrice, U256::from((mid * 1.2 * 1e9).floor() as u64));
    assert_eq!(legs[1].0.worstPrice, U256::from((mid * 0.8 * 1e9).ceil() as u64));
    // The venue asked exactly the recorded legs, in order: buy then sell per size.
    let asked: Vec<getQuoteCall> = stub.seen().iter().map(|s| getQuoteCall::abi_decode(&s.data()).unwrap()).collect();
    assert_eq!(asked.len(), legs.len());
    assert!(asked.iter().zip(&legs).all(|(a, (r, _))| same(a, r)));
    assert!(stub
        .seen()
        .iter()
        .all(|s| s.params[0]["to"].as_str().unwrap().parse::<Address>().unwrap() == crystal::CRYSTAL));

    assert_eq!(rows.iter().map(|r| r.size_usd).collect::<Vec<_>>(), SIZES);
    for (i, r) in rows.iter().enumerate() {
        let (buy, sell) = (legs[2 * i].1, legs[2 * i + 1].1);
        // Buy: (USDC in, WMON out); sell: (WMON in, USDC out).
        let ask_px = human(buy.0, 6) / human(buy.1, 18);
        let bid_px = human(sell.1, 6) / human(sell.0, 18);
        assert_eq!((r.venue_id.as_str(), r.market.as_str()), ("crystal", "MON/USDC"));
        assert!(close(r.ask_px, ask_px, 12));
        assert!(close(r.bid_px, bid_px, 12));
        assert!(close(r.ask_bps, (ask_px / mid - 1.0) * 1e4, 9));
        assert!(close(r.bid_bps, (bid_px / mid - 1.0) * 1e4, 9));
        assert!(close(r.spread_bps, (ask_px - bid_px) / mid * 1e4, 9));
        assert_eq!(r.fee_bps, 0.0);
        assert_eq!(r.one_sided, None);
    }
    // $100/$1k fill inside the band; at $10k+ the in-band book runs out.
    assert_eq!(rows.iter().map(|r| r.filled_full).collect::<Vec<_>>(), [true, true, false, false]);
    assert_ne!(legs[4].1 .0, legs[4].0.size);
}

#[tokio::test]
async fn pins_every_read_to_the_block_hash_in_one_batch_without_a_head_read() {
    let stub = recording().await;
    assert_eq!(quote(&stub).await.unwrap().len(), 4);
    let seen = stub.seen();
    assert_eq!(seen.len(), 8);
    assert!(seen.iter().all(|s| s.method == "eth_call"), "no head read of its own");
    assert!(seen.iter().all(|s| s.request == seen[0].request), "one round trip");
    assert!(seen.iter().all(|s| s.params[1] == pinned_to(HASH)));
    assert!(seen.iter().all(|s| s.params[0]["gas"] == json!("0x7a1200")));
}

/// The live book of late November: the vault's asks are gone from the band,
/// its bids still answer. A side with nothing in band is absent, and the row
/// is one-sided with the partial flag taken from the side that answered.
#[tokio::test]
async fn a_side_with_nothing_in_band_leaves_a_one_sided_row() {
    let stub = node(|(a, b), c| if c.isBuy { answer(U256::ZERO, U256::ZERO) } else { answer(a, b) }).await;
    let rows = quote(&stub).await.unwrap();
    let legs = recorded_legs();
    assert_eq!(rows.len(), 4);
    for (i, r) in rows.iter().enumerate() {
        let sell = legs[2 * i + 1].1;
        assert_eq!(r.one_sided, Some(true));
        assert_eq!((r.ask_px, r.ask_bps, r.spread_bps), (0.0, 0.0, 0.0));
        assert!(close(r.bid_px, human(sell.1, 6) / human(sell.0, 18), 12));
    }
    // Only the bid side's depth decides: it runs out at $10k.
    assert_eq!(rows.iter().map(|r| r.filled_full).collect::<Vec<_>>(), [true, true, false, false]);
}

/// Every leg failing is the venue's outage; legs that answer and fill nothing
/// in band are the vault's own state (an empty or far-priced ladder): no
/// rows, and no error. Only executable rows bring it back.
#[tokio::test]
async fn every_leg_failing_is_an_error_but_an_empty_band_is_just_empty() {
    let paused = node(|_, _| Err(json!({ "code": 3, "message": "execution reverted: market paused" }))).await;
    let err = quote(&paused).await.unwrap_err();
    assert_eq!(
        err,
        VenueError::Chain(
            "Crystal Vault quotes unavailable — all 8 legs failed with \"getQuote(address,bool,bool,bool,uint256,uint256): rpc error 3: execution reverted: market paused\" (venue disabled, or the ABI drifted from the contract)"
                .into()
        )
    );

    let empty = node(|_, _| answer(U256::ZERO, U256::ZERO)).await;
    assert_eq!(quote(&empty).await.unwrap(), []);
    assert_eq!(empty.seen().len(), 8);

    // Some legs failing beside an empty band: still the vault's state.
    let mixed = node(|_, c| {
        if c.isBuy {
            answer(U256::ZERO, U256::ZERO)
        } else {
            Err(json!({ "code": 3, "message": "execution reverted" }))
        }
    })
    .await;
    assert_eq!(quote(&mixed).await.unwrap(), []);

    assert_eq!(quote(&recording().await).await.unwrap().len(), 4);
}

#[tokio::test]
async fn asks_nothing_before_discovery_or_without_a_mid() {
    struct NoMid;
    impl Pricer for NoMid {
        fn usd_per_token(&self, key: &str) -> f64 {
            AtMid.usd_per_token(key)
        }
        fn usd_for_token(&self, _: &str, amount: f64) -> f64 {
            amount
        }
        fn pair_mid(&self, _: &str) -> f64 {
            0.0
        }
    }
    let stub = recording().await;
    assert_eq!(quote_with(&stub, &Crystal::default(), &AtMid).await.unwrap(), []);
    assert_eq!(quote_with(&stub, &Crystal::with_book(recorded_book()), &NoMid).await.unwrap(), []);
    assert!(stub.seen().is_empty());
}
