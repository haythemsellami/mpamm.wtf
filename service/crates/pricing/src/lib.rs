//! Prices (docs/rebuild-spec.md → Prices): the exchange feeds every
//! reference comes from, every mid they had for the last hours, ERC-4626
//! wrapper rates, the pair-terms reference, and the USD pricer decode uses.

pub mod book;
pub mod history;
pub mod kraken_checksum;
pub mod reference;

pub use book::{Book, Side, Walk};
pub use history::MidHistory;
pub use reference::{Exchanges, Fees, Rates, Reference};
