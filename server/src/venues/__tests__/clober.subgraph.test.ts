// Clober's vault-book discovery reads its Monad subgraph. On 2026-10-27 the
// Goldsky primary answered 404 "Subgraph not found" for every Clober subgraph,
// so discovery was never authoritative. decode() then holds any range that
// holds a Take, and that range is the live tail every venue shares. These pin
// the fallback Clober's own SDK uses: the configured endpoint first, then
// Ormi Labs, each serving one whole discovery. No network: fetch is stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOBER_SUBGRAPH_FALLBACK_URL, cloberSubgraphUrls, createCloberVaultAdapter, discoverCloberViaSubgraph, withCloberSubgraph,
} from '../clober.js';

const GOLDSKY = 'https://api.goldsky.com/api/public/project_clsljw95chutg01w45cio46j0/subgraphs/v2-subgraph-monad/latest/gn';
const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const NATIVE = '0x0000000000000000000000000000000000000000';

/** The vault's MON/USDC book pair as the chain reports it on 2026-10-27
 *  (LiquidityVault.bookPair + BookManager.getBookKey). */
const VAULT_BOOKS = [
  { id: '5954885684956363054050231031211743946744177791604395877538', unitSize: '1', base: { id: NATIVE }, quote: { id: USDC }, pool: { id: '0x01' } },
  { id: '3875727077379471850923186002296331935053867847116966170720', unitSize: '1000000000000', base: { id: USDC }, quote: { id: NATIVE }, pool: { id: '0x01' } },
];

/** A real MON/USDC vault Take (tx 0x42991909…, block 86,746,586; clober.decode.test.ts). */
const TAKE_LOG = {
  args: { bookId: 5954885684956363054050231031211743946744177791604395877538n, user: '0x553037Bac82741e7CA05AfB48e8538996fD70ECa', tick: -313882, unit: 296730680n },
  transactionHash: '0x42991909a8e6b88ef087bf0f108ec882b191b8f1d77241cc92a3d2381547e2e7',
  blockNumber: 86746586n,
  logIndex: 6,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOT_FOUND = () => json(404, { statusCode: 404, message: 'Subgraph not found.' });
const TOO_MANY = () => json(429, { error: 'Too many requests' });
const BOOKS = () => json(200, { data: { books: VAULT_BOOKS } });

/** fetch stub routed by endpoint; records which endpoints were asked */
function stubFetch(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }));
  return asked;
}

function ctxWith(notes: string[]) {
  return {
    config: { subgraphUrl: GOLDSKY },
    note: (code: string, msg: string) => notes.push(`${code}: ${msg}`),
    client: {},
    getLogs: async () => { throw new Error('no RPC in this test'); },
  } as any;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('clober subgraph endpoints', () => {
  it("tries the configured endpoint, then Clober's own Ormi Labs fallback", () => {
    expect(cloberSubgraphUrls(GOLDSKY)).toEqual([GOLDSKY, CLOBER_SUBGRAPH_FALLBACK_URL]);
    expect(new URL(CLOBER_SUBGRAPH_FALLBACK_URL).host).toBe('api.subgraph.ormilabs.com');
  });

  it('asks the fallback once when SUBGRAPH_URL already points at it', () => {
    expect(cloberSubgraphUrls(CLOBER_SUBGRAPH_FALLBACK_URL)).toEqual([CLOBER_SUBGRAPH_FALLBACK_URL]);
  });

  it('serves a discovery from the fallback when the primary answers 404', async () => {
    const asked = stubFetch({ [GOLDSKY]: NOT_FOUND, [CLOBER_SUBGRAPH_FALLBACK_URL]: BOOKS });
    const { value, url } = await withCloberSubgraph(cloberSubgraphUrls(GOLDSKY), discoverCloberViaSubgraph);
    expect(url).toBe(CLOBER_SUBGRAPH_FALLBACK_URL);
    expect([...value.vault].sort()).toEqual(VAULT_BOOKS.map((b) => b.id).sort());
    expect(value.markets.map((m) => m.market)).toEqual(['MON/USDC']);
    expect(asked).toEqual([GOLDSKY, CLOBER_SUBGRAPH_FALLBACK_URL]);
  });

  it('never asks the fallback while the primary answers', async () => {
    const asked = stubFetch({ [GOLDSKY]: BOOKS });
    const { url } = await withCloberSubgraph(cloberSubgraphUrls(GOLDSKY), discoverCloberViaSubgraph);
    expect(url).toBe(GOLDSKY);
    expect(asked).toEqual([GOLDSKY]);
  });

  // SUBGRAPH_URL is not validated (config.ts). An override missing its scheme
  // must still leave the fallback reachable, and must never be quoted back.
  const MALFORMED = 'api.goldsky.com/api/public/project_x/subgraphs/v2-subgraph-monad/gn?apiKey=secret';

  it('skips a malformed SUBGRAPH_URL and still reaches the fallback', async () => {
    const asked = stubFetch({ [CLOBER_SUBGRAPH_FALLBACK_URL]: BOOKS });
    const { url } = await withCloberSubgraph(cloberSubgraphUrls(MALFORMED), discoverCloberViaSubgraph);
    expect(url).toBe(CLOBER_SUBGRAPH_FALLBACK_URL);
    expect(asked).toEqual([CLOBER_SUBGRAPH_FALLBACK_URL]); // never fetched
  });

  it('reports a malformed SUBGRAPH_URL without quoting it', async () => {
    stubFetch({ [CLOBER_SUBGRAPH_FALLBACK_URL]: TOO_MANY });
    const err = await withCloberSubgraph(cloberSubgraphUrls(MALFORMED), discoverCloberViaSubgraph).catch((e: Error) => e);
    expect((err as Error).message).toBe('subgraph unavailable (SUBGRAPH_URL is not a valid URL; api.subgraph.ormilabs.com: subgraph 429)');
    expect((err as Error).message).not.toContain('secret');
  });

  it('names every endpoint and its failure when none answers', async () => {
    stubFetch({ [GOLDSKY]: NOT_FOUND, [CLOBER_SUBGRAPH_FALLBACK_URL]: TOO_MANY });
    await expect(withCloberSubgraph(cloberSubgraphUrls(GOLDSKY), discoverCloberViaSubgraph))
      .rejects.toThrow('subgraph unavailable (api.goldsky.com: subgraph 404; api.subgraph.ormilabs.com: subgraph 429)');
  });
});

describe('clober adapter discovery through the fallback', () => {
  it('is authoritative via the fallback, so a vault Take decodes instead of holding the tail', async () => {
    stubFetch({ [GOLDSKY]: NOT_FOUND, [CLOBER_SUBGRAPH_FALLBACK_URL]: BOOKS });
    const notes: string[] = [];
    const ctx = ctxWith(notes);
    const a = createCloberVaultAdapter();
    await a.discover(ctx);
    expect(notes).toContain('venue.discovery: Clober: subgraph discovery (2 vault book(s)) via fallback api.subgraph.ormilabs.com');
    const fills = await a.decode(ctx, { take: [TAKE_LOG], bmOpen: [], vaultOpen: [], router: [] } as any, () => 1_783_600_000_000, new Set());
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ venueId: 'clober-vault', market: 'MON/USDC' });
  });

  // A vault book known from LiquidityVault.Open but with no metadata yet sends
  // decode() to the by-id lookup. A primary that answers 200 WITHOUT the book
  // (an indexer behind the chain) must not end that lookup.
  const VAULT_OPEN = { args: { bookIdA: BigInt(VAULT_BOOKS[0].id), bookIdB: BigInt(VAULT_BOOKS[1].id) } };
  const EMPTY = () => json(200, { data: { books: [] } });

  it('retries the by-id lookup on the fallback when the primary answers without the book', async () => {
    const asked = stubFetch({ [GOLDSKY]: EMPTY, [CLOBER_SUBGRAPH_FALLBACK_URL]: BOOKS });
    const ctx = ctxWith([]);
    const a = createCloberVaultAdapter();
    await a.discover(ctx); // authoritative: the primary answered (no vault books yet)
    const fills = await a.decode(ctx, { take: [TAKE_LOG], bmOpen: [], vaultOpen: [VAULT_OPEN], router: [] } as any, () => 1_783_600_000_000, new Set());
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ venueId: 'clober-vault', market: 'MON/USDC' });
    expect(asked).toEqual([GOLDSKY, GOLDSKY, CLOBER_SUBGRAPH_FALLBACK_URL]); // discovery, by-id, by-id retry
  });

  it('holds the range when no endpoint has the book', async () => {
    stubFetch({ [GOLDSKY]: EMPTY, [CLOBER_SUBGRAPH_FALLBACK_URL]: EMPTY });
    const ctx = ctxWith([]);
    const a = createCloberVaultAdapter();
    await a.discover(ctx);
    await expect(a.decode(ctx, { take: [TAKE_LOG], bmOpen: [], vaultOpen: [VAULT_OPEN], router: [] } as any, () => 0, new Set()))
      .rejects.toThrow(`subgraph unavailable (api.goldsky.com: missing metadata for vault book ${VAULT_BOOKS[0].id}; api.subgraph.ormilabs.com: missing metadata for vault book ${VAULT_BOOKS[0].id})`);
  });

  it('when every endpoint fails, says why and still holds a range with a Take', async () => {
    stubFetch({ [GOLDSKY]: NOT_FOUND, [CLOBER_SUBGRAPH_FALLBACK_URL]: TOO_MANY });
    const notes: string[] = [];
    const ctx = ctxWith(notes);
    const a = createCloberVaultAdapter();
    await a.discover(ctx);
    expect(notes[0]).toBe('venue.discovery.degraded: Clober: subgraph discovery failed (subgraph unavailable (api.goldsky.com: subgraph 404; api.subgraph.ormilabs.com: subgraph 429)); trying recent Open logs');
    await expect(a.decode(ctx, { take: [TAKE_LOG], bmOpen: [], vaultOpen: [], router: [] } as any, () => 0, new Set()))
      .rejects.toThrow('authoritative vault-book discovery unavailable');
  });
});
