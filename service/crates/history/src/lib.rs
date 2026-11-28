//! History repairs and backfill (docs/rebuild-spec.md → History repairs):
//! the dated revisions venues ship with a decode change, a new venue's
//! lifetime history and an operator's replay, read from the hosted archive
//! pool and written beside the live pipeline without ever counting a trade
//! twice.

pub mod exec;
pub mod plan;
pub mod pool;

pub use exec::{Executor, Progress, Sink, Stats};
pub use plan::{plan, Kind, Plan, Planned, Reset, VenueHistory};
pub use pool::{ArchivePool, Logs, NodeStats, PoolConfig, PoolError};
