// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FlyWorld} from "../src/FlyWorld.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployWorld is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address token = vm.envAddress("TOKEN_ADDRESS");
        vm.startBroadcast(pk);
        FlyWorld w = new FlyWorld(IERC20(token), 1 ether, 60 ether, 50_000 ether, 120);
        vm.stopBroadcast();
        console.log("FlyWorld:", address(w));
    }
}
