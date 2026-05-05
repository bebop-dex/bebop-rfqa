// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock rate-based wrapped token. Like a vault share.
///         deposit: transfer `amount` underlying in, mint `amount * RATE_BASE / rate` shares
///         withdraw: burn `shares`, transfer `shares * rate / RATE_BASE` underlying out
///         rate = how much underlying 1 full share is worth (in RATE_BASE units)
///         RATE_BASE = 1e18. rate=1.5e18 means 1 share = 1.5 underlying.
contract MockRateToken is ERC20 {
    uint8 private _dec;
    IERC20 public immutable underlying;
    uint256 public rate; // 1e18 = 1:1
    uint256 public constant RATE_BASE = 1e18;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address underlying_, uint256 rate_) ERC20(name_, symbol_) {
        _dec = decimals_;
        underlying = IERC20(underlying_);
        rate = rate_;
    }

    function decimals() public view override returns (uint8) { return _dec; }

    /// @notice Deposit underlying, mint shares. shares = amount * RATE_BASE / rate
    function deposit(uint256 amount, address to) external {
        underlying.transferFrom(msg.sender, address(this), amount);
        uint256 shares = amount * RATE_BASE / rate;
        _mint(to, shares);
    }

    /// @notice Burn shares, withdraw underlying. underlying = shares * rate / RATE_BASE
    function withdraw(uint256 shares, address to) external {
        _burn(msg.sender, shares);
        uint256 amount = shares * rate / RATE_BASE;
        underlying.transfer(to, amount);
    }

    /// @notice Owner can update rate (for testing)
    function setRate(uint256 newRate) external {
        rate = newRate;
    }
}
