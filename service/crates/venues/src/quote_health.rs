//! Why a venue stopped quoting (server/src/venues/quote-health.ts).
//!
//! An empty quote carries no signal: a maker switching itself off and a
//! module whose ABI drifted after a proxy upgrade look identical from the
//! outside. Every leg failing is venue-wide, so it is an error naming the
//! commonest failure, and the quote engine records the venue as missing for
//! that block with that reason. One market going quiet is routine per-pair
//! behaviour (a drained side, a cold reference): its legs are skipped.
//!
//! Today's notes are log lines here: an `OutageLatch` says an outage once
//! per episode and announces the heal, as today's `outageLatch` does.

use mpamm_core::VenueError;

/// A failed leg's reason: its error without the variant's prefix.
pub fn leg_reason(e: &VenueError) -> String {
    message(e).to_string()
}

fn message(e: &VenueError) -> &str {
    match e {
        VenueError::NotReady(m) | VenueError::Decode(m) | VenueError::Chain(m) => m,
    }
}

/// A reverted leg's `Error(string)` text (today's `revertReason`), as the
/// chain client renders it at the end of the error: `… (reverted: <text>)`.
pub fn revert_text(e: &VenueError) -> Option<&str> {
    const MARK: &str = "(reverted: ";
    let m = message(e);
    let at = m.rfind(MARK)?;
    m[at + MARK.len()..].strip_suffix(')').map(str::trim)
}

/// The venue-wide outage reason, or `None` while ANY leg still answers (or
/// there were none). Legs failing for different reasons report the commonest
/// one (a plurality; ties go to whichever was seen first): a venue-wide cause
/// is the same on every leg, so it outweighs a flaky leg's noise.
pub fn outage_reason<T>(results: &[Result<T, VenueError>]) -> Option<String> {
    if results.is_empty() || results.iter().any(Result::is_ok) {
        return None;
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for e in results.iter().filter_map(|r| r.as_ref().err()) {
        let reason = leg_reason(e);
        match counts.iter_mut().find(|(r, _)| *r == reason) {
            Some((_, n)) => *n += 1,
            None => counts.push((reason, 1)),
        }
    }
    let mut top: Option<(String, usize)> = None;
    for (reason, n) in counts {
        if top.as_ref().is_none_or(|(_, most)| n > *most) {
            top = Some((reason, n));
        }
    }
    top.map(|(r, _)| r)
}

/// `Err` when every leg failed: the venue is missing for this block, and the
/// error says why (today's `createQuoteOutageReporter`).
pub fn check_outage<T>(venue_name: &str, results: &[Result<T, VenueError>]) -> Result<(), VenueError> {
    match outage_reason(results) {
        None => Ok(()),
        Some(reason) => Err(VenueError::Chain(format!(
            "{venue_name} quotes unavailable — all {} legs failed with \"{reason}\" (venue disabled, or the ABI drifted from the contract)",
            results.len()
        ))),
    }
}

/// One outage on the record: said once per reason (a changed reason is a new
/// event), and the heal announced rather than left implicit.
#[derive(Debug, Default)]
pub struct OutageLatch {
    current: Option<String>,
}

impl OutageLatch {
    /// `Some((reason, msg))`: an outage, identified by `reason`; `None`: the
    /// subject quotes again.
    pub fn report(&mut self, name: &str, outage: Option<(&str, &str)>) {
        match outage {
            Some((reason, msg)) => {
                if self.current.as_deref() != Some(reason) {
                    self.current = Some(reason.to_string());
                    tracing::warn!(target: "venues", "{msg}");
                }
            }
            None => {
                if let Some(was) = self.current.take() {
                    tracing::info!(target: "venues", "{name} quoting again (was \"{was}\")");
                }
            }
        }
    }

    /// The reason on the record, if any.
    pub fn current(&self) -> Option<&str> {
        self.current.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fail(m: &str) -> Result<(), VenueError> {
        Err(VenueError::Chain(m.into()))
    }

    /// Today's quoteOutageReason: null while any leg answers; otherwise the
    /// plurality reason, ties to the first seen.
    #[test]
    fn names_the_commonest_failure_only_when_every_leg_failed() {
        assert_eq!(outage_reason::<()>(&[]), None);
        assert_eq!(outage_reason(&[Ok(()), fail("a")]), None);
        assert_eq!(outage_reason(&[fail("a"), fail("b"), fail("b")]).as_deref(), Some("b"));
        assert_eq!(outage_reason(&[fail("a"), fail("b")]).as_deref(), Some("a"));
        let err = check_outage("X", &[fail("maker: paused"), fail("maker: paused")]).unwrap_err();
        assert_eq!(
            err,
            VenueError::Chain(
                "X quotes unavailable — all 2 legs failed with \"maker: paused\" (venue disabled, or the ABI drifted from the contract)"
                    .into()
            )
        );
        assert!(check_outage("X", &[Ok(()), fail("a")]).is_ok());
    }

    /// The node's own message may repeat the reason; the decoded one closes
    /// the chain client's rendering.
    #[test]
    fn a_reverted_legs_text_is_the_decoded_error_string() {
        let leg = |m: &str| VenueError::Chain(m.into());
        assert_eq!(
            revert_text(&leg("f(): rpc error 3: execution reverted: maker: balance (reverted: maker: balance)")),
            Some("maker: balance")
        );
        assert_eq!(revert_text(&leg("f(): rpc error 3: execution reverted (custom error 0x19abf40e)")), None);
        assert_eq!(revert_text(&leg("f() batch: transport: timed out")), None);
    }

    #[test]
    fn a_latch_says_an_outage_once_per_reason_and_clears_on_the_heal() {
        let mut l = OutageLatch::default();
        l.report("X", None);
        assert_eq!(l.current(), None);
        l.report("X", Some(("a", "X down: a")));
        l.report("X", Some(("a", "X down: a, again")));
        assert_eq!(l.current(), Some("a"));
        l.report("X", Some(("b", "X down: b")));
        assert_eq!(l.current(), Some("b"));
        l.report("X", None);
        assert_eq!(l.current(), None);
    }
}
