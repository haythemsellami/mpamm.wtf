//! The execution-event ring, as the service sees it: its own event model
//! (`event`), what to copy out of the ring (`watch`), and block assembly with
//! commit states (`tracker`). `sdk` reads the node's ring on Linux.

pub mod event;
pub mod live;
pub mod tracker;
pub mod watch;

#[cfg(target_os = "linux")]
pub mod follow;
#[cfg(target_os = "linux")]
pub mod sdk;

pub use event::{hex, Addr, BlockStart, Event, Log, TxnHeader, TxnOutput, B32};
pub use tracker::{Block, Config, MissingReason, Output, Stats, Tracker};
pub use watch::{TopicFilter, WatchSet};
