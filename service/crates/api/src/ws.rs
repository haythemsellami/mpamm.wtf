//! `/stream`: the WebSocket transport around the gateway. One task per
//! connection reads subscriptions and runs the heartbeat; the writer drains
//! the peer's outbox onto the socket, one frame at a time.

use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};

use crate::gateway::{Frame, Gateway, Metrics, Outbox, Resolved, Step};
use crate::rest::App;
use crate::topics::{STREAM_V2_GZIP, STREAM_V2_JSON};

/// Largest client message (a subscription of 128 topics fits easily).
const MAX_CLIENT_MESSAGE: usize = 16_384;
/// How long a closing connection waits for the client's close reply.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// What the writer sends.
pub(crate) enum Out {
    Frame(Frame),
    Ping,
    Close(u16, &'static str),
}

/// Where a writer's frames go: the socket, or a test's collector.
pub(crate) trait Wire: Send {
    /// False when the connection is gone.
    fn send(&mut self, out: Out) -> BoxFuture<'_, bool>;
}

impl Wire for futures_util::stream::SplitSink<WebSocket, Message> {
    fn send(&mut self, out: Out) -> BoxFuture<'_, bool> {
        let message = match out {
            Out::Frame(Frame::Text(t)) => Message::Text(t),
            Out::Frame(Frame::Binary(b)) => Message::Binary(b),
            Out::Ping => Message::Ping(Bytes::new()),
            Out::Close(code, reason) => Message::Close(Some(CloseFrame { code, reason: reason.into() })),
        };
        Box::pin(async move { SinkExt::send(self, message).await.is_ok() })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum End {
    /// Cut without a close frame (too far behind, missed heartbeat).
    Cut,
    /// The close frame went out.
    Closed,
    /// The connection failed under us.
    Gone,
}

/// Drain one peer's outbox until it is cut, closed or gone. A cut lands even
/// while a write is stalled on a peer that stopped reading.
pub(crate) async fn drive(outbox: &Outbox, metrics: &Metrics, wire: &mut dyn Wire) -> End {
    loop {
        let frame = match outbox.next() {
            Step::Stop => return End::Cut,
            Step::Idle => {
                tokio::select! {
                    _ = outbox.wake.notified() => continue,
                    _ = outbox.kill.notified() => return End::Cut,
                }
            }
            Step::Ping => {
                tokio::select! {
                    ok = wire.send(Out::Ping) => if !ok { return End::Gone },
                    _ = outbox.kill.notified() => return End::Cut,
                }
                continue;
            }
            Step::Close(code, reason) => {
                return if wire.send(Out::Close(code, reason)).await { End::Closed } else { End::Gone };
            }
            Step::Write(frame) => frame,
            Step::Await { id, payload } => {
                let frame = tokio::select! {
                    frame = payload => frame,
                    _ = outbox.kill.notified() => return End::Cut,
                };
                match outbox.resolved(id, frame) {
                    Resolved::Write(frame) => frame,
                    Resolved::Skip => continue,
                    Resolved::Cut => {
                        metrics.slow_clients.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        return End::Cut;
                    }
                }
            }
        };
        let len = frame.len();
        tokio::select! {
            ok = wire.send(Out::Frame(frame)) => if !ok { return End::Gone },
            _ = outbox.kill.notified() => return End::Cut,
        }
        outbox.written();
        Metrics::add(&metrics.sent_bytes, len);
    }
}

/// The upgrade. A v2 encoding is preferred when offered at all, gzip first.
/// A client that offers neither is refused: today's unversioned stream is
/// served only by today's system.
pub(crate) async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    let ws = ws.protocols([STREAM_V2_GZIP, STREAM_V2_JSON]).max_message_size(MAX_CLIENT_MESSAGE);
    let Some(protocol) = ws.selected_protocol().cloned() else {
        let body =
            serde_json::json!({ "error": format!("offer the {STREAM_V2_GZIP} or {STREAM_V2_JSON} subprotocol") });
        return (StatusCode::BAD_REQUEST, axum::Json(body)).into_response();
    };
    let gzip = protocol == STREAM_V2_GZIP;
    let heartbeat = app.config.heartbeat;
    let gateway = app.gateway.clone();
    ws.on_upgrade(move |socket| serve(gateway, socket, gzip, heartbeat))
}

async fn serve(gateway: Gateway, socket: WebSocket, gzip: bool, heartbeat: Duration) {
    let (mut sink, mut stream) = socket.split();
    let (id, outbox) = gateway.accept(gzip);
    let metrics = gateway.raw_metrics();
    let writer = drive(&outbox, &metrics, &mut sink);
    let reader = async {
        // One unanswered ping round (at least `heartbeat` long) cuts a peer
        // that vanished without a close frame and would otherwise stay
        // subscribed, buffering, for the life of the process.
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + heartbeat, heartbeat);
        let mut awaiting_pong = false;
        loop {
            tokio::select! {
                message = stream.next() => match message {
                    None | Some(Err(_)) => return,
                    Some(Ok(Message::Text(text))) => gateway.on_client_message(id, text.as_str()),
                    Some(Ok(Message::Binary(bytes))) => gateway.on_client_message(id, &String::from_utf8_lossy(&bytes)),
                    Some(Ok(Message::Pong(_))) => awaiting_pong = false,
                    // a close is answered by the socket; the next read ends
                    Some(Ok(_)) => {}
                },
                _ = tick.tick() => {
                    if awaiting_pong {
                        gateway.cut(id);
                        return;
                    }
                    awaiting_pong = true;
                    outbox.request_ping();
                }
            }
        }
    };
    tokio::pin!(writer, reader);
    tokio::select! {
        end = &mut writer => if end == End::Closed {
            let _ = tokio::time::timeout(CLOSE_GRACE, &mut reader).await;
        },
        _ = &mut reader => {}
    }
    gateway.remove(id);
}

#[cfg(test)]
pub(crate) mod local {
    //! A peer without a socket, for driving the gateway directly (today's
    //! `localPeer`): its writer appends every frame to a list.
    use std::sync::Arc;

    use futures_util::future::BoxFuture;
    use parking_lot::Mutex;

    use super::{drive, End, Out, Wire};
    use crate::gateway::{Frame, Gateway, Outbox};

    #[derive(Clone, Default)]
    pub(crate) struct Sent(pub(crate) Arc<Mutex<Vec<Out>>>);

    impl Wire for Sent {
        fn send(&mut self, out: Out) -> BoxFuture<'_, bool> {
            self.0.lock().push(out);
            Box::pin(async { true })
        }
    }

    pub(crate) struct LocalPeer {
        pub(crate) id: u64,
        pub(crate) outbox: Arc<Outbox>,
        pub(crate) sent: Sent,
        pub(crate) writer: tokio::task::JoinHandle<End>,
        gateway: Gateway,
    }

    impl LocalPeer {
        pub(crate) fn new(gateway: &Gateway, gzip: bool) -> LocalPeer {
            let (id, outbox) = gateway.accept(gzip);
            let sent = Sent::default();
            let (o, mut w, metrics) = (outbox.clone(), sent.clone(), gateway.raw_metrics());
            let writer = tokio::spawn(async move { drive(&o, &metrics, &mut w).await });
            LocalPeer { id, outbox, sent, writer, gateway: gateway.clone() }
        }

        pub(crate) fn subscribe(&self, topics: serde_json::Value) {
            let text = serde_json::json!({ "type": "subscribe", "topics": topics }).to_string();
            self.gateway.on_client_message(self.id, &text);
        }

        /// Every data frame written so far, decoded.
        pub(crate) fn frames(&self) -> Vec<serde_json::Value> {
            self.sent
                .0
                .lock()
                .iter()
                .filter_map(|out| match out {
                    Out::Frame(Frame::Text(t)) => Some(serde_json::from_str(t.as_str()).unwrap()),
                    Out::Frame(Frame::Binary(b)) => {
                        let mut text = String::new();
                        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&b[..]), &mut text).unwrap();
                        Some(serde_json::from_str(&text).unwrap())
                    }
                    _ => None,
                })
                .collect()
        }

        pub(crate) fn binaries(&self) -> usize {
            self.sent.0.lock().iter().filter(|o| matches!(o, Out::Frame(Frame::Binary(_)))).count()
        }

        pub(crate) fn closes(&self) -> Vec<u16> {
            self.sent.0.lock().iter().filter_map(|o| if let Out::Close(c, _) = o { Some(*c) } else { None }).collect()
        }
    }
}
