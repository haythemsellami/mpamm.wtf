//! The connection loop every feed shares: (re)connect with backoff, send the
//! subscriptions, answer pings, hand each text message to the feed, and drop
//! a connection whose feed went quiet (a half-open socket) so the next one
//! starts from fresh snapshots.

use std::{future::Future, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use tokio::{sync::watch, time::Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::{now_ms, Exchange};

const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A connection that lasted this long resets the backoff; one that fails
/// right after opening (a rejected subscription) keeps backing off, which
/// exchanges' connection limits reward.
const STABLE: Duration = Duration::from_secs(60);

pub trait Session: Send {
    /// Sent right after each connect.
    fn subscribe(&mut self) -> Vec<String>;
    /// One text message; returns messages to send. `Err` drops the
    /// connection for fresh snapshots.
    fn handle(&mut self, ex: &Exchange, raw: &str, now: u64) -> Result<Vec<String>, String>;
    /// Every 10 s while connected.
    fn tick(&mut self, _ex: &Exchange, _now: u64) -> Vec<String> {
        Vec::new()
    }
    /// An application-level ping and its period.
    fn ping(&self) -> Option<(Duration, String)> {
        None
    }
}

pub async fn run_loop<P, Fut, S>(
    name: &'static str,
    ex: Arc<Exchange>,
    mut stop: watch::Receiver<bool>,
    prepare: P,
    mut session: S,
) where
    P: Fn() -> Fut,
    Fut: Future<Output = String>,
    S: Session,
{
    let mut backoff = BACKOFF_MIN;
    loop {
        if *stop.borrow() {
            return;
        }
        ex.reset_books();
        let url = prepare().await;
        let opened = Instant::now();
        match connect_async(url.as_str()).await {
            Ok((stream, _)) => {
                tracing::info!(target: "feeds", "{name}: connected");
                ex.touch(now_ms());
                let (mut tx, mut rx) = stream.split();
                let mut ok = true;
                for m in session.subscribe() {
                    ok &= tx.send(Message::text(m)).await.is_ok();
                }
                let ping = session.ping();
                let mut ping_every = tokio::time::interval(ping.as_ref().map_or(Duration::from_secs(3600), |p| p.0));
                ping_every.tick().await;
                let mut watchdog = tokio::time::interval(Duration::from_secs(10));
                watchdog.tick().await;
                while ok {
                    tokio::select! {
                        msg = rx.next() => match msg {
                            Some(Ok(Message::Text(t))) => match session.handle(&ex, t.as_str(), now_ms()) {
                                Ok(out) => {
                                    for m in out {
                                        ok &= tx.send(Message::text(m)).await.is_ok();
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(target: "feeds", "{name}: {e}; reconnecting for fresh books");
                                    ok = false;
                                }
                            },
                            Some(Ok(Message::Ping(p))) => ok &= tx.send(Message::Pong(p)).await.is_ok(),
                            Some(Ok(Message::Close(_))) | None => ok = false,
                            Some(Err(e)) => {
                                tracing::warn!(target: "feeds", "{name}: {e}");
                                ok = false;
                            }
                            Some(Ok(_)) => {}
                        },
                        _ = ping_every.tick(), if ping.is_some() => {
                            ok &= tx.send(Message::text(ping.as_ref().unwrap().1.clone())).await.is_ok();
                        }
                        _ = watchdog.tick() => {
                            let now = now_ms();
                            if !ex.fresh(now) {
                                tracing::warn!(target: "feeds", "{name}: no message for {} s; reconnecting", super::STALE_MS / 1000);
                                ok = false;
                            } else {
                                for m in session.tick(&ex, now) {
                                    ok &= tx.send(Message::text(m)).await.is_ok();
                                }
                            }
                        }
                        _ = stop.changed() => return,
                    }
                }
                tracing::info!(target: "feeds", "{name}: disconnected");
            }
            Err(e) => {
                tracing::warn!(target: "feeds", "{name}: connect: {}", e.to_string().chars().take(200).collect::<String>())
            }
        }
        if opened.elapsed() >= STABLE {
            backoff = BACKOFF_MIN;
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}
