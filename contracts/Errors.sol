// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title Errors
/// @notice All custom errors used across BebopRouter contracts

// --- Signature errors ---
/// @dev Signature length is neither 64 (EIP-2098) nor 65 bytes
error InvalidSignatureLength();
/// @dev ecrecover returned address(0), signature is malformed
error InvalidSignature();
/// @dev Recovered signer does not match the expected address
error InvalidSigner();
/// @dev ERC-1271 isValidSignature returned incorrect magic value
error InvalidContractSignature();
/// @dev Router signature verification failed
error InvalidRouterSignature();
/// @dev User signature verification failed (settle flow)
error InvalidUserSignature();
/// @dev Hook signature verification failed for a maker
error InvalidHookSignature();

// --- Access / order validation errors ---
/// @dev tx.origin does not match order.originAddress
error InvalidOrigin();
/// @dev msg.sender does not match order.tokensOwner (swap flow)
error InvalidMsgSender();
/// @dev Nonce has already been used
error InvalidNonce();
/// @dev Nonce cannot be zero
error ZeroNonce();
/// @dev Block timestamp is past order expiry
error OrderExpired();
/// @dev Resulting amount violates the limit (minToAmount or maxFromAmount)
error LimitAmountViolation();

// --- Settle-specific errors ---
/// @dev tokensOwner must not be address(0) for settle
error ZeroTokensOwnerForSettle();
/// @dev exactAmount cannot be 0 for settle (no balance-of-router mode)
error ExactAmountZeroForSettle();
/// @dev For permit2 + exactOut, limitAmount must be < 0 to define the max permitted spend
error LimitAmountRequiredForPermit2ExactOut();

// --- PMM errors ---
/// @dev PMM calldata selector is not swapSingle or swapAggregate
error InvalidPmmSelector();
/// @dev Aggregate swap involves more than one taker/maker token type (excluding middle tokens)
error NotOneToOneAggregate();
/// @dev Token in PMM calldata does not match order.pmmFromToken/pmmToToken
error TokenMismatch();
/// @dev PMM call reverted
error PmmCallFailed();
/// @dev Unexpected amounts in PMM
error UnexpectedAmount();
/// @dev A maker has more than 2 token legs in aggregate (max: 1 direct, or 1 middle + 1 last)
error TooManyLegsPerMaker();
/// @dev taker_tokens and maker_tokens length mismatch for a maker
error MakerTakerLengthMismatch();
/// @dev 2-leg maker has invalid hop structure (wrong command order or middle token mismatch)
error InvalidHopStructure();

// --- Hook errors ---
/// @dev makerAddresses and makerNonces arrays have different lengths
error HookMakerArrayLengthMismatch();
/// @dev hooks array is shorter than makerAddresses (when hooks exist)
error HooksShorterThanMakers();
/// @dev Hook has a makerAddress but no matching nonce was found in makerNonces
error HookMakerNonceNotFound();
/// @dev A hook execution reverted and revertOnFail is true
error HookExecutionFailed();

// --- Native token errors ---
/// @dev Native ETH transfer via .call{value} failed
error NativeTransferFailed();
/// @dev Native ETH is not allowed as fromToken in settle (gasless flow)
error NativeTokenNotAllowedInSettle();
/// @dev msg.value sent when fromToken is not native, or insufficient msg.value
error UnexpectedMsgValue();

// --- Calldata errors ---
/// @dev Offset for _changeCalldata exceeds calldata bounds
error CalldataOffsetOutOfBounds();
