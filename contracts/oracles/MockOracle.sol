// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IOracle} from "../interfaces/IOracle.sol";

/// @notice Returns slippage value encoded in extraInfo (first uint256).
///         If extraInfo is empty or too short, returns 0.
contract MockOracle is IOracle {
    function getSlippage(
        address,
        address,
        uint256,
        uint256,
        bytes calldata extraInfo
    ) external pure override returns (uint256) {
        if (extraInfo.length < 64) return 0;
        // extraInfo layout: [uint256 feeUnits, uint256 slippageUnits, ...]
        return abi.decode(extraInfo[32:64], (uint256));
    }
}
