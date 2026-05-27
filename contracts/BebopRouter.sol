// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BebopRouterOrder, BebopRouterOrderLib} from "./libraries/BebopRouterOrderLib.sol";
import {Hook, HookLib} from "./libraries/HookLib.sol";
import {Swap} from "./interfaces/IBebopHook.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {IChecker} from "./interfaces/IChecker.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {BebopValidation} from "./base/BebopValidation.sol";
import {BebopPmmHelper} from "./base/BebopPmmHelper.sol";
import "./Errors.sol";

contract BebopRouter is Ownable, ReentrancyGuardTransient, BebopValidation, BebopPmmHelper {
    using SafeTransferLib for IERC20;
    using BebopRouterOrderLib for BebopRouterOrder;

    // --- Constants ---
    /// @dev 1 unit = 0.01 bps (0.0001%).  UNIT_BASE (1_000_000) = 100%.
    uint256 private constant UNIT_BASE = 1_000_000;
    /// @dev Sentinel address for native token (e.g. ETH)
    address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // --- State ---
    address public immutable protocolTreasury;
    address public routerSigner;
    IPermit2 public immutable permit2;
    IWETH public immutable wrappedNativeToken;

    // --- Intermediate structs ---
    struct AmountCalc {
        uint256 newFromAmount;
        uint256 newToAmount;
        uint256 toAmountAfterFeeSlippage;
        uint256 feeAmount;       // theoretical (from newToAmount), used for events only
        uint256 slippageAmount;  // theoretical (from newToAmount), used for events only
        uint256 feeRate;         // raw rate in units, for recomputing from actual balance
        uint256 slippageRate;    // raw rate in units, for recomputing from actual balance
        bool isExactOut;         // true for exactOut: receiver is owed exactly toAmountAfterFeeSlippage
    }

    // --- Events ---

    /// @notice Emitted once per swap leg per maker, showing the maker's real balance change
    event BebopPmmSwap(
        address indexed makerAddress,
        uint128 indexed eventId,
        uint256 indexed routerNonce,
        uint256 makerNonce,
        address takerToken,
        address makerToken,
        uint256 takerAmount,
        uint256 makerAmount,        // real maker balance change: amount after slippage and refund
        uint256 makerAmountRefunded // amount of refund sent back to maker
    );

    /// @notice Emitted once per swap/settle call
    event BebopRouterSwap(
        uint128 indexed eventId,
        uint256 indexed routerNonce,
        address indexed receiver,
        address fromToken,
        address toToken,
        uint256 fromAmount,      // real amount filled
        uint256 toAmount,        // real amount receiver received
        uint256 feeValue,        // fee in units (1 unit = 0.01 bps)
        uint256 slippageValue,   // slippage in units (1 unit = 0.01 bps)
        uint256 unsignedFlags
    );

    event NonceInvalidated(address indexed user, uint256 routerNonce);

    constructor(
        address _protocolTreasury,
        address _routerSigner,
        address _bebopPmm,
        address _permit2,
        address _wrappedNativeToken
    )
        Ownable(msg.sender)
        BebopValidation()
        BebopPmmHelper(_bebopPmm)
    {
        protocolTreasury = _protocolTreasury;
        routerSigner = _routerSigner;
        permit2 = IPermit2(_permit2);
        wrappedNativeToken = IWETH(_wrappedNativeToken);
    }

    receive() external payable {}

    // ==================== External Functions ====================

    function setRouterSigner(address _routerSigner) external onlyOwner {
        routerSigner = _routerSigner;
    }

    function invalidateNonce(uint256 nonce) external {
        _invalidateNonce(msg.sender, nonce);
        emit NonceInvalidated(msg.sender, nonce);
    }

    // ==================== View Helpers ====================

    /// @notice Compute the EIP712 order hash for a given order with extraInfo and hooksHash
    function hashOrder(
        BebopRouterOrder calldata order, bytes calldata extraInfo, bytes32 hooksHashVal
    ) external view returns (bytes32) {
        return order.isUsingPermit2()
            ? keccak256(abi.encodePacked("\x19\x01", permit2.DOMAIN_SEPARATOR(), order.permit2OrderHash(extraInfo, hooksHashVal, address(this))))
            : _toEIP712Digest(order.hash(extraInfo, hooksHashVal));
    }

    /// @notice Compute the EIP712 hookHash for a single hook with a given nonce
    function hashHook(Hook calldata hook, uint256 nonce) external view returns (bytes32) {
        return _toEIP712Digest(HookLib.hookHash(hook, nonce));
    }

    /// @notice Compute the hooksHash for an array of hooks given maker addresses and nonces
    function hooksHash(
        Hook[] calldata hooks, address[] calldata makerAddresses, uint256[] calldata makerNonces
    ) external pure returns (bytes32) {
        return HookLib.hooksHash(hooks, makerAddresses, makerNonces);
    }

    // ==================== Swap / Settle ====================

    /// @notice Execute a swap where msg.sender provides the input tokens directly.
    ///         Supports native ETH as input (auto-wraps to WETH) or output (auto-unwraps).
    /// @param exactAmount  Determines fill mode:
    ///                     > 0: exactIn  — user sends exactly this amount of fromToken
    ///                     < 0: exactOut — user wants exactly |exactAmount| of toToken after fees
    ///                     == 0: balance-of-router — use whatever fromToken balance the router holds
    /// @param order        The signed order struct (fromAmount/toAmount define the quote ratio for scaling)
    /// @param extraInfo    Opaque bytes forwarded to oracle/checker; its keccak256 is part of the signed order hash
    /// @param routerSignature  Router signer's EIP-712 signature over the order
    /// @param bebopPmmCalldata Raw calldata for BebopSettlement.swapSingle / swapAggregate
    /// @param hooks        Pre/post hooks to execute around the PMM swap 
    function swap(
        int256 exactAmount,
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        bytes calldata routerSignature,
        bytes calldata bebopPmmCalldata,
        Hook[] calldata hooks
    ) external payable nonReentrant {
        SwapContext memory ctx = _validateAndPrepare(exactAmount, order, extraInfo, routerSignature, bebopPmmCalldata, hooks, false);

        // Transfer fromToken from msg.sender to router
        if (order.fromToken == NATIVE_TOKEN) {
            require(msg.value >= ctx.calc.newFromAmount, UnexpectedMsgValue());
        } else {
            require(msg.value == 0, UnexpectedMsgValue());
            if (exactAmount != 0) {
                IERC20(order.fromToken).safeTransferFrom(msg.sender, address(this), ctx.calc.newFromAmount);
            }
        }

        _executeSwapCore(order, bebopPmmCalldata, hooks, ctx);

        // Refund excess msg.value
        if (msg.value > ctx.calc.newFromAmount && order.fromToken == NATIVE_TOKEN) {
            _transferNative(msg.sender, msg.value - ctx.calc.newFromAmount);
        }
    }

    /// @notice Execute a gasless swap where bebop submits on behalf of tokensOwner.
    ///         The user's tokens are pulled via either an EIP-712 signature or Permit2 witness signature.
    ///         Native ETH is not allowed as fromToken (gasless flow cannot receive msg.value from the user).
    /// @param exactAmount  Determines fill mode (same as swap):
    ///                     > 0: exactIn, < 0: exactOut, == 0: not allowed (reverts with ExactAmountZeroForSettle)
    /// @param order        The signed order struct. order.tokensOwner must be non-zero.
    ///                     For Permit2 exactOut: order.limitAmount must be < 0 (defines max spend as -limitAmount).
    /// @param extraInfo    Opaque bytes forwarded to oracle/checker; keccak256 included in signed hash
    /// @param routerSignature  Router signer's EIP-712 signature over the order
    /// @param bebopPmmCalldata Raw calldata for BebopSettlement
    /// @param hooks        Pre/post hooks to execute around the PMM swap
    /// @param userSignature  If Permit2: PermitWitnessTransferFrom signature with BebopRouterOrder as witness.
    ///                       Otherwise: EIP-712 signature over the order hash, or ERC-1271 contract signature.
    function settle(
        int256 exactAmount,
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        bytes calldata routerSignature,
        bytes calldata bebopPmmCalldata,
        Hook[] calldata hooks,
        bytes calldata userSignature
    ) external nonReentrant {
        require(order.tokensOwner != address(0), ZeroTokensOwnerForSettle());
        require(exactAmount != 0, ExactAmountZeroForSettle());
        require(order.fromToken != NATIVE_TOKEN, NativeTokenNotAllowedInSettle());

        SwapContext memory ctx = _validateAndPrepare(exactAmount, order, extraInfo, routerSignature, bebopPmmCalldata, hooks, true);

        // Transfer fromToken from tokensOwner to router.
        // `exactAmount` is an unsigned function arg, so the pull MUST be bounded by a signed
        // ceiling: exactIn is capped at fromAmount; exactOut must declare its max spend via
        // limitAmount < 0. order.maxFromAmount() returns that ceiling for both modes — the
        // same value the Permit2 path enforces internally as permitted.amount.
        require(exactAmount > 0 || order.limitAmount < 0, LimitAmountRequiredForExactOut());
        if (order.isUsingPermit2()) {
            _transferWithPermit2(order, extraInfo, ctx.hooksHashVal, userSignature, ctx.calc.newFromAmount);
        } else {
            bytes32 orderHash = order.hash(extraInfo, ctx.hooksHashVal);
            validateSignature(order.tokensOwner, _toEIP712Digest(orderHash), userSignature);
            require(ctx.calc.newFromAmount <= order.maxFromAmount(), LimitAmountViolation());
            IERC20(order.fromToken).safeTransferFrom(order.tokensOwner, address(this), ctx.calc.newFromAmount);
        }

        _executeSwapCore(order, bebopPmmCalldata, hooks, ctx);
    }

    // ==================== Internal Core Logic ====================

    /// @dev Bundles all swap execution context to avoid stack-too-deep
    struct SwapContext {
        PmmInfo pmm;
        bytes32 hooksHashVal;
        uint256 routerNonce;
        AmountCalc calc;
        uint256 feeValue;      // fee in units (1 unit = 0.01 bps)
        uint256 slippageValue;  // slippage in units (1 unit = 0.01 bps)
    }

    /// @dev Shared validation + amount calculation
    function _validateAndPrepare(
        int256 exactAmount,
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        bytes calldata routerSignature,
        bytes calldata bebopPmmCalldata,
        Hook[] calldata hooks,
        bool isSettle
    ) internal returns (SwapContext memory ctx) {
        // Validate PMM against pmmFromToken/pmmToToken
        ctx.pmm = _validateAndExtractPmmInfo(bebopPmmCalldata, order.pmmFromToken, order.pmmToToken);

        // Validate signatures, origin, msg.sender
        ctx.hooksHashVal = _validateSignaturesAndAccess(order, extraInfo, routerSignature, hooks, ctx.pmm, isSettle);

        // Validate nonce + expiry
        ctx.routerNonce = order.routerNonce;
        _invalidateNonce(isSettle ? order.tokensOwner : msg.sender, ctx.routerNonce);
        require(block.timestamp < order.getExpiry(), OrderExpired());

        // Get fee/slippage + calculate amounts
        {
            (ctx.feeValue, ctx.slippageValue) = _getFeeAndSlippage(order, extraInfo, ctx.pmm);
            ctx.calc = _calculateAmounts(exactAmount, order, ctx.feeValue, ctx.slippageValue);
        }
    }

    /// @dev Shared execution after inbound token transfer
    function _executeSwapCore(
        BebopRouterOrder calldata order,
        bytes calldata bebopPmmCalldata,
        Hook[] calldata hooks,
        SwapContext memory ctx
    ) internal {
        // Pre-hooks (e.g., unwrap aaveUSDC -> USDC)
        _approveHooks(hooks, false, order.fromToken, ctx.calc.newFromAmount);
        HookLib.executeHooks(hooks, false, ctx.pmm.makerAddresses, ctx.pmm.makerSwapLegs, order.fromAmount, ctx.calc.newFromAmount);

        // Determine pmmFromAmount
        uint256 pmmFromAmount;
        if (order.fromToken == NATIVE_TOKEN) {
            // Auto-wrap native ETH -> WETH for PMM
            pmmFromAmount = ctx.calc.newFromAmount;
            wrappedNativeToken.deposit{value: pmmFromAmount}();
        } else if (order.pmmFromToken != order.fromToken) {
            // Hooks transformed tokens — use balance
            pmmFromAmount = IERC20(order.pmmFromToken).balanceOf(address(this));
        } else {
            pmmFromAmount = ctx.calc.newFromAmount;
        }

        // Approve pmmFromToken + call PMM
        _executePmmSwap(bebopPmmCalldata, ctx.pmm.selector, order.pmmFromToken, pmmFromAmount);

        // Distribute fees/slippage + positive slippage in pmmToToken to makers/protocol
        _distributeFees(order, ctx.calc, ctx.pmm, ctx.routerNonce);

        // Post-hooks (e.g., wrap WETH -> aaveWETH)
        _approveHooks(hooks, true, order.pmmToToken, IERC20(order.pmmToToken).balanceOf(address(this)));
        HookLib.executeHooks(hooks, true, ctx.pmm.makerAddresses, ctx.pmm.makerSwapLegs, order.fromAmount, ctx.calc.newFromAmount);

        // Check limitAmount and transfer to receiver
        uint256 receiverAmount;
        if (order.toToken == NATIVE_TOKEN) {
            // Auto-unwrap WETH -> native ETH
            uint256 wethBalance = IERC20(address(wrappedNativeToken)).balanceOf(address(this));
            if (wethBalance > 0) {
                wrappedNativeToken.withdraw(wethBalance);
            }
            receiverAmount = address(this).balance;
            require(!ctx.calc.isExactOut || receiverAmount >= ctx.calc.toAmountAfterFeeSlippage, LimitAmountViolation());
            require(order.limitAmount <= 0 || receiverAmount >= uint256(order.limitAmount), LimitAmountViolation());
            _transferNative(order.receiver, receiverAmount);
        } else {
            receiverAmount = IERC20(order.toToken).balanceOf(address(this));
            require(!ctx.calc.isExactOut || receiverAmount >= ctx.calc.toAmountAfterFeeSlippage, LimitAmountViolation());
            require(order.limitAmount <= 0 || receiverAmount >= uint256(order.limitAmount), LimitAmountViolation());
            IERC20(order.toToken).safeTransfer(order.receiver, receiverAmount);
        }

        // Emit router-level event
        emit BebopRouterSwap(
            ctx.pmm.eventId, ctx.routerNonce, order.receiver,
            order.fromToken, order.toToken,
            ctx.calc.newFromAmount, receiverAmount,
            ctx.feeValue, ctx.slippageValue,
            order.unsignedFlags
        );
    }

    /// @dev Approve hook contracts that need it before execution
    function _approveHooks(Hook[] calldata hooks, bool postHookPhase, address token, uint256 amount) internal {
        for (uint256 i; i < hooks.length; ++i) {
            if (HookLib.isPostHook(hooks[i]) == postHookPhase && HookLib.isNeedsApproval(hooks[i])) {
                IERC20(token).safeApproveWithRetry(hooks[i].targetContract, amount);
            }
        }
    }

    function _transferNative(address to, uint256 amount) internal {
        (bool success,) = payable(to).call{value: amount}("");
        require(success, NativeTransferFailed());
    }

    function _validateSignaturesAndAccess(
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        bytes calldata routerSignature,
        Hook[] calldata hooks,
        PmmInfo memory pmm,
        bool isSettle
    ) internal view returns (bytes32 hooksHashVal) {
        hooksHashVal = HookLib.hooksHash(hooks, pmm.makerAddresses, pmm.makerNonces);

        bytes32 orderHash = order.hash(extraInfo, hooksHashVal);
        validateSignature(routerSigner, _toEIP712Digest(orderHash), routerSignature);

        _validateHookSignatures(hooks, pmm.makerAddresses, pmm.makerNonces);

        require(order.originAddress == address(0) || tx.origin == order.originAddress, InvalidOrigin());
        require(isSettle || order.tokensOwner == address(0) || msg.sender == order.tokensOwner, InvalidMsgSender());
    }

    function _validateHookSignatures(
        Hook[] calldata hooks,
        address[] memory makerAddresses,
        uint256[] memory makerNonces
    ) internal view {
        for (uint256 i; i < hooks.length; ++i) {
            address maker = HookLib.getMakerAddress(hooks[i]);
            if (maker == address(0)) continue;

            uint256 makerNonce;
            for (uint256 j; j < makerAddresses.length; ++j) {
                if (makerAddresses[j] == maker) {
                    makerNonce = makerNonces[j];
                    break;
                }
            }

            bytes32 hHash = HookLib.hookHash(hooks[i], makerNonce);
            validateSignature(maker, _toEIP712Digest(hHash), hooks[i].hookSignature);
        }
    }

    function _getFeeAndSlippage(
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        PmmInfo memory pmm
    ) internal view returns (uint256 fee, uint256 slippage) {
        address user = order.tokensOwner != address(0) ? order.tokensOwner : msg.sender;
        if (order.checker != address(0)) {
            fee = IChecker(order.checker).checkAndGetFee(user, order.receiver, msg.sender, extraInfo);
        }
        if (order.oracle != address(0)) {
            // Use actual PMM amounts from calldata (not order amounts, since calldata is replaceable)
            slippage = IOracle(order.oracle).getSlippage(
                order.pmmFromToken, order.pmmToToken, pmm.pmmTakerAmount, pmm.pmmMakerAmount, extraInfo
            );
        }
    }

    // ==================== Amount Calculation ====================

    function _calculateAmounts(
        int256 exactAmount,
        BebopRouterOrder calldata order,
        uint256 fee,
        uint256 slippage
    ) internal view returns (AmountCalc memory calc) {
        calc.feeRate = fee;
        calc.slippageRate = slippage;
        if (exactAmount > 0) {
            calc.newFromAmount = uint256(exactAmount);
            calc.newToAmount = (order.toAmount * calc.newFromAmount) / order.fromAmount;
            calc.feeAmount = (calc.newToAmount * fee) / UNIT_BASE;
            calc.slippageAmount = (calc.newToAmount * slippage) / UNIT_BASE;
            calc.toAmountAfterFeeSlippage = calc.newToAmount - calc.feeAmount - calc.slippageAmount;
            // limitAmount > 0 (minToAmount) is checked after post-hooks against actual toToken balance
        } else if (exactAmount < 0) {
            // ExactOut: user wants to receive exactly targetToAmount after fee+slippage.
            // net = gross * (BASE - fee - slippage) / BASE  →  gross = net * BASE / (BASE - fee - slippage)
            uint256 targetToAmount = uint256(-exactAmount);
            uint256 combinedRate = fee + slippage;
            calc.newToAmount = combinedRate > 0
                ? (targetToAmount * UNIT_BASE + UNIT_BASE - combinedRate - 1) / (UNIT_BASE - combinedRate) // round up
                : targetToAmount;
            calc.feeAmount = (calc.newToAmount * fee) / UNIT_BASE;
            calc.slippageAmount = (calc.newToAmount * slippage) / UNIT_BASE;
            calc.toAmountAfterFeeSlippage = targetToAmount;
            calc.isExactOut = true;
            calc.newFromAmount = (order.fromAmount * calc.newToAmount) / order.toAmount;
            require(order.limitAmount >= 0 || calc.newFromAmount <= uint256(-order.limitAmount), LimitAmountViolation());
        } else {
            calc.newFromAmount = order.fromToken == NATIVE_TOKEN
                ? address(this).balance
                : IERC20(order.fromToken).balanceOf(address(this));
            calc.newToAmount = (order.toAmount * calc.newFromAmount) / order.fromAmount;
            calc.feeAmount = (calc.newToAmount * fee) / UNIT_BASE;
            calc.slippageAmount = (calc.newToAmount * slippage) / UNIT_BASE;
            calc.toAmountAfterFeeSlippage = calc.newToAmount - calc.feeAmount - calc.slippageAmount;
        }
    }

    // ==================== Fee Distribution ====================

    /// @dev Distribute fees, slippage refund, and positive slippage in pmmToToken.
    ///      Called BEFORE post-hooks so remaining pmmToToken can be converted by post-hook.
    ///      Emits BebopPmmSwap per swap leg.
    ///
    ///      The receiver's share (toAmountAfterFeeSlippage) is guaranteed first.
    ///      Fees are taken from whatever remains. If PMM returned slightly less than
    ///      theoretical gross (integer rounding), the fee pool shrinks — not the receiver.
    function _distributeFees(
        BebopRouterOrder calldata order,
        AmountCalc memory calc,
        PmmInfo memory pmm,
        uint256 routerNonce
    ) internal {
        uint256 pmmToBalance = IERC20(order.pmmToToken).balanceOf(address(this));

        // Receiver's share is sacred — fee pool is whatever's left
        uint256 feePool = pmmToBalance > calc.toAmountAfterFeeSlippage
            ? pmmToBalance - calc.toAmountAfterFeeSlippage
            : 0;

        // Fee and slippage amounts: min of theoretical and actual feePool
        // If PMM returned less than expected, fee+slippage shrink proportionally
        // If PMM returned more, the excess is positive slippage → treasury
        uint256 feeAmount = calc.feeAmount;
        uint256 slippageAmount = calc.slippageAmount;
        uint256 theoreticalTotal = feeAmount + slippageAmount;

        if (feePool < theoreticalTotal) {
            // PMM returned less: scale down fee+slippage to fit actual feePool
            if (theoreticalTotal > 0) {
                feeAmount = (feePool * calc.feeRate) / (calc.feeRate + calc.slippageRate);
                slippageAmount = feePool - feeAmount;
            }
        }
        uint256 positiveSlippage = feePool > theoreticalTotal ? feePool - theoreticalTotal : 0;

        // Protocol shares
        uint32 protocolShareFee = order.getProtocolShareFee();
        uint32 protocolShareSlippage = order.getProtocolShareSlippage();
        uint256 protocolFeeShare = (feeAmount * protocolShareFee) / UNIT_BASE;
        uint256 protocolSlippageShare = (slippageAmount * protocolShareSlippage) / UNIT_BASE;

        // Skip dust positive slippage only if it would be the sole treasury transfer
        if (positiveSlippage > 0 && positiveSlippage < order.getMinPositiveSlippageToTreasury()
            && protocolFeeShare == 0 && protocolSlippageShare == 0) {
            positiveSlippage = 0;
        }

        uint256 toTreasury = protocolFeeShare + protocolSlippageShare + positiveSlippage;
        uint256 totalMakerRefund = (feeAmount + slippageAmount) - protocolFeeShare - protocolSlippageShare;

        if (toTreasury > 0) {
            IERC20(order.pmmToToken).safeTransfer(protocolTreasury, toTreasury);
        }

        // Distribute refund to makers and emit per-swap-leg events
        _distributeMakerRefundAndEmit(order, calc, pmm, totalMakerRefund, routerNonce);
    }

    function _distributeMakerRefundAndEmit(
        BebopRouterOrder calldata order,
        AmountCalc memory calc,
        PmmInfo memory pmm,
        uint256 totalMakerRefund,
        uint256 routerNonce
    ) internal {
        // pmmMakerAmount = total last-leg maker amount (= sum of lastLegAmounts)
        uint256 totalLastLeg = pmm.pmmMakerAmount;

        // Find last maker with non-zero lastLegAmounts for dust remainder
        uint256 lastRefundableMaker;
        for (uint256 i; i < pmm.lastLegAmounts.length; ++i) {
            if (pmm.lastLegAmounts[i] > 0) lastRefundableMaker = i;
        }

        uint256 refundDistributed;
        for (uint256 i; i < pmm.makerAddresses.length; ++i) {
            uint256 makerRefund;
            if (totalMakerRefund > 0 && pmm.lastLegAmounts[i] > 0) {
                makerRefund = i == lastRefundableMaker
                    ? totalMakerRefund - refundDistributed
                    : (totalMakerRefund * pmm.lastLegAmounts[i]) / totalLastLeg;
                refundDistributed += makerRefund;
                if (makerRefund > 0) {
                    IERC20(order.pmmToToken).safeTransfer(pmm.makerAddresses[i], makerRefund);
                }
            }

            // Emit one BebopPmmSwap per swap leg for this maker
            // Each maker has max 2 legs: optionally 1 middle-leg + 1 last-leg, or just 1 last-leg
            // Refund applies only to the last-leg (the one where makerToken == pmmToToken)
            Swap[] memory legs = pmm.makerSwapLegs[i];
            for (uint256 j; j < legs.length; ++j) {
                // Scale using PMM's own ratio: amount * filledTakerAmount / quoteTakerAmount
                uint256 scaledTakerAmt = (legs[j].takerAmount * calc.newFromAmount) / pmm.pmmTakerAmount;
                uint256 scaledMakerAmt = (legs[j].makerAmount * calc.newFromAmount) / pmm.pmmTakerAmount;

                bool isLastLeg = legs[j].makerToken == order.pmmToToken;
                uint256 legRefund = isLastLeg ? makerRefund : 0;

                emit BebopPmmSwap(
                    pmm.makerAddresses[i],
                    pmm.eventId,
                    routerNonce,
                    pmm.makerNonces[i],
                    legs[j].takerToken,
                    legs[j].makerToken,
                    scaledTakerAmt,
                    scaledMakerAmt - legRefund,  // real maker balance change
                    legRefund
                );
            }
        }
    }

    // ==================== Permit2 ====================

    function _transferWithPermit2(
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        bytes32 hooksHashVal,
        bytes calldata userSignature,
        uint256 amount
    ) internal {
        permit2.permitWitnessTransferFrom(
            order.getPermit2TransferInfo(),
            IPermit2.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            order.tokensOwner,
            order.hash(extraInfo, hooksHashVal),
            BebopRouterOrderLib.PERMIT2_WITNESS_TYPE_STRING,
            userSignature
        );
    }
}
