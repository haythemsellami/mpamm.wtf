//! A final block in one shape, whichever way it was read. The ring and RPC
//! must produce identical blocks for the same height (the proposal time is
//! the one field only the ring has); `tests` and the host check hold them to
//! that.

use mpamm_chain::{parse_b32, parse_quantity, parse_quantity_u128, RpcError};
use mpamm_registry::parse_address;
use mpamm_ring::{Addr, Block, WatchSet, B32};
use serde_json::Value;

/// Where a block's data came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    Ring,
    /// Read over RPC from the named client (`local`, `archive`).
    Rpc(String),
}

/// A transaction header, for gas and attribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalTxn {
    pub index: u32,
    pub hash: B32,
    pub from: Addr,
    pub to: Option<Addr>,
    pub kind: u8,
    pub gas_limit: u64,
    /// `gasPrice` for types 0 and 1, the fee cap otherwise.
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    /// Calldata, only for transactions to a watched address.
    pub input: Vec<u8>,
}

impl FinalTxn {
    /// What the transaction paid per gas: `gasPrice` for legacy and
    /// access-list transactions, min(fee cap, base fee + tip) otherwise.
    pub fn price_paid(&self, base_fee: u128) -> u128 {
        match self.kind {
            0 | 1 => self.max_fee_per_gas,
            _ => self.max_fee_per_gas.min(base_fee.saturating_add(self.max_priority_fee_per_gas)),
        }
    }

    /// Monad charges the gas limit, not the gas used.
    pub fn cost_wei(&self, base_fee: u128) -> u128 {
        u128::from(self.gas_limit).saturating_mul(self.price_paid(base_fee))
    }
}

/// A watched log, with its block-level index (RPC's `logIndex`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalLog {
    pub log_index: u32,
    pub txn_index: u32,
    pub tx_hash: B32,
    pub address: Addr,
    pub topics: Vec<B32>,
    pub data: Vec<u8>,
}

impl FinalLog {
    pub fn topic0(&self) -> Option<&B32> {
        self.topics.first()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalBlock {
    pub number: u64,
    pub hash: B32,
    pub parent_hash: B32,
    /// Seconds.
    pub timestamp: u64,
    /// The proposer's proposal time; `None` when read over RPC (headers carry
    /// seconds only).
    pub proposal_ns: Option<u128>,
    pub base_fee: u128,
    /// Every transaction, in index order.
    pub txns: Vec<FinalTxn>,
    /// Watched logs, in block order.
    pub logs: Vec<FinalLog>,
    pub origin: Origin,
}

impl FinalBlock {
    /// A complete block from the tracker (headers required).
    pub fn from_ring(b: &Block) -> Option<Self> {
        let end = b.end?;
        let txns = b
            .txns
            .iter()
            .enumerate()
            .filter(|(_, t)| !t.rejected)
            .map(|(i, t)| {
                let h = t.header.as_ref()?;
                Some(FinalTxn {
                    index: i as u32,
                    hash: h.hash,
                    from: h.sender,
                    to: h.to,
                    kind: h.kind,
                    gas_limit: h.gas_limit,
                    max_fee_per_gas: h.max_fee_per_gas,
                    max_priority_fee_per_gas: h.max_priority_fee_per_gas,
                    input: h.input.clone(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let logs = b
            .logs
            .iter()
            .zip(&b.log_index)
            .map(|(l, idx)| {
                Some(FinalLog {
                    log_index: *idx,
                    txn_index: l.txn_index,
                    tx_hash: b.txns.get(l.txn_index as usize)?.header.as_ref()?.hash,
                    address: l.address,
                    topics: l.topics.clone(),
                    data: l.data.clone(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            number: b.start.number,
            hash: end.hash,
            parent_hash: b.start.parent_hash,
            timestamp: b.start.timestamp,
            proposal_ns: Some(b.start.proposal_ns),
            base_fee: b.start.base_fee,
            txns,
            logs,
            origin: Origin::Ring,
        })
    }

    /// From `eth_getBlockByNumber(n, true)` and `eth_getLogs` for that block,
    /// keeping what `watch` keeps.
    pub fn from_rpc(block: &Value, logs: &Value, watch: &WatchSet, label: &str) -> Result<Self, RpcError> {
        let bad = |what: &str| RpcError::Decode(format!("block {what}"));
        let number = parse_quantity(&block["number"]).ok_or_else(|| bad("number"))?;
        let hash = parse_b32(&block["hash"]).ok_or_else(|| bad("hash"))?;
        let mut txns = Vec::new();
        for t in block["transactions"].as_array().ok_or_else(|| bad("transactions"))? {
            let kind = parse_quantity(&t["type"]).unwrap_or(0) as u8;
            let to = match &t["to"] {
                Value::Null => None,
                v => Some(parse_address(v.as_str().unwrap_or("")).ok_or_else(|| bad("tx to"))?),
            };
            let (max_fee, tip) = if kind <= 1 {
                (parse_quantity_u128(&t["gasPrice"]).ok_or_else(|| bad("gasPrice"))?, 0)
            } else {
                (
                    parse_quantity_u128(&t["maxFeePerGas"]).ok_or_else(|| bad("maxFeePerGas"))?,
                    parse_quantity_u128(&t["maxPriorityFeePerGas"]).ok_or_else(|| bad("maxPriorityFeePerGas"))?,
                )
            };
            let input = if watch.wants_input(to.as_ref()) {
                hex_bytes(t["input"].as_str().unwrap_or("0x")).ok_or_else(|| bad("input"))?
            } else {
                Vec::new()
            };
            txns.push(FinalTxn {
                index: parse_quantity(&t["transactionIndex"]).ok_or_else(|| bad("transactionIndex"))? as u32,
                hash: parse_b32(&t["hash"]).ok_or_else(|| bad("tx hash"))?,
                from: parse_address(t["from"].as_str().unwrap_or("")).ok_or_else(|| bad("from"))?,
                to,
                kind,
                gas_limit: parse_quantity(&t["gas"]).ok_or_else(|| bad("gas"))?,
                max_fee_per_gas: max_fee,
                max_priority_fee_per_gas: tip,
                input,
            });
        }
        txns.sort_by_key(|t| t.index);
        let mut out_logs = Vec::new();
        for l in logs.as_array().ok_or_else(|| bad("logs"))? {
            if l["blockHash"] != block["hash"] {
                return Err(bad("log from another block"));
            }
            let address = parse_address(l["address"].as_str().unwrap_or("")).ok_or_else(|| bad("log address"))?;
            let topics = l["topics"]
                .as_array()
                .ok_or_else(|| bad("topics"))?
                .iter()
                .map(parse_b32)
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| bad("topic"))?;
            if !watch.wants_log(&address, topics.first()) {
                continue;
            }
            out_logs.push(FinalLog {
                log_index: parse_quantity(&l["logIndex"]).ok_or_else(|| bad("logIndex"))? as u32,
                txn_index: parse_quantity(&l["transactionIndex"]).ok_or_else(|| bad("log txIndex"))? as u32,
                tx_hash: parse_b32(&l["transactionHash"]).ok_or_else(|| bad("log txHash"))?,
                address,
                topics,
                data: hex_bytes(l["data"].as_str().unwrap_or("0x")).ok_or_else(|| bad("log data"))?,
            });
        }
        out_logs.sort_by_key(|l| l.log_index);
        Ok(Self {
            number,
            hash,
            parent_hash: parse_b32(&block["parentHash"]).ok_or_else(|| bad("parentHash"))?,
            timestamp: parse_quantity(&block["timestamp"]).ok_or_else(|| bad("timestamp"))?,
            proposal_ns: None,
            base_fee: parse_quantity_u128(&block["baseFeePerGas"]).unwrap_or(0),
            txns,
            logs: out_logs,
            origin: Origin::Rpc(label.to_string()),
        })
    }

    /// The block's time in epoch ms: the proposal time when known, else the
    /// block second.
    pub fn time_ms(&self) -> f64 {
        match self.proposal_ns {
            Some(ns) => ns as f64 / 1e6,
            None => self.timestamp as f64 * 1000.0,
        }
    }

    pub fn txn(&self, index: u32) -> Option<&FinalTxn> {
        self.txns.binary_search_by_key(&index, |t| t.index).ok().map(|i| &self.txns[i])
    }
}

/// `0x`-hex to bytes.
pub fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    let h = s.strip_prefix("0x")?;
    if h.len() % 2 != 0 {
        return None;
    }
    h.as_bytes().chunks(2).map(|c| u8::from_str_radix(std::str::from_utf8(c).ok()?, 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use mpamm_ring::{Config, Event, Log, Output, Tracker, TxnHeader, TxnOutput};
    use serde_json::json;

    use super::*;

    fn b32(x: u8) -> String {
        format!("0x{}", format!("{x:02x}").repeat(32))
    }
    fn addr(x: u8) -> String {
        format!("0x{}", format!("{x:02x}").repeat(20))
    }

    /// The same block (2 transactions, one legacy and one EIP-1559; 3 logs of
    /// which 2 are watched) through the ring and through RPC.
    #[test]
    fn ring_and_rpc_give_the_same_block() {
        let mut watch = WatchSet::default();
        watch.logs.insert([0xaa; 20], mpamm_ring::TopicFilter::Any);
        watch.txn_input.insert([0xbb; 20]);
        watch.txn_headers = true;

        let mut t = Tracker::new(Config { require_headers: true, ..Config::default() }, None);
        t.handle(
            Event::BlockStart(Box::new(mpamm_ring::BlockStart {
                id: [9; 32],
                number: 50,
                round: 1,
                epoch: 1,
                proposal_ns: 1_795_762_412_123_456_789,
                author: [2; 33],
                parent_hash: [0x49; 32],
                timestamp: 1_795_762_412,
                base_fee: 100,
                gas_limit: 1,
                txn_count: 2,
            })),
            0,
        );
        for (i, to, kind, fee, tip, input) in
            [(0u32, 0xbbu8, 0u8, 300u128, 0u128, vec![1, 2, 3]), (1, 0xcc, 2, 500, 7, vec![])]
        {
            t.handle(
                Event::TxnHeader(Box::new(TxnHeader {
                    index: i,
                    hash: [0x10 + i as u8; 32],
                    sender: [0x20 + i as u8; 20],
                    to: Some([to; 20]),
                    kind,
                    gas_limit: 50_000,
                    max_fee_per_gas: fee,
                    max_priority_fee_per_gas: tip,
                    input,
                })),
                0,
            );
        }
        t.handle(Event::TxnOutput(TxnOutput { index: 0, status: true, log_count: 2, gas_used: 1 }), 0);
        t.handle(Event::TxnOutput(TxnOutput { index: 1, status: true, log_count: 1, gas_used: 1 }), 0);
        for (txn, idx) in [(0u32, 1u32), (1, 0)] {
            t.handle(
                Event::Log(Box::new(Log {
                    txn_index: txn,
                    index_in_txn: idx,
                    address: [0xaa; 20],
                    topics: vec![[0x77; 32]],
                    data: vec![idx as u8],
                })),
                0,
            );
        }
        t.handle(Event::BlockEnd { hash: [0x50; 32], gas_used: 1 }, 1);
        t.handle(Event::Finalized { id: [9; 32], number: 50 }, 2);
        let ring = t
            .take()
            .into_iter()
            .find_map(|o| if let Output::Final(b) = o { FinalBlock::from_ring(&b) } else { None })
            .unwrap();

        let block = json!({
            "number": "0x32", "hash": b32(0x50), "parentHash": b32(0x49), "timestamp": "0x6b0928ec",
            "baseFeePerGas": "0x64",
            "transactions": [
                { "transactionIndex": "0x1", "hash": b32(0x11), "from": addr(0x21), "to": addr(0xcc), "type": "0x2",
                  "gas": "0xc350", "gasPrice": "0x6b", "maxFeePerGas": "0x1f4", "maxPriorityFeePerGas": "0x7", "input": "0x09" },
                { "transactionIndex": "0x0", "hash": b32(0x10), "from": addr(0x20), "to": addr(0xbb), "type": "0x0",
                  "gas": "0xc350", "gasPrice": "0x12c", "input": "0x010203" },
            ]
        });
        let logs = json!([
            { "blockHash": b32(0x50), "logIndex": "0x0", "transactionIndex": "0x0", "transactionHash": b32(0x10),
              "address": addr(0xdd), "topics": [b32(0x77)], "data": "0x" },
            { "blockHash": b32(0x50), "logIndex": "0x2", "transactionIndex": "0x1", "transactionHash": b32(0x11),
              "address": addr(0xaa), "topics": [b32(0x77)], "data": "0x00" },
            { "blockHash": b32(0x50), "logIndex": "0x1", "transactionIndex": "0x0", "transactionHash": b32(0x10),
              "address": addr(0xaa), "topics": [b32(0x77)], "data": "0x01" },
        ]);
        let rpc = FinalBlock::from_rpc(&block, &logs, &watch, "local").unwrap();

        let strip = |mut b: FinalBlock| {
            b.proposal_ns = None;
            b.origin = Origin::Ring;
            b
        };
        assert_eq!(strip(rpc.clone()), strip(ring.clone()));
        assert_eq!(ring.logs.iter().map(|l| l.log_index).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(ring.txns[0].input, vec![1, 2, 3], "calldata kept for a watched `to`");
        assert!(ring.txns[1].input.is_empty());
        assert_eq!(ring.time_ms(), 1_795_762_412_123.456_8);
        assert_eq!(rpc.time_ms(), 1_795_762_412_000.0);
        // Gas: legacy pays gasPrice; EIP-1559 pays min(cap, base + tip).
        assert_eq!(ring.txns[0].cost_wei(100), 50_000 * 300);
        assert_eq!(ring.txns[1].cost_wei(100), 50_000 * 107);
        assert_eq!(ring.txns[1].cost_wei(495), 50_000 * 500);
        assert_eq!(ring.txn(1).unwrap().hash, [0x11; 32]);
    }

    #[test]
    fn rpc_rejects_logs_of_another_block() {
        let block =
            json!({ "number": "0x1", "hash": b32(1), "parentHash": b32(0), "timestamp": "0x1", "transactions": [] });
        let logs = json!([{ "blockHash": b32(2), "logIndex": "0x0", "transactionIndex": "0x0", "transactionHash": b32(3),
                            "address": addr(1), "topics": [], "data": "0x" }]);
        let w = WatchSet { all_logs: true, ..WatchSet::default() };
        assert!(FinalBlock::from_rpc(&block, &logs, &w, "local").is_err());
        assert_eq!(hex_bytes("0x0a0b"), Some(vec![10, 11]));
        assert_eq!(hex_bytes("0x0"), None);
    }
}
