import { parseAbi } from 'viem';

/**
 * Verified ABI fragments (verified on-chain). Human-readable form — viem parses
 * structs from the inline tuple syntax.
 */

// Clober V2 — BookManager (core events)
export const bookManagerAbi = parseAbi([
  'event Take(uint192 indexed bookId, address indexed user, int24 tick, uint64 unit)',
  'event Open(uint192 indexed id, address indexed base, address indexed quote, uint64 unitSize, uint24 makerPolicy, uint24 takerPolicy, address hooks)',
  'event Make(uint192 indexed bookId, address indexed user, int24 tick, uint256 orderIndex, uint64 unit, address provider)',
  // a book's immutable key; all zero for an id that was never opened
  'function getBookKey(uint192 id) view returns ((address base, uint64 unitSize, address quote, uint24 makerPolicy, address hooks, uint24 takerPolicy))',
]);

// Clober V2 — BookViewer (quoting)
export const bookViewerAbi = parseAbi([
  'function getExpectedOutput((uint192 id, uint256 limitPrice, uint256 baseAmount, uint256 minQuoteAmount, bytes hookData) params) view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount)',
  'function getExpectedInput((uint192 id, uint256 limitPrice, uint256 quoteAmount, uint256 maxBaseAmount, bytes hookData) params) view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount)',
]);

// Clober V2 — RouterGateway (routed flow)
export const routerGatewayAbi = parseAbi([
  'event Swap(address indexed user, address indexed inToken, address indexed outToken, uint256 amountIn, uint256 amountOut, address router, bytes4 method)',
]);

// Clober V2 — LiquidityVault (propAMM-cut tagging)
export const liquidityVaultAbi = parseAbi([
  'event Open(bytes32 indexed key, uint192 indexed bookIdA, uint192 indexed bookIdB, bytes32 salt, address strategy)',
  // a vault book's mirror, 0 for any other book: written only by open(), never
  // cleared (clober-dex/clober-liquidity-vault src/LiquidityVault.sol)
  'function bookPair(uint192 bookId) view returns (uint192)',
]);

// Clober V2 — SimpleOracleStrategy (clober-dex/clober-liquidity-vault
// src/SimpleOracleStrategy.sol). updatePosition is onlyOperator: the keeper
// pushes the oracle price + ticks in calldata and the vault's book orders are
// re-placed in the same tx — one event per quote update (QUOTE_UPDATE_BURN).
// Tick is a wrapped int24; the emitted rate widens to uint256 (topic0 verified
// against live logs: 0x6bfe82e0…18f9).
export const simpleOracleStrategyAbi = parseAbi([
  'event UpdatePosition(bytes32 indexed key, uint256 oraclePrice, int24 tickA, int24 tickB, uint256 rate)',
]);

export const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** Clober walk-whole-book sentinel (docs/architecture.md: quote poller). */
export const CLOBER_MIN_PRICE = 1350587n;
