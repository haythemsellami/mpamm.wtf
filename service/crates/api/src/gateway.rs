//! The subscription gateway (today's `SubscriptionGateway`, stream-v2.ts).
//!
//! - Every topic's message is serialized once, compressed at most once, and
//!   the same bytes go to every subscriber of that topic.
//! - Snapshot-shaped messages (quotes, state, volume, depth) coalesce: while a
//!   topic's message is compressing, a newer one replaces the pending one,
//!   except a pending resync, which already makes the client reload what the
//!   newer frame carries.
//! - Fills are never compressed, so they cannot reorder behind a compression
//!   job: a viewer gets them in order, or a resync.
//! - A subscriber's unsent bytes are bounded. One that falls 256 KB behind is
//!   cut; its browser reconnects and resynchronizes from REST. A stalled peer
//!   that is never cut keeps every frame in our memory: that OOM-killed
//!   today's service once (2026-07-29).
//! - A snapshot compressing on subscribe holds that subscriber's later frames
//!   behind it, so no update can arrive before the snapshot it follows.
//!
//! The core is synchronous and runs under one lock, as the TypeScript ran on
//! one event loop; compression runs on the blocking pool and re-enters the
//! core when done. Each peer drains its own outbox on its own task.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use axum::extract::ws::Utf8Bytes;
use bytes::Bytes;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use indexmap::{IndexMap, IndexSet};
use mpamm_registry::Registry;
use mpamm_types::{QuoteSnapshot, StreamMessage, StreamState, VenueRole};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::value::RawValue;
use tokio::sync::{oneshot, watch, Notify};

use crate::topics::{parse_topics, StreamTopic};
use crate::{ApiSource, Clock};

/// Unsent bytes a subscriber may hold (queued, compressing or being written)
/// before it is cut.
pub(crate) const BACKLOG: usize = 256_000;
/// Smaller envelopes go as text: a gzip member costs more than it saves.
pub(crate) const COMPRESS_MIN: usize = 512;
/// State frames go out at most once a second per topic.
pub(crate) const STATE_INTERVAL_MS: f64 = 1_000.0;
/// Subscription changes a connection may make per second.
pub(crate) const MAX_CHANGES_PER_SECOND: u32 = 20;
const GZIP_LEVEL: u32 = 3;
pub(crate) const INVALID_SUBSCRIPTION: (u16, &str) = (1008, "invalid subscription");

/// One WebSocket message as it leaves: JSON text, or a gzip member (binary).
#[derive(Debug, Clone)]
pub(crate) enum Frame {
    Text(Utf8Bytes),
    Binary(Bytes),
}

impl Frame {
    pub(crate) fn len(&self) -> usize {
        match self {
            Frame::Text(t) => t.len(),
            Frame::Binary(b) => b.len(),
        }
    }
}

/// A compressed snapshot shared by every subscriber that joins while it is
/// the topic's latest.
type Encoded = Shared<BoxFuture<'static, Frame>>;

enum Payload {
    Ready(Frame),
    Pending(Encoded),
}

struct Queued {
    id: u64,
    topic: Arc<str>,
    subscription: u64,
    payload: Payload,
    bytes: usize,
}

/// The gateway's counters, served as `stream` on `GET /api/health`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamMetrics {
    pub connections: u64,
    pub topics: u64,
    pub encodes: u64,
    pub raw_bytes: u64,
    pub encoded_bytes: u64,
    pub sent_bytes: u64,
    pub coalesced: u64,
    pub slow_clients: u64,
}

#[derive(Default)]
pub(crate) struct Metrics {
    connections: AtomicU64,
    topics: AtomicU64,
    encodes: AtomicU64,
    raw_bytes: AtomicU64,
    encoded_bytes: AtomicU64,
    pub(crate) sent_bytes: AtomicU64,
    coalesced: AtomicU64,
    pub(crate) slow_clients: AtomicU64,
}

impl Metrics {
    pub(crate) fn add(counter: &AtomicU64, n: usize) {
        counter.fetch_add(n as u64, Ordering::Relaxed);
    }

    fn snapshot(&self) -> StreamMetrics {
        let r = |c: &AtomicU64| c.load(Ordering::Relaxed);
        StreamMetrics {
            connections: r(&self.connections),
            topics: r(&self.topics),
            encodes: r(&self.encodes),
            raw_bytes: r(&self.raw_bytes),
            encoded_bytes: r(&self.encoded_bytes),
            sent_bytes: r(&self.sent_bytes),
            coalesced: r(&self.coalesced),
            slow_clients: r(&self.slow_clients),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Life {
    #[default]
    Open,
    /// Send the close frame, then stop.
    Closing(u16, &'static str),
    /// Drop the connection without a close frame.
    Terminated,
}

/// What a peer's writer does next.
pub(crate) enum Step {
    Write(Frame),
    Await { id: u64, payload: Encoded },
    Ping,
    Close(u16, &'static str),
    Stop,
    Idle,
}

/// What became of a compressed snapshot the writer waited for.
pub(crate) enum Resolved {
    Write(Frame),
    /// The subscription changed meanwhile; the entry is gone.
    Skip,
    /// The frame alone exceeds the backlog: the peer is cut.
    Cut,
}

#[derive(Default)]
struct OutboxInner {
    queue: VecDeque<Queued>,
    queued_bytes: usize,
    /// The frame being written: what `bufferedAmount` counted in `ws`.
    in_flight: usize,
    life: Life,
    ping: bool,
}

/// One peer's unsent frames, filled by the core and drained by the peer's
/// writer task.
#[derive(Default)]
pub(crate) struct Outbox {
    inner: Mutex<OutboxInner>,
    pub(crate) wake: Notify,
    pub(crate) kill: Notify,
}

impl Outbox {
    fn is_open(&self) -> bool {
        self.inner.lock().life == Life::Open
    }

    /// The writer's next step. A ready frame leaves the queue here and counts
    /// as in flight until [`Outbox::written`].
    pub(crate) fn next(&self) -> Step {
        let mut o = self.inner.lock();
        match o.life {
            Life::Terminated => return Step::Stop,
            Life::Closing(code, reason) => return Step::Close(code, reason),
            Life::Open => {}
        }
        if o.ping {
            o.ping = false;
            return Step::Ping;
        }
        let Some(front) = o.queue.front() else { return Step::Idle };
        match &front.payload {
            Payload::Pending(p) => Step::Await { id: front.id, payload: p.clone() },
            Payload::Ready(_) => {
                let entry = o.queue.pop_front().expect("front exists");
                o.queued_bytes -= entry.bytes;
                let Payload::Ready(frame) = entry.payload else { unreachable!() };
                o.in_flight = frame.len();
                Step::Write(frame)
            }
        }
    }

    /// The snapshot the writer awaited is ready.
    pub(crate) fn resolved(&self, id: u64, frame: Frame) -> Resolved {
        let mut o = self.inner.lock();
        if o.life != Life::Open || o.queue.front().map(|e| e.id) != Some(id) {
            return Resolved::Skip;
        }
        let entry = o.queue.pop_front().expect("front exists");
        o.queued_bytes -= entry.bytes;
        if o.in_flight + frame.len() > BACKLOG {
            drop(o);
            self.terminate();
            return Resolved::Cut;
        }
        o.in_flight = frame.len();
        Resolved::Write(frame)
    }

    pub(crate) fn written(&self) {
        self.inner.lock().in_flight = 0;
    }

    pub(crate) fn request_ping(&self) {
        self.inner.lock().ping = true;
        self.wake.notify_one();
    }

    pub(crate) fn terminate(&self) {
        let mut o = self.inner.lock();
        o.life = Life::Terminated;
        o.queue.clear();
        o.queued_bytes = 0;
        drop(o);
        self.kill.notify_one();
        self.wake.notify_one();
    }

    fn close(&self, code: u16, reason: &'static str) {
        let mut o = self.inner.lock();
        if o.life == Life::Open {
            o.life = Life::Closing(code, reason);
            o.queue.clear();
            o.queued_bytes = 0;
        }
        drop(o);
        self.wake.notify_one();
    }

    /// Queue a frame unless the peer is over its backlog (then false).
    fn push(&self, entry: Queued) -> bool {
        let mut o = self.inner.lock();
        if o.life != Life::Open {
            return true;
        }
        if o.in_flight + o.queued_bytes + entry.bytes > BACKLOG {
            return false;
        }
        o.queued_bytes += entry.bytes;
        o.queue.push_back(entry);
        drop(o);
        self.wake.notify_one();
        true
    }

    /// Drop queued frames of subscriptions the peer no longer holds, the
    /// entry awaiting compression included: retained topics keep their
    /// ordered events, removed ones release their budget at once.
    fn retain(&self, topics: &HashMap<Arc<str>, u64>) {
        let mut o = self.inner.lock();
        o.queue.retain(|e| topics.get(&e.topic) == Some(&e.subscription));
        o.queued_bytes = o.queue.iter().map(|e| e.bytes).sum();
    }

    #[cfg(test)]
    pub(crate) fn queued_bytes(&self) -> usize {
        self.inner.lock().queued_bytes
    }
}

/// A message on a topic: a stream message, or a depth snapshot carried as
/// the source serialized it.
#[derive(Debug, Clone)]
pub(crate) enum TopicMessage {
    Stream(StreamMessage),
    Depth(Box<RawValue>),
}

impl TopicMessage {
    fn is_fill(&self) -> bool {
        matches!(self, TopicMessage::Stream(StreamMessage::Fill(_) | StreamMessage::FillResync))
    }

    fn is_resync(&self) -> bool {
        matches!(self, TopicMessage::Stream(m) if m.is_resync())
    }
}

impl Serialize for TopicMessage {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            TopicMessage::Stream(m) => m.serialize(s),
            TopicMessage::Depth(raw) => {
                use serde::ser::SerializeStruct;
                let mut m = s.serialize_struct("TopicMessage", 2)?;
                m.serialize_field("ch", "depth")?;
                m.serialize_field("data", raw)?;
                m.end()
            }
        }
    }
}

#[derive(Serialize)]
struct Envelope<'a> {
    v: u8,
    epoch: &'a str,
    topic: &'a str,
    seq: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    snapshot: bool,
    message: &'a TopicMessage,
}

struct Peer {
    gzip: bool,
    /// topic key → this subscription's token; a re-subscription gets a new one.
    topics: HashMap<Arc<str>, u64>,
    outbox: Arc<Outbox>,
    changes: u32,
    window: Instant,
}

struct Group {
    id: u64,
    topic: StreamTopic,
    peers: IndexSet<u64>,
    seq: u64,
    encoding: bool,
    pending: Option<TopicMessage>,
    last_json: Option<String>,
    last_catalog: Option<String>,
    last_at: f64,
    initial: Option<(String, Encoded)>,
    /// Dropping it ends the depth watch, which releases the source's demand.
    _stop: Option<oneshot::Sender<()>>,
}

struct Core {
    weak: Weak<Inner>,
    source: Arc<dyn ApiSource>,
    clock: Clock,
    epoch: String,
    groups: IndexMap<Arc<str>, Group>,
    /// Survives a group's removal, so a returning topic keeps counting up.
    sequences: HashMap<Arc<str>, u64>,
    peers: HashMap<u64, Peer>,
    next_id: u64,
    /// Peers cut or closed during an operation, removed at its end.
    dead: Vec<u64>,
    metrics: Arc<Metrics>,
}

struct Inner {
    core: Mutex<Core>,
    metrics: Arc<Metrics>,
}

/// Cheap to clone; every clone is the same gateway.
#[derive(Clone)]
pub(crate) struct Gateway {
    inner: Arc<Inner>,
}

impl Gateway {
    pub(crate) fn new(source: Arc<dyn ApiSource>, clock: Clock) -> Gateway {
        let metrics = Arc::new(Metrics::default());
        let inner = Arc::new_cyclic(|weak| Inner {
            core: Mutex::new(Core {
                weak: weak.clone(),
                source,
                clock,
                epoch: uuid::Uuid::new_v4().to_string(),
                groups: IndexMap::new(),
                sequences: HashMap::new(),
                peers: HashMap::new(),
                next_id: 0,
                dead: Vec::new(),
                metrics: metrics.clone(),
            }),
            metrics,
        });
        Gateway { inner }
    }

    pub(crate) fn metrics(&self) -> StreamMetrics {
        self.inner.metrics.snapshot()
    }

    pub(crate) fn raw_metrics(&self) -> Arc<Metrics> {
        self.inner.metrics.clone()
    }

    #[cfg(test)]
    pub(crate) fn epoch(&self) -> String {
        self.inner.core.lock().epoch.clone()
    }

    /// A new connection; its writer drains the returned outbox.
    pub(crate) fn accept(&self, gzip: bool) -> (u64, Arc<Outbox>) {
        let mut core = self.inner.core.lock();
        let id = core.next_id();
        let outbox = Arc::new(Outbox::default());
        core.peers.insert(
            id,
            Peer { gzip, topics: HashMap::new(), outbox: outbox.clone(), changes: 0, window: Instant::now() },
        );
        core.reap();
        (id, outbox)
    }

    /// A message from the client: a subscription (the full set it wants), or
    /// anything else, which closes it with 1008.
    pub(crate) fn on_client_message(&self, peer: u64, text: &str) {
        let mut core = self.inner.core.lock();
        core.on_client_message(peer, text);
        core.reap();
    }

    /// A message from the source.
    pub(crate) fn on_message(&self, message: StreamMessage) {
        let mut core = self.inner.core.lock();
        core.on_message(message);
        core.reap();
    }

    /// The connection ended.
    pub(crate) fn remove(&self, peer: u64) {
        let mut core = self.inner.core.lock();
        core.dead.push(peer);
        core.reap();
    }

    /// Drop a peer without a close frame (a missed heartbeat).
    pub(crate) fn cut(&self, peer: u64) {
        let mut core = self.inner.core.lock();
        if let Some(p) = core.peers.get(&peer) {
            p.outbox.terminate();
        }
        core.dead.push(peer);
        core.reap();
    }

    /// The forwarding task's new depth publication for one group.
    fn on_depth(&self, key: &Arc<str>, group_id: u64, json: &str) {
        let raw = match RawValue::from_string(json.to_string()) {
            Ok(raw) => raw,
            Err(e) => {
                tracing::warn!("depth publication for {key} is not JSON: {e}");
                return;
            }
        };
        let mut core = self.inner.core.lock();
        if core.groups.get(key).is_some_and(|g| g.id == group_id) {
            core.publish(key, TopicMessage::Depth(raw));
        }
        core.reap();
    }

    /// A topic's compression finished.
    fn on_encoded(&self, key: &Arc<str>, group_id: u64, json: Utf8Bytes, recipients: &[(u64, u64)], gz: Option<Bytes>) {
        let mut core = self.inner.core.lock();
        core.encoded(key, group_id, json, recipients, gz);
        core.reap();
    }
}

fn gzip(data: &[u8]) -> std::io::Result<Bytes> {
    let mut e = flate2::write::GzEncoder::new(Vec::with_capacity(data.len() / 4), flate2::Compression::new(GZIP_LEVEL));
    e.write_all(data)?;
    Ok(Bytes::from(e.finish()?))
}

fn baseline_ids(source: &dyn ApiSource) -> HashSet<String> {
    source.venues().into_iter().filter(|v| v.role == VenueRole::Baseline).map(|v| v.id).collect()
}

/// What a topic takes of a source message, or nothing. Quote rows are
/// filtered to the topic's market and size (baseline venues only on a
/// baseline topic) and lose the frame telemetry; state loses the registry.
fn select(topic: &StreamTopic, message: &StreamMessage, baselines: &HashSet<String>) -> Option<TopicMessage> {
    if message.channel() != topic.channel() {
        return None;
    }
    Some(TopicMessage::Stream(match (message, topic) {
        (StreamMessage::Quotes(q), StreamTopic::Quotes { market, size_usd, baseline }) => {
            let rows = q
                .rows
                .iter()
                .filter(|r| {
                    &r.market == market && r.size_usd == *size_usd && (*baseline || !baselines.contains(&r.venue_id))
                })
                .cloned()
                .collect();
            StreamMessage::Quotes(Box::new(QuoteSnapshot {
                block_hash: q.block_hash.clone(),
                revision: q.revision,
                proposal_ts: q.proposal_ts,
                block: q.block,
                mon_usd: q.mon_usd,
                ts: q.ts,
                rows,
                frame: None,
            }))
        }
        (StreamMessage::State(s), _) => StreamMessage::State(Box::new((**s).clone().tick())),
        (other, _) => other.clone(),
    }))
}

/// Forward one market's depth publications to its group until the group
/// goes (its stop sender drops) or the source ends the watch.
async fn forward_depth(
    weak: Weak<Inner>,
    key: Arc<str>,
    group_id: u64,
    mut rx: watch::Receiver<Option<Arc<str>>>,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut stop => return,
            changed = rx.changed() => {
                if changed.is_err() {
                    return;
                }
                let Some(json) = rx.borrow_and_update().clone() else { continue };
                let Some(inner) = weak.upgrade() else { return };
                Gateway { inner }.on_depth(&key, group_id, &json);
            }
        }
    }
}

impl Core {
    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn on_client_message(&mut self, peer_id: u64, text: &str) {
        let Some(peer) = self.peers.get_mut(&peer_id) else { return };
        let request: Option<serde_json::Value> = serde_json::from_str(text).ok();
        let topics = request
            .filter(|r| r.get("type").and_then(|t| t.as_str()) == Some("subscribe"))
            .and_then(|r| parse_topics(&r["topics"], Registry::get()));
        let allowed = topics.is_some() && {
            if peer.window.elapsed() >= Duration::from_secs(1) {
                peer.window = Instant::now();
                peer.changes = 0;
            }
            peer.changes += 1;
            peer.changes <= MAX_CHANGES_PER_SECOND
        };
        match topics {
            Some(topics) if allowed => self.subscribe(peer_id, topics),
            _ => {
                let (code, reason) = INVALID_SUBSCRIPTION;
                peer.outbox.close(code, reason);
                self.dead.push(peer_id);
            }
        }
    }

    /// Drop a peer from one group, removing the group with its last peer.
    fn leave(&mut self, peer_id: u64, key: &Arc<str>) {
        if let Some(group) = self.groups.get_mut(key) {
            group.peers.shift_remove(&peer_id);
            if group.peers.is_empty() {
                self.groups.shift_remove(key);
            }
        }
    }

    fn subscribe(&mut self, peer_id: u64, topics: Vec<StreamTopic>) {
        let wanted: HashSet<String> = topics.iter().map(StreamTopic::key).collect();
        let Some(peer) = self.peers.get_mut(&peer_id) else { return };
        let removed: Vec<Arc<str>> = peer.topics.keys().filter(|k| !wanted.contains(&***k)).cloned().collect();
        for key in &removed {
            peer.topics.remove(key);
        }
        peer.outbox.retain(&peer.topics);
        for key in &removed {
            self.leave(peer_id, key);
        }
        for topic in topics {
            let key: Arc<str> = topic.key().into();
            let subscription = self.next_id();
            let Some(peer) = self.peers.get_mut(&peer_id) else { return };
            if peer.topics.contains_key(&key) {
                continue;
            }
            peer.topics.insert(key.clone(), subscription);
            if !self.groups.contains_key(&key) {
                let group = self.new_group(&key, topic.clone());
                self.groups.insert(key.clone(), group);
            }
            let group = self.groups.get_mut(&key).expect("just ensured");
            group.peers.insert(peer_id);
            let first = group.peers.len() == 1;
            if let Some(initial) = self.snapshot(&topic) {
                // A later peer's snapshot must not hide a catalog update still
                // owed to the existing peers: only the first establishes it.
                if let (true, TopicMessage::Stream(StreamMessage::State(s))) = (first, &initial) {
                    let catalog = s.quote_markets.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default());
                    self.groups.get_mut(&key).expect("exists").last_catalog = catalog;
                }
                self.send_snapshot(peer_id, &key, initial);
            }
        }
        self.metrics.topics.store(self.groups.len() as u64, Ordering::Relaxed);
    }

    fn new_group(&mut self, key: &Arc<str>, topic: StreamTopic) -> Group {
        let id = self.next_id();
        let mut stop = None;
        if let StreamTopic::Depth { market } = &topic {
            let mut rx = self.source.watch_depth(market);
            // The subscriber's snapshot holds the current curve. Marked here,
            // under the lock, not when the task first runs: a curve published
            // in between would otherwise be marked seen and never sent.
            rx.borrow_and_update();
            let (tx, stop_rx) = oneshot::channel();
            stop = Some(tx);
            tokio::spawn(forward_depth(self.weak.clone(), key.clone(), id, rx, stop_rx));
        }
        Group {
            id,
            topic,
            peers: IndexSet::new(),
            seq: self.sequences.get(key).copied().unwrap_or(0),
            encoding: false,
            pending: None,
            last_json: None,
            last_catalog: None,
            last_at: 0.0,
            initial: None,
            _stop: stop,
        }
    }

    fn snapshot(&self, topic: &StreamTopic) -> Option<TopicMessage> {
        match topic {
            StreamTopic::State => {
                Some(TopicMessage::Stream(StreamMessage::State(Box::new(StreamState::hello(&self.source.state())))))
            }
            StreamTopic::Quotes { .. } => {
                let quotes = StreamMessage::Quotes(Box::new(self.source.quotes()));
                select(topic, &quotes, &baseline_ids(&*self.source))
            }
            StreamTopic::Volume => {
                self.source.volume().pop().map(|today| TopicMessage::Stream(StreamMessage::Volume(Box::new(today))))
            }
            StreamTopic::Depth { market } => {
                let json = self.source.depth(market)?;
                RawValue::from_string(json.to_string()).ok().map(TopicMessage::Depth)
            }
            StreamTopic::Fill => None,
        }
    }

    fn envelope(&self, key: &str, seq: u64, snapshot: bool, message: &TopicMessage) -> String {
        let envelope = Envelope { v: 2, epoch: &self.epoch, topic: key, seq, snapshot, message };
        serde_json::to_string(&envelope).expect("an envelope always serializes")
    }

    fn on_message(&mut self, message: StreamMessage) {
        let now = self.now();
        let mut baselines: Option<HashSet<String>> = None;
        let keys: Vec<Arc<str>> = self.groups.keys().cloned().collect();
        for key in keys {
            let Some(group) = self.groups.get(&key) else { continue };
            if group.topic == StreamTopic::State && now - group.last_at < STATE_INTERVAL_MS {
                continue;
            }
            if message.channel() != group.topic.channel() {
                continue;
            }
            // read the registry once per message, however many quote topics
            if matches!(message, StreamMessage::Quotes(_)) && baselines.is_none() {
                baselines = Some(baseline_ids(&*self.source));
            }
            let empty = HashSet::new();
            let Some(selected) = select(&group.topic, &message, baselines.as_ref().unwrap_or(&empty)) else {
                continue;
            };
            if let TopicMessage::Stream(StreamMessage::Volume(day)) = &selected {
                let json = serde_json::to_string(day).unwrap_or_default();
                let group = self.groups.get_mut(&key).expect("exists");
                if group.last_json.as_deref() == Some(json.as_str()) {
                    continue;
                }
                group.last_json = Some(json);
            }
            self.publish(&key, selected);
        }
    }

    fn publish(&mut self, key: &Arc<str>, mut message: TopicMessage) {
        let now = self.now();
        let Some(group) = self.groups.get_mut(key) else { return };
        if group.peers.is_empty() {
            return;
        }
        if group.encoding {
            // Latest wins, except over a pending resync: the client reloads
            // its whole snapshot on that, which already holds anything the
            // newer frame carries.
            if !group.pending.as_ref().is_some_and(TopicMessage::is_resync) {
                group.pending = Some(message);
            }
            self.metrics.coalesced.fetch_add(1, Ordering::Relaxed);
            return;
        }
        // Catalogs are tracked only when publishing: a coalesced pending
        // state keeps its catalog until it actually goes out.
        if let TopicMessage::Stream(StreamMessage::State(state)) = &mut message {
            let catalog = state.quote_markets.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default());
            if catalog == group.last_catalog {
                state.quote_markets = None;
            } else {
                group.last_catalog = catalog;
            }
        }
        group.last_at = now;
        group.seq += 1;
        let (seq, group_id) = (group.seq, group.id);
        self.sequences.insert(key.clone(), seq);
        let json = self.envelope(key, seq, false, &message);
        let len = json.len();
        Metrics::add(&self.metrics.raw_bytes, len);
        let group = &self.groups[key];
        // Small messages, and every fill, skip compression: fills then can't
        // reorder behind a compression job.
        let compress = !message.is_fill()
            && len >= COMPRESS_MIN
            && group.peers.iter().any(|p| self.peers.get(p).is_some_and(|p| p.gzip));
        let json = Utf8Bytes::from(json);
        if !compress {
            let peers: Vec<u64> = group.peers.iter().copied().collect();
            for peer in peers {
                self.send(peer, key, Payload::Ready(Frame::Text(json.clone())), len);
            }
            return;
        }
        // A peer joining during compression gets its own snapshot, and an
        // earlier subscription must not deliver into a later one for the
        // same key: the job goes to the subscriptions held now.
        let recipients: Vec<(u64, u64)> = group
            .peers
            .iter()
            .filter_map(|p| self.peers.get(p).and_then(|peer| peer.topics.get(key)).map(|s| (*p, *s)))
            .collect();
        self.groups.get_mut(key).expect("exists").encoding = true;
        self.metrics.encodes.fetch_add(1, Ordering::Relaxed);
        let weak = self.weak.clone();
        let key = key.clone();
        tokio::spawn(async move {
            let text = json.clone();
            let gz = tokio::task::spawn_blocking(move || gzip(text.as_bytes())).await.ok().and_then(Result::ok);
            if let Some(inner) = weak.upgrade() {
                Gateway { inner }.on_encoded(&key, group_id, json, &recipients, gz);
            }
        });
    }

    fn encoded(
        &mut self,
        key: &Arc<str>,
        group_id: u64,
        json: Utf8Bytes,
        recipients: &[(u64, u64)],
        gz: Option<Bytes>,
    ) {
        if let Some(buf) = &gz {
            Metrics::add(&self.metrics.encoded_bytes, buf.len());
        }
        for &(peer_id, subscription) in recipients {
            let Some(peer) = self.peers.get(&peer_id) else { continue };
            if peer.topics.get(key) != Some(&subscription) {
                continue;
            }
            let frame = match (&gz, peer.gzip) {
                (Some(buf), true) => Frame::Binary(buf.clone()),
                _ => Frame::Text(json.clone()),
            };
            let len = frame.len();
            self.send(peer_id, key, Payload::Ready(frame), len);
        }
        let Some(group) = self.groups.get_mut(key) else { return };
        if group.id != group_id {
            return;
        }
        group.encoding = false;
        if let Some(next) = group.pending.take() {
            self.publish(key, next);
        }
    }

    fn send_snapshot(&mut self, peer_id: u64, key: &Arc<str>, message: TopicMessage) {
        let seq = self.groups[key].seq;
        let json = self.envelope(key, seq, true, &message);
        let len = json.len();
        let gzip_peer = self.peers.get(&peer_id).is_some_and(|p| p.gzip);
        if !gzip_peer || len < COMPRESS_MIN {
            self.send(peer_id, key, Payload::Ready(Frame::Text(Utf8Bytes::from(json))), len);
            return;
        }
        let group = self.groups.get_mut(key).expect("exists");
        // Identical subscribers share one compression of an unchanged snapshot.
        let reuse = group.initial.as_ref().is_some_and(|(j, _)| *j == json);
        if !reuse {
            Metrics::add(&self.metrics.raw_bytes, len);
            self.metrics.encodes.fetch_add(1, Ordering::Relaxed);
            let metrics = self.metrics.clone();
            let text = json.clone();
            let job = tokio::task::spawn_blocking(move || {
                let gz = gzip(text.as_bytes());
                if let Ok(buf) = &gz {
                    Metrics::add(&metrics.encoded_bytes, buf.len());
                }
                gz
            });
            let fallback = json.clone();
            let encoded: Encoded = async move {
                match job.await {
                    Ok(Ok(buf)) => Frame::Binary(buf),
                    _ => Frame::Text(Utf8Bytes::from(fallback)),
                }
            }
            .boxed()
            .shared();
            group.initial = Some((json, encoded));
        }
        let encoded = group.initial.as_ref().expect("set above").1.clone();
        self.send(peer_id, key, Payload::Pending(encoded), len);
    }

    /// Queue a frame for one subscription, or cut a peer that is too far
    /// behind.
    fn send(&mut self, peer_id: u64, key: &Arc<str>, payload: Payload, bytes: usize) {
        let Some(peer) = self.peers.get(&peer_id) else { return };
        let Some(&subscription) = peer.topics.get(key) else { return };
        if !peer.outbox.is_open() {
            return;
        }
        let id = self.next_id();
        let peer = &self.peers[&peer_id];
        if !peer.outbox.push(Queued { id, topic: key.clone(), subscription, payload, bytes }) {
            self.metrics.slow_clients.fetch_add(1, Ordering::Relaxed);
            peer.outbox.terminate();
            self.dead.push(peer_id);
        }
    }

    /// Remove the peers cut or closed during this operation.
    fn reap(&mut self) {
        while let Some(peer_id) = self.dead.pop() {
            let Some(peer) = self.peers.remove(&peer_id) else { continue };
            for key in peer.topics.keys() {
                self.leave(peer_id, key);
            }
        }
        self.metrics.connections.store(self.peers.len() as u64, Ordering::Relaxed);
        self.metrics.topics.store(self.groups.len() as u64, Ordering::Relaxed);
    }
}

/// Feed the source's messages to the gateway for as long as the source
/// sends them. A receiver that falls behind has lost messages: quotes,
/// state and volume are snapshots the next message replaces, but fills are
/// events, so the tape is told to reload.
pub(crate) async fn pump(gateway: Gateway, mut rx: tokio::sync::broadcast::Receiver<StreamMessage>) {
    use tokio::sync::broadcast::error::RecvError;
    loop {
        match rx.recv().await {
            Ok(message) => gateway.on_message(message),
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("stream gateway fell {n} messages behind the source; resyncing the tape");
                gateway.on_message(StreamMessage::FillResync);
            }
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    //! Ports of today's `localPeer` tests (stream-v2.test.ts): the gateway
    //! driven directly, every peer's writer collecting what it would send.
    use std::collections::BTreeMap;

    use mpamm_types::{DailyVolume, Fill, FillCategory, QuoteRow, Side, VenueDaily};
    use serde_json::{json, Value};

    use super::*;
    use crate::testing::{sample_state, FakeSource};
    use crate::ws::local::LocalPeer;
    use crate::ws::End;

    /// A row as prod ships it (~320 bytes): a one-row topic message clears
    /// the 512-byte compression threshold on its own, as real ones do.
    fn row(market: &str, size_usd: f64) -> QuoteRow {
        QuoteRow {
            venue_id: "poe".into(),
            market: market.into(),
            size_usd,
            bid_bps: -25.113599704000844,
            ask_bps: 26.180428069468853,
            bid_px: 0.015558350990069999,
            ask_px: 0.015638356962646323,
            spread_bps: 51.29402777346969,
            filled_full: true,
            one_sided: None,
            fee_bps: 21.28521667311415,
            cex_ask_bps: Some(15.105414314744436),
            cex_bid_bps: Some(14.246109677127361),
            ts: 100.0,
        }
    }

    fn quotes(block: u64, rows: Vec<QuoteRow>) -> QuoteSnapshot {
        QuoteSnapshot {
            block_hash: None,
            revision: None,
            proposal_ts: None,
            block,
            mon_usd: 0.024,
            ts: 100.0,
            rows,
            frame: None,
        }
    }

    fn source() -> Arc<FakeSource> {
        let source = FakeSource::new(sample_state());
        source.with(|d| {
            d.quotes = quotes(1, vec![row("MON/USDC", 1000.0), row("BTC/USDC", 1000.0), row("MON/USDC", 100.0)]);
            d.quotes.block_hash = Some(format!("0x{}", "ab".repeat(32)));
        });
        source
    }

    fn gateway(source: &Arc<FakeSource>) -> Gateway {
        Gateway::new(source.clone(), Arc::new(|| 1_800_000_000_000.0))
    }

    fn topic(market: &str) -> Value {
        json!({ "channel": "quotes", "market": market, "sizeUsd": 1000, "baseline": false })
    }

    fn fill() -> Fill {
        Fill {
            id: "retained-fill".into(),
            venue_id: "poe".into(),
            market: "MON/USDC".into(),
            side: Side::Buy,
            category: FillCategory::Unknown,
            usd: 100.0,
            base_amount: 1.0,
            exec_px: 100.0,
            px_approx: false,
            tx_hash: "0x123".into(),
            to: "0x456".into(),
            router: None,
            pool: "pool".into(),
            block_number: 2,
            ts: 101.0,
            markouts_bps: vec![None; 5],
            time_source: None,
        }
    }

    async fn wait_for(mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(done(), "timed out");
    }

    fn blocks(frames: &[Value]) -> Vec<u64> {
        frames.iter().map(|f| f["message"]["data"]["block"].as_u64().unwrap()).collect()
    }

    #[tokio::test]
    async fn bounds_live_frames_queued_behind_initial_compression() {
        let source = source();
        let gw = gateway(&source);
        let mut peer = LocalPeer::new(&gw, true);
        peer.subscribe(json!([topic("MON/USDC")]));
        assert_eq!(gw.metrics().topics, 1);
        // nothing drains while this runs: the snapshot is still compressing
        for block in 2..2_000 {
            gw.on_message(StreamMessage::Quotes(Box::new(quotes(block, vec![]))));
        }
        let m = gw.metrics();
        assert_eq!(m.slow_clients, 1);
        assert_eq!((m.connections, m.topics), (0, 0), "the cut peer's subscriptions are gone");
        assert_eq!((&mut peer.writer).await.unwrap(), End::Cut);
        assert!(peer.sent.0.lock().is_empty(), "a cut peer is sent nothing more");
    }

    #[tokio::test]
    async fn discards_removed_snapshots_and_queued_updates_but_keeps_retained_fills() {
        let source = source();
        let gw = gateway(&source);
        let peer = LocalPeer::new(&gw, true);
        peer.subscribe(json!([topic("MON/USDC"), { "channel": "fill" }]));
        gw.on_message(StreamMessage::Quotes(Box::new(quotes(2, vec![]))));
        gw.on_message(StreamMessage::Fill(Box::new(fill())));
        peer.subscribe(json!([topic("BTC/USDC"), { "channel": "fill" }]));
        gw.on_message(StreamMessage::Quotes(Box::new(quotes(3, vec![]))));
        wait_for(|| peer.frames().len() == 3).await;
        let frames = peer.frames();
        assert_eq!(frames[0]["seq"], 1);
        assert_eq!(frames[0]["message"], json!({ "ch": "fill", "data": serde_json::to_value(fill()).unwrap() }));
        let topics: Vec<&str> = frames[1..].iter().map(|f| f["topic"].as_str().unwrap()).collect();
        assert_eq!(topics, ["quotes:BTC/USDC:1000:0", "quotes:BTC/USDC:1000:0"]);
        assert_eq!((frames[1]["snapshot"].clone(), frames[1]["seq"].clone()), (json!(true), json!(0)));
        assert_eq!((frames[2]["seq"].clone(), frames[2]["message"]["data"]["block"].clone()), (json!(1), json!(3)));
        assert!(frames[2].get("snapshot").is_none());
        assert_eq!(gw.metrics().slow_clients, 0);
        assert!(!peer.writer.is_finished());
    }

    #[tokio::test]
    async fn a_fill_resync_reaches_tape_subscribers_only_as_a_one_off() {
        let source = source();
        let gw = gateway(&source);
        let (tape, volume) = (LocalPeer::new(&gw, true), LocalPeer::new(&gw, true));
        tape.subscribe(json!([{ "channel": "fill" }]));
        volume.subscribe(json!([{ "channel": "volume" }]));
        gw.on_message(StreamMessage::FillResync);
        wait_for(|| tape.frames().len() == 1).await;
        let frame = &tape.frames()[0];
        assert_eq!(
            (frame["seq"].clone(), frame["message"].clone()),
            (json!(1), json!({ "ch": "fill", "resync": true }))
        );
        assert!(frame.get("snapshot").is_none());
        assert_eq!(frame["v"], 2);
        assert_eq!(frame["epoch"], gw.epoch());
        assert!(volume.frames().is_empty());
    }

    #[tokio::test]
    async fn a_volume_resync_reaches_volume_subscribers_only_as_a_one_off() {
        let source = source();
        let gw = gateway(&source);
        let (volume, tape) = (LocalPeer::new(&gw, false), LocalPeer::new(&gw, false));
        volume.subscribe(json!([{ "channel": "volume" }]));
        tape.subscribe(json!([{ "channel": "fill" }]));
        gw.on_message(StreamMessage::VolumeResync);
        wait_for(|| volume.frames().len() == 1).await;
        assert_eq!(volume.frames()[0]["message"], json!({ "ch": "volume", "resync": true }));
        assert_eq!(volume.frames()[0]["seq"], 1);
        assert!(tape.frames().is_empty());
    }

    fn today(usd: f64) -> DailyVolume {
        // enough venues that the envelope crosses the compression threshold
        let by_venue: BTreeMap<String, VenueDaily> =
            (0..12).map(|i| (format!("venue-{i}"), VenueDaily { usd: usd + i as f64, swaps: i })).collect();
        DailyVolume { utc_day: "2026-10-15".into(), by_venue, partial: true }
    }

    /// A history revision's resync lands while today's (compressed) bucket
    /// is encoding, and the next tick arrives before it finishes: latest-wins
    /// would replace the resync, and the tab would keep misbooked closed days.
    #[tokio::test]
    async fn never_coalesces_away_a_pending_volume_resync() {
        let source = source();
        let gw = gateway(&source);
        let volume = LocalPeer::new(&gw, true);
        volume.subscribe(json!([{ "channel": "volume" }]));
        gw.on_message(StreamMessage::Volume(Box::new(today(1.0))));
        gw.on_message(StreamMessage::VolumeResync);
        gw.on_message(StreamMessage::Volume(Box::new(today(2.0))));
        wait_for(|| volume.frames().len() == 2).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let frames = volume.frames();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["message"]["data"]["byVenue"]["venue-0"]["usd"], 1.0);
        assert_eq!(frames[1]["message"], json!({ "ch": "volume", "resync": true }));
        assert_eq!(gw.metrics().coalesced, 2);
    }

    #[tokio::test]
    async fn an_unchanged_volume_day_is_not_sent_again() {
        let source = source();
        let gw = gateway(&source);
        let volume = LocalPeer::new(&gw, false);
        volume.subscribe(json!([{ "channel": "volume" }]));
        for usd in [1.0, 1.0, 2.0] {
            gw.on_message(StreamMessage::Volume(Box::new(today(usd))));
        }
        wait_for(|| volume.frames().len() == 2).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(volume.frames().len(), 2);
    }

    #[tokio::test]
    async fn releases_abandoned_snapshot_backlog_during_rapid_market_switches() {
        let source = source();
        let rows: Vec<QuoteRow> = (0..300).flat_map(|_| [row("MON/USDC", 1000.0), row("BTC/USDC", 1000.0)]).collect();
        source.with(|d| d.quotes = quotes(1, rows));
        let gw = gateway(&source);
        let peer = LocalPeer::new(&gw, true);
        for i in 0..10 {
            peer.subscribe(json!([topic(if i % 2 == 1 { "BTC/USDC" } else { "MON/USDC" })]));
            assert!(peer.outbox.queued_bytes() < BACKLOG);
        }
        assert!(!peer.writer.is_finished());
        wait_for(|| peer.frames().len() == 1).await;
        let frame = &peer.frames()[0];
        assert_eq!(frame["snapshot"], true);
        let rows = frame["message"]["data"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 300);
        assert!(rows.iter().all(|r| r["market"] == "BTC/USDC"));
        assert_eq!(gw.metrics().slow_clients, 0);
    }

    #[tokio::test]
    async fn an_older_compression_job_never_reaches_a_replacement_subscription() {
        let source = source();
        let gw = gateway(&source);
        let (observer, client) = (LocalPeer::new(&gw, true), LocalPeer::new(&gw, true));
        observer.subscribe(json!([topic("MON/USDC")]));
        client.subscribe(json!([topic("MON/USDC")]));
        wait_for(|| observer.frames().len() == 1 && client.frames().len() == 1).await;
        let set_block = |block| source.with(|d| d.quotes.block = block);
        set_block(2);
        gw.on_message(StreamMessage::Quotes(Box::new(source.quotes())));
        client.subscribe(json!([]));
        set_block(3);
        client.subscribe(json!([topic("MON/USDC")]));
        wait_for(|| observer.frames().len() == 2 && client.frames().len() == 2).await;
        set_block(4);
        gw.on_message(StreamMessage::Quotes(Box::new(source.quotes())));
        wait_for(|| observer.frames().len() == 3 && client.frames().len() == 3).await;
        assert_eq!(blocks(&client.frames()), [1, 3, 4]);
        assert_eq!(blocks(&observer.frames()), [1, 2, 4]);
        let seqs: Vec<u64> = client.frames().iter().map(|f| f["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, [0, 1, 2]);
        assert_eq!(client.binaries(), 3);
    }

    #[tokio::test]
    async fn an_invalid_or_too_frequent_subscription_closes_with_1008() {
        let source = source();
        let gw = gateway(&source);
        let oversized = r#"{"type":"subscribe","topics":[{"channel":"quotes","market":"MON/USDC","sizeUsd":12345,"baseline":false}]}"#;
        for bad in ["not json", r#"{"type":"unsubscribe","topics":[]}"#, oversized, "null"] {
            let mut peer = LocalPeer::new(&gw, false);
            gw.on_client_message(peer.id, bad);
            assert_eq!((&mut peer.writer).await.unwrap(), End::Closed, "{bad}");
            assert_eq!(peer.closes(), [1008]);
        }
        let mut peer = LocalPeer::new(&gw, false);
        for _ in 0..MAX_CHANGES_PER_SECOND {
            peer.subscribe(json!([{ "channel": "fill" }]));
        }
        tokio::task::yield_now().await;
        assert!(!peer.writer.is_finished());
        peer.subscribe(json!([{ "channel": "fill" }]));
        assert_eq!((&mut peer.writer).await.unwrap(), End::Closed, "the 21st change within a second");
        assert_eq!(peer.closes(), [1008]);
        assert_eq!((gw.metrics().connections, gw.metrics().topics), (0, 0));
    }

    /// A gateway whose clock the test moves (today's tests mock `Date.now`).
    fn clocked(source: &Arc<FakeSource>) -> (Gateway, Arc<AtomicU64>) {
        let now = Arc::new(AtomicU64::new(1_800_000_000_000));
        let n = now.clone();
        (Gateway::new(source.clone(), Arc::new(move || n.load(Ordering::SeqCst) as f64)), now)
    }

    fn state_message(source: &FakeSource, block: u64) -> StreamMessage {
        let mut state = StreamState::hello(&source.state());
        state.block = block;
        StreamMessage::State(Box::new(state))
    }

    fn catalog(entries: &[(&str, &[&str])]) -> IndexMap<String, Vec<String>> {
        entries.iter().map(|(v, m)| (v.to_string(), m.iter().map(|s| s.to_string()).collect())).collect()
    }

    #[tokio::test]
    async fn state_goes_out_at_most_once_a_second() {
        let source = source();
        let (gw, now) = clocked(&source);
        let peer = LocalPeer::new(&gw, false);
        peer.subscribe(json!([{ "channel": "state" }]));
        gw.on_message(state_message(&source, 2));
        gw.on_message(state_message(&source, 3));
        now.fetch_add(999, Ordering::SeqCst);
        gw.on_message(state_message(&source, 4));
        now.fetch_add(1, Ordering::SeqCst);
        gw.on_message(state_message(&source, 5));
        wait_for(|| peer.frames().len() == 3).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(blocks(&peer.frames()), [1, 2, 5], "the snapshot, then one tick per second");
    }

    #[tokio::test]
    async fn sends_the_catalog_on_subscription_then_only_when_it_changes() {
        let source = source();
        source.with(|d| d.state.quote_markets = Some(catalog(&[("poe", &["MON/USDC"])])));
        let (gw, now) = clocked(&source);
        let peer = LocalPeer::new(&gw, false);
        peer.subscribe(json!([{ "channel": "state" }]));
        for block in [2, 3, 4] {
            if block == 3 {
                source.with(|d| d.state.quote_markets = Some(catalog(&[("poe", &["MON/USDC", "BTC/USDC"])])));
            }
            now.fetch_add(1_001, Ordering::SeqCst);
            gw.on_message(state_message(&source, block));
        }
        wait_for(|| peer.frames().len() == 4).await;
        let f = peer.frames();
        assert_eq!(f[0]["message"]["data"]["quoteMarkets"], json!({ "poe": ["MON/USDC"] }));
        assert!(f[1]["message"]["data"].get("quoteMarkets").is_none());
        assert_eq!(f[2]["message"]["data"]["quoteMarkets"], json!({ "poe": ["MON/USDC", "BTC/USDC"] }));
        assert!(f[3]["message"]["data"].get("quoteMarkets").is_none());
    }

    #[tokio::test]
    async fn a_new_subscriber_does_not_hide_a_catalog_update_from_existing_ones() {
        let source = source();
        source.with(|d| d.state.quote_markets = Some(catalog(&[("poe", &["MON/USDC"])])));
        let (gw, _) = clocked(&source);
        let existing = LocalPeer::new(&gw, false);
        existing.subscribe(json!([{ "channel": "state" }]));
        source.with(|d| d.state.quote_markets = Some(catalog(&[("poe", &["BTC/USDC"])])));
        let joining = LocalPeer::new(&gw, false);
        joining.subscribe(json!([{ "channel": "state" }]));
        wait_for(|| joining.frames().len() == 1).await;
        assert_eq!(joining.frames()[0]["message"]["data"]["quoteMarkets"], json!({ "poe": ["BTC/USDC"] }));
        gw.on_message(state_message(&source, 2));
        wait_for(|| existing.frames().len() == 2).await;
        assert_eq!(existing.frames()[1]["message"]["data"]["quoteMarkets"], json!({ "poe": ["BTC/USDC"] }));
    }

    #[tokio::test]
    async fn a_catalog_change_survives_newer_state_replacing_a_pending_compressed_frame() {
        let source = source();
        source.with(|d| {
            // today's test state: small enough that only the large catalog crosses the threshold
            d.state.markets = vec!["MON/USDC".into(), "BTC/USDC".into()];
            d.state.quote_markets = Some(catalog(&[("poe", &["MON/USDC"])]));
        });
        let (gw, now) = clocked(&source);
        let peer = LocalPeer::new(&gw, true);
        peer.subscribe(json!([{ "channel": "state" }]));
        wait_for(|| peer.frames().len() == 1).await;
        let initial_binaries = peer.binaries();
        let names: Vec<String> = (0..40).map(|i| format!("venue-{i}")).collect();
        let large: IndexMap<String, Vec<String>> =
            names.iter().map(|n| (n.clone(), vec!["MON/USDC".to_string(), "BTC/USDC".to_string()])).collect();
        for block in [2, 3, 4] {
            source.with(|d| {
                d.state.quote_markets =
                    Some(if block == 2 { large.clone() } else { catalog(&[("poe", &["BTC/USDC"])]) })
            });
            now.fetch_add(1_001, Ordering::SeqCst);
            gw.on_message(state_message(&source, block));
        }
        wait_for(|| peer.frames().len() == 3).await;
        let f = peer.frames();
        assert_eq!(peer.binaries(), initial_binaries + 1);
        assert_eq!(
            (f[1]["message"]["data"]["block"].clone(), f[1]["message"]["data"]["quoteMarkets"].clone()),
            (json!(2), serde_json::to_value(&large).unwrap())
        );
        assert_eq!(f[2]["message"]["data"]["block"], 4);
        assert_eq!(f[2]["message"]["data"]["quoteMarkets"], json!({ "poe": ["BTC/USDC"] }));
        assert_eq!(f.iter().map(|f| f["seq"].as_u64().unwrap()).collect::<Vec<_>>(), [0, 1, 2]);
    }

    #[tokio::test]
    async fn keeps_only_the_latest_pending_snapshot_during_a_burst() {
        let source = source();
        let gw = gateway(&source);
        let peer = LocalPeer::new(&gw, true);
        peer.subscribe(json!([topic("MON/USDC")]));
        for block in [2, 3, 4] {
            source.with(|d| d.quotes.block = block);
            gw.on_message(StreamMessage::Quotes(Box::new(source.quotes())));
        }
        wait_for(|| peer.frames().len() == 3).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(blocks(&peer.frames()), [1, 2, 4]);
        assert_eq!(peer.frames().iter().map(|f| f["seq"].as_u64().unwrap()).collect::<Vec<_>>(), [0, 1, 2]);
        assert_eq!(gw.metrics().coalesced, 2, "blocks 3 and 4 waited while block 2 compressed; 4 replaced 3");
    }

    #[tokio::test]
    async fn a_topic_keeps_counting_after_it_empties_and_returns() {
        let source = source();
        let gw = gateway(&source);
        let peer = LocalPeer::new(&gw, false);
        peer.subscribe(json!([{ "channel": "fill" }]));
        gw.on_message(StreamMessage::Fill(Box::new(fill())));
        // (an unsent frame of a topic the peer leaves is dropped, so let it go out first)
        wait_for(|| peer.frames().len() == 1).await;
        peer.subscribe(json!([]));
        assert_eq!(gw.metrics().topics, 0);
        peer.subscribe(json!([{ "channel": "fill" }]));
        gw.on_message(StreamMessage::Fill(Box::new(fill())));
        wait_for(|| peer.frames().len() == 2).await;
        // a returning topic must not restart at 1: the client would drop it as a replay
        assert_eq!(peer.frames().iter().map(|f| f["seq"].as_u64().unwrap()).collect::<Vec<_>>(), [1, 2]);
    }

    #[tokio::test]
    async fn fills_are_never_compressed_and_keep_their_order() {
        let source = source();
        let gw = gateway(&source);
        let peer = LocalPeer::new(&gw, true);
        peer.subscribe(json!([{ "channel": "fill" }]));
        for i in 0..50 {
            let mut f = fill();
            f.id = format!("fill-{i}");
            f.to = "x".repeat(600); // well past the compression threshold
            gw.on_message(StreamMessage::Fill(Box::new(f)));
        }
        wait_for(|| peer.frames().len() == 50).await;
        assert_eq!(peer.binaries(), 0);
        let f = peer.frames();
        assert!(f
            .iter()
            .enumerate()
            .all(|(i, f)| f["seq"] == i + 1 && f["message"]["data"]["id"] == format!("fill-{i}")));
    }

    #[tokio::test]
    async fn a_lagging_pump_tells_the_tape_to_reload() {
        let source = source();
        let gw = gateway(&source);
        let peer = LocalPeer::new(&gw, false);
        peer.subscribe(json!([{ "channel": "fill" }]));
        let (tx, rx) = tokio::sync::broadcast::channel(2);
        for _ in 0..5 {
            tx.send(StreamMessage::Fill(Box::new(fill()))).unwrap();
        }
        drop(tx);
        pump(gw.clone(), rx).await;
        wait_for(|| peer.frames().len() == 3).await;
        let f = peer.frames();
        assert_eq!(f[0]["message"], json!({ "ch": "fill", "resync": true }), "three fills were lost");
        assert_eq!(f.len(), 3, "the resync, then the two fills still held");
    }

    #[tokio::test]
    async fn a_depth_topic_holds_the_source_demand_while_subscribed() {
        let source = source();
        let gw = gateway(&source);
        let peer = LocalPeer::new(&gw, false);
        peer.subscribe(json!([{ "channel": "depth", "market": "MON/USDC" }]));
        assert_eq!(source.depth_watchers("MON/USDC"), 1);
        assert!(peer.frames().is_empty(), "no curve yet, no snapshot");
        let depth = r#"{"market":"MON/USDC","asOfBlock":1,"refMid":0.024,"ts":100,"venues":[]}"#;
        source.publish_depth("MON/USDC", depth);
        wait_for(|| peer.frames().len() == 1).await;
        let f = &peer.frames()[0];
        assert_eq!((f["topic"].clone(), f["seq"].clone()), (json!("depth:MON/USDC"), json!(1)));
        assert_eq!(f["message"], json!({ "ch": "depth", "data": serde_json::from_str::<Value>(depth).unwrap() }));
        // a second viewer gets the latest curve as its snapshot, and shares the demand
        let other = LocalPeer::new(&gw, false);
        other.subscribe(json!([{ "channel": "depth", "market": "MON/USDC" }]));
        wait_for(|| other.frames().len() == 1).await;
        assert_eq!((other.frames()[0]["snapshot"].clone(), other.frames()[0]["seq"].clone()), (json!(true), json!(1)));
        assert_eq!(source.depth_watchers("MON/USDC"), 1);
        peer.subscribe(json!([]));
        other.subscribe(json!([]));
        wait_for(|| source.depth_watchers("MON/USDC") == 0).await;
    }
}
