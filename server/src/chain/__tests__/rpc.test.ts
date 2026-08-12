import { describe, expect, it } from 'vitest';
import { monad, publicClient } from '../rpc.js';

/**
 * Head freshness is load-bearing for both quote labels and the head-minus-five
 * fill cursor. These are configuration assertions only: importing the client
 * instantiates its transport but never touches the network.
 */
describe('Monad RPC client timing', () => {
  it('declares Monad block timing and never caches the live head', () => {
    expect(monad.blockTime).toBe(400);
    expect(publicClient.cacheTime).toBe(0);
  });
});
