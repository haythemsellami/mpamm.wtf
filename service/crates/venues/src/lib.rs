//! Venue modules (docs/rebuild-spec.md → Venue modules in Rust and the
//! port): one module per protocol, each implementing `mpamm_core::Venue`.
//! The core never names a venue; adding one is a module here plus a line in
//! `all()`.

pub mod btr;
pub mod chain;
pub mod crystal;
pub mod generations;
pub mod logs;
pub mod metric;
pub mod poe;
pub mod thogamm;
pub mod util;
pub mod woofi;

use std::sync::Arc;

use mpamm_core::Venue;

/// Every venue the service runs, in today's registry order.
pub fn all() -> Vec<Arc<dyn Venue>> {
    vec![
        Arc::new(poe::Poe::default()),
        Arc::new(metric::venue()),
        Arc::new(thogamm::Thogamm::default()),
        Arc::new(crystal::Crystal::default()),
        Arc::new(woofi::Woofi::default()),
        Arc::new(btr::Btr::default()),
    ]
}
