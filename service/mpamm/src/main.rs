//! The mpamm.wtf service (docs/rebuild-spec.md → Architecture): one process
//! beside its Monad node. The ring reader owns a pinned core and never waits
//! on anything; the trade pipeline and the API run on the async runtime; one
//! thread writes SQLite.
//!
//! Built so far: the reader, the commit pipeline and the store, with a local
//! health endpoint. Venue modules, pricing, quotes and the stream join as
//! their milestones land (docs/rebuild-plan.md).
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

mod health;
#[cfg(target_os = "linux")]
mod run;
mod settings;

use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_writer(std::io::stderr)
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
        run::run(settings)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = settings;
        tracing::error!("mpamm maps the node's event ring and runs on Linux only (see service/README.md)");
        ExitCode::from(2)
    }
}
