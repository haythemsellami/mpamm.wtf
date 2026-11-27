//! Ported from server/src/venues/__tests__/lunarbase.decode.test.ts: real
//! Monad SwapExecuted fixtures, the monotonic state cache, and discovery's
//! read-failure vs misconfiguration rules (the quoting cases are in
//! lunarbase_quote.rs).
//! Expected numbers are today's adapter's own outputs, bit for bit.

use std::collections::HashMap;

use alloy_primitives::{address, aliases::U160, Address, LogData, U256};
use alloy_sol_types::SolEvent;
use mpamm_core::{DecodeCx, FinalBlock, FinalLog, NoPrices, Origin, Venue, VenueError, VenueState};
use mpamm_registry::Registry;
use mpamm_types::{FillCategory, Side};
use mpamm_venues::lunarbase::{self, *};

const TS_S: u64 = 1_783_679_000;
const RECIPIENT: Address = address!("fb78Fcae443eB423b59B8C186518c5dF94416344");

fn b32(s: &str) -> [u8; 32] {
    let h = s.strip_prefix("0x").unwrap();
    let mut out = [0u8; 32];
    for (i, c) in h.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap();
    }
    out
}

fn log_of(address: Address, data: LogData, tx: &str, log_index: u32) -> FinalLog {
    FinalLog {
        log_index,
        txn_index: 0,
        tx_hash: b32(tx),
        address: address.into_array(),
        topics: data.topics().iter().map(|t| t.0).collect(),
        data: data.data.to_vec(),
    }
}

fn swap(x_to_y: bool, dx: u128, dy: u128, fee: u128, tx: &str, log_index: u32) -> FinalLog {
    let e = SwapExecuted {
        recipient: RECIPIENT,
        xToY: x_to_y,
        dx: U256::from(dx),
        dy: U256::from(dy),
        fee: U256::from(fee),
    };
    log_of(MON_POOL, e.encode_log_data(), tx, log_index)
}

const SELL_TX: &str = "0x75879d7d4fb3fc6380e1ca16404765853d4d693adaebb0d1f7d5e524daad342c";
const BUY_TX: &str = "0x5cbc98f4a7aa9abe704656a7dbce129bc189ecb611d97988666cc2af0b271338";

fn mon_sell() -> FinalLog {
    swap(true, 9_923_973_000_000_000_000_000, 225_999_389, 31_566, SELL_TX, 102)
}
fn mon_buy() -> FinalLog {
    swap(false, 14_593_103_441_529_868_288_115, 328_865_790, 12_626_737_983_444_994_440, BUY_TX, 17)
}

fn config() -> PoolConfig {
    production_pools(Registry::get()).remove(0)
}

#[test]
fn decodes_mon_x_to_y_as_a_base_sell_with_18_6_decimals() {
    let f = decode_swap(&mon_sell(), &config(), 86_807_396, 1.0).unwrap();
    assert_eq!(f.side, Side::Sell);
    assert_eq!(f.market, "MON/USDC");
    // today's adapter, bit for bit
    assert_eq!(f.base_amount.to_bits(), 0x40c361fc8b439581);
    assert_eq!(f.usd.to_bits(), 0x406c3ffafea3df6e);
    assert_eq!(f.exec_px.to_bits(), 0x3f9751d33e8706fc);
    assert!((f.base_amount - 9_923.973).abs() < 1e-9);
    assert!((f.usd - 225.999389).abs() < 1e-9);
    assert!((f.exec_px - 0.022773075763104153).abs() < 1e-15);
    assert_eq!(f.id, format!("lunarbase-{SELL_TX}-102"));
    assert_eq!(f.pool, "lunarbase 0x0000a8");
    assert_eq!(f.block_number, 86_807_396);
}

#[test]
fn decodes_mon_y_to_x_as_a_base_buy() {
    let f = decode_swap(&mon_buy(), &config(), 86_798_698, 1.0).unwrap();
    assert_eq!(f.side, Side::Buy);
    assert_eq!(f.base_amount.to_bits(), 0x40cc808d3d9271eb);
    assert_eq!(f.usd.to_bits(), 0x40748dda469d7343);
    assert_eq!(f.exec_px.to_bits(), 0x3f9713992cc0a004);
    assert!((f.base_amount - 14_593.103441529868).abs() < 1e-9);
    assert!((f.usd - 328.86579).abs() < 1e-9);
    assert_eq!(f.id, format!("lunarbase-{BUY_TX}-17"));
}

#[test]
fn does_not_invent_attribution_from_the_recipient_field() {
    let f = decode_swap(&mon_sell(), &config(), 86_807_396, 1.0).unwrap();
    assert_eq!(f.category, FillCategory::Unknown);
    assert_eq!(f.to, "0xfb78…6344");
    assert_eq!(f.router, None);
    assert_eq!(f.markouts_bps, vec![None; 5]);
}

#[test]
fn skips_unknown_pools_and_malformed_logs_locally() {
    let mut other = mon_sell();
    other.address = [0; 20];
    other.address[19] = 1;
    assert!(decode_swap(&other, &config(), 1, 1.0).is_none());
    let mut malformed = mon_sell();
    malformed.data.truncate(64); // { xToY: true } and nothing else
    assert!(decode_swap(&malformed, &config(), 1, 1.0).is_none());
    // zero legs are not trades
    assert!(decode_swap(&swap(true, 0, 5, 0, SELL_TX, 1), &config(), 1, 1.0).is_none());
}

fn cached_pool() -> CachedPool {
    let mut c = config();
    c.base_dec = 0;
    c.stable_dec = 0;
    let mut implementation = [0u8; 20];
    implementation[19] = 0x10;
    CachedPool {
        config: c,
        snapshot: Snapshot {
            block_number: 100,
            implementation,
            anchor_price: U256::from(1u8) << 96,
            fee_ask_x24: 0,
            fee_bid_x24: 0,
            latest_update_block: 100,
            reserve_x: U256::from(1_000_000u64),
            reserve_y: U256::from(1_000_000u64),
            concentration_k: 4_000,
            block_delay: 10,
            paused: false,
            blacklist_fee_multiplier: U256::from(100u8),
            whitelist_probe: true,
        },
        last_applied: LogPos { block: 100, log_index: u64::MAX },
        needs_rediscovery: false,
    }
}

fn pools_of(p: &CachedPool) -> HashMap<[u8; 20], CachedPool> {
    HashMap::from([(p.config.pool, p.clone())])
}

fn state_log(data: LogData, log_index: u32) -> FinalLog {
    log_of(MON_POOL, data, SELL_TX, log_index)
}

#[test]
fn applies_an_absolute_sync_once_without_mutating_the_input() {
    let initial = cached_pool();
    let sync = state_log(Sync { reserveX: 1_000_000, reserveY: 2_000_000 }.encode_log_data(), 2);
    let once = apply_state_logs(&pools_of(&initial), &[StateLog { block: 101, log: &sync }]);
    let updated = &once[&initial.config.pool];
    assert_eq!(updated.snapshot.reserve_y, U256::from(2_000_000u64));
    assert_eq!(initial.snapshot.reserve_y, U256::from(1_000_000u64), "staged, then committed");
    let twice = apply_state_logs(&once, &[StateLog { block: 101, log: &sync }]);
    assert_eq!(twice[&initial.config.pool].snapshot, updated.snapshot);
}

#[test]
fn never_lets_historical_state_logs_roll_a_pinned_snapshot_backwards() {
    let initial = cached_pool();
    let old = state_log(Sync { reserveX: 1, reserveY: 1 }.encode_log_data(), 9);
    let staged = apply_state_logs(&pools_of(&initial), &[StateLog { block: 99, log: &old }]);
    assert_eq!(staged[&initial.config.pool].snapshot.reserve_x, U256::from(1_000_000u64));
}

#[test]
fn sorts_state_events_and_invalidates_the_cache_on_an_upgrade() {
    let initial = cached_pool();
    let anchor = (U256::from(1u8) << 96) + U256::from(7u8);
    let upgraded = state_log(Upgraded { implementation: Address::ZERO }.encode_log_data(), 4);
    let paused = state_log(Paused { account: Address::ZERO }.encode_log_data(), 3);
    let updated = state_log(
        StateUpdated {
            anchorPrice: U160::from(anchor),
            feeAskX24: 10u32.try_into().unwrap(),
            feeBidX24: 20u32.try_into().unwrap(),
        }
        .encode_log_data(),
        2,
    );
    let logs = [
        StateLog { block: 104, log: &upgraded },
        StateLog { block: 103, log: &paused },
        StateLog { block: 102, log: &updated },
    ];
    let staged = apply_state_logs(&pools_of(&initial), &logs);
    let p = &staged[&initial.config.pool];
    assert_eq!(p.snapshot.anchor_price, anchor);
    assert_eq!(p.snapshot.fee_ask_x24, 10);
    assert_eq!(p.snapshot.fee_bid_x24, 20);
    assert_eq!(p.snapshot.latest_update_block, 102);
    assert!(p.snapshot.paused);
    assert!(p.needs_rediscovery);
    assert_eq!(p.last_applied, LogPos { block: 104, log_index: 4 });
}

#[test]
fn a_malformed_state_log_is_skipped_but_counts_as_applied() {
    let initial = cached_pool();
    let mut bad = state_log(Sync { reserveX: 5, reserveY: 5 }.encode_log_data(), 1);
    bad.data.truncate(10);
    let staged = apply_state_logs(&pools_of(&initial), &[StateLog { block: 101, log: &bad }]);
    let p = &staged[&initial.config.pool];
    assert_eq!(p.snapshot.reserve_x, U256::from(1_000_000u64));
    assert_eq!(p.snapshot.block_number, 100);
    assert_eq!(p.last_applied, LogPos { block: 101, log_index: 1 });
}

#[test]
fn lists_only_mon_usdc_while_cbbtc_usdc_remains_test_only() {
    let pools = production_pools(Registry::get());
    assert_eq!(pools.iter().map(|p| p.market.as_str()).collect::<Vec<_>>(), ["MON/USDC"]);
    assert!(pools[0].base_is_x);
    assert_eq!((pools[0].base_dec, pools[0].stable_dec), (18, 6));
}

// A failed read is not a misconfiguration (issue #61): the 2026-08-14 RPC
// brownout read every failed call as a wrong value and quarantined the pool,
// which silently stopped it being tailed.

const IMPL_1: &str = "0x0000000000000000000000001111111111111111111111111111111111111111";
const IMPL_2: &str = "0x0000000000000000000000002222222222222222222222222222222222222222";
const ZERO_SLOT: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

/// A pool that passes every structural check (X is native MON, so only Y
/// has decimals).
fn healthy(slot: Option<&str>) -> PoolReads {
    let c = config();
    PoolReads {
        x: Some(c.expected_x),
        y: Some(c.expected_y),
        state: Some((U256::from(1_000_000u64), 100, 100, 400)),
        reserve_x: Some(U256::from(10u8).pow(U256::from(20u8))),
        reserve_y: Some(U256::from(10u8).pow(U256::from(8u8))),
        concentration_k: Some(1),
        block_delay: Some(10),
        paused: Some(false),
        blacklist_fee_multiplier: Some(U256::from(1u8)),
        whitelist_probe: Some(true),
        x_decimals: None,
        y_decimals: Some(c.stable_dec),
        implementation_slot: slot.map(b32),
    }
}

fn failed() -> PoolReads {
    PoolReads::default()
}

fn discover(v: &Lunarbase, reads: PoolReads, block: u64) {
    let c = config();
    let validation = validate(Registry::get(), &c, &reads, block);
    v.apply_discovery(block, vec![(c, validation)]);
}

fn tailed(v: &Lunarbase) -> Vec<[u8; 20]> {
    let mut a: Vec<[u8; 20]> = v.watch().unwrap().logs.keys().copied().collect();
    a.sort();
    a
}

#[test]
fn watch_and_gas_hold_until_discovery() {
    let v = Lunarbase::default();
    assert!(matches!(v.watch(), Err(VenueError::NotReady(_))));
    assert!(matches!(v.gas_sources(), Err(VenueError::NotReady(_))));
    discover(&v, healthy(Some(IMPL_1)), 500);
    assert_eq!(tailed(&v), [config().pool]);
    let gas = v.gas_sources().unwrap().unwrap();
    // StateUpdated is today's CURRENT_STATE_TOPIC.
    let topic = b32("0x8acb811d2c5106785f847faf03ce160d2eb124b8632eb42d466f46c087033d61");
    assert_eq!(gas.logs, vec![(config().pool, topic)]);
    assert!(gas.destinations.is_empty() && gas.relays.is_empty());
    let w = v.watch().unwrap();
    assert!(w.wants_log(&config().pool, Some(&topic)), "the gas topic is copied");
    assert_eq!(v.entry_points().iter().map(|e| e.address).collect::<Vec<_>>(), [config().pool]);
    assert_eq!(v.meta()[0], lunarbase::meta());
    assert_eq!(v.history_from_utc(), Some("2026-04-30"));
}

#[test]
fn keeps_an_unreadable_pool_in_the_tail_set_instead_of_quarantining_it() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_1)), 500);
    assert_eq!(tailed(&v).len(), 1);
    discover(&v, failed(), 500); // brownout: every read fails
    assert_eq!(tailed(&v).len(), 1, "still tailed, not dropped");
}

#[test]
fn does_not_replace_a_newer_cached_implementation_with_an_older_snapshot() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_2)), 502);
    discover(&v, healthy(Some(IMPL_1)), 500);
    let p = v.pool(&config().pool).unwrap();
    assert_eq!(p.snapshot.block_number, 502);
    assert_eq!(p.snapshot.implementation, [0x22; 20]);
    assert!(v.raised().is_empty());
}

#[test]
fn ignores_an_obsolete_invalid_or_failed_rediscovery_instead_of_quarantining_a_newer_pool() {
    for older in [healthy(Some(ZERO_SLOT)), failed()] {
        let v = Lunarbase::default();
        discover(&v, healthy(Some(IMPL_1)), 502);
        discover(&v, older, 500);
        assert!(v.raised().is_empty());
        assert_eq!(tailed(&v), [config().pool]);
    }
}

#[test]
fn reports_the_outage_as_unreadable_not_as_a_config_mismatch() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_1)), 500);
    discover(&v, failed(), 500);
    assert_eq!(v.raised(), [format!("unread:{MON_POOL_STR}")]);
}

#[test]
fn still_quarantines_a_zero_implementation_slot() {
    // The slot RESOLVED empty (non-proxy, or wrong slot): a misconfiguration.
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_1)), 500);
    discover(&v, healthy(Some(ZERO_SLOT)), 500);
    assert_eq!(v.raised(), [format!("quarantine:{MON_POOL_STR}")]);
    assert!(tailed(&v).is_empty(), "dropped, correctly");
    assert_eq!(v.gas_sources(), Ok(None));
}

#[test]
fn retains_only_previously_admitted_markets_through_quarantine_and_recovery() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(ZERO_SLOT)), 500);
    assert!(v.markets().is_empty());
    discover(&v, healthy(Some(IMPL_1)), 500);
    assert_eq!(v.markets(), ["MON/USDC"]);
    discover(&v, healthy(Some(ZERO_SLOT)), 500);
    assert_eq!(v.markets(), ["MON/USDC"]);
    assert!(tailed(&v).is_empty());
    discover(&v, healthy(Some(IMPL_1)), 500);
    assert_eq!(v.markets(), ["MON/USDC"]);
    assert_eq!(tailed(&v), [config().pool]);
}

#[test]
fn a_quarantine_holds_against_an_older_rediscovery_and_lifts_on_a_newer_one() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_1)), 500);
    discover(&v, healthy(Some(ZERO_SLOT)), 502);
    assert!(tailed(&v).is_empty());
    assert_eq!(v.markets(), ["MON/USDC"]);
    discover(&v, healthy(Some(IMPL_1)), 501);
    assert!(tailed(&v).is_empty(), "an older snapshot can't re-admit it");
    discover(&v, healthy(Some(IMPL_1)), 503);
    assert_eq!(tailed(&v), [config().pool]);
}

#[test]
fn retracts_the_unreadable_warning_once_the_pool_reads_again() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_1)), 500);
    discover(&v, failed(), 500);
    assert_eq!(v.raised().len(), 1);
    discover(&v, healthy(Some(IMPL_1)), 500);
    assert!(v.raised().is_empty());
}

#[test]
fn validation_reasons_match_todays() {
    let r = Registry::get();
    let c = config();
    let mut wrong_y = healthy(Some(IMPL_1));
    wrong_y.y = Some([0x11; 20]);
    assert_eq!(
        validate(r, &c, &wrong_y, 1),
        Validation::Invalid(format!(
            "token order mismatch: X=0x0000000000000000000000000000000000000000 Y=0x{}",
            "11".repeat(20)
        ))
    );
    let mut dec = healthy(Some(IMPL_1));
    dec.y_decimals = Some(18);
    assert_eq!(validate(r, &c, &dec, 1), Validation::Invalid("decimals mismatch: X=18 Y=18".into()));
    let mut anchor = healthy(Some(IMPL_1));
    anchor.state = Some((U256::ZERO, 1, 1, 1));
    assert_eq!(validate(r, &c, &anchor, 1), Validation::Invalid("anchorPrice unset".into()));
    let mut wl = healthy(Some(IMPL_1));
    wl.whitelist_probe = Some(false);
    assert_eq!(
        validate(r, &c, &wl, 1),
        Validation::Invalid("whitelist caller 0x0000000000000000000000000000000000000000 is unavailable".into())
    );
    let mut no_slot = healthy(None);
    no_slot.implementation_slot = None;
    assert!(matches!(validate(r, &c, &no_slot, 1), Validation::Unreadable(_)));
    // paused is not a misconfiguration (the pool is paused today and still tailed)
    let mut paused = healthy(Some(IMPL_1));
    paused.paused = Some(true);
    assert!(matches!(validate(r, &c, &paused, 1), Validation::Valid(_)));
}

fn block(number: u64, logs: Vec<FinalLog>) -> FinalBlock {
    FinalBlock {
        number,
        hash: [0; 32],
        parent_hash: [0; 32],
        timestamp: TS_S,
        proposal_ns: None,
        base_fee: 0,
        txns: Vec::new(),
        logs,
        origin: Origin::Rpc("test".into()),
    }
}

fn decode(v: &Lunarbase, b: &FinalBlock) -> Vec<mpamm_types::Fill> {
    let state = VenueState::default();
    v.decode(&DecodeCx { registry: Registry::get(), pricer: &NoPrices, state: &state }, b).unwrap()
}

#[test]
fn the_venue_decodes_swaps_of_admitted_pools_only() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_1)), 86_000_000);
    let fills = decode(&v, &block(86_807_396, vec![mon_sell()]));
    assert_eq!(fills.len(), 1);
    assert_eq!(fills[0], decode_swap(&mon_sell(), &config(), 86_807_396, TS_S as f64 * 1000.0).unwrap());
    assert_eq!(fills[0].ts, TS_S as f64 * 1000.0);
    // quarantined: nothing decodes
    discover(&v, healthy(Some(ZERO_SLOT)), 86_900_000);
    assert!(decode(&v, &block(86_900_001, vec![mon_buy()])).is_empty());
}

#[test]
fn an_upgrade_quarantines_the_pool_and_drops_that_blocks_swaps_until_rediscovery() {
    let v = Lunarbase::default();
    discover(&v, healthy(Some(IMPL_1)), 100);
    let up = state_log(Upgraded { implementation: Address::ZERO }.encode_log_data(), 1);
    let fills = decode(&v, &block(101, vec![mon_sell(), up]));
    assert!(fills.is_empty(), "the block's swaps from an upgraded pool are not counted");
    assert!(tailed(&v).is_empty());
    assert_eq!(v.raised(), [format!("quarantine:{MON_POOL_STR}")]);
    assert!(decode(&v, &block(102, vec![mon_buy()])).is_empty());
    // a historical Upgraded (at or before the pinned snapshot) changes nothing
    discover(&v, healthy(Some(IMPL_2)), 200);
    assert_eq!(tailed(&v), [config().pool]);
    let old_up = state_log(Upgraded { implementation: Address::ZERO }.encode_log_data(), 1);
    assert_eq!(decode(&v, &block(150, vec![mon_buy(), old_up])).len(), 1);
    assert_eq!(tailed(&v), [config().pool]);
}
