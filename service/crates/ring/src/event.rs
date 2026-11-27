//! The service's own event model: the few fields it needs from each ring
//! event, copied out of shared memory. Nothing here depends on the SDK, so
//! block assembly and everything downstream builds and tests on any platform;
//! only `sdk.rs` (Linux) reads the ring itself.

/// A 32-byte hash or id.
pub type B32 = [u8; 32];
/// A 20-byte account address.
pub type Addr = [u8; 20];

/// `BLOCK_START`: a proposal begins executing. Before finalization a block is
/// known by `id`; `number` is the height it will have if it wins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockStart {
    pub id: B32,
    pub number: u64,
    pub round: u64,
    pub epoch: u64,
    /// When the proposer proposed it, on the proposer's clock (ns since 1970).
    pub proposal_ns: u128,
    /// The proposer's key, SEC1-compressed.
    pub author: [u8; 33],
    /// Ethereum hash of the parent block: links a height to the one below it
    /// when a finalization event was lost.
    pub parent_hash: B32,
    /// Block timestamp, seconds.
    pub timestamp: u64,
    pub base_fee: u128,
    pub gas_limit: u64,
    pub txn_count: u32,
}

/// `TXN_HEADER_START` for one transaction. `input` is copied only for
/// transactions sent to a watched address (gas destinations and relays).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxnHeader {
    pub index: u32,
    pub hash: B32,
    pub sender: Addr,
    /// `None` for a contract creation.
    pub to: Option<Addr>,
    /// EIP-2718 type: 0 legacy, 1 access list, 2 EIP-1559, 3 blob, 4 EIP-7702.
    pub kind: u8,
    pub gas_limit: u64,
    /// `gasPrice` for types 0 and 1, the fee cap otherwise.
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub input: Vec<u8>,
}

/// `TXN_EVM_OUTPUT`: the receipt of one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TxnOutput {
    pub index: u32,
    pub status: bool,
    pub log_count: u32,
    pub gas_used: u64,
}

/// `TXN_LOG` from a watched (address, topic0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Log {
    pub txn_index: u32,
    /// The ring's index counts within the transaction; the block-level index
    /// (what RPC calls `logIndex`) is computed at `BLOCK_END`.
    pub index_in_txn: u32,
    pub address: Addr,
    pub topics: Vec<B32>,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    BlockStart(Box<BlockStart>),
    /// The proposal is invalid; it produces no `BLOCK_END`.
    BlockReject,
    BlockEnd {
        hash: B32,
        gas_used: u64,
    },
    Qc {
        id: B32,
        number: u64,
    },
    Finalized {
        id: B32,
        number: u64,
    },
    Verified {
        number: u64,
    },
    TxnHeader(Box<TxnHeader>),
    TxnReject {
        index: u32,
    },
    TxnOutput(TxnOutput),
    Log(Box<Log>),
    /// The writer could not record an event in full: the block being
    /// executed is incomplete and must be read over RPC instead.
    RecordError,
}

/// Lower-case hex without a prefix.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}
