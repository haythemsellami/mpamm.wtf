//! `depth-at`: depth curves for one market at one block, computed by the
//! service's own depth pass (`mpamm_quotes::depth`) with a frozen reference
//! (`capture-prices`), printed as JSON: the Rust half of the same-block depth
//! parity check. `server/scripts/depth-at.ts` is the other half and
//! `service/tools/compare-depth.py` diffs the two. The exchanges' curves are
//! left out on both sides (their books can't be frozen); only the venues'.
//!
//! With `--follow-secs`, it runs passes back to back against the node's
//! newest block instead, as the service's scheduler does (a pass at the
//! newest head, heads arriving meanwhile coalesced), and prints the cadence
//! and the cost per pass.

use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use mpamm_chain::Rpc;
use mpamm_core::{BlockRef, ChainCx, Venue};
use mpamm_pricing::{Fees, Prices};
use mpamm_quotes::{depth::Depth, FramePricer};
use mpamm_registry::Registry;

/// The reference `capture-prices` froze, as a frame. Each price from its own
/// text: serde_json's float parsing can land an ulp off JSON.parse's.
pub fn frozen_frame(registry: &'static Registry, path: &Path) -> Result<FramePricer, String> {
    type Raw = HashMap<String, Box<serde_json::value::RawValue>>;
    let v: HashMap<String, Raw> =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let map = |k: &str| -> HashMap<String, f64> {
        v.get(k)
            .map(|o| o.iter().map(|(a, b)| (a.clone(), b.get().parse::<f64>().unwrap_or(0.0))).collect())
            .unwrap_or_default()
    };
    Ok(FramePricer::fixed(registry, map("pairMid"), map("assetUsd")))
}

pub struct Args<'a> {
    pub market: &'a str,
    pub block: u64,
    pub prices: &'a Path,
    pub venues: &'a [String],
    pub rpc: &'a str,
    pub deadline_ms: u64,
    pub follow_secs: u64,
}

pub async fn depth_at(a: Args<'_>) -> Result<(), String> {
    let registry = Registry::get();
    if registry.pair_of(a.market).is_none() {
        return Err(format!("{} is not a registered market", a.market));
    }
    let rpc = Rpc::new("node", a.rpc, Duration::from_secs(30));
    let venues: Vec<Arc<dyn Venue>> = mpamm_venues::all()
        .into_iter()
        .filter(|v| a.venues.is_empty() || a.venues.iter().any(|x| x == v.id()))
        .collect();
    if venues.is_empty() {
        return Err(format!("no venue among {:?}", a.venues));
    }
    for v in &venues {
        v.discover(&ChainCx { rpc: &rpc, registry }).await.map_err(|e| format!("discover {}: {e}", v.id()))?;
    }
    let markets = [a.market.to_string()];
    let frame = Arc::new(frozen_frame(registry, a.prices)?.only_markets(&markets));
    // No deadline by default: parity wants every venue's answer.
    let deadline = if a.deadline_ms == 0 { Duration::from_secs(60) } else { Duration::from_millis(a.deadline_ms) };
    let prices = Prices::new(registry, Fees::default());
    let depth = Depth::new(venues, rpc.clone(), prices, registry, deadline, Duration::ZERO);
    if a.follow_secs > 0 {
        return follow(&depth, &rpc, &markets, frame, a.follow_secs).await;
    }
    let block = block_ref(&rpc, a.block).await?;
    let pass = depth.pass(&markets, block, frame, Vec::new()).await;
    for (v, ms) in &pass.venue_ms {
        eprintln!("{v}: {ms:.1} ms");
    }
    for (v, why) in &pass.missed {
        eprintln!("{v}: missed ({why})");
    }
    let mut s = pass.snapshots.into_iter().next().ok_or("no snapshot")?;
    s.ts = 0.0;
    eprintln!("{}: {} curve(s) at block {} in {:.1} ms", a.market, s.venues.len(), block.number, pass.ms);
    println!("{}", serde_json::to_string(&s).map_err(|e| e.to_string())?);
    Ok(())
}

async fn block_ref(rpc: &Rpc, number: u64) -> Result<BlockRef, String> {
    let number = if number == 0 { rpc.block_number().await.map_err(|e| e.to_string())? } else { number };
    let h = rpc.block_header(number).await.map_err(|e| e.to_string())?.ok_or(format!("no block {number}"))?;
    Ok(BlockRef { number, id: [0; 32], hash: h.hash })
}

/// Passes back to back at the newest block for `secs`, then the cadence
/// (blocks passed over while a pass ran) and the cost per pass and venue.
async fn follow(
    depth: &Depth,
    rpc: &Rpc,
    markets: &[String],
    frame: Arc<FramePricer>,
    secs: u64,
) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs(secs);
    let (mut last, mut skipped) = (0u64, 0u64);
    let mut pass_ms: Vec<f64> = Vec::new();
    let mut venue_ms: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut missed: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut points = 0usize;
    let started = Instant::now();
    while Instant::now() < end {
        let n = rpc.block_number().await.map_err(|e| e.to_string())?;
        if n <= last {
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        }
        if last > 0 {
            skipped += n - last - 1;
        }
        last = n;
        let block = block_ref(rpc, n).await?;
        let p = depth.pass(markets, block, frame.clone(), Vec::new()).await;
        pass_ms.push(p.ms);
        points += p.snapshots.iter().flat_map(|s| &s.venues).map(|c| c.points.len()).sum::<usize>();
        for (v, ms) in p.venue_ms {
            venue_ms.entry(v).or_default().push(ms);
        }
        for (v, why) in p.missed {
            let e = missed.entry(v).or_insert((0, String::new()));
            e.0 += 1;
            e.1 = why;
        }
    }
    let secs = started.elapsed().as_secs_f64();
    let pct = |v: &mut Vec<f64>, p: f64| {
        v.sort_by(f64::total_cmp);
        v.get(((v.len() as f64 * p).ceil() as usize).clamp(1, v.len().max(1)) - 1).copied().unwrap_or(0.0)
    };
    let n = pass_ms.len();
    println!(
        "{}: {n} passes in {secs:.1} s ({:.2}/s), {skipped} block(s) passed over; pass p50 {:.1} ms, p90 {:.1} ms, max {:.1} ms; {:.1} points per pass",
        markets.join(","),
        n as f64 / secs,
        pct(&mut pass_ms, 0.5),
        pct(&mut pass_ms, 0.9),
        pct(&mut pass_ms, 1.0),
        points as f64 / n.max(1) as f64
    );
    for (v, mut ms) in venue_ms {
        println!("  {v}: {} answered, p50 {:.1} ms, p90 {:.1} ms", ms.len(), pct(&mut ms, 0.5), pct(&mut ms, 0.9));
    }
    for (v, (k, why)) in missed {
        println!("  {v}: missed {k} ({why})");
    }
    Ok(())
}
