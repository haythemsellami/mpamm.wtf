// Quotes one venue at one block with TODAY's adapter and a frozen reference
// (asset USD and pair mids from `mpamm-tools capture-prices`), and prints the
// rows as JSON: the TypeScript half of the same-block quote parity check
// (service/tools/compare-quotes.py diffs it with `mpamm-tools quote-at`).
//
//   RPC_URL=http://127.0.0.1:18080 npx tsx scripts/quote-at.ts poe 125800000 prices.json > ts.json
//
// ONE_CALL_PER_MULTICALL=1 sends every multicall entry as its own aggregate.
// The adapter is untouched; only the grouping changes. A Rust venue that
// splits a heavy multicall into one call per read is compared against this:
// grouped, a leg can fail because a heavy neighbour spent the aggregate's
// gas (the node caps eth_call at 30M), not because of its own state.
//
// PIN_HEAD=1 makes the chain head the quoted block, so discovery reads the
// same block the quote does. Lunarbase needs it for any block but the head:
// its quote discards a frame older than the snapshot discovery cached, so a
// past block otherwise always quotes nothing.
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { SIZES_USD } from '@shared';
import { monad } from '../src/chain/rpc.js';
import { config } from '../src/config.js';
import { UsdPricer } from '../src/pricer.js';
import { ADAPTERS } from '../src/venues/registry.js';
import type { AdapterContext } from '../src/venues/adapter.js';

const [venueId, blockArg, pricesFile] = process.argv.slice(2);
if (!venueId || !blockArg || !pricesFile) throw new Error('usage: quote-at.ts <venue> <block> <prices.json>');
const frozen = JSON.parse(readFileSync(pricesFile, 'utf8')) as { assetUsd: Record<string, number>; pairMid: Record<string, number> };
const rpcClient = createPublicClient({ chain: monad, transport: http(process.env.RPC_URL ?? 'http://127.0.0.1:8080', { timeout: 60_000 }) });
// batchSize 1: viem starts a new chunk whenever one would exceed it.
const grouped = process.env.ONE_CALL_PER_MULTICALL === '1'
  ? { ...rpcClient, multicall: ((args: any) => rpcClient.multicall({ ...args, batchSize: 1 })) as typeof rpcClient.multicall }
  : rpcClient;
const client = process.env.PIN_HEAD === '1' ? { ...grouped, getBlockNumber: async () => BigInt(blockArg) } : grouped;
const adapter = ADAPTERS.find((a) => a.venues().some((v) => v.id === venueId));
if (!adapter?.quote) throw new Error(`no quoting adapter for ${venueId}`);
const pricer = new UsdPricer((a) => frozen.assetUsd[a] ?? 0, (m) => frozen.pairMid[m] ?? 0, (a) => frozen.assetUsd[a] ?? 0);
const state = new Map<string, string>();
const ctx: AdapterContext = {
  client: client as any,
  getLogs: (async () => []) as any,
  pricer,
  config,
  note: (code, msg) => console.error(`[note] ${code}: ${msg}`),
  state: { get: (k) => state.get(k), set: async (k, v) => { state.set(k, v); } },
};
await adapter.discover(ctx);
const rows = await adapter.quote(ctx, SIZES_USD, BigInt(blockArg));
rows.sort((a, b) => (a.venueId + a.market + String(a.sizeUsd).padStart(8)).localeCompare(b.venueId + b.market + String(b.sizeUsd).padStart(8)));
console.log(JSON.stringify(rows));
console.error(`${venueId}: ${rows.length} row(s) at block ${blockArg}`);
process.exit(0);
