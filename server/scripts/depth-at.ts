// Computes one market's depth curves at one block with TODAY's depth pass and
// a frozen reference (asset USD and pair mids from `mpamm-tools capture-prices`),
// and prints the snapshot as JSON: the TypeScript half of the same-block depth
// parity check (service/tools/compare-depth.py diffs it with `mpamm-tools depth-at`).
//
//   RPC_URL=http://127.0.0.1:18080 npx tsx scripts/depth-at.ts MON/USDC 125800000 prices.json poe,metric > ts.json
//
// As src/depth/worker-entry.ts computes a pass: the depth grid, a frame with a
// mid only for the requested market, each adapter's quote() narrowed to it,
// the depth client's 8 KB multicall batches, buildDepthSnapshot, and the
// missing venues. Without the deadline (parity wants every answer) and without
// the exchanges' rows (their books can't be frozen; the Rust half leaves them
// out too). ONE_CALL_PER_MULTICALL=1 sends every multicall entry as its own
// aggregate, for a Rust venue that splits a heavy multicall per read.
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { depthSizes, MARKETS, type QuoteRow } from '@shared';
import { monad } from '../src/chain/rpc.js';
import { config } from '../src/config.js';
import { buildDepthSnapshot } from '../src/depth.js';
import { UsdPricer } from '../src/pricer.js';
import { ADAPTERS } from '../src/venues/registry.js';
import type { AdapterContext } from '../src/venues/adapter.js';

const [market, blockArg, pricesFile, venuesArg] = process.argv.slice(2);
if (!market || !blockArg || !pricesFile) throw new Error('usage: depth-at.ts <market> <block> <prices.json> [venue,…]');
if (!(MARKETS as readonly string[]).includes(market)) throw new Error(`${market} is not a registered market`);
const frozen = JSON.parse(readFileSync(pricesFile, 'utf8')) as { assetUsd: Record<string, number>; pairMid: Record<string, number> };
const rpcClient = createPublicClient({ chain: monad, transport: http(process.env.RPC_URL ?? 'http://127.0.0.1:8080', { timeout: 60_000 }) });
// The depth client's default batch (an adapter's own batchSize wins), or one
// call per aggregate (batchSize 1: viem starts a new chunk whenever one would exceed it).
const oneCall = process.env.ONE_CALL_PER_MULTICALL === '1';
const client = { ...rpcClient, multicall: ((args: any) => rpcClient.multicall({ ...args, batchSize: oneCall ? 1 : args.batchSize ?? 8_192 })) as typeof rpcClient.multicall };
const wanted = venuesArg ? new Set(venuesArg.split(',')) : undefined;
const requested = new Set([market]);
const grid = depthSizes(config.depthSamples);
// The depth frame: every asset's price, a mid for the requested market only.
const pricer = new UsdPricer((a) => frozen.assetUsd[a] ?? 0, (m) => (requested.has(m) ? frozen.pairMid[m] ?? 0 : 0));
const state = new Map<string, string>();
const ctx: AdapterContext = {
  client: client as any,
  getLogs: (async () => []) as any,
  pricer,
  config,
  note: (code, msg) => console.error(`[note] ${code}: ${msg}`),
  state: { get: (k) => state.get(k), set: async (k, v) => { state.set(k, v); } },
};
const block = BigInt(blockArg);
const candidates = ADAPTERS.filter((a) => a.quote && (!wanted || a.venues().some((v) => wanted.has(v.id))));
for (const adapter of candidates) await adapter.discover(ctx);
const adapters = candidates.filter((a) => !a.quoteMarkets || a.quoteMarkets().some((m) => requested.has(m)));
const results = await Promise.all(adapters.map(async (adapter) => {
  const declared = new Set(adapter.venues().map((v) => v.id));
  const t0 = performance.now();
  try {
    const rows = await adapter.quote!(ctx, grid, block, requested);
    console.error(`${[...declared].join(',')}: ${(performance.now() - t0).toFixed(1)} ms`);
    return rows.filter((r) => declared.has(r.venueId) && requested.has(r.market));
  } catch (error) {
    console.error(`${[...declared].join(',')}: missed (${error instanceof Error ? error.message : String(error)})`);
    return [] as QuoteRow[];
  }
}));
const snapshot = buildDepthSnapshot(results.flat(), market, grid, pricer.pairMid(market), Number(block), 0);
const present = new Set(snapshot.venues.map((v) => v.venueId));
snapshot.missingVenues = adapters.filter((a) => !a.quoteMarkets || a.quoteMarkets().includes(market))
  .flatMap((a) => a.venues().map((v) => v.id)).filter((id) => !present.has(id));
console.log(JSON.stringify(snapshot));
console.error(`${market}: ${snapshot.venues.length} curve(s) at block ${blockArg}`);
process.exit(0);
