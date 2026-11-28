import { TOKENS, ASSETS, PAIRS, pairFor, assetForToken, wrapBasisFor, cexForBase, baseTokenOf, isMonAddress } from '@shared';

/**
 * The registry helpers' answers for every input that matters: every base ×
 * quote, every token address (plus an unknown one and a case variant), every
 * pair's basis, every asset's exchange. The Rust service's registry
 * (service/crates/registry) is tested against these answers, so the two
 * implementations of the same lookups cannot drift.
 */
export function registryGolden() {
  const quotes = [...new Set([...Object.keys(TOKENS), ...Object.keys(ASSETS), ...PAIRS.map((p) => p.quote)])];
  return {
    pairFor: Object.keys(ASSETS).flatMap((b) => quotes.map((q) => [b, q, pairFor(b, q)?.symbol ?? null])),
    assetForToken: [...Object.values(TOKENS).map((t) => t.address), '0x0000000000000000000000000000000000000001',
      TOKENS.WBTC.address.toUpperCase().replace('0X', '0x')].map((a) => [a, assetForToken(a)?.key ?? null]),
    wrapBasisFor: PAIRS.map((p) => [p.symbol, wrapBasisFor(p) ?? null]),
    cexForBase: [...Object.keys(ASSETS), 'NOPE'].map((b) => [b, cexForBase(b)]),
    baseTokenOf: Object.keys(ASSETS).map((b) => [b, baseTokenOf(b)?.symbol ?? null]),
    isMonAddress: Object.values(TOKENS).map((t) => [t.address, isMonAddress(t.address)]),
  };
}
