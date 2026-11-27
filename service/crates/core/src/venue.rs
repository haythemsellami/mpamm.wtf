//! The venue trait (docs/rebuild-spec.md → The venue trait). It grows with
//! the port: discovery and quoting arrive with the first venue modules
//! (M5, M9); this is the part the commit pipeline drives.

use mpamm_registry::Registry;
use mpamm_ring::WatchSet;
use mpamm_types::{Fill, VenueMeta};

use crate::FinalBlock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VenueError {
    /// The venue can't say yet what it watches (discovery hasn't resolved
    /// it): the cursor holds rather than tail an incomplete source set.
    NotReady(String),
    /// Decoding a block failed as a whole: the cursor holds and the block is
    /// retried. A single malformed log is skipped by the venue instead.
    Decode(String),
}

impl std::fmt::Display for VenueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VenueError::NotReady(m) => write!(f, "not ready: {m}"),
            VenueError::Decode(m) => write!(f, "decode: {m}"),
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

/// What decoding a block can use.
pub struct DecodeCx<'a> {
    pub registry: &'a Registry,
    pub pricer: &'a dyn Pricer,
}

pub trait Venue: Send + Sync {
    /// The venue id its trades carry.
    fn id(&self) -> &str;

    /// Static metadata for the web app.
    fn meta(&self) -> Vec<VenueMeta>;

    /// What the reader must copy out of the ring for this venue: trade,
    /// state and attribution logs, gas destinations. Discovery only ever
    /// grows it.
    fn watch(&self) -> Result<WatchSet, VenueError>;

    /// The trades in one final block. Called once per block, strictly in
    /// block order, so a venue may keep state between blocks.
    fn decode(&self, cx: &DecodeCx<'_>, block: &FinalBlock) -> Result<Vec<Fill>, VenueError>;
}
