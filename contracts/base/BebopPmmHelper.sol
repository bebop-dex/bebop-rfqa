// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeTransferLib} from "../libraries/SafeTransferLib.sol";
import {Swap} from "../interfaces/IBebopHook.sol";
import "../Errors.sol";

/// @title BebopPmmHelper
/// @notice PMM calldata decoding, validation, and swap execution
abstract contract BebopPmmHelper {
    using SafeTransferLib for IERC20;

    bytes4 internal constant SWAP_SINGLE_SELECTOR = 0x4dcebcba;
    bytes4 internal constant SWAP_AGGREGATE_SELECTOR = 0xa2f74893;
    uint256 private constant SWAP_SINGLE_OFFSET = 388;
    uint256 private constant SWAP_AGGREGATE_OFFSET = 68;
    bytes1 private constant TRANSFER_TO_CONTRACT = 0x07;
    bytes1 private constant TRANSFER_FROM_CONTRACT = 0x08;

    address public immutable bebopPmm;

    struct PmmInfo {
        bytes4 selector;
        address[] makerAddresses;
        uint256[] makerNonces;
        uint256[] lastLegAmounts;   // per-maker last-leg maker amounts (for refund distribution)
        Swap[][] makerSwapLegs;     // per-maker all swap legs with original amounts
        uint256 pmmTakerAmount;     // total taker amount in pmmFromToken (non-middle-token)
        uint256 pmmMakerAmount;     // total maker amount in pmmToToken (non-middle-token)
        uint128 eventId;            // from PMM order flags (bits 128-255)
    }

    constructor(address _bebopPmm) {
        bebopPmm = _bebopPmm;
    }

    // ==================== PMM Validation ====================

    function _validateAndExtractPmmInfo(
        bytes calldata pmmCalldata,
        address expectedFromToken,
        address expectedToToken
    ) internal pure returns (PmmInfo memory pmm) {
        pmm.selector = bytes4(pmmCalldata[:4]);

        if (pmm.selector == SWAP_SINGLE_SELECTOR) {
            _decodeSinglePmm(pmmCalldata, expectedFromToken, expectedToToken, pmm);
        } else if (pmm.selector == SWAP_AGGREGATE_SELECTOR) {
            _decodeAggregatePmm(pmmCalldata, expectedFromToken, expectedToToken, pmm);
        } else {
            revert InvalidPmmSelector();
        }
    }

    function _decodeSinglePmm(
        bytes calldata pmmCalldata,
        address expectedFromToken,
        address expectedToToken,
        PmmInfo memory pmm
    ) private pure {
        (
            , // expiry
            , // taker_address
            address maker_address,
            uint256 maker_nonce,
            address taker_token,
            address maker_token,
            uint256 taker_amount,
            uint256 maker_amount,
            , // receiver
            , // packed_commands
            uint256 pmmFlags
        ) = abi.decode(pmmCalldata[4:4+352], (uint256, address, address, uint256, address, address, uint256, uint256, address, uint256, uint256));

        require(taker_token == expectedFromToken && maker_token == expectedToToken, TokenMismatch());
        require(taker_amount > 0 && maker_amount > 0, UnexpectedAmount());

        pmm.makerAddresses = new address[](1);
        pmm.makerNonces = new uint256[](1);
        pmm.lastLegAmounts = new uint256[](1);
        pmm.makerSwapLegs = new Swap[][](1);

        pmm.makerAddresses[0] = maker_address;
        pmm.makerNonces[0] = maker_nonce;
        pmm.lastLegAmounts[0] = maker_amount;
        pmm.pmmTakerAmount = taker_amount;
        pmm.pmmMakerAmount = maker_amount;
        pmm.eventId = uint128(pmmFlags >> 128);

        pmm.makerSwapLegs[0] = new Swap[](1);
        pmm.makerSwapLegs[0][0] = Swap({
            takerAmount: taker_amount,
            takerToken: taker_token,
            makerAmount: maker_amount,
            makerToken: maker_token
        });
    }

    /// @dev Decoded aggregate order fields, used to pass between decode and process functions
    struct AggregateDecoded {
        address[][] taker_tokens;
        address[][] maker_tokens;
        uint256[][] taker_amounts;
        uint256[][] maker_amounts;
        bytes commands;
    }

    function _decodeAggregatePmm(
        bytes calldata pmmCalldata,
        address expectedFromToken,
        address expectedToToken,
        PmmInfo memory pmm
    ) private pure {
        uint256 orderOffset;
        assembly {
            orderOffset := calldataload(add(pmmCalldata.offset, 4))
        }
        bytes calldata orderData = pmmCalldata[4 + orderOffset:];

        AggregateDecoded memory d;
        uint256 pmmFlags;
        (
            , , // expiry, taker_address
            pmm.makerAddresses,
            pmm.makerNonces,
            d.taker_tokens,
            d.maker_tokens,
            d.taker_amounts,
            d.maker_amounts,
            , // receiver
            d.commands,
            pmmFlags
        ) = abi.decode(orderData, (uint256, address, address[], uint256[], address[][], address[][], uint256[][], uint256[][], address, bytes, uint256));
        pmm.eventId = uint128(pmmFlags >> 128);

        uint256 numMakers = d.maker_tokens.length;
        pmm.lastLegAmounts = new uint256[](numMakers);
        pmm.makerSwapLegs = new Swap[][](numMakers);

        _processAggregateLegs(pmm, d, expectedFromToken, expectedToToken);
    }

    function _processAggregateLegs(
        PmmInfo memory pmm,
        AggregateDecoded memory d,
        address expectedFromToken,
        address expectedToToken
    ) private pure {
        address foundFromToken;
        address foundToToken;
        uint256 cmdIdx;

        for (uint256 i; i < d.maker_tokens.length; ++i) {
            uint256 numLegs = d.maker_tokens[i].length;
            require(numLegs > 0 && numLegs <= 2, TooManyLegsPerMaker());
            require(numLegs == d.taker_tokens[i].length, MakerTakerLengthMismatch());

            uint256 makerCmdStart = cmdIdx;
            pmm.makerSwapLegs[i] = new Swap[](numLegs);

            if (numLegs == 2) {
                // 2-hop: validate command order, directions, and middle token consistency
                require(
                    d.commands[makerCmdStart] == TRANSFER_TO_CONTRACT            // maker[0] sends middle token to contract
                    && d.commands[makerCmdStart + 1] != TRANSFER_TO_CONTRACT     // maker[1] sends last-leg token to taker
                    && d.commands[makerCmdStart + 2] != TRANSFER_FROM_CONTRACT   // taker[0] sends input token directly
                    && d.commands[makerCmdStart + 3] == TRANSFER_FROM_CONTRACT   // taker[1] gets middle token from contract
                    && d.maker_tokens[i][0] == d.taker_tokens[i][1],            // middle token matches both sides
                    InvalidHopStructure()
                );
            }

            // Process maker commands
            for (uint256 j; j < numLegs; ++j) {
                bool isMiddle = (d.commands[cmdIdx++] == TRANSFER_TO_CONTRACT);
                if (!isMiddle) {
                    if (foundToToken == address(0)) foundToToken = d.maker_tokens[i][j];
                    else require(foundToToken == d.maker_tokens[i][j], NotOneToOneAggregate());
                    pmm.lastLegAmounts[i] += d.maker_amounts[i][j];
                    pmm.pmmMakerAmount += d.maker_amounts[i][j];
                }
                pmm.makerSwapLegs[i][j] = Swap(d.taker_amounts[i][j], d.taker_tokens[i][j], d.maker_amounts[i][j], d.maker_tokens[i][j]);
            }

            // Process taker commands
            for (uint256 j; j < numLegs; ++j) {
                if (d.commands[cmdIdx++] != TRANSFER_FROM_CONTRACT) {
                    if (foundFromToken == address(0)) foundFromToken = d.taker_tokens[i][j];
                    else require(foundFromToken == d.taker_tokens[i][j], NotOneToOneAggregate());
                    pmm.pmmTakerAmount += d.taker_amounts[i][j];
                }
            }
        }
        require(pmm.pmmMakerAmount > 0 && pmm.pmmTakerAmount > 0, UnexpectedAmount());
        require(foundFromToken == expectedFromToken && foundToToken == expectedToToken, TokenMismatch());
    }

    // ==================== PMM Execution ====================

    function _executePmmSwap(
        bytes calldata bebopPmmCalldata,
        bytes4 selector,
        address fromToken,
        uint256 newFromAmount
    ) internal {
        bytes memory pmmCalldata = bebopPmmCalldata;
        uint256 offset = selector == SWAP_SINGLE_SELECTOR ? SWAP_SINGLE_OFFSET : SWAP_AGGREGATE_OFFSET;
        _changeCalldata(pmmCalldata, offset, newFromAmount);
        _ensureApproval(IERC20(fromToken), bebopPmm, newFromAmount);

        (bool success, bytes memory returnData) = bebopPmm.call(pmmCalldata);
        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
    }

    function _changeCalldata(bytes memory callData, uint256 offset, uint256 value) private pure {
        require(offset <= callData.length - 32, CalldataOffsetOutOfBounds());
        assembly ("memory-safe") {
            mstore(add(32, add(callData, offset)), value)
        }
    }

    function _ensureApproval(IERC20 token, address spender, uint256 amount) private {
        if (token.allowance(address(this), spender) < amount) {
            token.safeApproveWithRetry(spender, type(uint256).max);
        }
    }
}
