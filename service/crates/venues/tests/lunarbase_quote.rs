//! Lunarbase quote() against a stub node, ported from the quoting cases of
//! server/src/venues/__tests__/lunarbase.decode.test.ts. The stub plays the
//! MON/USDC pool: its views (as discovery reads them), USDC's decimals, the
//! ERC-1967 slot and the two quoters, each call recorded. Prices expected
//! below are computed from the raw amounts the stub hands out.
//!
//! Today's cases about aborted siblings (QuoteRunner, AbortSignal) have no
//! counterpart: a frame is one batch, and a frame dropped at its deadline
//! never reaches the state it would change (checked below).

mod rpc_stub;

use std::{sync::Arc, time::Duration};

use alloy_primitives::{
    aliases::{U160, U24, U48},
    Address, U256,
};
use alloy_sol_types::SolCall;
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_types::QuoteRow;
use mpamm_venues::{
    lunarbase::*,
    util::{from_units, to_units},
};
use rpc_stub::{call_data, hex, pinned_to, Answer, Stub};
use serde_json::{json, Value};

const HASH: [u8; 32] = [0x1b; 32];
const BLOCK: u64 = 501;
const MID: f64 = 0.0224;
const IMPL_1: &str = "0x0000000000000000000000001111111111111111111111111111111111111111";
const ZERO_SLOT: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

fn config() -> PoolConfig {
    production_pools(Registry::get()).remove(0)
}

fn pool() -> Address {
    Address::from(config().pool)
}

fn usdc() -> Address {
    Address::from(Registry::get().tokens["USDC"].address_bytes())
}

/// What the pool's views answer.
#[derive(Clone)]
struct PoolState {
    paused: bool,
    whitelisted: bool,
    latest_update: u64,
    slot: &'static str,
    /// Every view (and the slot) fails, as in an RPC brownout.
    reads_fail: bool,
}

impl Default for PoolState {
    fn default() -> Self {
        Self { paused: false, whitelisted: true, latest_update: BLOCK, slot: IMPL_1, reads_fail: false }
    }
}

type Legs = Arc<dyn Fn(bool, U256) -> Answer + Send + std::marker::Sync>;

fn quoted(amount_out: U256, fee: U256) -> Answer {
    let r = quoteXToYReturn { amountOut: amount_out, sqrtPriceNext: U160::from(1u8), fee };
    Ok(hex(&quoteXToYCall::abi_encode_returns(&r)))
}

/// Sells at 0.0223 USDC per MON with 10 bps of the output as fee; buys at
/// 0.0225 with 20 bps: bid −44.6 bps and ask +44.6 bps around 0.0224.
fn market_legs() -> Legs {
    Arc::new(|x_to_y, amount_in| {
        if x_to_y {
            let out = amount_in * U256::from(223u32) / U256::from(10u64).pow(U256::from(16u8));
            quoted(out, out / U256::from(1000u32))
        } else {
            let out = amount_in * U256::from(10u64).pow(U256::from(16u8)) / U256::from(225u32);
            quoted(out, out / U256::from(500u32))
        }
    })
}

fn boom() -> Answer {
    Err(json!({ "code": -32000, "message": "state unavailable" }))
}

async fn node(state: PoolState, legs: Legs) -> Stub {
    Stub::start(move |method, params| {
        let refuse = |why: String| Err(json!({ "code": -32601, "message": why }));
        if method == "eth_getStorageAt" {
            return if state.reads_fail { boom() } else { Ok(json!(state.slot)) };
        }
        if method != "eth_call" {
            return refuse(format!("unexpected {method}"));
        }
        let to: Address = params[0]["to"].as_str().unwrap().parse().unwrap();
        let data = call_data(params);
        let sel: [u8; 4] = data[..4].try_into().unwrap();
        if to == usdc() && sel == decimalsCall::SELECTOR {
            return Ok(hex(&decimalsCall::abi_encode_returns(&6u8)));
        }
        if to != pool() {
            return refuse(format!("unexpected call to {to}"));
        }
        if sel == quoteXToYCall::SELECTOR {
            return legs(true, quoteXToYCall::abi_decode(&data).unwrap().amountIn);
        }
        if sel == quoteYToXCall::SELECTOR {
            return legs(false, quoteYToXCall::abi_decode(&data).unwrap().amountIn);
        }
        if state.reads_fail {
            return boom();
        }
        let c = config();
        Ok(hex(&match sel {
            s if s == XCall::SELECTOR => XCall::abi_encode_returns(&Address::from(c.expected_x)),
            s if s == YCall::SELECTOR => YCall::abi_encode_returns(&Address::from(c.expected_y)),
            s if s == stateCall::SELECTOR => stateCall::abi_encode_returns(&stateReturn {
                anchorPrice: U160::from(1u64 << 40),
                feeAskX24: U24::from(100u32),
                feeBidX24: U24::from(100u32),
                latestUpdateBlock: U48::from(state.latest_update),
            }),
            s if s == getXReserveCall::SELECTOR => {
                getXReserveCall::abi_encode_returns(&alloy_primitives::Uint::from(1u64 << 60))
            }
            s if s == getYReserveCall::SELECTOR => {
                getYReserveCall::abi_encode_returns(&alloy_primitives::Uint::from(1u64 << 30))
            }
            s if s == concentrationKCall::SELECTOR => concentrationKCall::abi_encode_returns(&1u32),
            s if s == blockDelayCall::SELECTOR => blockDelayCall::abi_encode_returns(&U48::from(10u32)),
            s if s == pausedCall::SELECTOR => pausedCall::abi_encode_returns(&state.paused),
            s if s == blacklistFeeMultiplierCall::SELECTOR => {
                blacklistFeeMultiplierCall::abi_encode_returns(&U256::from(1u8))
            }
            s if s == isWhitelistedCall::SELECTOR => isWhitelistedCall::abi_encode_returns(&state.whitelisted),
            _ => return refuse("unknown selector".into()),
        }))
    })
    .await
}

/// MON is worth the mid, the stable $1; `mon` 0 leaves MON unpriced.
struct Prices {
    mon: f64,
}

impl Pricer for Prices {
    fn usd_per_token(&self, key: &str) -> f64 {
        match key {
            "USDC" => 1.0,
            "MON" | "WMON" => self.mon,
            _ => 0.0,
        }
    }
    fn usd_for_token(&self, _: &str, amount: f64) -> f64 {
        amount
    }
    fn pair_mid(&self, market: &str) -> f64 {
        if market == "MON/USDC" {
            MID
        } else {
            0.0
        }
    }
}

const PRICED: Prices = Prices { mon: MID };

/// A venue whose discovery admitted the pool with `slot` at block 500.
fn admitted(slot: &str) -> Lunarbase {
    let v = Lunarbase::default();
    let c = config();
    let reads = PoolReads {
        x: Some(c.expected_x),
        y: Some(c.expected_y),
        state: Some((U256::from(1u64 << 40), 100, 100, 500)),
        reserve_x: Some(U256::from(1u64 << 60)),
        reserve_y: Some(U256::from(1u64 << 30)),
        concentration_k: Some(1),
        block_delay: Some(10),
        paused: Some(false),
        blacklist_fee_multiplier: Some(U256::from(1u8)),
        whitelist_probe: Some(true),
        x_decimals: None,
        y_decimals: Some(c.stable_dec),
        implementation_slot: Some(slot.parse::<alloy_primitives::B256>().unwrap().0),
    };
    let validation = validate(Registry::get(), &c, &reads, 500);
    v.apply_discovery(500, vec![(c, validation)]);
    v
}

fn block() -> BlockRef {
    BlockRef { number: BLOCK, id: [0; 32], hash: HASH }
}

async fn quote_with(
    stub: &Stub,
    v: &Lunarbase,
    pricer: &dyn Pricer,
    sizes: &[f64],
) -> Result<Vec<QuoteRow>, VenueError> {
    let rpc = stub.rpc();
    v.quote(&QuoteCx { rpc: &rpc, registry: Registry::get(), pricer, block: block() }, sizes).await
}

async fn quote(stub: &Stub, v: &Lunarbase) -> Result<Vec<QuoteRow>, VenueError> {
    quote_with(stub, v, &PRICED, &[100.0, 1000.0]).await
}

fn tailed(v: &Lunarbase) -> Vec<[u8; 20]> {
    v.watch().unwrap().logs.keys().copied().collect()
}

fn inactive() -> String {
    format!("inactive:{MON_POOL_STR}")
}

#[test]
fn maps_mon_directions_to_the_pool_quoter() {
    assert!(quote_x_to_y(&config(), true), "selling MON is X→Y");
    assert!(!quote_x_to_y(&config(), false), "buying MON is Y→X");
}

/// Today's leg arithmetic on its own fixture (0-decimal tokens): 100 in, 90
/// out, a fee of 10 → 0.9, and 10 / (90 + 10) = 1000 bps.
#[test]
fn prices_a_leg_and_its_fee_over_the_gross_output() {
    let c = PoolConfig { base_dec: 0, stable_dec: 0, ..config() };
    let u = |n: u64| U256::from(n);
    assert_eq!(leg_quote(&c, true, u(100), u(90), u(10)), Some((0.9, 1000.0)));
    assert_eq!(leg_quote(&c, false, u(100), u(90), u(10)), Some((100.0 / 90.0, 1000.0)));
    assert_eq!(leg_quote(&c, true, u(100), U256::ZERO, u(10)), None, "nothing out");
    assert_eq!(leg_quote(&c, true, U256::ZERO, u(90), u(10)), None, "nothing in");
}

/// Every read of the frame in ONE batch pinned to the block hash with the
/// explicit gas: the pool's validation reads, the slot, then the legs, each
/// leg from the whitelisted route (address(0)), selling via quoteXToY and
/// buying via quoteYToX, sized from the pricer.
#[tokio::test]
async fn asks_the_gate_and_every_leg_in_one_batch_pinned_to_the_hash() {
    let stub = node(PoolState::default(), market_legs()).await;
    assert_eq!(quote(&stub, &admitted(IMPL_1)).await.unwrap().len(), 2);
    let seen = stub.seen();
    assert!(seen.iter().all(|s| s.request == seen[0].request), "one round trip");
    assert!(seen.iter().all(|s| s.params[s.params.as_array().unwrap().len() - 1] == pinned_to(HASH)));
    let calls: Vec<_> = seen.iter().filter(|s| s.method == "eth_call").collect();
    assert!(calls.iter().all(|s| s.params[0]["gas"] == json!("0x7a1200")));
    assert_eq!(seen.iter().filter(|s| s.method == "eth_getStorageAt").count(), 1);
    // 10 pool views + USDC's decimals (X is native MON), then 2 legs per size.
    assert_eq!(calls.len(), 11 + 4);
    let legs: Vec<(bool, U256, &Value)> = calls
        .iter()
        .filter_map(|s| {
            let d = s.data();
            let from = &s.params[0]["from"];
            if d[..4] == quoteXToYCall::SELECTOR {
                Some((true, quoteXToYCall::abi_decode(&d).unwrap().amountIn, from))
            } else if d[..4] == quoteYToXCall::SELECTOR {
                Some((false, quoteYToXCall::abi_decode(&d).unwrap().amountIn, from))
            } else {
                assert!(from.is_null(), "views carry no sender");
                None
            }
        })
        .collect();
    let zero = json!("0x0000000000000000000000000000000000000000");
    assert_eq!(
        legs,
        [
            (true, to_units(100.0 / MID, 18), &zero),
            (false, U256::from(100_000_000u64), &zero),
            (true, to_units(1000.0 / MID, 18), &zero),
            (false, U256::from(1_000_000_000u64), &zero),
        ]
    );
}

#[tokio::test]
async fn quotes_two_sided_rows_from_the_pool_quoters() {
    let stub = node(PoolState::default(), market_legs()).await;
    let rows = quote(&stub, &admitted(IMPL_1)).await.unwrap();
    let e18 = U256::from(10u64).pow(U256::from(16u8));
    for (r, size) in rows.iter().zip([100.0, 1000.0]) {
        let sell_in = to_units(size / MID, 18);
        let sell_out = sell_in * U256::from(223u32) / e18;
        let buy_in = to_units(size, 6);
        let buy_out = buy_in * e18 / U256::from(225u32);
        let bid_px = from_units(sell_out, 6) / from_units(sell_in, 18);
        let ask_px = from_units(buy_in, 6) / from_units(buy_out, 18);
        let (bid_bps, ask_bps) = ((bid_px / MID - 1.0) * 1e4, (ask_px / MID - 1.0) * 1e4);
        assert_eq!((r.venue_id.as_str(), r.market.as_str(), r.size_usd), ("lunarbase", "MON/USDC", size));
        assert_eq!((r.bid_px, r.ask_px, r.bid_bps, r.ask_bps), (bid_px, ask_px, bid_bps, ask_bps));
        assert_eq!(r.spread_bps, ask_bps - bid_bps);
        assert!((r.bid_bps + 44.64).abs() < 0.01 && (r.ask_bps - 44.64).abs() < 0.01, "{r:?}");
        // The larger of the two legs' fees: 20 bps of the gross out, to 1e-5 bp.
        let gross = buy_out + buy_out / U256::from(500u32);
        let fee = (buy_out / U256::from(500u32) * U256::from(1_000_000_000u64) / gross).to::<u64>() as f64 / 100_000.0;
        assert_eq!(r.fee_bps, fee);
        assert!((r.fee_bps - 19.96).abs() < 0.01);
        // Exact-input quoters: `oneSided` is availability, never a partial.
        assert_eq!((r.filled_full, r.one_sided), (true, Some(false)));
    }
}

/// A curve can price an exact input against a nearly drained reserve: a
/// side beyond ±2000 bps is dropped and the other kept, one-sided. The fee
/// is still the larger of both legs', as today.
#[tokio::test]
async fn a_side_beyond_the_band_leaves_a_one_sided_row() {
    let base = market_legs();
    let legs: Legs = Arc::new(move |x_to_y, amount| {
        if x_to_y {
            // 0.0150 USDC per MON: −3304 bps, with a 1% fee.
            let out = amount * U256::from(150u32) / U256::from(10u64).pow(U256::from(17u8));
            quoted(out, out / U256::from(99u32))
        } else {
            base(x_to_y, amount)
        }
    });
    let stub = node(PoolState::default(), legs).await;
    let rows = quote(&stub, &admitted(IMPL_1)).await.unwrap();
    assert_eq!(rows.len(), 2);
    for r in &rows {
        assert_eq!((r.bid_px, r.bid_bps, r.spread_bps), (0.0, 0.0, 0.0));
        assert!(r.ask_px > 0.0 && (r.ask_bps - 44.64).abs() < 0.01);
        assert_eq!((r.one_sided, r.filled_full), (Some(true), true));
        assert!((r.fee_bps - 100.0).abs() < 0.01, "the dropped bid's 1% fee: {}", r.fee_bps);
    }
}

/// Paused is the venue's own state, not a fault: no rows and no error, the
/// legs (asked in the same batch, answering zero as the paused pool does)
/// discarded, said once and the heal announced when it quotes again.
#[tokio::test]
async fn a_paused_pool_is_hidden_and_its_heal_announced() {
    let v = admitted(IMPL_1);
    let zero: Legs = Arc::new(|_, _| quoted(U256::ZERO, U256::ZERO));
    let paused = node(PoolState { paused: true, ..Default::default() }, zero).await;
    assert_eq!(quote(&paused, &v).await.unwrap(), []);
    assert_eq!(quote(&paused, &v).await.unwrap(), []);
    assert_eq!(v.raised(), [inactive()]);
    // A paused pool whose quoters still answer is hidden all the same.
    let answering = node(PoolState { paused: true, ..Default::default() }, market_legs()).await;
    assert_eq!(quote(&answering, &v).await.unwrap(), []);

    let live = node(PoolState::default(), market_legs()).await;
    assert_eq!(quote(&live, &v).await.unwrap().len(), 2);
    assert!(v.raised().is_empty());
}

/// The other gates: state older than blockDelay, and a read that says the
/// pool is invalid (the whitelist route closed, an empty implementation
/// slot) hide the quote. The frame never quarantines: the pool stays
/// watched and admitted until discovery re-validates it.
#[tokio::test]
async fn stale_state_and_an_invalid_read_hide_the_quote_without_touching_the_watch_set() {
    for state in [
        PoolState { latest_update: BLOCK - 10, ..Default::default() },
        PoolState { whitelisted: false, ..Default::default() },
        PoolState { slot: ZERO_SLOT, ..Default::default() },
    ] {
        let v = admitted(IMPL_1);
        let before = v.pool(&config().pool).unwrap();
        let stub = node(state, market_legs()).await;
        assert_eq!(quote(&stub, &v).await.unwrap(), []);
        assert_eq!(v.raised(), [inactive()]);
        assert_eq!(tailed(&v), [config().pool]);
        assert_eq!(v.pool(&config().pool).unwrap(), before, "the decode cache is the pipeline's");
        assert_eq!(v.markets(), ["MON/USDC"]);
    }
    // Fresh through the last block of the delay.
    let v = admitted(IMPL_1);
    let stub = node(PoolState { latest_update: BLOCK - 9, ..Default::default() }, market_legs()).await;
    assert_eq!(quote(&stub, &v).await.unwrap().len(), 2);
}

/// A FAILED read is not a misconfiguration (issue #61): the frame is the
/// venue's error, named, the pool stays tailed, and the warning is retracted
/// once it reads again.
#[tokio::test]
async fn an_unreadable_pool_is_the_venues_error_and_stays_tailed() {
    let v = admitted(IMPL_1);
    let down = node(PoolState { reads_fail: true, ..Default::default() }, market_legs()).await;
    let err = quote(&down, &v).await.unwrap_err();
    assert_eq!(
        err,
        VenueError::Chain(
            "Lunarbase quotes unavailable — MON/USDC state unreadable: rpc error -32000: state unavailable".into()
        )
    );
    assert_eq!(v.raised(), [format!("unread:{MON_POOL_STR}")]);
    assert_eq!(tailed(&v), [config().pool]);

    let up = node(PoolState::default(), market_legs()).await;
    assert_eq!(quote(&up, &v).await.unwrap().len(), 2);
    assert!(v.raised().is_empty());
}

#[tokio::test]
async fn every_leg_failing_on_a_live_pool_is_the_venues_error() {
    let reverted: Legs = Arc::new(|_, _| Err(json!({ "code": 3, "message": "execution reverted" })));
    let stub = node(PoolState::default(), reverted).await;
    let err = quote(&stub, &admitted(IMPL_1)).await.unwrap_err();
    assert_eq!(
        err,
        VenueError::Chain(
            "Lunarbase quotes unavailable — all 4 legs failed with \"quoteXToY(uint256): rpc error 3: execution reverted\" (venue disabled, or the ABI drifted from the contract)"
                .into()
        )
    );
    // One side failing is that side's problem: the other still quotes.
    let half: Legs = Arc::new(|x_to_y, amount| {
        if x_to_y {
            Err(json!({ "code": 3, "message": "execution reverted" }))
        } else {
            market_legs()(x_to_y, amount)
        }
    });
    let stub = node(PoolState::default(), half).await;
    let rows = quote(&stub, &admitted(IMPL_1)).await.unwrap();
    assert!(rows.iter().all(|r| r.one_sided == Some(true) && r.bid_px == 0.0 && r.ask_px > 0.0));
}

/// Nothing is asked before discovery, for a quarantined pool (its market is
/// still listed: admission history survives quarantine), or for a pool
/// without a reference mid. A side that cannot be sized is not asked.
#[tokio::test]
async fn asks_only_what_it_can_price() {
    let stub = node(PoolState::default(), market_legs()).await;
    assert_eq!(quote(&stub, &Lunarbase::default()).await.unwrap(), []);
    // Discovery found an empty implementation slot: quarantined, not quoted.
    let v = admitted(ZERO_SLOT);
    assert!(tailed(&v).is_empty());
    assert_eq!(quote(&stub, &v).await.unwrap(), []);
    // No reference mid: nothing to anchor a row on (the gate is still read).
    struct NoMid;
    impl Pricer for NoMid {
        fn usd_per_token(&self, key: &str) -> f64 {
            PRICED.usd_per_token(key)
        }
        fn usd_for_token(&self, _: &str, amount: f64) -> f64 {
            amount
        }
        fn pair_mid(&self, _: &str) -> f64 {
            0.0
        }
    }
    assert!(stub.seen().is_empty());
    assert_eq!(quote_with(&stub, &admitted(IMPL_1), &NoMid, &[100.0]).await.unwrap(), []);

    // No MON price: the sells cannot be sized, so only the buys are asked.
    let stub = node(PoolState::default(), market_legs()).await;
    let rows = quote_with(&stub, &admitted(IMPL_1), &Prices { mon: 0.0 }, &[100.0]).await.unwrap();
    let sells =
        stub.seen().iter().filter(|s| s.method == "eth_call" && s.data()[..4] == quoteXToYCall::SELECTOR).count();
    let buys =
        stub.seen().iter().filter(|s| s.method == "eth_call" && s.data()[..4] == quoteYToXCall::SELECTOR).count();
    assert_eq!((sells, buys), (0, 1));
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].one_sided, rows[0].bid_px), (Some(true), 0.0));
}

/// A frame dropped at its deadline changes nothing: the latch it would have
/// raised (paused) is not raised, the watch set is untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frame_dropped_at_its_deadline_changes_nothing() {
    let v = admitted(IMPL_1);
    let slow: Legs = Arc::new(|_, _| {
        std::thread::sleep(Duration::from_millis(60));
        quoted(U256::ZERO, U256::ZERO)
    });
    let stub = node(PoolState { paused: true, ..Default::default() }, slow).await;
    let late = tokio::time::timeout(Duration::from_millis(20), quote(&stub, &v)).await;
    assert!(late.is_err(), "dropped at the deadline");
    assert!(v.raised().is_empty());
    assert_eq!(tailed(&v), [config().pool]);
    // Completed, the same frame raises it.
    assert_eq!(quote(&stub, &v).await.unwrap(), []);
    assert_eq!(v.raised(), [inactive()]);
}
