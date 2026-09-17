// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LifeFund, IFlyRegistryFeed} from "../src/LifeFund.sol";

/// Deploys LifeFund: BNB in, seconds of life out, fed from the operator's $FLY by the keeper.
///   PRIVATE_KEY (deployer = owner = keeper = treasury unless KEEPER / TREASURY are set)
///   RATE_E18   seconds of life per wei ×1e18 (default 8_640_000: 0.01 BNB -> 24 h)
///   FREE_PER_DAY free seconds per fly per day the keeper may grant (default 7200)
contract DeployLifeFund is Script {
    address constant REGISTRY = 0x0eeB0A675720306Ef6f426Bd8560c1288848f813;
    address constant TOKEN = 0x23791AA3B031659B593cF141a2Bc76B0ad657777;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address keeper = vm.envOr("KEEPER", me);
        address treasury = vm.envOr("TREASURY", me);
        uint256 rate = vm.envOr("RATE_E18", uint256(8_640_000));
        uint256 free = vm.envOr("FREE_PER_DAY", uint256(7200));
        vm.startBroadcast(pk);
        LifeFund f = new LifeFund(IFlyRegistryFeed(REGISTRY), IERC20(TOKEN), keeper, treasury, rate, free);
        vm.stopBroadcast();
        console.log("LifeFund:", address(f));
        console.log("keeper:", keeper);
        console.log("treasury:", treasury);
        console.log("0.01 BNB buys (s):", f.quote(0.01 ether));
    }
}
