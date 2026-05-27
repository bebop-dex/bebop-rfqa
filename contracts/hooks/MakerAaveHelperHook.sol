// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeTransferLib} from "../external-libs/SafeTransferLib.sol";
import {IBebopHook, Swap} from "../interfaces/IBebopHook.sol";
import {IAavePool} from "./IAavePool.sol";

/// @title MakerAaveHelperHook
/// @notice Shared maker-side hook — any maker can use this single deployment to JIT-supply
///         underlying into Aave V3 and have the resulting aToken delivered to their own
///         wallet, ready for the PMM to pull.
///
/// Flow per call:
///   1. Sum the maker's outgoing aToken amounts across swap legs (legs whose `makerToken`
///      doesn't match the hook's configured aToken are ignored).
///   2. Query Aave's current `liquidityIndex` for the reserve and compute a dynamic buffer
///      that covers the worst-case `rayDiv`+`rayMul` rounding loss in the supply flow.
///   3. Pull (aTokenAmount + buffer) of `underlying` from `makerAddress` (the maker must
///      have pre-approved this contract).
///   4. Supply that amount to Aave V3; aToken minted to this contract.
///   5. Sanity-check the resulting aToken balance covers `aTokenAmount`; revert otherwise.
///   6. Transfer exactly `aTokenAmount` aToken to `makerAddress` so PMM can take it.
///
///
/// Security:
///   - `onlyRouter` modifier — only the configured BebopRouter can invoke.
///   - `makerAddress` is supplied by the router from `Hook.flags.makerAddress` (not from
///     `data`), so malicious `data` cannot trick the hook into pulling funds from a
///     different maker.
///   - The router validates the maker's EIP-712 hook signature before invoking, so
///     `swaps[]` matches what the maker authorized.
///   - The router separately blocks raw-call hooks whose calldata starts with the
///     `bebopHook` selector (`HookLib.BebopHookSelectorBanned`), so this entrypoint can
///     only ever be reached through the maker-signed bebopHook path.
contract MakerAaveHelperHook is IBebopHook {
    using SafeTransferLib for IERC20;

    error OnlyRouter();
    error ZeroAmount();
    /// @notice Aave's supply produced less aToken than the maker needs.
    ///         Safety net: should not trigger given the dynamic buffer below, but kept
    ///         in case Aave's accounting changes or an extreme index pushes loss past it.
    error InsufficientATokenMinted(uint256 aBalance, uint256 needed);

    /// @dev Aave V3 fixed-point unit for `liquidityIndex` (1e27).
    uint256 internal constant RAY = 1e27;

    /// @notice The BebopRouter permitted to call this hook. Immutable.
    address public immutable router;

    constructor(address router_) {
        router = router_;
    }

    modifier onlyRouter() {
        require(msg.sender == router, OnlyRouter());
        _;
    }

    /// @notice Maker-signed hook entrypoint.
    /// @param makerAddress Maker for whom we're supplying liquidity. From `Hook.flags.makerAddress`.
    /// @param data         abi.encode(address underlying, address aToken, address aavePool)
    /// @param swaps        Scaled swap legs for this maker.
    function bebopHook(
        address makerAddress,
        bytes calldata data,
        Swap[] calldata swaps
    ) external override onlyRouter {
        (address underlying, address aToken, address aavePool) = abi.decode(data, (address, address, address));

        // Sum maker outflow for the configured aToken. Legs that don't match are skipped —
        // useful when a maker's swap mixes aTokens or has non-aToken legs.
        uint256 aTokenAmount;
        for (uint256 i; i < swaps.length; ++i) {
            if (swaps[i].makerToken == aToken) {
                aTokenAmount += swaps[i].makerAmount;
            }
        }
        require(aTokenAmount != 0, ZeroAmount());

        uint256 currentIndex = IAavePool(aavePool).getReserveNormalizedIncome(underlying);
        uint256 buffer = currentIndex / RAY + 1;
        uint256 underlyingNeeded = aTokenAmount + buffer;

        // Pull underlying from maker (maker has pre-approved this contract).
        IERC20(underlying).safeTransferFrom(makerAddress, address(this), underlyingNeeded);

        // Lazy Aave Pool approval. safeApproveWithRetry handles USDT-style tokens that
        // require a 0-reset before re-approval.
        if (IERC20(underlying).allowance(address(this), aavePool) < underlyingNeeded) {
            IERC20(underlying).safeApproveWithRetry(aavePool, type(uint256).max);
        }

        // Supply to Aave; aToken minted to this contract (= onBehalfOf).
        IAavePool(aavePool).supply(underlying, underlyingNeeded, address(this), 0);

        // Sanity check: post-supply balance must cover the maker's requested amount.
        // The dynamic buffer above is sized to keep this true under Aave's documented
        // rounding; this check fails fast if assumptions ever change.
        uint256 aBalance = IERC20(aToken).balanceOf(address(this));
        require(aBalance >= aTokenAmount, InsufficientATokenMinted(aBalance, aTokenAmount));

        // Forward exactly `aTokenAmount` aToken to the maker. Any rounding remainder
        // stays in the contract.
        IERC20(aToken).safeTransfer(makerAddress, aTokenAmount);
    }
}
