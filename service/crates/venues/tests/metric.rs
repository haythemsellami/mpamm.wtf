//! Metric, both generations, ported from server/src/venues/__tests__/
//! metric.decode.test.ts and metric.discovery.test.ts: real recorded logs
//! (fixtures/metric.json) decode to the same trades, and discovery admits,
//! holds, merges and quotes as today against a stubbed chain.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolEvent;
use async_trait::async_trait;
use mpamm_core::{
    DecodeCx, FinalBlock, FinalLog, NoPrices, Origin, Pricer, RevisionSource, Venue, VenueError, VenueState,
};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{Addr, TopicFilter};
use mpamm_types::{Fill, FillCategory, QuoteRow, Side};
use mpamm_venues::{
    generations::{Generation, Generations},
    metric::{
        self,
        shared::{admit_pool, pool_liveness, Liveness, PoolTokens, Reject},
        v0::{MetricV0, V0_LAST_SWAP_BLOCK, V0_POOLS, V0_PUSH_ORACLE},
        v1::{
            announced_pool, unpack_amount_deltas, MetricV1, PoolImmutables, QuoteCall, Swap, V1Reads, V1_FACTORY,
            V1_FACTORY_BLOCK, V1_SIMPLE_ROUTER,
        },
    },
    util::to_addr,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../server/src/venues/__tests__/fixtures/metric.json");

fn fx() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

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

/// A raw eth_getLogs entry as the block carries it.
fn log_of(v: &Value) -> FinalLog {
    FinalLog {
        log_index: u32::from_str_radix(v["logIndex"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap(),
        txn_index: 0,
        tx_hash: b32(v["transactionHash"].as_str().unwrap()),
        address: addr(v["address"].as_str().unwrap()),
        topics: v["topics"].as_array().unwrap().iter().map(|t| b32(t.as_str().unwrap())).collect(),
        data: mpamm_core::block::hex_bytes(v["data"].as_str().unwrap()).unwrap(),
    }
}

fn block_of(v: &Value) -> FinalBlock {
    let number = u64::from_str_radix(v["blockNumber"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
    block(number, v["blockTimestamp"].as_u64().unwrap_or(0), vec![log_of(v)])
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

fn decode(v: &dyn Venue, b: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
    let state = VenueState::default();
    v.decode(&DecodeCx { registry: reg(), pricer: &NoPrices, state: &state }, b)
}

fn tx(v: &Value) -> String {
    v["transactionHash"].as_str().unwrap().to_string()
}

fn close(a: f64, b: f64, digits: i32) {
    assert!((a - b).abs() < 10f64.powi(-digits) / 2.0, "{a} vs {b} to {digits} digits");
}

// ── the stubbed chain (today's `stub`) ──────────────────────────────────────

const WMON_POOL: &str = "0xe6831acf980c2dfc5ae993f06b198d872fddf515"; // #6, funded
const WETH_POOL: &str = "0x22fcd163a8a317047ae64194baaa4c3857251e5f"; // #7, empty shell
const WANTX_POOL: &str = "0x035c19f38b2c391067e5aa9ade3644c9171fb71c"; // #11, share-wrapper base
const AUSD_POOL: &str = "0x94d5e3543a39c0ec1171f14a45100bd62bee49bc"; // #9, stable/stable
const ORACLE: &str = "0x30a88bf894d1b806125a23ebf23d715496fd7102";
const ORACLE_B: &str = "0xaaaa0000000000000000000000000000000000bb";

/// A pool's creation-time (and, by default, current) provider: today's
/// `'0xprov' + pool.slice(6)`.
fn prov_of(pool: Addr) -> Addr {
    let mut p = pool;
    p[0] = 0xee;
    p[1] = 0xee;
    p
}

type PoolFn<T> = Box<dyn Fn(Addr) -> T + Send + Sync>;
/// The quoter: (amount in used, amount out) or the leg's failure.
type QuoteFn = Box<dyn Fn(&QuoteCall) -> Result<(U256, U256), VenueError> + Send + Sync>;

struct Stub {
    pools: Vec<Addr>,
    tokens: HashMap<Addr, (Addr, Addr)>,
    balances: PoolFn<(u64, u64)>,
    price_fails: bool,
    unresolved: HashSet<Addr>,
    provider_fails: HashSet<Addr>,
    current_provider: PoolFn<Addr>,
    oracle_of: PoolFn<Option<Addr>>,
    /// Default: a full fill at 1:1.
    quote: QuoteFn,
    calls: Mutex<Vec<(&'static str, String)>>,
    /// Every quoter leg asked, with the block hash it was pinned to.
    legs: Mutex<Vec<(QuoteCall, [u8; 32])>>,
}

impl Stub {
    fn new(pools: &[&str]) -> Self {
        let tokens = HashMap::from([
            (addr(WMON_POOL), (token("WMON"), token("USDC"))),
            (addr(WETH_POOL), (token("WETH"), token("USDC"))),
            (addr(AUSD_POOL), (token("AUSD"), token("USDC"))),
            (addr(WANTX_POOL), (token("WANTX"), token("USDC"))),
        ]);
        Self {
            pools: pools.iter().map(|p| addr(p)).collect(),
            tokens,
            balances: Box::new(|_| (1_000, 1_000)),
            price_fails: false,
            unresolved: HashSet::new(),
            provider_fails: HashSet::new(),
            current_provider: Box::new(prov_of),
            oracle_of: Box::new(|_| Some(addr(ORACLE))),
            quote: Box::new(|c| Ok((c.amount_in, c.amount_in))),
            calls: Mutex::new(Vec::new()),
            legs: Mutex::new(Vec::new()),
        }
    }

    fn default_pools() -> Self {
        Self::new(&[WMON_POOL, WETH_POOL, AUSD_POOL])
    }

    fn record(&self, f: &'static str, what: String) {
        self.calls.lock().unwrap().push((f, what));
    }

    fn calls(&self, f: &str) -> Vec<String> {
        self.calls.lock().unwrap().iter().filter(|(c, _)| *c == f).map(|(_, w)| w.clone()).collect()
    }
}

fn hex(a: &Addr) -> String {
    mpamm_venues::util::addr_hex(a)
}

#[async_trait]
impl V1Reads for Stub {
    async fn next_pool_idx(&self) -> Result<u64, VenueError> {
        Ok(self.pools.len() as u64 + 1)
    }
    async fn idx_to_pool(&self, idxs: &[u64]) -> Result<Vec<Addr>, VenueError> {
        Ok(idxs
            .iter()
            .map(|i| {
                self.record("idxToPool", i.to_string());
                self.pools.get(*i as usize - 1).copied().unwrap_or_default()
            })
            .collect())
    }
    async fn immutables(&self, pools: &[Addr]) -> Result<Vec<Option<PoolImmutables>>, VenueError> {
        Ok(pools
            .iter()
            .map(|p| {
                self.record("getImmutables", hex(p));
                if self.unresolved.contains(p) {
                    return None;
                }
                let (token0, token1) = self.tokens.get(p).copied().unwrap_or((token("WMON"), token("USDC")));
                Some(PoolImmutables {
                    factory: to_addr(V1_FACTORY),
                    token0,
                    token1,
                    immutable_price_provider: prov_of(*p),
                })
            })
            .collect())
    }
    async fn price_providers(&self, pools: &[Addr]) -> Result<Vec<Option<Addr>>, VenueError> {
        Ok(pools
            .iter()
            .map(|p| {
                self.record("priceProvider", hex(p));
                (!self.provider_fails.contains(p)).then(|| (self.current_provider)(*p))
            })
            .collect())
    }
    async fn balances(&self, probes: &[(Addr, Addr)]) -> Result<Vec<Option<U256>>, VenueError> {
        Ok(probes
            .iter()
            .enumerate()
            .map(|(i, (t, pool))| {
                self.record("balanceOf", hex(t));
                let (b0, b1) = (self.balances)(*pool);
                Some(U256::from(if i % 2 == 0 { b0 } else { b1 }))
            })
            .collect())
    }
    async fn prices(&self, pools: &[Addr]) -> Result<Vec<Option<(u128, u128)>>, VenueError> {
        Ok(pools
            .iter()
            .map(|p| {
                self.record("getSellAndBuyPrices", hex(p));
                (!self.price_fails).then_some((100, 101))
            })
            .collect())
    }
    async fn offchain_oracles(&self, providers: &[Addr]) -> Result<Vec<Option<Addr>>, VenueError> {
        Ok(providers
            .iter()
            .map(|p| {
                self.record("offchainOracle", hex(p));
                (self.oracle_of)(*p)
            })
            .collect())
    }
    async fn quote_live(
        &self,
        legs: &[QuoteCall],
        block_hash: [u8; 32],
    ) -> Result<Vec<Result<(U256, U256), VenueError>>, VenueError> {
        self.legs.lock().unwrap().extend(legs.iter().map(|l| (*l, block_hash)));
        Ok(legs.iter().map(|l| (self.quote)(l)).collect())
    }
}

/// Today's stub pricer: every pair mid `mid` unless named, every token $1
/// (so every sell leg spends one whole base token).
struct Frame {
    mid: f64,
    mids: HashMap<&'static str, f64>,
}

impl Frame {
    fn mid(mid: f64) -> Self {
        Self { mid, mids: HashMap::new() }
    }
}

impl Pricer for Frame {
    fn usd_per_token(&self, _: &str) -> f64 {
        1.0
    }
    fn usd_for_token(&self, _: &str, _: f64) -> f64 {
        1.0
    }
    fn pair_mid(&self, market: &str) -> f64 {
        self.mids.get(market).copied().unwrap_or(self.mid)
    }
    fn token_for_usd(&self, _: &str, _: f64) -> f64 {
        1.0
    }
}

fn hash(n: u8) -> [u8; 32] {
    [n; 32]
}

async fn quote(v1: &MetricV1, stub: &Stub, frame: &Frame, sizes: &[f64]) -> Result<Vec<QuoteRow>, VenueError> {
    v1.quote_with(stub, frame, hash(7), sizes).await
}

fn venue() -> (Generations, Arc<MetricV1>) {
    let v1 = Arc::new(MetricV1::default());
    (metric::compose(MetricV0::new(reg()), v1.clone()), v1)
}

async fn discovered(stub: &Stub) -> (Generations, Arc<MetricV1>) {
    let (v, v1) = venue();
    v1.refresh(stub, reg()).await.unwrap();
    (v, v1)
}

/// v1's watched swap pools (lower-case), sorted.
fn swap_pools(v1: &MetricV1) -> Vec<String> {
    let w = v1.watch().unwrap();
    let mut out: Vec<String> = w.logs.keys().filter(|a| **a != to_addr(V1_FACTORY)).map(hex).collect();
    out.sort();
    out
}

fn sorted(mut v: Vec<&str>) -> Vec<String> {
    v.sort();
    v.into_iter().map(String::from).collect()
}

/// The two pools the decode fixtures touch (today's `ctx` in the decode test).
async fn decode_venue() -> Generations {
    discovered(&Stub { oracle_of: Box::new(|_| None), price_fails: true, ..Stub::new(&[WMON_POOL, AUSD_POOL]) }).await.0
}

async fn decode_all() -> Vec<Fill> {
    let v = decode_venue().await;
    let f = fx();
    let mut out = Vec::new();
    for l in f["v0Swaps"].as_array().unwrap().iter().chain(f["v1Swaps"].as_array().unwrap()) {
        out.extend(decode(&v, &block_of(l)).unwrap());
    }
    out
}

// ── decode: v1 (packed deltas) ──────────────────────────────────────────────

#[test]
fn unpacks_packed2int128_as_token0_high_token1_low_sign_extended() {
    let f = fx();
    let l = log_of(&f["v1Swaps"][0]);
    let s = Swap::decode_raw_log(l.topics.iter().map(|t| B256::from(*t)), &l.data).unwrap();
    assert_eq!(unpack_amount_deltas(s.amountDeltas), (359_625_382_330_000_000_000, -12_031_717));
}

#[tokio::test]
async fn the_first_v1_swap_a_sell_of_359_625_wmon_for_12_031717_usdc() {
    let f = fx();
    let raw = &f["v1Swaps"][0];
    let fills = decode_all().await;
    let fill = fills.iter().find(|x| x.tx_hash == tx(raw)).unwrap();
    assert_eq!(fill.id, format!("metric-{}-97", tx(raw)));
    assert_eq!(fill.venue_id, "metric");
    assert_eq!(fill.market, "MON/USDC");
    assert_eq!(fill.side, Side::Sell);
    assert_eq!(fill.category, FillCategory::Unknown);
    assert_eq!(fill.block_number, 110_474_867);
    assert_eq!(fill.pool, "metric 0xe6831a");
    close(fill.usd, 12.031717, 9);
    close(fill.base_amount, 359.62538233, 9);
    close(fill.exec_px, 12.031717 / 359.62538233, 12);
    assert_eq!(fill.exec_px, fill.usd / fill.base_amount);
    assert_eq!(fill.ts, raw["blockTimestamp"].as_f64().unwrap() * 1000.0);
    assert!(!fill.px_approx);
    assert_eq!(fill.router, None);
    // The recipient as viem hands it: checksummed.
    let recipient = Address::from(addr("0x28bf6006d87de7f44445905aa4f5cb8c0d8cba02"));
    assert_eq!(fill.to, mpamm_venues::util::short_hex(&recipient.to_checksum(None)));
    assert_ne!(fill.to, "0x28bf…ba02");
}

#[tokio::test]
async fn a_buy_inside_a_multi_swap_tx() {
    let f = fx();
    let raw = &f["v1Swaps"][1];
    let fills = decode_all().await;
    let fill = fills.iter().find(|x| x.tx_hash == tx(raw)).unwrap();
    assert_eq!(fill.id, format!("metric-{}-10", tx(raw)));
    assert_eq!((fill.side, fill.market.as_str()), (Side::Buy, "MON/USDC"));
    close(fill.usd, 721.762571, 9);
    close(fill.base_amount, 29761.367737552755, 9);
}

#[tokio::test]
async fn drops_the_ausd_usdc_pool_stable_stable_is_not_a_market() {
    let f = fx();
    let fills = decode_all().await;
    assert!(!fills.iter().any(|x| x.tx_hash == tx(&f["v1Swaps"][2])));
}

// ── decode: v1 wANTx/USDC (18-decimal share wrapper) ─────────────────────────

const SHARES: f64 = 0.003082174078727451;

async fn decode11() -> Vec<Fill> {
    let (v, _) = discovered(&Stub { oracle_of: Box::new(|_| None), ..Stub::new(&[WANTX_POOL]) }).await;
    let f = fx();
    let mut out = Vec::new();
    for l in f["v1WantxSwaps"].as_array().unwrap() {
        out.extend(decode(&v, &block_of(l)).unwrap());
    }
    out
}

#[test]
fn wantx_unpacks_both_swaps_to_the_wei() {
    let f = fx();
    let deltas: Vec<(i128, i128)> = f["v1WantxSwaps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| {
            let l = log_of(raw);
            unpack_amount_deltas(
                Swap::decode_raw_log(l.topics.iter().map(|t| B256::from(*t)), &l.data).unwrap().amountDeltas,
            )
        })
        .collect();
    assert_eq!(deltas, [(-3_082_174_078_727_451, 300_000), (3_082_174_078_727_451, -298_325)]);
}

#[tokio::test]
async fn wantx_first_swap_a_buy_for_0_30_usdc() {
    let f = fx();
    let raw = &f["v1WantxSwaps"][0];
    let fills = decode11().await;
    let fill = fills.iter().find(|x| x.tx_hash == tx(raw)).unwrap();
    assert_eq!(fill.id, format!("metric-{}-236", tx(raw)));
    assert_eq!((fill.market.as_str(), fill.side), ("wANTx/USDC", Side::Buy));
    assert_eq!(fill.block_number, 123_648_251);
    assert_eq!(fill.pool, "metric 0x035c19");
    assert_eq!(fill.ts, 1_795_111_313_000.0);
    close(fill.usd, 0.3, 12);
    close(fill.base_amount, SHARES, 18);
    close(fill.exec_px, 97.33389236, 6);
}

#[tokio::test]
async fn wantx_the_round_trip_back_a_sell() {
    let f = fx();
    let raw = &f["v1WantxSwaps"][1];
    let fills = decode11().await;
    let fill = fills.iter().find(|x| x.tx_hash == tx(raw)).unwrap();
    assert_eq!(fill.id, format!("metric-{}-167", tx(raw)));
    assert_eq!((fill.market.as_str(), fill.side, fill.block_number), ("wANTx/USDC", Side::Sell, 123_648_272));
    close(fill.usd, 0.298325, 12);
    close(fill.base_amount, SHARES, 18);
    close(fill.exec_px, 0.298325 / SHARES, 9);
}

#[tokio::test]
async fn wantx_counts_both_fills_with_no_reference_at_all() {
    let markets: Vec<String> = decode11().await.into_iter().map(|f| f.market).collect();
    assert_eq!(markets, ["wANTx/USDC", "wANTx/USDC"]);
}

// ── decode: v0 (retired generation stays replayable) ────────────────────────

#[tokio::test]
async fn the_last_v0_swap_a_buy_of_0_00007887_wbtc() {
    let f = fx();
    let raw = &f["v0Swaps"][0];
    let fills = decode_all().await;
    let fill = fills.iter().find(|x| x.tx_hash == tx(raw)).unwrap();
    assert_eq!(fill.id, format!("metric-{}-173", tx(raw)));
    assert_eq!((fill.venue_id.as_str(), fill.market.as_str(), fill.side), ("metric", "BTC/USDC", Side::Buy));
    assert_eq!(fill.block_number, 108_406_568);
    // The pool label in the checksum spelling the pre-split adapter stored.
    assert_eq!(fill.pool, "metric 0x2D82AC");
    close(fill.base_amount, 0.00007887, 12);
    close(fill.usd, 6.667031, 9);
    close(fill.exec_px, 6.667031 / 0.00007887, 6);
}

#[tokio::test]
async fn ids_are_generation_free() {
    let fills = decode_all().await;
    let ids: HashSet<&str> = fills.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(ids.len(), fills.len());
    assert_eq!(fills.len(), 3);
    for id in ids {
        let rest = id.strip_prefix("metric-0x").unwrap();
        let (hash, idx) = rest.split_once('-').unwrap();
        assert!(hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(idx.parse::<u32>().is_ok());
    }
}

/// A v0 swap past the retirement block is never read today (the source's
/// span ends there), so it is never counted.
#[tokio::test]
async fn v0_decodes_only_up_to_its_last_swap_block() {
    let v = decode_venue().await;
    let f = fx();
    let raw = &f["v0Swaps"][0];
    let at = |n: u64| block(n, 1, vec![log_of(raw)]);
    assert_eq!(decode(&v, &at(V0_LAST_SWAP_BLOCK)).unwrap().len(), 1);
    assert_eq!(decode(&v, &at(V0_LAST_SWAP_BLOCK + 1)).unwrap().len(), 0);
}

// ── PoolCreated (real log) ──────────────────────────────────────────────────

#[test]
fn pool_created_names_the_pool_of_the_recorded_creation() {
    let f = fx();
    let raw = &f["v1PoolCreated"];
    assert_eq!(addr(raw["address"].as_str().unwrap()), to_addr(V1_FACTORY));
    assert_eq!(announced_pool(&log_of(raw)), Some(addr(WMON_POOL)));
    // Missing indexed topics: today's decoder has no poolAddress, so no announcement.
    let mut short = log_of(raw);
    short.topics.truncate(2);
    assert_eq!(announced_pool(&short), None);
}

// ── admission and liveness (pure) ───────────────────────────────────────────

const POOL: &str = "0x00000000000000000000000000000000000000a1";
const PROVIDER: &str = "0x00000000000000000000000000000000000000b1";

fn im(t0: Addr, t1: Addr) -> PoolTokens {
    PoolTokens { token0: t0, token1: t1, price_provider: addr(PROVIDER) }
}

#[test]
fn admits_a_base_stable_pool_on_a_registered_pair_either_ordering() {
    let p = admit_pool(reg(), addr(POOL), POOL, Some(&im(token("WMON"), token("USDC")))).unwrap();
    assert_eq!((p.market.as_str(), p.base_is_token0, p.stable_sym.as_str()), ("MON/USDC", true, "USDC"));
    assert_eq!(p.price_provider, addr(PROVIDER));
    let p = admit_pool(reg(), addr(POOL), POOL, Some(&im(token("USDC"), token("WETH")))).unwrap();
    assert_eq!((p.market.as_str(), p.base_is_token0), ("ETH/USDC", false));
}

#[test]
fn rejects_unresolved_stable_stable_base_base_and_untracked_pools() {
    assert_eq!(admit_pool(reg(), addr(POOL), POOL, None), Err(Reject::Unresolved));
    assert_eq!(
        admit_pool(reg(), addr(POOL), POOL, Some(&im(token("AUSD"), token("USDC")))),
        Err(Reject::NotBaseStable)
    );
    assert_eq!(
        admit_pool(reg(), addr(POOL), POOL, Some(&im(token("WMON"), token("WETH")))),
        Err(Reject::NotBaseStable)
    );
    let rando = addr("0x1111111111111111111111111111111111111111");
    assert_eq!(admit_pool(reg(), addr(POOL), POOL, Some(&im(rando, token("USDC")))), Err(Reject::NotBaseStable));
    assert!(admit_pool(reg(), addr(POOL), POOL, Some(&im(rando, addr("0x2222222222222222222222222222222222222222"))))
        .is_err());
    // A base the registry knows paired with a stable it has no pair for.
    assert_eq!(
        admit_pool(reg(), addr(POOL), POOL, Some(&im(token("WANTX"), token("AUSD")))),
        Err(Reject::UnregisteredPair("wANTx/AUSD".into()))
    );
}

#[test]
fn admits_the_wantx_pool_under_the_wrappers_own_market_sized_in_wrapper_units() {
    let p = admit_pool(reg(), addr(POOL), POOL, Some(&im(token("WANTX"), token("USDC")))).unwrap();
    assert_eq!(
        (p.market.as_str(), p.base_token.as_str(), p.base_dec, p.base_is_token0, p.stable_sym.as_str()),
        ("wANTx/USDC", "WANTX", 18, true, "USDC")
    );
}

#[test]
fn liveness_separates_unfunded_no_price_and_unreadable() {
    let u = |x: u64| Some(U256::from(x));
    assert_eq!(pool_liveness(u(1), u(1), Some(100), Some(101)), Liveness::Live);
    for (b0, b1) in [(0, 0), (1, 0), (0, 1)] {
        assert_eq!(pool_liveness(u(b0), u(b1), Some(100), Some(101)), Liveness::Unfunded);
    }
    assert_eq!(pool_liveness(u(1), u(1), Some(0), Some(0)), Liveness::NoPrice);
    assert_eq!(pool_liveness(u(1), u(1), Some(100), Some(0)), Liveness::NoPrice);
    assert_eq!(pool_liveness(u(1), u(1), None, Some(101)), Liveness::NoPrice);
    assert_eq!(pool_liveness(None, u(1), Some(100), Some(101)), Liveness::Unreadable);
}

// ── v1 discovery (factory enumeration) ──────────────────────────────────────

#[tokio::test]
async fn admits_every_registered_base_stable_pool_funded_or_not_and_drops_stable_stable() {
    let stub = Stub {
        balances: Box::new(|p| if p == addr(WMON_POOL) { (1_000, 1_000) } else { (0, 0) }),
        ..Stub::default_pools()
    };
    let (v, v1) = discovered(&stub).await;
    assert_eq!(swap_pools(&v1), sorted(vec![WETH_POOL, WMON_POOL]));
    let mut markets = v.markets();
    markets.sort();
    assert_eq!(markets, ["ETH/USDC", "MON/USDC"]);
    assert_eq!(v1.live_markets(), ["MON/USDC"]);
}

#[tokio::test]
async fn holds_until_the_first_discovery_succeeds() {
    let (v, v1) = venue();
    assert!(matches!(v.watch(), Err(VenueError::NotReady(m)) if m.contains("discovery unavailable")));
    let stub = Stub { unresolved: HashSet::from([addr(WMON_POOL)]), ..Stub::default_pools() };
    let err = v1.refresh(&stub, reg()).await.unwrap_err();
    assert!(err.to_string().contains("getImmutables failed"), "{err}");
    assert!(matches!(v.watch(), Err(VenueError::NotReady(_))));
    // Decode holds too: nothing is read for an undiscovered venue.
    assert!(matches!(decode(&v, &block(V1_FACTORY_BLOCK + 1, 1, vec![])), Err(VenueError::NotReady(_))));
}

#[tokio::test]
async fn never_silently_drops_a_factory_pool_whose_immutables_did_not_answer() {
    let (_, v1) = discovered(&Stub::new(&[WMON_POOL])).await;
    let flaky = Stub { unresolved: HashSet::from([addr(WETH_POOL)]), ..Stub::new(&[WMON_POOL, WETH_POOL]) };
    assert!(v1.refresh(&flaky, reg()).await.is_err());
    assert_eq!(swap_pools(&v1), [WMON_POOL]);
    v1.refresh(&Stub::new(&[WMON_POOL, WETH_POOL]), reg()).await.unwrap();
    assert_eq!(swap_pools(&v1), sorted(vec![WETH_POOL, WMON_POOL]));
}

#[tokio::test]
async fn fails_the_pass_when_the_current_provider_read_fails_never_the_creation_time_one() {
    let rotated = addr(&format!("0x{}", "c".repeat(40)));
    let oracle_of = move |p: Addr| Some(if p == rotated { addr(ORACLE) } else { addr(ORACLE_B) });
    let (v, v1) = discovered(&Stub {
        current_provider: Box::new(move |_| rotated),
        oracle_of: Box::new(oracle_of),
        ..Stub::default_pools()
    })
    .await;
    let failing = Stub {
        provider_fails: HashSet::from([addr(WMON_POOL)]),
        oracle_of: Box::new(oracle_of),
        ..Stub::default_pools()
    };
    let err = v1.refresh(&failing, reg()).await.unwrap_err();
    assert!(err.to_string().contains("priceProvider read failed"), "{err}");
    // The obsolete provider's oracle never entered the gas destinations.
    let gas = v.gas_sources().unwrap().unwrap();
    assert!(!gas.destinations.contains(&addr(ORACLE_B)));
    assert!(swap_pools(&v1).contains(&WMON_POOL.to_string()));
}

#[tokio::test]
async fn only_reads_factory_indices_it_has_not_read_before() {
    let (_, v1) = discovered(&Stub::new(&[WMON_POOL])).await;
    let second = Stub::new(&[WMON_POOL, WETH_POOL]);
    v1.refresh(&second, reg()).await.unwrap();
    assert_eq!(second.calls("idxToPool"), ["2"]);
    // Immutables are cached: only the new pool is resolved.
    assert_eq!(second.calls("getImmutables"), [WETH_POOL]);
}

#[tokio::test]
async fn watches_the_factory_even_with_no_admitted_pool() {
    let (_, v1) = discovered(&Stub::new(&[AUSD_POOL])).await;
    let w = v1.watch().unwrap();
    assert_eq!(w.logs.len(), 1);
    assert_eq!(w.logs[&to_addr(V1_FACTORY)], TopicFilter::Topics(HashSet::from([announced_topic()])));
}

fn announced_topic() -> [u8; 32] {
    log_of(&fx()["v1PoolCreated"]).topics[0]
}

#[tokio::test]
async fn bounds_v1_at_the_factory_creation_block() {
    let (v, v1) = discovered(&Stub::default_pools()).await;
    assert_eq!(v1.span().from, Some(V1_FACTORY_BLOCK));
    // A v1 pool's swap before the factory existed is never read today.
    let f = fx();
    let raw = &f["v1Swaps"][0];
    assert_eq!(decode(&v, &block(V1_FACTORY_BLOCK - 1, 1, vec![log_of(raw)])).unwrap().len(), 0);
    assert_eq!(decode(&v, &block(V1_FACTORY_BLOCK, 1, vec![log_of(raw)])).unwrap().len(), 1);
}

#[tokio::test]
async fn keeps_watching_a_funded_pool_whose_oracle_stopped_answering_but_does_not_quote_it() {
    let stub = Stub { price_fails: true, ..Stub::default_pools() };
    let (_, v1) = discovered(&stub).await;
    assert!(swap_pools(&v1).contains(&WMON_POOL.to_string()));
    assert!(v1.live_markets().is_empty());
    assert!(v1.no_price_warning().unwrap().contains("funded pool(s) have no oracle price"));
    assert_eq!(quote(&v1, &stub, &Frame::mid(1.0), &[100.0]).await.unwrap(), []);
    assert!(stub.legs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn latches_the_no_price_warning_and_clears_it_on_recovery() {
    let (_, v1) = discovered(&Stub { price_fails: true, ..Stub::default_pools() }).await;
    let first = v1.no_price_warning().unwrap();
    v1.refresh(&Stub { price_fails: true, ..Stub::default_pools() }, reg()).await.unwrap();
    assert_eq!(v1.no_price_warning().unwrap(), first);
    v1.refresh(&Stub::default_pools(), reg()).await.unwrap();
    assert_eq!(v1.no_price_warning(), None);
    v1.refresh(&Stub { price_fails: true, ..Stub::default_pools() }, reg()).await.unwrap();
    assert_eq!(v1.no_price_warning().unwrap(), first);
}

#[tokio::test]
async fn declares_its_pools_direct_and_its_simple_router_as_metric_periphery() {
    let (v, _) = discovered(&Stub::default_pools()).await;
    let eps = v.entry_points();
    assert!(eps.iter().any(|e| e.address == to_addr(V1_SIMPLE_ROUTER) && e.router.as_deref() == Some("Metric")));
    assert!(eps.iter().any(|e| e.address == addr(WMON_POOL) && e.router.is_none()));
    // v0's pools stay DIRECT entry points too.
    assert!(eps.iter().any(|e| e.address == addr(V0_POOLS[1].0) && e.router.is_none()));
}

// ── gas (both generations) ──────────────────────────────────────────────────

#[tokio::test]
async fn declares_the_retired_v0_oracle_and_the_v1_oracle() {
    let (v, _) = discovered(&Stub::default_pools()).await;
    let mut dest = v.gas_sources().unwrap().unwrap().destinations;
    dest.sort();
    let mut want = vec![addr(ORACLE), to_addr(V0_PUSH_ORACLE)];
    want.sort();
    assert_eq!(dest, want);
    let w = v.watch().unwrap();
    assert!(want.iter().all(|a| w.txn_input.contains(a)));
}

#[tokio::test]
async fn holds_the_gas_sources_until_a_v1_oracle_resolves() {
    let (v, v1) = venue();
    assert!(matches!(v.gas_sources(), Err(VenueError::NotReady(m)) if m.contains("not resolved")));
    v1.refresh(&Stub { oracle_of: Box::new(|_| None), ..Stub::default_pools() }, reg()).await.unwrap();
    assert!(matches!(v.gas_sources(), Err(VenueError::NotReady(m)) if m.contains("not resolved")));
}

#[tokio::test]
async fn gas_destinations_never_shrink() {
    let weth_prov = prov_of(addr(WETH_POOL));
    let (v, v1) = discovered(&Stub {
        oracle_of: Box::new(move |p| Some(if p == weth_prov { addr(ORACLE_B) } else { addr(ORACLE) })),
        ..Stub::default_pools()
    })
    .await;
    v1.refresh(
        &Stub {
            oracle_of: Box::new(move |p| if p == weth_prov { None } else { Some(addr(ORACLE)) }),
            balances: Box::new(|_| (0, 0)),
            ..Stub::default_pools()
        },
        reg(),
    )
    .await
    .unwrap();
    let dest = v.gas_sources().unwrap().unwrap().destinations;
    for a in [addr(ORACLE), addr(ORACLE_B), to_addr(V0_PUSH_ORACLE)] {
        assert!(dest.contains(&a));
    }
}

// ── v1 quotes ───────────────────────────────────────────────────────────────

/// Only the WMON pool funded: the one live pool.
fn wmon_funded() -> Stub {
    Stub { balances: Box::new(|p| if p == addr(WMON_POOL) { (1_000, 1_000) } else { (0, 0) }), ..Stub::default_pools() }
}

fn markets_of(rows: &[QuoteRow]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in rows {
        if !out.contains(&r.market) {
            out.push(r.market.clone());
        }
    }
    out
}

fn e12() -> U256 {
    U256::from(10u64).pow(U256::from(12))
}

#[tokio::test]
async fn quotes_both_sides_of_every_live_pool_at_the_pinned_block_sized_in_pair_terms() {
    // buy: 100 USDC in → 98 WMON out (ask 1/0.98); sell: 1 WMON in → 0.99 USDC out (bid 0.99).
    let stub = Stub {
        // WMON is token0: zeroForOne = selling WMON.
        quote: Box::new(|c| {
            let pct = |n: u64| c.amount_in * U256::from(n) / U256::from(100u64);
            Ok(if c.zero_for_one { (c.amount_in, pct(99) / e12()) } else { (c.amount_in, pct(98) * e12()) })
        }),
        ..wmon_funded()
    };
    let (_, v1) = discovered(&stub).await;
    let rows = quote(&v1, &stub, &Frame::mid(1.0), &[100.0]).await.unwrap();
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(
        (r.venue_id.as_str(), r.market.as_str(), r.size_usd, r.filled_full, r.one_sided, r.fee_bps),
        ("metric", "MON/USDC", 100.0, true, None, 0.0)
    );
    close(r.ask_px, 1.0 / 0.98, 9);
    close(r.bid_px, 0.99, 9);
    assert_eq!(r.spread_bps, r.ask_bps - r.bid_bps);
    assert!(r.ts > 0.0);
    let legs = stub.legs.lock().unwrap();
    // Every leg pinned to the frame's block.
    assert!(legs.iter().all(|(_, h)| *h == hash(7)));
    // Buy: USDC (token1) in, zeroForOne=false, no upper bound; sell: WMON in,
    // zeroForOne=true, floor 0. $100 of USDC; the base worth $100 (one WMON
    // at the stub's price).
    let got: Vec<(String, bool, U256, u128)> =
        legs.iter().map(|(c, _)| (hex(&c.pool), c.zero_for_one, c.amount_in, c.price_limit_x64)).collect();
    assert_eq!(
        got,
        [
            (WMON_POOL.to_string(), false, U256::from(100_000_000u64), u128::MAX),
            (WMON_POOL.to_string(), true, U256::from(10u64).pow(U256::from(18)), 0)
        ]
    );
}

#[tokio::test]
async fn marks_a_size_the_pool_cannot_absorb_as_not_filled_full() {
    let half = |c: &QuoteCall| Ok((c.amount_in / U256::from(2u8), c.amount_in / U256::from(2u8)));
    let stub = Stub { quote: Box::new(half), ..wmon_funded() };
    let (_, v1) = discovered(&stub).await;
    let rows = quote(&v1, &stub, &Frame::mid(1.0), &[100.0]).await.unwrap();
    assert!(!rows[0].filled_full);
}

/// Today the venue goes dark with a note naming the failure; here it is
/// missing for the block with that reason.
#[tokio::test]
async fn every_leg_failing_is_an_error_naming_the_failure() {
    let stub = Stub { quote: Box::new(|_| Err(VenueError::Chain("oracle: not attributed".into()))), ..wmon_funded() };
    let (_, v1) = discovered(&stub).await;
    let err = quote(&v1, &stub, &Frame::mid(1.0), &[100.0]).await.unwrap_err();
    assert_eq!(
        err,
        VenueError::Chain(
            "Metric quotes unavailable — all 2 legs failed with \"oracle: not attributed\" (venue disabled, or the ABI drifted from the contract)"
                .into()
        )
    );
}

// The reference registry handles share conversion: the venue sees a missing
// rate as a missing mid.
#[tokio::test]
async fn quotes_the_wantx_pool_like_any_other_while_its_pair_has_a_reference() {
    let stub = Stub::new(&[WANTX_POOL]);
    let (_, v1) = discovered(&stub).await;
    assert_eq!(markets_of(&quote(&v1, &stub, &Frame::mid(1.0), &[100.0]).await.unwrap()), ["wANTx/USDC"]);
}

#[tokio::test]
async fn asks_the_quoter_nothing_for_wantx_while_its_reference_is_withheld() {
    let stub = Stub::new(&[WMON_POOL, WANTX_POOL]);
    let (_, v1) = discovered(&stub).await;
    let frame = Frame { mid: 1.0, mids: HashMap::from([("wANTx/USDC", 0.0)]) };
    assert_eq!(markets_of(&quote(&v1, &stub, &frame, &[100.0]).await.unwrap()), ["MON/USDC"]);
    let asked: Vec<String> = stub.legs.lock().unwrap().iter().map(|(c, _)| hex(&c.pool)).collect();
    assert_eq!(asked, [WMON_POOL, WMON_POOL]);
    // The pool stays watched.
    assert_eq!(swap_pools(&v1), sorted(vec![WANTX_POOL, WMON_POOL]));
}

// Metric's one live pool is an xStock: its market closes every weekend, and
// a wrapper can leave parity. Either way the venue returns nothing, and only
// it can say why.

#[derive(Clone, Copy)]
enum Legs {
    Fill,
    Fail,
    Empty,
}

fn wantx(legs: Legs) -> Stub {
    Stub {
        quote: Box::new(move |c| match legs {
            Legs::Fill => Ok((c.amount_in, c.amount_in)),
            Legs::Fail => Err(VenueError::Chain("execution reverted".into())),
            Legs::Empty => Ok((U256::ZERO, U256::ZERO)),
        }),
        ..Stub::new(&[WANTX_POOL])
    }
}

async fn wantx_live() -> Arc<MetricV1> {
    discovered(&wantx(Legs::Fill)).await.1
}

/// `n` frames against one reference mid; the rows they published.
async fn frames(v1: &MetricV1, legs: Legs, mid: f64, n: usize) -> usize {
    let stub = wantx(legs);
    let mut rows = 0;
    for i in 0..n {
        rows += v1.quote_with(&stub, &Frame::mid(mid), hash(i as u8), &[100.0]).await.map_or(0, |r| r.len());
    }
    rows
}

const NO_REFERENCE: &str = "no reference for wANTx/USDC";

#[tokio::test]
async fn says_why_it_is_silent_once_the_gap_outlasts_a_cold_start_once_for_the_episode() {
    let v1 = wantx_live().await;
    let n = metric::v1::NO_REFERENCE_FRAMES as usize;
    assert_eq!(frames(&v1, Legs::Fill, 0.0, n - 1).await, 0);
    assert_eq!(v1.no_reference_outage(), None);
    frames(&v1, Legs::Fill, 0.0, 1).await;
    assert_eq!(v1.no_reference_outage().as_deref(), Some(NO_REFERENCE));
    frames(&v1, Legs::Fill, 0.0, 50).await;
    assert_eq!(v1.no_reference_outage().as_deref(), Some(NO_REFERENCE));
}

#[tokio::test]
async fn says_nothing_about_a_gap_shorter_than_that() {
    let v1 = wantx_live().await;
    let n = metric::v1::NO_REFERENCE_FRAMES as usize;
    frames(&v1, Legs::Fill, 0.0, 3).await;
    assert_eq!(frames(&v1, Legs::Fill, 97.0, 2).await, 2);
    // The counter restarts: a later short gap is not added to the first one.
    frames(&v1, Legs::Fill, 0.0, n - 1).await;
    assert_eq!(v1.no_reference_outage(), None);
}

#[tokio::test]
async fn clears_it_when_the_reference_is_back_and_it_quotes() {
    let v1 = wantx_live().await;
    frames(&v1, Legs::Fill, 0.0, metric::v1::NO_REFERENCE_FRAMES as usize).await;
    assert_eq!(frames(&v1, Legs::Fill, 97.0, 3).await, 3);
    assert_eq!(v1.no_reference_outage(), None);
}

#[tokio::test]
async fn keeps_it_while_another_cause_blocks_it_every_leg_failing() {
    let v1 = wantx_live().await;
    frames(&v1, Legs::Fill, 0.0, metric::v1::NO_REFERENCE_FRAMES as usize).await;
    assert_eq!(frames(&v1, Legs::Fail, 97.0, 3).await, 0);
    let err = v1.quote_with(&wantx(Legs::Fail), &Frame::mid(97.0), hash(1), &[100.0]).await.unwrap_err();
    assert!(err.to_string().contains("Metric quotes unavailable — all 2 legs failed"), "{err}");
    assert_eq!(v1.no_reference_outage().as_deref(), Some(NO_REFERENCE));
    assert_eq!(frames(&v1, Legs::Fill, 97.0, 1).await, 1);
    assert_eq!(v1.no_reference_outage(), None);
}

/// Legs that answered are not a quote: every one answering zero builds no row.
#[tokio::test]
async fn keeps_it_while_every_leg_answers_with_nothing() {
    let v1 = wantx_live().await;
    frames(&v1, Legs::Fill, 0.0, metric::v1::NO_REFERENCE_FRAMES as usize).await;
    assert_eq!(frames(&v1, Legs::Empty, 97.0, 3).await, 0);
    assert_eq!(v1.no_reference_outage().as_deref(), Some(NO_REFERENCE));
    assert_eq!(frames(&v1, Legs::Fill, 97.0, 1).await, 1);
    assert_eq!(v1.no_reference_outage(), None);
}

// A pool refusing one direction (the stop-loss window of 2026-10-12).

const REVERTED: &str = "quoteLiveExactInSingle(address,address,bool,uint128,uint128): rpc error 3: execution reverted";

/// Buy legs are USDC (token1) in: zeroForOne false.
fn buys_blocked() -> Stub {
    Stub {
        quote: Box::new(|c| {
            if c.zero_for_one {
                Ok((c.amount_in, c.amount_in / e12()))
            } else {
                Err(VenueError::Chain(REVERTED.into()))
            }
        }),
        ..wmon_funded()
    }
}

#[tokio::test]
async fn keeps_the_real_side_one_sided_while_the_other_is_refused() {
    let stub = buys_blocked();
    let (_, v1) = discovered(&stub).await;
    let rows = quote(&v1, &stub, &Frame::mid(1.0), &[100.0, 1000.0]).await.unwrap();
    assert_eq!(rows.len(), 2);
    for r in &rows {
        assert_eq!((r.market.as_str(), r.one_sided, r.ask_px, r.spread_bps), ("MON/USDC", Some(true), 0.0, 0.0));
        assert!(r.bid_px > 0.0);
    }
}

#[tokio::test]
async fn names_the_refused_side_once_then_clears_it_when_it_quotes_again() {
    let blocked = buys_blocked();
    let (_, v1) = discovered(&blocked).await;
    quote(&v1, &blocked, &Frame::mid(1.0), &[100.0]).await.unwrap();
    let want = vec![("MON/USDC|buy".to_string(), REVERTED.to_string())];
    assert_eq!(v1.side_outages(), want);
    quote(&v1, &blocked, &Frame::mid(1.0), &[100.0]).await.unwrap();
    assert_eq!(v1.side_outages(), want);
    quote(&v1, &wmon_funded(), &Frame::mid(1.0), &[100.0]).await.unwrap();
    assert!(v1.side_outages().is_empty());
}

// ── v0 (retired generation) ─────────────────────────────────────────────────

#[test]
fn anchors_the_lifetime_replay_at_the_first_v0_swap_day() {
    let (v, _) = venue();
    assert_eq!(v.history_from_utc(), Some("2026-03-30"));
    assert_eq!(v.meta()[0].since_utc.as_deref(), v.history_from_utc());
    assert_eq!(v.meta()[0].name, "Metric");
    assert_eq!(v.id(), "metric");
    let revs = v.history_revisions();
    assert_eq!(revs.len(), 1);
    assert_eq!(
        (revs[0].id, revs[0].from, revs[0].source),
        ("wantx-usdc", Some("2026-11-19"), RevisionSource::Markets(&["wANTx/USDC"]))
    );
}

#[test]
fn watches_all_eight_v0_pools_bounded_at_the_last_v0_swap() {
    let v0 = MetricV0::new(reg());
    assert_eq!(v0.pools().len(), 8);
    let w = v0.watch().unwrap();
    let mut got: Vec<Addr> = w.logs.keys().copied().collect();
    got.sort();
    let mut want: Vec<Addr> = V0_POOLS.iter().map(|p| addr(p.0)).collect();
    want.sort();
    assert_eq!(got, want);
    assert_eq!(v0.span().until, Some(V0_LAST_SWAP_BLOCK));
    assert!(!v0.span().contains(112_000_000));
    assert!(v0.span().contains(108_406_000));
}

#[tokio::test]
async fn v0_makes_no_rpc_call_of_its_own() {
    let stub = Stub::default_pools();
    discovered(&stub).await;
    let v0: HashSet<String> = V0_POOLS.iter().map(|p| p.0.to_lowercase()).collect();
    assert!(!stub.calls.lock().unwrap().iter().any(|(_, a)| v0.contains(a)));
}

// ── a v1 pool announced mid-stream holds its block until discovery decides it

fn created(pool: &str) -> FinalLog {
    let mut l = log_of(&fx()["v1PoolCreated"]);
    let mut topic = [0u8; 32];
    topic[12..].copy_from_slice(&addr(pool));
    l.topics[1] = topic;
    l.log_index = 1;
    l
}

/// The pool gained 2 USDC (token1) and paid out 1 base (token0): a buy.
fn swap_log(pool: &str) -> FinalLog {
    let packed = ((U256::from(u128::MAX) - U256::from(10u128.pow(18)) + U256::from(1)) << 128) | U256::from(2_000_000);
    let e = Swap {
        sender: Address::repeat_byte(0x33),
        recipient: Address::repeat_byte(0x33),
        details: U256::ZERO,
        amountDeltas: packed,
        platformFees: U256::ZERO,
    }
    .encode_log_data();
    FinalLog {
        log_index: 3,
        txn_index: 0,
        tx_hash: [0x22; 32],
        address: addr(pool),
        topics: e.topics().iter().map(|t| t.0).collect(),
        data: e.data.to_vec(),
    }
}

#[tokio::test]
async fn holds_while_an_announced_pool_is_undecided_then_counts_its_swap() {
    let (v, v1) = discovered(&Stub::new(&[WMON_POOL])).await;
    let b = block(150_000_000, 1, vec![created(WETH_POOL), swap_log(WETH_POOL)]);
    assert!(matches!(decode(&v, &b), Err(VenueError::NotReady(m)) if m.contains("factory deployed 1 new pool")));
    // Discovery decides it (admitted): the block passes, the swap counts.
    v1.refresh(&Stub::new(&[WMON_POOL, WETH_POOL]), reg()).await.unwrap();
    assert!(swap_pools(&v1).contains(&WETH_POOL.to_string()));
    let fills = decode(&v, &b).unwrap();
    assert_eq!(fills.len(), 1);
    assert_eq!(
        (fills[0].venue_id.as_str(), fills[0].market.as_str(), fills[0].side),
        ("metric", "ETH/USDC", Side::Buy)
    );
    assert_eq!(fills[0].usd, 2.0);
    assert_eq!(fills[0].to, "0x3333…3333");
}

#[tokio::test]
async fn keeps_holding_when_the_pass_failed_after_enumerating_the_pool() {
    let (v, v1) = discovered(&Stub::new(&[WMON_POOL])).await;
    let b = block(150_000_000, 1, vec![created(WETH_POOL), swap_log(WETH_POOL)]);
    let flaky = Stub { unresolved: HashSet::from([addr(WETH_POOL)]), ..Stub::new(&[WMON_POOL, WETH_POOL]) };
    assert!(v1.refresh(&flaky, reg()).await.is_err());
    // A candidate now, but not decided: still held.
    assert!(matches!(decode(&v, &b), Err(VenueError::NotReady(_))));
    assert!(v1.refresh(&flaky, reg()).await.is_err());
    assert!(matches!(decode(&v, &b), Err(VenueError::NotReady(_))));
    v1.refresh(&Stub::new(&[WMON_POOL, WETH_POOL]), reg()).await.unwrap();
    assert_eq!(decode(&v, &b).unwrap().len(), 1);
}

#[tokio::test]
async fn a_rejected_announcement_passes_once_decided() {
    let (v, v1) = discovered(&Stub::new(&[WMON_POOL])).await;
    let b = block(150_000_000, 1, vec![created(AUSD_POOL)]);
    assert!(decode(&v, &b).is_err());
    v1.refresh(&Stub::new(&[WMON_POOL, AUSD_POOL]), reg()).await.unwrap();
    assert_eq!(decode(&v, &b).unwrap().len(), 0);
}

#[tokio::test]
async fn a_known_pools_swap_decodes_without_a_hold() {
    let (v, _) = discovered(&Stub::new(&[WMON_POOL])).await;
    let fills = decode(&v, &block(150_000_000, 1, vec![created(WMON_POOL), swap_log(WMON_POOL)])).unwrap();
    assert_eq!(fills.len(), 1);
    assert_eq!(fills[0].market, "MON/USDC");
}

/// The service registers Metric once, between POE and WOOFi.
#[test]
fn registered_in_all() {
    let ids: Vec<String> = mpamm_venues::all().iter().map(|v| v.id().to_string()).collect();
    assert!(ids.iter().position(|i| i == "poe") < ids.iter().position(|i| i == "metric"));
}
