//! `mpamm-tools relabel`: stored UNKNOWN trades in a block range attributed
//! again with this build's tables (after an attribution change, for trades
//! decoded before it). Each trade's transaction is read over RPC (to, from),
//! the venues' entry points come from discovery, and only `category`,
//! `router` and `to` change: volume, prices and markouts are untouched.

use std::{sync::Arc, time::Duration};

use mpamm_chain::{parse_b32, Rpc};
use mpamm_core::{ChainCx, FinalBlock, FinalTxn, Origin, Venue};
use mpamm_pipeline::attribution::{entries, Attributor};
use mpamm_registry::{parse_address, Registry};
use mpamm_types::{Fill, FillCategory};
use rusqlite::{params, Connection};
use serde_json::json;

fn row_fill(r: &rusqlite::Row<'_>) -> rusqlite::Result<Fill> {
    Ok(Fill {
        id: r.get(0)?,
        venue_id: r.get(1)?,
        market: String::new(),
        side: mpamm_types::Side::Buy,
        category: FillCategory::Unknown,
        usd: 0.0,
        base_amount: 0.0,
        exec_px: 0.0,
        px_approx: false,
        tx_hash: r.get(2)?,
        to: r.get(3)?,
        router: None,
        pool: String::new(),
        block_number: r.get::<_, i64>(4)? as u64,
        ts: 0.0,
        markouts_bps: vec![],
        time_source: None,
    })
}

pub async fn relabel(db: &std::path::Path, rpc_url: &str, from: u64, to: u64, dry_run: bool) -> Result<(), String> {
    let registry = Registry::get();
    let rpc = Rpc::new("node", rpc_url, Duration::from_secs(30));
    let venues: Vec<Arc<dyn Venue>> = mpamm_venues::all();
    for v in &venues {
        v.discover(&ChainCx { rpc: &rpc, registry }).await.map_err(|e| format!("discover {}: {e}", v.id()))?;
    }
    let entries = entries(&venues);
    let attributor = Attributor::default();
    let conn = Connection::open(db).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?;
    let unknown: Vec<Fill> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, venue_id, tx_hash, to_label, block_number FROM trades
                 WHERE category = 'UNKNOWN' AND block_number >= ?1 AND block_number <= ?2 ORDER BY block_number, id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![from as i64, to as i64], row_fill).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    eprintln!("{} UNKNOWN trade(s) in blocks {from}..={to}", unknown.len());
    let mut changed: Vec<Fill> = Vec::new();
    for mut f in unknown {
        let tx = rpc
            .call("eth_getTransactionByHash", json!([f.tx_hash]))
            .await
            .map_err(|e| format!("{}: {e}", f.tx_hash))?;
        if tx.is_null() {
            return Err(format!("no transaction {} on this node", f.tx_hash));
        }
        let txn = FinalTxn {
            index: 0,
            hash: parse_b32(&tx["hash"]).ok_or("tx hash")?,
            from: parse_address(tx["from"].as_str().unwrap_or("")).ok_or("tx from")?,
            to: tx["to"].as_str().and_then(parse_address),
            kind: 0,
            gas_limit: 0,
            max_fee_per_gas: 0,
            max_priority_fee_per_gas: 0,
            input: vec![],
        };
        let block = FinalBlock {
            number: f.block_number,
            hash: [0; 32],
            parent_hash: [0; 32],
            timestamp: 0,
            proposal_ns: None,
            base_fee: 0,
            txns: vec![txn],
            logs: vec![],
            origin: Origin::Rpc("relabel".into()),
        };
        let before = (f.category, f.router.clone(), f.to.clone());
        attributor.attribute(std::slice::from_mut(&mut f), &block, &entries);
        if f.category != before.0 || f.router != before.1 {
            println!(
                "{} block {} {} → {} {}",
                f.id,
                f.block_number,
                before.0.as_str(),
                f.category.as_str(),
                f.router.clone().unwrap_or_default()
            );
            changed.push(f);
        }
    }
    if dry_run {
        eprintln!("{} trade(s) would change (dry run)", changed.len());
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for f in &changed {
        tx.execute(
            "UPDATE trades SET category = ?1, router = ?2, to_label = ?3 WHERE id = ?4 AND category = 'UNKNOWN'",
            params![f.category.as_str(), f.router, f.to, f.id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    eprintln!("{} trade(s) relabelled", changed.len());
    Ok(())
}
