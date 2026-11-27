//! Verification tools for the port.
//!
//! `decode-range`: discovers one venue on a node, reads its watched logs for
//! a block range, decodes them block by block exactly as the pipeline does,
//! and prints the trades as JSON (sorted by id) — the Rust half of the
//! decode parity check; `server/scripts/decode-range.ts` is the other half
//! and `service/tools/compare-fills.py` diffs the two.
//!
//! `archive-marks`: trades marked from the exchanges' archives, the Rust half
//! of the archive parity check against today's `history/cex.ts`.
//!
//! `parity`: the shadow run's check, the service's database against
//! production's public `/api/fills` (see `parity.rs`).
//!
//! `depth-at`: depth curves at one block with a frozen reference, the Rust
//! half of the depth parity check (see `depth.rs`).

mod depth;
mod migrate;
mod parity;
mod verify;

use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Duration,
};

use clap::{Parser, Subcommand};
use mpamm_chain::{parse_b32, parse_quantity, quantity, Rpc};
use mpamm_core::{ChainCx, DecodeCx, FinalLog, Pricer, VenueError, VenueState};
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
        /// Skip blocks whose watched logs are all the venue's gas-event logs
        /// (a keeper pushing every block makes nearly every block one).
        #[arg(long)]
        skip_gas_only: bool,
    },
    /// Cost one venue's quote-update gas over [from, to] two ways: as the
    /// pipeline does (transaction headers, gas limit × price paid) and from
    /// receipts (gasUsed × effectiveGasPrice), and compare.
    /// Run the exchange feeds a while and freeze the reference (asset USD,
    /// pair mids) into a file both quote-at tools read.
    CapturePrices {
        #[arg(long, default_value_t = 15)]
        secs: u64,
        #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8080")]
        rpc: String,
        #[arg(long)]
        out: PathBuf,
    },
    /// Quote one venue at one block (reads pinned to its hash) with a frozen
    /// reference, and print the rows as JSON.
    QuoteAt {
        #[arg(long)]
        venue: String,
        #[arg(long)]
        block: u64,
        #[arg(long)]
        prices: PathBuf,
        #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8080")]
        rpc: String,
    },
    /// Depth curves for one market at one block (reads pinned to its hash)
    /// with a frozen reference, as the service computes them, printed as
    /// JSON; or, with --follow-secs, passes back to back at the newest block
    /// with their cadence and cost.
    DepthAt {
        #[arg(long)]
        market: String,
        /// 0 = the node's newest block.
        #[arg(long, default_value_t = 0)]
        block: u64,
        #[arg(long)]
        prices: PathBuf,
        /// Venues quoted (default: every venue).
        #[arg(long, value_delimiter = ',')]
        venues: Vec<String>,
        #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8080")]
        rpc: String,
        /// Deadline per venue in ms (0 = none, for parity).
        #[arg(long, default_value_t = 0)]
        deadline_ms: u64,
        #[arg(long, default_value_t = 0)]
        follow_secs: u64,
    },
    /// Copy today's database into the new schema and verify it.
    Migrate {
        /// Today's SQLite database (opened read-only).
        #[arg(long)]
        from: PathBuf,
        /// The new database (must not exist yet, or have no cursor).
        #[arg(long)]
        to: PathBuf,
    },
    GasCheck {
        #[arg(long)]
        venue: String,
        #[arg(long)]
        from: u64,
        #[arg(long)]
        to: u64,
        #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8080")]
        rpc: String,
    },
    /// The live checklist for a venue module's PR (today's verify-adapter):
    /// registry entry, discovery, quotes, watch set, a recent window decoded,
    /// gas rules; exits 1 on any failure.
    VerifyVenue {
        #[arg(long)]
        venue: String,
        #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8080")]
        rpc: String,
        /// Blocks decoded back from the head.
        #[arg(long, default_value_t = 3000)]
        span: u64,
        /// Seconds the exchange feeds warm before quoting.
        #[arg(long, default_value_t = 20)]
        warm_secs: u64,
    },
    /// Diff the service's trades against production's over a block window;
    /// exits 1 on any difference.
    Parity {
        /// The service's database (opened read-only).
        #[arg(long)]
        db: PathBuf,
        /// Production's origin; its public /api/fills is read.
        #[arg(long, default_value = "https://mpamm.wtf")]
        prod: String,
        /// A saved /api/fills response instead of fetching one.
        #[arg(long)]
        prod_file: Option<PathBuf>,
        /// How far back both sides are read.
        #[arg(long, default_value_t = 24.0)]
        hours: f64,
        /// First block compared (default: the later side's earliest trade).
        #[arg(long)]
        from_block: Option<u64>,
        /// Blocks left out at the newer end, for production's tail lag.
        #[arg(long, default_value_t = 20)]
        margin: u64,
        /// Relative USD tolerance on crypto-quoted markets.
        #[arg(long, default_value_t = 0.002)]
        usd_tolerance: f64,
        /// Crypto-quoted USD past the tolerance but within this is reported
        /// as pricing drift, not a difference.
        #[arg(long, default_value_t = 0.01)]
        drift_max: f64,
        /// Venues compared (default: every venue the service runs).
        #[arg(long, value_delimiter = ',')]
        venues: Vec<String>,
    },
    /// Mark trades from the exchanges' archives, as markouts after the fact
    /// do (every horizon, whatever the trades already carry), and print
    /// `[{id, markoutsBps, verdict}]` as JSON: the Rust half of the archive
    /// parity check against today's history/cex.ts.
    ArchiveMarks {
        /// Trades as `/api/fills` returns them.
        #[arg(long)]
        fills: PathBuf,
        /// The archives' cache directory.
        #[arg(long)]
        cache: PathBuf,
    },
}

/// Marks `fills` from the archives and prints the result.
async fn archive_marks(fills: &std::path::Path, cache: &std::path::Path) -> Result<(), String> {
    let mut trades: Vec<mpamm_types::Fill> =
        serde_json::from_slice(&std::fs::read(fills).map_err(|e| format!("{}: {e}", fills.display()))?)
            .map_err(|e| format!("{}: {e}", fills.display()))?;
    for f in &mut trades {
        f.markouts_bps = vec![None; mpamm_types::MARKOUT_HORIZONS_S.len()];
    }
    let archives =
        mpamm_pricing::archives::Archives::new(Registry::get(), mpamm_pricing::archives::ArchiveConfig::new(cache));
    let t0 = std::time::Instant::now();
    let now = mpamm_ring::live::now_ms() as f64;
    let verdicts = mpamm_markouts::archive::mark_from_archives(&archives, &trades, now).await;
    eprintln!("marked {} trade(s) in {:.1}s", verdicts.len(), t0.elapsed().as_secs_f64());
    let out: Vec<Value> = verdicts
        .into_iter()
        .map(|(id, v)| match v {
            mpamm_markouts::archive::Verdict::Marked(m) => json!({ "id": id, "markoutsBps": m, "verdict": "marked" }),
            mpamm_markouts::archive::Verdict::Never(why) => json!({ "id": id, "verdict": "never", "why": why }),
            mpamm_markouts::archive::Verdict::Later(why) => json!({ "id": id, "verdict": "later", "why": why }),
        })
        .collect();
    println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn parity_cmd(
    db: &std::path::Path,
    prod: &str,
    prod_file: Option<&std::path::Path>,
    hours: f64,
    from_block: Option<u64>,
    margin: u64,
    usd_tolerance: f64,
    drift_max: f64,
    venues: Vec<String>,
) -> Result<(), String> {
    let since_ms = mpamm_ring::live::now_ms() as f64 - hours * 3_600_000.0;
    let prod_fills: Vec<mpamm_types::Fill> = match prod_file {
        Some(f) => serde_json::from_slice(&std::fs::read(f).map_err(|e| format!("{}: {e}", f.display()))?)
            .map_err(|e| format!("{}: {e}", f.display()))?,
        None => {
            let days = (hours / 24.0).ceil().max(1.0);
            let url = format!("{}/api/fills?days={days}&limit=50000", prod.trim_end_matches('/'));
            let resp = reqwest::Client::new()
                .get(&url)
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|e| format!("{url}: {e}"))?;
            resp.json().await.map_err(|e| format!("{url}: {e}"))?
        }
    };
    let prod_fills: Vec<_> = prod_fills.into_iter().filter(|f| f.ts >= since_ms).collect();
    if prod_fills.len() >= 50_000 {
        eprintln!("warning: production returned its 50,000-fill cap; the oldest blocks may be missing on its side");
    }
    let store = mpamm_store::Store::open_readonly(db).map_err(|e| format!("{}: {e}", db.display()))?;
    let local = store.trades_between(since_ms, f64::MAX, usize::MAX >> 1).map_err(|e| e.to_string())?;
    let venues: BTreeSet<String> = if venues.is_empty() {
        mpamm_venues::all().iter().flat_map(|v| v.meta()).map(|m| m.id).collect()
    } else {
        venues.into_iter().collect()
    };
    let window = parity::Window::common(&prod_fills, &local, from_block, margin)
        .ok_or("no common block window (one side has no trades yet)")?;
    let reports = parity::compare(&prod_fills, &local, window, &venues, usd_tolerance, drift_max);
    let trades_ok = parity::print(window, &reports);
    // Whole UTC days: per venue-day volume against production's /api/volume.
    let today = mpamm_types::utc_day(mpamm_ring::live::now_ms() as f64);
    let all_local = store.trades_between(0.0, f64::MAX, usize::MAX >> 1).map_err(|e| e.to_string())?;
    let days = parity::full_days(&all_local, &today);
    let volume_ok = match (days.first(), days.last(), prod_file) {
        (Some(first), Some(last), None) => {
            let url = format!("{}/api/volume?from={first}&to={last}", prod.trim_end_matches('/'));
            let prod_volume: Vec<mpamm_types::DailyVolume> = reqwest::Client::new()
                .get(&url)
                .timeout(Duration::from_secs(60))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|e| format!("{url}: {e}"))?
                .json()
                .await
                .map_err(|e| format!("{url}: {e}"))?;
            let local_volume = store.volume_days(&today).map_err(|e| e.to_string())?;
            parity::print_volume(
                &days,
                &parity::compare_volume(&prod_volume, &local_volume, &days, &venues, usd_tolerance),
            )
        }
        _ => parity::print_volume(&BTreeSet::new(), &[]),
    };
    if trades_ok && volume_ok {
        Ok(())
    } else {
        Err("the service and production differ".into())
    }
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

/// The watched logs of `from..=to`, by block (number → hash, logs).
type BlockLogs = BTreeMap<u64, ([u8; 32], Vec<FinalLog>)>;

/// Decodes every block of `from..=to` holding one of the venue's watched
/// logs, read as the pipeline's RPC repair reads it, with venue state kept
/// across blocks as the service commits it. Returns the trades and the
/// watched logs by block.
async fn decode_blocks(
    venue: &std::sync::Arc<dyn mpamm_core::Venue>,
    rpc: &Rpc,
    prices: &Prices,
    from: u64,
    to: u64,
    chunk: u64,
    skip_gas_only: bool,
) -> Result<(Vec<mpamm_types::Fill>, BlockLogs), String> {
    let registry = Registry::get();
    let venue_id = venue.id().to_string();
    let watch = venue.watch().map_err(|e| e.to_string())?;
    let addresses: Vec<String> = watch.logs.keys().map(|a| format!("0x{}", hex(a))).collect();
    let mut blocks: BlockLogs = BTreeMap::new();
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

    // Each block with watched logs is read exactly as the pipeline's RPC
    // repair reads it (full transactions, the watched logs), so decode sees
    // what it would see in the service.
    let fetcher = mpamm_pipeline::Fetcher { local: rpc.clone(), archive: None };
    let mut state = VenueState::default();
    let mut fills = Vec::new();
    let gas_logs: std::collections::HashSet<([u8; 20], [u8; 32])> =
        venue.gas_sources().ok().flatten().map(|g| g.logs.into_iter().collect()).unwrap_or_default();
    let wanted: Vec<u64> = blocks
        .iter()
        .filter(|(_, (_, logs))| {
            !skip_gas_only || logs.iter().any(|l| l.topic0().is_none_or(|t| !gas_logs.contains(&(l.address, *t))))
        })
        .map(|(n, _)| *n)
        .collect();
    if skip_gas_only {
        eprintln!("{venue_id}: {} of {} blocks hold more than gas-event logs", wanted.len(), blocks.len());
    }
    for n in wanted {
        let block = fetcher.block(n, &watch).await.map_err(|e| format!("block {n}: {e}"))?;
        let pricer = prices.at(block.time_ms());
        // A venue that holds a block until discovery has read the chain
        // (Clober's unclassified books) is retried after one, as the service
        // retries the held block and rediscovers.
        let mut retries = 0;
        let decoded = loop {
            let cx = DecodeCx { registry, pricer: &pricer as &dyn Pricer, state: &state };
            match venue.decode(&cx, &block) {
                Ok(f) => break f,
                Err(VenueError::NotReady(e)) if retries < 5 => {
                    retries += 1;
                    eprintln!("block {n}: {e}; rediscovering");
                    state.take_pending();
                    venue.discover(&ChainCx { rpc, registry }).await.map_err(|e| e.to_string())?;
                }
                Err(e) => return Err(format!("block {n}: {e}")),
            }
        };
        fills.extend(decoded);
        // Venue state persists across blocks, as committed in the service.
        let writes = state.take_pending();
        state.apply(&writes);
    }
    Ok((fills, blocks))
}

async fn decode_range(
    venue_id: &str,
    from: u64,
    to: u64,
    rpc_url: &str,
    chunk: u64,
    live_secs: u64,
    skip_gas_only: bool,
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

    let (mut fills, _) = decode_blocks(&venue, &rpc, &prices, from, to, chunk, skip_gas_only).await?;
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

async fn gas_check(venue_id: &str, from: u64, to: u64, rpc_url: &str) -> Result<(), String> {
    use std::sync::Arc;
    let registry = Registry::get();
    let rpc = Rpc::new("node", rpc_url, Duration::from_secs(60));
    let venue = mpamm_venues::all().into_iter().find(|v| v.id() == venue_id).ok_or(format!("no venue {venue_id}"))?;
    venue.discover(&ChainCx { rpc: &rpc, registry }).await.map_err(|e| e.to_string())?;
    // As the pipeline does: a venue may load a gas source in decode (WOOFi's
    // persisted Wooracles), so one empty block is decoded before the sources
    // are read, and each block after.
    let state = VenueState::new(std::collections::HashMap::new());
    let empty = mpamm_core::FinalBlock {
        number: from,
        hash: [0; 32],
        parent_hash: [0; 32],
        timestamp: 0,
        proposal_ns: None,
        base_fee: 0,
        txns: vec![],
        logs: vec![],
        origin: mpamm_core::Origin::Rpc("warm-up".into()),
    };
    let _ = venue.decode(&DecodeCx { registry, pricer: &mpamm_core::NoPrices, state: &state }, &empty);
    state.take_pending();
    let sources = venue.gas_sources().map_err(|e| e.to_string())?.ok_or("venue has no gas sources")?;
    // The recount reads receipts, independently of the pipeline's rules: a
    // transaction is the venue's when it is sent to a destination, when its
    // receipt holds one of the venue's gas logs, or when it calls a relay
    // naming one of the relay's targets in its head word.
    let dests: std::collections::HashSet<String> =
        sources.destinations.iter().map(|d| format!("0x{}", hex(d))).collect();
    let gas_logs: std::collections::HashSet<(String, String)> =
        sources.logs.iter().map(|(a, t)| (format!("0x{}", hex(a)), format!("0x{}", hex(t)))).collect();
    let relays: Vec<(String, String, usize, std::collections::HashSet<String>)> = sources
        .relays
        .iter()
        .map(|r| {
            let targets = if r.targets.is_empty() { &sources.destinations } else { &r.targets };
            (
                format!("0x{}", hex(&r.address)),
                format!("0x{}", hex(&r.selector)),
                r.target_word,
                targets.iter().map(|t| hex(t)).collect(),
            )
        })
        .collect();
    let relayed = |tx: &Value| {
        let to = tx["to"].as_str().unwrap_or("").to_ascii_lowercase();
        let input = tx["input"].as_str().unwrap_or("").to_ascii_lowercase();
        relays.iter().any(|(addr, sel, word, targets)| {
            let at = 10 + 64 * word; // "0x" + selector, then 32-byte words
            *addr == to
                && input.starts_with(sel.as_str())
                && input.get(at..at + 24).is_some_and(|z| z.bytes().all(|b| b == b'0'))
                && input.get(at + 24..at + 64).is_some_and(|a| targets.contains(a))
        })
    };
    let watch = venue.watch().map_err(|e| e.to_string())?;
    let venues: Vec<Arc<dyn mpamm_core::Venue>> = vec![venue];
    let (mut a_mon, mut a_txs, mut b_mon, mut b_txs, mut differ) = (0.0f64, 0u64, 0.0f64, 0u64, 0u64);
    let mut n = from;
    while n <= to {
        let end = (n + 24).min(to);
        let nums: Vec<u64> = (n..=end).collect();
        let blocks: Vec<(&str, Value)> =
            nums.iter().map(|b| ("eth_getBlockByNumber", json!([quantity(*b), true]))).collect();
        let receipts: Vec<(&str, Value)> =
            nums.iter().map(|b| ("eth_getBlockReceipts", json!([quantity(*b)]))).collect();
        let (bs, rs) = (
            rpc.batch(&blocks).await.map_err(|e| e.to_string())?,
            rpc.batch(&receipts).await.map_err(|e| e.to_string())?,
        );
        for ((num, b), r) in nums.iter().zip(bs).zip(rs) {
            let b = b.map_err(|e| format!("block {num}: {e}"))?;
            let r = r.map_err(|e| format!("receipts {num}: {e}"))?;
            // The pipeline's view: the block with its watched logs, as RPC
            // repair builds it (the logs taken from the receipts here).
            let all_logs: Vec<Value> = r
                .as_array()
                .ok_or("receipts")?
                .iter()
                .flat_map(|rc| rc["logs"].as_array().cloned().unwrap_or_default())
                .collect();
            let block = mpamm_core::FinalBlock::from_rpc(&b, &Value::Array(all_logs), &watch, "node")
                .map_err(|e| e.to_string())?;
            let cx = DecodeCx { registry, pricer: &mpamm_core::NoPrices, state: &state };
            let _ = venues[0].decode(&cx, &block);
            state.take_pending();
            let rules = mpamm_pipeline::gas::GasRules::of(&venues).map_err(|e| e.to_string())?;
            let acc = rules.accrue(&block);
            let (am, at) = acc.first().map_or((0.0, 0), |g| (g.mon, g.txs));
            let (mut bm, mut bt) = (0.0, 0u64);
            let txs = b["transactions"].as_array().ok_or("transactions")?;
            for (i, rc) in r.as_array().ok_or("receipts")?.iter().enumerate() {
                let to = rc["to"].as_str().unwrap_or("").to_ascii_lowercase();
                let logged = rc["logs"].as_array().is_some_and(|ls| {
                    ls.iter().any(|l| {
                        let addr = l["address"].as_str().unwrap_or("").to_ascii_lowercase();
                        let t0 = l["topics"][0].as_str().unwrap_or("").to_ascii_lowercase();
                        gas_logs.contains(&(addr, t0))
                    })
                });
                if dests.contains(&to) || logged || txs.get(i).is_some_and(&relayed) {
                    let used = mpamm_chain::parse_quantity_u128(&rc["gasUsed"]).unwrap_or(0);
                    let price = mpamm_chain::parse_quantity_u128(&rc["effectiveGasPrice"]).unwrap_or(0);
                    bm += (used * price) as f64 / 1e18;
                    bt += 1;
                }
            }
            if at != bt || (am - bm).abs() > 1e-15 * am.abs().max(1.0) {
                differ += 1;
                if differ <= 5 {
                    eprintln!("block {num}: headers {at} txs {am} MON; receipts {bt} txs {bm} MON");
                }
            }
            a_mon += am;
            a_txs += at;
            b_mon += bm;
            b_txs += bt;
        }
        n = end + 1;
    }
    println!("{venue_id} {from}..={to}: pipeline {a_txs} txs {a_mon:.12} MON; receipts {b_txs} txs {b_mon:.12} MON; blocks differing {differ}");
    if differ > 0 {
        return Err("gas differs".into());
    }
    Ok(())
}

async fn capture_prices(secs: u64, rpc_url: &str, out: &std::path::Path) -> Result<(), String> {
    let registry = Registry::get();
    let prices = Prices::new(registry, Fees::default());
    let (_stop, rx) = tokio::sync::watch::channel(false);
    prices.spawn(Rpc::new("node", rpc_url, Duration::from_secs(10)), Default::default(), rx);
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let r = prices.reference();
    let asset_usd: BTreeMap<String, f64> = registry.assets.keys().map(|k| (k.clone(), r.asset_usd(k))).collect();
    let pair_mid: BTreeMap<String, f64> =
        registry.pairs.iter().map(|p| (p.symbol.clone(), r.mid_for_pair(&p.symbol))).collect();
    let priced = pair_mid.values().filter(|m| **m > 0.0).count();
    std::fs::write(out, serde_json::to_string_pretty(&json!({ "assetUsd": asset_usd, "pairMid": pair_mid })).unwrap())
        .map_err(|e| e.to_string())?;
    eprintln!("{priced}/{} pairs priced → {}", pair_mid.len(), out.display());
    Ok(())
}

async fn quote_at(venue_id: &str, block: u64, prices: &std::path::Path, rpc_url: &str) -> Result<(), String> {
    let registry = Registry::get();
    let rpc = Rpc::new("node", rpc_url, Duration::from_secs(30));
    // Each price from its own text: serde_json's float parsing (without
    // float_roundtrip) can land an ulp off the double JSON.parse gives the
    // TypeScript half, and a crypto-sized leg then differs in its last bit.
    type Raw = std::collections::HashMap<String, Box<serde_json::value::RawValue>>;
    let v: std::collections::HashMap<String, Raw> =
        serde_json::from_str(&std::fs::read_to_string(prices).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let map = |k: &str| -> std::collections::HashMap<String, f64> {
        v.get(k)
            .map(|o| o.iter().map(|(a, b)| (a.clone(), b.get().parse::<f64>().unwrap_or(0.0))).collect())
            .unwrap_or_default()
    };
    let pricer = mpamm_quotes::FramePricer::fixed(registry, map("pairMid"), map("assetUsd"));
    let venue = mpamm_venues::all().into_iter().find(|x| x.id() == venue_id).ok_or(format!("no venue {venue_id}"))?;
    venue.discover(&ChainCx { rpc: &rpc, registry }).await.map_err(|e| e.to_string())?;
    let header = rpc.block_header(block).await.map_err(|e| e.to_string())?.ok_or(format!("no block {block}"))?;
    let cx = mpamm_core::QuoteCx {
        rpc: &rpc,
        registry,
        pricer: &pricer,
        block: mpamm_core::BlockRef { number: block, id: [0; 32], hash: header.hash },
    };
    let mut rows = venue.quote(&cx, &registry.sizes_usd).await.map_err(|e| e.to_string())?;
    rows.sort_by(|a, b| {
        (a.venue_id.as_str(), a.market.as_str(), a.size_usd.to_bits()).cmp(&(
            b.venue_id.as_str(),
            b.market.as_str(),
            b.size_usd.to_bits(),
        ))
    });
    println!("{}", serde_json::to_string(&rows).unwrap());
    eprintln!("{venue_id}: {} row(s) at block {block}", rows.len());
    Ok(())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("warn").with_writer(std::io::stderr).init();
    let r = match Cli::parse().cmd {
        Cmd::DecodeRange { venue, from, to, rpc, chunk, live_prices_secs, skip_gas_only } => {
            decode_range(&venue, from, to, &rpc, chunk, live_prices_secs, skip_gas_only).await
        }
        Cmd::GasCheck { venue, from, to, rpc } => gas_check(&venue, from, to, &rpc).await,
        Cmd::Migrate { from, to } => migrate::migrate(&from, &to),
        Cmd::CapturePrices { secs, rpc, out } => capture_prices(secs, &rpc, &out).await,
        Cmd::QuoteAt { venue, block, prices, rpc } => quote_at(&venue, block, &prices, &rpc).await,
        Cmd::VerifyVenue { venue, rpc, span, warm_secs } => match verify::verify(&venue, &rpc, span, warm_secs).await {
            Ok(r) => {
                verify::print(&r);
                if r.failures() > 0 {
                    Err(format!("{} check(s) failed", r.failures()))
                } else {
                    Ok(())
                }
            }
            Err(e) => Err(e),
        },
        Cmd::DepthAt { market, block, prices, venues, rpc, deadline_ms, follow_secs } => {
            depth::depth_at(depth::Args {
                market: &market,
                block,
                prices: &prices,
                venues: &venues,
                rpc: &rpc,
                deadline_ms,
                follow_secs,
            })
            .await
        }
        Cmd::Parity { db, prod, prod_file, hours, from_block, margin, usd_tolerance, drift_max, venues } => {
            parity_cmd(&db, &prod, prod_file.as_deref(), hours, from_block, margin, usd_tolerance, drift_max, venues)
                .await
        }
        Cmd::ArchiveMarks { fills, cache } => archive_marks(&fills, &cache).await,
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
