//! Clober quote() against a stub node, ported from
//! server/src/venues/__tests__/clober.quote.test.ts. The recorded legs are
//! today's: the MON/USDC vault books at block 109,422,525 (2026-10-01), $100
//! each side, while the vault was dark (both sides swept far from the
//! 0.029085 mid). The stub answers getExpectedOutput by book id, and every
//! call it saw is checked: one batch, pinned to the block hash, explicit gas.
//!
//! Hand check of the recorded legs:
//!   sell 3438.197658764939368693 MON → 25.156797 USDC   0.0073168 → −7484 bps
//!   buy  99.999940 USDC → 501.6000599775 MON            0.1993620 → +58545 bps

mod rpc_stub;

use alloy_primitives::{address, Address, U256};
use alloy_sol_types::{Revert, SolCall, SolError};
use mpamm_core::{BlockRef, Pricer, QuoteCx, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_types::QuoteRow;
use mpamm_venues::{
    chain::At,
    clober::{BookViewer::getExpectedOutputCall, Clober, Pos, RawKey, Verdict, BOOK_VIEWER, MIN_PRICE},
    util::from_units,
};
use rpc_stub::{call_data, hex, pinned_to, Answer, Stub};
use serde_json::json;

const MID: f64 = 0.029085;
const HASH: [u8; 32] = [0xcb; 32];
const MON_SELL: &str = "5954885684956363054050231031211743946744177791604395877538";
const MON_BUY: &str = "3875727077379471850923186002296331935053867847116966170720";
const ETH_SELL: &str = "680091963353999958661303284433884846705699901928885914311";
const ETH_BUY: &str = "6215929461771924482215683498685754109371513948112281158916";
const BTC_SELL: &str = "11";
const BTC_BUY: &str = "12";
const USDC: Address = address!("754704bc059f8c67012fed69bc8a327a5aafb603");
const WETH: Address = address!("ee8c0e9f1bffb4eb878d8f15f368a02a35481242");
const WBTC: Address = address!("0555e30da8f98308edb960aa94c0db47230d2b9c");

fn id(s: &str) -> U256 {
    s.parse().unwrap()
}

fn key(base: Address, quote: Address, unit_size: u64) -> RawKey {
    RawKey { base: base.into_array(), quote: quote.into_array(), unit_size }
}

/// The vault's books as BookManager.getBookKey states them; `btc` adds a
/// BTC/USDC pair of books.
fn vault(btc: bool) -> Clober {
    let at = Pos { block: 37_886_929, log_index: 8 };
    let mut books = vec![
        (id(MON_SELL), key(Address::ZERO, USDC, 1), at),
        (id(MON_BUY), key(USDC, Address::ZERO, 1_000_000_000_000), at),
    ];
    if btc {
        books.push((id(BTC_SELL), key(WBTC, USDC, 1), at));
        books.push((id(BTC_BUY), key(USDC, WBTC, 1), at));
    }
    Clober::with_books(Registry::get(), &books)
}

/// Both pairs the vault runs today.
fn vault_mon_eth() -> Clober {
    let (mon, eth) = (Pos { block: 37_886_929, log_index: 8 }, Pos { block: 37_278_311, log_index: 2 });
    Clober::with_books(
        Registry::get(),
        &[
            (id(MON_SELL), key(Address::ZERO, USDC, 1), mon),
            (id(MON_BUY), key(USDC, Address::ZERO, 1_000_000_000_000), mon),
            (id(ETH_SELL), key(WETH, USDC, 1), eth),
            (id(ETH_BUY), key(USDC, WETH, 1_000_000_000_000), eth),
        ],
    )
}

/// WMON is worth the mid and the stable $1, as the TypeScript test sizes
/// legs (`usd / MID`); a market not in `mids` has a cold reference.
struct Mids(Vec<(&'static str, f64)>);

impl Mids {
    fn mon() -> Self {
        Mids(vec![("MON/USDC", MID)])
    }
}

impl Pricer for Mids {
    fn usd_per_token(&self, key: &str) -> f64 {
        match key {
            "USDC" => 1.0,
            "WMON" => MID,
            "WETH" => 3000.0,
            "WBTC" => 90_000.0,
            _ => 0.0,
        }
    }
    fn usd_for_token(&self, _: &str, amount: f64) -> f64 {
        amount
    }
    fn pair_mid(&self, market: &str) -> f64 {
        self.0.iter().find(|(m, _)| *m == market).map_or(0.0, |(_, px)| *px)
    }
}

fn answer(taken: u128, spent: u128) -> Answer {
    Ok(hex(&getExpectedOutputCall::abi_encode_returns(&BookViewer_return(taken, spent))))
}

#[allow(non_snake_case)]
fn BookViewer_return(taken: u128, spent: u128) -> mpamm_venues::clober::BookViewer::getExpectedOutputReturn {
    mpamm_venues::clober::BookViewer::getExpectedOutputReturn {
        takenQuoteAmount: U256::from(taken),
        spentBaseAmount: U256::from(spent),
    }
}

/// [takenQuote, spentBase] per book, as getExpectedOutput returned it.
fn recorded(book: &str) -> Answer {
    match book {
        MON_SELL => answer(25_156_797, 3_438_197_658_764_939_368_693),
        MON_BUY => answer(501_600_059_977_500_000_000, 99_999_940),
        _ => Err(json!({ "code": -32000, "message": format!("unrecorded book {book}") })),
    }
}

fn book_not_open() -> Answer {
    let data = Revert::from("book not open").abi_encode();
    Err(json!({ "code": 3, "message": "execution reverted", "data": hex(&data) }))
}

/// A node answering each getExpectedOutput leg through `leg(book id, call)`.
async fn node(leg: impl Fn(&str, &getExpectedOutputCall) -> Answer + Send + Sync + 'static) -> Stub {
    Stub::start(move |method, params| {
        if method != "eth_call" {
            return Err(json!({ "code": -32000, "message": format!("unexpected {method}") }));
        }
        let c = getExpectedOutputCall::abi_decode(&call_data(params)).expect("a getExpectedOutput call");
        leg(&c.params.id.to_string(), &c)
    })
    .await
}

fn block() -> BlockRef {
    BlockRef { number: 109_422_525, id: [0; 32], hash: HASH }
}

async fn frame(stub: &Stub, v: &Clober, pricer: &dyn Pricer, sizes: &[f64]) -> (Vec<QuoteRow>, Verdict) {
    let rpc = stub.rpc();
    v.quote_frame(&rpc, Registry::get(), pricer, At::Hash(HASH), sizes).await.unwrap()
}

async fn quote(stub: &Stub, v: &Clober, pricer: &dyn Pricer, sizes: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
    let rpc = stub.rpc();
    v.quote(&QuoteCx { rpc: &rpc, registry: Registry::get(), pricer, block: block() }, sizes).await
}

fn dark(v: Verdict) -> (String, String) {
    match v {
        Verdict::Dark { reason, msg } => (reason, msg),
        other => panic!("expected a dark verdict, got {other:?}"),
    }
}

/// The leg's failure as the venue names it: the call, then the node's error.
fn leg_failure(why: &str) -> String {
    format!("{}: {why}", getExpectedOutputCall::SIGNATURE)
}

#[tokio::test]
async fn explains_the_recorded_dark_vault_every_leg_answered_none_executable() {
    let stub = node(|book, _| recorded(book)).await;
    let (rows, verdict) = frame(&stub, &vault(false), &Mids::mon(), &[100.0]).await;
    assert_eq!(rows, []);
    let (reason, msg) = dark(verdict);
    assert_eq!(reason, "no vault book side fills $100 within ±2000 bps of mid");
    // sell: 25.156797 / 3438.19766 = 0.0073168 USDC/MON → −7484 bps (buy is +58545)
    assert!(msg.contains("(nearest: MON/USDC sell at −7484 bps"), "{msg}");
    assert!(msg.contains("not an adapter fault"), "{msg}");
    // Today's message for these legs, word for word (the sell stops 7.25e14
    // wei short of the request, more than two units of rounding: partial).
    assert_eq!(
        msg,
        "Clober quotes unavailable — no vault book side fills $100 within ±2000 bps of mid (nearest: MON/USDC sell at −7484 bps, ~$100.00 of $100 filled): the vault's books are empty or priced away from mid, not an adapter fault"
    );
}

#[tokio::test]
async fn reports_a_thin_side_by_what_it_actually_filled() {
    // BTC-book shape seen the same day: the book stops after ~$1 of input.
    let stub =
        node(|book, _| if book == MON_SELL { answer(29_000, 1_000_000_000_000_000_000) } else { answer(0, 0) }).await;
    let (_, msg) = dark(frame(&stub, &vault(false), &Mids::mon(), &[100.0]).await.1);
    assert!(msg.contains("(nearest: MON/USDC sell at −29 bps, ~$0.03 of $100 filled)"), "{msg}");
}

#[tokio::test]
async fn reports_the_most_executable_side_not_a_dust_leg_that_happens_to_sit_at_mid() {
    // Live 2026-10-01: an ETH book's sell leg spent 3831 wei at +224 bps.
    // Here the dust sell sits at +112 bps (1 raw USDC for 3.4e-5 MON), far
    // closer to mid than the buy, so a bps-only ranking would pick it.
    let stub = node(|book, _| if book == MON_SELL { answer(1, 34_000_000_000_000) } else { recorded(book) }).await;
    let (_, msg) = dark(frame(&stub, &vault(false), &Mids::mon(), &[100.0]).await.1);
    assert!(msg.contains("(nearest: MON/USDC buy at +58545 bps, ~$100.00 of $100 filled)"), "{msg}");
}

#[tokio::test]
async fn does_not_call_it_a_depth_outage_when_some_book_calls_failed() {
    let stub = node(|book, _| if book == MON_SELL { book_not_open() } else { recorded(book) }).await;
    let (reason, msg) = dark(frame(&stub, &vault(false), &Mids::mon(), &[100.0]).await.1);
    let why = leg_failure("rpc error 3: execution reverted (reverted: book not open)");
    assert_eq!(reason, format!("some book calls failed with \"{why}\""));
    assert!(
        msg.contains(&format!(
            "1 of 2 book calls failed with \"{why}\", and no answered side fills $100 within ±2000 bps of mid"
        )),
        "{msg}"
    );
    assert!(!msg.contains("not an adapter fault"), "{msg}");
}

#[tokio::test]
async fn names_a_market_it_could_not_price_instead_of_withholding_the_verdict() {
    // A cold reference leaves a market with no legs, so it cannot quote this
    // frame either way. The warm books still explain the outage.
    let stub = node(|book, _| recorded(book)).await;
    let (rows, verdict) = frame(&stub, &vault(true), &Mids::mon(), &[100.0]).await;
    assert_eq!(rows, []);
    let (reason, msg) = dark(verdict);
    assert_eq!(reason, "no vault book side fills $100 within ±2000 bps of mid");
    assert!(msg.contains("; not priced, reference cold: BTC/USDC)"), "{msg}");
    // The BTC books were never asked.
    assert_eq!(stub.seen().len(), 2);
}

#[tokio::test]
async fn clears_once_a_side_is_executable_again() {
    let v = vault(false);
    let dark_vault = node(|book, _| recorded(book)).await;
    assert_eq!(quote(&dark_vault, &v, &Mids::mon(), &[100.0]).await.unwrap(), []);
    assert_eq!(v.outage_on_record().as_deref(), Some("no vault book side fills $100 within ±2000 bps of mid"));

    let healthy = node(|book, _| {
        if book == MON_SELL {
            answer(99_800_000, 3_438_198_384_046_759_497_000) // 3438.198 MON → $99.80, −20 bps
        } else {
            answer(0, 0)
        }
    })
    .await;
    let rows = quote(&healthy, &v, &Mids::mon(), &[100.0]).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].one_sided, Some(true));
    assert_eq!(v.outage_on_record(), None);
}

#[tokio::test]
async fn names_the_shared_revert_when_every_leg_fails_as_the_venue_error() {
    let v = vault(false);
    let stub = node(|_, _| book_not_open()).await;
    let err = quote(&stub, &v, &Mids::mon(), &[100.0]).await.unwrap_err();
    let why = leg_failure("rpc error 3: execution reverted (reverted: book not open)");
    assert_eq!(
        err,
        VenueError::Chain(format!(
            "Clober quotes unavailable — all 2 legs failed with \"{why}\" (venue disabled, or the ABI drifted from the contract)"
        ))
    );
    // The error is the record: the dark-vault latch is not moved by it.
    assert_eq!(v.outage_on_record(), None);
}

#[tokio::test]
async fn gives_no_verdict_and_asks_nothing_when_nothing_could_be_priced() {
    let stub = node(|book, _| recorded(book)).await;
    let (rows, verdict) = frame(&stub, &vault(false), &Mids(vec![]), &[100.0]).await;
    assert_eq!(rows, []);
    assert_eq!(verdict, Verdict::Unknown);
    assert!(stub.seen().is_empty());
    // And without discovered books, nothing either.
    let (rows, verdict) = frame(&stub, &Clober::default(), &Mids::mon(), &[100.0]).await;
    assert_eq!((rows, verdict), (vec![], Verdict::Unknown));
    assert!(stub.seen().is_empty());
}

/// Every leg is one eth_call to the BookViewer in ONE batch, pinned to the
/// block hash with explicit gas, limit at the lowest price, sized from the
/// pricer: registry pair order (MON/USDC before ETH/USDC), then size, sell
/// before buy.
#[tokio::test]
async fn asks_every_leg_in_one_batch_pinned_to_the_hash_with_explicit_gas() {
    let stub = node(|book, _| recorded(book).or_else(|_| answer(0, 0))).await;
    let pricer = Mids(vec![("MON/USDC", MID), ("ETH/USDC", 3000.0)]);
    let _ = quote(&stub, &vault_mon_eth(), &pricer, &[100.0, 1000.0]).await.unwrap();
    let seen = stub.seen();
    assert_eq!(seen.len(), 8);
    assert!(seen.iter().all(|s| s.request == seen[0].request), "one round trip");
    assert!(seen.iter().all(|s| s.method == "eth_call"));
    assert!(seen.iter().all(|s| s.params[1] == pinned_to(HASH)));
    assert!(seen.iter().all(|s| s.params[0]["gas"] == json!("0x7a1200")));
    assert!(seen.iter().all(|s| s.params[0]["to"].as_str().unwrap().parse::<Address>().unwrap() == BOOK_VIEWER));
    let asked: Vec<(String, U256)> = seen
        .iter()
        .map(|s| {
            let c = getExpectedOutputCall::abi_decode(&s.data()).unwrap();
            assert_eq!(c.params.limitPrice, U256::from(MIN_PRICE));
            assert_eq!(c.params.minQuoteAmount, U256::ZERO);
            assert!(c.params.hookData.is_empty());
            (c.params.id.to_string(), c.params.baseAmount)
        })
        .collect();
    let u = |s: &str| s.parse::<U256>().unwrap();
    assert_eq!(
        asked,
        [
            // $100 of MON at 0.029085, as toFixed(18) writes it; $100 of USDC.
            (MON_SELL.to_string(), u("3438198384046759656485")),
            (MON_BUY.to_string(), u("100000000")),
            (MON_SELL.to_string(), u("34381983840467597474344")),
            (MON_BUY.to_string(), u("1000000000")),
            // $100 of WETH at 3000.
            (ETH_SELL.to_string(), u("33333333333333333")),
            (ETH_BUY.to_string(), u("100000000")),
            (ETH_SELL.to_string(), u("333333333333333315")),
            (ETH_BUY.to_string(), u("1000000000")),
        ]
    );
}

/// Both sides full and in band: a two-sided row priced over the filled
/// amounts (stable per base), flagged `oneSided: false` as today's is. A side
/// filled in full but outside the band is zeroed, leaving a one-sided row;
/// rows come in registry pair order, then size.
#[tokio::test]
async fn prices_two_sided_and_one_sided_rows_from_the_raw_amounts() {
    const ASK_TAKEN: u128 = 3_436_426_116_838_487_972_508; // MON for $100: ask 0.0291
    let stub = node(|book, c| {
        let spent = c.params.baseAmount.to::<u128>();
        match book {
            // $100: sell at −20 bps; $1000: sell at −2500 bps (out of band).
            MON_SELL if spent < 10u128.pow(22) => answer(99_800_000, spent),
            MON_SELL => answer(750_000_000, spent),
            MON_BUY if spent == 100_000_000 => answer(ASK_TAKEN, spent),
            MON_BUY => answer(ASK_TAKEN * 10, spent),
            // ETH: the sell book is all but empty, the buy book answers nothing.
            ETH_SELL => answer(9, 3_650_023_120),
            _ => answer(0, 0),
        }
    })
    .await;
    let pricer = Mids(vec![("MON/USDC", MID), ("ETH/USDC", 3000.0)]);
    let rows = quote(&stub, &vault_mon_eth(), &pricer, &[100.0, 1000.0]).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| (r.market.as_str(), r.size_usd)).collect::<Vec<_>>(),
        [("MON/USDC", 100.0), ("MON/USDC", 1000.0)]
    );

    let sell_in = from_units("3438198384046759656485".parse().unwrap(), 18);
    let bid_px = 99.8 / sell_in;
    let ask_px = 100.0 / from_units(U256::from(ASK_TAKEN), 18);
    let r = &rows[0];
    assert_eq!((r.venue_id.as_str(), r.bid_px, r.ask_px), ("clober-vault", bid_px, ask_px));
    assert_eq!((r.bid_bps, r.ask_bps), ((bid_px / MID - 1.0) * 1e4, (ask_px / MID - 1.0) * 1e4));
    assert_eq!(r.spread_bps, r.ask_bps - r.bid_bps);
    assert_eq!((r.one_sided, r.filled_full, r.fee_bps), (Some(false), true, 0.0));
    assert!((r.bid_bps + 20.0).abs() < 0.1 && (r.ask_bps - 5.2).abs() < 0.1);

    // $1000: the bid sits 2500 bps under mid, so only the ask stands.
    let r = &rows[1];
    assert_eq!((r.bid_px, r.bid_bps, r.spread_bps), (0.0, 0.0, 0.0));
    assert_eq!(r.ask_px, 1000.0 / from_units(U256::from(ASK_TAKEN * 10), 18));
    assert_eq!((r.one_sided, r.filled_full), (Some(true), true));
}

/// A side that stops short of the size is not executable at it, however
/// close to mid: today's partial ETH sell (3.65e-9 ETH of 0.033) has no row.
#[tokio::test]
async fn a_partial_side_is_not_a_quote() {
    let stub = node(|book, c| {
        let spent = c.params.baseAmount.to::<u128>();
        match book {
            ETH_SELL => answer(99_000_000, spent / 2), // half filled, at mid
            MON_SELL => answer(99_800_000, spent),
            _ => answer(0, 0),
        }
    })
    .await;
    let pricer = Mids(vec![("MON/USDC", MID), ("ETH/USDC", 3000.0)]);
    let rows = quote(&stub, &vault_mon_eth(), &pricer, &[100.0]).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.market.as_str()).collect::<Vec<_>>(), ["MON/USDC"]);
}
