//! LFJ POE, ported from server/src/venues/poe.ts: LFJ's Public Prop AMM.
//! Each pool prices off a ClapOracle (concentrated-liquidity constant
//! product); `getQuote` returns an executable, fee-inclusive amount.
//!
//!   Factory.getPool(x, y) → the pool for a registered (base, stable)
//!   Pool.getTokens()      → which side is the base
//!   Pool.Swap(…)          → the trade
//!
//! Gas: LFJ's keeper pushes `setData()` to the shared ClapOracle every block
//! with no event; every transaction to it is a quote update (400/400
//! sampled, docs.lfj.gg/poe). The oracle is re-read from `pool.getOracle()`
//! at every discovery so a migration is followed.

use std::collections::{HashMap, HashSet};

use alloy_primitives::{address, Address};
use alloy_sol_types::sol;
use async_trait::async_trait;
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, GasSources, Venue, VenueError};
use mpamm_registry::Registry;
use mpamm_ring::{Addr, TopicFilter, WatchSet};
use mpamm_types::{Fill, FillCategory, Side, ThemeColor, VenueKind, VenueMeta, VenueRole};
use parking_lot::RwLock;

use crate::{
    chain::{call, call_many, At},
    logs,
    util::{addr_hex, fill_id, from_units, short_hex, to_addr},
};

pub const ID: &str = "poe";
const FACTORY: Address = address!("78120F2C0EBF0cc8B7E7749e62D36e6523dD711D");

sol! {
    function getPool(address tokenX, address tokenY) view returns (address);
    function getTokens() view returns (address tokenX, address tokenY);
    function getOracle() view returns (address);
    event Swap(address indexed sender, address indexed recipient, bool indexed swapXtoY, uint256 actualAmountIn, uint256 amountOut, uint256 feeIn, uint256 feeOut);
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    pub pool: Addr,
    pub market: String,
    /// The base asset is the pool's tokenX.
    pub base_is_x: bool,
    pub base_token: String,
    pub base_dec: u8,
    pub stable_dec: u8,
}

#[derive(Debug, Default)]
struct Inner {
    by_market: HashMap<String, Pool>,
    by_addr: HashMap<Addr, Pool>,
    discovered: bool,
    oracle: Option<Addr>,
}

#[derive(Default)]
pub struct Poe {
    inner: RwLock<Inner>,
}

pub fn meta() -> VenueMeta {
    VenueMeta {
        id: ID.into(),
        name: "LFJ POE".into(),
        color: ThemeColor { light: "#FF4D00".into(), dark: "#EA580C".into() },
        kind: VenueKind::Amm,
        role: VenueRole::Venue,
        taker: None,
        taker_bps: None,
        since_utc: Some("2026-05-09".into()),
        quote_note: None,
    }
}

impl Poe {
    /// A venue already discovered (tests and tools).
    pub fn with_pools(pools: Vec<Pool>, oracle: Option<Addr>) -> Self {
        let p = Self::default();
        p.merge(pools, oracle);
        p
    }

    fn merge(&self, pools: Vec<Pool>, oracle: Option<Addr>) {
        let mut inner = self.inner.write();
        for p in pools {
            inner.by_addr.insert(p.pool, p.clone());
            inner.by_market.insert(p.market.clone(), p);
        }
        if oracle.is_some() {
            inner.oracle = oracle;
        }
        inner.discovered = true;
    }

    /// The (pair, base wrapper, stable) combinations POE could list: every
    /// registered pair whose quote is a stable.
    fn combos(registry: &Registry) -> Vec<(String, String, Addr, u8, Addr, u8)> {
        registry
            .pairs
            .iter()
            .filter_map(|pair| {
                let asset = registry.asset_of(&pair.base)?;
                let base = registry.base_token_of(&pair.base)?;
                let stable = registry.tokens.get(&pair.quote).filter(|t| t.stable)?;
                Some((
                    pair.symbol.clone(),
                    asset.token.clone(),
                    base.address_bytes(),
                    base.decimals,
                    stable.address_bytes(),
                    stable.decimals,
                ))
            })
            .collect()
    }
}

#[async_trait]
impl Venue for Poe {
    fn id(&self) -> &str {
        ID
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![meta()]
    }

    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let combos = Self::combos(cx.registry);
        let calls: Vec<(Address, getPoolCall)> = combos
            .iter()
            .map(|c| (FACTORY, getPoolCall { tokenX: Address::from(c.2), tokenY: Address::from(c.4) }))
            .collect();
        let pools = call_many(cx.rpc, &calls, At::Latest).await?;
        let mut candidates = Vec::new();
        for (c, r) in combos.iter().zip(pools) {
            // Fail closed: a configured lookup that errors holds discovery.
            let addr = r.map_err(|e| VenueError::Chain(format!("POE getPool for {}: {e}", c.0)))?;
            if addr != Address::ZERO {
                candidates.push((to_addr(addr), c));
            }
        }
        if candidates.is_empty() {
            self.merge(Vec::new(), None);
            tracing::info!(target: "venues", "POE: 0 base/stable pool(s)");
            return Ok(());
        }
        let tok_calls: Vec<(Address, getTokensCall)> =
            candidates.iter().map(|(p, _)| (Address::from(*p), getTokensCall {})).collect();
        let tokens = call_many(cx.rpc, &tok_calls, At::Latest).await?;
        // The shared oracle, from the first pool; a failed read only defers gas.
        let oracle = call(cx.rpc, Address::from(candidates[0].0), &getOracleCall {}, At::Latest)
            .await
            .ok()
            .filter(|o| *o != Address::ZERO)
            .map(to_addr);
        let mut found = Vec::new();
        for ((pool, c), r) in candidates.iter().zip(tokens) {
            let t = r.map_err(|e| VenueError::Chain(format!("POE getTokens for {}: {e}", addr_hex(pool))))?;
            found.push(Pool {
                pool: *pool,
                market: c.0.clone(),
                base_is_x: to_addr(t.tokenX) == c.2,
                base_token: c.1.clone(),
                base_dec: c.3,
                stable_dec: c.5,
            });
        }
        // Merge, never replace: a partial answer must not shrink what is tailed.
        self.merge(found, oracle);
        tracing::info!(target: "venues", "POE: {} base/stable pool(s)", self.inner.read().by_market.len());
        Ok(())
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        let inner = self.inner.read();
        if !inner.discovered {
            return Err(VenueError::NotReady("POE discovery unavailable".into()));
        }
        let mut w = WatchSet::default();
        for addr in inner.by_addr.keys() {
            w.logs.insert(*addr, TopicFilter::Topics(HashSet::from([logs::topic0::<Swap>()])));
        }
        if let Some(o) = inner.oracle {
            w.txn_input.insert(o);
        }
        Ok(w)
    }

    fn decode(&self, _cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let inner = self.inner.read();
        let mut out = Vec::new();
        for l in &block.logs {
            let Some(p) = inner.by_addr.get(&l.address) else { continue };
            let Some(s) = logs::decode::<Swap>(l) else { continue };
            // swapXtoY sends X→Y, so the input is the base exactly when swapXtoY == baseIsX.
            let input_is_base = s.swapXtoY == p.base_is_x;
            let (base_raw, stable_raw) =
                if input_is_base { (s.actualAmountIn, s.amountOut) } else { (s.amountOut, s.actualAmountIn) };
            let base_amount = from_units(base_raw, p.base_dec);
            let usd = from_units(stable_raw, p.stable_dec);
            if base_amount <= 0.0 || usd <= 0.0 {
                continue;
            }
            out.push(Fill {
                id: fill_id(ID, &l.tx_hash, l.log_index),
                venue_id: ID.into(),
                market: p.market.clone(),
                // Spent base ⇒ sell.
                side: if input_is_base { Side::Sell } else { Side::Buy },
                // Attribution is the core's job: never claim DIRECT here.
                category: FillCategory::Unknown,
                usd,
                base_amount,
                exec_px: usd / base_amount,
                px_approx: false,
                tx_hash: crate::util::b32_hex(&l.tx_hash),
                // viem hands decoded addresses checksummed; today's label keeps that case.
                to: short_hex(&s.recipient.to_string()),
                router: None,
                pool: format!("poe {}", &addr_hex(&p.pool)[..8]),
                block_number: block.number,
                ts: block.time_ms(),
                markouts_bps: vec![None; 5],
                time_source: None,
            });
        }
        Ok(out)
    }

    fn markets(&self) -> Vec<String> {
        let mut m: Vec<String> = self.inner.read().by_market.keys().cloned().collect();
        m.sort();
        m
    }

    fn entry_points(&self) -> Vec<EntryPoint> {
        self.inner.read().by_addr.keys().map(|a| EntryPoint { address: *a, router: None }).collect()
    }

    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        match self.inner.read().oracle {
            Some(o) => Ok(Some(GasSources { destinations: vec![o], relays: Vec::new() })),
            None => Err(VenueError::NotReady("POE oracle not resolved yet".into())),
        }
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        Some("2026-05-09")
    }
}
