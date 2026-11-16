import type { Pair } from '@shared';
import { ASSETS } from '@shared';

/**
 * Which on-chain tokens a registered pair trades.
 *
 * A pool that holds many assets and names both tokens in its swap event
 * (ThogAMM, WOOFi, BTR) maps a fill to its market by token pair, not by pool.
 * The rule that turns a registered pair into its two tokens has one exception
 * (cbBTC), and it lives here so the adapters cannot drift apart on it: a copy
 * that missed a change would book a wrapper's fills on the wrong market.
 */

/** The TOKENS keys [base, quote] of a registered pair, or undefined when the
 *  registry cannot name both. */
export function tokenKeysForPair(pair: Pair): readonly [string, string] | undefined {
  // cbBTC is an alternative BTC wrapper, so its market symbol—not Pair.base—
  // selects the on-chain token. The same rule handles the WBTC/cbBTC cross.
  const baseKey = pair.symbol.startsWith('cbBTC/') ? 'CBBTC' : ASSETS[pair.base]?.token;
  const quoteKey = pair.symbol.endsWith('/cbBTC')
    ? 'CBBTC'
    : pair.quoteKind === 'asset'
      ? ASSETS[pair.quote]?.token
      : pair.quote;
  return baseKey && quoteKey ? [baseKey, quoteKey] : undefined;
}

/** Direction-free key for two token addresses: a swap names them either way round. */
export const pairKey = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join(':');
