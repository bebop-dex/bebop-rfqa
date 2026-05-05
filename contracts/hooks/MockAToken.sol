// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock aToken for testing. 1:1 with underlying.
///         deposit(): transfer underlying in, mint aToken
///         withdraw(): burn aToken, transfer underlying out
contract MockAToken is ERC20 {
    uint8 private _dec;
    IERC20 public immutable underlying;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address underlying_) ERC20(name_, symbol_) {
        _dec = decimals_;
        underlying = IERC20(underlying_);
    }

    function decimals() public view override returns (uint8) { return _dec; }

    /// @notice Deposit underlying, mint aToken 1:1
    function deposit(uint256 amount, address to) external {
        underlying.transferFrom(msg.sender, address(this), amount);
        _mint(to, amount);
    }

    /// @notice Burn aToken, withdraw underlying 1:1
    function withdraw(uint256 amount, address to) external {
        _burn(msg.sender, amount);
        underlying.transfer(to, amount);
    }
}
