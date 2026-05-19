// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Swap} from "../interfaces/IBebopHook.sol";
import {MockMintableToken} from "./MockMintableToken.sol";

/// @notice Mock maker hook: mints tokens based on swap info.
///         Called via bebopHook(data, swaps) with includeSwapInfo=true.
///         Mints swaps[0].makerAmount of the token to the specified address.
///         data = abi.encode(address mintTo)
///         Maker signs this hook to authorize the mint.
contract MockMakerMintHook {
    /// @notice Called by router as bebopHook(makerAddress, data, swaps)
    function bebopHook(address /*makerAddress*/, bytes calldata data, Swap[] calldata swaps) external {
        address mintTo = abi.decode(data, (address));
        // Mint each maker token from the swap legs
        for (uint256 i; i < swaps.length; i++) {
            if (swaps[i].makerAmount > 0) {
                MockMintableToken(swaps[i].makerToken).mint(mintTo, swaps[i].makerAmount);
            }
        }
    }
}
