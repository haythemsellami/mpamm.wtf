// Writes today's depth-curve answers (the notional grid, and buildDepthSnapshot
// over a set of quote matrices) to service/crates/quotes/tests/depth-golden.json,
// which the Rust depth curves are tested against. Run after changing
// server/src/depth.ts or the DEPTH_* constants in shared/src/index.ts:
//   npx tsx scripts/depth-golden.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { depthSizes, type QuoteRow } from '@shared';
import { buildDepthSnapshot } from '../src/depth.js';

// Deterministic, so the golden file only changes when the code does.
let seed = 42;
const rand = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

const GRID = depthSizes();
const MID = 0.0192;

function row(venueId: string, market: string, sizeUsd: number, bidBps: number, askBps: number,
  over: Partial<QuoteRow> = {}): QuoteRow {
  return {
    venueId, market, sizeUsd, bidBps, askBps,
    bidPx: MID * (1 + bidBps / 1e4),
    askPx: MID * (1 + askBps / 1e4),
    spreadBps: askBps - bidBps,
    filledFull: true,
    feeBps: 0,
    ts: 1,
    ...over,
  };
}

/** A venue's curve whose spread widens with size, with a little skew. */
function curve(venueId: string, market: string, sizes: readonly number[], shape: (size: number, i: number) => Partial<QuoteRow> = () => ({})): QuoteRow[] {
  const skew = (rand() - 0.5) * 2;
  return sizes.map((size, i) => {
    const impact = Math.log10(size / 100) * (1 + rand() * 3);
    return row(venueId, market, size, -(1.5 + impact) + skew, 1.5 + impact + skew, shape(size, i));
  });
}

const cases: Array<{ name: string; rows: QuoteRow[]; market: string; sizes: number[]; refMid: number; asOfBlock: number; ts: number }> = [];
const add = (name: string, rows: QuoteRow[], market = 'MON/USDC', sizes = GRID) =>
  cases.push({ name, rows, market, sizes: [...sizes], refMid: MID, asOfBlock: 125_811_220 + cases.length, ts: 1_764_250_000_000 + cases.length });

add('full curves, skew kept', [...curve('poe', 'MON/USDC', GRID), ...curve('metric', 'MON/USDC', GRID)]);
add('a partial fill ends the curve', curve('clober', 'MON/USDC', GRID, (s) => (s > 100_000 ? { filledFull: false } : {})));
add('no row ends the curve', curve('hanji', 'MON/USDC', GRID.filter((s) => s <= 10_000)));
add('a hole after the start is a cap, not bridged', curve('woofi', 'MON/USDC', GRID.filter((s) => s !== 4_642)));
add('a floor before the start is not a cap', curve('btr', 'MON/USDC', GRID.filter((s) => s >= 1_000)));
add('a one-sided book keeps its real side', curve('crystal', 'MON/USDC', GRID, () => ({ bidPx: 0, bidBps: 0, oneSided: true })));
add('a side priced at zero is absent', curve('thogamm', 'MON/USDC', GRID, (_, i) => (i % 2 ? { askPx: 0 } : {})));
add('no executable side drops the venue', [
  ...curve('dead', 'MON/USDC', GRID, () => ({ bidPx: 0, askPx: 0 })),
  ...curve('poe', 'MON/USDC', GRID),
]);
add('non-finite bps is not a side', curve('lunarbase', 'MON/USDC', GRID, (s) => (s === 1_000 ? { bidBps: Infinity } : {})));
add('the first row per venue and size wins', [
  ...curve('poe', 'MON/USDC', GRID),
  ...curve('poe', 'MON/USDC', GRID, () => ({ bidBps: -99, askBps: 99 })),
]);
add('markets stay apart; venues in first-appearance order', [
  ...curve('uniswap', 'BTC/USDC', GRID),
  ...curve('metric', 'MON/USDC', GRID),
  ...curve('uniswap', 'MON/USDC', GRID),
  ...curve('bybit', 'MON/USDC', GRID),
]);
add('sizes arrive unsorted; rows off the grid are ignored', [
  ...curve('poe', 'MON/USDC', [...GRID, 250, 7_500]).reverse(),
], 'MON/USDC', [...GRID].reverse());
add('a market nobody quotes', curve('poe', 'BTC/USDC', GRID));
add('a coarse grid', curve('poe', 'MON/USDC', depthSizes(5)), 'MON/USDC', depthSizes(5));

const grids = [2, 3, 4, 5, 7, 9, 13, 25, 49, 97, 101].map((samples) => ({ samples, sizes: depthSizes(samples) }));
const golden = {
  grids,
  cases: cases.map((c) => ({ ...c, snapshot: buildDepthSnapshot(c.rows, c.market, c.sizes, c.refMid, c.asOfBlock, c.ts) })),
};
// JSON has no Infinity: the one non-finite bps travels as a string marker.
const out = fileURLToPath(new URL('../../service/crates/quotes/tests/depth-golden.json', import.meta.url));
writeFileSync(out, JSON.stringify(golden, (_, v) => (v === Infinity ? 'Infinity' : v)) + '\n');
console.log(`wrote ${out}: ${golden.cases.length} cases, ${grids.length} grids`);
