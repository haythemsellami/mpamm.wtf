//! Reading the node's ring with the execution-event SDK (Linux only).
//!
//! The SDK's zero-copy filter takes a plain `fn`, so the watch set reaches it
//! through a thread-local set by the reader thread (`set_watch`). The filter
//! runs while the payload may still be overwritten; the SDK discards the copy
//! (`Expired`) if that happened, so nothing half-read leaves this module.

use std::{
    cell::RefCell,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use monad_event_ring::{DecodedEventRing, EventNextResult, EventPayloadResult, EventReader, EventRingPath};
use monad_exec_events::{
    ffi::monad_c_uint256_ne, ExecEventDecoder, ExecEventReaderExt, ExecEventRef, ExecEventRing, ExecEventType,
};

use crate::{
    event::{BlockStart, Event, Log, TxnHeader, TxnOutput, B32},
    watch::WatchSet,
};

/// A reader over the execution ring.
pub type Reader<'ring> = EventReader<'ring, ExecEventDecoder>;

/// Where `monad-execution --exec-event-ring` writes by default.
pub const DEFAULT_RING: &str = "/var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings/monad-exec-events";

thread_local! {
    static WATCH: RefCell<Arc<WatchSet>> = RefCell::new(Arc::new(WatchSet::default()));
}

/// Sets what this thread's reads copy out of the ring. Applied from the next
/// event; callers swap it at a `BLOCK_START` so one block sees one set.
pub fn set_watch(watch: Arc<WatchSet>) {
    WATCH.with(|w| *w.borrow_mut() = watch);
}

fn u128_of(x: &monad_c_uint256_ne) -> u128 {
    if x.limbs[2] != 0 || x.limbs[3] != 0 {
        return u128::MAX;
    }
    u128::from(x.limbs[0]) | (u128::from(x.limbs[1]) << 64)
}

fn pick(event: ExecEventRef<'_>) -> Option<Event> {
    match event {
        ExecEventRef::BlockStart(s) => {
            let mut author = [0u8; 33];
            author[0] = 2 + (s.author.y_parity & 1);
            author[1..].copy_from_slice(&s.author.x.bytes);
            Some(Event::BlockStart(Box::new(BlockStart {
                id: s.block_tag.id.bytes,
                number: s.block_tag.block_number,
                round: s.round,
                epoch: s.epoch,
                // bindgen may render __uint128_t as u128 or as [u64; 2]; both
                // are 16 little-endian bytes on x86_64.
                proposal_ns: unsafe { std::mem::transmute_copy::<_, u128>(&s.proposal_epoch_nanos) },
                author,
                parent_hash: s.parent_eth_hash.bytes,
                timestamp: s.eth_block_input.timestamp,
                base_fee: u128_of(&s.eth_block_input.base_fee_per_gas),
                gas_limit: s.eth_block_input.gas_limit,
                txn_count: u32::try_from(s.eth_block_input.txn_count).unwrap_or(u32::MAX),
            })))
        }
        ExecEventRef::BlockReject(_) => Some(Event::BlockReject),
        ExecEventRef::BlockEnd(e) => {
            Some(Event::BlockEnd { hash: e.eth_block_hash.bytes, gas_used: e.exec_output.gas_used })
        }
        ExecEventRef::BlockQC(q) => Some(Event::Qc { id: q.block_tag.id.bytes, number: q.block_tag.block_number }),
        ExecEventRef::BlockFinalized(f) => Some(Event::Finalized { id: f.id.bytes, number: f.block_number }),
        ExecEventRef::BlockVerified(v) => Some(Event::Verified { number: v.block_number }),
        ExecEventRef::TxnHeaderStart { txn_index, txn_header_start: h, data_bytes, .. } => WATCH.with(|w| {
            let w = w.borrow();
            if !w.txn_headers {
                return None;
            }
            let to = (!h.txn_header.is_contract_creation).then_some(h.txn_header.to.bytes);
            Some(Event::TxnHeader(Box::new(TxnHeader {
                index: u32::try_from(txn_index).ok()?,
                hash: h.txn_hash.bytes,
                sender: h.sender.bytes,
                to,
                kind: h.txn_header.txn_type,
                gas_limit: h.txn_header.gas_limit,
                max_fee_per_gas: u128_of(&h.txn_header.max_fee_per_gas),
                max_priority_fee_per_gas: u128_of(&h.txn_header.max_priority_fee_per_gas),
                input: if w.wants_input(to.as_ref()) { data_bytes.to_vec() } else { Vec::new() },
            })))
        }),
        ExecEventRef::TxnReject { txn_index, .. } => Some(Event::TxnReject { index: u32::try_from(txn_index).ok()? }),
        ExecEventRef::TxnEvmOutput { txn_index, output } => Some(Event::TxnOutput(TxnOutput {
            index: u32::try_from(txn_index).ok()?,
            status: output.receipt.status,
            log_count: output.receipt.log_count,
            gas_used: output.receipt.gas_used,
        })),
        ExecEventRef::TxnLog { txn_index, txn_log, topic_bytes, data_bytes } => {
            let topic0: Option<&B32> = topic_bytes.get(..32).and_then(|t| t.try_into().ok());
            if !WATCH.with(|w| w.borrow().wants_log(&txn_log.address.bytes, topic0)) {
                return None;
            }
            let topics = topic_bytes.as_chunks::<32>().0.to_vec();
            Some(Event::Log(Box::new(Log {
                txn_index: u32::try_from(txn_index).ok()?,
                index_in_txn: txn_log.index,
                address: txn_log.address.bytes,
                topics,
                data: data_bytes.to_vec(),
            })))
        }
        ExecEventRef::RecordError(_) => Some(Event::RecordError),
        _ => None,
    }
}

/// One step of the reader.
#[derive(Debug)]
pub enum Polled {
    /// A watched event, with its sequence number and this host's record time.
    Event { seqno: u64, t_ns: u64, event: Event },
    /// An event the watch set skips.
    Skipped { seqno: u64 },
    /// The reader fell behind the writer: events were lost. The reader has
    /// been reset to the newest event.
    Gap,
    /// A payload was overwritten while it was being read: the same as a gap.
    Expired { seqno: u64 },
    /// Nothing new yet.
    Idle,
}

/// Reads the next event. On a gap or an expired payload the reader is reset
/// to the writer's newest event and the caller must treat in-flight state as
/// incomplete.
pub fn poll(reader: &mut Reader<'_>) -> Polled {
    match reader.next_descriptor() {
        EventNextResult::Gap => {
            reader.reset();
            Polled::Gap
        }
        EventNextResult::NotReady => Polled::Idle,
        EventNextResult::Ready(desc) => {
            let info = desc.info();
            match desc.try_filter_map(pick) {
                EventPayloadResult::Expired => {
                    reader.reset();
                    Polled::Expired { seqno: info.seqno }
                }
                EventPayloadResult::Ready(Some(event)) => {
                    Polled::Event { seqno: info.seqno, t_ns: info.record_epoch_nanos, event }
                }
                EventPayloadResult::Ready(None) => Polled::Skipped { seqno: info.seqno },
            }
        }
    }
}

/// An open ring and the identity of the file it maps, so a node restart that
/// recreates the file is noticed.
pub struct Ring {
    pub path: EventRingPath,
    pub ring: ExecEventRing,
    pub file: PathBuf,
    inode: u64,
}

impl Ring {
    pub fn open(file: &Path) -> Result<Self, String> {
        let path = EventRingPath::resolve(file)?;
        let ring = ExecEventRing::new(&path)?;
        let inode = std::fs::metadata(file).map(|m| m.ino()).map_err(|e| format!("stat {}: {e}", file.display()))?;
        Ok(Self { path, ring, file: file.to_path_buf(), inode })
    }

    /// Whether the file at the ring's path is no longer the one mapped (the
    /// node recreated it, or it is gone).
    pub fn replaced(&self) -> bool {
        std::fs::metadata(&self.file).map(|m| m.ino() != self.inode).unwrap_or(true)
    }

    /// A reader at the start of the newest block (a live reader begins at the
    /// newest event, usually mid-block).
    pub fn reader_at_newest_block(&self) -> Reader<'_> {
        let mut reader = self.ring.create_reader();
        reader.consensus_prev(Some(ExecEventType::BlockStart));
        reader
    }

    /// A reader positioned to replay from before `height`: at the latest
    /// `BLOCK_START` three heights below, which precedes every proposal at
    /// `height` (heights below a final one are never re-proposed). `None` if
    /// that block has left the ring.
    pub fn reader_before(&self, height: u64) -> Option<Reader<'_>> {
        let mut reader = self.ring.create_reader();
        reader.block_number_prev(height.saturating_sub(3), Some(ExecEventType::BlockStart))?;
        Some(reader)
    }

    /// A reader at the oldest `BLOCK_START` still in the ring.
    pub fn reader_at_oldest(&self, newest: u64) -> Option<(Reader<'_>, u64)> {
        let (oldest, _) = self.oldest_block(newest)?;
        let mut reader = self.ring.create_reader();
        reader.block_number_prev(oldest, Some(ExecEventType::BlockStart))?;
        Some((reader, oldest))
    }

    /// The number of the newest block that has started executing.
    pub fn newest_block(&self) -> Option<u64> {
        let mut reader = self.ring.create_reader();
        let desc = reader.consensus_prev(Some(ExecEventType::BlockStart))?;
        match desc.try_filter_map(pick) {
            EventPayloadResult::Ready(Some(Event::BlockStart(s))) => Some(s.number),
            _ => None,
        }
    }

    /// The oldest block whose `BLOCK_START` is still in the ring and its
    /// record time, by binary search (absent below it, present above).
    pub fn oldest_block(&self, newest: u64) -> Option<(u64, u64)> {
        let probe = |n: u64| -> Option<u64> {
            let mut reader = self.ring.create_reader();
            reader.block_number_prev(n, Some(ExecEventType::BlockStart)).map(|d| d.info().record_epoch_nanos)
        };
        let mut hi = newest;
        let mut hi_ns = probe(hi)?;
        let mut lo = newest.saturating_sub(4_000_000);
        if let Some(ns) = probe(lo) {
            return Some((lo, ns));
        }
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            match probe(mid) {
                Some(ns) => {
                    hi = mid;
                    hi_ns = ns;
                }
                None => lo = mid,
            }
        }
        Some((hi, hi_ns))
    }

    /// The ring header's fixed fields: capacity, payload buffer size and the
    /// writer's last sequence number.
    pub fn header(&self) -> Option<Header> {
        read_header(&self.path)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Header {
    pub descriptor_capacity: u64,
    pub payload_buf_bytes: u64,
    pub last_seqno: u64,
}

/// The header layout (category/core/event/event_ring.h): magic[6], content
/// type u16, schema hash[32], then descriptor capacity, payload buffer size
/// and context size (u64 each), then the writer's control block, 64-byte
/// aligned, whose first field is the last allocated sequence number.
fn read_header(path: &EventRingPath) -> Option<Header> {
    let mut buf = [0u8; 72];
    path.open().ok()?.read_exact(&mut buf).ok()?;
    if &buf[0..4] != b"RING" {
        return None;
    }
    let u64_at = |o: usize| u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
    Some(Header { descriptor_capacity: u64_at(40), payload_buf_bytes: u64_at(48), last_seqno: u64_at(64) })
}
