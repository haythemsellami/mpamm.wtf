//! BTR on recorded Monad mainnet logs (server/src/venues/__tests__/
//! fixtures/btr-swapped.json, the TypeScript tests' own fixture): the
//! retired pool's three swaps and pool v2's creation `Upgraded`. Hand check
//! from the raw `amounts` word (in = low 128 bits, out = high 128), each half
//! equal to the ERC-20 transfer into or out of the pool in the same tx:
//!   buy    168.286102 USDC in, 4923.169136709459298021 WMON out
//!   sell   4786.444594106445540380 WMON in, 164.518345 USDC out
//!   cross  0.00479999 WBTC in, 0.00479561 cbBTC out

use std::collections::HashSet;

use alloy_primitives::Address;
use mpamm_core::{
    block::hex_bytes, DecodeCx, FinalBlock, FinalLog, NoPrices, Origin, Pricer, RevisionSource, Venue, VenueState,
};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::TopicFilter;
use mpamm_types::{Fill, FillCategory, Side};
use mpamm_venues::{
    btr::{self, btr_markets, quotable_markets, Btr, Listing},
    util::{from_units, to_addr},
};
use serde_json::Value;

const FX: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/btr-swapped.json");
const BTC_USD: f64 = 110_000.0;

fn fx() -> Value {
    serde_json::from_str(FX).unwrap()
}

fn num(v: &Value) -> u64 {
    match v {
        Value::String(s) => match s.strip_prefix("0x") {
            Some(h) => u64::from_str_radix(h, 16).unwrap(),
            None => s.parse().unwrap(),
        },
        v => v.as_u64().unwrap(),
    }
}

fn b32(v: &Value) -> [u8; 32] {
    hex_bytes(v.as_str().unwrap()).unwrap().try_into().unwrap()
}

/// A recorded log and its block (number, timestamp).
fn log_of(v: &Value) -> (u64, u64, FinalLog) {
    (
        num(&v["blockNumber"]),
        num(&v["blockTimestamp"]),
        FinalLog {
            log_index: num(&v["logIndex"]) as u32,
            txn_index: 0,
            tx_hash: b32(&v["transactionHash"]),
            address: parse_address(v["address"].as_str().unwrap()).unwrap(),
            topics: v["topics"].as_array().unwrap().iter().map(b32).collect(),
            data: hex_bytes(v["data"].as_str().unwrap()).unwrap(),
        },
    )
}

fn block(number: u64, timestamp: u64, logs: Vec<FinalLog>) -> FinalBlock {
    FinalBlock {
        number,
        hash: [0; 32],
        parent_hash: [0; 32],
        timestamp,
        proposal_ns: None,
        base_fee: 0,
        txns: Vec::new(),
        logs,
        origin: Origin::Rpc("fixture".into()),
    }
}

/// Stables at $1, both BTC wrappers at one fixed price, nothing else priced.
struct TestPrices;

impl Pricer for TestPrices {
    fn usd_per_token(&self, _: &str) -> f64 {
        0.0
    }
    fn usd_for_token(&self, key: &str, amount: f64) -> f64 {
        if Registry::get().tokens[key].stable {
            amount
        } else if key == "WBTC" || key == "CBBTC" {
            amount * BTC_USD
        } else {
            0.0
        }
    }
    fn pair_mid(&self, _: &str) -> f64 {
        0.0
    }
}

fn decode_with(v: &Btr, pricer: &dyn Pricer, b: &FinalBlock) -> Result<Vec<Fill>, mpamm_core::VenueError> {
    let state = VenueState::default();
    v.decode(&DecodeCx { registry: Registry::get(), pricer, state: &state }, b)
}

/// One recorded swap (0 buy, 1 sell, 2 cross) in its own block, edited by `f`.
fn decode_swap(i: usize, f: impl FnOnce(&mut FinalLog)) -> Result<Vec<Fill>, mpamm_core::VenueError> {
    let (n, ts, mut l) = log_of(&fx()["logs"][i]);
    f(&mut l);
    decode_with(&Btr::default(), &TestPrices, &block(n, ts, vec![l]))
}

fn one(i: usize) -> Fill {
    let mut out = decode_swap(i, |_| {}).unwrap();
    assert_eq!(out.len(), 1);
    out.remove(0)
}

fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

#[test]
fn one_static_source_carries_both_pools_fills_and_upgrades() {
    let w = Btr::default().watch().unwrap();
    let fx = fx();
    let want =
        TopicFilter::Topics(HashSet::from([b32(&fx["logs"][0]["topics"][0]), b32(&fx["upgraded"]["topics"][0])]));
    assert_eq!(w.logs.len(), 2);
    assert_eq!(w.logs[&to_addr(btr::POOL)], want);
    assert_eq!(w.logs[&to_addr(btr::RETIRED_POOL)], want);
}

#[test]
fn pools_are_direct_entry_and_the_router_and_executors_btr_periphery() {
    let entries = Btr::default().entry_points();
    let direct: Vec<_> = entries.iter().filter(|e| e.router.is_none()).map(|e| e.address).collect();
    assert_eq!(direct, [to_addr(btr::POOL), to_addr(btr::RETIRED_POOL)]);
    let periphery: Vec<_> = entries.iter().filter(|e| e.router.is_some()).collect();
    // The router, the four that fronted the retired pool, and the one on pool v2.
    assert_eq!(periphery.len(), 6);
    let label = |a: &str| {
        periphery.iter().find(|e| mpamm_venues::util::addr_hex(&e.address) == a).and_then(|e| e.router.clone())
    };
    assert_eq!(label("0xbbbbbbb17647a22d61e49d62a95445b1284b1296").as_deref(), Some("BTR"), "the router");
    assert_eq!(label("0xbbbbbbb0f8c5d06406a6ff39abe1d514e25ade2e").as_deref(), Some("BTR"));
    // The pool v2 executor is CoopArb, named apart from BTR's other executors.
    assert_eq!(label("0xbbbbbbb2a9c5b6da52f2cc79f6a306ebcb37e5cf").as_deref(), Some("BTR Coop Arb"));
    let addrs: Vec<_> = periphery.iter().map(|e| mpamm_venues::util::addr_hex(&e.address)).collect();
    assert!(addrs.iter().all(|a| a.starts_with("0xbbbbbbb") && a.len() == 42));
}

#[test]
fn every_known_implementation_is_a_gas_destination() {
    let g = Btr::default().gas_sources().unwrap().unwrap();
    // Pool v2's, as its recorded creation Upgraded names it, and the retired pool's.
    let v2: [u8; 20] = b32(&fx()["upgraded"]["topics"][1])[12..].try_into().unwrap();
    assert!(g.destinations.contains(&v2));
    assert!(g.destinations.contains(&parse_address("0x154be75fff18c9dfdd15d7f902b64a7b93b2a638").unwrap()));
    assert!(g.relays.is_empty() && g.logs.is_empty());
    // Their calldata is copied for gas.
    let w = Btr::default().watch().unwrap();
    assert!(g.destinations.iter().all(|d| w.txn_input.contains(d)));
}

#[test]
fn usdc_to_wmon_is_a_buy_of_mon_usdc() {
    let f = one(0);
    assert_eq!(f.id, "btr-0xd2beaa33c6b80fc3a1b0aae5ffdb0bfdcdd878024889828aa213f10003753922-182");
    assert_eq!(f.venue_id, "btr");
    assert_eq!(f.market, "MON/USDC");
    assert_eq!(f.side, Side::Buy);
    assert_eq!(f.category, FillCategory::Unknown);
    assert_eq!(f.usd, 168.286102);
    assert!(close(f.base_amount, 4923.169136709459, 9));
    assert_eq!(f.base_amount, from_units(alloy_primitives::U256::from(4_923_169_136_709_459_298_021u128), 18));
    assert!(close(f.exec_px, 168.286102 / 4923.169136709459, 12));
    assert_eq!(f.exec_px, f.usd / f.base_amount);
    assert_eq!(f.block_number, 109_923_373);
    assert_eq!(f.ts, 1_790_952_940_000.0);
    assert_eq!(f.pool, "btr 0xbbbbbbb0");
    // The recipient as viem hands it: checksummed.
    assert_eq!(f.to, "0xbbbb…06A7");
    assert_eq!(f.tx_hash, "0xd2beaa33c6b80fc3a1b0aae5ffdb0bfdcdd878024889828aa213f10003753922");
    assert!(!f.px_approx && f.router.is_none());
}

#[test]
fn wmon_to_usdc_is_a_sell_of_mon_usdc() {
    let f = one(1);
    assert_eq!(f.id, "btr-0x58a335d8bdd1cd76c35a5263307a9fd0cbb34190c183505e7053263dc96d34a5-12");
    assert_eq!(f.market, "MON/USDC");
    assert_eq!(f.side, Side::Sell);
    assert_eq!(f.usd, 164.518345);
    assert!(close(f.base_amount, 4786.444594106445, 9));
    assert!(close(f.exec_px, 164.518345 / 4786.444594106445, 12));
    assert_eq!(f.block_number, 109_894_477);
}

#[test]
fn a_spoke_to_spoke_swap_is_one_trade_on_the_registered_cross() {
    let f = one(2);
    assert_eq!(f.market, "WBTC/cbBTC");
    assert_eq!(f.side, Side::Sell);
    assert!(close(f.base_amount, 0.00479999, 12));
    assert!(close(f.exec_px, 0.00479561 / 0.00479999, 12));
    // Valued off its quote leg.
    assert!(close(f.usd, 0.00479561 * BTC_USD, 9));
}

#[test]
fn decodes_the_same_event_from_pool_v2() {
    let f = decode_swap(0, |l| l.address = to_addr(btr::POOL)).unwrap();
    assert_eq!(f[0].market, "MON/USDC");
    assert_eq!(f[0].usd, 168.286102);
    assert_eq!(f[0].pool, "btr 0xbbbbbbbd");
}

#[test]
fn drops_another_address_a_same_token_pair_and_malformed_amounts() {
    assert!(decode_swap(0, |l| l.address = [0x11; 20]).unwrap().is_empty());
    let usdt0 = Registry::get().tokens["USDT0"].address_bytes();
    let same = decode_swap(0, |l| {
        l.topics[3] = [[0u8; 12].as_slice(), usdt0.as_slice()].concat().try_into().unwrap();
        l.data[12..32].copy_from_slice(&usdt0);
    });
    assert!(same.unwrap().is_empty());
    // amounts = 5: nothing out.
    let five = decode_swap(0, |l| {
        l.data[32..64].fill(0);
        l.data[63] = 5;
    });
    assert!(five.unwrap().is_empty());
}

#[test]
fn holds_only_when_no_leg_can_be_priced() {
    let (n, ts, l) = log_of(&fx()["logs"][0]);
    let err = decode_with(&Btr::default(), &NoPrices, &block(n, ts, vec![l])).unwrap_err();
    assert!(err.to_string().contains("no USD price"), "{err}");
}

#[test]
fn passes_over_the_recorded_upgraded_a_known_implementation() {
    let fx = fx();
    let (_, _, upgrade) = log_of(&fx["upgraded"]);
    let swaps: Vec<FinalLog> = (0..3).map(|i| log_of(&fx["logs"][i]).2).collect();
    let out = decode_with(&Btr::default(), &TestPrices, &block(1, 1, [vec![upgrade], swaps].concat())).unwrap();
    assert_eq!(out.iter().map(|f| f.side).collect::<Vec<_>>(), [Side::Buy, Side::Sell, Side::Sell]);
}

#[test]
fn an_unknown_implementation_keeps_the_trades_around_it() {
    let fx = fx();
    let (_, _, mut foreign) = log_of(&fx["upgraded"]);
    foreign.topics[1] = [[0u8; 12].as_slice(), [0x12u8; 20].as_slice()].concat().try_into().unwrap();
    let (s0, s1) = (log_of(&fx["logs"][0]).2, log_of(&fx["logs"][1]).2);
    let out = decode_with(&Btr::default(), &TestPrices, &block(1, 1, vec![s0, foreign, s1])).unwrap();
    assert_eq!(out.iter().map(|f| f.side).collect::<Vec<_>>(), [Side::Buy, Side::Sell]);
}

/// Discovery's reads for every token it probes: `listed` answer with their
/// registry decimals and the swap-enabled flag unless overridden; every
/// other token reads back zeroed (what the pool returns for an asset it does
/// not list).
fn discovered(listed: &[(&str, Option<u8>, Option<u16>)]) -> Result<Vec<String>, mpamm_core::VenueError> {
    let r = Registry::get();
    let native = parse_address(&r.native_mon);
    let listing: Vec<Listing<'_>> = r
        .tokens
        .iter()
        .filter(|(_, t)| Some(t.address_bytes()) != native)
        .map(|(k, t)| {
            let read = match listed.iter().find(|(key, _, _)| key == k) {
                Some((_, d, f)) => (d.unwrap_or(t.decimals), f.unwrap_or(16)),
                None => (0, 0),
            };
            Listing { token_key: k, read: Some(read) }
        })
        .collect();
    let b = Btr::with_quotable(quotable_markets(r, &listing)?);
    Ok(b.markets())
}

#[test]
fn discovery_skips_assets_the_pool_does_not_list() {
    let m = discovered(&[("USDC", None, None), ("WMON", None, None), ("WETH", None, None)]).unwrap();
    assert_eq!(m, ["ETH/USDC", "MON/ETH", "MON/USDC"]);
}

#[test]
fn discovery_picks_up_a_registered_token_listed_later() {
    let m = discovered(&[("USDC", None, None), ("WMON", None, None), ("USD1", None, None)]).unwrap();
    assert!(m.contains(&"MON/USD1".to_string()));
}

#[test]
fn discovery_leaves_a_listed_asset_without_the_swap_bit_unquoted() {
    let m = discovered(&[("USDC", None, None), ("WMON", None, None), ("WETH", None, Some(32))]).unwrap();
    assert_eq!(m, ["MON/USDC"]);
}

#[test]
fn discovery_fails_loud_on_a_listed_asset_with_other_decimals() {
    let err = discovered(&[("USDC", None, None), ("WMON", Some(8), None)]).unwrap_err();
    assert!(err.to_string().contains("WMON decimals mismatch"), "{err}");
    // And on a failed read, and when nothing registered is listed.
    let r = Registry::get();
    let failed = [Listing { token_key: "USDC", read: None }];
    assert!(quotable_markets(r, &failed).unwrap_err().to_string().contains("read failed"));
    assert!(discovered(&[]).unwrap_err().to_string().contains("no registered markets"));
}

#[test]
fn the_market_table_maps_every_registered_erc20_pair() {
    let r = Registry::get();
    let markets = btr_markets(r);
    let symbols: Vec<&str> = markets.values().map(|m| m.market.as_str()).collect();
    assert!(symbols.contains(&"MON/USDC"));
    assert!(symbols.contains(&"WBTC/cbBTC"));
    // Not a pool asset today: its swaps decode the day it becomes one.
    assert!(symbols.contains(&"SPYx/USDC"));
    let native = parse_address(&r.native_mon).unwrap();
    assert!(markets.values().all(|m| m.base != native && m.quote != native));
    // The canonical pair wins: WMON/USDC is MON/USDC, never another symbol.
    let wmon = r.tokens["WMON"].address_bytes();
    let usdc = r.tokens["USDC"].address_bytes();
    assert!(markets.values().any(|m| m.market == "MON/USDC" && m.base == wmon && m.quote == usdc));
    assert_eq!(markets.values().filter(|m| m.base == wmon && m.quote == usdc).count(), 1);
}

#[test]
fn meta_and_history_match_today() {
    let b = Btr::default();
    let m = &b.meta()[0];
    assert_eq!((m.id.as_str(), m.name.as_str(), m.since_utc.as_deref()), ("btr", "BTR", Some("2026-10-01")));
    assert_eq!((m.color.light.as_str(), m.color.dark.as_str()), ("#1E3A8A", "#E0E7FF"));
    assert_eq!(b.history_from_utc(), Some("2026-10-01"));
    let rev = b.history_revisions();
    assert_eq!(rev.len(), 1);
    assert_eq!((rev[0].id, rev[0].from), ("fill-time-usd", Some("2026-10-13")));
    assert_eq!(rev[0].source, RevisionSource::Replay);
    assert_eq!(Address::from(to_addr(btr::POOL)), btr::POOL);
}
