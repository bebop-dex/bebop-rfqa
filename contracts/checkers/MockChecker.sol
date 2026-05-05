// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IChecker} from "../interfaces/IChecker.sol";

/// @notice Returns fee value encoded in extraInfo (first uint256).
///         If extraInfo is empty or too short, returns 0.
contract MockChecker is IChecker {
    function checkAndGetFee(
        address,
        address,
        address,
        bytes calldata extraInfo
    ) external pure override returns (uint256) {
        if (extraInfo.length < 32) return 0;
        return abi.decode(extraInfo[:32], (uint256));
    }
}
