import { describe, expect, it } from 'vitest';
import { ASSETS, type RealtimeHealth } from '@shared';
import {
  captureReferenceFrame, checkRealtimeDegraded, expectedReferenceVenues, medianFrameMs, NO_QUOTE_FRAME, paceSymptoms,
  realtimeCoverage, realtimeSymptoms, REALTIME_DEGRADED, REALTIME_HOLD_MS,
} from '../datasource/live.js';

describe('realtime quote coverage', () => {
  it('counts missing block numbers and a newer observed head', () => {
    const now = 100_000;
    const result = realtimeCoverage([
      { block: 101, emittedAt: now - 900, coalescedBlocks: 0 },
      { block: 102, emittedAt: now - 600, coalescedBlocks: 0 },
      { block: 104, emittedAt: now - 300, coalescedBlocks: 1 },
    ], 105, now);

    expect(result.coveragePct60s).toBe(60);
    expect(result.coalescedBlocks60s).toBe(1);
  });

  it('dedupes frames and excludes samples outside the wall-time window', () => {
    const now = 100_000;
    const result = realtimeCoverage([
      { block: 99, emittedAt: now - 60_001, coalescedBlocks: 8 },
      { block: 100, emittedAt: now - 500, coalescedBlocks: 0 },
      { block: 100, emittedAt: now - 400, coalescedBlocks: 0 },
      { block: 101, emittedAt: now - 100, coalescedBlocks: 0 },
    ], 101, now);

    expect(result.coveragePct60s).toBe(100);
    expect(result.coalescedBlocks60s).toBe(0);
  });
});

// The pace numbers left the dashboard and the stream for GET /api/health; a
// sustained problem is reported as ONE note per episode instead.
describe('quote pace note', () => {
  const healthy: RealtimeHealth = {
    headBlock: 1_000, quoteBlock: 1_000, lagBlocks: 0, frameMs: 150, headToFrameMs: 160, eventLoopLagMs: 40,
    coveragePct60s: 99.5, coalescedBlocks60s: 1, headSource: 'http', wsStatus: 'fallback',
  };
  const collector = () => {
    const log: string[] = [];
    return { log, io: { warn: (m: string) => log.push(`warn ${m}`), clear: (m: string) => log.push(`clear ${m}`), announce: (m: string) => log.push(`info ${m}`) } };
  };

  it('finds nothing wrong with ordinary operation: a skipped block, a block of lag, WS fallback', () => {
    // prod on 2026-11-16: coverage 99.5%, 0–1 blocks behind, ~150ms frames
    expect(realtimeSymptoms(healthy, 150, 300)).toEqual([]);
    expect(realtimeSymptoms({ ...healthy, lagBlocks: REALTIME_DEGRADED.lagBlocks, coveragePct60s: REALTIME_DEGRADED.coveragePct }, 299, 300)).toEqual([]);
  });

  it('names each crossed threshold with its number', () => {
    expect(realtimeSymptoms({ ...healthy, coveragePct60s: 81.25 }, 150, 300)).toEqual(['81.3% of blocks quoted over the last 60s']);
    expect(realtimeSymptoms({ ...healthy, lagBlocks: 12 }, 150, 300)).toEqual(['12 blocks behind the head']);
    expect(realtimeSymptoms(healthy, 412.4, 300)).toEqual(['median frame 412ms against a 300ms block']);
    expect(realtimeSymptoms({ ...healthy, coveragePct60s: 0, lagBlocks: 40 }, 0, 300)).toHaveLength(2); // a stalled quote loop
  });

  it('takes the median compute time of the last minute only', () => {
    const now = 100_000;
    const frames = [
      { block: 1, emittedAt: now - 60_001, coalescedBlocks: 0, durationMs: 9_000 }, // aged out
      { block: 2, emittedAt: now - 900, coalescedBlocks: 0, durationMs: 120 },
      { block: 3, emittedAt: now - 600, coalescedBlocks: 0, durationMs: 800 },        // one slow frame
      { block: 4, emittedAt: now - 300, coalescedBlocks: 0, durationMs: 140 },
    ];
    expect(medianFrameMs(frames, now)).toBe(140);
    expect(medianFrameMs([], now)).toBe(0);
  });

  // Review of #171: the upper-middle value read a window split evenly between
  // 150ms and 400ms frames as 400ms, over the 300ms line, with coverage and
  // lag healthy. The median of an even count is the mean of the middle two.
  it('averages the two middle values of an even-sized window', () => {
    const now = 100_000;
    const sample = (durationMs: number, i: number) => ({ block: i, emittedAt: now - 1 - i, coalescedBlocks: 0, durationMs });
    const split = [...Array.from({ length: 100 }, (_, i) => sample(150, i)), ...Array.from({ length: 100 }, (_, i) => sample(400, 100 + i))];
    expect(medianFrameMs(split, now)).toBe(275);
    expect(realtimeSymptoms(healthy, medianFrameMs(split, now), 300)).toEqual([]);
    expect(medianFrameMs([sample(120, 0), sample(140, 1)], now)).toBe(130);
    // one more slow frame tips a genuine majority over the line
    expect(medianFrameMs([...split, sample(400, 200)], now)).toBe(400);
  });

  // Review of #171: a failed frame is retried silently, so a loop failing every
  // frame from boot had no frame, no health and therefore no note.
  it('reports a loop that never produces a first frame, and recovers on the first one', () => {
    const { log, io } = collector();
    const state = {};
    const sample = (now: number, health: RealtimeHealth | undefined, loopStarted = true) =>
      checkRealtimeDegraded(paceSymptoms({ health, medianMs: 150, blockTimeMs: 300, loopStarted }), '', now, state, io);

    sample(0, undefined, false);                                   // warm-up: no frame is expected yet
    sample(600_000, undefined, false);
    expect(log).toEqual([]);

    const start = 1_000_000;
    for (let t = 0; t < REALTIME_HOLD_MS; t += 5_000) sample(start + t, undefined); // the startup grace
    expect(log).toEqual([]);
    sample(start + REALTIME_HOLD_MS, undefined);
    const line = `warn quotes are not keeping up with the chain head: ${NO_QUOTE_FRAME} — live values on GET /api/health`;
    expect(log).toEqual([line]);
    sample(start + 240_000, undefined);                            // minutes of failed frames: the same line
    expect(log).toEqual([line, line]);

    sample(start + 300_000, healthy);                              // the first frame lands
    sample(start + 300_000 + REALTIME_HOLD_MS, healthy);
    expect(log.slice(-2)).toEqual([`clear ${line.slice(5)}`, 'info quotes are keeping up with the chain head again after ~5m']);
  });

  it('stays silent for a blip, raises once when it lasts, and keeps the same line for the episode', () => {
    const { log, io } = collector();
    const state = {};
    checkRealtimeDegraded(['12 blocks behind the head'], '', 0, state, io);
    checkRealtimeDegraded([], '', 5_000, state, io);                           // gone within the hold
    checkRealtimeDegraded(['12 blocks behind the head'], '', 10_000, state, io);
    checkRealtimeDegraded(['14 blocks behind the head'], '', 10_000 + REALTIME_HOLD_MS - 1, state, io);
    expect(log).toEqual([]);

    checkRealtimeDegraded(['61.0% of blocks quoted over the last 60s', '20 blocks behind the head'], 'slowest adapters: hanji 410ms', 10_000 + REALTIME_HOLD_MS, state, io);
    const line = 'warn quotes are not keeping up with the chain head: 61.0% of blocks quoted over the last 60s; 20 blocks behind the head (slowest adapters: hanji 410ms) — live values on GET /api/health';
    expect(log).toEqual([line]);

    // the numbers move every sample; the line must not, or noteOnce cannot
    // dedupe it and the 60-note window fills with one incident
    checkRealtimeDegraded(['40.0% of blocks quoted over the last 60s'], 'slowest adapters: woofi 900ms', 60_000, state, io);
    expect(log).toEqual([line, line]);
  });

  it('retracts only after staying clear for the hold, and says how long the episode lasted', () => {
    const { log, io } = collector();
    const state = {};
    checkRealtimeDegraded(['12 blocks behind the head'], '', 0, state, io);
    checkRealtimeDegraded(['12 blocks behind the head'], '', REALTIME_HOLD_MS, state, io);
    const line = log[0];
    expect(line).toMatch(/^warn quotes are not keeping up/);

    const clearAt = 600_000;                                                    // ten minutes in
    checkRealtimeDegraded([], '', clearAt, state, io);                          // clear, not yet trusted
    checkRealtimeDegraded(['9 blocks behind the head'], '', clearAt + 5_000, state, io); // relapse: same episode
    checkRealtimeDegraded([], '', clearAt + 10_000, state, io);
    checkRealtimeDegraded([], '', clearAt + 10_000 + REALTIME_HOLD_MS - 1, state, io);
    expect(log.every((l) => l === line)).toBe(true);

    checkRealtimeDegraded([], '', clearAt + 10_000 + REALTIME_HOLD_MS, state, io);
    expect(log.slice(-2)).toEqual([
      `clear ${line.slice(5)}`,
      'info quotes are keeping up with the chain head again after ~10m',
    ]);

    // a fresh episode starts from nothing
    const before = log.length;
    checkRealtimeDegraded([], '', 2_000_000, state, io);
    checkRealtimeDegraded(['12 blocks behind the head'], '', 2_000_000, state, io);
    expect(log).toHaveLength(before);
  });
});

describe('frame reference capture', () => {
  it('keeps adapter pricing immutable after the live reference moves', () => {
    let assetUsd = 2;
    let pairMid = 3;
    const references = {
      assetUsd: () => assetUsd,
      midForPair: () => pairMid,
      quote: () => [],
    };

    const frame = captureReferenceFrame(references, [100]);
    assetUsd = 20;
    pairMid = 30;

    expect(frame.monUsd).toBe(2);
    expect(frame.pricer.pairMid('MON/USDC')).toBe(3);
    expect(frame.assetPrices.get('MON')).toBe(2);
    expect(frame.closedAssets.size).toBe(0);   // a registry without marketClosed
  });

  it('records the assets whose CEX reports the market closed', () => {
    const frame = captureReferenceFrame({ assetUsd: () => 0, midForPair: () => 0, quote: () => [], marketClosed: (k) => k === 'SPYx' }, [100]);
    expect([...frame.closedAssets]).toEqual(['SPYx']);
  });
});

describe('expected reference venues', () => {
  const XSTOCKS = Object.values(ASSETS).filter((a) => a.cex === 'kraken').map((a) => a.key);
  it('expects every CEX while its markets are open', () => {
    expect(expectedReferenceVenues(new Set()).sort()).toEqual(['binance', 'bybit', 'kraken']);
  });
  it('does not expect Kraken while all of its xStock markets are closed, and still does if one is open', () => {
    expect(expectedReferenceVenues(new Set(XSTOCKS)).sort()).toEqual(['binance', 'bybit']);
    expect(expectedReferenceVenues(new Set(XSTOCKS.slice(1)))).toContain('kraken');
  });
});
