// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal Aave V3 Pool interface.
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    /// @notice Returns the reserve normalized income (current liquidity index) in RAY (1e27).
    ///         For a fresh reserve = RAY; grows as interest accrues to suppliers.
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
}
