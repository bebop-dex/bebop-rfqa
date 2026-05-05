// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IBebopHook, Swap} from "../interfaces/IBebopHook.sol";
import "../Errors.sol";

struct Hook {
    address targetContract;
    bytes data;
    bytes hookSignature;    // empty if makerAddress == address(0)
    /// @dev Packed flags:
    ///   bits 0-159:  makerAddress — address(0) = no signature verification
    ///   bit 160:     postHook — true = execute after swap, false = before swap
    ///   bit 161:     revertOnFail — true = revert whole swap if hook fails
    ///   bit 162:     useBebopHook — true = call bebopHook(data, Swap[]) with scaled swap legs, false = raw call with data
    ///   bit 163:     needsApproval — true = router approves targetContract before calling
    ///                                pre-hook: approve fromToken for newFromAmount
    ///                                post-hook: approve pmmToToken for current balance
    uint256 flags;
}

library HookLib {

    // EIP-712 type for hook signing
    bytes32 internal constant HOOK_SIGN_TYPE_HASH = keccak256(
        "BebopHook(address targetContract,bytes32 dataHash,uint256 makerNonce,uint256 flags)"
    );

    // --- Flag bit positions ---
    uint256 private constant POST_HOOK_BIT = 160;
    uint256 private constant REVERT_ON_FAIL_BIT = 161;
    uint256 private constant USE_BEBOP_HOOK_BIT = 162;
    uint256 private constant NEEDS_APPROVAL_BIT = 163;

    // --- Flag getters ---

    function getMakerAddress(Hook calldata hook) internal pure returns (address) {
        return address(uint160(hook.flags));
    }

    function isPostHook(Hook calldata hook) internal pure returns (bool) {
        return (hook.flags >> POST_HOOK_BIT) & 1 == 1;
    }

    function isRevertOnFail(Hook calldata hook) internal pure returns (bool) {
        return (hook.flags >> REVERT_ON_FAIL_BIT) & 1 == 1;
    }

    function useBebopHook(Hook calldata hook) internal pure returns (bool) {
        return (hook.flags >> USE_BEBOP_HOOK_BIT) & 1 == 1;
    }

    function isNeedsApproval(Hook calldata hook) internal pure returns (bool) {
        return (hook.flags >> NEEDS_APPROVAL_BIT) & 1 == 1;
    }

    /// @notice EIP-712 struct hash of a hook. Used for both hooksHash and maker signature verification.
    function hookHash(Hook calldata hook, uint256 makerNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            HOOK_SIGN_TYPE_HASH,
            hook.targetContract,
            keccak256(hook.data),
            makerNonce,
            hook.flags
        ));
    }

    function hooksHash(
        Hook[] calldata hooks,
        address[] memory makerAddresses,
        uint256[] memory makerNonces
    ) internal pure returns (bytes32) {
        require(makerAddresses.length == makerNonces.length, HookMakerArrayLengthMismatch());
        if (hooks.length == 0) return bytes32(0);

        bytes32[] memory hashes = new bytes32[](hooks.length);
        for (uint256 i; i < hooks.length; ++i) {
            uint256 nonce = 0;
            address maker = getMakerAddress(hooks[i]);
            if (maker != address(0)) {
                for (uint256 j; j < makerAddresses.length; ++j) {
                    if (makerAddresses[j] == maker) {
                        nonce = makerNonces[j];
                        break;
                    }
                }
                require(nonce != 0, HookMakerNonceNotFound());
            }
            hashes[i] = hookHash(hooks[i], nonce);
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @notice Execute hooks for a given phase, providing each hook with its maker's
    ///         full set of swap legs scaled proportionally to the filled amount.
    function executeHooks(
        Hook[] calldata hooks,
        bool postHookPhase,
        address[] memory makerAddresses,
        Swap[][] memory makerSwapLegs,
        uint256 originalFromAmount,
        uint256 filledFromAmount
    ) internal {
        for (uint256 i; i < hooks.length; ++i) {
            if (isPostHook(hooks[i]) != postHookPhase) continue;

            bool success;
            if (useBebopHook(hooks[i])) {
                Swap[] memory scaledSwaps = _buildScaledSwaps(
                    getMakerAddress(hooks[i]), makerAddresses, makerSwapLegs,
                    originalFromAmount, filledFromAmount
                );
                try IBebopHook(hooks[i].targetContract).bebopHook(
                    hooks[i].data,
                    scaledSwaps
                ) {
                    success = true;
                } catch {
                    success = false;
                }
            } else {
                (success,) = hooks[i].targetContract.call(hooks[i].data);
            }

            require(success || !isRevertOnFail(hooks[i]), HookExecutionFailed());
        }
    }

    /// @dev Find maker index, copy their swap legs, scale all amounts by filledFromAmount/originalFromAmount
    function _buildScaledSwaps(
        address makerAddress,
        address[] memory makerAddresses,
        Swap[][] memory makerSwapLegs,
        uint256 originalFromAmount,
        uint256 filledFromAmount
    ) private pure returns (Swap[] memory) {
        uint256 makerIdx = type(uint256).max;
        for (uint256 i; i < makerAddresses.length; ++i) {
            if (makerAddresses[i] == makerAddress) {
                makerIdx = i;
                break;
            }
        }
        if (makerIdx == type(uint256).max) {
            return new Swap[](0);
        }

        Swap[] memory legs = makerSwapLegs[makerIdx];
        Swap[] memory scaled = new Swap[](legs.length);
        for (uint256 j; j < legs.length; ++j) {
            scaled[j] = Swap({
                takerAmount: (legs[j].takerAmount * filledFromAmount) / originalFromAmount,
                takerToken: legs[j].takerToken,
                makerAmount: (legs[j].makerAmount * filledFromAmount) / originalFromAmount,
                makerToken: legs[j].makerToken
            });
        }
        return scaled;
    }
}
