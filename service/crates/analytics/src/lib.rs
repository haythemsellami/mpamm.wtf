//! The REST aggregations over the fill window: the leaderboard
//! (`server/src/analytics.ts`) and the markout curves
//! (`server/src/markout-curves.ts`), as pure functions over rows the caller
//! has already read.
//!
//! They answer exactly as today's TypeScript does, down to tie order and
//! rounding (checked against its recorded answers in `tests/golden.json`).
//! That is why the code keeps a few JavaScript habits the port would
//! otherwise drop: maps iterate in insertion order (`indexmap`), sorts are
//! stable with the TS comparators' numeric results (`js::cmp`), and rounding
//! is `Math.round`'s, which takes a negative half toward +∞ where
//! `f64::round` takes it away from zero (`js::round`).
//!
//! Today's leaderboard streams the window twice in bounded pages because the
//! production box could not hold it; here the rows are a slice and both
//! passes read it directly. The bounded top-K pruning it did between pages is
//! a full stable sort here: pruning only ever drops an entry that `cap`
//! better-or-earlier entries already beat, so both keep the same top `cap`.

pub mod js;
pub mod leaderboard;

pub use leaderboard::{compute_leaderboard, LbRow};
