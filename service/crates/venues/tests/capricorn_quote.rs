//! Capricorn pAMM quote(), ported from the quote cases of
//! server/src/venues/__tests__/capricorn.decode.test.ts through a loopback
//! JSON-RPC node. The factory keys pools on (token0, token1, feeBps), so MORE
//! THAN ONE fee tier of the same pair is the designed shape even though only
//! two pools (on two markets) exist today: a second pool on a market must not
//! make the published row depend on call order.

mod rpc_stub;

use alloy_primitives::{address, Address, U256};
use alloy_sol_types::SolCall;
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_ring::Addr;
use mpamm_types::QuoteRow;
use mpamm_venues::capricorn::{quoteExactInCall, Capricorn, Reads};
use rpc_stub::{call_data, hex, pinned_to, reverted, Answer, Stub};
use serde_json::json;

const SEED_USDC: Addr = address!("63093325c05cd32b18034d3ea29199fb7098e4df").0 .0;
const SEED_AUSD: Addr = address!("91c483fbe8feef4dad525781e6d65d2e668b3a47").0 .0;
/// A second MON/USDC pool, as a later PoolCreated would deliver it.
const NEW_USDC: Addr = address!("00000000000000000000000000000000000000aa").0 .0;
const HASH: [u8; 32] = [0xca; 32];
const E18: u64 = 1_000_000_000_000_000_000;

fn reg() -> &'static Registry {
    Registry::get()
}

fn tok(key: &str) -> Addr {
    reg().tokens[key].address_bytes()
}

/// (pool, token0, token1, fee) as discovery reads them.
fn layout(pool: Addr) -> (Addr, Addr, f64) {
    match pool {
        SEED_USDC => (tok("USDC"), tok("WMON"), 50.0),
        NEW_USDC => (tok("USDC"), tok("WMON"), 30.0),
        SEED_AUSD => (tok("AUSD"), tok("WMON"), 50.0),
        _ => unreachable!(),
    }
}

/// A venue whose discovery admitted these pools and found each one quoting.
fn discovered(pools: &[Addr]) -> Capricorn {
    let v = Capricorn::default();
    let reads = Reads {
        pools: pools.to_vec(),
        tokens: pools.iter().map(|p| Some((layout(*p).0, layout(*p).1))).collect(),
        fees: pools.iter().map(|p| Some(layout(*p).2)).collect(),
    };
    let admitted = v.apply(reg(), &reads).unwrap();
    v.set_quotable(&admitted, &vec![Some(false); admitted.len()], &vec![Some(U256::from(1u8)); admitted.len()]);
    v
}

/// Per-pool answers in raw output units: (buy out in WMON, sell out in the
/// stable). Mid is 0.02 stable per base, so 100 of the stable buys 5,000
/// WMON AT mid.
fn answers(pool: Addr) -> (U256, U256) {
    let wmon = |n: u64| U256::from(n) * U256::from(E18);
    match pool {
        SEED_USDC => (wmon(4_950), U256::from(99_500_000u64)), // ask 0.020202 (worse), bid 0.0199 (better)
        NEW_USDC => (wmon(5_000), U256::from(99_000_000u64)),  // ask 0.02 (better), bid 0.0198 (worse)
        SEED_AUSD => (wmon(5_000), U256::from(99_000_000u64)),
        _ => unreachable!(),
    }
}

/// A node answering each pool's legs: buying spends exactly 100 of the
/// stable, selling exactly 5,000 WMON ($100 at 0.02); any other leg is
/// refused, so the sizing is checked by the lookup itself.
async fn node(f: impl Fn(Addr, &quoteExactInCall) -> Answer + Send + Sync + 'static) -> Stub {
    Stub::start(move |method, params| {
        let refuse = |why: String| Err(json!({ "code": -32000, "message": why }));
        if method != "eth_call" {
            return refuse(format!("unexpected {method}"));
        }
        let Ok(c) = quoteExactInCall::abi_decode(&call_data(params)) else {
            return refuse("not a quoteExactIn".into());
        };
        let pool = params[0]["to"].as_str().unwrap().parse::<Address>().unwrap().into_array();
        f(pool, &c)
    })
    .await
}

fn out(v: U256) -> Answer {
    Ok(hex(&quoteExactInCall::abi_encode_returns(&v)))
}

async fn recorded() -> Stub {
    node(|pool, c| {
        let (buy, sell) = answers(pool);
        let (stable, _, _) = layout(pool);
        if c.tokenIn == Address::from(stable) && c.amountIn == U256::from(100_000_000u64) {
            out(buy)
        } else if c.tokenIn == Address::from(tok("WMON")) && c.amountIn == U256::from(5_000u64) * U256::from(E18) {
            out(sell)
        } else {
            Err(json!({ "code": -32000, "message": format!("unrecorded leg {} {}", c.tokenIn, c.amountIn) }))
        }
    })
    .await
}

/// mid 0.02 for every market and $0.02 per base token.
struct Mid;

impl Pricer for Mid {
    fn usd_per_token(&self, key: &str) -> f64 {
        if reg().tokens.get(key).is_some_and(|t| t.stable) {
            1.0
        } else {
            0.02
        }
    }
    fn usd_for_token(&self, _: &str, _: f64) -> f64 {
        0.0
    }
    fn pair_mid(&self, _: &str) -> f64 {
        0.02
    }
}

async fn quote_with(
    stub: &Stub,
    v: &Capricorn,
    pricer: &dyn Pricer,
    sizes: &[f64],
) -> Result<Vec<QuoteRow>, VenueError> {
    let rpc = stub.rpc();
    let cx = QuoteCx { rpc: &rpc, registry: reg(), pricer, block: BlockRef { number: 123, id: [0; 32], hash: HASH } };
    v.quote(&cx, sizes).await
}

/// vitest's `toBeCloseTo(b, digits)`.
fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

fn mon_usdc(rows: &[QuoteRow]) -> &QuoteRow {
    rows.iter().find(|r| r.market == "MON/USDC").expect("a MON/USDC row")
}

#[tokio::test]
async fn takes_the_best_price_per_side_not_whichever_leg_answered_last() {
    let stub = recorded().await;
    let rows = quote_with(&stub, &discovered(&[SEED_USDC, SEED_AUSD, NEW_USDC]), &Mid, &[100.0]).await.unwrap();
    let row = mon_usdc(&rows);
    // Cheapest ask wins (the new pool), richest bid wins (the seed pool).
    assert!(close(row.ask_px, 0.02, 9));
    assert!(close(row.bid_px, 0.0199, 9));
    assert!(close(row.ask_bps, 0.0, 6));
    assert!(close(row.bid_bps, -50.0, 6));
    assert!(close(row.spread_bps, 50.0, 6));
    assert_eq!(row.spread_bps, row.ask_bps - row.bid_bps);
    // A row assembled from two pools carries the WORSE fee of the two.
    assert_eq!(row.fee_bps, 50.0);
    assert_eq!(row.one_sided, None);
    assert!(row.filled_full && row.ts > 0.0 && row.cex_ask_bps.is_none() && row.cex_bid_bps.is_none());
}

#[tokio::test]
async fn is_order_independent_the_same_rows_whichever_pool_is_seen_first() {
    let stub = recorded().await;
    let a = quote_with(&stub, &discovered(&[SEED_USDC, SEED_AUSD, NEW_USDC]), &Mid, &[100.0]).await.unwrap();
    let b = quote_with(&stub, &discovered(&[NEW_USDC, SEED_AUSD, SEED_USDC]), &Mid, &[100.0]).await.unwrap();
    let strip = |rows: Vec<QuoteRow>| rows.into_iter().map(|r| QuoteRow { ts: 0.0, ..r }).collect::<Vec<_>>();
    assert_eq!(strip(a), strip(b));
}

#[tokio::test]
async fn pins_every_leg_to_the_block_hash_in_one_batch_buying_with_the_stable_selling_the_base() {
    let stub = recorded().await;
    let rows = quote_with(&stub, &discovered(&[SEED_AUSD, SEED_USDC]), &Mid, &[100.0]).await.unwrap();
    // The registry's order (MON/USDC before MON/AUSD), whatever the pools' order.
    let got: Vec<&str> = rows.iter().map(|r| r.market.as_str()).collect();
    assert_eq!(got, ["MON/USDC", "MON/AUSD"]);
    let seen = stub.seen();
    assert_eq!(seen.len(), 4);
    assert!(seen.iter().all(|s| s.method == "eth_call"), "no head read of its own");
    assert!(seen.iter().all(|s| s.request == seen[0].request), "one round trip");
    assert!(seen.iter().all(|s| s.params[1] == pinned_to(HASH)));
    assert!(seen.iter().all(|s| s.params[0]["gas"] == json!("0x7a1200")));
    // Per pool and size: buy (spend 100 of the stable), then sell (5,000 WMON).
    let asked: Vec<(Addr, Address)> = seen
        .iter()
        .map(|s| {
            let c = quoteExactInCall::abi_decode(&s.data()).unwrap();
            (s.params[0]["to"].as_str().unwrap().parse::<Address>().unwrap().into_array(), c.tokenIn)
        })
        .collect();
    let (ausd, usdc, wmon) = (Address::from(tok("AUSD")), Address::from(tok("USDC")), Address::from(tok("WMON")));
    assert_eq!(asked, [(SEED_AUSD, ausd), (SEED_AUSD, wmon), (SEED_USDC, usdc), (SEED_USDC, wmon)]);
}

#[tokio::test]
async fn a_saturated_leg_beyond_the_band_is_dropped_leaving_a_one_sided_row() {
    // Asked to sell 5,000 WMON, the pool hands back its whole reserve: a
    // "price" thousands of bps out is an exhausted reserve, not depth.
    let stub = node(|pool, c| {
        if c.tokenIn == Address::from(tok("WMON")) {
            out(U256::from(1_000_000_000u64)) // 1,000 USDC for $100 of WMON: +100,000 bps
        } else {
            out(answers(pool).0)
        }
    })
    .await;
    let rows = quote_with(&stub, &discovered(&[SEED_USDC]), &Mid, &[100.0]).await.unwrap();
    let row = mon_usdc(&rows);
    assert_eq!(row.one_sided, Some(true));
    assert_eq!((row.bid_px, row.bid_bps, row.spread_bps), (0.0, 0.0, 0.0));
    assert!(close(row.ask_px, 100.0 / 4_950.0, 12));
    assert!(row.filled_full);
    assert_eq!(row.fee_bps, 50.0);
}

#[tokio::test]
async fn every_leg_failing_is_an_error_naming_the_failure() {
    let stub = node(|_, _| reverted("0x19abf40e")).await;
    let err = quote_with(&stub, &discovered(&[SEED_USDC, SEED_AUSD]), &Mid, &[100.0]).await.unwrap_err();
    let VenueError::Chain(msg) = err else { panic!("{err:?}") };
    assert!(msg.starts_with("Capricorn pAMM quotes unavailable — all 4 legs failed with \""), "{msg}");
    assert!(msg.contains("custom error 0x19abf40e"), "{msg}");
}

#[tokio::test]
async fn one_pool_failing_is_skipped() {
    // Today's AUSD pool: its quoteExactIn reverts while the USDC pool answers.
    let stub = node(|pool, c| {
        if pool == SEED_AUSD {
            return reverted("0x19abf40e");
        }
        let (buy, sell) = answers(pool);
        out(if c.tokenIn == Address::from(tok("WMON")) { sell } else { buy })
    })
    .await;
    let rows = quote_with(&stub, &discovered(&[SEED_USDC, SEED_AUSD]), &Mid, &[100.0]).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.market.as_str()).collect::<Vec<_>>(), ["MON/USDC"]);
}

#[tokio::test]
async fn quotes_only_pools_answering_at_the_last_discovery() {
    let stub = recorded().await;
    let v = Capricorn::default();
    let reads = Reads {
        pools: vec![SEED_USDC, SEED_AUSD],
        tokens: vec![Some((tok("USDC"), tok("WMON"))), Some((tok("AUSD"), tok("WMON")))],
        fees: vec![Some(50.0), Some(50.0)],
    };
    let admitted = v.apply(reg(), &reads).unwrap();
    // Undiscovered quotability: nothing asked.
    assert_eq!(quote_with(&stub, &v, &Mid, &[100.0]).await.unwrap(), []);
    // The probes fail: the catalog stays, nothing is quoted.
    v.set_quotable(&admitted, &[Some(false), Some(false)], &[None, None]);
    assert_eq!(quote_with(&stub, &v, &Mid, &[100.0]).await.unwrap(), []);
    assert!(stub.seen().is_empty());
    assert_eq!(v.markets(), ["MON/AUSD", "MON/USDC"]);
    // One paused, one quoting: the quoting one recovers its rows.
    v.set_quotable(&admitted, &[Some(true), Some(false)], &[Some(U256::from(1u8)), Some(U256::from(1u8))]);
    let rows = quote_with(&stub, &v, &Mid, &[100.0]).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.market.as_str()).collect::<Vec<_>>(), ["MON/AUSD"]);
}

#[tokio::test]
async fn an_unpriced_market_asks_nothing_and_an_unsized_sell_is_not_sent() {
    struct NoMid;
    impl Pricer for NoMid {
        fn usd_per_token(&self, key: &str) -> f64 {
            Mid.usd_per_token(key)
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, _: &str) -> f64 {
            0.0
        }
    }
    let stub = recorded().await;
    let v = discovered(&[SEED_USDC]);
    assert_eq!(quote_with(&stub, &v, &NoMid, &[100.0]).await.unwrap(), []);
    assert!(stub.seen().is_empty());

    /// The mid, but no USD to size the base with: only the buy is asked.
    struct NoBaseUsd;
    impl Pricer for NoBaseUsd {
        fn usd_per_token(&self, key: &str) -> f64 {
            if reg().tokens.get(key).is_some_and(|t| t.stable) {
                1.0
            } else {
                0.0
            }
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, _: &str) -> f64 {
            0.02
        }
    }
    let rows = quote_with(&stub, &v, &NoBaseUsd, &[100.0]).await.unwrap();
    assert_eq!(stub.seen().len(), 1);
    let row = mon_usdc(&rows);
    assert_eq!((row.one_sided, row.bid_px), (Some(true), 0.0));
    assert!(close(row.ask_px, 100.0 / 4_950.0, 12));
}
