//! The venue trait (docs/rebuild-spec.md → The venue trait). Everything a
//! protocol needs lives in its module: discovery, what to watch, decoding
//! final blocks, gas destinations, entry points and dated history repairs.
//! The core names no venue. Quoting joins with the quote engine (M9).

use std::collections::HashMap;

use async_trait::async_trait;
use mpamm_chain::Rpc;
use mpamm_registry::Registry;
use mpamm_ring::{Addr, WatchSet, B32};
use mpamm_types::{Fill, VenueMeta};
use parking_lot::Mutex;

use crate::FinalBlock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VenueError {
    /// The venue can't say yet what it watches (discovery hasn't resolved
    /// it): the cursor holds rather than tail an incomplete source set.
    NotReady(String),
    /// Decoding a block failed as a whole: the cursor holds and the block is
    /// retried. A single malformed log is skipped by the venue instead.
    Decode(String),
    /// A chain read failed (discovery).
    Chain(String),
}

impl std::fmt::Display for VenueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VenueError::NotReady(m) => write!(f, "not ready: {m}"),
            VenueError::Decode(m) => write!(f, "decode: {m}"),
            VenueError::Chain(m) => write!(f, "chain: {m}"),
        }
    }
}

impl std::error::Error for VenueError {}

/// USD prices for decoding one block, as of that block's time.
pub trait Pricer: Send + Sync {
    /// USD per whole token: $1 for a stable, the base asset's price
    /// otherwise; 0 when unknown.
    fn usd_per_token(&self, token_key: &str) -> f64;
    /// USD value of a settled trade leg (a closed market keeps its last good
    /// price).
    fn usd_for_token(&self, token_key: &str, amount: f64) -> f64;
    /// The pair's reference mid in its own terms (the bps anchor); 0 when
    /// unavailable.
    fn pair_mid(&self, market: &str) -> f64;

    /// Token amount (whole units) worth `usd`: quote sizing. 0 when unpriced.
    fn token_for_usd(&self, token_key: &str, usd: f64) -> f64 {
        let px = self.usd_per_token(token_key);
        if px > 0.0 {
            usd / px
        } else {
            0.0
        }
    }
}

/// A proposed block, as the quote engine pins reads to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockRef {
    pub number: u64,
    /// Consensus block id (keys a proposal before it is final).
    pub id: [u8; 32],
    /// Ethereum block hash: every read of a quote job is pinned to it.
    pub hash: [u8; 32],
}

/// What a quote job can use: the local node, reads pinned to `block`, and a
/// pricer frozen at the job's start (one reference for every row of it).
pub struct QuoteCx<'a> {
    pub rpc: &'a Rpc,
    pub registry: &'a Registry,
    pub pricer: &'a dyn Pricer,
    pub block: BlockRef,
}

/// Prices nothing: for tests and for blocks with no venue to decode.
pub struct NoPrices;

impl Pricer for NoPrices {
    fn usd_per_token(&self, _: &str) -> f64 {
        0.0
    }
    fn usd_for_token(&self, _: &str, _: f64) -> f64 {
        0.0
    }
    fn pair_mid(&self, _: &str) -> f64 {
        0.0
    }
}

/// A venue's small durable key/value state (a pool a factory announced
/// once). Reads see what is committed plus this block's writes; writes are
/// committed with the block, so the cursor can never pass state that was not
/// stored.
#[derive(Debug, Default)]
pub struct VenueState {
    committed: HashMap<(String, String), String>,
    pending: Mutex<Vec<(String, String, String)>>,
}

impl VenueState {
    pub fn new(committed: HashMap<(String, String), String>) -> Self {
        Self { committed, pending: Mutex::new(Vec::new()) }
    }

    pub fn get(&self, venue: &str, key: &str) -> Option<String> {
        let pending = self.pending.lock();
        if let Some((_, _, v)) = pending.iter().rev().find(|(ve, k, _)| ve == venue && k == key) {
            return Some(v.clone());
        }
        self.committed.get(&(venue.to_string(), key.to_string())).cloned()
    }

    pub fn set(&self, venue: &str, key: &str, value: &str) {
        self.pending.lock().push((venue.to_string(), key.to_string(), value.to_string()));
    }

    /// This block's writes, for the commit.
    pub fn take_pending(&self) -> Vec<(String, String, String)> {
        std::mem::take(&mut *self.pending.lock())
    }

    /// After the commit: the writes are now committed.
    pub fn apply(&mut self, writes: &[(String, String, String)]) {
        for (v, k, val) in writes {
            self.committed.insert((v.clone(), k.clone()), val.clone());
        }
    }
}

/// What decoding a block can use.
pub struct DecodeCx<'a> {
    pub registry: &'a Registry,
    pub pricer: &'a dyn Pricer,
    pub state: &'a VenueState,
}

/// What discovery can use: the local node and the registry.
pub struct ChainCx<'a> {
    pub rpc: &'a Rpc,
    pub registry: &'a Registry,
}

/// A contract takers enter a venue through (compared with a transaction's
/// `to` by the core's attribution). No `router` = the venue itself (a direct
/// trade); a `router` name = the venue's own periphery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryPoint {
    pub address: Addr,
    pub router: Option<String>,
}

/// A shared forwarder some of a venue's quote updates go through: matched on
/// `to`, the 4-byte selector, and the static calldata word (0-based, after
/// the selector) that holds one of `targets`, as today: a relay routes only
/// to the destinations of the source that declared it. Empty `targets` =
/// any of the venue's destinations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GasRelay {
    pub address: Addr,
    pub selector: [u8; 4],
    pub target_word: usize,
    pub targets: Vec<Addr>,
}

/// How a venue's own quote-update transactions are recognised. With the
/// ring every transaction of a final block is seen, so the cost of each is
/// exact (gas limit × price paid); these rules only say which ones count.
/// A transaction counts once even if several rules match it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GasSources {
    /// Transactions sent straight to one of these (today's 'blocks' mode).
    pub destinations: Vec<Addr>,
    /// Transactions through a shared relay naming one of `destinations`.
    pub relays: Vec<GasRelay>,
    /// Transactions that emitted a log from this address with this topic0,
    /// whatever their `to` (today's 'logs' mode). The venue's watch set must
    /// copy these logs.
    pub logs: Vec<(Addr, B32)>,
}

/// A one-shot, dated replay of a venue's history shipped with the decode
/// change that needs it (today's `historyRevisions`). Applied once per
/// database, keyed by `id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRevision {
    pub id: &'static str,
    /// First UTC day whose stored history is wrong; `None` = the lifetime.
    pub from: Option<&'static str>,
    /// `Markets(..)`: add these newly listed markets' history only.
    pub markets: &'static [&'static str],
}

#[async_trait]
pub trait Venue: Send + Sync {
    /// The venue id its trades carry.
    fn id(&self) -> &str;

    /// Static metadata for the web app.
    fn meta(&self) -> Vec<VenueMeta>;

    /// Finds the venue's markets on chain. Re-runs every 10 minutes and must
    /// merge into what it holds, never replace it.
    async fn discover(&self, cx: &ChainCx<'_>) -> Result<(), VenueError>;

    /// What the reader must copy out of the ring for this venue. `NotReady`
    /// holds the cursor until discovery has resolved it.
    fn watch(&self) -> Result<WatchSet, VenueError>;

    /// The trades in one final block. Called once per block, strictly in
    /// block order, so a venue may keep state between blocks.
    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError>;

    /// Bid and ask for every market and size this venue quotes, with every
    /// read pinned to `cx.block`. An error makes the venue missing for this
    /// block only.
    async fn quote(&self, _cx: &QuoteCx<'_>, _sizes_usd: &[f64]) -> Result<Vec<mpamm_types::QuoteRow>, VenueError> {
        Ok(Vec::new())
    }

    /// Markets discovery found (what the quote engine will quote).
    fn markets(&self) -> Vec<String> {
        Vec::new()
    }

    /// Contracts takers enter through, for attribution.
    fn entry_points(&self) -> Vec<EntryPoint> {
        Vec::new()
    }

    /// Where the venue's own quote updates go. `None` = it doesn't fund its
    /// own quoting; `NotReady` holds until discovery resolves it.
    fn gas_sources(&self) -> Result<Option<GasSources>, VenueError> {
        Ok(None)
    }

    fn history_revisions(&self) -> Vec<HistoryRevision> {
        Vec::new()
    }

    /// The first UTC day of on-chain history, for lifetime replays.
    fn history_from_utc(&self) -> Option<&'static str> {
        None
    }
}
