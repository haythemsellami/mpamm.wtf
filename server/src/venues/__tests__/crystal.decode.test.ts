import { readFileSync } from 'node:fs';
import { decodeEventLog, toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { createCrystalAdapter, crystalAbi } from '../crystal.js';

/**
 * Crystal Vault on REAL recorded data (fixtures/crystal.json): every Crystal
 * Fill/Trade log of six txs as raw topics/data, plus one block's discovery and
 * getQuote reads. Expected values are computed here from the raw ints, not by
 * the adapter. Each vault leg was cross-checked against its tx's ERC-20
 * Transfers: the vault keeps internal Crystal balances, so the taker's USDC
 * moves to Crystal and its WMON from Crystal, by exactly the summed legs (an
 * outside maker in the same trade is paid directly, beside them).
 */

const FX = JSON.parse(readFileSync(new URL('./fixtures/crystal.json', import.meta.url), 'utf8'));

const CRYSTAL = '0x508254c838b2e936b0631440c5c6e3ab3a4a98bd';
const VAULT = '0x020f863a6212a9ed5caa73a087e62acd371b7334';

/** a raw log as the core hands it to decode(): viem-decoded args + eventName */
const asCoreLog = (raw: any) => {
  const d = decodeEventLog({ abi: crystalAbi, data: raw.data, topics: raw.topics }) as any;
  return { ...raw, blockNumber: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex), eventName: d.eventName, args: d.args };
};
const logsOf = (...names: string[]) => names.flatMap((n) => FX.logs[n].map(asCoreLog));

const str = (args: readonly unknown[]) => JSON.stringify(args.map((x) => (typeof x === 'bigint' ? String(x) : x)));
const notes: string[] = [];
const ctx = {
  client: {
    multicall: async ({ contracts }: any) => {
      if (contracts[0].functionName !== 'getQuote') return FX.discovery.vault;
      // replay: the adapter must ask for exactly the recorded legs
      return contracts.map((c: any) => {
        const leg = FX.quote.legs.find((l: any) => JSON.stringify(l.args) === str(c.args));
        if (!leg) throw new Error(`unrecorded getQuote leg ${str(c.args)}`);
        return { status: leg.status, result: leg.result.map(BigInt) };
      });
    },
    readContract: async () => Object.fromEntries(Object.entries(FX.discovery.getMarket).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v])),
  },
  note: (_code: string, msg: string) => { notes.push(msg); },
  // USDC is the quote leg: $1, so a fill's USD is its USDC leg
  pricer: {
    pairMid: () => FX.quote.pairMid,
    tokenForUsd: (sym: string, usd: number) => (sym === 'USDC' ? usd : usd / FX.quote.pairMid),
    usdForToken: (_sym: string, amount: number) => amount,
  },
} as any;

async function adapter() {
  const a = createCrystalAdapter();
  await a.discover(ctx);
  return a;
}
const decode = async (logs: any[]) => (await adapter()).decode(ctx, { book: logs }, (bn) => Number(bn), new Set());

describe('Crystal Vault discovery', () => {
  it('holds the cursor until discovery, then tails only Fill + Trade on Crystal', async () => {
    expect(() => createCrystalAdapter().logSources()).toThrow();
    const a = await adapter();
    const [src] = a.logSources();
    expect(src.address).toBe(CRYSTAL);
    expect((src.events as any[]).map((e) => toEventSelector(e)).sort()).toEqual([FX.logs.buy[0].topics[0], FX.logs.buy[1].topics[0]].sort());
    expect(a.quoteMarkets!()).toEqual(['MON/USDC']);
    expect(a.gasSources!()).toEqual([{ mode: 'blocks', address: VAULT }]);
    expect(a.entryPoints!()).toEqual([{ address: CRYSTAL }]);
  });
});

describe('Crystal Vault decode (recorded logs)', () => {
  /**
   * https://monadscan.com/tx/0xbcd6f97225ea9335610c3608b65a0313b6a7da31ff657ac89f4df1381334e8c7
   * Taker BOUGHT 115,863.31… WMON for 2,487.246242 USDC off one vault ask at
   * book price 21,466,000 (0.021466). makerRebate 99995 shaves the taker's
   * leg, so the realized price is the book price ÷ 0.99995.
   */
  it('decodes a buy and a sell at their gross USDC leg', async () => {
    const [buy, sell] = await decode(logsOf('buy', 'sell'));
    expect(buy).toMatchObject({
      id: 'crystal-0xbcd6f97225ea9335610c3608b65a0313b6a7da31ff657ac89f4df1381334e8c7-97',
      venueId: 'crystal', market: 'MON/USDC', side: 'buy', category: 'UNKNOWN', blockNumber: 116_614_451, to: '0x5F50…aA52',
    });
    expect(buy.usd).toBeCloseTo(2487.246242, 9);
    expect(buy.baseAmount).toBeCloseTo(115_863.313099785707630671, 9);
    expect(buy.execPx / (0.021466 / 0.99995) - 1).toBeCloseTo(0, 8);
    // https://monadscan.com/tx/0xc2514490943edb9153ef8d64af94bb41580ff33fcab1b5726da05b1eed926e9f
    // Taker SOLD 175,547.59… WMON into a vault bid at 0.021735 for 3,815.336151 USDC.
    expect(sell).toMatchObject({ id: 'crystal-0xc2514490943edb9153ef8d64af94bb41580ff33fcab1b5726da05b1eed926e9f-10', side: 'sell' });
    expect(sell.usd).toBeCloseTo(3815.336151, 9);
    expect(sell.baseAmount).toBeCloseTo(175_547.592709188455277791, 9);
    expect(sell.execPx / (0.021735 * 0.99995) - 1).toBeCloseTo(0, 8);
  });

  /**
   * https://monadscan.com/tx/0xd064bb6f22a53ef5829f398be22a24bc9fb186c2fe68d59406c506e8362482c7
   * One $8,518.53 buy across four vault asks and one outside ask (0x082345ba…,
   * 2.378439 USDC, paid to it directly). The tx's USDC Transfer to Crystal is
   * 8,516.150031: exactly the vault's four legs.
   */
  it('counts only the vault legs of a trade outside makers share', async () => {
    const fills = await decode(logsOf('mixedMakers'));
    expect(fills).toHaveLength(1);
    expect(fills[0].id).toBe('crystal-0xd064bb6f22a53ef5829f398be22a24bc9fb186c2fe68d59406c506e8362482c7-239');
    expect(fills[0].usd).toBeCloseTo((2409146072 + 2891774634 + 1607207587 + 1608021738) / 1e6, 9);
    const base = 111015005330052883677184n + 133218006396063463768064n + 74010003553368586321920n + 74010003553368586321920n;
    expect(fills[0].baseAmount).toBeCloseTo(Number(base) / 1e18, 6);
  });

  /** https://monadscan.com/tx/0xdf6283864421b726d6b6f3093c6c39560c96fd1f410173cb92a3e8c5ac3a1b47
   *  — an aggregator selling twice through the book in one tx (one leg, then two). */
  it('splits two taker orders in one tx at their own Trade', async () => {
    const fills = await decode(logsOf('twoTrades'));
    expect(fills.map((f) => f.id.split('-').pop())).toEqual(['50', '88']);
    expect(fills.map((f) => f.side)).toEqual(['sell', 'sell']);
    expect(fills[0].usd).toBeCloseTo(424.893061, 9);
    expect(fills[1].usd).toBeCloseTo((2376778187 + 1660342405) / 1e6, 9);
    expect(fills[1].baseAmount).toBeCloseTo(Number(108247428356480215849757n + 75642359201542728143072n) / 1e18, 6);
  });

  /** outsideMaker: https://monadscan.com/tx/0x35d0c13f9b49716afa7dac7bae45d8cc1094a5db34abdb2978033fc7730b0035
   *  vaultTakes: https://monadscan.com/tx/0xcfa458369328d20678e771a7be970e921d656b573b1c066b89a97bc11f77d168
   *  (the keeper's execute selling 749.75 WMON into two outside bids) */
  it('drops trades the vault did not make, including its own takes', async () => {
    expect(await decode(logsOf('outsideMaker', 'vaultTakes'))).toEqual([]);
  });

  it('is independent of the order logs arrive in', async () => {
    const logs = logsOf('buy', 'mixedMakers', 'twoTrades');
    expect(await decode([...logs].reverse())).toEqual(await decode(logs));
  });

  it('holds the cursor when a vault leg arrives without its Trade', async () => {
    const [fill] = logsOf('buy');
    await expect(decode([fill])).rejects.toThrow(/without their Trade/);
  });

  it('skips a trade whose legs disagree with its side', async () => {
    const [fill, trade] = logsOf('buy');
    notes.length = 0;
    expect(await decode([fill, { ...trade, args: { ...trade.args, isBuy: false } }])).toEqual([]);
    expect(notes.join()).toMatch(/disagree/);
  });
});

describe('Crystal Vault quote (recorded getQuote at block 117,081,122)', () => {
  it('prices each leg off getQuote, banded, partial when in-band depth runs out', async () => {
    const a = await adapter();
    const rows = await a.quote!(ctx, [100, 1000, 10000, 100000], BigInt(FX.quote.block));
    const mid = FX.quote.pairMid;
    // worstPrice = mid ± 2000bps in raw book units (scaleFactor 1e21 × 1e6 / 1e18 = 1e9)
    expect(FX.quote.legs[0].args[5]).toBe(String(Math.floor(mid * 1.2 * 1e9)));
    expect(FX.quote.legs[1].args[5]).toBe(String(Math.ceil(mid * 0.8 * 1e9)));
    expect(rows.map((r) => r.sizeUsd)).toEqual([100, 1000, 10000, 100000]);
    for (const [i, r] of rows.entries()) {
      const [buyIn, sellIn] = [FX.quote.legs[2 * i], FX.quote.legs[2 * i + 1]];
      const askPx = (Number(buyIn.result[0]) / 1e6) / (Number(buyIn.result[1]) / 1e18);
      const bidPx = (Number(sellIn.result[1]) / 1e6) / (Number(sellIn.result[0]) / 1e18);
      expect(r.askPx).toBeCloseTo(askPx, 12);
      expect(r.bidPx).toBeCloseTo(bidPx, 12);
      expect(r.askBps).toBeCloseTo((askPx / mid - 1) * 1e4, 9);
      expect(r.bidBps).toBeCloseTo((bidPx / mid - 1) * 1e4, 9);
      expect(r.feeBps).toBe(0);
      expect(r.oneSided).toBeUndefined();
    }
    // $100/$1k fill inside the band; at $10k+ the in-band book runs out
    expect(rows.map((r) => r.filledFull)).toEqual([true, true, false, false]);
    expect(FX.quote.legs[4].result[0]).not.toBe(FX.quote.legs[4].args[4]);
  });
});
