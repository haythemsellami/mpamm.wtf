// A boot with Clober's subgraph down. decode() used to hold every range with
// a Take until a subgraph discovery succeeded, and that range is the fills
// tail every venue shares: on 2026-10-31 (Goldsky 404, Ormi 429) two Takes on
// a CHOG/MON book nobody tracks froze fills and volume for every venue. The
// chain now says which books are the vault's (LiquidityVault.bookPair), so the
// subgraph only decides what is quoted at boot. Fixtures are recorded from
// Monad; fetch and the RPC client are stubbed, so there is no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADDR } from '@shared';
import { createCloberVaultAdapter, decodeCloberTake, type CloberBook } from '../clober.js';

const GOLDSKY = 'https://api.goldsky.com/api/public/project_clsljw95chutg01w45cio46j0/subgraphs/v2-subgraph-monad/latest/gn';
const ZERO = '0x0000000000000000000000000000000000000000';

type Key = { base: string; unitSize: bigint; quote: string; makerPolicy: number; hooks: string; takerPolicy: number };
const NO_KEY: Key = { base: ZERO, unitSize: 0n, quote: ZERO, makerPolicy: 0, hooks: ZERO, takerPolicy: 0 };

/** The vault's MON/USDC sell book and its mirror (LiquidityVault.bookPair and
 *  BookManager.getBookKey at block 118,218,010). */
const MON_USDC = '5954885684956363054050231031211743946744177791604395877538';
const MON_USDC_MIRROR = '3875727077379471850923186002296331935053867847116966170720';
const MON_USDC_KEY: Key = { base: ZERO, unitSize: 1n, quote: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', makerPolicy: 8888608, hooks: ZERO, takerPolicy: 8888708 };

/** CHOG/MON, not a vault book: bookPair is 0 (block 118,218,881). */
const CHOG_MON = '3600347544513338768057978329649925835452964932637306115424';
const CHOG_MON_KEY: Key = { base: '0x350035555E10d9AfAF1566AaebfCeD5BA6C27777', unitSize: 1_000_000_000_000n, quote: ZERO, makerPolicy: 8888608, hooks: ZERO, takerPolicy: 8888708 };

/** The two Takes in tx 0xe77d4935… (block 117,814,474) that held the prod
 *  tail at block ~117,813,977 on 2026-10-31. */
const CHOG_TX = '0xe77d4935b186cbdca8aceb1178bc81ce60e3e756abe4376e1aac897092a30e00';
const CHOG_TAKES = [
  { args: { bookId: BigInt(CHOG_MON), user: '0xC44bc3187cD5084BAc87aF0710CCB3e52041a70D', tick: -27322, unit: 1n }, transactionHash: CHOG_TX, blockNumber: 117_814_474n, logIndex: 9 },
  { args: { bookId: BigInt(CHOG_MON), user: '0xC44bc3187cD5084BAc87aF0710CCB3e52041a70D', tick: -28913, unit: 1_487_248_567n }, transactionHash: CHOG_TX, blockNumber: 117_814_474n, logIndex: 11 },
];

/** A real MON/USDC vault Take (tx 0x42991909…, block 86,746,586; clober.decode.test.ts). */
const VAULT_TAKE = {
  args: { bookId: BigInt(MON_USDC), user: '0x553037Bac82741e7CA05AfB48e8538996fD70ECa', tick: -313882, unit: 296730680n },
  transactionHash: '0x42991909a8e6b88ef087bf0f108ec882b191b8f1d77241cc92a3d2381547e2e7',
  blockNumber: 86_746_586n,
  logIndex: 6,
};

const HEAD = 118_218_881n;
const TS = 1_783_600_000_000;

type ChainBook = { pair: bigint; key: Key };
/** Both subgraph endpoints down, exactly as on 2026-10-31. */
function subgraphDown() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === GOLDSKY
    ? new Response(JSON.stringify({ statusCode: 404, message: 'Subgraph not found.' }), { status: 404 })
    : new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 }))));
}

/** An RPC client answering bookPair/getBookKey from `chain.books`; records
 *  each multicall's block and the books it asked about. */
function chainWith(chain: { head: bigint; books: Record<string, ChainBook>; fail?: Error }) {
  const reads: Array<{ blockNumber: bigint; ids: string[] }> = [];
  const client = {
    getBlockNumber: async () => chain.head,
    multicall: async ({ contracts, allowFailure, blockNumber }: any) => {
      expect(allowFailure).toBe(false); // one failed leg must fail the read, never read as "not the vault's"
      reads.push({ blockNumber, ids: [...new Set<string>(contracts.map((c: any) => String(c.args[0])))] });
      if (chain.fail) throw chain.fail;
      return contracts.map((c: any) => {
        const b = chain.books[String(c.args[0])] ?? { pair: 0n, key: NO_KEY };
        if (c.functionName === 'bookPair') { expect(c.address).toBe(ADDR.liquidityVault); return b.pair; }
        expect(c.functionName).toBe('getBookKey');
        expect(c.address).toBe(ADDR.bookManager);
        return b.key;
      });
    },
  };
  return { client, reads };
}

async function bootWith(chain: Parameters<typeof chainWith>[0]) {
  subgraphDown();
  const { client, reads } = chainWith(chain);
  const notes: string[] = [];
  const ctx = {
    config: { subgraphUrl: GOLDSKY },
    note: (code: string, msg: string) => notes.push(`${code}: ${msg}`),
    client,
    getLogs: async () => { throw new Error('no getLogs in this test'); },
  } as any;
  const adapter = createCloberVaultAdapter();
  await adapter.discover(ctx);
  const decode = (bundle: { take?: any[]; vaultOpen?: any[]; bmOpen?: any[] }) =>
    adapter.decode(ctx, { take: [], bmOpen: [], vaultOpen: [], router: [], ...bundle }, () => TS, new Set());
  return { adapter, decode, reads, notes, chain };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Clober with its subgraph down at boot', () => {
  it('says discovery failed, and nothing about holding the tail', async () => {
    const { notes, adapter } = await bootWith({ head: HEAD, books: {} });
    expect(notes).toEqual(['venue.discovery.degraded: Clober: subgraph discovery failed (subgraph unavailable (api.goldsky.com: subgraph 404; api.subgraph.ormilabs.com: subgraph 429)); trying recent Open logs']);
    expect(adapter.quoteMarkets?.()).toEqual([]);
  });

  it('drops the Takes that froze the tail on 2026-10-31: the chain says their CHOG/MON book is not the vault\'s', async () => {
    const { decode, reads } = await bootWith({ head: HEAD, books: { [CHOG_MON]: { pair: 0n, key: CHOG_MON_KEY } } });
    expect(await decode({ take: CHOG_TAKES })).toEqual([]);
    expect(reads).toEqual([{ blockNumber: HEAD, ids: [CHOG_MON] }]); // one read, pinned at the head
  });

  it('decodes a vault Take from the chain\'s book key, the same fill the subgraph book gives', async () => {
    const { decode, adapter } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: BigInt(MON_USDC_MIRROR), key: MON_USDC_KEY } } });
    const fills = await decode({ take: [VAULT_TAKE] });
    const subgraphBook: CloberBook = { bookId: BigInt(MON_USDC), base: ZERO, quote: MON_USDC_KEY.quote.toLowerCase(), unitSize: 1n, baseSym: 'MON', quoteSym: 'USDC', isVault: true };
    expect(fills).toEqual([decodeCloberTake(VAULT_TAKE, new Map([[MON_USDC, subgraphBook]]), TS)]);
    expect(fills[0]).toMatchObject({ venueId: 'clober-vault', market: 'MON/USDC', side: 'sell', id: `clb-${VAULT_TAKE.transactionHash}-6` });
    expect(fills[0].usd).toBeCloseTo(296.73068, 5);      // unit × unitSize / 1e6
    expect(fills[0].execPx).toBeCloseTo(0.023386190540000906, 12);
    // the book is quotable from here on, though discovery found nothing
    expect(adapter.quoteMarkets?.()).toEqual(['MON/USDC']);
  });

  it('reads a vault book once: its verdict never changes', async () => {
    const { decode, reads } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: BigInt(MON_USDC_MIRROR), key: MON_USDC_KEY } } });
    await decode({ take: [VAULT_TAKE] });
    await decode({ take: [{ ...VAULT_TAKE, blockNumber: HEAD + 50n, logIndex: 1 }] });
    expect(reads).toHaveLength(1);
  });

  it('a not-the-vault\'s verdict covers Takes up to its block; a later Take is asked again', async () => {
    const { decode, reads, chain } = await bootWith({ head: HEAD, books: { [CHOG_MON]: { pair: 0n, key: CHOG_MON_KEY } } });
    await decode({ take: CHOG_TAKES });
    await decode({ take: [{ ...CHOG_TAKES[0], blockNumber: HEAD }] });
    expect(reads).toHaveLength(1);
    chain.head = HEAD + 10n;
    expect(await decode({ take: [{ ...CHOG_TAKES[0], blockNumber: HEAD + 1n }] })).toEqual([]);
    expect(reads.map((r) => r.blockNumber)).toEqual([HEAD, HEAD + 10n]);
  });

  it('counts a book from the Vault.Open that adopts it, after a not-the-vault\'s verdict', async () => {
    // the vault can adopt a book that is already open (LiquidityVault.open)
    const { decode, chain } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: 0n, key: MON_USDC_KEY } } });
    expect(await decode({ take: [VAULT_TAKE] })).toEqual([]);
    chain.books[MON_USDC] = { pair: BigInt(MON_USDC_MIRROR), key: MON_USDC_KEY };
    const vaultOpen = { args: { bookIdA: BigInt(MON_USDC), bookIdB: BigInt(MON_USDC_MIRROR) } };
    const fills = await decode({ take: [VAULT_TAKE], vaultOpen: [vaultOpen] });
    expect(fills).toHaveLength(1);
    expect(fills[0].market).toBe('MON/USDC');
  });

  it('ignores a vault book outside base/stable scope, without holding or re-reading it', async () => {
    const { decode, reads } = await bootWith({ head: HEAD, books: { [CHOG_MON]: { pair: 1n, key: CHOG_MON_KEY } } });
    expect(await decode({ take: CHOG_TAKES })).toEqual([]);
    expect(await decode({ take: [{ ...CHOG_TAKES[0], blockNumber: HEAD + 100n }] })).toEqual([]);
    expect(reads).toHaveLength(1);
  });

  it('holds the range when the chain read fails', async () => {
    const { decode } = await bootWith({ head: HEAD, books: {}, fail: new Error('HTTP request failed') });
    await expect(decode({ take: CHOG_TAKES })).rejects.toThrow('HTTP request failed');
  });

  it('holds the range when the head has not reached the Take', async () => {
    const { decode, reads } = await bootWith({ head: 117_814_473n, books: { [CHOG_MON]: { pair: 0n, key: CHOG_MON_KEY } } });
    await expect(decode({ take: CHOG_TAKES })).rejects.toThrow('head 117814473 is behind Take block 117814474');
    expect(reads).toEqual([]);
  });

  it('holds the range when a Vault.Open names a book the chain read says is not the vault\'s', async () => {
    const { decode } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: 0n, key: MON_USDC_KEY } } });
    const vaultOpen = { args: { bookIdA: BigInt(MON_USDC), bookIdB: BigInt(MON_USDC_MIRROR) } };
    await expect(decode({ take: [VAULT_TAKE], vaultOpen: [vaultOpen] }))
      .rejects.toThrow(`vault book ${MON_USDC} has no LiquidityVault.bookPair at block ${HEAD}`);
  });

  it('holds the range when a vault book has no key on the BookManager', async () => {
    const { decode } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: BigInt(MON_USDC_MIRROR), key: NO_KEY } } });
    await expect(decode({ take: [VAULT_TAKE] })).rejects.toThrow(`vault book ${MON_USDC} has no BookManager key`);
  });

  it('a range without a Take reads nothing', async () => {
    const { decode, reads } = await bootWith({ head: HEAD, books: {} });
    expect(await decode({})).toEqual([]);
    expect(reads).toEqual([]);
  });
});
