import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKOUT_HORIZONS, pairOf, type Fill, type StreamMessage } from '@shared';
import type { ReferenceSample } from '../src/markout-aging.js';

const directory = mkdtempSync(join(tmpdir(), 'mpamm-markout-benchmark-'));
process.env.DB_PATH = join(directory, 'history.db');
const { LiveDataSource } = await import('../src/datasource/live.js');
interface AgingSource {
  pending: Set<Fill>; dirty: Set<Fill>; midHist: Map<string, ReferenceSample[]>;
  ageMarkouts(): Promise<void>;
  emitMsg(message: StreamMessage): void;
  store: { close(): void };
}
const source = new LiveDataSource() as unknown as AgingSource;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = Date.now();
const history = Array.from({ length: 1201 }, (_, i) => ({ t: now - 120_000 + i * 100, mid: 1 + (i % 31) / 10_000 }));
const rows = (count: number): Fill[] => Array.from({ length: count }, (_, i) => ({
  id: String(i), venueId: 'venue', market: 'MON/USDC', side: i % 2 ? 'buy' : 'sell', category: 'DIRECT',
  usd: 100, baseAmount: 100, execPx: 1, blockNumber: 1, txHash: '0x1', to: 'direct', pool: 'pool',
  ts: now - 119_000 + (i % 59_000), markoutsBps: [null, null, null, null, null],
}));

/** The previous synchronous pass, retained as the comparison oracle. Every
 * fixture horizon has a historical reference, so no live feed is involved. */
function synchronousPass(): void {
  const at = Date.now();
  for (const fill of [...source.pending]) {
    if (fill.pxApprox || !pairOf(fill.market)) { source.pending.delete(fill); continue; }
    const hist = source.midHist.get(fill.market) ?? [];
    const earliest = hist.length ? hist[0].t : at;
    const sign = fill.side === 'buy' ? 1 : -1;
    let changed = false, complete = true;
    for (let h = 0; h < MARKOUT_HORIZONS.length; h++) {
      if (fill.markoutsBps[h] != null) continue;
      const target = fill.ts + MARKOUT_HORIZONS[h] * 1000;
      if (at < target) { complete = false; continue; }
      if (target < earliest) continue;
      let mid = 0, delta = Infinity;
      for (const sample of hist) {
        const dt = Math.abs(sample.t - target);
        if (dt < delta) { delta = dt; mid = sample.mid; }
      }
      if (delta > 6000) mid = 0;
      if (mid > 0 && fill.execPx > 0) { fill.markoutsBps[h] = sign * (mid / fill.execPx - 1) * 1e4; changed = true; }
    }
    if (changed) { source.dirty.add(fill); source.emitMsg({ ch: 'fill', data: fill }); }
    if (complete) source.pending.delete(fill);
  }
}

async function sample(count: number, mode: 'synchronous-linear' | 'yielding-binary') {
  const fills = rows(count);
  source.pending = new Set(fills); source.dirty = new Set();
  source.midHist.set('MON/USDC', history);
  let previous = performance.now();
  const delays: number[] = [];
  const probe = setInterval(() => { const time = performance.now(); delays.push(Math.max(0, time - previous - 2)); previous = time; }, 2);
  await pause(10);
  delays.length = 0; previous = performance.now();
  const cpu = process.cpuUsage(), started = performance.now();
  if (mode === 'synchronous-linear') synchronousPass();
  else await source.ageMarkouts();
  const elapsedMs = performance.now() - started, usage = process.cpuUsage(cpu);
  await pause(5); clearInterval(probe);
  if (source.pending.size || source.dirty.size !== count) throw new Error('incomplete markout pass');
  return { elapsedMs, cpuMs: (usage.user + usage.system) / 1000, maxLoopDelayMs: Math.max(0, ...delays),
    hash: createHash('sha256').update(JSON.stringify(fills)).digest('hex') };
}

try {
  await sample(1000, 'synchronous-linear'); await sample(1000, 'yielding-binary');
  const results = [];
  for (const count of [10_000, 50_000]) {
    const baseline = [], bounded = [];
    for (let trial = 0; trial < 3; trial++) {
      const before = await sample(count, 'synchronous-linear');
      const after = await sample(count, 'yielding-binary');
      if (before.hash !== after.hash) throw new Error('markout result mismatch');
      const { hash: _, ...original } = before, { hash: __, ...updated } = after;
      baseline.push(original); bounded.push(updated);
    }
    results.push({ count, exactResults: true, baseline, bounded });
  }
  const report = { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
    method: 'One warmup and three alternating trials per size; 1201 reference samples at 100ms; all five horizons due in a synthetic burst. Original synchronous linear scan vs actual LiveDataSource aging with binary lookup and 128-fill/2ms slices. 2ms event-loop probe; fixture construction and JSON hashing excluded; no RPC, persistence or socket fanout.', results };
  writeFileSync(process.argv[2] ?? '/tmp/mpamm-markouts.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { source.store.close(); rmSync(directory, { recursive: true, force: true }); }
