// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockAToken} from "./MockAToken.sol";

/// @notice Mock pre-hook: unwraps aToken → underlying on router (1:1).
///         data = abi.encode(address aToken)
///         Router must approve this contract to spend aToken (via needsApproval).
contract MockAaveWithdrawHook {
    fallback() external {
        address aToken = abi.decode(msg.data, (address));
        address router = msg.sender;

        uint256 amount = IERC20(aToken).balanceOf(router);
        if (amount == 0) return;

        // Pull aToken from router
        IERC20(aToken).transferFrom(router, address(this), amount);
        // Burn aToken, get underlying sent to router
        MockAToken(aToken).withdraw(amount, router);
    }
}
