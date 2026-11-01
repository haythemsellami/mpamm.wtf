// A boot with Clober's subgraph down. decode() used to hold every range with
// a Take until a subgraph discovery succeeded, and that range is the fills
// tail every venue shares: on 2026-10-31 (Goldsky 404, Ormi 429) two Takes on
// a CHOG/MON book nobody tracks froze fills and volume for every venue. The
// chain now says which books are the vault's (LiquidityVault.bookPair), so the
// subgraph only decides what is quoted at boot. Fixtures are recorded from
// Monad; fetch and the RPC client are stubbed, so there is no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADDR } from '@shared';
import { CLOBER_VAULT_ADOPTIONS, createCloberVaultAdapter, decodeCloberTake, type CloberBook } from '../clober.js';

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

/** A MON/USDC-keyed book the vault adopts during a test. It is not in
 *  CLOBER_VAULT_ADOPTIONS, so only the chain can say when it was adopted. */
const LATE = '4242424242424242424242424242424242424242424242424242424242';
const LATE_MIRROR = '2424242424242424242424242424242424242424242424242424242424';
const lateTake = (blockNumber: bigint, logIndex = 0) => ({ ...VAULT_TAKE, args: { ...VAULT_TAKE.args, bookId: BigInt(LATE) }, blockNumber, logIndex });
const lateOpen = (blockNumber: bigint, logIndex = 0) => ({ args: { bookIdA: BigInt(LATE), bookIdB: BigInt(LATE_MIRROR) }, blockNumber, logIndex });
/** the logIndex each fill's id ends with */
const logIndexes = (fills: Array<{ id: string }>) => fills.map((f) => Number(f.id.split('-').pop()));

const HEAD = 118_218_881n;
/** reads stay five blocks behind the head: the fills tail's finality margin */
const READ_AT = HEAD - 5n;
const TS = 1_783_600_000_000;

/** `pair` is what bookPair returns from block `pairedFrom` on (0 before it;
 *  always, when omitted) */
type ChainBook = { pair: bigint; key: Key; pairedFrom?: bigint };
type OpenLogs = { vaultOpen: any[]; bmOpen: any[] };
/** Both subgraph endpoints down, exactly as on 2026-10-31. */
function subgraphDown() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === GOLDSKY
    ? new Response(JSON.stringify({ statusCode: 404, message: 'Subgraph not found.' }), { status: 404 })
    : new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 }))));
}

/** An RPC client answering bookPair/getBookKey from `chain.books`; records
 *  each multicall's block and the books it asked about. */
function chainWith(chain: { head: bigint; books: Record<string, ChainBook>; fail?: Error; logs?: OpenLogs; stateFrom?: bigint }) {
  const reads: Array<{ blockNumber: bigint; ids: string[] }> = [];
  const client = {
    getBlockNumber: async () => chain.head,
    multicall: async ({ contracts, allowFailure, blockNumber }: any) => {
      expect(allowFailure).toBe(false); // one failed leg must fail the read, never read as "not the vault's"
      reads.push({ blockNumber, ids: [...new Set<string>(contracts.map((c: any) => String(c.args[0])))] });
      if (chain.fail) throw chain.fail;
      // a fullnode keeps recent state only
      if (chain.stateFrom !== undefined && blockNumber < chain.stateFrom) throw new Error(`missing trie node (block ${blockNumber})`);
      return contracts.map((c: any) => {
        const b = chain.books[String(c.args[0])] ?? { pair: 0n, key: NO_KEY };
        if (c.functionName === 'bookPair') {
          expect(c.address).toBe(ADDR.liquidityVault);
          return b.pairedFrom === undefined || blockNumber >= b.pairedFrom ? b.pair : 0n;
        }
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
  const scans: bigint[] = [];
  const ctx = {
    config: { subgraphUrl: GOLDSKY },
    note: (code: string, msg: string) => notes.push(`${code}: ${msg}`),
    client,
    // the recent-Open fallback's scans, answered from `chain.logs` within the asked range
    getLogs: async ({ address, fromBlock, toBlock }: any) => {
      if (!chain.logs) throw new Error('no getLogs in this test');
      scans.push(toBlock);
      const src = address === ADDR.liquidityVault ? chain.logs.vaultOpen : chain.logs.bmOpen;
      return src.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  } as any;
  const adapter = createCloberVaultAdapter();
  await adapter.discover(ctx);
  const decode = (bundle: { take?: any[]; vaultOpen?: any[]; bmOpen?: any[] }) =>
    adapter.decode(ctx, { take: [], bmOpen: [], vaultOpen: [], router: [], ...bundle }, () => TS, new Set());
  return { adapter, decode, reads, notes, chain, scans };
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
    expect(reads).toEqual([{ blockNumber: READ_AT, ids: [CHOG_MON] }]); // one read, pinned behind the head
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
    await decode({ take: [{ ...CHOG_TAKES[0], blockNumber: READ_AT }] });
    expect(reads).toHaveLength(1);
    chain.head = HEAD + 10n;
    expect(await decode({ take: [{ ...CHOG_TAKES[0], blockNumber: READ_AT + 1n }] })).toEqual([]);
    expect(reads.map((r) => r.blockNumber)).toEqual([READ_AT, READ_AT + 10n]);
  });

  // LiquidityVault.open() can adopt a book that is already open, and both of
  // the vault's pairs were adopted (Vault.Open at blocks 37,278,311 and
  // 37,886,929 with no BookManager.Open in either tx). Adoption makes later
  // Takes vault flow, never the ones the chain already said were not.
  it('counts an adopted book from the Vault.Open on, and never a Take the chain said predates it', async () => {
    const { decode, chain, reads } = await bootWith({ head: HEAD, books: { [LATE]: { pair: BigInt(LATE_MIRROR), key: MON_USDC_KEY, pairedFrom: HEAD } } });
    const early = lateTake(117_000_000n);
    expect(await decode({ take: [early] })).toEqual([]);
    chain.head = HEAD + 20n;
    const later = lateTake(HEAD + 1n, 1);
    const fills = await decode({ take: [later], vaultOpen: [lateOpen(HEAD, 3)] });
    expect(fills.map((f) => [f.market, f.id])).toEqual([['MON/USDC', `clb-${VAULT_TAKE.transactionHash}-1`]]);
    // a replay after the adoption still leaves the earlier Take out
    expect(await decode({ take: [early, later] })).toHaveLength(1);
    // the head twice (not the vault's, then its key), then just before the later Take
    expect(reads.map((r) => r.blockNumber)).toEqual([READ_AT, READ_AT + 20n, HEAD]);
  });

  // The subgraph's `pool` flag and bookPair both say a book IS the vault's,
  // never since when: both of the vault's pairs were open books it adopted
  // later, and prod counted 14 MON/USDC Takes from before (2025-11-06..24).
  it('counts a listed book\'s Takes from its first Vault.Open on, reading only its key', async () => {
    const { decode, reads } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: BigInt(MON_USDC_MIRROR), key: MON_USDC_KEY, pairedFrom: 37_886_929n } } });
    const at = (blockNumber: bigint, logIndex: number) => ({ ...VAULT_TAKE, blockNumber, logIndex });
    // its Vault.Open is log 8 of block 37,886,929 (CLOBER_VAULT_ADOPTIONS)
    const fills = await decode({ take: [at(37_000_000n, 1), at(37_886_929n, 7), at(37_886_929n, 9), at(37_886_930n, 0)] });
    expect(logIndexes(fills)).toEqual([9, 0]);
    expect(reads).toEqual([{ blockNumber: READ_AT, ids: [MON_USDC] }]);
    expect(CLOBER_VAULT_ADOPTIONS.find((a) => a.books.includes(MON_USDC))).toMatchObject({ pair: 'MON/USDC', block: 37_886_929n, logIndex: 8 });
  });

  it('finds an unlisted book\'s adoption in the range: Takes before its first Vault.Open drop', async () => {
    const OPEN = 117_500_000n;
    const { decode, reads } = await bootWith({ head: HEAD, books: { [LATE]: { pair: BigInt(LATE_MIRROR), key: MON_USDC_KEY, pairedFrom: OPEN } } });
    const take = [lateTake(OPEN - 10n, 1), lateTake(OPEN, 2), lateTake(OPEN, 7), lateTake(OPEN + 10n, 4)];
    expect(logIndexes(await decode({ take, vaultOpen: [lateOpen(OPEN, 5)] }))).toEqual([7, 4]);
    // the Open is known from here on: a replay without it reads nothing more
    expect(logIndexes(await decode({ take }))).toEqual([7, 4]);
    expect(reads.map((r) => r.blockNumber)).toEqual([READ_AT, OPEN - 11n]);
  });

  it('counts an unlisted vault book once the chain says it was paired before its Takes, reading that once', async () => {
    const { decode, reads, chain } = await bootWith({ head: HEAD, books: { [LATE]: { pair: BigInt(LATE_MIRROR), key: MON_USDC_KEY, pairedFrom: 100_000_000n } } });
    expect(await decode({ take: [lateTake(117_000_000n, 1), lateTake(117_000_100n, 2)] })).toHaveLength(2);
    chain.head = HEAD + 50n;
    expect(await decode({ take: [lateTake(HEAD + 40n, 3)] })).toHaveLength(1);
    expect(reads.map((r) => r.blockNumber)).toEqual([READ_AT, 116_999_999n]);
  });

  it('drops an unlisted vault book\'s Takes from before its adoption, with no Vault.Open in the range', async () => {
    const { decode, reads } = await bootWith({ head: HEAD, books: { [LATE]: { pair: BigInt(LATE_MIRROR), key: MON_USDC_KEY, pairedFrom: 118_000_000n } } });
    expect(await decode({ take: [lateTake(117_000_000n, 1), lateTake(117_000_100n, 2)] })).toEqual([]);
    expect(await decode({ take: [lateTake(117_000_050n, 3)] })).toEqual([]);
    expect(reads.map((r) => r.blockNumber)).toEqual([READ_AT, 116_999_999n]);
  });

  it('holds the range when a Vault.Open precedes a block the chain says its book was not paired at', async () => {
    const { decode } = await bootWith({ head: HEAD, books: { [LATE]: { pair: BigInt(LATE_MIRROR), key: MON_USDC_KEY, pairedFrom: 118_000_000n } } });
    await expect(decode({ take: [lateTake(117_000_000n, 1)], vaultOpen: [lateOpen(116_999_000n)] }))
      .rejects.toThrow(`book ${LATE} has a Vault.Open at block 116999000 but no LiquidityVault.bookPair at block 116999999`);
  });

  it('holds the range when an unlisted book\'s Take is deeper than the node keeps state', async () => {
    const { decode } = await bootWith({ head: HEAD, stateFrom: HEAD - 1_000_000n, books: { [LATE]: { pair: BigInt(LATE_MIRROR), key: MON_USDC_KEY, pairedFrom: 100_000_000n } } });
    await expect(decode({ take: [lateTake(90_000_000n, 1)] })).rejects.toThrow('missing trie node (block 89999999)');
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

  // A vault verdict is cached for good, so it never comes from a tip block
  // that can still mutate away (a provisional Vault.Open would stick).
  it('holds the range until the block five behind the head has reached the Take', async () => {
    const { decode, reads, chain } = await bootWith({ head: 117_814_478n, books: { [CHOG_MON]: { pair: 0n, key: CHOG_MON_KEY } } });
    await expect(decode({ take: CHOG_TAKES })).rejects.toThrow('block 117814473 (head - 5) is behind Take block 117814474');
    expect(reads).toEqual([]);
    chain.head = 117_814_479n;
    expect(await decode({ take: CHOG_TAKES })).toEqual([]);
    expect(reads).toEqual([{ blockNumber: 117_814_474n, ids: [CHOG_MON] }]);
  });

  it('holds the range when a Vault.Open names a book the chain read says is not the vault\'s', async () => {
    const { decode } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: 0n, key: MON_USDC_KEY } } });
    const vaultOpen = { args: { bookIdA: BigInt(MON_USDC), bookIdB: BigInt(MON_USDC_MIRROR) } };
    await expect(decode({ take: [VAULT_TAKE], vaultOpen: [vaultOpen] }))
      .rejects.toThrow(`vault book ${MON_USDC} has no LiquidityVault.bookPair at block ${READ_AT}`);
  });

  it('caches nothing from a read it holds on, so the retry still makes the vault book quotable', async () => {
    // MON/USDC answers first and is in scope; the CHOG/MON answer contradicts its Vault.Open
    const { decode, adapter, reads, chain } = await bootWith({ head: HEAD, books: {
      [MON_USDC]: { pair: BigInt(MON_USDC_MIRROR), key: MON_USDC_KEY },
      [CHOG_MON]: { pair: 0n, key: CHOG_MON_KEY },
    } });
    const range = { take: [VAULT_TAKE, CHOG_TAKES[0]], vaultOpen: [{ args: { bookIdA: BigInt(CHOG_MON) } }] };
    await expect(decode(range)).rejects.toThrow(`vault book ${CHOG_MON} has no LiquidityVault.bookPair`);
    chain.books[CHOG_MON] = { pair: 1n, key: CHOG_MON_KEY }; // the vault's after all, outside base/stable scope
    const fills = await decode(range);
    expect(fills.map((f) => f.market)).toEqual(['MON/USDC']);
    expect(adapter.quoteMarkets?.()).toEqual(['MON/USDC']);
    expect(reads.map((r) => r.ids)).toEqual([[MON_USDC, CHOG_MON], [MON_USDC, CHOG_MON]]);
  });

  it('holds the range when a vault book has no key on the BookManager', async () => {
    const { decode } = await bootWith({ head: HEAD, books: { [MON_USDC]: { pair: BigInt(MON_USDC_MIRROR), key: NO_KEY } } });
    await expect(decode({ take: [VAULT_TAKE] })).rejects.toThrow(`vault book ${MON_USDC} has no BookManager key`);
  });

  /** The vault opening MON/USDC and its mirror at `block` (Vault.Open +
   *  BookManager.Open), as the recent-Open fallback finds them. */
  const opensAt = (block: bigint, id = MON_USDC, mirror = MON_USDC_MIRROR): OpenLogs => ({
    vaultOpen: [{ args: { bookIdA: BigInt(id), bookIdB: BigInt(mirror) }, blockNumber: block }],
    bmOpen: [{ args: { id: BigInt(id), ...MON_USDC_KEY }, blockNumber: block }],
  });

  it('learns a vault book from a finalized Open in the recent-Open fallback', async () => {
    const { adapter, decode, reads, scans } = await bootWith({ head: HEAD, books: {}, logs: opensAt(READ_AT) });
    expect(scans).toEqual([READ_AT, READ_AT]);
    expect(adapter.quoteMarkets?.()).toEqual(['MON/USDC']);
    expect(await decode({ take: [{ ...VAULT_TAKE, blockNumber: READ_AT }] })).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  // The fallback's books are cached for fills, so it never scans the tip. An
  // Open there can still mutate away: if it is retracted, the book is not the
  // vault's, and its Takes must not count.
  it('never caches an Open from the tip in the fallback, so a retracted one counts nothing', async () => {
    const { adapter, decode, reads } = await bootWith({ head: HEAD, books: { [LATE]: { pair: 0n, key: MON_USDC_KEY } }, logs: opensAt(HEAD - 2n, LATE, LATE_MIRROR) });
    expect(adapter.quoteMarkets?.()).toEqual([]);
    expect(await decode({ take: [lateTake(READ_AT)] })).toEqual([]);
    expect(reads).toEqual([{ blockNumber: READ_AT, ids: [LATE] }]);
  });

  it('counts a discovered vault book from its adoption, not over its whole life', async () => {
    const OPEN = READ_AT - 100n;
    const { adapter, decode, reads } = await bootWith({ head: HEAD, books: { [LATE]: { pair: BigInt(LATE_MIRROR), key: MON_USDC_KEY, pairedFrom: OPEN } }, logs: opensAt(OPEN, LATE, LATE_MIRROR) });
    expect(adapter.quoteMarkets?.()).toEqual(['MON/USDC']);
    expect(await decode({ take: [lateTake(OPEN - 100n, 1)] })).toEqual([]);
    expect(await decode({ take: [lateTake(OPEN + 1n, 2)] })).toHaveLength(1);
    expect(reads.map((r) => r.blockNumber)).toEqual([OPEN - 101n, OPEN]);
  });

  it('a range without a Take reads nothing', async () => {
    const { decode, reads } = await bootWith({ head: HEAD, books: {} });
    expect(await decode({})).toEqual([]);
    expect(reads).toEqual([]);
  });
});
