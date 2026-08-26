import { ASSETS, depthSizes, MARKETS, type QuoteRow } from '@shared';
import { guardRpcRead } from '../chain/failover.js';
import {
  getLogsChunked, probeChain, publicClient, quoteClient, rpcGeneration, rpcStatus,
} from '../chain/rpc.js';
import { HotHeadWatcher } from '../chain/heads.js';
import { config } from '../config.js';
import { buildDepthSnapshot } from '../depth.js';
import { UsdPricer } from '../pricer.js';
import { ADAPTERS, REFERENCES, validateRegistry } from '../venues/registry.js';
import type { AdapterContext, VenueAdapter } from '../venues/adapter.js';
import type { DepthWorkerRequest, DepthWorkerResponse } from './protocol.js';

const active = new Set<string>();
const pending = new Set<string>();
const lastStarted = new Map<string, number>();
const contexts = new WeakMap<VenueAdapter, AdapterContext>();
const grid = depthSizes(config.depthSamples);
let latestHead = 0n;
let running = false;
let ready = false;
let stopped = false;
let lastWarning = '';
let lastWarningAt = 0;

const send = (message: DepthWorkerResponse): void => {
  if (process.connected && process.send) process.send(message);
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const unavailable = () => { const state = rpcStatus(); return state.degraded || state.down; };
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
      client: publicClient,
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

function captureReference(market: string): { pricer: UsdPricer; rows: QuoteRow[]; mid: number } {
  const assetPrices = new Map(Object.keys(ASSETS).map((key) => [key, REFERENCES.assetUsd(key)]));
  const mid = REFERENCES.midForPair(market);
  const pricer = new UsdPricer(
    (key) => assetPrices.get(key) ?? 0,
    (pair) => pair === market ? mid : 0,
  );
  return { pricer, rows: REFERENCES.quote(grid, new Set([market])), mid };
}

async function compute(market: string, blockNumber: bigint): Promise<void> {
  const requested = new Set([market]);
  const { pricer, rows: referenceRows, mid } = captureReference(market);
  const results = await Promise.all(ADAPTERS.filter((adapter) => adapter.quote).map(async (adapter) => {
    try {
      const declared = new Set(adapter.venues().map((venue) => venue.id));
      const rows = await adapter.quote!({ ...ctxFor(adapter, pricer), client: quoteClient }, grid, blockNumber, requested);
      return { failed: false, rows: rows.filter((row) => declared.has(row.venueId) && row.market === market) };
    } catch {
      return { failed: true, rows: [] as QuoteRow[] };
    }
  }));
  if (results.length && results.every((result) => result.failed)) {
    throw new Error('every depth adapter failed; retaining the last completed curve');
  }
  if (!active.has(market) || stopped) return;
  const snapshot = buildDepthSnapshot(
    [...results.flatMap((result) => result.rows), ...referenceRows], market, grid, mid, Number(blockNumber), Date.now(),
  );
  send({
    type: 'publication',
    publication: {
      market,
      asOfBlock: snapshot.asOfBlock,
      ts: snapshot.ts,
      json: JSON.stringify(snapshot),
    },
  });
  lastWarning = '';
}

async function drain(): Promise<void> {
  if (!ready || running || stopped) return;
  running = true;
  try {
    while (!stopped && pending.size) {
      const market = pending.values().next().value as string;
      pending.delete(market);
      if (!active.has(market)) continue;
      const wait = config.depthMinIntervalMs - (Date.now() - (lastStarted.get(market) ?? 0));
      if (wait > 0) await pause(wait);
      if (!active.has(market) || stopped) continue;
      const blockNumber = latestHead > 0n
        ? latestHead
        : await guardRpcRead(() => publicClient.getBlockNumber(), unavailable, rpcGeneration);
      lastStarted.set(market, Date.now());
      await compute(market, blockNumber);
    }
  } catch (error) {
    warn(`depth pass failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
    if (pending.size && !stopped) queueMicrotask(() => { void drain(); });
  }
}

const watcher = new HotHeadWatcher(publicClient, { wsUrl: config.rpcWs, pollMs: Math.max(75, config.headPollMs) });

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  watcher.stop();
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
    pending.add(message.market);
    void drain();
  } else {
    active.delete(message.market);
    pending.delete(message.market);
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
  watcher.start({
    onBlock(blockNumber) {
      if (blockNumber <= latestHead) return;
      latestHead = blockNumber;
      for (const market of active) pending.add(market);
      void drain();
    },
    onWsConnected: () => {},
    onWsFallback: () => {},
    onWsRecovered: () => {},
  });
  latestHead = await guardRpcRead(() => publicClient.getBlockNumber(), unavailable, rpcGeneration);
  ready = true;
  for (const market of active) pending.add(market);
  send({ type: 'ready' });
  void drain();
}

boot().catch((error) => {
  send({ type: 'status', level: 'warn', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  void shutdown();
});
