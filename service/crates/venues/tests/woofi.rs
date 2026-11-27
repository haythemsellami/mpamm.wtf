//! WOOFi sPMM, ported from server/src/venues/__tests__/woofi.decode.test.ts:
//! REAL WooPPV2 logs recorded on Monad mainnet decode to the same trades,
//! and discovery lists, checks and persists as today against a stubbed
//! chain. Quote tests wait for the quote milestone.

// 18-decimal amounts are written out to the wei, as today's tests write them:
// the literal is the nearest double, which is what the decode must produce.
#![allow(clippy::excessive_precision)]

use std::collections::HashMap;

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolEvent;
use async_trait::async_trait;
use mpamm_core::{DecodeCx, FinalBlock, FinalLog, NoPrices, Origin, Venue, VenueError, VenueState};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{Addr, TopicFilter};
use mpamm_types::{Fill, FillCategory, Side};
use mpamm_venues::{
    util::to_addr,
    woofi::{
        decode_woofi_swap, read_observed_oracles, TokenListing, Upgraded, WooSwap, Woofi, WoofiMarkets, WoofiReads,
        KNOWN_WOORACLES, OBSERVED_ORACLES_KEY, WOOPP, WOO_ROUTER,
    },
};

fn reg() -> &'static Registry {
    Registry::get()
}

fn addr(s: &str) -> Addr {
    parse_address(s).unwrap()
}

fn b32(s: &str) -> [u8; 32] {
    mpamm_core::block::hex_bytes(s).unwrap().try_into().unwrap()
}

fn token(key: &str) -> Addr {
    reg().tokens[key].address_bytes()
}

struct Raw {
    topics: &'static [&'static str],
    data: &'static str,
    tx: &'static str,
    block: u64,
    log_index: u32,
}

fn log_of(r: &Raw) -> FinalLog {
    FinalLog {
        log_index: r.log_index,
        txn_index: 0,
        tx_hash: b32(r.tx),
        address: to_addr(WOOPP),
        topics: r.topics.iter().map(|t| b32(t)).collect(),
        data: mpamm_core::block::hex_bytes(r.data).unwrap(),
    }
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

/// block 117,035,771 · log 49: 0.998822850599321984 WETH in, 2,309.494943 USDC out.
const SELL_ETH: Raw = Raw {
    topics: &[
        "0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469",
        "0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242",
        "0x000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603",
        "0x0000000000000000000000005f500b990de962f56ae335d36df8e797d6a6aa52",
    ],
    data: "0x0000000000000000000000000000000000000000000000000ddc8817338401800000000000000000000000000000000000000000000000000000000089a8189f0000000000000000000000005f500b990de962f56ae335d36df8e797d6a6aa5200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000089a8189f0000000000000000000000000000000000000000000000000000000000000000",
    tx: "0x7631f8b8f959140c6a922eea2582fab9d3d4a8a5138c04e7dcba7a7a9084d0fa",
    block: 117_035_771,
    log_index: 49,
};
const SELL_ETH_TS: u64 = 1_793_102_350;

/// block 117,049,738 · log 62: 1,797.618155 USDC in, 0.772387288110366777 WETH out.
const BUY_ETH: Raw = Raw {
    topics: &[
        "0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469",
        "0x000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603",
        "0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242",
        "0x0000000000000000000000007db99f225af7a1a21b7b6468ed28f4bc60fbe937",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000006b2579eb0000000000000000000000000000000000000000000000000ab8122570d880390000000000000000000000007db99f225af7a1a21b7b6468ed28f4bc60fbe9370000000000000000000000007db99f225af7a1a21b7b6468ed28f4bc60fbe937000000000000000000000000000000000000000000000000000000006b2579eb0000000000000000000000000000000000000000000000000000000000000000",
    tx: "0x848dc895e1399a57242fc2e7fd3bb5ab60bb311d0eb9b0bfe813c9ace9f6cd7e",
    block: 117_049_738,
    log_index: 62,
};
const BUY_ETH_TS: u64 = 1_793_106_597;

/// BASE→BASE through WooRouterV2, block 117,033,565 · log 40: 0.088966323477787031
/// WETH in, 0.00257794 cbBTC out, swapVol 205.747543 USDC, no USDC transfer.
const WETH_TO_CBBTC: Raw = Raw {
    topics: &[
        "0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469",
        "0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242",
        "0x000000000000000000000000d18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
        "0x000000000000000000000000fb78fcae443eb423b59b8c186518c5df94416344",
    ],
    data: "0x000000000000000000000000000000000000000000000000013c12665bddb197000000000000000000000000000000000000000000000000000000000003ef020000000000000000000000004c4af8dbc524681930a27b2f1af5bcc8062e6fb70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c4375570000000000000000000000000000000000000000000000000000000000000000",
    tx: "0x8f233278f958a1cb07ba0da31bce7170b3c874f02fd863ac33e60ebbbe04c550",
    block: 117_033_565,
    log_index: 40,
};
const WETH_TO_CBBTC_TS: u64 = 1_793_101_684;

/// A FEE-PAYING sale before the May 2026 pause (feeRate 25), block 70,002,987 · log 11.
const FEE_SELL_ETH: Raw = Raw {
    topics: &[
        "0x0e8e403c2d36126272b08c75823e988381d9dc47f2f0a9a080d95f891d95c469",
        "0x000000000000000000000000ee8c0e9f1bffb4eb878d8f15f368a02a35481242",
        "0x000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603",
        "0x000000000000000000000000243e55d3233a2af3a8d92b1762296a5ad2c207a7",
    ],
    data: "0x000000000000000000000000000000000000000000000000012c2ecf587d75c6000000000000000000000000000000000000000000000000000000000bb93ccd0000000000000000000000004c4af8dbc524681930a27b2f1af5bcc8062e6fb7000000000000000000000000243e55d3233a2af3a8d92b1762296a5ad2c207a7000000000000000000000000000000000000000000000000000000000bb9fced000000000000000000000000000000000000000000000000000000000000c020",
    tx: "0x17a113f132fe96759540bafcfeb8cc8fa1b34eb6a25f905ab45148fc39cbd0f6",
    block: 70_002_987,
    log_index: 11,
};

/// The proxy's only Upgraded, in its creation tx (block 38,315,208).
const CREATION_UPGRADE: Raw = Raw {
    topics: &[
        "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
        "0x0000000000000000000000006aebc663dd6b8de86129e671baf68586fb0c8fcc",
    ],
    data: "0x",
    tx: "0x816f6058d9826fa532fc2252bece0fbf201a671dfcba6b31bfa8f54b98ac857a",
    block: 38_315_208,
    log_index: 1,
};

fn swap(r: &Raw) -> WooSwap {
    let l = log_of(r);
    WooSwap::decode_raw_log(l.topics.iter().map(|t| B256::from(*t)), &l.data).unwrap()
}

fn markets() -> WoofiMarkets {
    WoofiMarkets::new(reg())
}

fn fill_of(r: &Raw, ts_secs: u64) -> Option<Fill> {
    decode_woofi_swap(&markets(), &log_of(r), r.block, ts_secs as f64 * 1000.0)
}

/// A WooSwap log re-encoded with some fields changed.
fn patched(r: &Raw, f: impl FnOnce(&mut WooSwap)) -> FinalLog {
    let mut s = swap(r);
    f(&mut s);
    let e = s.encode_log_data();
    FinalLog { topics: e.topics().iter().map(|t| t.0).collect(), data: e.data.to_vec(), ..log_of(r) }
}

// ── the log source ──────────────────────────────────────────────────────────

#[test]
fn one_static_source_carrying_fills_and_upgrades_with_no_discovery_to_wait_on() {
    let w = Woofi::default().watch().unwrap();
    assert_eq!(w.logs.len(), 1);
    let topics = [b32(SELL_ETH.topics[0]), b32(CREATION_UPGRADE.topics[0])];
    assert_eq!(w.logs[&to_addr(WOOPP)], TopicFilter::Topics(topics.into()));
}

#[test]
fn decodes_the_recorded_logs_through_the_adapters_own_abi() {
    let sell = swap(&SELL_ETH);
    assert_eq!(sell.fromToken.to_string(), "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242");
    assert_eq!(sell.toToken.to_string(), "0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    assert_eq!(sell.fromAmount, U256::from(998_822_850_599_321_984u128));
    assert_eq!(sell.toAmount, U256::from(2_309_494_943u64));
    assert_eq!(sell.swapVol, U256::from(2_309_494_943u64));
    assert_eq!(sell.swapFee, U256::ZERO);
    let buy = swap(&BUY_ETH);
    assert_eq!((buy.fromAmount, buy.toAmount), (U256::from(1_797_618_155u64), U256::from(772_387_288_110_366_777u128)));
    let b2b = swap(&WETH_TO_CBBTC);
    assert_eq!((b2b.fromAmount, b2b.toAmount), (U256::from(88_966_323_477_787_031u128), U256::from(257_794u64)));
    assert_eq!(b2b.from.to_string(), "0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7");
    assert_eq!(b2b.from, WOO_ROUTER);
    assert_eq!(b2b.swapVol, U256::from(205_747_543u64));
    let l = log_of(&CREATION_UPGRADE);
    let up = Upgraded::decode_raw_log(l.topics.iter().map(|t| B256::from(*t)), &l.data).unwrap();
    assert_eq!(up.implementation.to_string(), "0x6AEBC663DD6B8De86129E671bAf68586fb0c8fcC");
}

// ── decodeWoofiSwap (real fixtures) ─────────────────────────────────────────

#[test]
fn decodes_a_base_to_usdc_sale_from_the_usdc_leg_actually_paid() {
    let f = fill_of(&SELL_ETH, SELL_ETH_TS).unwrap();
    assert_eq!(f.id, "woofi-0x7631f8b8f959140c6a922eea2582fab9d3d4a8a5138c04e7dcba7a7a9084d0fa-49");
    assert_eq!(f.venue_id, "woofi");
    assert_eq!(f.market, "ETH/USDC");
    assert_eq!(f.side, Side::Sell);
    assert_eq!(f.category, FillCategory::Unknown);
    assert_eq!(f.usd, 2309.494943);
    assert_eq!(f.base_amount, 0.998822850599321984);
    assert_eq!(f.exec_px, 2309.494943 / 0.998822850599321984);
    assert_eq!(f.tx_hash, SELL_ETH.tx);
    assert_eq!(f.to, "0x5F50…aA52");
    assert_eq!(f.pool, "woofi 0x5520385b");
    assert_eq!(f.block_number, 117_035_771);
    assert_eq!(f.ts, 1_793_102_350_000.0);
    assert_eq!(f.markouts_bps, vec![None; 5]);
    assert!(!f.px_approx && f.router.is_none());
    assert!((f.exec_px - 2312.2168).abs() < 5e-4);
}

#[test]
fn decodes_a_usdc_to_base_purchase() {
    let f = fill_of(&BUY_ETH, BUY_ETH_TS).unwrap();
    assert_eq!(f.id, "woofi-0x848dc895e1399a57242fc2e7fd3bb5ab60bb311d0eb9b0bfe813c9ace9f6cd7e-62");
    assert_eq!((f.market.as_str(), f.side, f.usd, f.block_number), ("ETH/USDC", Side::Buy, 1797.618155, 117_049_738));
    assert!((f.base_amount - 0.772387288110366777).abs() < 5e-16);
    assert!((f.exec_px - 1797.618155 / 0.772387288110366777).abs() < 5e-10);
    assert!((f.exec_px - 2327.3533).abs() < 5e-4);
}

#[test]
fn books_a_fee_paying_sale_at_the_usdc_the_taker_received() {
    let s = swap(&FEE_SELL_ETH);
    assert_eq!(
        (s.toAmount, s.swapVol, s.swapFee),
        (U256::from(196_689_101u64), U256::from(196_738_285u64), U256::from(49_184u64))
    );
    let f = fill_of(&FEE_SELL_ETH, 1_776_948_779).unwrap();
    assert_eq!((f.market.as_str(), f.side, f.usd, f.block_number), ("ETH/USDC", Side::Sell, 196.689101, 70_002_987));
    assert!((f.base_amount - 0.084493961090921926).abs() < 5e-16);
    assert!((f.exec_px - 196.689101 / 0.084493961090921926).abs() < 5e-10);
}

#[test]
fn prices_a_base_to_base_swap_in_pair_terms_with_swapvol_as_its_usd() {
    let f = fill_of(&WETH_TO_CBBTC, WETH_TO_CBBTC_TS).unwrap();
    assert_eq!(f.id, "woofi-0x8f233278f958a1cb07ba0da31bce7170b3c874f02fd863ac33e60ebbbe04c550-40");
    assert_eq!(f.market, "cbBTC/ETH");
    // ETH (the pair's quote) in, cbBTC (its base) out.
    assert_eq!(f.side, Side::Buy);
    assert_eq!(f.usd, 205.747543);
    assert_eq!(f.base_amount, 0.00257794);
    assert_eq!(f.exec_px, 0.088966323477787031 / 0.00257794);
    assert_eq!(f.to, "0xfb78…6344");
    assert!((f.exec_px - 34.5106).abs() < 5e-4);
}

#[test]
fn skips_unregistered_pairs_and_malformed_logs() {
    let m = markets();
    let dec = |l: &FinalLog| decode_woofi_swap(&m, l, SELL_ETH.block, 0.0);
    // stable↔stable has no base asset to benchmark
    let usdt0 = Address::from(token("USDT0"));
    let usdc = Address::from(token("USDC"));
    assert!(dec(&patched(&SELL_ETH, |s| {
        s.fromToken = usdc;
        s.toToken = usdt0;
    }))
    .is_none());
    // a token the registry doesn't know
    assert!(dec(&patched(&SELL_ETH, |s| s.fromToken = Address::repeat_byte(0x11))).is_none());
    assert!(dec(&patched(&SELL_ETH, |s| s.toAmount = U256::ZERO)).is_none());
    // another contract's log
    assert!(
        dec(&FinalLog { address: addr("0x0000000000000000000000000000000000000001"), ..log_of(&SELL_ETH) }).is_none()
    );
    assert!(decode_woofi_swap(&m, &log_of(&SELL_ETH), 0, 0.0).is_none());
    assert!(dec(&log_of(&CREATION_UPGRADE)).is_none());
    // A WooSwap whose data does not decode is skipped, never an error.
    assert!(dec(&FinalLog { data: vec![0; 10], ..log_of(&SELL_ETH) }).is_none());
    assert!(dec(&log_of(&SELL_ETH)).is_some());
}

// ── the registered-market table ─────────────────────────────────────────────

#[test]
fn covers_every_pair_the_pool_can_trade_among_its_listed_tokens() {
    let m = markets();
    let cases = [
        ("WMON", "USDC", "MON/USDC", "WMON"),
        ("WETH", "USDC", "ETH/USDC", "WETH"),
        ("WBTC", "USDC", "BTC/USDC", "WBTC"),
        ("CBBTC", "USDC", "cbBTC/USDC", "CBBTC"),
        ("WMON", "WETH", "MON/ETH", "WMON"),
        ("WBTC", "WMON", "BTC/MON", "WBTC"),
        ("WBTC", "WETH", "BTC/ETH", "WBTC"),
        ("CBBTC", "WMON", "cbBTC/MON", "CBBTC"),
        ("CBBTC", "WETH", "cbBTC/ETH", "CBBTC"),
        ("WBTC", "CBBTC", "WBTC/cbBTC", "WBTC"),
    ];
    for (a, b, market, base) in cases {
        // Direction never changes the market or which leg is the base.
        for got in [m.market_for(token(a), token(b)), m.market_for(token(b), token(a))] {
            let got = got.unwrap();
            assert_eq!((got.market.as_str(), got.base_key.as_str()), (market, base));
        }
    }
}

#[test]
fn never_resolves_native_mon_and_leaves_unregistered_crosses_out() {
    let native = token("MON");
    for m in markets().iter() {
        assert!(m.base != native && m.quote != native);
    }
    assert!(markets().market_for(token("USDC"), token("AUSD")).is_none());
}

// ── discovery against a stubbed pool ────────────────────────────────────────

/// Live pool state recorded 2026-10-27: WETH, WBTC, cbBTC and WMON listed
/// with a $50k notional cap and feeRate 0; every other token answers zero.
fn listed() -> HashMap<Addr, (u128, u64)> {
    HashMap::from([
        (token("WETH"), (50_000_000_000, 10u64.pow(18))),
        (token("WBTC"), (50_000_000_000, 10u64.pow(8))),
        (token("CBBTC"), (50_000_000_000, 10u64.pow(8))),
        (token("WMON"), (50_000_000_000, 10u64.pow(18))),
    ])
}

struct Stub {
    quote_token: Addr,
    oracle: Addr,
    listed: HashMap<Addr, (u128, u64)>,
}

impl Default for Stub {
    fn default() -> Self {
        Self {
            quote_token: token("USDC"),
            oracle: addr("0xf9b0c8Ee13AE2fC0665764ecbdB417685dEa8081"),
            listed: listed(),
        }
    }
}

#[async_trait]
impl WoofiReads for Stub {
    async fn block_number(&self) -> Result<u64, VenueError> {
        Ok(117_080_000)
    }
    async fn quote_token(&self, _: u64) -> Result<Addr, VenueError> {
        Ok(self.quote_token)
    }
    async fn wooracle(&self, _: u64) -> Result<Addr, VenueError> {
        Ok(self.oracle)
    }
    async fn token_infos(&self, tokens: &[Addr], _: u64) -> Result<Vec<Option<TokenListing>>, VenueError> {
        Ok(tokens
            .iter()
            .map(|t| {
                let cap = self.listed.get(t).map_or(0, |l| l.0);
                Some(TokenListing { fee_rate: 0, max_notional_swap: cap })
            })
            .collect())
    }
    async fn decimal_infos(&self, tokens: &[Addr], _: u64) -> Result<Vec<Option<(u64, u64, u64)>>, VenueError> {
        Ok(tokens.iter().map(|t| Some((100_000_000, 1_000_000, self.listed.get(t).map_or(0, |l| l.1)))).collect())
    }
}

const A: &str = "0x00000000000000000000000000000000000000aa";
const B: &str = "0x00000000000000000000000000000000000000bb";

fn known() -> Vec<Addr> {
    KNOWN_WOORACLES.iter().map(|a| to_addr(*a)).collect()
}

/// One block through decode, its state writes committed as the service does.
fn decode_commit(v: &Woofi, state: &mut VenueState, b: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
    let out = v.decode(&DecodeCx { registry: reg(), pricer: &NoPrices, state }, b);
    let writes = state.take_pending();
    if out.is_ok() {
        state.apply(&writes);
    }
    out
}

fn gas(v: &Woofi) -> Vec<Addr> {
    v.gas_sources().unwrap().unwrap().destinations
}

#[tokio::test]
async fn lists_the_10_registered_markets_its_four_live_base_tokens_span() {
    let v = Woofi::default();
    v.refresh(&Stub::default(), reg()).await.unwrap();
    let mut m = v.markets();
    m.sort();
    assert_eq!(
        m,
        [
            "BTC/ETH",
            "BTC/MON",
            "BTC/USDC",
            "ETH/USDC",
            "MON/ETH",
            "MON/USDC",
            "WBTC/cbBTC",
            "cbBTC/ETH",
            "cbBTC/MON",
            "cbBTC/USDC"
        ]
    );
}

#[tokio::test]
async fn fails_loud_on_a_quote_token_that_is_not_usdc() {
    let err = Woofi::default().refresh(&Stub { quote_token: token("USDT0"), ..Stub::default() }, reg()).await;
    assert!(err.unwrap_err().to_string().contains("not USDC"));
}

#[tokio::test]
async fn fails_loud_on_a_decimals_mismatch() {
    let mut l = listed();
    l.insert(token("WBTC"), (50_000_000_000, 10u64.pow(18)));
    let err = Woofi::default().refresh(&Stub { listed: l, ..Stub::default() }, reg()).await.unwrap_err();
    assert!(err.to_string().contains("WOOFi WBTC decimals mismatch (pool base 1e18, registry 8)"), "{err}");
    let err = Woofi::default().refresh(&Stub { listed: HashMap::new(), ..Stub::default() }, reg()).await.unwrap_err();
    assert!(err.to_string().contains("no registered markets"), "{err}");
}

#[tokio::test]
async fn holds_the_gas_sources_until_the_oracle_is_read_then_keeps_every_oracle() {
    let v = Woofi::default();
    let mut state = VenueState::default();
    assert!(matches!(v.gas_sources(), Err(VenueError::NotReady(m)) if m.contains("not resolved")));
    v.refresh(&Stub::default(), reg()).await.unwrap();
    // The persisted list is read by the next decode.
    assert!(v.gas_sources().is_err());
    decode_commit(&v, &mut state, &block(117_080_001, 1, vec![])).unwrap();
    assert_eq!(gas(&v), known());
    let w = v.watch().unwrap();
    assert!(known().iter().all(|o| w.txn_input.contains(o)));
}

#[tokio::test]
async fn adds_a_rotated_in_oracle_as_a_pure_addition() {
    let v = Woofi::default();
    let mut state = VenueState::default();
    v.refresh(&Stub { oracle: addr("0x00000000000000000000000000000000000000AA"), ..Stub::default() }, reg())
        .await
        .unwrap();
    decode_commit(&v, &mut state, &block(117_080_001, 1, vec![])).unwrap();
    assert_eq!(gas(&v), [known(), vec![addr(A)]].concat());
    assert_eq!(state.get("woofi", OBSERVED_ORACLES_KEY).as_deref(), Some(format!("[\"{A}\"]").as_str()));
}

#[tokio::test]
async fn keeps_every_oracle_across_successive_rotations_and_a_restart() {
    let mut state = VenueState::default();
    let before = Woofi::default();
    before.refresh(&Stub { oracle: addr(A), ..Stub::default() }, reg()).await.unwrap();
    decode_commit(&before, &mut state, &block(1, 1, vec![])).unwrap();
    before.refresh(&Stub { oracle: addr(B), ..Stub::default() }, reg()).await.unwrap(); // A rotated out
    decode_commit(&before, &mut state, &block(2, 1, vec![])).unwrap();
    assert_eq!(gas(&before), [known(), vec![addr(A), addr(B)]].concat());

    // Restart after the rotation: A is no longer live and not pinned, yet
    // dropping it would rebuild the series without its burn.
    let after = Woofi::default();
    after.refresh(&Stub { oracle: addr(B), ..Stub::default() }, reg()).await.unwrap();
    decode_commit(&after, &mut state, &block(3, 1, vec![])).unwrap();
    assert_eq!(gas(&after), [known(), vec![addr(A), addr(B)]].concat());
    let raw = state.get("woofi", OBSERVED_ORACLES_KEY);
    assert_eq!(read_observed_oracles(raw.as_deref()).unwrap(), [addr(A), addr(B)]);
}

/// A block whose commit fails takes its state write with it: the retry writes
/// the oracle again, so the persisted list never misses a live oracle.
#[tokio::test]
async fn a_failed_commit_rewrites_the_new_oracle() {
    let mut state = VenueState::default();
    let v = Woofi::default();
    v.refresh(&Stub { oracle: addr(A), ..Stub::default() }, reg()).await.unwrap();
    v.decode(&DecodeCx { registry: reg(), pricer: &NoPrices, state: &state }, &block(1, 1, vec![])).unwrap();
    state.take_pending(); // the block did not commit
    decode_commit(&v, &mut state, &block(1, 1, vec![])).unwrap();
    assert_eq!(read_observed_oracles(state.get("woofi", OBSERVED_ORACLES_KEY).as_deref()).unwrap(), [addr(A)]);
}

#[tokio::test]
async fn refuses_unreadable_persisted_state_rather_than_shrinking_the_set() {
    assert_eq!(read_observed_oracles(None).unwrap(), Vec::<Addr>::new());
    assert!(read_observed_oracles(Some("not json")).unwrap_err().contains("unreadable"));
    assert!(read_observed_oracles(Some("[\"0xAA\"]")).unwrap_err().contains("unreadable"));
    assert!(read_observed_oracles(Some(&format!("[\"{}\"]", A.to_uppercase().replace("0X", "0x")))).is_err());
    let mut state = VenueState::new(HashMap::from([(("woofi".into(), OBSERVED_ORACLES_KEY.into()), "{".into())]));
    let v = Woofi::default();
    v.refresh(&Stub::default(), reg()).await.unwrap();
    let err = decode_commit(&v, &mut state, &block(1, 1, vec![])).unwrap_err();
    assert!(err.to_string().contains("unreadable"), "{err}");
    assert!(matches!(v.gas_sources(), Err(VenueError::NotReady(_))));
}

// ── decode and proxy upgrades ───────────────────────────────────────────────

#[test]
fn decodes_fills_with_no_discovery_at_all() {
    let v = Woofi::default();
    let mut state = VenueState::default();
    let fills =
        decode_commit(&v, &mut state, &block(SELL_ETH.block, 1, vec![log_of(&SELL_ETH), log_of(&WETH_TO_CBBTC)]))
            .unwrap();
    assert_eq!(fills.iter().map(|f| f.market.as_str()).collect::<Vec<_>>(), ["ETH/USDC", "cbBTC/ETH"]);
}

#[test]
fn stays_silent_on_the_implementation_it_was_verified_against() {
    let v = Woofi::default();
    let mut state = VenueState::default();
    let b = block(SELL_ETH.block, 1, vec![log_of(&CREATION_UPGRADE), log_of(&SELL_ETH)]);
    assert_eq!(decode_commit(&v, &mut state, &b).unwrap().len(), 1);
}

fn other_upgrade() -> FinalLog {
    let mut l = log_of(&CREATION_UPGRADE);
    l.topics[1] = b32("0x000000000000000000000000127a5b18e3e96fc104f5eaf280dfe502dd3fd40a");
    l
}

/// Today the decode re-reads the layout on the spot; here the block waits
/// for a discovery pass read at or after it.
#[tokio::test]
async fn holds_any_other_implementation_until_discovery_has_rechecked_the_layout() {
    let v = Woofi::default();
    let mut state = VenueState::default();
    let at = |n: u64| block(n, 1, vec![other_upgrade(), log_of(&SELL_ETH)]);
    let err = decode_commit(&v, &mut state, &at(117_000_000)).unwrap_err();
    assert!(matches!(&err, VenueError::NotReady(m) if m.contains("0x127a…d40a")), "{err}");
    v.refresh(&Stub::default(), reg()).await.unwrap(); // read at block 117,080,000
    assert_eq!(decode_commit(&v, &mut state, &at(117_000_000)).unwrap().len(), 1);
    assert_eq!(decode_commit(&v, &mut state, &at(117_080_000)).unwrap().len(), 1);
    // An upgrade after the last pass holds again.
    assert!(decode_commit(&v, &mut state, &at(117_080_001)).is_err());
}

#[tokio::test]
async fn keeps_holding_when_an_upgrade_changed_the_quote_token() {
    let v = Woofi::default();
    let mut state = VenueState::default();
    assert!(v.refresh(&Stub { quote_token: token("USDT0"), ..Stub::default() }, reg()).await.is_err());
    assert!(matches!(
        decode_commit(&v, &mut state, &block(117_000_000, 1, vec![other_upgrade(), log_of(&SELL_ETH)])),
        Err(VenueError::NotReady(_))
    ));
}

#[test]
fn meta_entry_points_and_history() {
    let v = Woofi::default();
    let m = &v.meta()[0];
    assert_eq!((m.id.as_str(), m.name.as_str(), m.since_utc.as_deref()), ("woofi", "WOOFi sPMM", Some("2025-12-01")));
    assert_eq!((m.color.light.as_str(), m.color.dark.as_str()), ("#00613A", "#57B791"));
    assert_eq!(v.history_from_utc(), Some("2025-12-01"));
    assert!(v.history_revisions().is_empty());
    let eps = v.entry_points();
    assert_eq!(eps.len(), 2);
    assert_eq!((eps[0].address, eps[0].router.as_deref()), (to_addr(WOOPP), None));
    assert_eq!((eps[1].address, eps[1].router.as_deref()), (to_addr(WOO_ROUTER), Some("WOOFi")));
    let ids: Vec<String> = mpamm_venues::all().iter().map(|v| v.id().to_string()).collect();
    assert!(ids.iter().position(|i| i == "metric") < ids.iter().position(|i| i == "woofi"));
}
