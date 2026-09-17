// Registry addresses must survive viem's ABI address encoder (2026-09-16
// outage, PR #105): TOKENS.XAUT0 shipped an invalid EIP-55 checksum, viem's
// encodeAbiParameters threw InvalidAddressError, and inside
// multicall(allowFailure) that surfaced as a per-leg "returned no data"
// failure indistinguishable from a revert — POE's fail-closed discovery threw
// on it and the held tail OOM-crash-looped prod for 7h. The existing venue
// tests lowercase-compare addresses and mock multicalls, so none of them
// could catch a checksum regression; this locks the real contract instead.
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import { TOKENS, ADDR } from '@shared';

const PROBE = parseAbi(['function probe(address token) view returns (bool)']);

const entries: readonly (readonly [string, string])[] = [
  ...Object.entries(TOKENS).map(([k, t]) => [`${k} (${t.symbol})`, t.address] as const),
  ...Object.entries(ADDR).map(([k, a]) => [`ADDR.${k}`, a] as const),
];

describe('registry addresses are ABI-encodable', () => {
  it('every registered address is lowercase or matches its EIP-55 checksum', () => {
    // getAddress(lowercased) never throws and returns the canonical checksum.
    // Lowercase is fine by itself; a mixed-case entry that disagrees with its
    // checksum is the exact poison above (viem rejects it at encode time).
    for (const [label, addr] of entries) {
      expect(addr === addr.toLowerCase() || addr === getAddress(addr.toLowerCase()), `${label}: ${addr}`).toBe(true);
    }
  });

  it('a call arg built from each address encodes — the exact viem path adapters use', () => {
    for (const [label, addr] of entries) {
      expect(
        () => encodeFunctionData({ abi: PROBE, functionName: 'probe', args: [addr as `0x${string}`] }),
        `${label}: ${addr}`,
      ).not.toThrow();
    }
  });
});
