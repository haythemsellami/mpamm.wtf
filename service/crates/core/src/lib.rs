//! What the venue modules and the pipeline share: a final block in one
//! shape whether it came from the ring or from RPC, and the `Venue` trait.

pub mod block;
pub mod venue;

pub use block::{FinalBlock, FinalLog, FinalTxn, Origin};
pub use venue::{DecodeCx, Venue, VenueError};
