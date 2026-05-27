// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../external-libs/PermitHash.sol";

struct BebopRouterOrder {
    uint256 fromAmount;
    uint256 toAmount;
    int256 limitAmount;     // >0: minToAmount (exactIn), <0: -maxFromAmount (exactOut), ==0: disabled
    address fromToken;      // user-facing from token
    address toToken;        // user-facing to token
    address pmmFromToken;   // PMM taker token. Same as fromToken if no pre-hook conversion
    address pmmToToken;     // PMM maker token. Same as toToken if no post-hook conversion
    address tokensOwner;    // for swap: verify msg.sender; for settle: user address; address(0): skip check
    address receiver;
    address originAddress;  // address(0): skip tx.origin check
    address oracle;         // address(0): no oracle
    address checker;        // address(0): no checker
    uint256 info;           // packed: [uint128 minPositiveSlippageToTreasury | uint64 expiry | uint32 protocolShareSlippage | uint32 protocolShareFee]
    uint256 routerNonce;    // replay protection nonce (signed)
    uint256 unsignedFlags;  // NOT SIGNED. bit 0: usingPermit2. Rest available for offchain use.
}

library BebopRouterOrderLib {

    // Combined type hash: includes extraInfoHash and hooksHash as signed fields
    bytes internal constant ORDER_TYPE = abi.encodePacked(
        "BebopRouterOrder(uint256 fromAmount,uint256 toAmount,int256 limitAmount,address fromToken,address toToken,address pmmFromToken,address pmmToToken,address tokensOwner,address receiver,address originAddress,address oracle,address checker,uint256 info,uint256 routerNonce,bytes32 extraInfoHash,bytes32 hooksHash)"
    );
    bytes32 internal constant ORDER_TYPE_HASH = keccak256(ORDER_TYPE);
    string internal constant PERMIT2_WITNESS_TYPE_STRING = string(
        abi.encodePacked("BebopRouterOrder witness)", ORDER_TYPE, "TokenPermissions(address token,uint256 amount)")
    );

    /// @notice EIP-712 struct hash of the order (includes extraInfoHash and hooksHash).
    ///         Uses assembly to lay out all 17 words in a single buffer and keccak256.
    ///         Struct fields 1-14 (fromAmount..routerNonce) are copied straight from calldata;
    ///         unsignedFlags is excluded (not signed).
    function hash(
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        bytes32 hooksHash
    ) internal pure returns (bytes32 result) {
        bytes32 typeHash = ORDER_TYPE_HASH;
        bytes32 extraInfoHash = keccak256(extraInfo);
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, typeHash)
            calldatacopy(add(m, 0x20), order, 0x1c0)   // 14 fields: fromAmount .. routerNonce
            mstore(add(m, 0x1e0), extraInfoHash)
            mstore(add(m, 0x200), hooksHash)
            result := keccak256(m, 0x220)               // 17 words = 544 bytes
        }
    }

    /// @notice Maximum input the signed order authorizes pulling from the token owner.
    ///         exactIn (limitAmount >= 0): fromAmount. exactOut (limitAmount < 0): -limitAmount (maxFromAmount).
    function maxFromAmount(BebopRouterOrder calldata order) internal pure returns (uint256) {
        return order.limitAmount >= 0 ? order.fromAmount : uint256(-order.limitAmount);
    }

    function getPermit2TransferInfo(BebopRouterOrder calldata order) internal pure returns (IPermit2.PermitTransferFrom memory) {
        // For exactIn (limitAmount >= 0): user signed for fromAmount
        // For exactOut (limitAmount < 0): user signed for -limitAmount (maxFromAmount)
        return IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({
                token: order.fromToken,
                amount: maxFromAmount(order)
            }),
            nonce: order.routerNonce,
            deadline: uint256(getExpiry(order))
        });
    }

    function permit2OrderHash(
        BebopRouterOrder calldata order,
        bytes calldata extraInfo,
        bytes32 hooksHash,
        address spender
    ) internal pure returns (bytes32) {
        return PermitHash.hashWithWitness(
            getPermit2TransferInfo(order), hash(order, extraInfo, hooksHash), PERMIT2_WITNESS_TYPE_STRING, spender
        );
    } 

    // --- Info field getters ---

    function getExpiry(BebopRouterOrder calldata order) internal pure returns (uint64) {
        return uint64(order.info >> 64);
    }

    function getProtocolShareSlippage(BebopRouterOrder calldata order) internal pure returns (uint32) {
        return uint32(order.info >> 32);
    }

    function getProtocolShareFee(BebopRouterOrder calldata order) internal pure returns (uint32) {
        return uint32(order.info);
    }

    function getMinPositiveSlippageToTreasury(BebopRouterOrder calldata order) internal pure returns (uint128) {
        return uint128(order.info >> 128);
    }

    // --- UnsignedFlags getter ---

    function isUsingPermit2(BebopRouterOrder calldata order) internal pure returns (bool) {
        return (order.unsignedFlags & 1) != 0;
    }
}
