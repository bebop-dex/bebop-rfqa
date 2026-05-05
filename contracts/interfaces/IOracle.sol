// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IOracle {
    function getSlippage(
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 toAmount,
        bytes calldata extraInfo
    ) external view returns (uint256);
}
