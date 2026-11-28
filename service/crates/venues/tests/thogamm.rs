//! ThogAMM, ported from server/src/venues/__tests__/thogamm.decode.test.ts
//! and thogamm.gas.test.ts: the same real logs and fixtures, the same
//! expected numbers.

use std::collections::{HashMap, HashSet};

use alloy_primitives::{address, b256, Address, U256};
use alloy_sol_types::SolEvent;
use mpamm_core::{
    DecodeCx, FinalBlock, FinalLog, FinalTxn, Origin, Pricer, RevisionSource, Venue, VenueError, VenueState,
};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{Addr, TopicFilter};
use mpamm_types::{FillCategory, Side};
use mpamm_venues::{
    thogamm::{
        index_markets, markets_for_tokens, select_pool_id, upgrade_note, CategoryMetadata, MakerPageUpdated,
        MakerSwapExecuted, MakerTokenAdded, MakerTokenRetired, Thogamm, TokenMetadata, Upgraded, ID, PROXY,
    },
    util::to_addr,
};
use serde_json::Value;

const XSTOCK_FILL: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/thogamm-xstock-fill.json");
const PARAMS_PUSHED: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/thogamm-params-pushed.json");

fn reg() -> &'static Registry {
    Registry::get()
}

fn tok(key: &str) -> Address {
    Address::from(reg().tokens[key].address_bytes())
}

/// USD per whole token: stables at $1, the rest from the table (0 = no price).
struct Stub(HashMap<&'static str, f64>);

impl Pricer for Stub {
    fn usd_per_token(&self, key: &str) -> f64 {
        if reg().tokens.get(key).is_some_and(|t| t.stable) {
            return 1.0;
        }
        self.0.get(key).copied().unwrap_or(0.0)
    }
    fn usd_for_token(&self, key: &str, amount: f64) -> f64 {
        amount * self.usd_per_token(key)
    }
    fn pair_mid(&self, _: &str) -> f64 {
        0.0
    }
}

/// The TS test's stub prices.
fn prices() -> Stub {
    Stub(HashMap::from([
        ("WMON", 0.021),
        ("WETH", 3_800.0),
        ("WBTC", 118_000.0),
        ("CBBTC", 118_000.0),
        ("XAUT0", 4_350.0),
    ]))
}

fn block(number: u64, ts_ms: u64, logs: Vec<FinalLog>) -> FinalBlock {
    FinalBlock {
        number,
        hash: [1; 32],
        parent_hash: [0; 32],
        timestamp: ts_ms / 1000,
        proposal_ns: None,
        base_fee: 0,
        txns: Vec::new(),
        logs,
        origin: Origin::Rpc("test".into()),
    }
}

fn log_of<E: SolEvent>(e: &E, tx_hash: [u8; 32], log_index: u32) -> FinalLog {
    let d = e.encode_log_data();
    FinalLog {
        log_index,
        txn_index: 0,
        tx_hash,
        address: to_addr(PROXY),
        topics: d.topics().iter().map(|t| t.0).collect(),
        data: d.data.to_vec(),
    }
}

fn decode(v: &Thogamm, p: &dyn Pricer, b: &FinalBlock) -> Result<Vec<mpamm_types::Fill>, VenueError> {
    let state = VenueState::default();
    v.decode(&DecodeCx { registry: reg(), pricer: p, state: &state }, b)
}

/// The only MakerSwapExecuted in ThogAMM's history when the adapter was
/// written: block 90,433,928, log 50, 2026-07-26 08:08:16 UTC; 0.01 WMON in,
/// 0.000210 USDC out.
const REAL_TX: [u8; 32] = b256!("a7d17be22f83bb43b6fd983bdbf924a8ad5eb5eaf5ea1d89fa1572d4f9bc151f").0;
const REAL_BLOCK: u64 = 90_433_928;
const REAL_TS: u64 = 1_785_053_296_000;

fn real_swap() -> MakerSwapExecuted {
    MakerSwapExecuted {
        tokenIn: tok("WMON"),
        tokenOut: tok("USDC"),
        sender: address!("d364e667df69f393ae080a18236c4bcb8be7b4db"),
        recipient: address!("d364e667df69f393ae080a18236c4bcb8be7b4db"),
        amountIn: U256::from(10_000_000_000_000_000u64),
        amountOut: U256::from(210u64),
        quoteAgeBlocks: U256::from(1u64),
        inventoryPenaltyUsdWad: U256::from(60_845_104_272u64),
    }
}

/// ThogAMM's live registry as of 2026-09-15: 8 tokens.
fn live_tokens() -> Vec<Addr> {
    ["USDC", "AUSD", "USDT0", "WMON", "WETH", "WBTC", "CBBTC", "XAUT0"].iter().map(|k| to_addr(tok(k))).collect()
}

const STOCKS: [&str; 5] = ["SPYX", "QQQX", "EWYX", "NVDAX", "TSLAX"];

/// The 13-token registry of 2026-10-27.
fn current_tokens() -> Vec<Addr> {
    let mut t = live_tokens();
    t.extend(STOCKS.iter().map(|k| to_addr(tok(k))));
    t
}

#[test]
fn follows_a_sole_rotated_pool_id_and_rejects_zero_or_many() {
    let v1 = b256!("ce389e78282dedac7b18ba7f775b7602d2ab3ab171bbd6711eb0239be6ef4dcc");
    let v2 = b256!("2222222222222222222222222222222222222222222222222222222222222222");
    assert_eq!(select_pool_id(&[v1]).unwrap(), v1);
    assert_eq!(select_pool_id(&[v2]).unwrap(), v2);
    let e = select_pool_id(&[]).unwrap_err().to_string();
    assert!(e.contains("expected exactly one pool id, got 0"), "{e}");
    let e = select_pool_id(&[v1, v2]).unwrap_err().to_string();
    assert!(e.contains("expected exactly one pool id, got 2"), "{e}");
}

#[test]
fn lists_every_registered_pair_the_live_registry_supports() {
    let markets = markets_for_tokens(reg(), &live_tokens());
    let names: Vec<&str> = markets.iter().map(|m| m.market.as_str()).collect();
    assert_eq!(
        names,
        [
            "MON/USDC",
            "BTC/USDC",
            "ETH/USDC",
            "MON/USDT0",
            "MON/AUSD",
            "BTC/USDT0",
            "BTC/AUSD",
            "ETH/USDT0",
            "ETH/AUSD",
            "cbBTC/USDC",
            "cbBTC/USDT0",
            "cbBTC/AUSD",
            "MON/ETH",
            "BTC/MON",
            "BTC/ETH",
            "cbBTC/MON",
            "cbBTC/ETH",
            "WBTC/cbBTC",
            "XAUt/USDC",
            "XAUt/USDT0",
            "XAUt/AUSD",
            "XAUt/MON",
            "XAUt/ETH",
            "XAUt/BTC",
            "XAUt/cbBTC",
        ]
    );
    let used: HashSet<Addr> = markets.iter().flat_map(|m| [m.base, m.quote]).collect();
    assert_eq!(used, live_tokens().into_iter().collect());
    assert_eq!(index_markets(&markets).unwrap().len(), 50);

    let without_xaut: Vec<Addr> = live_tokens().into_iter().filter(|a| *a != to_addr(tok("XAUT0"))).collect();
    assert!(!markets_for_tokens(reg(), &without_xaut).iter().any(|m| m.market.contains("XAUt")));
}

#[test]
fn decodes_exact_units_side_price_and_id() {
    let v = Thogamm::with_tokens(reg(), &live_tokens()).unwrap();
    let b = block(REAL_BLOCK, REAL_TS, vec![log_of(&real_swap(), REAL_TX, 50)]);
    let fills = decode(&v, &prices(), &b).unwrap();
    assert_eq!(fills.len(), 1);
    let f = &fills[0];
    assert_eq!(f.id, "thogamm-0xa7d17be22f83bb43b6fd983bdbf924a8ad5eb5eaf5ea1d89fa1572d4f9bc151f-50");
    assert_eq!(f.venue_id, ID);
    assert_eq!(f.market, "MON/USDC");
    assert_eq!(f.side, Side::Sell);
    assert_eq!(f.category, FillCategory::Unknown);
    assert_eq!(f.usd, 0.00021);
    assert_eq!(f.base_amount, 0.01);
    assert_eq!(f.exec_px, 0.021);
    assert_eq!(f.tx_hash, "0xa7d17be22f83bb43b6fd983bdbf924a8ad5eb5eaf5ea1d89fa1572d4f9bc151f");
    // Checksummed as viem decodes a real log (the TS test hand-wrote the
    // args in lower case, so it reads "0xd364…b4db").
    assert_eq!(f.to, "0xD364…B4db");
    assert_eq!(f.pool, "thogamm 0x80c74517");
    assert_eq!(f.block_number, REAL_BLOCK);
    assert_eq!(f.ts, REAL_TS as f64);
    assert_eq!(f.markouts_bps, vec![None; 5]);
    assert!(!f.px_approx && f.router.is_none());
}

#[test]
fn skips_an_unknown_pair_or_a_zero_amount_without_holding() {
    let v = Thogamm::with_tokens(reg(), &live_tokens()).unwrap();
    let unknown = MakerSwapExecuted { tokenOut: tok("USD1"), ..real_swap() };
    let zero = MakerSwapExecuted { amountOut: U256::ZERO, ..real_swap() };
    let mut malformed = log_of(&real_swap(), REAL_TX, 52);
    malformed.data.truncate(40);
    let b = block(REAL_BLOCK, REAL_TS, vec![log_of(&unknown, REAL_TX, 50), log_of(&zero, REAL_TX, 51), malformed]);
    assert_eq!(decode(&v, &prices(), &b).unwrap(), vec![]);
}

#[test]
fn notes_each_upgrade_and_tolerates_a_malformed_one() {
    let up = |impl_: Address, i| log_of(&Upgraded { implementation: impl_ }, [0xaa; 32], i);
    // Labels are checksummed, as viem decodes a real log.
    let note = upgrade_note(&up(address!("127a5b18e3e96fc104f5eaf280dfe502dd3fd40a"), 1)).to_lowercase();
    assert!(note.contains("proxy upgraded"), "{note}");
    assert!(note.contains("0x127a…d40a"), "{note}");
    assert!(note.contains("re-verify"), "{note}");
    let note = upgrade_note(&up(address!("aea051d2d7c0f4a5b6d3e2f1a0b9c8d7e6f5a4b3"), 0));
    assert!(note.contains("0xAEA0…A4B3"), "{note}");
    let mut bad = up(Address::ZERO, 0);
    bad.topics.truncate(1);
    assert!(upgrade_note(&bad).contains("an unreadable implementation"));

    // An upgrade in the block never stops its fills.
    let v = Thogamm::with_tokens(reg(), &live_tokens()).unwrap();
    let b = block(
        REAL_BLOCK,
        REAL_TS,
        vec![up(address!("127a5b18e3e96fc104f5eaf280dfe502dd3fd40a"), 1), bad, log_of(&real_swap(), REAL_TX, 50)],
    );
    assert_eq!(decode(&v, &prices(), &b).unwrap().len(), 1);
}

#[test]
fn holds_on_a_fill_before_discovery_and_lets_an_empty_block_pass() {
    let undiscovered = Thogamm::default();
    let b = block(REAL_BLOCK, REAL_TS, vec![log_of(&real_swap(), REAL_TX, 50)]);
    assert_eq!(decode(&undiscovered, &prices(), &b), Err(VenueError::NotReady("ThogAMM discovery unavailable".into())));
    // Today's adapter re-reads the chain when an upgrade arrives with the
    // fill; decode reads no chain here, so it holds until discovery instead.
    let up = log_of(&Upgraded { implementation: address!("127a5b18e3e96fc104f5eaf280dfe502dd3fd40a") }, [0xaa; 32], 1);
    let b2 = block(REAL_BLOCK, REAL_TS, vec![up, log_of(&real_swap(), REAL_TX, 50)]);
    assert!(matches!(decode(&undiscovered, &prices(), &b2), Err(VenueError::NotReady(_))));

    // The sources are static, so the watch set is known before discovery and
    // a block carrying no swap of ours advances.
    let w = undiscovered.watch().unwrap();
    let TopicFilter::Topics(topics) = &w.logs[&to_addr(PROXY)] else { panic!("topic filter") };
    assert_eq!(topics.len(), 7);
    assert!(topics.contains(&MakerSwapExecuted::SIGNATURE_HASH.0));
    assert_eq!(decode(&undiscovered, &prices(), &block(REAL_BLOCK, REAL_TS, vec![])).unwrap(), vec![]);

    let discovered = Thogamm::with_tokens(reg(), &live_tokens()).unwrap();
    let fills = decode(&discovered, &prices(), &b).unwrap();
    assert_eq!(fills.len(), 1);
    assert_eq!((fills[0].market.as_str(), fills[0].side, fills[0].base_amount), ("MON/USDC", Side::Sell, 0.01));
}

#[test]
fn covers_all_75_non_stable_crosses_of_the_13_token_registry() {
    let markets = markets_for_tokens(reg(), &current_tokens());
    assert_eq!(markets.len(), 75);
    assert_eq!(index_markets(&markets).unwrap().len(), 150);
    let stocks: Vec<_> = markets.iter().filter(|m| STOCKS.contains(&m.base_key.as_str())).collect();
    assert_eq!(stocks.len(), 50);
    assert!(stocks.iter().all(|m| m.base_dec == 18));
}

/// The first real xStock fill (fixtures/thogamm-xstock-fill.json): block
/// 117,225,577, log 58, 2026-10-28 04:01:21 UTC. 1e-6 WMON in, 28,143,588 raw
/// SPYx (18 decimals) out: 35,532 MON per SPYx, about $775.
#[test]
fn decodes_the_first_real_xstock_fill_from_its_recorded_log() {
    let fx: Value = serde_json::from_str(XSTOCK_FILL).unwrap();
    let tx: [u8; 32] = fx["transactionHash"].as_str().unwrap().parse::<alloy_primitives::B256>().unwrap().0;
    let l = &fx["log"];
    let log = FinalLog {
        log_index: l["logIndex"].as_u64().unwrap() as u32,
        txn_index: 0,
        tx_hash: tx,
        address: parse_address(l["address"].as_str().unwrap()).unwrap(),
        topics: l["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().parse::<alloy_primitives::B256>().unwrap().0)
            .collect(),
        data: mpamm_core::block::hex_bytes(l["data"].as_str().unwrap()).unwrap(),
    };
    // The subscribed ABI decodes it, and its amounts are what actually moved.
    let topics = log.topics.iter().map(|t| alloy_primitives::B256::from(*t));
    let e = MakerSwapExecuted::decode_raw_log(topics, &log.data).unwrap();
    assert_eq!(e.amountIn, U256::from(1_000_000_000_000u64));
    assert_eq!(e.amountOut, U256::from(28_143_588u64));
    let moved = |token: Address| {
        let t = fx["transfers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["token"].as_str().unwrap().eq_ignore_ascii_case(&token.to_string()))
            .unwrap();
        U256::from_str_radix(t["value"].as_str().unwrap(), 10).unwrap()
    };
    assert_eq!(moved(tok("WMON")), e.amountIn);
    assert_eq!(moved(tok("SPYX")), e.amountOut);

    let v = Thogamm::with_tokens(reg(), &current_tokens()).unwrap();
    let ts = fx["timestamp"].as_u64().unwrap() * 1000;
    let number: u64 = fx["blockNumber"].as_str().unwrap().parse().unwrap();
    let fills = decode(&v, &prices(), &block(number, ts, vec![log])).unwrap();
    assert_eq!(fills.len(), 1);
    let f = &fills[0];
    assert_eq!(f.id, format!("thogamm-{}-58", fx["transactionHash"].as_str().unwrap()));
    assert_eq!((f.market.as_str(), f.side, f.block_number), ("SPYx/MON", Side::Buy, 117_225_577));
    assert_eq!(f.ts, 1_793_160_081_000.0, "2026-10-28T04:01:21Z");
    assert!((f.base_amount - 28_143_588.0 / 1e18).abs() < 1e-25);
    assert!((f.exec_px - 1e-6 / (28_143_588.0 / 1e18)).abs() < 1e-6, "MON per SPYx");
    assert!(f.exec_px * 0.0218 > 700.0 && f.exec_px * 0.0218 < 850.0, "≈ $775: 18-decimal units hold");
    assert!((f.usd - 1e-6 * 0.021).abs() < 1e-15, "its MON leg, at the stub price");
}

#[test]
fn decodes_rebased_xstock_units_without_an_issuer_multiplier() {
    let v = Thogamm::with_tokens(reg(), &current_tokens()).unwrap();
    let s = MakerSwapExecuted {
        tokenIn: tok("SPYX"),
        tokenOut: tok("USDC"),
        amountIn: U256::from(1_234_567_890_123_456_789u128),
        amountOut: U256::from(950_617_275u64),
        ..real_swap()
    };
    let f = &decode(&v, &prices(), &block(REAL_BLOCK, 0, vec![log_of(&s, REAL_TX, 50)])).unwrap()[0];
    assert_eq!((f.market.as_str(), f.side), ("SPYx/USDC", Side::Sell));
    assert!((f.base_amount - 1.234_567_890_123_456_7).abs() < 1e-14);
    assert_eq!(f.usd, 950.617275);
    assert!((f.exec_px - 950.617275 / 1.234_567_890_123_456_7).abs() < 1e-10);
}

/// Both legs of an xStock/xStock fill price from Kraken alone: a closed
/// market values it at its last good price (the pricer's job); it holds only
/// if Kraken never answered.
#[test]
fn values_an_xstock_cross_from_its_quote_leg_and_holds_without_any_price() {
    let v = Thogamm::with_tokens(reg(), &current_tokens()).unwrap();
    let s = MakerSwapExecuted {
        tokenIn: tok("QQQX"),
        tokenOut: tok("SPYX"),
        amountIn: U256::from(2_000_000_000_000_000_000u128),
        amountOut: U256::from(1_000_000_000_000_000_000u128),
        ..real_swap()
    };
    let b = block(REAL_BLOCK, 0, vec![log_of(&s, REAL_TX, 50)]);
    let closed = Stub(HashMap::from([("SPYX", 770.0), ("QQQX", 720.0)]));
    let f = &decode(&v, &closed, &b).unwrap()[0];
    assert_eq!(f.market, "QQQx/SPYx");
    assert_eq!(f.usd, 770.0);
    // Base leg only.
    let base_only = Stub(HashMap::from([("QQQX", 720.0)]));
    assert_eq!(decode(&v, &base_only, &b).unwrap()[0].usd, 1440.0);
    let e = decode(&v, &Stub(HashMap::new()), &b).unwrap_err().to_string();
    assert!(e.contains("no USD price for either fill leg"), "{e}");
}

fn added(token: Address, index: u8) -> FinalLog {
    let e = MakerTokenAdded {
        tokenIndex: index,
        token,
        metadata: TokenMetadata { token, decimals: 18, ..Default::default() },
        categoryMetadata: CategoryMetadata::default(),
        balance: U256::ZERO,
    };
    log_of(&e, [0xbb; 32], u32::from(index))
}

fn retired(token: Address) -> FinalLog {
    log_of(&MakerTokenRetired { retiredIndex: 3, token, movedFrom: 12, generation: 1 }, [0xcc; 32], 0)
}

#[test]
fn follows_registry_events_stops_quoting_retired_tokens_and_keeps_their_decode_table() {
    let v = Thogamm::with_tokens(reg(), &live_tokens()).unwrap();
    assert!(!v.markets().contains(&"SPYx/USDC".to_string()));

    let adds: Vec<FinalLog> = STOCKS.iter().enumerate().map(|(i, k)| added(tok(k), 8 + i as u8)).collect();
    // A fill in the same block as the add decodes.
    let spy = MakerSwapExecuted {
        tokenIn: tok("SPYX"),
        tokenOut: tok("USDC"),
        amountIn: U256::from(10u128.pow(18)),
        amountOut: U256::from(700_000_000u64),
        ..real_swap()
    };
    let mut logs = adds;
    logs.push(log_of(&spy, REAL_TX, 60));
    let fills = decode(&v, &prices(), &block(REAL_BLOCK, 0, logs)).unwrap();
    assert_eq!(fills.len(), 1);
    assert_eq!(fills[0].market, "SPYx/USDC");
    assert!(v.markets().contains(&"SPYx/USDC".to_string()));
    assert_eq!(v.markets().len(), 75);

    let b = block(REAL_BLOCK + 1, 0, vec![retired(tok("WMON")), log_of(&real_swap(), REAL_TX, 50)]);
    let fills = decode(&v, &prices(), &b).unwrap();
    assert!(!v.markets().contains(&"MON/USDC".to_string()));
    assert_eq!(fills.len(), 1, "a retired token's market still decodes");
}

#[test]
fn replays_only_newly_tracked_markets() {
    let r = Thogamm::default().history_revisions();
    assert_eq!(r.len(), 4);
    assert_eq!((r[0].id, r[0].from), ("xstocks-usd-references", Some("2026-10-26")));
    // Today's list, in registry order (recorded from the TS adapter).
    let xstocks: Vec<&str> = "SPYx/USDC SPYx/USDT0 SPYx/AUSD SPYx/MON SPYx/ETH SPYx/XAUt SPYx/BTC SPYx/cbBTC \
         QQQx/USDC QQQx/USDT0 QQQx/AUSD QQQx/MON QQQx/ETH QQQx/XAUt QQQx/SPYx QQQx/BTC QQQx/cbBTC \
         EWYx/USDC EWYx/USDT0 EWYx/AUSD EWYx/MON EWYx/ETH EWYx/XAUt EWYx/SPYx EWYx/QQQx EWYx/BTC EWYx/cbBTC \
         NVDAx/USDC NVDAx/USDT0 NVDAx/AUSD NVDAx/MON NVDAx/ETH NVDAx/XAUt NVDAx/SPYx NVDAx/QQQx NVDAx/EWYx NVDAx/BTC \
         NVDAx/cbBTC TSLAx/USDC TSLAx/USDT0 TSLAx/AUSD TSLAx/MON TSLAx/ETH TSLAx/XAUt TSLAx/SPYx TSLAx/QQQx \
         TSLAx/EWYx TSLAx/NVDAx TSLAx/BTC TSLAx/cbBTC"
        .split_whitespace()
        .collect();
    let RevisionSource::Markets(markets) = r[0].source else { panic!("{:?}", r[0].source) };
    assert_eq!(markets, &xstocks[..]);
    assert_eq!(markets.len(), 50);
    assert_eq!(
        (r[1].id, r[1].from, r[1].source),
        ("xaut-wbtc-quote-basis", Some("2026-09-04"), RevisionSource::Markets(&["XAUt/BTC"]))
    );
    // Today's 'november-xstocks' and 'anthropic-xstock': every pair of those bases.
    let RevisionSource::Markets(nov) = r[2].source else { panic!("{:?}", r[2].source) };
    assert_eq!((r[2].id, r[2].from), ("november-xstocks", Some("2026-11-17")));
    // Each base pairs with 3 stables, MON/ETH/XAUt, BTC/cbBTC and every earlier xStock:
    // SMHx 13, SPCXx 14, MUx 15, SKHYx 16.
    assert_eq!(nov.len(), 58);
    assert!(nov.contains(&"SKHYx/USDC") && nov.contains(&"SMHx/SPYx") && !nov.iter().any(|m| m.starts_with("ANTx/")));
    let RevisionSource::Markets(ant) = r[3].source else { panic!("{:?}", r[3].source) };
    assert_eq!((r[3].id, r[3].from), ("anthropic-xstock", Some("2026-11-27")));
    assert!(ant.iter().all(|m| m.starts_with("ANTx/")) && ant.contains(&"ANTx/USDC"));
    assert_eq!(Thogamm::default().history_from_utc(), Some("2026-07-26"));
}

#[test]
fn entry_point_and_meta() {
    let v = Thogamm::default();
    assert_eq!(v.entry_points(), vec![mpamm_core::EntryPoint { address: to_addr(PROXY), router: None }]);
    let m = &v.meta()[0];
    assert_eq!((m.id.as_str(), m.name.as_str(), m.since_utc.as_deref()), ("thogamm", "ThogAMM", Some("2026-07-26")));
    assert_eq!((m.color.light.as_str(), m.color.dark.as_str()), ("#6D28D9", "#A78BFA"));
    assert!(m.quote_note.as_deref().unwrap().starts_with("ThogAMM shows the contract\u{2019}s read-only quote."));
}

// ---- gas (thogamm.gas.test.ts) ----

fn hex_u(s: &str) -> u128 {
    u128::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

#[test]
fn gas_tracks_only_the_proxy_by_its_push_events() {
    let g = Thogamm::default().gas_sources().unwrap().unwrap();
    assert!(g.destinations.is_empty() && g.relays.is_empty(), "logs mode: never by destination");
    assert_eq!(g.logs.len(), 3);
    assert!(g.logs.iter().all(|(a, _)| *a == to_addr(PROXY)));
    let topics: HashSet<[u8; 32]> = g.logs.iter().map(|(_, t)| *t).collect();
    // The pre-upgrade events stay, so a rebuild still reads 2026-10-22 before 22:21 UTC.
    assert!(topics.contains(&b256!("4297642da60dca19aa6bb6cee38e85c2c07cb520fe9513b94877a68ed0a61962").0));
    assert!(topics.contains(&b256!("48557a4086bd92501827d61122791730229612ecfc969f5a6c7bd857602db263").0));
    // The watch set copies every gas log.
    let w = Thogamm::default().watch().unwrap();
    for (a, t) in &g.logs {
        assert!(w.wants_log(a, Some(t)));
    }
}

#[test]
fn gas_matches_both_post_upgrade_keeper_paths_with_one_log_each() {
    let fx: Value = serde_json::from_str(PARAMS_PUSHED).unwrap();
    let g = Thogamm::default().gas_sources().unwrap().unwrap();
    let pushes = fx["pushes"].as_array().unwrap();
    assert_eq!(
        pushes.iter().map(|p| p["selector"].as_str().unwrap()).collect::<Vec<_>>(),
        ["0x59558d29", "0x4cb2db39"]
    );
    let proxy = format!("{PROXY:#x}").to_lowercase();
    let mut lanes = Vec::new();
    for p in pushes {
        assert_eq!(p["to"].as_str().unwrap(), proxy);
        assert_eq!(p["status"], "success");
        let hits: Vec<&Value> = p["logs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| {
                let t0 = l["topics"][0].as_str().unwrap().parse::<alloy_primitives::B256>().unwrap().0;
                l["address"].as_str().unwrap() == proxy && g.logs.iter().any(|(_, t)| *t == t0)
            })
            .collect();
        assert_eq!(hits.len(), 1);
        let topics = hits[0]["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().parse::<alloy_primitives::B256>().unwrap());
        let data = mpamm_core::block::hex_bytes(hits[0]["data"].as_str().unwrap()).unwrap();
        let e = MakerPageUpdated::decode_raw_log(topics, &data).unwrap();
        let lane_word = hits[0]["topics"][1].as_str().unwrap();
        assert_eq!(u128::from(e.lane), hex_u(lane_word));
        lanes.push(e.lane);
        // Monad charges the full limit; the ring's header gives the exact cost.
        assert_eq!(hex_u(p["gasUsed"].as_str().unwrap()), hex_u(p["gasLimit"].as_str().unwrap()));
    }
    // The indexed word is the push kind: 1 prices, 2 risk params.
    assert_eq!(lanes, [1, 2]);

    // Hand-checked cost at 112 gwei: 58,215 gas = 0.00652008 MON, 118,481 gas = 0.013269872 MON.
    let mon: Vec<f64> = pushes
        .iter()
        .map(|p| {
            let t = FinalTxn {
                index: 0,
                hash: [0; 32],
                from: [0; 20],
                to: Some(to_addr(PROXY)),
                kind: 0,
                gas_limit: hex_u(p["gasLimit"].as_str().unwrap()) as u64,
                max_fee_per_gas: hex_u(p["effectiveGasPrice"].as_str().unwrap()),
                max_priority_fee_per_gas: 0,
                input: Vec::new(),
            };
            t.cost_wei(0) as f64 / 1e18
        })
        .collect();
    assert!((mon[0] - 0.00652008).abs() < 1e-12);
    assert!((mon[1] - 0.013269872).abs() < 1e-12);
}
