//! Capricorn pAMM, ported from server/src/venues/__tests__/capricorn.decode.test.ts
//! and capricorn.gas.test.ts: the same real logs and fixture, the same
//! expected numbers. The quote-aggregation cases keep here what they assert
//! about discovery and the catalog; their quotes are in capricorn_quote.rs.

use alloy_primitives::{address, b256, Address, I256, U256};
use alloy_sol_types::SolEvent;
use mpamm_core::{DecodeCx, FinalBlock, FinalLog, FinalTxn, NoPrices, Origin, Venue, VenueError, VenueState};
use mpamm_registry::Registry;
use mpamm_ring::Addr;
use mpamm_types::{Fill, FillCategory, Side};
use mpamm_venues::{
    capricorn::{
        admit, Capricorn, Pool, PoolCreated, Reads, Reject, Swap, FACTORY, PUSH_FEED, PUSH_FEED_UPDATE_TOPIC,
        SEED_POOLS,
    },
    util::to_addr,
};
use serde_json::Value;

const FEED_PUSH: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/capricorn-feed-push.json");

fn reg() -> &'static Registry {
    Registry::get()
}

fn tok(key: &str) -> Addr {
    reg().tokens[key].address_bytes()
}

const SEED_USDC: Addr = address!("63093325c05cd32b18034d3ea29199fb7098e4df").0 .0;
const SEED_AUSD: Addr = address!("91c483fbe8feef4dad525781e6d65d2e668b3a47").0 .0;
/// A second MON/USDC pool, as a later PoolCreated would deliver it.
const NEW_USDC: Addr = address!("00000000000000000000000000000000000000aa").0 .0;

/// The admitted USDC/WMON pool, exactly as discovery builds it on chain.
fn pool() -> Pool {
    Pool {
        pool: SEED_USDC,
        market: "MON/USDC".into(),
        base_is_token0: false,
        base_token: "WMON".into(),
        base_dec: 18,
        base_addr: tok("WMON"),
        stable_sym: "USDC".into(),
        stable_dec: 6,
        stable_addr: tok("USDC"),
        fee_bps: 50.0,
    }
}

const TS: u64 = 1_787_157_656_000;

fn block(number: u64, logs: Vec<FinalLog>) -> FinalBlock {
    FinalBlock {
        number,
        hash: [1; 32],
        parent_hash: [0; 32],
        timestamp: TS / 1000,
        proposal_ns: None,
        base_fee: 0,
        txns: Vec::new(),
        logs,
        origin: Origin::Rpc("test".into()),
    }
}

fn log_at<E: SolEvent>(address: Addr, e: &E, tx_hash: [u8; 32], log_index: u32) -> FinalLog {
    let d = e.encode_log_data();
    FinalLog {
        log_index,
        txn_index: 0,
        tx_hash,
        address,
        topics: d.topics().iter().map(|t| t.0).collect(),
        data: d.data.to_vec(),
    }
}

fn i(v: i128) -> I256 {
    I256::try_from(v).unwrap()
}

fn decode_with(v: &Capricorn, state: &VenueState, b: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
    v.decode(&DecodeCx { registry: reg(), pricer: &NoPrices, state }, b)
}

fn decode(v: &Capricorn, b: &FinalBlock) -> Vec<Fill> {
    decode_with(v, &VenueState::default(), b).unwrap()
}

const BUY_TX: [u8; 32] = b256!("98f5609adb8bc67ad138e5951f9a4e58c020b60fb8668f69fc991ac02b07100f").0;
const SELL_TX: [u8; 32] = b256!("0aecc3fde34a0b1802608b3f1eb0717da4f12456206d0da26b21b437c64d257a").0;
const TAKER: Address = address!("ffaf66457deb4076ca5b4beafd4ef791663c2140");

/// Block 96,643,765, log 83, 2026-08-17: the pool received 163.862325 USDC
/// and paid out 8,121.006 WMON ⇒ the taker bought MON at 0.0201776.
fn buy() -> Swap {
    Swap {
        sender: TAKER,
        recipient: TAKER,
        amount0: i(163_862_325),
        amount1: i(-8_121_006_003_488_566_394_178),
        reserve0: U256::from(1_232_092_307u64),
        reserve1: U256::from(39_642_009_007_025_830_713_689u128),
    }
}

/// Block 97,390,883, log 74, 2026-08-19: the pool paid out 329.321994 USDC
/// and received 14,718.074 WMON ⇒ the taker sold MON at 0.0223753.
fn sell() -> Swap {
    Swap {
        sender: TAKER,
        recipient: TAKER,
        amount0: i(-329_321_994),
        amount1: i(14_718_074_205_856_226_608_005),
        reserve0: U256::from(715_967_554u64),
        reserve1: U256::from(62_372_409_809_966_363_178_656u128),
    }
}

fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

#[test]
fn decodes_a_real_buy() {
    let v = Capricorn::with_pools(vec![pool()]);
    let fills = decode(&v, &block(96_643_765, vec![log_at(SEED_USDC, &buy(), BUY_TX, 83)]));
    assert_eq!(fills.len(), 1);
    let f = &fills[0];
    // usd = |USDC leg| / 10^6; baseAmount = |WMON leg| / 10^18.
    assert!(close(f.usd, 163.862325, 6));
    assert!(close(f.base_amount, 8121.006003488566, 9));
    assert!(close(f.exec_px, 0.0201775894426884, 12));
    assert_eq!(f.usd, 163.862325);
    assert_eq!(f.exec_px, f.usd / f.base_amount);
    // The pool received the stable and paid out base ⇒ the taker bought.
    assert_eq!((f.side, f.market.as_str()), (Side::Buy, "MON/USDC"));
    assert_eq!(f.id, "capricorn-0x98f5609adb8bc67ad138e5951f9a4e58c020b60fb8668f69fc991ac02b07100f-83");
    assert_eq!((f.venue_id.as_str(), f.block_number, f.ts), ("capricorn", 96_643_765, TS as f64));
    assert_eq!(f.category, FillCategory::Unknown);
    assert_eq!(f.markouts_bps, vec![None; 5]);
    assert_eq!(f.pool, "cap 0x630933");
    // Checksummed, as viem decodes a real log.
    assert_eq!(f.to, "0xFFaF…2140");
    assert!(!f.px_approx && f.router.is_none());
}

#[test]
fn decodes_a_real_sell() {
    let v = Capricorn::with_pools(vec![pool()]);
    let f = &decode(&v, &block(97_390_883, vec![log_at(SEED_USDC, &sell(), SELL_TX, 74)]))[0];
    assert!(close(f.usd, 329.321994, 6));
    assert!(close(f.base_amount, 14718.074205856226, 9));
    assert!(close(f.exec_px, 0.022375345401436073, 12));
    // The pool gained base ⇒ the taker sold.
    assert_eq!(f.side, Side::Sell);
    // Oracle mid at that block = 1 / 44.3959 WMON per USDC: the fill landed
    // inside it by more than the 50 bps fee, and not absurdly far.
    let bps = (f.exec_px / (1.0 / 44.3959) - 1.0) * 1e4;
    assert!(bps < -50.0 && bps > -200.0, "{bps}");
}

#[test]
fn refuses_to_invent_fills() {
    let v = Capricorn::with_pools(vec![pool()]);
    // An unknown pool.
    assert!(decode(&v, &block(1, vec![log_at(NEW_USDC, &buy(), BUY_TX, 83)])).is_empty());
    // A zero leg.
    assert!(
        decode(&v, &block(1, vec![log_at(SEED_USDC, &Swap { amount1: I256::ZERO, ..buy() }, BUY_TX, 83)])).is_empty()
    );
    // Same-signed legs (a donation/skim shape).
    let same = Swap { amount1: i(8_121_006_003_488_566_394_178), ..buy() };
    assert!(decode(&v, &block(1, vec![log_at(SEED_USDC, &same, BUY_TX, 83)])).is_empty());
    // A log whose body doesn't decode is skipped, never a hold.
    let mut bad = log_at(SEED_USDC, &buy(), BUY_TX, 83);
    bad.data.truncate(10);
    assert!(decode(&v, &block(1, vec![bad])).is_empty());
}

#[test]
fn admits_only_registered_base_stable_pairs() {
    let p = admit(reg(), SEED_USDC, Some((tok("USDC"), tok("WMON"))), Some(50.0)).unwrap();
    assert_eq!(p, pool());

    let p = admit(reg(), SEED_AUSD, Some((tok("AUSD"), tok("WMON"))), Some(50.0)).unwrap();
    assert_eq!((p.market.as_str(), p.stable_sym.as_str()), ("MON/AUSD", "AUSD"));

    // The base side is tracked when the order is flipped.
    let p = admit(reg(), SEED_USDC, Some((tok("WMON"), tok("USDC"))), Some(50.0)).unwrap();
    assert!(p.base_is_token0);
    assert_eq!(p.base_dec, 18);

    // Stable/stable: no base asset to benchmark.
    assert_eq!(admit(reg(), SEED_USDC, Some((tok("USDC"), tok("AUSD"))), Some(50.0)), Err(Reject::NotBaseStable));
    // An unresolved read is never guessed.
    assert_eq!(admit(reg(), SEED_USDC, None, Some(50.0)), Err(Reject::Unresolved));
    assert_eq!(admit(reg(), SEED_USDC, Some((tok("USDC"), tok("WMON"))), None), Err(Reject::Unresolved));
    // The non-stable side is not a tracked asset.
    let dead = address!("000000000000000000000000000000000000dead").0 .0;
    assert_eq!(admit(reg(), SEED_USDC, Some((tok("USDC"), dead)), Some(50.0)), Err(Reject::NotBaseStable));
}

fn created(pool: Addr, t0: Addr, t1: Addr, fee: u64) -> FinalLog {
    let e = PoolCreated {
        token0: Address::from(t0),
        token1: Address::from(t1),
        feeBps: U256::from(fee),
        pool: Address::from(pool),
    };
    log_at(FACTORY.0 .0, &e, [0xcc; 32], 1)
}

/// (pool, getTokens, feeBps) as one discovery read them.
type Read = (Addr, Option<(Addr, Addr)>, Option<f64>);

fn seed_reads(extra: &[Read]) -> Reads {
    let mut r = Reads {
        pools: vec![SEED_USDC, SEED_AUSD],
        tokens: vec![Some((tok("USDC"), tok("WMON"))), Some((tok("AUSD"), tok("WMON")))],
        fees: vec![Some(50.0), Some(50.0)],
    };
    for (p, t, f) in extra {
        r.pools.push(*p);
        r.tokens.push(*t);
        r.fees.push(*f);
    }
    r
}

#[test]
fn watch_holds_until_discovery_then_follows_the_factory_and_every_admitted_pool() {
    let v = Capricorn::default();
    assert_eq!(v.watch(), Err(VenueError::NotReady("Capricorn discovery unavailable".into())));
    assert_eq!(v.candidates(), SEED_POOLS.iter().map(|a| to_addr(*a)).collect::<Vec<_>>());
    v.apply(reg(), &seed_reads(&[])).unwrap();
    let w = v.watch().unwrap();
    assert!(w.wants_log(&FACTORY.0 .0, Some(&PoolCreated::SIGNATURE_HASH.0)));
    for p in [SEED_USDC, SEED_AUSD] {
        assert!(w.wants_log(&p, Some(&Swap::SIGNATURE_HASH.0)));
    }
    assert_eq!(v.markets(), ["MON/AUSD", "MON/USDC"]);
    assert_eq!(v.entry_points().len(), 2);
}

#[test]
fn a_seed_that_cannot_be_read_fails_discovery() {
    let v = Capricorn::default();
    let mut r = seed_reads(&[]);
    r.tokens[1] = None;
    let e = v.apply(reg(), &r).unwrap_err().to_string();
    assert!(e.contains("read failed for seed pool 0x91c483fbe8feef4dad525781e6d65d2e668b3a47"), "{e}");
    assert!(v.watch().is_err(), "still undiscovered");
}

/// A pool the factory announces is admitted from the event, before the same
/// block's swaps, and recorded in the venue's committed state.
#[test]
fn admits_a_factory_pool_mid_run_and_decodes_its_swaps_in_the_same_block() {
    let v = Capricorn::default();
    v.apply(reg(), &seed_reads(&[])).unwrap();
    let state = VenueState::default();
    let b =
        block(120_000_000, vec![created(NEW_USDC, tok("USDC"), tok("WBTC"), 30), log_at(NEW_USDC, &buy(), BUY_TX, 5)]);
    let fills = decode_with(&v, &state, &b).unwrap();
    assert_eq!(fills.len(), 1);
    assert_eq!((fills[0].market.as_str(), fills[0].pool.as_str()), ("BTC/USDC", "cap 0x000000"));
    assert!(v.candidates().contains(&NEW_USDC));
    assert!(v.markets().contains(&"BTC/USDC".to_string()));
    assert!(v.watch().unwrap().wants_log(&NEW_USDC, Some(&Swap::SIGNATURE_HASH.0)));
    let writes = state.take_pending();
    assert_eq!(writes.len(), 1);

    // A restart: a fresh venue learns the pool from the committed state.
    let mut committed = VenueState::default();
    committed.apply(&writes);
    let restarted = Capricorn::default();
    restarted.apply(reg(), &seed_reads(&[])).unwrap();
    let f =
        decode_with(&restarted, &committed, &block(120_000_001, vec![log_at(NEW_USDC, &sell(), SELL_TX, 2)])).unwrap();
    assert_eq!(f.len(), 1);
    assert!(restarted.candidates().contains(&NEW_USDC));
    assert!(committed.take_pending().is_empty(), "nothing new to record");

    // An unregistered pair is skipped, not admitted.
    let other = address!("00000000000000000000000000000000000000bb").0 .0;
    let b = block(120_000_002, vec![created(other, tok("USDC"), tok("USD1"), 30), log_at(other, &buy(), BUY_TX, 2)]);
    assert!(decode_with(&v, &VenueState::default(), &b).unwrap().is_empty());
    assert!(!v.watch().unwrap().logs.contains_key(&other));
}

/// Today's "retains a non-seed catalog market when getTokens/feeBps becomes
/// unreadable": discovery only ever adds.
#[test]
fn keeps_a_non_seed_market_when_its_reads_fail() {
    for field in ["getTokens", "feeBps"] {
        let v = Capricorn::default();
        v.apply(reg(), &seed_reads(&[])).unwrap();
        decode(&v, &block(1, vec![created(NEW_USDC, tok("USDC"), tok("WBTC"), 30)]));
        v.apply(reg(), &seed_reads(&[(NEW_USDC, Some((tok("USDC"), tok("WBTC"))), Some(30.0))])).unwrap();
        assert!(v.markets().contains(&"BTC/USDC".to_string()));
        let unreadable = if field == "getTokens" {
            (NEW_USDC, None, Some(30.0))
        } else {
            (NEW_USDC, Some((tok("USDC"), tok("WBTC"))), None)
        };
        v.apply(reg(), &seed_reads(&[unreadable])).unwrap();
        assert!(v.markets().contains(&"BTC/USDC".to_string()), "{field}");
        assert!(v.watch().unwrap().wants_log(&NEW_USDC, Some(&Swap::SIGNATURE_HASH.0)), "{field}");
    }
}

/// Today's "retains admitted markets while quote probes fail": the catalog
/// and the tailed pools don't depend on quotability.
#[test]
fn quote_probes_never_change_the_catalog() {
    let v = Capricorn::default();
    let admitted = v.apply(reg(), &seed_reads(&[])).unwrap();
    let catalog = v.markets();
    v.set_quotable(&admitted, &[Some(false), Some(false)], &[None, None]);
    assert_eq!(v.markets(), catalog);
    let w = v.watch().unwrap();
    assert_eq!([SEED_USDC, SEED_AUSD].iter().filter(|p| w.logs.contains_key(*p)).count(), 2);
    v.set_quotable(&admitted, &[Some(false), Some(true)], &[Some(U256::from(1u8)), Some(U256::from(1u8))]);
    assert_eq!(v.markets(), catalog);
}

#[test]
fn meta_and_history() {
    let v = Capricorn::default();
    let m = &v.meta()[0];
    assert_eq!(
        (m.id.as_str(), m.name.as_str(), m.since_utc.as_deref()),
        ("capricorn", "Capricorn pAMM", Some("2026-04-01"))
    );
    assert_eq!((m.color.light.as_str(), m.color.dark.as_str()), ("#BE123C", "#FB7185"));
    assert!(m.quote_note.is_none());
    assert_eq!(v.history_from_utc(), Some("2026-04-01"));
    assert!(v.history_revisions().is_empty());
}

// ---- gas (capricorn.gas.test.ts) ----

fn hex_u(s: &str) -> u128 {
    u128::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

#[test]
fn gas_tracks_the_push_feed_by_its_push_event() {
    let fx: Value = serde_json::from_str(FEED_PUSH).unwrap();
    let g = Capricorn::default().gas_sources().unwrap().unwrap();
    assert!(g.destinations.is_empty() && g.relays.is_empty(), "logs mode: never by destination");
    let feed = PUSH_FEED.0 .0;
    assert_eq!(g.logs, vec![(feed, PUSH_FEED_UPDATE_TOPIC)]);
    // Unverified contract: only the hash is known.
    let topic = |s: &Value| s.as_str().unwrap().parse::<alloy_primitives::B256>().unwrap().0;
    assert_eq!(PUSH_FEED_UPDATE_TOPIC, topic(&fx["logs"][0]["topics"][0]));

    // A real push: the feed emits exactly one log with that topic.
    let feed_hex = format!("{PUSH_FEED:#x}").to_lowercase();
    assert_eq!(fx["to"].as_str().unwrap(), feed_hex);
    assert_eq!(fx["status"], "success");
    let hits = fx["logs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| {
            l["address"].as_str().unwrap() == feed_hex && g.logs.iter().any(|(_, t)| *t == topic(&l["topics"][0]))
        })
        .count();
    assert_eq!(hits, 1);

    // Once discovered, the watch set copies the push logs.
    let v = Capricorn::default();
    v.apply(reg(), &seed_reads(&[])).unwrap();
    assert!(v.watch().unwrap().wants_log(&feed, Some(&PUSH_FEED_UPDATE_TOPIC)));

    // Hand-checked cost: 99,650 × 102 gwei = 0.0101643 MON per push (Monad
    // charges the full limit).
    assert_eq!(hex_u(fx["gasUsed"].as_str().unwrap()), hex_u(fx["gasLimit"].as_str().unwrap()));
    let t = FinalTxn {
        index: 0,
        hash: [0; 32],
        from: [0; 20],
        to: Some(feed),
        kind: 0,
        gas_limit: hex_u(fx["gasLimit"].as_str().unwrap()) as u64,
        max_fee_per_gas: hex_u(fx["effectiveGasPrice"].as_str().unwrap()),
        max_priority_fee_per_gas: 0,
        input: Vec::new(),
    };
    assert!((t.cost_wei(0) as f64 / 1e18 - 0.0101643).abs() < 1e-10);
}
