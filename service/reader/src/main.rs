//! Phase 1 of the rebuild (docs/rebuild-spec.md → Rollout): follow the node's
//! execution-event ring and record, per block height, what the phase gate
//! needs: how long a proposal took to reach this node, how long it took to
//! execute, when it was voted / finalized / verified, whether a proposal lost,
//! and whether the reader ever lost events. A height the ring could not
//! deliver whole is read over RPC (local node, then the hosted archive) and
//! recorded as repaired, so "no unrepaired gap" can be checked.
//!
//! Output, under `--out-dir`:
//! - `blocks-YYYY-MM-DD.jsonl`: one line per settled height (`final`,
//!   `repaired`) or losing proposal (`abandoned`);
//! - `summary-YYYY-MM-DD.jsonl` (and stdout): one line per interval with
//!   percentiles, gaps, repairs, reader lag and how far back the ring reaches;
//! - `authors.json`: arrival delay per proposer key, for validator locations;
//! - `cursor.json`: the first height not yet written, where a restart resumes;
//! - `health.json`: rewritten every second (status, lag, unrepaired heights).
//!
//! Times: `proposal_epoch_nanos` is the proposer's clock, every other time is
//! this host's `record_epoch_nanos`; arrival therefore includes the two
//! clocks' offset (both NTP-disciplined), the rest are same-clock intervals.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

mod config;
mod files;
mod repair;
mod stats;

#[cfg(target_os = "linux")]
mod run;

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    run::main()
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("mpamm-reader maps the node's event ring and runs on Linux only (see service/README.md)");
    std::process::ExitCode::from(2)
}
