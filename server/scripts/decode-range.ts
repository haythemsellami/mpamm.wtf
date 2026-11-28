// Decodes one venue's fills over a block range with TODAY's adapter and
// prints them as JSON (sorted by id): the TypeScript half of the decode
// parity check for the Rust port (service/tools: `mpamm-tools decode-range`;
// service/tools/compare-fills.py diffs the two).
//
//   RPC_URL=http://127.0.0.1:18080 npx tsx scripts/decode-range.ts poe 125000000 125010000 > ts.json
//
// LIVE_PRICES_SECS=10 starts the exchange feeds first, so crypto-quoted fills
// get live USD.
import { createPublicClient, http } from 'viem';
import { monad } from '../src/chain/rpc.js';
import { config } from '../src/config.js';
import { UsdPricer } from '../src/pricer.js';
import { ADAPTERS, REFERENCES } from '../src/venues/registry.js';
import type { AdapterContext, LogBundle } from '../src/venues/adapter.js';

const [venueId, fromArg, toArg] = process.argv.slice(2);
if (!venueId || !fromArg || !toArg) throw new Error('usage: decode-range.ts <venue> <from> <to>');
const from = BigInt(fromArg), to = BigInt(toArg);
const chunk = BigInt(process.env.CHUNK ?? '1000');
const client = createPublicClient({ chain: monad, transport: http(process.env.RPC_URL ?? 'http://127.0.0.1:8080', { batch: true, timeout: 60_000 }) });

const adapter = ADAPTERS.find((a) => a.venues().some((v) => v.id === venueId));
if (!adapter) throw new Error(`no adapter for ${venueId}`);

const liveSecs = Number(process.env.LIVE_PRICES_SECS ?? '0');
if (liveSecs > 0) {
  await REFERENCES.start();
  await new Promise((r) => setTimeout(r, liveSecs * 1000));
}
const pricer = new UsdPricer((b) => REFERENCES.assetUsd(b), (m) => REFERENCES.midForPair(m), (b) => REFERENCES.settledUsd(b));
const state = new Map<string, string>();
const ctx: AdapterContext = {
  client: client as any,
  getLogs: (async (params: any) => {
    const out: unknown[] = [];
    for (let s = params.fromBlock as bigint; s <= params.toBlock; s += chunk) {
      const e = s + chunk - 1n > params.toBlock ? params.toBlock : s + chunk - 1n;
      out.push(...await client.getLogs({ address: params.address, events: params.events, fromBlock: s, toBlock: e } as any));
    }
    return out;
  }) as any,
  pricer,
  config,
  note: (code, msg) => console.error(`[note] ${code}: ${msg}`),
  state: { get: (k) => state.get(k), set: async (k, v) => { state.set(k, v); } },
};

await adapter.discover(ctx);
const bundle: LogBundle = {};
for (const s of adapter.logSources()) {
  bundle[s.key] = await ctx.getLogs({ address: s.address, events: s.events, fromBlock: from, toBlock: to } as any) as any[];
}
const blockTs = new Map<bigint, number>();
for (const logs of Object.values(bundle)) {
  for (const l of logs) blockTs.set(BigInt(l.blockNumber), 0);
}
for (const bn of blockTs.keys()) blockTs.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp) * 1000);
const fills = await adapter.decode(ctx, bundle, (bn) => blockTs.get(BigInt(bn)) ?? 0, new Set());
fills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
console.log(JSON.stringify(fills.map((f) => ({
  id: f.id, market: f.market, side: f.side, category: f.category, usd: f.usd, baseAmount: f.baseAmount, execPx: f.execPx,
  pxApprox: f.pxApprox ?? false, pool: f.pool, to: f.to, router: f.router ?? null, blockNumber: f.blockNumber,
}))));
console.error(`${venueId}: ${fills.length} fill(s)`);
process.exit(0);
