// Crystal Vault's quote-update burn is its keeper's `execute` pushes. On
// 2026-11-07 the keeper moved them onto FastLane's shared AuctionHandler with
// its own EIP-7702 account as the searcher, and a vault-keyed source goes
// SILENT there — no throw, no note: production stored 4,040 txs for 11-07 and
// no row from 11-08 while the keeper sent 51,770 txs that day. These pin both
// routes on real recorded txs (fixtures/crystal-keeper.json), and run the REAL
// pass() over the series production held: the rebuild must start on the day
// the keeper gained code and keep every day before it. No network; the one
// archive lookup (blockAtOrAfter) is mocked.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrystalAdapter } from '../crystal.js';
import { createHanjiAdapter } from '../hanji.js';
import { GasTracker, classifyGasSourceChange, gasSourcesSignature, relayedTxHashes } from '../../gas.js';
import { VolumeStore } from '../../db.js';
import type { GasSource } from '../adapter.js';

// 2026-11-07 opens at block 40,000 in the pass() test's small block space
vi.mock('../../chain/rpc.js', () => ({
  blockAtOrAfter: vi.fn(async (ts: number) => {
    if (new Date(ts * 1000).toISOString().slice(0, 10) !== '2026-11-07') throw new Error(`unexpected day boundary lookup: ${ts}`);
    return 40_000n;
  }),
}));

const FX = JSON.parse(readFileSync(new URL('./fixtures/crystal-keeper.json', import.meta.url), 'utf8'));

const VAULT = '0x020f863a6212a9ed5caa73a087e62acd371b7334';
const KEEPER = '0xaf9ed4d3153d821046885b4aea0f778addbb3de5';
const HANDLER = '0xd32edf6642d917dbbe7b8bf8e5d6f5df6a9fff58';
const RELAY_TOKEN = `${KEEPER}@${HANDLER}:0x0c7abd22:5`;

const addrsOf = (s: GasSource) => (Array.isArray(s.address) ? s.address : [s.address]).map((a) => a.toLowerCase());
// the tracker's own normalisation (gas.ts tailVenue) — relays bind to their source's targets
const relaysOf = (sources: GasSource[]) => sources.flatMap((s) => (s.mode === 'blocks' ? s.relays ?? [] : []).map((r) => ({
  to: r.address.toLowerCase(), selector: r.selector.toLowerCase(), word: r.targetWord, targets: new Set(addrsOf(s)),
})));
const mon = (t: any) => Number(BigInt(t.gasUsed) * BigInt(t.effectiveGasPrice)) / 1e18;

describe('crystal quote-update destinations', () => {
  const sources = createCrystalAdapter().gasSources?.() ?? [];

  it('tracks the vault and the keeper account, in blocks mode', () => {
    // blocks mode is load-bearing: the vault emits nothing, and a reverted
    // FastLane bid has no logs at all.
    expect(sources.every((s) => s.mode === 'blocks')).toBe(true);
    expect(sources.flatMap(addrsOf)).toEqual([VAULT, KEEPER]);
  });

  it('routes FastLane to the keeper alone — never to the vault', () => {
    const routed = sources.filter((s) => s.mode === 'blocks' && s.relays?.length);
    expect(routed).toHaveLength(1);
    expect(addrsOf(routed[0])).toEqual([KEEPER]);
    expect(gasSourcesSignature(sources)).toBe([VAULT, KEEPER, RELAY_TOKEN].sort().join(','));
  });
});

describe('listing the keeper rebuilds the minimum', () => {
  const sigNow = gasSourcesSignature(createCrystalAdapter().gasSources?.() ?? []);
  /** what production fingerprinted while the vault was the only destination */
  const SIG_VAULT_ONLY = VAULT;

  it('is a PARTIAL rebuild bounded by the keeper — its code dates from 2026-11-07', () => {
    expect(classifyGasSourceChange(SIG_VAULT_ONLY, sigNow)).toEqual({ kind: 'partial', added: [KEEPER] });
  });

  it('a relay on the vault source would name the vault, whose creation precedes sinceUtc — a lifetime re-scan', () => {
    const relay = { address: HANDLER as `0x${string}`, selector: '0x0c7abd22' as const, targetWord: 5 };
    const oneSource = gasSourcesSignature([{ mode: 'blocks', address: [VAULT as `0x${string}`, KEEPER as `0x${string}`], relays: [relay] }]);
    expect(classifyGasSourceChange(SIG_VAULT_ONLY, oneSource).added.sort()).toEqual([VAULT, KEEPER].sort());
  });

  it('re-running with the same sources is a no-op', () => {
    expect(classifyGasSourceChange(sigNow, sigNow).kind).toBe('none');
  });
});

describe('crystal FastLane relay route', () => {
  const sources = createCrystalAdapter().gasSources?.() ?? [];
  const relays = relaysOf(sources);

  it('counts the keeper\'s relayed pushes — including a REVERTED one, which is log-less but still pays the limit', () => {
    const hit = relayedTxHashes([FX.relayed, FX.relayedRev, FX.other, FX.direct, FX.delegate], relays);
    expect([...hit].sort()).toEqual([FX.relayed.hash, FX.relayedRev.hash].sort());
    expect(FX.relayedRev.status).toBe('0x0');
    for (const t of [FX.relayed, FX.relayedRev]) {
      expect(t.from).toBe(KEEPER);
      expect(t.to).toBe(HANDLER);
    }
  });

  it('the searcher word is the keeper itself; the vault sits off the word grid, inside searcherCallData', () => {
    const words = FX.relayed.input.slice(10).match(/.{64}/g) as string[];
    expect(`0x${words[5].slice(24)}`).toBe(KEEPER);
    expect(words.some((w) => w === VAULT.slice(2).padStart(64, '0'))).toBe(false);
    expect(FX.relayed.input).toContain(VAULT.slice(2));
  });

  it('a direct push is matched by tx.to — the tracker\'s target set is every source\'s addresses', () => {
    expect(FX.direct.to).toBe(VAULT);
    expect(FX.direct.input.slice(0, 10)).toBe('0x61d59c2d'); // execute
    expect(sources.flatMap(addrsOf)).toContain(FX.direct.to);
  });

  it("never counts another searcher's bid on the shared handler", () => {
    expect(FX.other.to).toBe(HANDLER);
    expect(FX.other.input.slice(0, 10)).toBe('0x0c7abd22');
    expect(relayedTxHashes([FX.other], relays).size).toBe(0);
  });

  it('shares the handler with Hanji without cross-counting', () => {
    const hanji = relaysOf(createHanjiAdapter().gasSources?.() ?? []);
    expect(hanji.some((r) => r.to === HANDLER)).toBe(true);
    expect(relayedTxHashes([FX.relayed, FX.relayedRev], hanji).size).toBe(0);
  });

  it('the keeper has code from its type-4 delegation tx — the block the rebuild is dated by', () => {
    expect(FX.delegate.type).toBe('0x4');
    expect(FX.delegate.to).toBe(KEEPER);
    expect(FX.delegate.blockNumber).toBe(120_108_824);
    expect(FX.delegate.blockNumber).toBeLessThan(FX.relayedRev.blockNumber); // no routed push predates it
  });

  it('hand-checked cost: 950,000 × 113 gwei = 0.10735 MON per routed push (~5× a direct one)', () => {
    expect(mon(FX.relayed)).toBeCloseTo(0.10735, 10);
    expect(mon(FX.relayedRev)).toBeCloseTo(0.07345, 10); // 650,000 × 113 gwei, reverted
    expect(mon(FX.direct)).toBeCloseTo(0.0226, 10); // 200,000 × 113 gwei
  });
});

describe('the deployed series heals from the delegation day', () => {
  // block space: 2026-11-07 opens at 40,000 and 2026-11-08 at 46,000; the
  // keeper gains code at 42,500 and relays from 43,000; stride is 1,000.
  const DELEGATED = 42_500n;
  const RELAY_FROM = 43_000n;
  const DAY8 = 46_000n;
  const HEAD_RAW = 48_005n; // tail head = 48,000
  const tsOf = (bn: bigint) => BigInt(Date.parse(bn < DAY8 ? '2026-11-07T12:00:00Z' : '2026-11-08T12:00:00Z') / 1000);
  // every block: the keeper's one push by the route of its time, beside another searcher's bid
  const txsOf = (bn: bigint) => [bn < RELAY_FROM ? FX.direct : FX.relayed, FX.other];

  it('keeps 11-06, re-counts 11-07 on both routes, and fills 11-08', async () => {
    const path = join(tmpdir(), `crystal-gas-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new VolumeStore(path);
    // production's state on 2026-11-09: vault-only fingerprint, cursor at the tip
    store.setMeta('gas_cov_epoch', '2');
    store.setMeta('gas_srcs_crystal', VAULT);
    store.setMeta('gas_from_crystal', '2026-09-22');
    store.applyGas([
      { utcDay: '2026-11-06', venueId: 'crystal', mon: 1_744, txs: 51_494 },
      { utcDay: '2026-11-07', venueId: 'crystal', mon: 123, txs: 4_040 }, // direct pushes only — the hole
    ], 'gas_cursor_crystal', '47500');

    const probed = new Set<string>();
    const client: any = {
      getBlockNumber: async () => HEAD_RAW,
      getCode: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
        probed.add(address.toLowerCase());
        return blockNumber >= DELEGATED ? '0xef0100a8357c991244d7e0a88abe5e807a909a69a4b4ba' : '0x';
      },
      getBlock: async ({ blockNumber, includeTransactions }: { blockNumber: bigint; includeTransactions?: boolean }) => ({
        timestamp: tsOf(blockNumber),
        ...(includeTransactions ? { transactions: txsOf(blockNumber) } : {}),
      }),
      request: async ({ method, params }: { method: string; params: [string] }) => {
        if (method !== 'eth_getBlockReceipts') throw new Error(`unexpected ${method}`);
        return txsOf(BigInt(params[0])).map((t: any) => ({ transactionHash: t.hash, to: t.to, gasUsed: t.gasUsed, effectiveGasPrice: t.effectiveGasPrice }));
      },
    };
    const notes: string[] = [];
    const adapter = createCrystalAdapter();
    const tracker = new GasTracker(client, store, [adapter], (code, msg) => { notes.push(`${code} ${msg}`); }, () => false, 9_999);

    await (tracker as any).pass();
    clearTimeout((tracker as any).timer);

    expect(notes).toEqual(['gas.series.reset Crystal Vault: quote-update destination added — rebuilding from 2026-11-07 (earlier history unaffected)']);
    // dated by the keeper alone: the vault (created before sinceUtc) is never probed
    expect([...probed]).toEqual([KEEPER]);
    expect(store.getMeta('gas_srcs_crystal')).toBe(gasSourcesSignature(adapter.gasSources!()));
    expect(store.getMeta('gas_from_crystal')).toBe('2026-09-22'); // the series anchor never moves

    const rows = Object.fromEntries(store.gasDays('2099-01-01').filter((d) => d.byVenue['crystal']).map((d) => [d.utcDay, d.byVenue['crystal']!]));
    expect(Object.keys(rows).sort()).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']);
    expect(rows['2026-11-06']).toMatchObject({ txs: 51_494, mon: 1_744 });
    // 11-07: samples 40k–42k see a direct push, 43k–45k a relayed one, × stride 1,000
    expect(rows['2026-11-07'].txs).toBe(6_000);
    expect(rows['2026-11-07'].mon).toBeCloseTo(3_000 * mon(FX.direct) + 3_000 * mon(FX.relayed), 6);
    // 11-08: samples 46k, 47k × 1,000 and the head block alone
    expect(rows['2026-11-08'].txs).toBe(2_001);
    expect(rows['2026-11-08'].mon).toBeCloseTo(2_001 * mon(FX.relayed), 6);
    expect(store.getMeta('gas_cursor_crystal')).toBe('48001');

    await (tracker as any).pass(); // fingerprint stored: the next pass only tails
    tracker.stop();
    expect(notes).toHaveLength(1);
    unlinkSync(path);
  });
});
