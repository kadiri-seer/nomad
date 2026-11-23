// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A stand-in for $NOMAD in the tests only.
contract TestToken is ERC20 {
    constructor() ERC20("Test NOMAD", "tNOMAD") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
