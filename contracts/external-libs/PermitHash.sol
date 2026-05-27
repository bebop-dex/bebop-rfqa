// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../interfaces/IPermit2.sol";

/// @notice PermitHash.sol in Permit2
/// From: https://github.com/Uniswap/permit2/blob/main/src/libraries/PermitHash.sol
library PermitHash {

    string private constant _PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    bytes32 private constant _TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    function hashWithWitness(
        IPermit2.PermitTransferFrom memory permit,
        bytes32 witness,
        string memory witnessTypeString,
        address spender
    ) internal pure returns (bytes32) {
        bytes32 typeHash = keccak256(abi.encodePacked(_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB, witnessTypeString));

        bytes32 tokenPermissionsHash = _hashTokenPermissions(permit.permitted);
        return keccak256(abi.encode(typeHash, tokenPermissionsHash, spender, permit.nonce, permit.deadline, witness));
    }

    function _hashTokenPermissions(IPermit2.TokenPermissions memory permitted) private pure returns (bytes32){
        return keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permitted));
    }
}