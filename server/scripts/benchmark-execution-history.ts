import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import type { QuoteSnapshot } from '@shared';
import { ExecutionHistory } from '../src/execution-history.js';

// Replay real matrix shapes with a synthetic clock: measure retention and
// aggregation independently of RPC latency, JSON parsing and quote generation.
const fixture: QuoteSnapshot = JSON.parse(readFileSync(new URL('./fixtures/quote-matrix.json', import.meta.url), 'utf8'));
const selections = [...new Map(fixture.rows.map((r) => [`${r.market}|${r.sizeUsd}`, { market: r.market, size: r.sizeUsd }])).values()];
const history = new ExecutionHistory();
const realNow = Date.now;
let now = 1_800_000_000_000;
Date.now = () => now;
const cadenceMs = 300;
const recordMs: number[] = [], checkpoints: unknown[] = [];
const p = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
try {
  for (let tick = 0; tick < 12_000; tick++) {
    now = 1_800_000_000_000 + tick * cadenceMs;
    const quote: QuoteSnapshot = { ...fixture, block: tick, ts: now, rows: fixture.rows.map((row) => ({ ...row, ts: now })),
      frame: fixture.frame && { ...fixture.frame, emittedAt: now } };
    const at = performance.now(); history.record(quote);
    if (tick >= 1200) recordMs.push(performance.now() - at);
    if ([1199, 2399, 11999].includes(tick)) {
      const spreads = Reflect.get(history, 'spreads') as Array<{ values: Float64Array }>;
      const quotes = Reflect.get(history, 'quotes') as QuoteSnapshot[];
      checkpoints.push({ elapsedMinutes: (tick + 1) * cadenceMs / 60_000, chartFrames: quotes.length,
        chartRows: quotes.reduce((sum, q) => sum + q.rows.length, 0), spreadFrames: spreads.length,
        numericSpreadBytes: spreads.reduce((sum, q) => sum + q.values.byteLength, 0) });
    }
  }
  const uncachedMs: number[] = [], repeatedMs: number[] = [];
  let summaryBytes = 0;
  for (const selection of selections) {
    const at = performance.now(); const summary = history.stats(selection.market, selection.size);
    uncachedMs.push(performance.now() - at);
    summaryBytes += Buffer.byteLength(JSON.stringify(summary));
    for (let viewer = 0; viewer < 100; viewer++) {
      const readAt = performance.now(); history.stats(selection.market, selection.size);
      repeatedMs.push(performance.now() - readAt);
    }
  }
  const report = { recordedAt: new Date(realNow()).toISOString(), node: process.version, cpu: cpus()[0].model,
    method: 'Replay the recorded quote-matrix fixture for one synthetic hour at 300ms cadence. Each frame owns new row objects. Timings exclude fixture copying and cover record/aggregate calls only; first six minutes excluded from record timing. Read each selection once uncached, then 100 times within one cache bucket; never-collected selections return empty without scanning. Numeric payload bytes exclude JS object overhead and are not process RSS or a production memory estimate.',
    fixtureRows: fixture.rows.length, cadenceMs, selections: selections.length, checkpoints,
    record: { p50Ms: p(recordMs, .5), p95Ms: p(recordMs, .95) },
    aggregate: { uncachedP50Ms: p(uncachedMs, .5), uncachedP95Ms: p(uncachedMs, .95),
      repeatedP50Ms: p(repeatedMs, .5), repeatedP95Ms: p(repeatedMs, .95), allSelectionsSummaryBytes: summaryBytes } };
  writeFileSync(process.argv[2] ?? '/tmp/mpamm-execution-history.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { Date.now = realNow; history.clear(); }
