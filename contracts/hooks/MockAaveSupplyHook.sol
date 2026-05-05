// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockAToken} from "./MockAToken.sol";

/// @notice Mock post-hook: wraps underlying → aToken on router (1:1).
///         data = abi.encode(address aToken)
///         Router must approve this contract to spend underlying (via needsApproval).
contract MockAaveSupplyHook {
    fallback() external {
        address aToken = abi.decode(msg.data, (address));
        address router = msg.sender;
        address underlying = address(MockAToken(aToken).underlying());

        uint256 amount = IERC20(underlying).balanceOf(router);
        if (amount == 0) return;

        // Pull underlying from router
        IERC20(underlying).transferFrom(router, address(this), amount);
        // Approve aToken contract and deposit
        IERC20(underlying).approve(aToken, amount);
        MockAToken(aToken).deposit(amount, router);
    }
}
