//! Verification tools for the port.
//!
//! `decode-range`: discovers one venue on a node, reads its watched logs for
//! a block range, decodes them block by block exactly as the pipeline does,
//! and prints the trades as JSON (sorted by id) — the Rust half of the
//! decode parity check; `server/scripts/decode-range.ts` is the other half
//! and `service/tools/compare-fills.py` diffs the two.

use std::{collections::BTreeMap, time::Duration};

use clap::{Parser, Subcommand};
use mpamm_chain::{parse_b32, parse_quantity, quantity, Rpc};
use mpamm_core::{ChainCx, DecodeCx, FinalBlock, FinalLog, Origin, Pricer, VenueState};
use mpamm_pricing::{Fees, Prices};
use mpamm_registry::{parse_address, Registry};
use mpamm_ring::hex;
use serde_json::{json, Value};

#[derive(Parser)]
#[command(name = "mpamm-tools")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Decode one venue's trades over [from, to] and print them as JSON.
    DecodeRange {
        #[arg(long)]
        venue: String,
        #[arg(long)]
        from: u64,
        #[arg(long)]
        to: u64,
        /// JSON-RPC of a node that has the range.
        #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8080")]
        rpc: String,
        /// Blocks per eth_getLogs request.
        #[arg(long, default_value_t = 1000)]
        chunk: u64,
        /// Run the exchange feeds for this many seconds first, so
        /// crypto-quoted trades get live USD (0 = no feeds).
        #[arg(long, default_value_t = 0)]
        live_prices_secs: u64,
    },
}

fn parse_log(l: &Value) -> Option<(u64, [u8; 32], FinalLog)> {
    Some((
        parse_quantity(&l["blockNumber"])?,
        parse_b32(&l["blockHash"])?,
        FinalLog {
            log_index: parse_quantity(&l["logIndex"])? as u32,
            txn_index: parse_quantity(&l["transactionIndex"])? as u32,
            tx_hash: parse_b32(&l["transactionHash"])?,
            address: parse_address(l["address"].as_str()?)?,
            topics: l["topics"].as_array()?.iter().map(parse_b32).collect::<Option<Vec<_>>>()?,
            data: mpamm_core::block::hex_bytes(l["data"].as_str()?)?,
        },
    ))
}

async fn decode_range(
    venue_id: &str,
    from: u64,
    to: u64,
    rpc_url: &str,
    chunk: u64,
    live_secs: u64,
) -> Result<(), String> {
    let registry = Registry::get();
    let rpc = Rpc::new("node", rpc_url, Duration::from_secs(60));
    let venue = mpamm_venues::all().into_iter().find(|v| v.id() == venue_id).ok_or(format!("no venue {venue_id}"))?;
    venue.discover(&ChainCx { rpc: &rpc, registry }).await.map_err(|e| e.to_string())?;
    let watch = venue.watch().map_err(|e| e.to_string())?;
    let addresses: Vec<String> = watch.logs.keys().map(|a| format!("0x{}", hex(a))).collect();
    eprintln!("{venue_id}: watching {} address(es) over {from}..={to}", addresses.len());

    let prices = Prices::new(registry, Fees::default());
    if live_secs > 0 {
        let (_stop_tx, stop) = tokio::sync::watch::channel(false);
        prices.spawn(rpc.clone(), Default::default(), stop);
        tokio::time::sleep(Duration::from_secs(live_secs)).await;
        std::mem::forget(_stop_tx);
    }

    // Watched logs, grouped by block.
    let mut blocks: BTreeMap<u64, ([u8; 32], Vec<FinalLog>)> = BTreeMap::new();
    let mut start = from;
    while start <= to && !addresses.is_empty() {
        let end = (start + chunk - 1).min(to);
        let logs = rpc
            .call(
                "eth_getLogs",
                json!([{ "fromBlock": quantity(start), "toBlock": quantity(end), "address": addresses }]),
            )
            .await
            .map_err(|e| format!("eth_getLogs {start}..{end}: {e}"))?;
        for l in logs.as_array().ok_or("eth_getLogs answer")? {
            let (n, hash, log) = parse_log(l).ok_or("malformed log")?;
            if !watch.wants_log(&log.address, log.topics.first()) {
                continue;
            }
            blocks.entry(n).or_insert((hash, Vec::new())).1.push(log);
        }
        start = end + 1;
    }

    let state = VenueState::default();
    let mut fills = Vec::new();
    for (n, (hash, mut logs)) in blocks {
        logs.sort_by_key(|l| l.log_index);
        let header = rpc.block_header(n).await.map_err(|e| e.to_string())?.ok_or(format!("no block {n}"))?;
        let block = FinalBlock {
            number: n,
            hash,
            parent_hash: header.parent_hash,
            timestamp: header.timestamp,
            proposal_ns: None,
            base_fee: header.base_fee,
            txns: Vec::new(),
            logs,
            origin: Origin::Rpc("node".into()),
        };
        let pricer = prices.at(block.time_ms());
        let cx = DecodeCx { registry, pricer: &pricer as &dyn Pricer, state: &state };
        fills.extend(venue.decode(&cx, &block).map_err(|e| format!("block {n}: {e}"))?);
        let _ = state.take_pending();
    }
    fills.sort_by(|a, b| a.id.cmp(&b.id));
    let out: Vec<Value> = fills
        .iter()
        .map(|f| {
            json!({
                "id": f.id, "market": f.market, "side": f.side, "category": f.category, "usd": f.usd,
                "baseAmount": f.base_amount, "execPx": f.exec_px, "pxApprox": f.px_approx, "pool": f.pool,
                "to": f.to, "router": f.router, "blockNumber": f.block_number,
            })
        })
        .collect();
    println!("{}", serde_json::to_string(&out).unwrap());
    eprintln!("{venue_id}: {} trade(s)", fills.len());
    Ok(())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("warn").with_writer(std::io::stderr).init();
    let r = match Cli::parse().cmd {
        Cmd::DecodeRange { venue, from, to, rpc, chunk, live_prices_secs } => {
            decode_range(&venue, from, to, &rpc, chunk, live_prices_secs).await
        }
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
