//! `verify-venue`: the live checklist a venue module's PR carries (today's
//! `verify-adapter`, docs/rebuild-venues.md → Verifying). Against the real
//! chain, read-only: the registry entry, discovery, quotes at the newest
//! block, the watch set, a recent window decoded as the service decodes it,
//! and the gas rules. Prints PASS / WARN / FAIL, a paste-ready fixture (a
//! raw log and its trade) and the trade to hand-verify on the explorer.

use std::{sync::Arc, time::Duration};

use mpamm_chain::Rpc;
use mpamm_core::{ChainCx, DecodeCx, NoPrices, Venue, VenueState};
use mpamm_pricing::{Fees, Prices};
use mpamm_registry::Registry;
use mpamm_ring::hex;
use mpamm_types::{Fill, VenueMeta, VenueRole};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Pass,
    Warn,
    Fail,
}

#[derive(Default)]
pub struct Report(pub Vec<(Level, String)>);

impl Report {
    fn pass(&mut self, m: impl Into<String>) {
        self.0.push((Level::Pass, m.into()));
    }
    fn warn(&mut self, m: impl Into<String>) {
        self.0.push((Level::Warn, m.into()));
    }
    fn fail(&mut self, m: impl Into<String>) {
        self.0.push((Level::Fail, m.into()));
    }
    pub fn failures(&self) -> usize {
        self.0.iter().filter(|(l, _)| *l == Level::Fail).count()
    }
}

fn hex_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// The registry entry's own rules.
pub fn check_meta(r: &mut Report, meta: &VenueMeta, history_from: Option<&str>) {
    let kebab = !meta.id.is_empty()
        && meta.id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && meta.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if kebab {
        r.pass("venue id is kebab-case");
    } else {
        r.fail(format!("invalid venue id '{}'", meta.id));
    }
    if hex_color(&meta.color.light) && hex_color(&meta.color.dark) {
        r.pass("both theme colours set");
    } else {
        r.fail("color.light / color.dark must be #rrggbb");
    }
    if meta.role == VenueRole::Venue {
        match &meta.since_utc {
            Some(d) => r.pass(format!("since_utc = {d}")),
            None => r.fail("display venues need since_utc (per-day views, the gas anchor)"),
        }
        match history_from {
            Some(d) => r.pass(format!("history_from_utc = {d}")),
            None => r.warn("no history_from_utc: lifetime volume won't be backfilled"),
        }
    }
}

/// Above zero (NaN is not).
fn positive(x: f64) -> bool {
    x > 0.0
}

/// Every trade's own rules.
pub fn check_fills(r: &mut Report, registry: &Registry, fills: &[Fill]) {
    let mut bad = 0;
    for f in fills {
        if registry.pair_of(&f.market).is_none() {
            r.fail(format!("trade for UNREGISTERED market {}", f.market));
            bad += 1;
        }
        if !positive(f.usd) || !positive(f.base_amount) {
            r.fail(format!("trade {}: non-positive usd/baseAmount", f.id));
            bad += 1;
        }
        if !f.px_approx && !positive(f.exec_px) {
            r.fail(format!("trade {}: non-positive execPx without pxApprox", f.id));
            bad += 1;
        }
        if !f.id.to_lowercase().contains(&f.tx_hash.to_lowercase()) {
            r.warn(format!("trade id '{}' doesn't embed the tx hash: is it deterministic?", f.id));
        }
    }
    if !fills.is_empty() && bad == 0 {
        r.pass("decode() produces well-formed trades");
    }
}

pub async fn verify(venue_id: &str, rpc_url: &str, span: u64, warm_secs: u64) -> Result<Report, String> {
    let registry = Registry::get();
    let rpc = Rpc::new("node", rpc_url, Duration::from_secs(60));
    let mut r = Report::default();
    let venue: Arc<dyn Venue> = mpamm_venues::all()
        .into_iter()
        .find(|v| v.id() == venue_id || v.meta().iter().any(|m| m.id == venue_id))
        .ok_or_else(|| format!("no venue module declares '{venue_id}'"))?;
    let meta = venue.meta().into_iter().find(|m| m.id == venue_id).unwrap_or_else(|| venue.meta().remove(0));
    println!("\n■ verifying '{}' ({}, role {:?})\n", meta.name, meta.id, meta.role);
    let head = rpc.block_number().await.map_err(|e| format!("chain probe: {e}"))?;
    r.pass(format!("chain reachable (block {head})"));
    check_meta(&mut r, &meta, venue.history_from_utc());

    // The references (quotes anchor on the pair's mid).
    let prices = Prices::new(registry, Fees::default());
    let (_stop_tx, stop) = tokio::sync::watch::channel(false);
    prices.spawn(rpc.clone(), Default::default(), stop);
    println!("… warming the exchange feeds ({warm_secs} s)");
    tokio::time::sleep(Duration::from_secs(warm_secs)).await;
    let cold: Vec<&str> = {
        let reference = prices.reference();
        registry.pairs.iter().filter(|p| reference.mid_for_pair(&p.symbol) <= 0.0).map(|p| p.symbol.as_str()).collect()
    };
    if cold.is_empty() {
        r.pass("reference mids warm for every pair");
    } else {
        r.warn(format!("no reference yet for {}: those pairs won't be quoted", cold.join(", ")));
    }

    match venue.discover(&ChainCx { rpc: &rpc, registry }).await {
        Ok(()) => r.pass("discover() completed"),
        Err(e) => r.fail(format!("discover() failed: {e}")),
    }
    // A venue may load sources in decode (WOOFi's Wooracles): one empty
    // block first, as the service's first decode would.
    let state = VenueState::default();
    let empty = mpamm_core::FinalBlock {
        number: head,
        hash: [0; 32],
        parent_hash: [0; 32],
        timestamp: 0,
        proposal_ns: None,
        base_fee: 0,
        txns: vec![],
        logs: vec![],
        origin: mpamm_core::Origin::Rpc("warm-up".into()),
    };
    let _ = venue.decode(&DecodeCx { registry, pricer: &NoPrices, state: &state }, &empty);
    state.take_pending();

    // Quotes at the newest block, pinned to its hash.
    let header = rpc.block_header(head).await.map_err(|e| e.to_string())?.ok_or("no newest block")?;
    let frame = mpamm_quotes::FramePricer::capture(&prices, registry);
    let cx = mpamm_core::QuoteCx {
        rpc: &rpc,
        registry,
        pricer: &frame,
        block: mpamm_core::BlockRef { number: head, id: [0; 32], hash: header.hash },
    };
    match venue.quote(&cx, &registry.sizes_usd).await {
        Ok(rows) => {
            let rows: Vec<_> = rows.into_iter().filter(|q| q.venue_id == meta.id).collect();
            let mut markets: Vec<&str> = rows.iter().map(|q| q.market.as_str()).collect();
            markets.dedup();
            println!("  quotes: {} row(s) across {} market(s): {}", rows.len(), markets.len(), markets.join(", "));
            if rows.is_empty() {
                r.warn("quote() returned no rows (nothing live, cold references, or a venue that doesn't quote)");
            }
            for q in &rows {
                if registry.pair_of(&q.market).is_none() {
                    r.fail(format!("quote row for UNREGISTERED market {}", q.market));
                }
                let worst = q.bid_bps.abs().max(q.ask_bps.abs());
                if worst > 500.0 {
                    r.warn(format!(
                        "{} ${}: |bps| {worst:.0} vs mid: a scaling bug or a wide venue?",
                        q.market, q.size_usd
                    ));
                }
            }
            if let Some(q) = rows.first() {
                println!(
                    "  sample: {} ${} bid {:.1} bps ask {:.1} bps (fee {} bps{})",
                    q.market,
                    q.size_usd,
                    q.bid_bps,
                    q.ask_bps,
                    q.fee_bps,
                    if q.one_sided == Some(true) { ", one-sided" } else { "" }
                );
                r.pass("quote() emits registered-pair rows");
            }
        }
        Err(e) => r.fail(format!("quote() failed: {e}")),
    }

    // The watch set and a recent window, decoded as the service decodes it.
    match venue.watch() {
        Err(e) => r.fail(format!("watch() after discovery: {e}")),
        Ok(w) if meta.role == VenueRole::Baseline => {
            if w.logs.is_empty() {
                r.pass("baseline is quote-only (watches no logs)");
            } else {
                r.fail("baseline venues must not watch logs");
            }
        }
        Ok(w) if w.logs.is_empty() => r.warn("watch() holds no logs: no trades will ever be decoded"),
        Ok(w) => {
            println!("  watching {} log address(es)", w.logs.len());
            let from = head.saturating_sub(5 + span);
            match super::decode_blocks(&venue, &rpc, &prices, from, head - 5, 100, true).await {
                Err(e) => r.fail(format!("decoding {from}..={}: {e}", head - 5)),
                Ok((fills, blocks)) => {
                    let fills: Vec<Fill> = fills.into_iter().filter(|f| f.venue_id == meta.id).collect();
                    println!(
                        "  last {span} blocks: {} block(s) with watched logs → {} trade(s)",
                        blocks.len(),
                        fills.len()
                    );
                    if blocks.is_empty() {
                        r.warn(format!(
                            "no watched logs in the last {span} blocks: a quiet venue, or wrong addresses?"
                        ));
                    }
                    check_fills(&mut r, registry, &fills);
                    if let Some(f) = fills.first() {
                        println!("  sample trade: {} {:?} ${:.2} @ {} ({})", f.market, f.side, f.usd, f.exec_px, f.id);
                        let raw = blocks.get(&f.block_number).and_then(|(_, logs)| {
                            logs.iter().find(|l| format!("0x{}", hex(&l.tx_hash)) == f.tx_hash.to_lowercase())
                        });
                        if let Some(l) = raw {
                            println!("\n  ── paste-ready fixture ──");
                            println!(
                                "  raw log: address 0x{} topics [{}] data 0x{} (block {}, log {})",
                                hex(&l.address),
                                l.topics.iter().map(|t| format!("0x{}", hex(t))).collect::<Vec<_>>().join(", "),
                                hex(&l.data),
                                f.block_number,
                                l.log_index
                            );
                            println!("  decoded: {}", serde_json::to_string(f).unwrap_or_default());
                        }
                        println!(
                            "\n  → hand-verify this trade on the explorer: https://monadscan.com/tx/{}",
                            f.tx_hash
                        );
                    }
                }
            }
        }
    }

    match venue.gas_sources() {
        Ok(Some(g)) => r.pass(format!(
            "gas_sources(): {} destination(s), {} relay(s), {} log rule(s)",
            g.destinations.len(),
            g.relays.len(),
            g.logs.len()
        )),
        Ok(None) if meta.role == VenueRole::Venue => {
            r.warn("no gas sources: say in the PR who pays for quote updates and why it isn't the venue")
        }
        Ok(None) => {}
        Err(e) => r.warn(format!("gas_sources(): {e} (the block would hold until it resolves)")),
    }
    std::mem::forget(_stop_tx);
    Ok(r)
}

pub fn print(r: &Report) {
    println!("\n■ report");
    for (l, m) in &r.0 {
        let (mark, word) = match l {
            Level::Pass => ("✓", "PASS"),
            Level::Warn => ("⚠", "WARN"),
            Level::Fail => ("✗", "FAIL"),
        };
        println!("  {mark} {word}  {m}");
    }
    let warns = r.0.iter().filter(|(l, _)| *l == Level::Warn).count();
    let fails = r.failures();
    if fails > 0 {
        println!("\n✗ {fails} failure(s) · {warns} warning(s)\n");
    } else {
        println!("\n✓ all checks passed · {warns} warning(s)\n");
    }
}

#[cfg(test)]
mod tests {
    use mpamm_types::{FillCategory, Side, ThemeColor, VenueKind};

    use super::*;

    fn meta(id: &str, role: VenueRole, since: Option<&str>) -> VenueMeta {
        VenueMeta {
            id: id.into(),
            name: id.into(),
            color: ThemeColor { light: "#0F9D8C".into(), dark: "#0D9488".into() },
            kind: VenueKind::Amm,
            role,
            taker: None,
            taker_bps: None,
            since_utc: since.map(str::to_string),
            quote_note: None,
        }
    }

    fn levels(r: &Report) -> Vec<Level> {
        r.0.iter().map(|(l, _)| *l).collect()
    }

    #[test]
    fn the_registry_entry_rules() {
        let mut r = Report::default();
        check_meta(&mut r, &meta("clober-vault", VenueRole::Venue, Some("2025-10-28")), Some("2025-10-28"));
        assert_eq!(r.failures(), 0);
        let mut r = Report::default();
        let mut m = meta("Bad_Id", VenueRole::Venue, None);
        m.color.dark = "teal".into();
        check_meta(&mut r, &m, None);
        assert_eq!(levels(&r), [Level::Fail, Level::Fail, Level::Fail, Level::Warn]);
        let mut r = Report::default();
        check_meta(&mut r, &meta("uniswap-v4", VenueRole::Baseline, None), None);
        assert_eq!(r.failures(), 0, "a baseline needs no since_utc");
    }

    #[test]
    fn every_trade_rule() {
        let good = Fill {
            id: "poe-0xab-3".into(),
            venue_id: "poe".into(),
            market: "MON/USDC".into(),
            side: Side::Buy,
            category: FillCategory::Direct,
            usd: 10.0,
            base_amount: 900.0,
            exec_px: 0.0111,
            px_approx: false,
            tx_hash: "0xAB".into(),
            to: "x".into(),
            router: None,
            pool: "p".into(),
            block_number: 1,
            ts: 0.0,
            markouts_bps: vec![],
            time_source: None,
        };
        let mut r = Report::default();
        check_fills(&mut r, Registry::get(), std::slice::from_ref(&good));
        assert_eq!(levels(&r), [Level::Pass]);
        let mut bad = good.clone();
        bad.market = "NOPE/USDC".into();
        bad.exec_px = 0.0;
        bad.id = "poe-3".into();
        let mut r = Report::default();
        check_fills(&mut r, Registry::get(), &[bad]);
        assert_eq!(levels(&r), [Level::Fail, Level::Fail, Level::Warn]);
    }
}
