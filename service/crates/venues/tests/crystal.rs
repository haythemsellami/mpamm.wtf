//! Crystal Vault on REAL recorded data, the TypeScript tests' own fixtures:
//! crystal.json (every Crystal Fill/Trade log of six txs, and one block's
//! discovery reads) and crystal-keeper.json (the keeper's quote-update txs on
//! both routes). Expected values come from the raw ints, not the venue. Each
//! vault leg was cross-checked against its tx's ERC-20 Transfers.

use std::collections::{BTreeMap, HashSet};

use alloy_primitives::{Address, U256};
use mpamm_core::{
    block::hex_bytes, DecodeCx, EntryPoint, FinalBlock, FinalLog, FinalTxn, GasRelay, GasSources, NoPrices, Origin,
    Pricer, Venue, VenueError, VenueState,
};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::TopicFilter;
use mpamm_types::{Fill, FillCategory, Side};
use mpamm_venues::{
    crystal::{self, abi::MarketInfo, verify_book, Book, Crystal},
    util::to_addr,
};
use serde_json::Value;

const FX: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/crystal.json");
const KEEPER_FX: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/crystal-keeper.json");

const VAULT: &str = "0x020f863a6212a9ed5caa73a087e62acd371b7334";
const KEEPER: &str = "0xaf9ed4d3153d821046885b4aea0f778addbb3de5";
const HANDLER: &str = "0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58";

fn fx() -> Value {
    serde_json::from_str(FX).unwrap()
}

fn addr(s: &str) -> [u8; 20] {
    parse_address(s).unwrap()
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

fn log_of(v: &Value) -> (u64, FinalLog) {
    (
        num(&v["blockNumber"]),
        FinalLog {
            log_index: num(&v["logIndex"]) as u32,
            txn_index: 0,
            tx_hash: b32(&v["transactionHash"]),
            address: addr(v["address"].as_str().unwrap()),
            topics: v["topics"].as_array().unwrap().iter().map(b32).collect(),
            data: hex_bytes(v["data"].as_str().unwrap()).unwrap(),
        },
    )
}

fn logs_of(names: &[&str]) -> Vec<(u64, FinalLog)> {
    let fx = fx();
    names.iter().flat_map(|n| fx["logs"][*n].as_array().unwrap().iter().map(log_of).collect::<Vec<_>>()).collect()
}

fn u256(v: &Value) -> U256 {
    v.as_str().unwrap().parse().unwrap()
}

/// The recorded getMarket answer.
fn market_info() -> MarketInfo {
    let m = &fx()["discovery"]["getMarket"];
    let a = |k: &str| m[k].as_str().unwrap().parse::<Address>().unwrap();
    MarketInfo {
        quoteAsset: a("quoteAsset"),
        baseAsset: a("baseAsset"),
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
    }
}

/// Discovery as recorded: vault market(), quoteAsset(), baseAsset(), then
/// the market's getMarket.
fn recorded_book() -> Book {
    let v = &fx()["discovery"]["vault"];
    let a = |i: usize| v[i].as_str().unwrap().parse::<Address>().unwrap();
    verify_book(Registry::get(), a(0), a(2), a(1), &market_info()).unwrap()
}

fn discovered() -> Crystal {
    Crystal::with_book(recorded_book())
}

/// USDC is the quote leg: $1, so a trade's USD is its USDC leg.
struct UsdcAtOne;

impl Pricer for UsdcAtOne {
    fn usd_per_token(&self, _: &str) -> f64 {
        1.0
    }
    fn usd_for_token(&self, _: &str, amount: f64) -> f64 {
        amount
    }
    fn pair_mid(&self, _: &str) -> f64 {
        0.0
    }
}

fn block(number: u64, logs: Vec<FinalLog>) -> FinalBlock {
    FinalBlock {
        number,
        hash: [0; 32],
        parent_hash: [0; 32],
        timestamp: number,
        proposal_ns: None,
        base_fee: 0,
        txns: Vec::new(),
        logs,
        origin: Origin::Rpc("fixture".into()),
    }
}

/// Decodes the logs block by block, in block order, as the pipeline does
/// (within a block, in the order given).
fn decode_with(pricer: &dyn Pricer, logs: Vec<(u64, FinalLog)>) -> Result<Vec<Fill>, VenueError> {
    let v = discovered();
    let mut blocks: BTreeMap<u64, Vec<FinalLog>> = BTreeMap::new();
    for (n, l) in logs {
        blocks.entry(n).or_default().push(l);
    }
    let state = VenueState::default();
    let cx = DecodeCx { registry: Registry::get(), pricer, state: &state };
    let mut out = Vec::new();
    for (n, logs) in blocks {
        out.extend(v.decode(&cx, &block(n, logs))?);
    }
    Ok(out)
}

fn decode(logs: Vec<(u64, FinalLog)>) -> Result<Vec<Fill>, VenueError> {
    decode_with(&UsdcAtOne, logs)
}

fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

#[test]
fn holds_the_cursor_until_discovery_then_tails_fill_and_trade_on_crystal() {
    assert!(matches!(Crystal::default().watch(), Err(VenueError::NotReady(_))));
    assert!(Crystal::default().markets().is_empty());
    let v = discovered();
    let w = v.watch().unwrap();
    let fx = fx();
    let want = HashSet::from([b32(&fx["logs"]["buy"][0]["topics"][0]), b32(&fx["logs"]["buy"][1]["topics"][0])]);
    assert_eq!(w.logs.len(), 1);
    assert_eq!(w.logs[&to_addr(crystal::CRYSTAL)], TopicFilter::Topics(want));
    assert_eq!(v.markets(), ["MON/USDC"]);
    // The direct route; the keeper's FastLane route is pinned below.
    assert_eq!(v.gas_sources().unwrap().unwrap().destinations[0], addr(VAULT));
    assert_eq!(v.entry_points(), [EntryPoint { address: to_addr(crystal::CRYSTAL), router: None }]);
}

#[test]
fn discovery_reads_the_book_and_fails_closed_on_other_tokens() {
    let b = recorded_book();
    assert_eq!(b.market, addr("0x39fae95717cfd4bda22317f1c124660a166b6bec"));
    assert_eq!(b.symbol, "MON/USDC");
    // scaleFactor 1e21 × 10^6 / 10^18.
    assert_eq!(b.px_scale, 1e9);
    assert_eq!(b.fee_bps, 0.0);
    let r = Registry::get();
    let v = &fx()["discovery"]["vault"];
    let a = |i: usize| v[i].as_str().unwrap().parse::<Address>().unwrap();
    // The vault's tokens swapped, and the market's.
    assert!(verify_book(r, a(0), a(1), a(2), &market_info()).is_err());
    let mut info = market_info();
    info.baseAsset = info.quoteAsset;
    assert!(verify_book(r, a(0), a(2), a(1), &info).is_err());
}

/// https://monadscan.com/tx/0xbcd6f97225ea9335610c3608b65a0313b6a7da31ff657ac89f4df1381334e8c7
/// Taker BOUGHT 115,863.31… WMON for 2,487.246242 USDC off one vault ask at
/// book price 21,466,000 (0.021466); makerRebate 99995 shaves the taker's
/// leg, so the realized price is the book price ÷ 0.99995.
#[test]
fn decodes_a_buy_and_a_sell_at_their_gross_usdc_leg() {
    let out = decode(logs_of(&["buy", "sell"])).unwrap();
    let (buy, sell) = (&out[0], &out[1]);
    assert_eq!(buy.id, "crystal-0xbcd6f97225ea9335610c3608b65a0313b6a7da31ff657ac89f4df1381334e8c7-97");
    assert_eq!(buy.venue_id, "crystal");
    assert_eq!(buy.market, "MON/USDC");
    assert_eq!(buy.side, Side::Buy);
    assert_eq!(buy.category, FillCategory::Unknown);
    assert_eq!(buy.block_number, 116_614_451);
    // The taker as viem hands it: checksummed; the market likewise.
    assert_eq!(buy.to, "0x5F50…aA52");
    assert_eq!(buy.pool, "book 0x39fAE9");
    assert_eq!(buy.usd, 2487.246242);
    assert!(close(buy.base_amount, 115_863.313_099_785_7, 9));
    assert!(close(buy.exec_px / (0.021466 / 0.99995) - 1.0, 0.0, 8));
    assert_eq!(buy.exec_px, buy.usd / buy.base_amount);
    assert!(!buy.px_approx && buy.router.is_none());
    // https://monadscan.com/tx/0xc2514490943edb9153ef8d64af94bb41580ff33fcab1b5726da05b1eed926e9f
    // Taker SOLD 175,547.59… WMON into a vault bid at 0.021735 for 3,815.336151 USDC.
    assert_eq!(sell.id, "crystal-0xc2514490943edb9153ef8d64af94bb41580ff33fcab1b5726da05b1eed926e9f-10");
    assert_eq!(sell.side, Side::Sell);
    assert_eq!(sell.usd, 3815.336151);
    assert!(close(sell.base_amount, 175_547.592_709_188_46, 9));
    assert!(close(sell.exec_px / (0.021735 * 0.99995) - 1.0, 0.0, 8));
}

/// https://monadscan.com/tx/0xd064bb6f22a53ef5829f398be22a24bc9fb186c2fe68d59406c506e8362482c7
/// One $8,518.53 buy across four vault asks and one outside ask (2.378439
/// USDC, paid to it directly). The tx's USDC Transfer to Crystal is
/// 8,516.150031: exactly the vault's four legs.
#[test]
fn counts_only_the_vault_legs_of_a_trade_outside_makers_share() {
    let fills = decode(logs_of(&["mixedMakers"])).unwrap();
    assert_eq!(fills.len(), 1);
    assert_eq!(fills[0].id, "crystal-0xd064bb6f22a53ef5829f398be22a24bc9fb186c2fe68d59406c506e8362482c7-239");
    assert_eq!(fills[0].usd, (2409146072u64 + 2891774634 + 1607207587 + 1608021738) as f64 / 1e6);
    let base: u128 =
        111015005330052883677184 + 133218006396063463768064 + 74010003553368586321920 + 74010003553368586321920;
    assert_eq!(fills[0].base_amount, base as f64 / 1e18);
}

/// https://monadscan.com/tx/0xdf6283864421b726d6b6f3093c6c39560c96fd1f410173cb92a3e8c5ac3a1b47
/// An aggregator selling twice through the book in one tx (one leg, then two).
#[test]
fn splits_two_taker_orders_in_one_tx_at_their_own_trade() {
    let fills = decode(logs_of(&["twoTrades"])).unwrap();
    assert_eq!(fills.iter().map(|f| f.id.rsplit('-').next().unwrap()).collect::<Vec<_>>(), ["50", "88"]);
    assert_eq!(fills.iter().map(|f| f.side).collect::<Vec<_>>(), [Side::Sell, Side::Sell]);
    assert!(close(fills[0].usd, 424.893061, 9));
    assert_eq!(fills[1].usd, (2376778187u64 + 1660342405) as f64 / 1e6);
    let base: u128 = 108247428356480215849757 + 75642359201542728143072;
    assert_eq!(fills[1].base_amount, base as f64 / 1e18);
}

/// outsideMaker: https://monadscan.com/tx/0x35d0c13f9b49716afa7dac7bae45d8cc1094a5db34abdb2978033fc7730b0035
/// vaultTakes: https://monadscan.com/tx/0xcfa458369328d20678e771a7be970e921d656b573b1c066b89a97bc11f77d168
/// (the keeper's execute selling 749.75 WMON into two outside bids)
#[test]
fn drops_trades_the_vault_did_not_make_including_its_own_takes() {
    assert!(decode(logs_of(&["outsideMaker", "vaultTakes"])).unwrap().is_empty());
}

#[test]
fn is_independent_of_the_order_logs_arrive_in() {
    let logs = logs_of(&["buy", "mixedMakers", "twoTrades"]);
    let mut reversed = logs.clone();
    reversed.reverse();
    assert_eq!(decode(reversed).unwrap(), decode(logs).unwrap());
}

#[test]
fn holds_the_cursor_when_a_vault_leg_arrives_without_its_trade() {
    let mut logs = logs_of(&["buy"]);
    logs.truncate(1);
    let err = decode(logs).unwrap_err();
    assert!(matches!(err, VenueError::Decode(_)) && err.to_string().contains("without their Trade"), "{err}");
}

#[test]
fn skips_a_trade_whose_legs_disagree_with_its_side() {
    let mut logs = logs_of(&["buy"]);
    // Trade data word 0 is isBuy.
    logs[1].1.data[31] = 0;
    assert!(decode(logs).unwrap().is_empty());
}

#[test]
fn holds_when_usdc_has_no_price() {
    assert!(decode_with(&NoPrices, logs_of(&["buy"])).is_err());
}

#[test]
fn decode_reads_only_crystals_logs() {
    let mut logs = logs_of(&["buy"]);
    for (_, l) in &mut logs {
        l.address = [0x11; 20];
    }
    assert!(decode(logs).unwrap().is_empty());
}

#[test]
fn replays_from_the_deploy_day() {
    let v = Crystal::default();
    let rev = v.history_revisions();
    assert_eq!(rev.len(), 1);
    assert_eq!((rev[0].id, rev[0].from), ("deploy-day", Some("2026-10-27")));
    assert!(rev[0].markets.is_empty());
    assert_eq!(v.history_from_utc(), Some("2026-09-20"));
    let m = &v.meta()[0];
    assert_eq!(
        (m.id.as_str(), m.name.as_str(), m.since_utc.as_deref()),
        ("crystal", "Crystal Vault", Some("2026-09-22"))
    );
    assert_eq!((m.color.light.as_str(), m.color.dark.as_str()), ("#AD2B62", "#D14781"));
}

// Quote-update gas (crystal.gas.test.ts). On 2026-11-07 the keeper moved its
// pushes onto FastLane's shared handler with its own EIP-7702 account as the
// searcher; a vault-keyed source alone goes silent there.

fn keeper_fx() -> Value {
    serde_json::from_str(KEEPER_FX).unwrap()
}

fn txn_of(t: &Value) -> FinalTxn {
    FinalTxn {
        index: 0,
        hash: b32(&t["hash"]),
        from: addr(t["from"].as_str().unwrap()),
        to: t["to"].as_str().map(addr),
        // Priced at the receipt's effective price: Monad charges the limit,
        // and receipts report gasUsed == limit.
        kind: 0,
        gas_limit: num(&t["gasUsed"]),
        max_fee_per_gas: u128::from(num(&t["effectiveGasPrice"])),
        max_priority_fee_per_gas: 0,
        input: hex_bytes(t["input"].as_str().unwrap()).unwrap(),
    }
}

/// A relay's rule as `GasRelay` states it: `to`, the selector, and the
/// static word naming one of the destinations (an address-shaped word).
fn relayed(g: &GasSources, t: &FinalTxn) -> bool {
    g.relays.iter().any(|r| {
        let at = 4 + 32 * r.target_word;
        t.to == Some(r.address)
            && t.input.len() >= at + 32
            && t.input[..4] == r.selector
            && t.input[at..at + 12].iter().all(|b| *b == 0)
            && g.destinations.iter().any(|d| t.input[at + 12..at + 32] == d[..])
    })
}

fn sources() -> GasSources {
    Crystal::default().gas_sources().unwrap().unwrap()
}

#[test]
fn tracks_the_vault_and_the_keeper_and_routes_fastlane_to_the_keeper() {
    let g = sources();
    assert_eq!(g.destinations, [addr(VAULT), addr(KEEPER)]);
    assert_eq!(
        g.relays,
        [GasRelay {
            address: addr(HANDLER),
            selector: [0x0c, 0x7a, 0xbd, 0x22],
            target_word: 5,
            targets: vec![addr(KEEPER)]
        }]
    );
    assert!(g.logs.is_empty());
    // Gas needs no discovery; the watch set copies every destination's and
    // the relay's calldata once it is ready.
    let w = Crystal::with_book(recorded_book()).watch().unwrap();
    for a in [VAULT, KEEPER, HANDLER] {
        assert!(w.txn_input.contains(&addr(a)), "{a}");
    }
}

#[test]
fn counts_the_keepers_relayed_pushes_including_a_reverted_one() {
    let fx = keeper_fx();
    let g = sources();
    let hits: Vec<&str> = ["relayed", "relayedRev", "other", "direct", "delegate"]
        .into_iter()
        .filter(|k| relayed(&g, &txn_of(&fx[*k])))
        .collect();
    assert_eq!(hits, ["relayed", "relayedRev"]);
    assert_eq!(fx["relayedRev"]["status"], "0x0");
    for k in ["relayed", "relayedRev"] {
        assert_eq!(fx[k]["from"], KEEPER);
        assert_eq!(fx[k]["to"], HANDLER);
    }
}

#[test]
fn the_searcher_word_is_the_keeper_and_the_vault_sits_off_the_word_grid() {
    let t = txn_of(&keeper_fx()["relayed"]);
    let words: Vec<&[u8]> = t.input[4..].chunks(32).collect();
    assert_eq!(words[5][12..], addr(KEEPER));
    let vault_word: Vec<u8> = [[0u8; 12].as_slice(), addr(VAULT).as_slice()].concat();
    assert!(words.iter().all(|w| *w != vault_word.as_slice()));
    assert!(t.input.windows(20).any(|w| w == addr(VAULT)));
}

#[test]
fn a_direct_push_is_matched_by_its_to_and_another_searchers_bid_never() {
    let fx = keeper_fx();
    let g = sources();
    let direct = txn_of(&fx["direct"]);
    assert_eq!(direct.to, Some(addr(VAULT)));
    assert_eq!(direct.input[..4], [0x61, 0xd5, 0x9c, 0x2d]); // execute
    assert!(g.destinations.contains(&direct.to.unwrap()));
    let other = txn_of(&fx["other"]);
    assert_eq!(other.to, Some(addr(HANDLER)));
    assert_eq!(other.input[..4], [0x0c, 0x7a, 0xbd, 0x22]);
    assert!(!relayed(&g, &other) && !g.destinations.contains(&other.to.unwrap()));
}

#[test]
fn the_keeper_has_code_from_its_type_4_delegation() {
    let fx = keeper_fx();
    assert_eq!(fx["delegate"]["type"], "0x4");
    assert_eq!(fx["delegate"]["to"], KEEPER);
    assert_eq!(num(&fx["delegate"]["blockNumber"]), 120_108_824);
    // No routed push predates it.
    assert!(num(&fx["delegate"]["blockNumber"]) < num(&fx["relayedRev"]["blockNumber"]));
}

#[test]
fn hand_checked_cost_per_push() {
    let fx = keeper_fx();
    let mon = |k: &str| txn_of(&fx[k]).cost_wei(0) as f64 / 1e18;
    // 950,000 × 113 gwei per routed push (~5× a direct one).
    assert!(close(mon("relayed"), 0.10735, 10));
    // 650,000 × 113 gwei, reverted.
    assert!(close(mon("relayedRev"), 0.07345, 10));
    // 200,000 × 113 gwei.
    assert!(close(mon("direct"), 0.0226, 10));
}
