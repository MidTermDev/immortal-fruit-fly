// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Script, console} from "forge-std/Script.sol";
import {FlyArcade} from "../src/FlyArcade.sol";
contract DeployArcade is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        FlyArcade a = new FlyArcade();
        vm.stopBroadcast();
        console.log("FlyArcade:", address(a));
    }
}
