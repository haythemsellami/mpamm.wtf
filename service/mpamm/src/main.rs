//! The mpamm.wtf service (docs/rebuild-spec.md → Architecture): one process
//! beside its Monad node. The ring reader owns a pinned core and never waits
//! on anything; the trade pipeline and the API run on the async runtime; one
//! thread writes SQLite.
//!
//! Built so far: the reader, the commit pipeline and the store, with a local
//! health endpoint. Venue modules, pricing, quotes and the stream join as
//! their milestones land (docs/rebuild-plan.md).
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

mod fallback;
mod health;
mod history;
mod marks;
mod notes;
mod replication;
#[cfg(target_os = "linux")]
mod run;
mod settings;
mod source;

use std::process::ExitCode;

use clap::Parser;
use tracing_subscriber::prelude::*;

fn main() -> ExitCode {
    // The log, and the notes window `/api/markets` serves (every warning).
    let notes = notes::NoteBuffer::new();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
                .with_writer(std::io::stderr),
        )
        .with(notes.layer())
        .init();
    let cli = settings::Cli::parse();
    let settings = match settings::Settings::load(cli, |k| std::env::var(k).ok()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("{e}");
            return ExitCode::FAILURE;
        }
    };
    #[cfg(target_os = "linux")]
    {
        run::run(settings, notes)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (settings, notes);
        tracing::error!("mpamm maps the node's event ring and runs on Linux only (see service/README.md)");
        ExitCode::from(2)
    }
}
