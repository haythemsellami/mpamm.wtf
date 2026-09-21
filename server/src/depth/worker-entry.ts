import { ASSETS, depthSizes, MARKETS, type QuoteRow } from '@shared';
import { QuoteRunner } from '../quote-runner.js';
import { DepthScheduler, type DepthHead } from './scheduler.js';
import {
  getLogsChunked, headClient, probeChain, publicClient, scopedDepthClient, resolveQuoteBlock, hotHeadEndpoint, rpcGeneration,
} from '../chain/rpc.js';
import { HotHeadWatcher } from '../chain/heads.js';
import { config } from '../config.js';
import { buildDepthSnapshot } from '../depth.js';
import { UsdPricer } from '../pricer.js';
import { ADAPTERS, REFERENCES, validateRegistry } from '../venues/registry.js';
import type { AdapterContext, VenueAdapter } from '../venues/adapter.js';
import type { DepthWorkerRequest, DepthWorkerResponse } from './protocol.js';

const active = new Set<string>();
const runner = new QuoteRunner();
const contexts = new WeakMap<VenueAdapter, AdapterContext>();
const grid = depthSizes(config.depthSamples);
let ready = false;
let stopped = false;
let lastWarning = '';
let lastWarningAt = 0;

const send = (message: DepthWorkerResponse): void => {
  if (process.connected && process.send) process.send(message);
};
const warn = (message: string): void => {
  const now = Date.now();
  if (message === lastWarning && now - lastWarningAt < 30_000) return;
  lastWarning = message;
  lastWarningAt = now;
  send({ type: 'status', level: 'warn', message });
};

function ctxFor(adapter: VenueAdapter, pricer: UsdPricer): AdapterContext {
  let base = contexts.get(adapter);
  if (!base) {
    base = {
      client: { ...publicClient, getBlockNumber: headClient.getBlockNumber },
      getLogs: getLogsChunked,
      pricer,
      config,
      // Depth health must never compete with the realtime quote note lifecycle.
      // Worker failures are surfaced as worker status; an adapter that fails a
      // pass is honestly absent from that completed snapshot.
      note: () => {},
    };
    contexts.set(adapter, base);
  }
  return { ...base, pricer };
}

function captureReference(markets: Set<string>): { pricer: UsdPricer; rows: QuoteRow[]; mids: Map<string, number> } {
  const assetPrices = new Map(Object.keys(ASSETS).map((key) => [key, REFERENCES.assetUsd(key)]));
  const mids = new Map([...markets].map((market) => [market, REFERENCES.midForPair(market)]));
  const pricer = new UsdPricer((key) => assetPrices.get(key) ?? 0, (pair) => mids.get(pair) ?? 0);
  return { pricer, rows: REFERENCES.quote(grid, markets), mids };
}

async function compute(markets: string[], head: DepthHead): Promise<void> {
  const startedAt = Date.now();
  const requested = new Set(markets);
  const { pricer, rows: referenceRows, mids } = captureReference(requested);
  const pinned = await resolveQuoteBlock(head.number, head.identity);
  if (!watcher.rememberResolved(head.number, pinned)) return;
  const adapters = ADAPTERS.filter((adapter) => adapter.quote
    && (!adapter.quoteMarkets || adapter.quoteMarkets().some((market) => requested.has(market))));
  const completed = new Set<VenueAdapter>();
  const results = await Promise.all(adapters.map(async (adapter) => {
    const declared = new Set(adapter.venues().map((venue) => venue.id));
    try {
      const rows = await runner.run([...declared].join(','), config.quoteDeadlineMs, async (signal) => {
        const rows = await adapter.quote!({ ...ctxFor(adapter, pricer), quoteSignal: signal,
          client: scopedDepthClient(`depth-${[...declared].join('-')}-${head.number}`, signal, pinned) }, grid, head.number, requested);
        signal.throwIfAborted();
        completed.add(adapter);
        return rows.filter((row) => declared.has(row.venueId) && requested.has(row.market));
      }, [] as QuoteRow[]);
      return rows;
    } catch { return [] as QuoteRow[]; }
  }));
  if (stopped || !watcher.isCurrent(head.number, pinned) || pinned.generation !== rpcGeneration()) return;
  const rows = [...results.flat(), ...referenceRows];
  const ts = Date.now();
  for (const market of markets) {
    if (!active.has(market)) continue;
    const snapshot = buildDepthSnapshot(rows, market, grid, mids.get(market) ?? 0, Number(head.number), ts);
    snapshot.blockHash = pinned.hash;
    if (pinned.revision) snapshot.revision = pinned.revision;
    const present = new Set(snapshot.venues.map((venue) => venue.venueId));
    snapshot.missingVenues = adapters.filter((adapter) => !adapter.quoteMarkets || adapter.quoteMarkets().includes(market))
      .flatMap((adapter) => adapter.venues().map((venue) => venue.id)).filter((id) => !present.has(id));
    send({ type: 'publication', publication: { market, asOfBlock: snapshot.asOfBlock, ts, json: JSON.stringify(snapshot),
      headObservedAt: head.observedAt, computeMs: Date.now() - startedAt,
      incompleteVenues: adapters.filter((adapter) => !completed.has(adapter)).flatMap((adapter) => adapter.venues().map((venue) => venue.id)) } });
  }
  lastWarning = '';
}

const scheduler = new DepthScheduler(compute, config.depthMinIntervalMs, () => warn('depth pass unavailable; waiting for the next observed block'));
const watcher = new HotHeadWatcher(headClient, { endpoint: hotHeadEndpoint, pollMs: config.headPollMs });

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  watcher.stop();
  scheduler.stop();
  runner.stop();
  REFERENCES.stop();
  if (process.connected) process.disconnect();
  // The worker owns no persistent state. Exit explicitly so a stop received
  // during REST warm-up/discovery cannot leave a late-created socket or timer
  // keeping an otherwise idle child alive.
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(process.exitCode ?? 0);
}

process.on('message', (raw) => {
  const message = raw as DepthWorkerRequest;
  if (message.type === 'stop') { void shutdown(); return; }
  if (!(MARKETS as readonly string[]).includes(message.market)) return;
  if (message.type === 'subscribe') {
    active.add(message.market);
    if (ready) scheduler.demand(message.market, true);
  } else {
    active.delete(message.market);
    scheduler.demand(message.market, false);
  }
});
process.on('disconnect', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

async function boot(): Promise<void> {
  validateRegistry();
  const probe = await probeChain();
  if (!probe.ok) throw new Error(`depth RPC sanity check failed (${probe.reason})`);
  await REFERENCES.start();
  const bootstrapPricer = new UsdPricer((key) => REFERENCES.assetUsd(key), (market) => REFERENCES.midForPair(market));
  for (const adapter of ADAPTERS) {
    try { await adapter.discover(ctxFor(adapter, bootstrapPricer)); }
    catch { /* a venue can recover on the next worker lifetime; other curves stay useful */ }
  }
  ready = true;
  for (const market of active) scheduler.demand(market, true);
  watcher.start({
    onBlock(number, _source, observedAt, identity) { scheduler.observe({ number, observedAt, identity }); },
    onReplaced: () => runner.stop(),
  });
  send({ type: 'ready' });
}

boot().catch((error) => {
  send({ type: 'status', level: 'warn', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  void shutdown();
});
