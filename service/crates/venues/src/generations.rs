//! One venue, several contract generations (server/src/venues/generations.ts
//! → `composeGenerations`). A protocol that redeploys (new factory, new ABI)
//! is still the same venue: its history is keyed by venue id, and a new id
//! would be a different venue whose old rows a reconcile prunes. So the
//! redeploy is a new `Generation` behind the SAME `VenueMeta`, and
//! `Generations` is what the registry sees.
//!
//! Dispatch is by the contract that emitted a log, never by time: every
//! generation is handed the whole final block and decodes only the logs of
//! its own contracts (they never share an address). A retired generation
//! stays decode-capable for lifetime replays: its addresses stay in the watch
//! set (the ring has no block bounds, and a retired contract emits nothing),
//! and its `span` keeps it from decoding outside the blocks today's sources
//! promise (`LogSource.fromBlock/untilBlock`: logs outside them are never
//! fetched, so never counted).

use std::sync::Arc;

use async_trait::async_trait;
use mpamm_core::{ChainCx, DecodeCx, EntryPoint, FinalBlock, GasSources, HistoryRevision, Venue, VenueError};
use mpamm_ring::WatchSet;
use mpamm_types::{Fill, VenueMeta};

/// The inclusive block span a generation's sources can emit logs in: a
/// contract's creation block, a retired contract's last activity. `None` =
/// unbounded on that side. A generation whose sources have different spans
/// declares their union here and narrows the rest in its own decode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Span {
    pub from: Option<u64>,
    pub until: Option<u64>,
}

impl Span {
    pub const ALL: Span = Span { from: None, until: None };

    pub fn contains(&self, block: u64) -> bool {
        self.from.is_none_or(|f| block >= f) && self.until.is_none_or(|u| block <= u)
    }
}

/// One contract generation: everything a `Venue` is except what belongs to
/// the venue as a whole (id, metadata, history).
#[async_trait]
pub trait Generation: Send + Sync {
    /// Blocks this generation's sources can emit in (see `Span`).
    fn span(&self) -> Span {
        Span::ALL
    }

    /// A retired generation has nothing to discover.
    async fn discover(&self, _cx: &ChainCx<'_>) -> Result<(), VenueError> {
        Ok(())
    }

    fn watch(&self) -> Result<WatchSet, VenueError>;

    /// The trades of this generation's own contracts in one final block.
    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError>;

    fn markets(&self) -> Vec<String> {
        Vec::new()
    }

    fn entry_points(&self) -> Vec<EntryPoint> {
        Vec::new()
    }

    /// `None` = this generation burns no quote-update gas.
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(None)
    }
}

/// The venue-level half of a composed venue (today's `composeGenerations`
/// options).
#[derive(Debug, Clone, Default)]
pub struct VenueHistory {
    pub from_utc: Option<&'static str>,
    pub revisions: Vec<HistoryRevision>,
}

/// One venue over its generations, in declaration order (oldest first).
pub struct Generations {
    meta: VenueMeta,
    history: VenueHistory,
    gens: Vec<(&'static str, Arc<dyn Generation>)>,
}

impl Generations {
    pub fn new(meta: VenueMeta, history: VenueHistory, gens: Vec<(&'static str, Arc<dyn Generation>)>) -> Self {
        Self { meta, history, gens }
    }

    pub fn generation_names(&self) -> Vec<&'static str> {
        self.gens.iter().map(|(n, _)| *n).collect()
    }
}

#[async_trait]
impl Venue for Generations {
    fn id(&self) -> &str {
        &self.meta.id
    }

    fn meta(&self) -> Vec<VenueMeta> {
        vec![self.meta.clone()]
    }

    /// Every generation runs even when one fails, so a retired generation's
    /// problem can never stall the live one's discovery; then the first
    /// error (in declaration order) is surfaced, as of any discover().
    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError> {
        let mut first = None;
        for (_, g) in &self.gens {
            if let Err(e) = g.discover(cx).await {
                first.get_or_insert(e);
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// An error from ANY generation holds: a partial watch set would let the
    /// cursor pass the other generation's uncopied logs.
    fn watch(&self) -> Result<WatchSet, VenueError> {
        let mut w = WatchSet::default();
        for (_, g) in &self.gens {
            w.merge(&g.watch()?);
        }
        Ok(w)
    }

    /// Each generation in order, outside its span skipped (its sources are
    /// never read there today); an error from any of them holds the block.
    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
        let mut out = Vec::new();
        for (_, g) in &self.gens {
            if g.span().contains(block.number) {
                out.extend(g.decode(cx, block)?);
            }
        }
        Ok(out)
    }

    /// Every generation's markets, first seen first, once each.
    fn markets(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (_, g) in &self.gens {
            for m in g.markets() {
                if !out.contains(&m) {
                    out.push(m);
                }
            }
        }
        out
    }

    fn entry_points(&self) -> Vec<EntryPoint> {
        self.gens.iter().flat_map(|(_, g)| g.entry_points()).collect()
    }

    /// `None` only when no generation burns gas; never a partial set: an
    /// error from any generation holds the gas cursor.
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        let mut out: Option<GasSources> = None;
        for (_, g) in &self.gens {
            if let Some(s) = g.gas_sources()? {
                let acc = out.get_or_insert_with(GasSources::default);
                acc.destinations.extend(s.destinations);
                acc.relays.extend(s.relays);
                acc.logs.extend(s.logs);
            }
        }
        Ok(out)
    }

    fn history_revisions(&self) -> Vec<HistoryRevision> {
        self.history.revisions.clone()
    }

    fn history_from_utc(&self) -> Option<&'static str> {
        self.history.from_utc
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use mpamm_core::{NoPrices, Origin, VenueState};
    use mpamm_registry::Registry;
    use mpamm_ring::TopicFilter;
    use mpamm_types::{FillCategory, Side, ThemeColor, VenueKind, VenueRole};

    use super::*;

    fn meta() -> VenueMeta {
        VenueMeta {
            id: "v".into(),
            name: "V".into(),
            color: ThemeColor { light: "#000".into(), dark: "#fff".into() },
            kind: VenueKind::Amm,
            role: VenueRole::Venue,
            taker: None,
            taker_bps: None,
            since_utc: None,
            quote_note: None,
        }
    }

    fn fill(id: &str) -> Fill {
        Fill {
            id: id.into(),
            venue_id: "v".into(),
            market: "MON/USDC".into(),
            side: Side::Buy,
            category: FillCategory::Unknown,
            usd: 1.0,
            base_amount: 1.0,
            exec_px: 1.0,
            px_approx: false,
            tx_hash: String::new(),
            to: String::new(),
            router: None,
            pool: String::new(),
            block_number: 0,
            ts: 0.0,
            markouts_bps: vec![None; 5],
            time_source: None,
        }
    }

    fn block(number: u64) -> FinalBlock {
        FinalBlock {
            number,
            hash: [0; 32],
            parent_hash: [0; 32],
            timestamp: 0,
            proposal_ns: None,
            base_fee: 0,
            txns: Vec::new(),
            logs: Vec::new(),
            origin: Origin::Rpc("test".into()),
        }
    }

    /// A generation that watches one address and emits one fill per decode.
    #[derive(Default)]
    struct Gen {
        addr: u8,
        span: Span,
        discover_fails: bool,
        watch_fails: bool,
        decode_fails: bool,
        gas: Option<Result<Option<GasSources>, VenueError>>,
        markets: Vec<String>,
        discovered: AtomicUsize,
        decoded: AtomicUsize,
    }

    #[async_trait]
    impl Generation for Gen {
        fn span(&self) -> Span {
            self.span
        }
        async fn discover(&self, _cx: &ChainCx<'_>) -> Result<(), VenueError> {
            self.discovered.fetch_add(1, Ordering::Relaxed);
            if self.discover_fails {
                return Err(VenueError::Chain("rpc".into()));
            }
            Ok(())
        }
        fn watch(&self) -> Result<WatchSet, VenueError> {
            if self.watch_fails {
                return Err(VenueError::NotReady("not discovered".into()));
            }
            let mut w = WatchSet::default();
            w.logs.insert([self.addr; 20], TopicFilter::Any);
            Ok(w)
        }
        fn decode(&self, _cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError> {
            self.decoded.fetch_add(1, Ordering::Relaxed);
            if self.decode_fails {
                return Err(VenueError::NotReady("pool announced".into()));
            }
            Ok(vec![fill(&format!("{}-{}", self.addr, block.number))])
        }
        fn markets(&self) -> Vec<String> {
            self.markets.clone()
        }
        fn entry_points(&self) -> Vec<EntryPoint> {
            vec![EntryPoint { address: [self.addr; 20], router: None }]
        }
        fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
            self.gas.clone().unwrap_or(Ok(None))
        }
    }

    fn compose(old: Gen, new: Gen) -> (Generations, Arc<Gen>, Arc<Gen>) {
        let (old, new) = (Arc::new(old), Arc::new(new));
        let v = Generations::new(
            meta(),
            VenueHistory::default(),
            vec![("old", old.clone() as Arc<dyn Generation>), ("new", new.clone() as Arc<dyn Generation>)],
        );
        (v, old, new)
    }

    fn decode(v: &Generations, n: u64) -> Result<Vec<String>, VenueError> {
        let state = VenueState::default();
        let cx = DecodeCx { registry: Registry::get(), pricer: &NoPrices, state: &state };
        Ok(v.decode(&cx, &block(n))?.into_iter().map(|f| f.id).collect())
    }

    #[test]
    fn span_bounds_are_inclusive() {
        let s = Span { from: Some(5), until: Some(10) };
        assert!(!s.contains(4) && s.contains(5) && s.contains(10) && !s.contains(11));
        assert!(Span::ALL.contains(0) && Span::ALL.contains(u64::MAX));
    }

    /// Today: namespaced keys keep each source's span, and the core never
    /// fetches a source outside it. Here: a generation outside its span is
    /// not decoded at all; inside, each decodes in declaration order.
    #[test]
    fn a_generation_decodes_only_inside_its_span() {
        let (v, old, _) = compose(
            Gen { addr: 1, span: Span { from: None, until: Some(10) }, ..Gen::default() },
            Gen { addr: 2, ..Gen::default() },
        );
        assert_eq!(decode(&v, 10).unwrap(), ["1-10", "2-10"]);
        assert_eq!(decode(&v, 11).unwrap(), ["2-11"]);
        assert_eq!(old.decoded.load(Ordering::Relaxed), 1);
        let (v, _, new) = compose(
            Gen { addr: 1, ..Gen::default() },
            Gen { addr: 2, span: Span { from: Some(100), until: None }, ..Gen::default() },
        );
        assert_eq!(decode(&v, 99).unwrap(), ["1-99"]);
        assert_eq!(new.decoded.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_decode_error_from_any_generation_holds_the_block() {
        let (v, _, _) =
            compose(Gen { addr: 1, ..Gen::default() }, Gen { addr: 2, decode_fails: true, ..Gen::default() });
        assert_eq!(decode(&v, 1), Err(VenueError::NotReady("pool announced".into())));
    }

    #[test]
    fn watches_every_generation_and_holds_on_any_error() {
        let (v, _, _) = compose(Gen { addr: 1, ..Gen::default() }, Gen { addr: 2, ..Gen::default() });
        let w = v.watch().unwrap();
        assert!(w.logs.contains_key(&[1; 20]) && w.logs.contains_key(&[2; 20]));
        let (v, _, _) =
            compose(Gen { addr: 1, ..Gen::default() }, Gen { addr: 2, watch_fails: true, ..Gen::default() });
        assert_eq!(v.watch(), Err(VenueError::NotReady("not discovered".into())));
    }

    #[tokio::test]
    async fn runs_every_discover_even_when_one_fails_then_surfaces_the_failure() {
        let (v, _, ok) =
            compose(Gen { addr: 1, discover_fails: true, ..Gen::default() }, Gen { addr: 2, ..Gen::default() });
        let rpc = mpamm_chain::Rpc::new("test", "", std::time::Duration::from_millis(10));
        let cx = ChainCx { rpc: &rpc, registry: Registry::get() };
        assert_eq!(v.discover(&cx).await, Err(VenueError::Chain("rpc".into())));
        assert_eq!(ok.discovered.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn gas_sources_only_when_some_generation_burns_and_never_partial() {
        let (v, _, _) = compose(Gen { addr: 1, ..Gen::default() }, Gen { addr: 2, ..Gen::default() });
        assert_eq!(v.gas_sources(), Ok(None));
        let burns = |a: u8| Some(Ok(Some(GasSources { destinations: vec![[a; 20]], ..GasSources::default() })));
        let (v, _, _) = compose(
            Gen { addr: 1, gas: burns(1), ..Gen::default() },
            Gen { addr: 2, gas: Some(Err(VenueError::NotReady("oracle unresolved".into()))), ..Gen::default() },
        );
        assert_eq!(v.gas_sources(), Err(VenueError::NotReady("oracle unresolved".into())));
        let (v, _, _) =
            compose(Gen { addr: 1, gas: burns(1), ..Gen::default() }, Gen { addr: 2, gas: burns(2), ..Gen::default() });
        assert_eq!(v.gas_sources().unwrap().unwrap().destinations, vec![[1; 20], [2; 20]]);
    }

    #[test]
    fn concatenates_markets_and_entry_points_and_keeps_the_venue_level_half() {
        let (old, new) = (
            Arc::new(Gen { addr: 1, ..Gen::default() }),
            Arc::new(Gen { addr: 2, markets: vec!["MON/USDC".into(), "MON/USDC".into()], ..Gen::default() }),
        );
        let v = Generations::new(
            meta(),
            VenueHistory {
                from_utc: Some("2026-01-01"),
                revisions: vec![HistoryRevision { id: "x", from: Some("2026-02-01"), markets: &[] }],
            },
            vec![("old", old as Arc<dyn Generation>), ("new", new as Arc<dyn Generation>)],
        );
        assert_eq!(v.markets(), ["MON/USDC"]);
        assert_eq!(v.entry_points().iter().map(|e| e.address[0]).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(v.history_from_utc(), Some("2026-01-01"));
        assert_eq!(v.history_revisions()[0].id, "x");
        assert_eq!(v.meta(), vec![meta()]);
        assert_eq!(v.id(), "v");
        assert_eq!(v.generation_names(), ["old", "new"]);
    }
}
