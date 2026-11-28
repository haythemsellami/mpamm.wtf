//! BTR quote() on RECORDED getSwapQuote results, the TypeScript tests' own
//! fixture (server/src/venues/__tests__/fixtures/btr-quotes.json: raw
//! eth_call return data from pool v2 at block 122,736,377, and the raw revert
//! of a leg it refused). The stub node answers a leg only with what the pool
//! answered for exactly that (tokenIn, tokenOut, amountIn); a leg sized any
//! other way has no recording and fails, so the input decimals are checked by
//! the lookup itself. Results are decoded with the venue's own ABI, so a drift
//! in its getSwapQuote tuple fails here.
//!
//! Hand check from the tuples (amountOut is net of protoFee, lpFee and covToll):
//!   MON/USDC $100   sell 6400 WMON -> 97.286130 USDC            bid 0.0152009578125
//!                   buy 100 USDC -> 6565.395285784463596801 WMON ask 0.0152313753624
//!                   fee (8919+80277)/(97286130+8919+80277)       9.160 bps each side
//!   BTC/USDC $100   sell 0.0015625 WBTC -> 100.171583 USDC       bid 64109.81312
//!                   buy 100 USDC -> 0.00155757 WBTC              ask 64202.57195503
//!                   fee 6.115 bps (sell), 6.159 bps (buy)        mean 6.137
//!   MON/USDC $15.5k sell 992,000 WMON reverts 0xb8edb9ac (past the pool's cover)
//!                   buy 15,500 USDC -> 914138.187019147875 WMON  ask 0.0169558609629

mod rpc_stub;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::{parse_address, Registry};
use mpamm_types::QuoteRow;
use mpamm_venues::btr::{self, abi::getSwapQuoteCall, quotable_markets, Btr, BtrMarket, Listing};
use rpc_stub::{call_data, pinned_to, reverted, Answer, Stub};
use serde_json::{json, Value};

const FX: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/btr-quotes.json");
const HASH: [u8; 32] = [0x5a; 32];

fn fx() -> Value {
    serde_json::from_str(FX).unwrap()
}

fn token(key: &str) -> Address {
    Address::from(Registry::get().tokens[key].address_bytes())
}

/// USD sizing prices under which the recorded legs are exact token amounts
/// ($100 is 6,400 WMON and 0.0015625 WBTC), and the pair-terms reference mids
/// the bps are anchored to (the pool's own marks at that block were
/// 0.0152157 and 64,154.40).
struct Recorded;

impl Pricer for Recorded {
    fn usd_per_token(&self, key: &str) -> f64 {
        match key {
            "USDC" => 1.0,
            "WMON" => 1.0 / 64.0,
            "WBTC" => 64_000.0,
            _ => 0.0,
        }
    }
    fn usd_for_token(&self, _: &str, _: f64) -> f64 {
        0.0
    }
    fn pair_mid(&self, market: &str) -> f64 {
        match market {
            "MON/USDC" => 0.0152,
            "BTC/USDC" => 64_150.0,
            _ => 0.0,
        }
    }
}

/// Discovery as the TypeScript test stubs it: USDC, WMON and WBTC are listed
/// and swap-enabled, every other registered ERC-20 reads back zeroed.
fn discovered() -> Vec<BtrMarket> {
    let reg = Registry::get();
    let native = parse_address(&reg.native_mon);
    let listing: Vec<Listing<'_>> = reg
        .tokens
        .iter()
        .filter(|(_, t)| Some(t.address_bytes()) != native)
        .map(|(k, t)| Listing {
            token_key: k,
            read: Some(if ["USDC", "WMON", "WBTC"].contains(&k.as_str()) { (t.decimals, 16) } else { (0, 0) }),
        })
        .collect();
    quotable_markets(reg, &listing).unwrap()
}

/// The venue with only these discovered markets quotable (today's
/// `quote(…, markets)` subset).
fn only(markets: &[&str]) -> Btr {
    Btr::with_quotable(discovered().into_iter().filter(|m| markets.contains(&m.market.as_str())).collect())
}

/// A node holding the recording: each getSwapQuote leg answered with its
/// recorded return data or revert, anything else refused loudly.
async fn recording() -> Stub {
    let legs: Vec<(Address, Address, U256, Answer)> = fx()["legs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            let a = |k: &str| l[k].as_str().unwrap().parse::<Address>().unwrap();
            let answer = match l["returnData"].as_str() {
                Some(d) => Ok(json!(d)),
                None => reverted(l["revertData"].as_str().unwrap()),
            };
            (a("tokenIn"), a("tokenOut"), l["amountIn"].as_str().unwrap().parse().unwrap(), answer)
        })
        .collect();
    Stub::start(move |method, params| {
        let refuse = |why: String| Err(json!({ "code": -32000, "message": why }));
        if method != "eth_call" {
            return refuse(format!("unexpected {method}"));
        }
        let Ok(c) = getSwapQuoteCall::abi_decode(&call_data(params)) else {
            return refuse("not a getSwapQuote".into());
        };
        match legs.iter().find(|(i, o, n, _)| (*i, *o, *n) == (c.tokenIn, c.tokenOut, c.amountIn)) {
            Some((.., answer)) => answer.clone(),
            None => refuse(format!("no recorded getSwapQuote for {}, {}, {}", c.tokenIn, c.tokenOut, c.amountIn)),
        }
    })
    .await
}

fn block() -> BlockRef {
    BlockRef { number: fx()["blockNumber"].as_str().unwrap().parse().unwrap(), id: [0; 32], hash: HASH }
}

async fn quote_with(stub: &Stub, v: &Btr, pricer: &dyn Pricer, sizes: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
    let rpc = stub.rpc();
    v.quote(&QuoteCx { rpc: &rpc, registry: Registry::get(), pricer, block: block() }, sizes).await
}

async fn quote(stub: &Stub, markets: &[&str], sizes: &[f64]) -> Vec<QuoteRow> {
    quote_with(stub, &only(markets), &Recorded, sizes).await.unwrap()
}

/// What the venue asked the pool, in order: (to, tokenIn, tokenOut, amountIn).
fn asked(stub: &Stub) -> Vec<(Address, Address, Address, U256)> {
    stub.seen()
        .iter()
        .map(|s| {
            let c = getSwapQuoteCall::abi_decode(&s.data()).unwrap();
            (s.params[0]["to"].as_str().unwrap().parse().unwrap(), c.tokenIn, c.tokenOut, c.amountIn)
        })
        .collect()
}

fn bps(px: f64, mid: f64) -> f64 {
    (px / mid - 1.0) * 1e4
}

/// vitest's `toBeCloseTo(b, digits)`.
fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

#[tokio::test]
async fn prices_both_sides_of_an_18_decimal_base_against_a_6_decimal_quote() {
    let stub = recording().await;
    let rows = quote(&stub, &["MON/USDC"], &[100.0]).await;

    // Each side is sized in its INPUT token's own units: $100 of WMON, then $100 of USDC.
    assert_eq!(
        asked(&stub),
        [
            (btr::POOL, token("WMON"), token("USDC"), U256::from(6_400u64) * U256::from(10u64).pow(U256::from(18u8))),
            (btr::POOL, token("USDC"), token("WMON"), U256::from(100_000_000u64)),
        ]
    );

    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!((row.venue_id.as_str(), row.market.as_str(), row.size_usd), ("btr", "MON/USDC", 100.0));
    assert!(row.filled_full);
    assert_eq!(row.one_sided, None);
    // Sell: USDC out (6 decimals) per WMON in (18); buy: USDC in per WMON out.
    assert!(close(row.bid_px, 97.28613 / 6400.0, 12));
    assert!(close(row.bid_px, 0.0152009578125, 12));
    assert!(close(row.ask_px, 0.015231375362352, 12));
    assert!(close(row.bid_bps, bps(0.0152009578125, 0.0152), 6)); //  +0.63
    assert!(close(row.ask_bps, bps(0.015231375362352, 0.0152), 6)); // +20.64
    assert!(close(row.spread_bps, 20.011546, 4));
    assert_eq!(row.spread_bps, row.ask_bps - row.bid_bps);
    assert!(row.ts > 0.0 && row.cex_ask_bps.is_none() && row.cex_bid_bps.is_none());
}

#[tokio::test]
async fn prices_an_8_decimal_base_in_both_directions() {
    let stub = recording().await;
    let rows = quote(&stub, &["BTC/USDC"], &[100.0]).await;
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!((row.market.as_str(), row.size_usd, row.filled_full), ("BTC/USDC", 100.0, true));
    // 156,250 sats in -> 100.171583 USDC; 100 USDC in -> 155,757 sats.
    assert_eq!(asked(&stub)[0].3, U256::from(156_250u64));
    assert!(close(row.bid_px, 64_109.813_12, 6));
    assert!(close(row.ask_px, 64_202.571955, 5));
    assert!(close(row.bid_bps, bps(64_109.813_12, 64_150.0), 6)); // -6.26
    assert!(close(row.ask_bps, bps(64_202.571955, 64_150.0), 5)); // +8.20
    assert!(close(row.spread_bps, 14.459678, 4));
}

#[tokio::test]
async fn takes_the_fee_over_the_gross_output_per_leg_and_averages_the_two_sides() {
    let stub = recording().await;
    let mon = &quote(&stub, &["MON/USDC"], &[100.0]).await[0];
    let btc = &quote(&stub, &["BTC/USDC"], &[100.0]).await[0];
    // (protoFee + lpFee) / (amountOut + protoFee + lpFee), in tokenOut units.
    // Over the NET amountOut these would read 9.168 and 6.1405 instead.
    assert!(close(mon.fee_bps, 9.16, 3));
    assert!(close(btc.fee_bps, (6.115 + 6.159) / 2.0, 3));
}

#[tokio::test]
async fn pins_every_read_to_the_block_hash_in_one_batch_without_a_head_read() {
    let stub = recording().await;
    assert_eq!(quote(&stub, &["MON/USDC", "BTC/USDC"], &[100.0]).await.len(), 2);
    let seen = stub.seen();
    assert_eq!(seen.len(), 4);
    assert!(seen.iter().all(|s| s.method == "eth_call"), "no head read of its own");
    assert!(seen.iter().all(|s| s.request == seen[0].request), "one round trip");
    assert!(seen.iter().all(|s| s.params[1] == pinned_to(HASH)));
    // Every read carries the explicit gas limit (under the node's 8.1M heavy-call bar).
    assert!(seen.iter().all(|s| s.params[0]["gas"] == json!("0x7a1200")));
}

#[tokio::test]
async fn keeps_the_surviving_side_as_a_one_sided_row_when_the_pool_refuses_the_other() {
    let stub = recording().await;
    let size = fx()["oneSidedSizeUsd"].as_f64().unwrap();
    let rows = quote(&stub, &["MON/USDC"], &[size]).await;
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!((row.market.as_str(), row.size_usd, row.one_sided), ("MON/USDC", 15_500.0, Some(true)));
    assert_eq!((row.bid_px, row.bid_bps, row.spread_bps), (0.0, 0.0, 0.0));
    // A refused leg reverts rather than filling partly: what answers is the full size.
    assert!(row.filled_full);
    // 15,500 USDC in -> 914,138.187 WMON out: the size-dependent toll puts it far off mid.
    assert!(close(row.ask_px, 0.016955860962928, 12));
    assert!(close(row.ask_bps, bps(0.016955860962928, 0.0152), 6)); // +1155.17
    assert!(close(row.fee_bps, 9.16, 3));
}

#[tokio::test]
async fn rows_follow_the_registry_order_market_then_size() {
    let stub = recording().await;
    let rows = quote(&stub, &["BTC/USDC", "MON/USDC"], &[100.0, 15_500.0]).await;
    let got: Vec<(&str, f64)> = rows.iter().map(|r| (r.market.as_str(), r.size_usd)).collect();
    // BTC/USDC $15.5k has no recording: both its legs fail and it has no row.
    assert_eq!(got, [("MON/USDC", 100.0), ("MON/USDC", 15_500.0), ("BTC/USDC", 100.0)]);
    let order: Vec<(Address, Address)> = asked(&stub).iter().map(|a| (a.1, a.2)).collect();
    let (wmon, usdc, wbtc) = (token("WMON"), token("USDC"), token("WBTC"));
    assert_eq!(
        order,
        [
            (wmon, usdc),
            (usdc, wmon),
            (wmon, usdc),
            (usdc, wmon),
            (wbtc, usdc),
            (usdc, wbtc),
            (wbtc, usdc),
            (usdc, wbtc)
        ]
    );
}

#[tokio::test]
async fn every_leg_failing_is_an_error_naming_the_failure() {
    let stub = Stub::start(|_, _| reverted("0xb8edb9ac")).await;
    let err = quote_with(&stub, &only(&["MON/USDC"]), &Recorded, &[100.0]).await.unwrap_err();
    let VenueError::Chain(msg) = err else { panic!("{err:?}") };
    assert!(msg.starts_with("BTR quotes unavailable — all 2 legs failed with \""), "{msg}");
    assert!(msg.contains("execution reverted"), "{msg}");
}

#[tokio::test]
async fn an_unpriced_market_asks_nothing() {
    /// The mids, but no USD price for the quote leg.
    struct NoUsdc;
    impl Pricer for NoUsdc {
        fn usd_per_token(&self, key: &str) -> f64 {
            if key == "USDC" {
                0.0
            } else {
                Recorded.usd_per_token(key)
            }
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, market: &str) -> f64 {
            Recorded.pair_mid(market)
        }
    }
    let stub = recording().await;
    // No mid for BTC/MON; no USD for USDC.
    assert_eq!(quote(&stub, &["BTC/MON"], &[100.0]).await, []);
    assert_eq!(quote_with(&stub, &only(&["MON/USDC"]), &NoUsdc, &[100.0]).await.unwrap(), []);
    assert!(stub.seen().is_empty());
}
