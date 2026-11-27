//! Decoding a watched log as a known event.

use alloy_primitives::B256;
use alloy_sol_types::SolEvent;
use mpamm_core::FinalLog;

/// The log as `E`, if its topic0 is `E`'s and it decodes. A log that claims
/// to be `E` but doesn't decode is malformed: the caller skips it (one
/// malformed log never holds the cursor).
pub fn decode<E: SolEvent>(log: &FinalLog) -> Option<E> {
    if log.topic0().map(|t| B256::from(*t)) != Some(E::SIGNATURE_HASH) {
        return None;
    }
    let topics = log.topics.iter().map(|t| B256::from(*t));
    match E::decode_raw_log(topics, &log.data) {
        Ok(e) => Some(e),
        Err(err) => {
            tracing::warn!(target: "venues", "skipping a malformed {} log: {err}", E::SIGNATURE);
            None
        }
    }
}

pub fn topic0<E: SolEvent>() -> [u8; 32] {
    E::SIGNATURE_HASH.0
}
