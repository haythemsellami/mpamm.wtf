//! The single writer: a thread that owns the write connection. The async
//! pipeline sends it work and awaits the result, so SQLite's blocking calls
//! never run on the async runtime and writes stay strictly ordered.

use std::{sync::mpsc, thread};

use tokio::sync::oneshot;

use crate::{BlockCommit, Committed, Result, Store, StoreError};

type Job = Box<dyn FnOnce(&mut Store) + Send>;

#[derive(Clone)]
pub struct Writer {
    jobs: mpsc::Sender<Job>,
}

impl Writer {
    pub fn spawn(mut store: Store) -> Self {
        let (jobs, rx) = mpsc::channel::<Job>();
        thread::Builder::new()
            .name("store-writer".into())
            .spawn(move || {
                for job in rx {
                    job(&mut store);
                }
            })
            .expect("spawn store writer");
        Self { jobs }
    }

    /// Runs `f` on the writer thread, after every job sent before it.
    pub async fn run<R: Send + 'static>(&self, f: impl FnOnce(&mut Store) -> Result<R> + Send + 'static) -> Result<R> {
        let (tx, rx) = oneshot::channel();
        self.jobs
            .send(Box::new(move |s: &mut Store| {
                let _ = tx.send(f(s));
            }))
            .map_err(|_| StoreError::Schema("store writer stopped".into()))?;
        rx.await.map_err(|_| StoreError::Schema("store writer stopped".into()))?
    }

    /// Commits one final block (see `Store::commit_block`).
    pub async fn commit(&self, c: BlockCommit) -> Result<Committed> {
        self.run(move |s| s.commit_block(&c)).await
    }
}
