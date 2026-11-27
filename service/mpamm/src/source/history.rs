//! The Execution tab's two windows (today's `execution-history.ts`): the
//! last minute of quote frames, replayed to a page that opens the tab, and
//! five minutes of executable spreads, summarized per venue for the rolling
//! statistics. Only numeric spreads live the five minutes; whole frames age
//! out with the chart.
//!
//! A frame at a height already recorded, or with a higher revision, replaces
//! everything from its height on (a new proposal at that height, or a
//! rollback to an ancestor): the chart never shows two answers for a block.

use std::collections::{HashMap, VecDeque};

use mpamm_registry::Registry;
use mpamm_types::{QuoteSnapshot, QuoteStatsResponse, QuoteStatsRow};

pub const QUOTE_CHART_WINDOW_MS: f64 = 60_000.0;
pub const QUOTE_STATS_WINDOW_MS: f64 = 300_000.0;
const SPREAD_RETENTION_MS: f64 = 360_000.0;
const STATS_CACHE_MS: f64 = 1_000.0;

struct SpreadFrame {
    block: u64,
    ts: f64,
    /// (venue, market, size) index → spread bps.
    values: Vec<(u32, f64)>,
}

pub struct ExecutionHistory {
    registry: &'static Registry,
    quotes: VecDeque<QuoteSnapshot>,
    spreads: VecDeque<SpreadFrame>,
    /// (market, size bits) → venue → column.
    columns: HashMap<(String, u64), Vec<(String, u32)>>,
    column_count: u32,
    cache: HashMap<(String, u64), QuoteStatsResponse>,
    revision: u64,
}

fn frame_ts(q: &QuoteSnapshot) -> f64 {
    q.frame.as_ref().map_or(q.ts, |f| f.emitted_at)
}

impl ExecutionHistory {
    pub fn new(registry: &'static Registry) -> Self {
        Self {
            registry,
            quotes: VecDeque::new(),
            spreads: VecDeque::new(),
            columns: HashMap::new(),
            column_count: 0,
            cache: HashMap::new(),
            revision: 0,
        }
    }

    #[cfg(test)]
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn record(&mut self, quote: &QuoteSnapshot, now: f64) {
        let ts = frame_ts(quote);
        let revision = quote.revision.unwrap_or(0);
        if !ts.is_finite() || revision < self.revision {
            return;
        }
        if let Some(last) = self.spreads.back() {
            if quote.block < last.block && revision == self.revision {
                return;
            }
            if quote.block == last.block || revision > self.revision {
                self.invalidate(quote.block, revision);
            }
        }
        self.revision = revision;
        let mut values = Vec::new();
        for row in &quote.rows {
            let ok = self.registry.pair_of(&row.market).is_some()
                && self.registry.sizes_usd.contains(&row.size_usd)
                && row.filled_full
                && row.one_sided != Some(true)
                && row.bid_px > 0.0
                && row.ask_px > 0.0
                && row.bid_px.is_finite()
                && row.ask_px.is_finite()
                && row.spread_bps.is_finite();
            if !ok {
                continue;
            }
            let cols = self.columns.entry((row.market.clone(), row.size_usd.to_bits())).or_default();
            let col = match cols.iter().find(|(v, _)| *v == row.venue_id) {
                Some((_, c)) => *c,
                None => {
                    let c = self.column_count;
                    self.column_count += 1;
                    cols.push((row.venue_id.clone(), c));
                    c
                }
            };
            values.push((col, row.spread_bps));
        }
        self.quotes.push_back(quote.clone());
        self.spreads.push_back(SpreadFrame { block: quote.block, ts, values });
        self.prune(now);
    }

    /// The last minute's frames, each holding only this selection's rows.
    pub fn history(&mut self, market: &str, size: f64, now: f64) -> Vec<QuoteSnapshot> {
        self.prune(now);
        self.quotes
            .iter()
            .filter(|q| frame_ts(q) <= now)
            .map(|q| QuoteSnapshot {
                rows: q.rows.iter().filter(|r| r.market == market && r.size_usd == size).cloned().collect(),
                ..q.clone()
            })
            .collect()
    }

    /// Each venue's spread distribution over the last five minutes: the
    /// shared interpolated percentiles, population standard deviation.
    pub fn stats(&mut self, market: &str, size: f64, now: f64) -> QuoteStatsResponse {
        self.prune(now);
        let key = (market.to_string(), size.to_bits());
        if let Some(c) = self.cache.get(&key) {
            if c.as_of <= now && (now / STATS_CACHE_MS).floor() == (c.as_of / STATS_CACHE_MS).floor() {
                return c.clone();
            }
        }
        let columns = self.columns.get(&key);
        let mut rows = Vec::new();
        for (venue, col) in columns.into_iter().flatten() {
            let mut values: Vec<f64> = self
                .spreads
                .iter()
                .filter(|f| f.ts > now - QUOTE_STATS_WINDOW_MS && f.ts <= now)
                .flat_map(|f| f.values.iter().filter(|(c, _)| c == col).map(|(_, v)| *v))
                .collect();
            let n = values.len();
            if n == 0 {
                continue;
            }
            values.sort_by(f64::total_cmp);
            let pct = |p: f64| {
                let i = (n - 1) as f64 * p;
                let (lo, hi) = (i.floor() as usize, i.ceil() as usize);
                values[lo] + (values[hi] - values[lo]) * (i - lo as f64)
            };
            let avg = values.iter().sum::<f64>() / n as f64;
            let sd = (values.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / n as f64).sqrt();
            rows.push(QuoteStatsRow {
                venue_id: venue.clone(),
                p5: pct(0.05),
                p25: pct(0.25),
                p50: pct(0.5),
                p75: pct(0.75),
                p95: pct(0.95),
                avg,
                sd,
                n: n as u64,
            });
        }
        let out = QuoteStatsResponse {
            market: market.to_string(),
            size_usd: size,
            as_of: now,
            window_ms: QUOTE_STATS_WINDOW_MS,
            revision: self.revision,
            rows,
        };
        // A selection never collected can't grow the cache through REST.
        if columns.is_some() {
            self.cache.insert(key, out.clone());
        }
        out
    }

    /// Drops every frame from `from_block` on.
    pub fn invalidate(&mut self, from_block: u64, revision: u64) {
        self.quotes.retain(|q| q.block < from_block);
        self.spreads.retain(|f| f.block < from_block);
        self.revision = revision;
        self.cache.clear();
    }

    pub fn prune(&mut self, now: f64) {
        while self.quotes.front().is_some_and(|q| frame_ts(q) <= now - QUOTE_CHART_WINDOW_MS) {
            self.quotes.pop_front();
        }
        while self.spreads.front().is_some_and(|f| f.ts <= now - SPREAD_RETENTION_MS) {
            self.spreads.pop_front();
        }
        self.cache.retain(|_, c| now - c.as_of < STATS_CACHE_MS);
        if self.spreads.is_empty() {
            self.columns.clear();
            self.column_count = 0;
            self.cache.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use mpamm_types::QuoteRow;

    use super::*;

    fn row(venue: &str, market: &str, size: f64, spread: f64) -> QuoteRow {
        QuoteRow {
            venue_id: venue.into(),
            market: market.into(),
            size_usd: size,
            bid_bps: -spread / 2.0,
            ask_bps: spread / 2.0,
            bid_px: 1.0,
            ask_px: 1.0001,
            spread_bps: spread,
            filled_full: true,
            one_sided: None,
            fee_bps: 0.0,
            cex_ask_bps: None,
            cex_bid_bps: None,
            ts: 0.0,
        }
    }

    fn frame(block: u64, ts: f64, revision: u64, rows: Vec<QuoteRow>) -> QuoteSnapshot {
        QuoteSnapshot { block_hash: None, revision: Some(revision), block, mon_usd: 0.02, ts, rows, frame: None }
    }

    #[test]
    fn the_chart_keeps_a_minute_and_filters_the_selection() {
        let mut h = ExecutionHistory::new(Registry::get());
        let t0 = 1_000_000.0;
        for i in 0..200u64 {
            let rows = vec![row("poe", "MON/USDC", 1000.0, 5.0), row("poe", "MON/USDC", 100.0, 4.0)];
            h.record(&frame(100 + i, t0 + i as f64 * 400.0, 0, rows), t0 + i as f64 * 400.0);
        }
        let now = t0 + 199.0 * 400.0;
        let got = h.history("MON/USDC", 1000.0, now);
        assert_eq!(got.len(), 150, "60 s of 400 ms frames");
        assert!(got.iter().all(|q| q.rows.len() == 1 && q.rows[0].size_usd == 1000.0));
        assert!(h.history("MON/USDC", 1000.0, now - 1_000.0).iter().all(|q| q.ts <= now - 1_000.0), "no future frames");
    }

    #[test]
    fn stats_use_interpolated_percentiles_and_skip_unusable_rows() {
        let mut h = ExecutionHistory::new(Registry::get());
        let t0 = 5_000_000.0;
        for (i, s) in [1.0, 2.0, 3.0, 4.0, 5.0].into_iter().enumerate() {
            let mut one_sided = row("hanji", "MON/USDC", 1000.0, 99.0);
            one_sided.one_sided = Some(true);
            let mut partial = row("hanji", "MON/USDC", 1000.0, 99.0);
            partial.filled_full = false;
            let rows =
                vec![row("poe", "MON/USDC", 1000.0, s), one_sided, partial, row("poe", "NOT/A_PAIR", 1000.0, 1.0)];
            h.record(&frame(10 + i as u64, t0 + i as f64 * 1000.0, 0, rows), t0 + i as f64 * 1000.0);
        }
        let now = t0 + 4_000.0;
        let st = h.stats("MON/USDC", 1000.0, now);
        assert_eq!(st.rows.len(), 1, "one-sided and partial rows are not spreads");
        let r = &st.rows[0];
        assert_eq!((r.venue_id.as_str(), r.n), ("poe", 5));
        for (got, want) in [(r.p5, 1.2), (r.p25, 2.0), (r.p50, 3.0), (r.p75, 4.0), (r.p95, 4.8)] {
            assert!((got - want).abs() < 1e-12, "{got} vs {want}");
        }
        assert_eq!(r.avg, 3.0);
        assert!((r.sd - 2f64.sqrt()).abs() < 1e-12, "population sd");
        assert_eq!(st.window_ms, QUOTE_STATS_WINDOW_MS);
        assert!(h.stats("BTC/USDC", 1000.0, now).rows.is_empty());
        assert!(!h.cache.contains_key(&("BTC/USDC".to_string(), 1000f64.to_bits())), "never cached");
    }

    #[test]
    fn a_replacement_or_rollback_drops_the_frames_from_its_height() {
        let mut h = ExecutionHistory::new(Registry::get());
        let t0 = 9_000_000.0;
        for i in 0..5u64 {
            h.record(&frame(100 + i, t0 + i as f64 * 400.0, 0, vec![row("poe", "MON/USDC", 1000.0, 1.0)]), t0 + 2000.0);
        }
        // A second proposal at 104: same revision, same height.
        h.record(&frame(104, t0 + 2_000.0, 0, vec![row("poe", "MON/USDC", 1000.0, 9.0)]), t0 + 2000.0);
        let blocks: Vec<u64> = h.history("MON/USDC", 1000.0, t0 + 2000.0).iter().map(|q| q.block).collect();
        assert_eq!(blocks, [100, 101, 102, 103, 104]);
        // A rollback to 102 under a new revision.
        h.record(&frame(102, t0 + 2_100.0, 1, vec![row("poe", "MON/USDC", 1000.0, 7.0)]), t0 + 2100.0);
        let blocks: Vec<u64> = h.history("MON/USDC", 1000.0, t0 + 2100.0).iter().map(|q| q.block).collect();
        assert_eq!(blocks, [100, 101, 102]);
        assert_eq!(h.revision(), 1);
        // A stale frame of the old revision, or a lower height, is ignored.
        h.record(&frame(105, t0 + 2_200.0, 0, vec![]), t0 + 2200.0);
        h.record(&frame(90, t0 + 2_200.0, 1, vec![]), t0 + 2200.0);
        assert_eq!(h.history("MON/USDC", 1000.0, t0 + 2200.0).len(), 3);
        assert_eq!(h.stats("MON/USDC", 1000.0, t0 + 2200.0).rows[0].p50, 1.0);
    }

    #[test]
    fn spreads_outlive_the_chart_then_everything_resets() {
        let mut h = ExecutionHistory::new(Registry::get());
        h.record(&frame(1, 0.0, 0, vec![row("poe", "MON/USDC", 1000.0, 2.0)]), 0.0);
        assert!(h.history("MON/USDC", 1000.0, 70_000.0).is_empty(), "past the chart window");
        assert_eq!(h.stats("MON/USDC", 1000.0, 70_000.0).rows.len(), 1, "still in the stats window");
        assert!(h.stats("MON/USDC", 1000.0, 400_000.0).rows.is_empty());
        assert!(h.columns.is_empty() && h.column_count == 0);
    }
}
