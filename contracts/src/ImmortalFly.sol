// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Immortal Fruit Fly ($FLY) — BEP-20 token on BNB Smart Chain
/// @notice Fixed supply, no owner, no mint, no tax, no blacklist, no pause.
///         The entire supply is minted once to the deployer, who seeds liquidity.
///         Tokens are burned to feed and resurrect the on-chain fly (see FlyBrain.sol).
/// @dev    Burnable so FlyBrain can destroy the tokens it consumes, Permit so the
///         website can feed the fly with a signature instead of a separate approve tx.
contract ImmortalFly is ERC20, ERC20Burnable, ERC20Permit {
    constructor(string memory name_, string memory symbol_, uint256 supply_, address to_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _mint(to_, supply_);
    }
}
