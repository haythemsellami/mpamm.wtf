// BTR `Swapped` decode on REAL recorded logs (fixtures/btr-swapped.json — a
// USDC->WMON and a WMON->USDC swap receipt). Hand check, buy: 100 USDC in,
// 3584.249443572863555652 WMON out => execPx 100/3584.2494 = 0.027900;
// sell: 3598.065022044050543475 WMON in, 99.661849 USDC out => 0.027698.
// `amounts` packs amountIn (low 128 bits) | amountOut << 128.
import { readFileSync } from 'node:fs';
import { decodeEventLog, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@shared';
import { BTR_POOL, btrMarkets, createBtrAdapter, decodeBtrSwap } from '../btr.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/btr-swapped.json', import.meta.url), 'utf8'));
const abi = parseAbi(['event Swapped(address indexed sender, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amounts, uint256 fees, uint256 prices, uint256 outBook, uint256 outState)']);

/** a raw log as the core hands it to decode(): viem-decoded args, bigint block, numeric index; the
 *  fixture's rehearsal pool address is rewritten to the mainnet proxy. */
const asCoreLog = (raw: any) => ({
  ...raw,
  address: BTR_POOL,
  blockNumber: BigInt(raw.blockNumber),
  logIndex: Number(raw.logIndex),
  ...decodeEventLog({ abi, data: raw.data, topics: raw.topics }),
});
const usdForToken = (key: string, amount: number) => (TOKENS[key].stable ? amount : 0);
const ts = 1790776788000;

describe('BTR Swapped decode', () => {
  const [buyLog, sellLog] = FX.logs.map(asCoreLog);

  it('USDC -> WMON is a buy of MON/USDC', () => {
    const f = decodeBtrSwap(buyLog, ts, usdForToken)!;
    expect(f.id).toBe(`btr-${FX.logs[0].transactionHash}-2`);
    expect(f.venueId).toBe('btr');
    expect(f.market).toBe('MON/USDC');
    expect(f.side).toBe('buy');
    expect(f.usd).toBe(100);
    expect(f.baseAmount).toBeCloseTo(3584.249443572863, 9);
    expect(f.execPx).toBeCloseTo(100 / 3584.249443572863, 12);
    expect(f.blockNumber).toBe(0x6842f47);
  });

  it('WMON -> USDC is a sell of MON/USDC', () => {
    const f = decodeBtrSwap(sellLog, ts, usdForToken)!;
    expect(f.market).toBe('MON/USDC');
    expect(f.side).toBe('sell');
    expect(f.usd).toBeCloseTo(99.661849, 9);
    expect(f.baseAmount).toBeCloseTo(3598.0650220440505, 9);
    expect(f.execPx).toBeCloseTo(99.661849 / 3598.0650220440505, 12);
  });

  it('drops logs from another address, a non-registered pair, and malformed amounts', () => {
    expect(decodeBtrSwap({ ...buyLog, address: '0x' + '1'.repeat(40) }, ts, usdForToken)).toBeNull();
    expect(decodeBtrSwap({ ...buyLog, args: { ...buyLog.args, tokenOut: TOKENS.USDT0.address, tokenIn: TOKENS.USDT0.address } }, ts, usdForToken)).toBeNull();
    expect(decodeBtrSwap({ ...buyLog, args: { ...buyLog.args, amounts: 5n } }, ts, usdForToken)).toBeNull();
  });

  it('throws only when no leg can be priced', () => {
    expect(() => decodeBtrSwap(buyLog, ts, () => 0)).toThrow(/no USD price/);
  });

  it('decode() skips a foreign Upgraded implementation without throwing and returns fills', async () => {
    const notes: string[] = [];
    const ctx: any = { note: (_c: string, m: string) => notes.push(m), client: { getBlockNumber: async () => 1n, multicall: async () => [] }, pricer: { usdForToken } };
    const a = createBtrAdapter();
    const out = await a.decode(ctx, { pool: [buyLog, sellLog] }, () => ts, new Set());
    expect(out.map((f) => f.side)).toEqual(['buy', 'sell']);
  });
});

describe('BTR market table', () => {
  it('covers only registered pairs over the pool assets', () => {
    const symbols = [...btrMarkets().values()].map((m) => m.market);
    expect(symbols).toContain('MON/USDC');
    expect(symbols).toContain('WBTC/cbBTC');
    expect(symbols).not.toContain('SPYx/USDC');
  });
});
