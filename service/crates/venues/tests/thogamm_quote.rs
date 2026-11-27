//! ThogAMM quote(), ported from server/src/venues/__tests__/thogamm.quote.test.ts
//! through a loopback JSON-RPC node. The view REVERTS rather than answering
//! zero when the maker is off ("maker: paused", recorded live at block
//! 93,063,4xx) or holds none of the output token ("maker: balance"), so the
//! venue's disappearance carries no signal by itself: these lock down that
//! the error names the cause, that drained legs sit out and come back, the
//! units of the gold and xStock markets, the hash pin and the explicit gas.

mod rpc_stub;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_types::QuoteRow;
use mpamm_venues::thogamm::{
    self, makerQuoteExactInputCall, makerQuoteExactInputReturn, Thogamm, DRAINED_REPROBE_BLOCKS, PROXY,
};
use rpc_stub::{call_data, hex, pinned_to, reverted, Answer, Stub};
use serde_json::{json, Value};

const XSTOCK: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/thogamm-xstock-quote.json");
const BLOCK: u64 = 93_063_374;

/// The token list ThogAMM held when the TypeScript test was written.
const LIVE: [&str; 8] = ["USDC", "AUSD", "USDT0", "WMON", "WETH", "WBTC", "CBBTC", "XAUT0"];

fn reg() -> &'static Registry {
    Registry::get()
}

fn token(key: &str) -> Address {
    Address::from(reg().tokens[key].address_bytes())
}

fn venue(keys: &[&str]) -> Thogamm {
    let tokens: Vec<[u8; 20]> = keys.iter().map(|k| reg().tokens[*k].address_bytes()).collect();
    Thogamm::with_tokens(reg(), &tokens).unwrap()
}

/// Each block's stand-in hash.
fn hash_of(block: u64) -> [u8; 32] {
    let mut h = [0x7e; 32];
    h[24..].copy_from_slice(&block.to_be_bytes());
    h
}

/// An `Error(string)` revert, as the node returns its data.
fn error_string(text: &str) -> Answer {
    let mut data = vec![0x08, 0xc3, 0x79, 0xa0];
    let mut word = |n: usize| data.extend_from_slice(&U256::from(n).to_be_bytes::<32>());
    word(32);
    word(text.len());
    let mut body = text.as_bytes().to_vec();
    body.resize(text.len().div_ceil(32) * 32, 0);
    data.extend_from_slice(&body);
    reverted(hex(&data).as_str().unwrap())
}

fn answer(amount_out: U256, block: u64) -> Answer {
    let ret = makerQuoteExactInputReturn { amountOut: amount_out, lastPostedBlock: U256::from(block) };
    Ok(hex(&makerQuoteExactInputCall::abi_encode_returns(&ret)))
}

/// A node answering every leg with `f(leg)`; anything but a quote is refused.
async fn node(f: impl Fn(&makerQuoteExactInputCall) -> Answer + Send + Sync + 'static) -> Stub {
    Stub::start(move |method, params| {
        if method != "eth_call" || params[0]["to"].as_str().unwrap().parse::<Address>().unwrap() != PROXY {
            return Err(json!({ "code": -32000, "message": format!("unexpected {method}") }));
        }
        match makerQuoteExactInputCall::abi_decode(&call_data(params)) {
            Ok(c) => f(&c),
            Err(_) => Err(json!({ "code": -32000, "message": "not a makerQuoteExactInput" })),
        }
    })
    .await
}

/// The TypeScript stub's pricer: one mid and one USD price for everything.
struct Flat;

impl Pricer for Flat {
    fn usd_per_token(&self, _: &str) -> f64 {
        0.0207
    }
    fn usd_for_token(&self, _: &str, _: f64) -> f64 {
        0.0
    }
    fn pair_mid(&self, _: &str) -> f64 {
        0.0207
    }
}

async fn quote_at(
    stub: &Stub,
    v: &Thogamm,
    pricer: &dyn Pricer,
    sizes: &[f64],
    block: u64,
) -> Result<Vec<QuoteRow>, VenueError> {
    let rpc = stub.rpc();
    let cx = QuoteCx {
        rpc: &rpc,
        registry: reg(),
        pricer,
        block: BlockRef { number: block, id: [0; 32], hash: hash_of(block) },
    };
    v.quote(&cx, sizes).await
}

/// (legs, legs into XAUt0) per quote, in order: a quote's legs go in
/// several concurrent batches, all pinned to its block (each quote here pins
/// a different one).
fn rounds(stub: &Stub) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut last = None;
    for s in stub.seen() {
        let c = makerQuoteExactInputCall::abi_decode(&s.data()).unwrap();
        let pin = s.params[1].clone();
        if last.as_ref() != Some(&pin) {
            out.push((0, 0));
            last = Some(pin);
        }
        let r = out.last_mut().unwrap();
        r.0 += 1;
        r.1 += usize::from(c.tokenOut == token("XAUT0"));
    }
    out
}

#[tokio::test]
async fn pins_every_leg_to_the_block_hash_in_batches_without_a_head_read() {
    let stub = node(|_| answer(U256::from(1u8), BLOCK)).await;
    let rows = quote_at(&stub, &venue(&LIVE), &Flat, &[100.0], 123).await.unwrap();
    assert!(!rows.is_empty());
    let seen = stub.seen();
    assert!(seen.iter().all(|s| s.method == "eth_call"), "no head read of its own");
    let requests: std::collections::HashSet<_> = seen.iter().map(|s| s.request).collect();
    assert_eq!(
        requests.len(),
        seen.len().div_ceil(mpamm_venues::chain::BATCH),
        "batches of {}",
        mpamm_venues::chain::BATCH
    );
    assert!(seen.iter().all(|s| s.params[1] == pinned_to(hash_of(123))));
    // Every read carries the explicit gas limit (under the node's 8.1M heavy-call bar).
    assert!(seen.iter().all(|s| s.params[0]["gas"] == json!("0x7a1200")));
}

#[tokio::test]
async fn a_paused_maker_is_an_error_naming_the_cause_and_quotes_again_when_it_resumes() {
    let live = Arc::new(AtomicBool::new(false));
    let on = live.clone();
    let stub =
        node(
            move |_| {
                if on.load(Ordering::SeqCst) {
                    answer(U256::from(1u8), BLOCK)
                } else {
                    error_string("maker: paused")
                }
            },
        )
        .await;
    let v = venue(&LIVE);
    for _ in 0..3 {
        let err = quote_at(&stub, &v, &Flat, &[100.0], 123).await.unwrap_err();
        let VenueError::Chain(msg) = err else { panic!("{err:?}") };
        assert!(msg.starts_with("ThogAMM quotes unavailable — all "), "{msg}");
        assert!(msg.contains("reverted: maker: paused"), "{msg}");
        // The message must distinguish the two causes it could be: that is its job.
        assert!(msg.contains("venue disabled, or the ABI drifted"), "{msg}");
    }
    live.store(true, Ordering::SeqCst);
    assert!(!quote_at(&stub, &v, &Flat, &[100.0], 123).await.unwrap().is_empty());
}

/// Per-token USD. The stub's maker echoes the same ratio, so a correctly
/// sized leg lands at px == outUsd/inUsd EXACTLY: a decimals bug (XAUt0 is
/// 6, not 18) or a wrong pair-terms mid shows up as px off by 10^k or by the
/// quote asset's whole value, not as a subtle drift.
fn usd(key: &str) -> f64 {
    match key {
        "USDC" | "AUSD" | "USDT0" | "USD1" => 1.0,
        "WMON" => 0.0207,
        "WETH" => 3_500.0,
        "WBTC" | "CBBTC" => 118_000.0,
        "XAUT0" => 4_350.0,
        _ => 0.0,
    }
}

struct Priced;

impl Pricer for Priced {
    fn usd_per_token(&self, key: &str) -> f64 {
        usd(key)
    }
    fn usd_for_token(&self, _: &str, _: f64) -> f64 {
        0.0
    }
    fn pair_mid(&self, market: &str) -> f64 {
        let Some(p) = reg().pair_of(market) else { return 0.0 };
        let asset_usd = |k: &str| reg().assets.get(k).map_or(0.0, |a| usd(&a.token));
        let quote_usd = if p.is_asset_quoted() { asset_usd(&p.quote) } else { 1.0 };
        if quote_usd > 0.0 {
            asset_usd(&p.base) / quote_usd
        } else {
            0.0
        }
    }
}

fn pow10(d: u8) -> f64 {
    format!("1e{d}").parse().unwrap()
}

/// A maker quoting every pair at the USD ratio: px = usd(in) / usd(out).
async fn echo() -> Stub {
    node(|c| {
        let key = |a: Address| reg().token_by_address(&a.into_array()).unwrap();
        let ((kin, tin), (kout, tout)) = (key(c.tokenIn), key(c.tokenOut));
        let human_in = mpamm_venues::util::to_f64(c.amountIn) / pow10(tin.decimals);
        let human_out = human_in * (usd(kin) / usd(kout));
        answer(U256::from((human_out * pow10(tout.decimals)).round() as u128), BLOCK)
    })
    .await
}

fn row<'a>(rows: &'a [QuoteRow], market: &str) -> &'a QuoteRow {
    let found: Vec<&QuoteRow> = rows.iter().filter(|r| r.market == market).collect();
    assert_eq!(found.len(), 1, "{market}");
    found[0]
}

#[tokio::test]
async fn sizes_and_prices_the_gold_market_in_usdc_terms_at_6_decimal_precision() {
    let stub = echo().await;
    let rows = quote_at(&stub, &venue(&LIVE), &Priced, &[100.0], 123).await.unwrap();
    let r = row(&rows, "XAUt/USDC");
    // Tolerance = one 6-decimal tick of the small XAUt leg (0.0229885057… XAUt
    // rounds to 0.022989: ~2.2e-5 relative, ~0.2 bp).
    let rel = |x: f64| (x - 4_350.0).abs() / 4_350.0;
    assert!(rel(r.bid_px) < 5e-5 && rel(r.ask_px) < 5e-5, "{r:?}");
    assert!(r.bid_bps.abs() < 0.3 && r.ask_bps.abs() < 0.3, "{r:?}");
    // Today states a two-sided row explicitly.
    assert_eq!(r.one_sided, Some(false));
    assert_eq!((r.filled_full, r.fee_bps), (true, 0.0));
}

#[tokio::test]
async fn prices_a_crypto_quoted_gold_pair_in_the_quote_assets_own_terms() {
    let stub = echo().await;
    let rows = quote_at(&stub, &venue(&LIVE), &Priced, &[100.0], 123).await.unwrap();
    let r = row(&rows, "XAUt/MON");
    // 4350 USD/XAUt ÷ 0.0207 USD/MON: MON per XAUt, not a USD number.
    let want = 4_350.0 / 0.0207;
    let rel = |x: f64| (x - want).abs() / want;
    assert!(rel(r.bid_px) < 5e-5 && rel(r.ask_px) < 5e-5, "{r:?}");
}

#[tokio::test]
async fn rows_follow_the_registry_order_market_then_size() {
    let stub = echo().await;
    let v = venue(&LIVE);
    let rows = quote_at(&stub, &v, &Priced, &[100.0, 1_000.0], 123).await.unwrap();
    let listed: Vec<String> =
        reg().pairs.iter().map(|p| p.symbol.clone()).filter(|s| v.markets().contains(s)).collect();
    let want: Vec<(String, f64)> = listed.iter().flat_map(|m| [(m.clone(), 100.0), (m.clone(), 1_000.0)]).collect();
    let got: Vec<(String, f64)> = rows.iter().map(|r| (r.market.clone(), r.size_usd)).collect();
    assert_eq!(got, want);
    // Each market's legs: sell then buy, per size.
    let first: Vec<(Address, Address)> = stub.seen()[..4]
        .iter()
        .map(|s| {
            let c = makerQuoteExactInputCall::abi_decode(&s.data()).unwrap();
            (c.tokenIn, c.tokenOut)
        })
        .collect();
    let (wmon, usdc) = (token("WMON"), token("USDC"));
    assert_eq!(listed[0], "MON/USDC");
    assert_eq!(first, [(wmon, usdc), (usdc, wmon), (wmon, usdc), (usdc, wmon)]);
}

#[tokio::test]
async fn turns_the_recorded_1_spyx_to_770369227_raw_usdc_quote_into_770_369227() {
    let fx: Value = serde_json::from_str(XSTOCK).unwrap();
    let block: u64 = fx["blockNumber"].as_str().unwrap().parse().unwrap();
    let recorded: Vec<(Address, Address, U256, U256, u64)> = fx["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| {
            let a = |k: &str| q[k].as_str().unwrap().parse::<Address>().unwrap();
            let n = |k: &str| q[k].as_str().unwrap().parse::<U256>().unwrap();
            (a("tokenIn"), a("tokenOut"), n("amountIn"), n("amountOut"), n("lastPostedBlock").to::<u64>())
        })
        .collect();
    let stub = node(move |c| match recorded.iter().find(|r| (r.0, r.1, r.2) == (c.tokenIn, c.tokenOut, c.amountIn)) {
        Some(r) => answer(r.3, r.4),
        None => Err(json!({ "code": -32000, "message": "unrecorded test leg" })),
    })
    .await;
    struct Spyx;
    impl Pricer for Spyx {
        fn usd_per_token(&self, key: &str) -> f64 {
            if key == "SPYX" {
                770.0
            } else {
                1.0
            }
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, _: &str) -> f64 {
            770.0
        }
    }
    let mut keys = LIVE.to_vec();
    keys.push("SPYX");
    let rows = quote_at(&stub, &venue(&keys), &Spyx, &[770.0], block).await.unwrap();
    assert!(stub.seen().iter().all(|s| s.params[1] == pinned_to(hash_of(block))));
    let r = row(&rows, "SPYx/USDC");
    assert_eq!(r.bid_px, 770.369227);
    assert_eq!((r.ask_px, r.one_sided, r.fee_bps), (0.0, Some(true), 0.0));
    assert_eq!((r.ask_bps, r.spread_bps), (0.0, 0.0));
    assert!(thogamm::meta().quote_note.unwrap().contains("read-only quote"));
}

#[tokio::test]
async fn sits_out_maker_balance_legs_until_the_reprobe_block_then_quotes_them_again_once_refilled() {
    let drained = Arc::new(AtomicBool::new(true));
    let d = drained.clone();
    let xaut = token("XAUT0");
    let stub = node(move |c| {
        if c.tokenOut == xaut && d.load(Ordering::SeqCst) {
            error_string("maker: balance")
        } else {
            answer(U256::from(1u8), BLOCK)
        }
    })
    .await;
    let v = venue(&LIVE);
    let sizes = [100.0, 1_000.0];
    let b = BLOCK;
    quote_at(&stub, &v, &Flat, &sizes, b).await.unwrap();
    let (all, into_xaut) = rounds(&stub)[0];
    assert!(into_xaut > 0);
    quote_at(&stub, &v, &Flat, &sizes, b + 1).await.unwrap();
    quote_at(&stub, &v, &Flat, &sizes, b + DRAINED_REPROBE_BLOCKS - 1).await.unwrap();
    assert_eq!(rounds(&stub)[1..], [(all - into_xaut, 0), (all - into_xaut, 0)]);
    drained.store(false, Ordering::SeqCst);
    let rows = quote_at(&stub, &v, &Flat, &sizes, b + DRAINED_REPROBE_BLOCKS).await.unwrap();
    assert_eq!(rounds(&stub)[3].0, all);
    assert!(rows.iter().any(|r| r.market.starts_with("XAUt/") && r.ask_px > 0.0));
    quote_at(&stub, &v, &Flat, &sizes, b + DRAINED_REPROBE_BLOCKS + 1).await.unwrap();
    assert_eq!(rounds(&stub)[4].0, all);
}

#[tokio::test]
async fn keeps_probing_legs_that_fail_for_any_other_reason() {
    let xaut = token("XAUT0");
    let stub =
        node(move |c| if c.tokenOut == xaut { error_string("maker: paused") } else { answer(U256::from(1u8), BLOCK) })
            .await;
    let v = venue(&LIVE);
    quote_at(&stub, &v, &Flat, &[100.0], BLOCK).await.unwrap();
    quote_at(&stub, &v, &Flat, &[100.0], BLOCK + 1).await.unwrap();
    let r = rounds(&stub);
    assert_eq!(r[1], r[0]);
    // "maker: balanced" is not "maker: balance": the reason must match as a word.
    let stub = node(
        move |c| if c.tokenOut == xaut { error_string("maker: balanced") } else { answer(U256::from(1u8), BLOCK) },
    )
    .await;
    quote_at(&stub, &v, &Flat, &[100.0], BLOCK).await.unwrap();
    quote_at(&stub, &v, &Flat, &[100.0], BLOCK + 1).await.unwrap();
    let r = rounds(&stub);
    assert_eq!(r[1], r[0]);
}

#[tokio::test]
async fn an_unpriced_market_asks_nothing() {
    struct NoUsd;
    impl Pricer for NoUsd {
        fn usd_per_token(&self, _: &str) -> f64 {
            0.0
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, _: &str) -> f64 {
            0.0207
        }
    }
    struct NoMid;
    impl Pricer for NoMid {
        fn usd_per_token(&self, _: &str) -> f64 {
            0.0207
        }
        fn usd_for_token(&self, _: &str, _: f64) -> f64 {
            0.0
        }
        fn pair_mid(&self, _: &str) -> f64 {
            0.0
        }
    }
    let stub = node(|_| answer(U256::from(1u8), BLOCK)).await;
    let v = venue(&LIVE);
    assert_eq!(quote_at(&stub, &v, &NoUsd, &[100.0], BLOCK).await.unwrap(), []);
    assert_eq!(quote_at(&stub, &v, &NoMid, &[100.0], BLOCK).await.unwrap(), []);
    // Undiscovered: nothing to quote.
    assert_eq!(quote_at(&stub, &Thogamm::default(), &Flat, &[100.0], BLOCK).await.unwrap(), []);
    assert!(stub.seen().is_empty());
}
