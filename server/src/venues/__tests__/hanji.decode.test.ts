import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHanjiAdapter } from '../hanji.js';

/**
 * Fixture-based decode tests — REAL `OrderPlaced` logs from Hanji's XAUt0/USDC
 * book (CLOB 0xa49d9ea9…25ab), with the expected values computed independently
 * of the adapter off the raw ints. No network: the CLOB configs are the
 * recorded getConfig rows in fixtures/hanji-config.json.
 *
 * The book trades in SHARES: getConfig's scalingX = 100 over XAUt0's 6
 * decimals makes one share 1e-4 XAUt, and scalingY = 1 over USDC's 6 makes
 * one value unit 1e-6 USDC. Each fill was hand-verified against the ERC-20
 * Transfers of its own tx: the XAUt0 leg moves exactly shares × 1e-4, and the
 * taker's USDC leg is aggressive_value plus (buy) or minus (sell) the 1bp
 * aggressive_fee — so the fill's USD is the GROSS value, fee excluded.
 */

const config = JSON.parse(readFileSync(new URL('./fixtures/hanji-config.json', import.meta.url), 'utf8')) as {
  markets: Array<{ market: string; address: string; result: string[] }>;
};
const rows = new Map(config.markets.map((m) => [m.address.toLowerCase(), m.result.map((v, i) => ([2, 3, 6, 7].includes(i) ? v : BigInt(v)))]));
const ctx = {
  client: {
    multicall: async ({ contracts }: any) => contracts.map((c: any) => ({ status: 'success', result: [...rows.get(c.address.toLowerCase())!] })),
  },
  note: () => {},
  // USDC is the quote leg: $1, so a fill's USD is its quote amount
  pricer: { usdForToken: (_tok: string, amount: number) => amount, pairMid: () => 0 },
} as any;

const XAUT_CLOB = '0xa49d9ea941e4adb7e60aeee49fd6c9fb122925ab';
const PROXY = '0x88687E499846ce3037E63754a6e2E7B53483C70e';
const VAULT = '0xff0cC147F4b9c9a92B865E47061Dbc55A5dAFAA6';

/**
 * https://monadscan.com/tx/0x2f323e96cdd3422886d9099145d4be146b3b68e4485f70a74f00ae6f2c9f9811
 * block 113,327,335 · log index 790 · 2026-10-14 12:30:01 UTC
 * Taker BOUGHT 0.1689 XAUt (XAUt0 Transfer CLOB→proxy 168,900) for 699.428412
 * USDC gross; it paid 699.498355 (gross + 0.069943 fee) ⇒ $4,141.08 / XAUt.
 */
const BUY = {
  address: XAUT_CLOB,
  args: {
    owner: PROXY, initiator: PROXY, order_id: 0n, isAsk: false, quantity: 1689n, price: 999_999_000_000_000_000_000n,
    passive_shares: 0n, passive_fee: 0n, aggressive_shares: 1689n, aggressive_value: 699_428_412n, aggressive_fee: 69_943n,
    market_only: true, post_only: false,
  },
  transactionHash: '0x2f323e96cdd3422886d9099145d4be146b3b68e4485f70a74f00ae6f2c9f9811',
  blockNumber: 113_327_335n,
  logIndex: 790,
};

/**
 * https://monadscan.com/tx/0x5921ef0bc4239b5f93fd4f0b02ac5fd79ebd7c75ff1961848adc67b990f72767
 * block 113,203,926 · log index 49 · 2026-10-14 02:09:08 UTC
 * Taker SOLD 0.1203 XAUt (XAUt0 Transfer proxy→CLOB 120,300) for 500.230257
 * USDC gross; it received 500.180233 (gross − 0.050024 fee) ⇒ $4,158.19 / XAUt.
 */
const SELL = {
  address: XAUT_CLOB,
  args: {
    owner: PROXY, initiator: PROXY, order_id: 0n, isAsk: true, quantity: 1203n, price: 414_987n,
    passive_shares: 0n, passive_fee: 0n, aggressive_shares: 1203n, aggressive_value: 500_230_257n, aggressive_fee: 50_024n,
    market_only: true, post_only: false,
  },
  transactionHash: '0x5921ef0bc4239b5f93fd4f0b02ac5fd79ebd7c75ff1961848adc67b990f72767',
  blockNumber: 113_203_926n,
  logIndex: 49,
};

/**
 * https://monadscan.com/tx/0x30b7f99aea99ca5a116b1bf28b43d9816069f2ebf319a9358d349c6878e69a48
 * block 113,182,032 · log index 14 — the XAUt vault (not the LPManager behind
 * the other books) resting a bid: passive only, so not a trade.
 */
const VAULT_QUOTE = {
  address: XAUT_CLOB,
  args: {
    owner: VAULT, initiator: VAULT, order_id: 457_486_997_108_285_638n, isAsk: false, quantity: 3354n, price: 416_081n,
    passive_shares: 3354n, passive_fee: 0n, aggressive_shares: 0n, aggressive_value: 0n, aggressive_fee: 0n,
    market_only: false, post_only: false,
  },
  transactionHash: '0x30b7f99aea99ca5a116b1bf28b43d9816069f2ebf319a9358d349c6878e69a48',
  blockNumber: 113_182_032n,
  logIndex: 14,
};

describe('Hanji XAUt/USDC decode (recorded logs)', () => {
  it('lists the book and tails its CLOB', async () => {
    const adapter = createHanjiAdapter();
    await adapter.discover(ctx);
    expect(adapter.quoteMarkets!()).toContain('XAUt/USDC');
    expect((adapter.logSources()[0].address as string[]).map((a) => a.toLowerCase())).toContain(XAUT_CLOB);
    expect(adapter.entryPoints!().map((e) => e.address.toLowerCase())).toContain(PROXY.toLowerCase());
  });

  it('decodes a buy and a sell in shares, at the gross USDC value', async () => {
    const adapter = createHanjiAdapter();
    await adapter.discover(ctx);
    const fills = await adapter.decode(ctx, { orderPlaced: [BUY, SELL, VAULT_QUOTE] as any }, (bn) => Number(bn), new Set());
    expect(fills).toHaveLength(2);   // the vault's resting bid is not a trade
    const [buy, sell] = fills;
    expect(buy).toMatchObject({
      id: `hanji-${BUY.transactionHash}-790`, venueId: 'hanji', market: 'XAUt/USDC', side: 'buy', blockNumber: 113_327_335, ts: 113_327_335,
    });
    expect(buy.baseAmount).toBeCloseTo(0.1689, 12);
    expect(buy.usd).toBeCloseTo(699.428412, 9);
    expect(buy.execPx).toBeCloseTo(4141.0800, 3);
    expect(sell).toMatchObject({ id: `hanji-${SELL.transactionHash}-49`, market: 'XAUt/USDC', side: 'sell' });
    expect(sell.baseAmount).toBeCloseTo(0.1203, 12);
    expect(sell.usd).toBeCloseTo(500.230257, 9);
    expect(sell.execPx).toBeCloseTo(4158.1900, 3);
  });
});
