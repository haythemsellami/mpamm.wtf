import { describe, expect, it } from 'vitest';
import { pinQuoteRequest } from '../quote-block.js';
const block = { number: 123n, hash: `0x${'a'.repeat(64)}` as const, generation: 0 };

describe('proposal-pinned state reads', () => {
  it.each(['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getStorageAt'])('pins %s without mutating the adapter arguments', (method) => {
    const params = method === 'eth_getStorageAt' ? ['0xaddress', '0xslot', '0x7b'] : ['0xaddress', '0x7b'];
    const original = [...params];
    const result = pinQuoteRequest({ method, params }, block);
    expect((result.params as unknown[]).at(-1)).toEqual({ blockHash: block.hash, requireCanonical: false });
    expect(params).toEqual(original);
  });
  it.each(['latest', '0x7c', undefined])('rejects an unpinned or conflicting adapter block (%s)', (selected) => {
    expect(() => pinQuoteRequest({ method: 'eth_call', params: [{}, selected] }, block)).toThrow('RPC pool changed');
  });
});
