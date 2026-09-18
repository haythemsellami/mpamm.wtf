import { createHash } from 'node:crypto';
import { VolumeStore } from '../src/db.js';
import { AnalyticsWorker } from '../src/analytics-worker.js';
import { computeLeaderboard } from '../src/analytics.js';

// Called by benchmark-runtime in fresh processes, so fixture construction and
// another scenario's retained heap cannot masquerade as service memory usage.
const path = process.argv[2], mode = process.argv[3];
const now = 1_800_000_000_000;
const store = mode === 'direct' ? new VolumeStore(path, true) : undefined;
const worker = mode === 'worker' ? new AnalyticsWorker(path) : undefined;
const task = () => worker ? worker.compute(30, now) : computeLeaderboard(() => {
  let ts = -1, id = '';
  return () => { const page = store!.lbFillsChunk(now - 30 * 86_400_000, ts, id, 25_000, now); if (page.length) { ts = page.at(-1)!.ts; id = page.at(-1)!.id; } return page; };
}, 30, now, (ids) => store!.fillsByIds(ids));
await task();
global.gc?.();
const delays: number[] = [];
let previous = performance.now(), rss = process.memoryUsage().rss;
const timer = setInterval(() => { const at = performance.now(); delays.push(Math.max(0, at - previous - 5)); previous = at; rss = Math.max(rss, process.memoryUsage().rss); }, 5);
const cpu = process.cpuUsage(), start = performance.now();
const result = await task();
const elapsedMs = performance.now() - start;
await new Promise((r) => setTimeout(r, 10)); clearInterval(timer);
const usage = process.cpuUsage(cpu);
delays.sort((a, b) => a - b);
console.log(JSON.stringify({ hash: createHash('sha256').update(JSON.stringify(result)).digest('hex'), elapsedMs,
  cpuMs: (usage.user + usage.system) / 1000, eventLoopP95Ms: delays[Math.floor((delays.length - 1) * .95)],
  eventLoopMaxMs: Math.max(...delays), rssPeakMB: rss / 1024 ** 2 }));
await worker?.close(); store?.close();
