//! Hanji, ported from server/src/venues/__tests__/hanji.{decode,discovery,
//! quoters}.test.ts: the same fixtures and expected numbers. The decode
//! fixtures are the TS tests' recorded `OrderPlaced` args, ABI-encoded back
//! into raw logs so they go through the real decoder.

use std::collections::HashSet;

use alloy_primitives::{aliases::U72, Address, U256};
use alloy_sol_types::SolEvent;
use mpamm_chain::Rpc;
use mpamm_core::{
    block::hex_bytes, ChainCx, DecodeCx, FinalBlock, FinalLog, GasSources, NoPrices, Origin, Pricer, Venue, VenueError,
    VenueState,
};
use mpamm_registry::{parse_address, Registry};
use mpamm_types::{Fill, FillCategory, Side, VenueKind, VenueRole};
use mpamm_venues::hanji::{BookConfig, Hanji, OrderPlaced, KNOWN_MARKETS};
use serde_json::Value;

const CONFIG: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/hanji-config.json");
const FASTLANE: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/hanji-fastlane.json");
const XAUT_QUOTER: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/hanji-xaut-quoter.json");

const XAUT_CLOB: &str = "0xa49d9ea941e4adb7e60aeee49fd6c9fb122925ab";
const PROXY: &str = "0x88687E499846ce3037E63754a6e2E7B53483C70e";
const VAULT: &str = "0xff0cC147F4b9c9a92B865E47061Dbc55A5dAFAA6";

fn a(s: &str) -> Address {
    Address::from(parse_address(s).unwrap())
}

fn b32(s: &str) -> [u8; 32] {
    hex_bytes(s).unwrap().try_into().unwrap()
}

/// The fixture's getConfig rows: (market, address, answer), in its order.
fn fixture_configs() -> Vec<(String, String, BookConfig)> {
    let v: Value = serde_json::from_str(CONFIG).unwrap();
    v["markets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let r = |i: usize| m["result"][i].as_str().unwrap().to_string();
            let u = |i: usize| U256::from_str_radix(&r(i), 10).unwrap();
            let cfg = BookConfig {
                scaling_x: u(0),
                scaling_y: u(1),
                token_x: parse_address(&r(2)).unwrap(),
                token_y: parse_address(&r(3)).unwrap(),
                taker_fee_rate: u(9),
            };
            (m["market"].as_str().unwrap().to_string(), m["address"].as_str().unwrap().to_string(), cfg)
        })
        .collect()
}

fn registry() -> &'static Registry {
    Registry::get()
}

fn discovered() -> Hanji {
    Hanji::with_configs(registry(), fixture_configs().into_iter().map(|c| c.2).collect()).unwrap()
}

/// USDC is the quote leg: $1, so a fill's USD is its quote amount.
struct QuoteIsUsd;

impl Pricer for QuoteIsUsd {
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

/// Prices one token only.
struct Only(&'static str, f64);

impl Pricer for Only {
    fn usd_per_token(&self, t: &str) -> f64 {
        if t == self.0 {
            self.1
        } else {
            0.0
        }
    }
    fn usd_for_token(&self, t: &str, amount: f64) -> f64 {
        amount * self.usd_per_token(t)
    }
    fn pair_mid(&self, _: &str) -> f64 {
        0.0
    }
}

fn decode(h: &Hanji, pricer: &dyn Pricer, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
    let state = VenueState::default();
    h.decode(&DecodeCx { registry: registry(), pricer, state: &state }, block)
}

#[allow(clippy::too_many_arguments)]
fn order(
    owner: &str,
    initiator: &str,
    order_id: u64,
    is_ask: bool,
    quantity: u128,
    price: u128,
    passive_shares: u128,
    aggressive: (u128, u128, u128),
    market_only: bool,
) -> OrderPlaced {
    OrderPlaced {
        owner: a(owner),
        initiator: a(initiator),
        order_id,
        isAsk: is_ask,
        quantity,
        price: U72::from(price),
        passive_shares,
        passive_fee: 0,
        aggressive_shares: aggressive.0,
        aggressive_value: aggressive.1,
        aggressive_fee: aggressive.2,
        market_only,
        post_only: false,
    }
}

fn raw(address: &str, tx: &str, log_index: u32, ev: &OrderPlaced) -> FinalLog {
    let d = ev.encode_log_data();
    FinalLog {
        log_index,
        txn_index: 0,
        tx_hash: b32(tx),
        address: parse_address(address).unwrap(),
        topics: d.topics().iter().map(|t| t.0).collect(),
        data: d.data.to_vec(),
    }
}

fn block(number: u64, logs: Vec<FinalLog>) -> FinalBlock {
    FinalBlock {
        number,
        hash: [1; 32],
        parent_hash: [0; 32],
        timestamp: 1_760_445_001,
        proposal_ns: None,
        base_fee: 0,
        txns: Vec::new(),
        logs,
        origin: Origin::Rpc("fixture".into()),
    }
}

/// `toBeCloseTo(expected, digits)`.
fn close(got: f64, want: f64, digits: i32) -> bool {
    (got - want).abs() < 10f64.powi(-digits) / 2.0
}

/// monadscan tx 0x2f323e96…9811, block 113,327,335, log 790: the taker BOUGHT
/// 0.1689 XAUt for 699.428412 USDC gross (it paid gross + the 0.069943 fee).
const BUY_TX: &str = "0x2f323e96cdd3422886d9099145d4be146b3b68e4485f70a74f00ae6f2c9f9811";
fn buy() -> FinalLog {
    let ev = order(PROXY, PROXY, 0, false, 1689, 999_999_000_000_000_000_000, 0, (1689, 699_428_412, 69_943), true);
    raw(XAUT_CLOB, BUY_TX, 790, &ev)
}

/// tx 0x5921ef0b…2767, block 113,203,926, log 49: the taker SOLD 0.1203 XAUt
/// for 500.230257 USDC gross (it received gross − the 0.050024 fee).
const SELL_TX: &str = "0x5921ef0bc4239b5f93fd4f0b02ac5fd79ebd7c75ff1961848adc67b990f72767";
fn sell() -> FinalLog {
    let ev = order(PROXY, PROXY, 0, true, 1203, 414_987, 0, (1203, 500_230_257, 50_024), true);
    raw(XAUT_CLOB, SELL_TX, 49, &ev)
}

/// tx 0x30b7f99a…9a48, block 113,182,032, log 14: the XAUt vault resting a
/// bid, passive only, so not a trade.
fn vault_quote() -> FinalLog {
    let ev = order(VAULT, VAULT, 457_486_997_108_285_638, false, 3354, 416_081, 3354, (0, 0, 0), false);
    raw(XAUT_CLOB, "0x30b7f99aea99ca5a116b1bf28b43d9816069f2ebf319a9358d349c6878e69a48", 14, &ev)
}

#[test]
fn lists_the_xaut_book_and_tails_its_clob() {
    let h = discovered();
    assert!(h.markets().contains(&"XAUt/USDC".to_string()));
    assert!(h.watch().unwrap().logs.contains_key(&parse_address(XAUT_CLOB).unwrap()));
    assert!(h.entry_points().iter().any(|e| e.address == parse_address(PROXY).unwrap() && e.router.is_none()));
}

#[test]
fn decodes_a_buy_and_a_sell_in_shares_at_the_gross_usdc_value() {
    let h = discovered();
    let mut fills = decode(&h, &QuoteIsUsd, &block(113_327_335, vec![buy()])).unwrap();
    fills.extend(decode(&h, &QuoteIsUsd, &block(113_203_926, vec![sell()])).unwrap());
    // The vault's resting bid is not a trade.
    assert!(decode(&h, &QuoteIsUsd, &block(113_182_032, vec![vault_quote()])).unwrap().is_empty());
    assert_eq!(fills.len(), 2);
    let (b, s) = (&fills[0], &fills[1]);

    assert_eq!(b.id, format!("hanji-{BUY_TX}-790"));
    assert_eq!(b.venue_id, "hanji");
    assert_eq!(b.market, "XAUt/USDC");
    assert_eq!(b.side, Side::Buy);
    assert_eq!(b.category, FillCategory::Unknown);
    assert_eq!(b.block_number, 113_327_335);
    assert_eq!(b.ts, 1_760_445_001_000.0);
    assert_eq!(b.tx_hash, BUY_TX);
    assert_eq!(b.to, "0x8868…C70e", "checksummed initiator, as viem hands it");
    assert_eq!(b.pool, "lob 0xa49d9e", "the table's spelling of the CLOB");
    assert_eq!(b.router, None);
    assert!(!b.px_approx);
    assert_eq!(b.markouts_bps, vec![None; 5]);
    assert!(close(b.base_amount, 0.1689, 12), "{}", b.base_amount);
    assert!(close(b.usd, 699.428412, 9), "{}", b.usd);
    assert!(close(b.exec_px, 4141.0800, 3), "{}", b.exec_px);
    // Bit for bit as TypeScript: Number(shares) × (Number(scalingX) / 10 ** dec).
    assert_eq!(b.base_amount, 1689.0 * (100.0 / 1e6));
    assert_eq!(b.usd, 699_428_412.0 * (1.0 / 1e6));
    assert_eq!(b.exec_px, b.usd / b.base_amount);

    assert_eq!(s.id, format!("hanji-{SELL_TX}-49"));
    assert_eq!(s.market, "XAUt/USDC");
    assert_eq!(s.side, Side::Sell);
    assert!(close(s.base_amount, 0.1203, 12), "{}", s.base_amount);
    assert!(close(s.usd, 500.230257, 9), "{}", s.usd);
    assert!(close(s.exec_px, 4158.1900, 3), "{}", s.exec_px);
}

/// Monad block 124766671, OrderPlaced log 167: the wrapper Transfer into the
/// CLOB is 95200000000000000 wei and the USDC payout 67612846 after fees.
#[test]
fn decodes_a_wmux_sale_in_wrapper_units_at_the_gross_usdc_execution_price() {
    let h = discovered();
    let ev = order(
        "0x0000000000000000000000000000000000000000",
        "0x403A596d1E9e0ed4b7b2fEcD2c22580CD5388AB7",
        0,
        true,
        0,
        1,
        0,
        (952, 67_619_608, 6762),
        false,
    );
    let log = raw(
        "0x16ec8f28325b6dbf171c28056814a1f3bafb5100",
        "0xc6627e8b42f106d02117ff1372b7451e22a46a5a166026c5c258163499f0a2ca",
        167,
        &ev,
    );
    let fills = decode(&h, &QuoteIsUsd, &block(124_766_671, vec![log])).unwrap();
    assert_eq!(fills.len(), 1);
    let f = &fills[0];
    assert_eq!(f.market, "wMUx/USDC");
    assert_eq!(f.side, Side::Sell);
    assert_eq!(f.pool, "lob 0x16EC8F");
    assert_eq!(f.to, "0x403A…8AB7");
    assert!(close(f.base_amount, 0.0952, 12), "{}", f.base_amount);
    assert!(close(f.usd, 67.619608, 9), "{}", f.usd);
    assert!(close(f.exec_px, 67.619608 / 0.0952, 9), "{}", f.exec_px);
}

/// A MON/ETH trade (both legs crypto): the quote leg's USD, else the base
/// leg's, else the block fails closed.
#[test]
fn a_crypto_quoted_trade_falls_back_to_the_base_leg_then_fails_closed() {
    let h = discovered();
    let mon_eth = "0xBe717AEdc2cdc0a4d3903B7A6a70691942E72793";
    // MON/ETH: scalingX 1e14 → a share is 1e-4 MON; scalingY 100 → a value
    // unit is 1e-16 ETH. 100 MON for 0.025 ETH.
    let ev = order(PROXY, PROXY, 0, false, 0, 0, 0, (1_000_000, 250_000_000_000_000, 0), true);
    let blk = block(1, vec![raw(mon_eth, BUY_TX, 3, &ev)]);
    let (base, quote) = (1_000_000.0 * (1e14 / 1e18), 250_000_000_000_000.0 * (100.0 / 1e18));
    let f = decode(&h, &Only("WETH", 3000.0), &blk).unwrap();
    assert_eq!((f[0].base_amount, f[0].exec_px), (base, quote / base));
    assert_eq!(f[0].usd, quote * 3000.0);
    let f = decode(&h, &Only("WMON", 0.03), &blk).unwrap();
    assert_eq!(f[0].usd, base * 0.03);
    assert!(matches!(decode(&h, &NoPrices, &blk), Err(VenueError::Decode(_))));
}

#[test]
fn skips_malformed_and_unwatched_logs() {
    let h = discovered();
    let mut bad = buy();
    bad.data.truncate(64);
    let mut elsewhere = buy();
    elsewhere.address = [0x11; 20];
    let fills = decode(&h, &QuoteIsUsd, &block(1, vec![bad, elsewhere, sell()])).unwrap();
    assert_eq!(fills.len(), 1);
    assert_eq!(fills[0].side, Side::Sell);
}

// Discovery commits a complete, validated set (hanji.discovery.test.ts).

#[derive(Clone, Copy, Debug)]
enum Failure {
    Partial,
    Empty,
    Tokens,
    Transport,
}

fn answers(failure: Option<Failure>) -> Vec<Result<BookConfig, VenueError>> {
    match failure {
        Some(Failure::Empty) => Vec::new(),
        _ => fixture_configs()
            .into_iter()
            .enumerate()
            .map(|(i, (_, _, mut c))| match failure {
                Some(Failure::Partial) if i == 2 => Err(VenueError::Chain("one market unavailable".into())),
                Some(Failure::Tokens) if i == 2 => {
                    c.token_x = [0; 20];
                    Ok(c)
                }
                _ => Ok(c),
            })
            .collect(),
    }
}

async fn discover(h: &Hanji, failure: Option<Failure>) -> Result<(), VenueError> {
    match failure {
        // A batch that never reaches a node: discovery fails before it can
        // admit anything.
        Some(Failure::Transport) => {
            let rpc = Rpc::new("down", "unreachable://rpc", std::time::Duration::from_secs(1));
            h.discover(&ChainCx { rpc: &rpc, registry: registry() }).await
        }
        f => h.apply(registry(), answers(f)),
    }
}

fn watched(h: &Hanji) -> HashSet<[u8; 20]> {
    h.watch().unwrap().logs.keys().copied().collect()
}

#[test]
fn the_table_is_the_fixture() {
    let fx = fixture_configs();
    assert_eq!(KNOWN_MARKETS.len(), fx.len());
    for (k, (market, address, _)) in KNOWN_MARKETS.iter().zip(&fx) {
        assert_eq!(k.market, market);
        assert_eq!(k.clob.to_lowercase(), address.to_lowercase());
    }
}

#[tokio::test]
async fn preserves_every_admitted_market_and_fill_source_after_a_failed_discovery() {
    let markets: Vec<String> = fixture_configs().into_iter().map(|c| c.0).collect();
    let clobs: HashSet<[u8; 20]> = fixture_configs().iter().map(|c| parse_address(&c.1).unwrap()).collect();
    for failure in [Failure::Partial, Failure::Empty, Failure::Tokens, Failure::Transport] {
        let h = Hanji::default();
        discover(&h, None).await.unwrap();
        assert_eq!(h.markets(), markets);
        assert_eq!(watched(&h), clobs);
        let sources = h.watch().unwrap();
        assert!(discover(&h, Some(failure)).await.is_err(), "{failure:?}");
        assert_eq!(h.markets(), markets, "{failure:?}");
        assert_eq!(h.watch().unwrap(), sources, "{failure:?}");
        assert_eq!(h.entry_points()[2].address, parse_address(KNOWN_MARKETS[2].proxy).unwrap());
        discover(&h, None).await.unwrap();
        assert_eq!(h.markets(), markets);
        assert_eq!(h.watch().unwrap(), sources);
    }
}

#[tokio::test]
async fn does_not_admit_a_partial_first_discovery_then_recovers_all_registered_markets() {
    let h = Hanji::default();
    let e = discover(&h, Some(Failure::Partial)).await.unwrap_err();
    assert!(e.to_string().contains("Hanji getConfig failed"), "{e}");
    assert!(h.markets().is_empty());
    assert_eq!(h.watch().unwrap_err(), VenueError::NotReady("Hanji discovery unavailable".into()));
    discover(&h, None).await.unwrap();
    assert_eq!(h.markets(), fixture_configs().into_iter().map(|c| c.0).collect::<Vec<_>>());
    assert_eq!(h.watch().unwrap().logs.len(), fixture_configs().len());
}

#[test]
fn a_token_layout_that_differs_from_the_table_is_rejected() {
    let e = Hanji::default().apply(registry(), answers(Some(Failure::Tokens))).unwrap_err();
    assert!(e.to_string().contains("cbBTC/USDC: on-chain tokens"), "{e}");
}

#[test]
fn discovery_reads_scaling_and_fee_from_the_config() {
    let h = discovered();
    let fills = decode(&h, &QuoteIsUsd, &block(1, vec![buy()])).unwrap();
    assert_eq!(fills[0].base_amount, 1689.0 * 1e-4);
    // Fees are 1bp on every book (1e14 at 1e18 scale).
    for (_, _, c) in fixture_configs() {
        assert_eq!(c.taker_fee_rate, U256::from(100_000_000_000_000u64));
    }
}

// FastQuoter generations and the FastLane route (hanji.quoters.test.ts).

/// Every generation, oldest first, as verified on-chain: each pushes
/// updatePrices(uint256) and answers owner() with 0xA24D2aF7….
const GENERATIONS: [&str; 9] = [
    "0xd637b38f8436fc4974ce9236d65888a1bac64160",
    "0x04fdeac24e4e57364b4f22844106583d88f747d7",
    "0x48cba27861983367c3fb063877b144a628e2b48b",
    "0x91855e7930044a8f13f10b336abf551f1f58ac7e",
    "0xeae24c729ee1a38554037e4ad25ef1e3c9e30be0",
    "0x103de0b5226a2a6d8b918d8192dc23248825bb55",
    "0xbb3f3cb75f3a652a3ee47c5cacceef794874e046",
    "0xf5b5f7f8ef84419c030dfc44771734810ea36d70",
    "0x125f12a1938b97f11fdc35b1a5fb4d5217cda50b",
];
const XAUT: &str = "0x1fb37a1e6dc03a523bba106cb25e398e8608a010";
const STOCKS: &str = "0x02fe828a897b18ea37fa477436a8013578a3aa96";
const STOCKS_2: &str = "0xae5b4a1775f05b8818209e35c01630feac99b60b";
const HANDLER: &str = "0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58";
/// Same selector, own fleet, another owner, concurrent with gen1.
const NOT_HANJI: &str = "0xc1ff9fefdd86735bb14286caa796f72d90f4b0fc";

fn gas() -> GasSources {
    Hanji::default().gas_sources().unwrap().unwrap()
}

#[test]
fn tracks_every_generation_plus_the_xaut_and_xstock_quoters() {
    let g = gas();
    let want: Vec<[u8; 20]> =
        GENERATIONS.iter().chain(&[XAUT, STOCKS, STOCKS_2]).map(|s| parse_address(s).unwrap()).collect();
    assert_eq!(g.destinations, want);
    assert!(!g.destinations.contains(&parse_address(NOT_HANJI).unwrap()));
    assert_eq!(g.destinations.iter().collect::<HashSet<_>>().len(), g.destinations.len());
    assert!(g.logs.is_empty(), "updates emit no logs");
}

#[test]
fn the_fastlane_relay_and_its_calldata_are_watched() {
    let g = gas();
    assert_eq!(g.relays.len(), 1);
    assert_eq!(g.relays[0].address, parse_address(HANDLER).unwrap());
    assert_eq!(g.relays[0].selector, [0x0c, 0x7a, 0xbd, 0x22]);
    assert_eq!(g.relays[0].target_word, 5);
    let targets: HashSet<[u8; 20]> = g.relays[0].targets.iter().copied().collect();
    let want: HashSet<[u8; 20]> =
        [GENERATIONS[8], XAUT, STOCKS, STOCKS_2].iter().map(|s| parse_address(s).unwrap()).collect();
    assert_eq!(targets, want, "only gen8+ quoters carry fastLaneCall");
    let w = discovered().watch().unwrap();
    assert!(w.txn_input.contains(&parse_address(HANDLER).unwrap()));
    assert!(g.destinations.iter().all(|d| w.txn_input.contains(d)));
}

/// A relay rule as the core applies it: `to`, the selector, and the static
/// word naming one of the relay's targets.
fn relayed(tx: &Value, g: &GasSources) -> bool {
    let to = parse_address(tx["to"].as_str().unwrap()).unwrap();
    let input = hex_bytes(tx["input"].as_str().unwrap()).unwrap();
    g.relays.iter().any(|r| {
        let at = 4 + 32 * r.target_word;
        r.address == to
            && input.len() >= at + 32
            && input[..4] == r.selector
            && input[at..at + 12].iter().all(|b| *b == 0)
            && r.targets.iter().any(|d| d[..] == input[at + 12..at + 32])
    })
}

#[test]
fn counts_relayed_bids_naming_a_hanji_quoter_reverted_ones_too() {
    let g = gas();
    let fx: Value = serde_json::from_str(FASTLANE).unwrap();
    let fxx: Value = serde_json::from_str(XAUT_QUOTER).unwrap();
    for t in [&fx["g8ok"], &fx["g8rev"], &fxx["xok"], &fxx["xrev"]] {
        assert!(relayed(t, &g), "{}", t["hash"]);
    }
    assert_eq!(fx["g8rev"]["status"], "0x0");
    assert_eq!(fxx["xrev"]["status"], "0x0");
    // Another searcher's bid on the shared handler never counts.
    assert_eq!(fx["other"]["to"], HANDLER);
    assert!(!relayed(&fx["other"], &g));
    // Direct pushes are matched by `to`.
    for t in [&fx["direct"], &fxx["xdirect"]] {
        assert!(!relayed(t, &g));
        assert!(g.destinations.contains(&parse_address(t["to"].as_str().unwrap()).unwrap()));
    }
}

#[test]
fn meta_and_history_as_today() {
    let h = Hanji::default();
    let m = &h.meta()[0];
    assert_eq!((m.id.as_str(), m.name.as_str()), ("hanji", "Hanji pAMM Vault"));
    assert_eq!((m.color.light.as_str(), m.color.dark.as_str()), ("#A21CAF", "#C026D3"));
    assert_eq!((m.kind, m.role), (VenueKind::Clob, VenueRole::Venue));
    assert_eq!(m.since_utc.as_deref(), Some("2026-06-05"));
    assert_eq!(h.history_from_utc(), Some("2026-06-05"));
    let revs = h.history_revisions();
    let ids: Vec<&str> = revs.iter().map(|r| r.id).collect();
    assert_eq!(ids, ["replay-0921-midnight", "xaut-book", "wrapped-xstocks", "wrapped-xstocks-2"]);
    assert_eq!(revs[1].markets, ["XAUt/USDC"]);
    assert_eq!(revs[3].from, Some("2026-11-19"));
    assert!(matches!(h.watch(), Err(VenueError::NotReady(_))));
    assert_eq!(h.entry_points().len(), 17);
}
