// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

interface PriceProvider {
    function getBidAndAskPrice() external view returns (uint128, uint128);
}

interface MetricRouter {
    function quoteSwap(address, bool, int128, uint128, uint128, uint128)
        external returns (int128, int128);
}

/// Constructor-only eth_call: no deployment, storage, or funds are required.
/// An oracle is read once per pool; a failed leg cannot discard another quote.
contract MetricQuoteBatch {
    struct Leg { bool zeroForOne; int128 amount; uint128 limit; }
    struct Pool { address pool; address provider; Leg[] legs; }
    struct Result { bool success; int128 amount0Delta; int128 amount1Delta; }

    constructor(address router, Pool[] memory pools) {
        uint256 count;
        for (uint256 i; i < pools.length; ++i) count += pools[i].legs.length;
        Result[] memory results = new Result[](count);
        uint256 index;
        for (uint256 i; i < pools.length; ++i) {
            Pool memory pool = pools[i];
            try PriceProvider(pool.provider).getBidAndAskPrice() returns (uint128 bid, uint128 ask) {
                for (uint256 j; j < pool.legs.length; ++j) {
                    Leg memory leg = pool.legs[j];
                    try MetricRouter(router).quoteSwap(pool.pool, leg.zeroForOne, leg.amount, leg.limit, bid, ask)
                        returns (int128 d0, int128 d1) {
                        results[index + j] = Result(true, d0, d1);
                    } catch {}
                }
            } catch {}
            index += pool.legs.length;
        }
        bytes memory output = abi.encode(results);
        assembly { return(add(output, 32), mload(output)) }
    }
}
