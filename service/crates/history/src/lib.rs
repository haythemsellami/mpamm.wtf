//! History repairs and backfill (docs/rebuild-spec.md → History repairs):
//! the dated revisions venues ship with a decode change, a new venue's
//! lifetime history and an operator's replay, read from the hosted archive
//! pool and written beside the live pipeline without ever counting a trade
//! twice.

pub mod pool;

pub use pool::{ArchivePool, Logs, NodeStats, PoolConfig, PoolError};
