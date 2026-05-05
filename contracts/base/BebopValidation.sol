// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "../Errors.sol";

/// @title BebopValidation
/// @notice Signature validation (EIP-712, EIP-2098, ERC-1271) and nonce management
abstract contract BebopValidation {

    bytes32 private constant UPPER_BIT_MASK = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    bytes4 private constant EIP1271_MAGICVALUE = bytes4(keccak256("isValidSignature(bytes32,bytes)"));

    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("BebopRouter");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;

    mapping(address => mapping(uint256 => uint256)) private _nonces;

    constructor() {
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _computeDomainSeparator();
    }

    // ==================== Domain Separator ====================

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID
            ? _CACHED_DOMAIN_SEPARATOR
            : _computeDomainSeparator();
    }

    function _computeDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this)
        ));
    }

    function _toEIP712Digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // ==================== Signature Validation ====================

    /// @notice Validate the signature against an address
    /// @param validationAddress The address to validate the signature against
    /// @param hash The EIP-712 digest to verify
    /// @param signature The signature bytes (65 standard or 64 EIP-2098)
    function validateSignature(address validationAddress, bytes32 hash, bytes calldata signature) public view {
        bytes32 r;
        bytes32 s;
        uint8 v;
        if (validationAddress.code.length == 0) {
            if (signature.length == 65) {
                (r, s) = abi.decode(signature, (bytes32, bytes32));
                v = uint8(signature[64]);
            } else if (signature.length == 64) {
                // EIP-2098
                bytes32 vs;
                (r, vs) = abi.decode(signature, (bytes32, bytes32));
                s = vs & UPPER_BIT_MASK;
                v = uint8(uint256(vs >> 255)) + 27;
            } else {
                revert InvalidSignatureLength();
            }
            address signer = ecrecover(hash, v, r, s);
            require(signer != address(0), InvalidSignature());
            require(signer == validationAddress, InvalidSigner());
        } else {
            bytes4 magicValue = IERC1271(validationAddress).isValidSignature(hash, signature);
            require(magicValue == EIP1271_MAGICVALUE, InvalidContractSignature());
        }
    }

    // ==================== Nonce Management ====================
    // Bitmap-based: each nonce occupies 1 bit in a 256-bit slot
    // nonce >> 8 = slot index, nonce & 0xff = bit position within slot

    function _invalidateNonce(address owner, uint256 nonce) internal {
        require(nonce != 0, ZeroNonce());
        uint256 invalidatorSlot = nonce >> 8;
        uint256 invalidatorBit = 1 << (nonce & 0xff);
        uint256 invalidator = _nonces[owner][invalidatorSlot];
        require(invalidator & invalidatorBit == 0, InvalidNonce());
        _nonces[owner][invalidatorSlot] = invalidator | invalidatorBit;
    }

    function isNonceValid(address owner, uint256 nonce) external view returns (bool) {
        uint256 invalidatorSlot = nonce >> 8;
        uint256 invalidatorBit = 1 << (nonce & 0xff);
        return (_nonces[owner][invalidatorSlot] & invalidatorBit) == 0;
    }
}
