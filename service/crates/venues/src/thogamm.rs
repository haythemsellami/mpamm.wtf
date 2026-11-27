//! ThogAMM, ported from server/src/venues/thogamm.ts: one inventory-funded
//! ERC-7815 pool behind the TAKERBOT proxy, quoting many tokens against each
//! other. A fill names its two tokens, so a market is found by token pair,
//! not by pool.
//!
//! ONE PROXY, TWO BUSINESSES, AND ONLY ONE OF THEM IS THIS VENUE. Only
//! `MakerSwapExecuted` is this pool's settled volume. The proxy's
//! `TakerTradeExecuted` is TAKERBOT's operator trading on OTHER venues; that
//! volume belongs to whoever filled it, and counting it here was PR #82's
//! mistake (reverted). Low maker volume is a finding, not a decode bug.
//!
//! The pool's token set changes on chain (`MakerTokenAdded`/`Retired`), and
//! the proxy upgrades often (an ABI change would silently match nothing).
//! Today's adapter re-reads the registry from chain when either appears.
//! Decode reads no chain here, but runs once per final block in order, so it
//! applies the token events themselves: the indexed token is all it needs,
//! and the decode table keeps the registry's decimals, which discovery
//! checks against ERC-20 `decimals()` every 10 minutes. An upgrade is logged
//! as the cue to re-verify the ABIs; a token set it changed without events
//! is picked up by the next discovery.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::OnceLock,
};

use alloy_primitives::{address, Address, B256};
use alloy_sol_types::sol;
use async_trait::async_trait;
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, FinalLog, GasSources, HistoryRevision, Venue, VenueError};
use mpamm_registry::{Pair, Registry};
use mpamm_ring::{Addr, TopicFilter, WatchSet};
use mpamm_types::{Fill, FillCategory, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call, call_many, At},
    logs,
    util::{b32_hex, fill_id, from_units, short_hex, to_addr},
};

pub const ID: &str = "thogamm";
pub const PROXY: Address = address!("80c74517BCC2D67fFE02D3ED886796272F647210");
/// Today's `thogamm ${THOGAMM_ADDRESS.slice(0, 10)}`.
const POOL_LABEL: &str = "thogamm 0x80c74517";

/// The xStock bases ThogAMM listed on 2026-10-27: the scope of its
/// 'xstocks-usd-references' history revision, frozen.
const XSTOCKS_2026_10: [&str; 5] = ["SPYx", "QQQx", "EWYx", "NVDAx", "TSLAx"];

sol! {
    function getPoolIds() view returns (bytes32[]);
    // ERC-7815 declares this nonpayable; discovery invokes it through eth_call.
    function getTokens(bytes32 poolId) view returns (address[]);
    function decimals() view returns (uint8);
    event MakerSwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed sender, address recipient, uint256 amountIn, uint256 amountOut, uint256 quoteAgeBlocks, uint256 inventoryPenaltyUsdWad);
    event MakerPricesPushed(uint16 seq, uint32 indexed postedBlock, uint16 sideEnableBits);
    event MakerRiskParamsPushed(uint8 indexed fields);
    event Upgraded(address indexed implementation);
    event MakerPageUpdated(uint8 indexed lane, bytes payload, uint256 control);
    #[derive(Default)]
    struct TokenMetadata { address token; uint8 decimals; uint8 category; uint32 price; uint32 priceTail; uint32 tokenBidSpread; uint32 tokenAskSpread; uint32 volumeRate; uint32 categorySpread; uint32 inventory; uint32 sides; uint32 postedBlock; uint32 sequence; uint32 pairStart; uint32 inventoryCap; }
    #[derive(Default)]
    struct CategoryMetadata { uint8 anchorTokenIndex; uint32 price; uint32 priceTail; uint32 inventory; uint32 spread; uint32 postedBlock; uint32 inventoryCap; }
    event MakerTokenAdded(uint8 indexed tokenIndex, address indexed token, TokenMetadata metadata, CategoryMetadata categoryMetadata, uint256 balance);
    event MakerTokenRetired(uint8 indexed retiredIndex, address indexed token, uint8 movedFrom, uint32 generation);
}

/// A registered pair whose two tokens the pool holds.
#[derive(Debug, Clone, PartialEq)]
pub struct Market {
    pub market: String,
    pub base_key: String,
    pub quote_key: String,
    pub base: Addr,
    pub quote: Addr,
    pub base_dec: u8,
    pub quote_dec: u8,
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "ThogAMM".into(),
        color: ThemeColor { light: "#6D28D9".into(), dark: "#A78BFA".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2026-07-26".into()),
        quote_note: Some(
            "ThogAMM shows the contract\u{2019}s read-only quote. Actual swaps may receive less after gas-price and \
             FastLane execution charges; same-block treatment also affects those charges."
                .into(),
        ),
    }
}

/// The token keys `[base, quote]` of a registered pair, today's
/// `tokenKeysForPair` (venues/pair-tokens.ts): cbBTC is an alternative BTC
/// wrapper, so the market symbol, not `Pair.base`, selects its token.
fn token_keys_for_pair<'a>(registry: &'a Registry, pair: &'a Pair) -> Option<(&'a str, &'a str)> {
    let base = if pair.symbol.starts_with("cbBTC/") {
        "CBBTC"
    } else {
        registry.asset_of(&pair.base).map(|a| a.token.as_str())?
    };
    let quote = if pair.symbol.ends_with("/cbBTC") {
        "CBBTC"
    } else if pair.is_asset_quoted() {
        registry.asset_of(&pair.quote).map(|a| a.token.as_str())?
    } else {
        pair.quote.as_str()
    };
    Some((base, quote))
}

/// Follows a pool-id rotation, but fails closed unless the proxy has exactly
/// one pool.
pub fn select_pool_id(ids: &[B256]) -> Result<B256, VenueError> {
    if ids.len() != 1 {
        let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ");
        return Err(VenueError::Chain(format!(
            "ThogAMM expected exactly one pool id, got {}: {}",
            ids.len(),
            if list.is_empty() { "none".into() } else { list }
        )));
    }
    Ok(ids[0])
}

/// Every registered pair whose two tokens are both in the pool, in registry
/// order; a token pair listed twice (either way round) keeps its first pair.
pub fn markets_for_tokens(registry: &Registry, tokens: &[Addr]) -> Vec<Market> {
    let available: HashSet<Addr> = tokens.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for pair in &registry.pairs {
        let Some((bk, qk)) = token_keys_for_pair(registry, pair) else { continue };
        let (Some(b), Some(q)) = (registry.tokens.get(bk), registry.tokens.get(qk)) else { continue };
        let (ba, qa) = (b.address_bytes(), q.address_bytes());
        if ba == qa || !available.contains(&ba) || !available.contains(&qa) {
            continue;
        }
        if !seen.insert(if ba < qa { (ba, qa) } else { (qa, ba) }) {
            continue;
        }
        out.push(Market {
            market: pair.symbol.clone(),
            base_key: bk.to_string(),
            quote_key: qk.to_string(),
            base: ba,
            quote: qa,
            base_dec: b.decimals,
            quote_dec: q.decimals,
        });
    }
    out
}

/// (tokenIn, tokenOut) → market, both directions. A direction claimed by two
/// markets is a registry fault: fail closed.
pub fn index_markets<'a>(
    markets: impl IntoIterator<Item = &'a Market>,
) -> Result<HashMap<(Addr, Addr), Market>, VenueError> {
    let mut out: HashMap<(Addr, Addr), Market> = HashMap::new();
    for m in markets {
        for key in [(m.base, m.quote), (m.quote, m.base)] {
            if let Some(prior) = out.get(&key) {
                if prior.market != m.market {
                    return Err(VenueError::Decode(format!(
                        "ThogAMM token pair maps to both {} and {}",
                        prior.market, m.market
                    )));
                }
            }
            out.insert(key, m.clone());
        }
    }
    Ok(out)
}

/// The operator-facing line for an `Upgraded` log: the cue to re-verify the
/// quote, fill and gas ABIs against the new implementation.
pub fn upgrade_note(log: &FinalLog) -> String {
    let label = match log.topics.get(1) {
        Some(t) if t[..12].iter().all(|b| *b == 0) => short_hex(&Address::from_slice(&t[12..]).to_string()),
        _ => "an unreadable implementation".to_string(),
    };
    format!("ThogAMM: proxy upgraded to {label} — re-verify quote/fill/gas ABIs against the new implementation")
}

/// The token an add/retire log names (its second indexed word).
fn named_token(log: &FinalLog) -> Option<Addr> {
    let t = log.topics.get(2)?;
    t[..12].iter().all(|b| *b == 0).then(|| to_addr(Address::from_slice(&t[12..])))
}

#[derive(Debug, Default)]
struct Inner {
    /// Every market ever discovered: the decode table only grows.
    by_market: HashMap<String, Market>,
    by_direction: HashMap<(Addr, Addr), Market>,
    /// The pool's token list as last read or followed from its events.
    tokens: Vec<Addr>,
    /// Markets of the current token list (what is quoted).
    active: BTreeSet<String>,
    discovered: bool,
}

impl Inner {
    /// Lists the markets of the current token list, merging them into the
    /// decode table.
    fn relist(&mut self, registry: &Registry) -> Result<usize, VenueError> {
        let found = markets_for_tokens(registry, &self.tokens);
        let mut merged = self.by_market.clone();
        for m in &found {
            merged.insert(m.market.clone(), m.clone());
        }
        let index = index_markets(merged.values())?;
        self.by_market = merged;
        self.by_direction = index;
        self.active = found.iter().map(|m| m.market.clone()).collect();
        Ok(found.len())
    }
}

#[derive(Default)]
pub struct Thogamm {
    inner: RwLock<Inner>,
}

/// What discovery read from the proxy at one block.
pub struct Reads {
    pub block: u64,
    pub tokens: Vec<Address>,
    /// ERC-20 `decimals()` of each token, in order.
    pub decimals: Vec<Result<u8, VenueError>>,
}

impl Thogamm {
    /// A venue already discovered with this token list (tests and tools).
    pub fn with_tokens(registry: &Registry, tokens: &[Addr]) -> Result<Self, VenueError> {
        let v = Self::default();
        {
            let mut inner = v.inner.write();
            inner.tokens = tokens.to_vec();
            inner.relist(registry)?;
            inner.discovered = true;
        }
        Ok(v)
    }

    /// Applies one discovery's reads: validates the token list and the
    /// registered tokens' decimals, then merges (never replaces) the markets.
    pub fn apply(&self, registry: &Registry, reads: Reads) -> Result<(), VenueError> {
        let tokens: Vec<Addr> = reads.tokens.iter().map(|a| to_addr(*a)).collect();
        if tokens.len() < 2 || tokens.iter().collect::<HashSet<_>>().len() != tokens.len() {
            return Err(VenueError::Chain(format!("ThogAMM returned an invalid {}-token registry", tokens.len())));
        }
        for (i, addr) in tokens.iter().enumerate() {
            let Some((key, token)) = registry.token_by_address(addr) else {
                tracing::warn!(
                    target: "venues",
                    "ThogAMM: token {} is not in the registry's tokens; its pairs remain unlisted",
                    short_hex(&reads.tokens[i].to_string())
                );
                continue;
            };
            match reads.decimals.get(i) {
                Some(Ok(d)) if *d == token.decimals => {}
                _ => return Err(VenueError::Chain(format!("ThogAMM {key} decimals mismatch"))),
            }
        }
        if markets_for_tokens(registry, &tokens).is_empty() {
            return Err(VenueError::Chain("ThogAMM discovered no registered markets".into()));
        }
        let mut inner = self.inner.write();
        let prior = std::mem::replace(&mut inner.tokens, tokens);
        match inner.relist(registry) {
            Ok(n) => {
                inner.discovered = true;
                tracing::info!(
                    target: "venues",
                    "ThogAMM: {n} registered market(s) across {} on-chain token(s) at block {}",
                    inner.tokens.len(),
                    reads.block
                );
                Ok(())
            }
            Err(e) => {
                inner.tokens = prior;
                Err(e)
            }
        }
    }

    /// Follows the pool's own token events in one block, in log order.
    fn follow_registry(&self, registry: &Registry, block: &FinalBlock) -> Result<(), VenueError> {
        let (added, retired, upgraded) =
            (logs::topic0::<MakerTokenAdded>(), logs::topic0::<MakerTokenRetired>(), logs::topic0::<Upgraded>());
        let proxy = to_addr(PROXY);
        let relevant: Vec<(&FinalLog, &[u8; 32])> = block
            .logs
            .iter()
            .filter(|l| l.address == proxy)
            .filter_map(|l| l.topic0().filter(|t| **t == added || **t == retired || **t == upgraded).map(|t| (l, t)))
            .collect();
        if relevant.is_empty() {
            return Ok(());
        }
        let mut changed = false;
        let mut inner = self.inner.write();
        for (l, t0) in relevant {
            if *t0 == upgraded {
                tracing::warn!(target: "venues", "{} (block {})", upgrade_note(l), block.number);
            } else if *t0 == added || *t0 == retired {
                let Some(token) = named_token(l) else { continue };
                if *t0 == added {
                    if !inner.tokens.contains(&token) {
                        inner.tokens.push(token);
                    }
                    if registry.token_by_address(&token).is_none() {
                        tracing::warn!(
                            target: "venues",
                            "ThogAMM: token {} is not in the registry's tokens; its pairs remain unlisted",
                            short_hex(&Address::from(token).to_string())
                        );
                    }
                } else {
                    inner.tokens.retain(|t| *t != token);
                }
                changed = true;
            }
        }
        if changed {
            let n = inner.relist(registry)?;
            tracing::info!(target: "venues", "ThogAMM: registry changed at block {}; {n} market(s) listed", block.number);
        }
        Ok(())
    }
}

#[async_trait]
impl Venue for Thogamm {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let block = cx.rpc.block_number().await.map_err(|e| VenueError::Chain(format!("ThogAMM head: {e}")))?;
        let at = At::Number(block);
        let ids = call(cx.rpc, PROXY, &getPoolIdsCall {}, at).await?;
        let pool_id = select_pool_id(&ids)?;
        let tokens = call(cx.rpc, PROXY, &getTokensCall { poolId: pool_id }, at).await?;
        let calls: Vec<(Address, decimalsCall)> = tokens.iter().map(|a| (*a, decimalsCall {})).collect();
        let decimals = call_many(cx.rpc, &calls, at).await?;
        self.apply(cx.registry, Reads { block, tokens, decimals })
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        // The sources are constant, so they are known before discovery; decode
        // holds instead when a swap arrives with no decode table.
        let mut w = WatchSet::default();
        w.logs.insert(
            to_addr(PROXY),
            TopicFilter::Topics(HashSet::from([
                // MAKER-ONLY, deliberately: TakerTradeExecuted is TAKERBOT
                // trading elsewhere (the header).
                logs::topic0::<MakerSwapExecuted>(),
                logs::topic0::<Upgraded>(),
                logs::topic0::<MakerTokenAdded>(),
                logs::topic0::<MakerTokenRetired>(),
                logs::topic0::<MakerPricesPushed>(),
                logs::topic0::<MakerRiskParamsPushed>(),
                logs::topic0::<MakerPageUpdated>(),
            ])),
        );
        Ok(w)
    }

    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        // State first: a token added in this block is listed before its fills.
        self.follow_registry(cx.registry, block)?;
        let swap = logs::topic0::<MakerSwapExecuted>();
        let proxy = to_addr(PROXY);
        let inner = self.inner.read();
        let mut out = Vec::new();
        for l in block.logs.iter().filter(|l| l.address == proxy && l.topic0() == Some(&swap)) {
            // With no decode table every swap would decode to nothing and the
            // cursor would pass fills no replay returns for: hold instead.
            if !inner.discovered {
                return Err(VenueError::NotReady("ThogAMM discovery unavailable".into()));
            }
            let Some(s) = logs::decode::<MakerSwapExecuted>(l) else { continue };
            if s.amountIn.is_zero() || s.amountOut.is_zero() {
                continue;
            }
            let (tin, tout) = (to_addr(s.tokenIn), to_addr(s.tokenOut));
            let Some(m) = inner.by_direction.get(&(tin, tout)) else { continue };
            let input_is_base = tin == m.base;
            let (base_raw, quote_raw) =
                if input_is_base { (s.amountIn, s.amountOut) } else { (s.amountOut, s.amountIn) };
            let base_amount = from_units(base_raw, m.base_dec);
            let quote_amount = from_units(quote_raw, m.quote_dec);
            if base_amount <= 0.0 || quote_amount <= 0.0 {
                continue;
            }
            // A settled leg's value: a closed market keeps its last good price.
            let mut usd = cx.pricer.usd_for_token(&m.quote_key, quote_amount);
            if usd <= 0.0 {
                usd = cx.pricer.usd_for_token(&m.base_key, base_amount);
            }
            if usd <= 0.0 {
                return Err(VenueError::Decode(format!("ThogAMM {}: no USD price for either fill leg", m.market)));
            }
            out.push(Fill {
                id: fill_id(ID, &l.tx_hash, l.log_index),
                venue_id: ID.into(),
                market: m.market.clone(),
                // Spent base ⇒ sell.
                side: if input_is_base { Side::Sell } else { Side::Buy },
                category: FillCategory::Unknown,
                usd,
                base_amount,
                exec_px: quote_amount / base_amount,
                px_approx: false,
                tx_hash: b32_hex(&l.tx_hash),
                // viem hands decoded addresses checksummed; today's label keeps that case.
                to: short_hex(&s.recipient.to_string()),
                router: None,
                pool: POOL_LABEL.into(),
                block_number: block.number,
                ts: block.time_ms(),
                markouts_bps: vec![None; 5],
                time_source: None,
            });
        }
        Ok(out)
    }

    fn markets(&self) -> Vec<String> {
        self.inner.read().active.iter().cloned().collect()
    }

    fn entry_points(&self) -> Vec<EntryPoint> {
        vec![EntryPoint { address: to_addr(PROXY), router: None }]
    }

    /// TAKERBOT's keeper self-funds price/risk pushes to the proxy, one event
    /// per push: the named pair until the 2026-10-22 upgrade (block
    /// 115,729,249), `MakerPageUpdated` (its lane is the push kind) after.
    /// Both also fire inside TAKERBOT's own price-pushing taker trades; the
    /// series has counted those from the start.
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        let proxy = to_addr(PROXY);
        Ok(Some(GasSources {
            logs: vec![
                (proxy, logs::topic0::<MakerPricesPushed>()),
                (proxy, logs::topic0::<MakerRiskParamsPushed>()),
                (proxy, logs::topic0::<MakerPageUpdated>()),
            ],
            ..GasSources::default()
        }))
    }

    /// Each `from` is the market's first possible fill, so the revision adds
    /// its whole history: SPYx's MakerTokenAdded is block 116,945,831
    /// (2026-10-27); the first XAUt0↔WBTC swap is block 101,922,564
    /// (2026-09-04).
    fn history_revisions(&self) -> Vec<HistoryRevision> {
        vec![
            HistoryRevision { id: "xstocks-usd-references", from: Some("2026-10-26"), markets: xstock_markets() },
            HistoryRevision { id: "xaut-wbtc-quote-basis", from: Some("2026-09-04"), markets: &["XAUt/BTC"] },
        ]
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        Some("2026-07-26")
    }
}

/// Every registered pair based on the five xStocks of 2026-10-27, in registry
/// order (today's `PAIRS.filter((p) => THOG_XSTOCKS_2026_10.includes(p.base))`).
fn xstock_markets() -> &'static [&'static str] {
    static M: OnceLock<Vec<&'static str>> = OnceLock::new();
    M.get_or_init(|| {
        Registry::get()
            .pairs
            .iter()
            .filter(|p| XSTOCKS_2026_10.contains(&p.base.as_str()))
            .map(|p| p.symbol.as_str())
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::addr_hex;

    #[test]
    fn labels() {
        assert_eq!(POOL_LABEL, format!("thogamm {}", &addr_hex(&to_addr(PROXY))[..10]));
    }
}
