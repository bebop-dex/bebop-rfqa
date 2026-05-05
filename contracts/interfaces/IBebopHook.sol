// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice A single swap leg between taker and maker
struct Swap {
    uint256 takerAmount;
    address takerToken;
    uint256 makerAmount;
    address makerToken;
}

interface IBebopHook {
    /// @notice Called by BebopRouter during hook execution
    /// @param data Arbitrary data passed through from the Hook struct
    /// @param swaps All swap legs for this hook's maker, scaled to the filled amount
    function bebopHook(bytes calldata data, Swap[] calldata swaps) external;
}
