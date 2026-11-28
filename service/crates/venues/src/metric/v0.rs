//! Metric v0, the RETIRED first deployment (server/src/venues/metric-v0.ts).
//! Kept because its swaps are Metric's history from 2026-03-30 to
//! 2026-09-27 and a lifetime replay must decode them again: decode-only, no
//! discovery, its span bounded at the last v0 swap.
//!
//! Retirement, verified on-chain 2026-10-12: liquidity pulled 2026-09-30, the
//! push oracle's last update at block 108,407,309, and the last Swap on any of
//! the eight pools at block 108,406,568.

use std::collections::{HashMap, HashSet};

use alloy_primitives::{address, Address};
use alloy_sol_types::sol;
use mpamm_core::{DecodeCx, EntryPoint, FinalBlock, GasSources, VenueError};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::{Addr, TopicFilter, WatchSet};
use mpamm_types::Fill;

use super::shared::{admit_pool, metric_fill, MetricPool, PoolTokens};
use crate::{
    generations::{Generation, Span},
    logs,
    util::to_addr,
};

/// Last block with a v0 Swap: the swap source's span ends here.
pub const V0_LAST_SWAP_BLOCK: u64 = 108_406_568;

/// The v0 push oracle (no logs). It went quiet with the pools but STAYS a gas
/// destination: dropping it would read as a removal of Metric's gas history.
pub const V0_PUSH_ORACLE: Address = address!("681e908b8ab57c49c74d770f369754ccc3e1ae09");

const WMON: &str = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const WBTC: &str = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const WETH: &str = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242";
const USDC: &str = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

/// Every pool the v0 factory ever created, with the token layout
/// getImmutables reports (pool, token0, token1, price provider). Casing is
/// DELIBERATE: the three funded seeds keep the checksum spelling today's
/// stored `pool` labels carry (`metric 0x2D82AC`).
pub const V0_POOLS: [(&str, &str, &str, &str); 8] = [
    ("0x7e4d6287b0a36822bb454dff8500562ecde2d937", WBTC, USDC, "0x3a911762cf640b482e72fe53462419798c9ed591"),
    ("0x2D82AC42334b394A9a8d8f097d61DC1c6B065Fd8", WBTC, USDC, "0x3a911762cf640b482e72fe53462419798c9ed591"),
    ("0x3826750cbd476de7e15f71357a5c1c57c1b75e53", WMON, USDC, "0xf034c1d706e0939e6a5c64ea0fa98620b34964cf"),
    ("0xFA32f9ec28787d1F9C5BA5c39e54e59984FEF3f0", WMON, USDC, "0xeafd2cde852fce3d00c743b46dcdec41e8168021"),
    ("0xe3eedcd6be6c8ebd37861deed30a99a12e984948", WMON, USDC, "0x3a911762cf640b482e72fe53462419798c9ed591"),
    ("0x4e3613b28d00e83c85d616760a847f1a1411d9c4", WETH, USDC, "0x6f3ad3ff7e95f08fe852d46ec8170b4aab225ef8"),
    ("0x354D92279cA0190fF275095fE6A2a6989BAa66Fb", WETH, USDC, "0x6f3ad3ff7e95f08fe852d46ec8170b4aab225ef8"),
    ("0x5357bf9863320e8fc0c10c97896c0aed070aab9f", WMON, USDC, "0xeafd2cde852fce3d00c743b46dcdec41e8168021"),
];

sol! {
    event Swap(address sender, address recipient, bool exactInput, int128 amount0Delta, int128 amount1Delta, int16 newTick, uint104 newPositionInBin);
}

pub struct MetricV0 {
    pools: Vec<MetricPool>,
    by_addr: HashMap<Addr, MetricPool>,
}

impl MetricV0 {
    /// The static table through the same structural admission as v1; a pool
    /// that fails it never traded a market we report, so it is not tailed.
    pub fn new(registry: &Registry) -> Self {
        let pools: Vec<MetricPool> = V0_POOLS
            .iter()
            .filter_map(|(pool, t0, t1, prov)| {
                let addr = parse_address(pool)?;
                let tokens = PoolTokens {
                    token0: parse_address(t0)?,
                    token1: parse_address(t1)?,
                    price_provider: parse_address(prov)?,
                };
                admit_pool(registry, addr, pool, Some(&tokens)).ok()
            })
            .collect();
        let by_addr = pools.iter().map(|p| (p.pool, p.clone())).collect();
        Self { pools, by_addr }
    }

    pub fn pools(&self) -> &[MetricPool] {
        &self.pools
    }
}

impl Generation for MetricV0 {
    fn span(&self) -> Span {
        Span { from: None, until: Some(V0_LAST_SWAP_BLOCK) }
    }

    fn watch(&self) -> Result<WatchSet, VenueError> {
        let mut w = WatchSet::default();
        for p in &self.pools {
            w.logs.insert(p.pool, TopicFilter::Topics(HashSet::from([logs::topic0::<Swap>()])));
        }
        w.txn_input.insert(to_addr(V0_PUSH_ORACLE));
        Ok(w)
    }

    fn decode(&self, _cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let mut out = Vec::new();
        for l in &block.logs {
            let Some(p) = self.by_addr.get(&l.address) else { continue };
            let Some(s) = logs::decode::<Swap>(l) else { continue };
            out.extend(metric_fill(p, s.amount0Delta, s.amount1Delta, l, s.recipient, block));
        }
        Ok(out)
    }

    /// The markout onboarding can still label v0 fills: the pools stay
    /// DIRECT entry points.
    fn entry_points(&self) -> Vec<EntryPoint> {
        self.pools.iter().map(|p| EntryPoint { address: p.pool, router: None }).collect()
    }

    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(Some(GasSources { destinations: vec![to_addr(V0_PUSH_ORACLE)], ..GasSources::default() }))
    }
}
