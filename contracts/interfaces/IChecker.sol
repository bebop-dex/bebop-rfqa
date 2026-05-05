// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IChecker {
    function checkAndGetFee(
        address user,
        address receiver,
        address msgSender,
        bytes calldata extraInfo
    ) external view returns (uint256);
}
