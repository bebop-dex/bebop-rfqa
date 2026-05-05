// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IOracle} from "../interfaces/IOracle.sol";
import {IUniswapV3Pool} from "./pool-interfaces/IUniswapV3Pool.sol";
import {IUniswapV2Pair} from "./pool-interfaces/IUniswapV2Pair.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BebopOracle
/// @notice Computes onchain mid price from Uni V2/V3 pools and returns slippage
///         based on drift from an offchain price snapshot encoded in extraInfo.
///         Stateless, no admin — redeploy when new pool types are added.
///
///         Prices are in "token1_full per token0_full, scaled 1e18" — i.e., normalized
///         by each pool's token decimals so both directions remain representable even for
///         asymmetric pairs (e.g. 18-dec low-priced tokens vs 6-dec stablecoins).
contract BebopOracle is IOracle {

    /// @dev Pool returned zero for a token whose raw price is needed — dead pool, empty reserves,
    ///      or V3 pool at extreme tick where `sqrtPrice²/2^128` underflows. Inversion on zero
    ///      would panic; we revert explicitly so callers can diagnose.
    error ZeroPriceFromPool();

    uint256 private constant UNIT_BASE = 1_000_000;
    uint256 private constant PRICE_SCALE = 1e18;
    uint256 private constant PRICE_SCALE_SQ = 1e36;
    uint256 private constant POOL_INFO_SIZE = 48;

    uint8 private constant POOL_UNI_V3 = 0;
    uint8 private constant POOL_UNI_V2 = 1;

    // ==================== IOracle ====================

    /// @notice Compute slippage by comparing offchain mid price to current onchain mid price.
    /// @dev extraInfo layout:
    ///      [0:32]   uint256 offchainMidPrice (from_full per to_full, scaled 1e18)
    ///      [32:34]  uint16  minSlippage (units, 1 unit = 0.01 bps)
    ///      [34:36]  uint16  maxSlippage (units)
    ///      [36:37]  uint8   numPools
    ///      [37:]    PoolInfo[numPools] (48 bytes each, tightly packed)
    function getSlippage(
        address,
        address,
        uint256,
        uint256,
        bytes calldata extraInfo
    ) external view override returns (uint256) {
        uint256 offchainMidPrice = uint256(bytes32(extraInfo[:32]));
        uint16 minSlippage = uint16(bytes2(extraInfo[32:34]));
        uint16 maxSlippage = uint16(bytes2(extraInfo[34:36]));
        uint8 numPools = uint8(extraInfo[36]);
        bytes calldata poolData = extraInfo[37:];

        uint256 currentPrice = _computeMidPrice(poolData, numPools);

        // Price improved or unchanged — no slippage
        if (currentPrice >= offchainMidPrice) return 0;

        // diff = percentage drop in units
        uint256 diff = (offchainMidPrice - currentPrice) * UNIT_BASE / offchainMidPrice;

        if (diff <= uint256(minSlippage)) return 0;
        return diff < uint256(maxSlippage) ? diff : uint256(maxSlippage);
    }

    // ==================== getMidPrice ====================

    /// @notice Compute the current onchain mid price from pool data.
    /// @dev extraInfo layout:
    ///      [0:1]  uint8 numPools
    ///      [1:]   PoolInfo[numPools] (48 bytes each)
    /// @return midPrice from_full per to_full, scaled 1e18
    function getMidPrice(
        address,
        address,
        uint256,
        uint256,
        bytes calldata extraInfo
    ) external view returns (uint256 midPrice) {
        uint8 numPools = uint8(extraInfo[0]);
        midPrice = _computeMidPrice(extraInfo[1:], numPools);
    }

    /// @notice Batch variant of getMidPrice — computes a mid price for each extraInfo entry.
    ///         Useful offchain for fetching prices across many pairs in one RPC round-trip.
    /// @param extraInfos Array of extraInfo payloads (same format as getMidPrice)
    /// @return prices Mid prices in the same order as inputs (each from_full per to_full, scaled 1e18)
    function getMidPrices(bytes[] calldata extraInfos) external view returns (uint256[] memory prices) {
        uint256 n = extraInfos.length;
        prices = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            bytes calldata ei = extraInfos[i];
            uint8 numPools = uint8(ei[0]);
            prices[i] = _computeMidPrice(ei[1:], numPools);
        }
    }

    // ==================== Internal ====================

    /// @dev Compute mid price from tightly-packed pool data.
    ///      Direct pools (middleToken=0x0) each produce one from→to price.
    ///      Middle-token pools are grouped by middleToken: avg(from→middle) × avg(middle→to) per group.
    ///      All prices are averaged together.
    ///
    /// PoolInfo (48 bytes):
    ///   [ 0]   uint8   poolType     (0=UniV3, 1=UniV2)
    ///   [ 1]   uint8   tokenConfig  (0-5, see _getOrientedPrice)
    ///   [ 2]   uint8   dec0         (pool.token0 decimals)
    ///   [ 3]   uint8   dec1         (pool.token1 decimals)
    ///   [ 4: 8] uint32 poolFee
    ///   [ 8:28] address pool
    ///   [28:48] address middleToken (0x0 for direct pools)
    function _computeMidPrice(
        bytes calldata poolData,
        uint8 numPools
    ) internal view returns (uint256) {
        uint256 priceSum;
        uint256 priceCount;

        // Collect direct pool prices
        for (uint8 i; i < numPools; ++i) {
            (, address middleToken) = _parsePoolMeta(poolData, i);
            if (middleToken == address(0)) {
                priceSum += _getOrientedPrice(poolData, i);
                ++priceCount;
            }
        }

        // Process middle-token groups (O(n²) — numPools is small)
        for (uint8 i; i < numPools; ++i) {
            (, address middleToken) = _parsePoolMeta(poolData, i);
            if (middleToken == address(0)) continue;

            bool alreadyProcessed;
            for (uint8 j; j < i; ++j) {
                (, address prevMiddle) = _parsePoolMeta(poolData, j);
                if (prevMiddle == middleToken) { alreadyProcessed = true; break; }
            }
            if (alreadyProcessed) continue;

            uint256 fromMiddleSum;
            uint256 fromMiddleCount;
            uint256 middleToSum;
            uint256 middleToCount;

            for (uint8 k; k < numPools; ++k) {
                (uint8 tokenConfig, address mt) = _parsePoolMeta(poolData, k);
                if (mt != middleToken) continue;

                uint256 price = _getOrientedPrice(poolData, k);
                if (tokenConfig == 2 || tokenConfig == 3) {
                    fromMiddleSum += price;
                    ++fromMiddleCount;
                } else if (tokenConfig == 4 || tokenConfig == 5) {
                    middleToSum += price;
                    ++middleToCount;
                }
            }

            if (fromMiddleCount > 0 && middleToCount > 0) {
                uint256 avgFromMiddle = fromMiddleSum / fromMiddleCount;
                uint256 avgMiddleTo = middleToSum / middleToCount;
                priceSum += Math.mulDiv(avgFromMiddle, avgMiddleTo, PRICE_SCALE);
                ++priceCount;
            }
        }

        return priceCount > 0 ? priceSum / priceCount : 0;
    }

    /// @dev Parse tokenConfig and middleToken from pool at index i.
    function _parsePoolMeta(
        bytes calldata poolData,
        uint8 i
    ) internal pure returns (uint8 tokenConfig, address middleToken) {
        uint256 offset = uint256(i) * POOL_INFO_SIZE;
        tokenConfig = uint8(poolData[offset + 1]);
        assembly {
            middleToken := shr(96, calldataload(add(add(poolData.offset, offset), 28)))
        }
    }

    /// @dev Read pool price (decimal-normalized), oriented by tokenConfig.
    ///      tokenConfig semantics (from caller's from/to perspective):
    ///        0: t0=from, t1=to     → invert (want from_per_to)
    ///        1: t0=to,   t1=from   → direct
    ///        2: t0=from, t1=middle → invert (want from_per_middle)
    ///        3: t0=middle, t1=from → direct
    ///        4: t0=middle, t1=to   → invert (want middle_per_to)
    ///        5: t0=to, t1=middle   → direct
    function _getOrientedPrice(
        bytes calldata poolData,
        uint8 i
    ) internal view returns (uint256) {
        uint256 offset = uint256(i) * POOL_INFO_SIZE;
        uint8 poolType = uint8(poolData[offset]);
        uint8 tokenConfig = uint8(poolData[offset + 1]);
        uint8 dec0 = uint8(poolData[offset + 2]);
        uint8 dec1 = uint8(poolData[offset + 3]);

        address pool;
        assembly {
            pool := shr(96, calldataload(add(add(poolData.offset, offset), 8)))
        }

        // rawPrice = token1_full per token0_full, scaled 1e18 (decimal-normalized)
        uint256 rawPrice = poolType == POOL_UNI_V3
            ? _getUniV3Price(pool, dec0, dec1)
            : _getUniV2Price(pool, dec0, dec1);

        require(rawPrice != 0, ZeroPriceFromPool());

        // Even tokenConfig → invert, odd → direct
        return (tokenConfig & 1 == 0)
            ? PRICE_SCALE_SQ / rawPrice
            : rawPrice;
    }

    /// @dev Read Uniswap V3 pool price, decimal-normalized.
    ///      Returns token1_full / token0_full scaled 1e18.
    ///      Raw formula (per-raw-amount): sqrtPriceX96² × 1e18 / 2¹⁹²
    ///      Full formula: rawPerRaw × 10^(dec0 - dec1) — folded into mulDiv.
    function _getUniV3Price(address pool, uint8 dec0, uint8 dec1) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 sp = uint256(sqrtPriceX96);
        // step = sqrtPrice² / 2^128 (max ~2^192, fits uint256)
        uint256 step = Math.mulDiv(sp, sp, 1 << 128);
        // Want: step * 1e18 * 10^(dec0-dec1) / 2^64
        if (dec0 >= dec1) {
            uint256 num = PRICE_SCALE * (10 ** uint256(dec0 - dec1));
            return Math.mulDiv(step, num, 1 << 64);
        } else {
            uint256 den = (1 << 64) * (10 ** uint256(dec1 - dec0));
            return Math.mulDiv(step, PRICE_SCALE, den);
        }
    }

    /// @dev Read Uniswap V2 pair price, decimal-normalized.
    ///      Returns token1_full / token0_full scaled 1e18.
    function _getUniV2Price(address pool, uint8 dec0, uint8 dec1) internal view returns (uint256) {
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pool).getReserves();
        // Want: reserve1 * 1e18 * 10^(dec0-dec1) / reserve0
        if (dec0 >= dec1) {
            uint256 num = PRICE_SCALE * (10 ** uint256(dec0 - dec1));
            return Math.mulDiv(uint256(reserve1), num, uint256(reserve0));
        } else {
            uint256 den = uint256(reserve0) * (10 ** uint256(dec1 - dec0));
            return Math.mulDiv(uint256(reserve1), PRICE_SCALE, den);
        }
    }
}
