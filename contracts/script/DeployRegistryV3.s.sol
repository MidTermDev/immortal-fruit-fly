// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FlyRegistryV3} from "../src/FlyRegistryV3.sol";

/// FlyRegistry v3: life is paid in BNB (nothing burned for metabolism), the keeper feeds for free, one-time migration
/// from v2. Reads the identity from ../brain/identity.json and the collection metadata CID from ../brand/collection_cid.txt.
///   PRIVATE_KEY, optional LIFE_WEI_PER_S (default 115740740740 ≈ 0.01 BNB/day), RESURRECT_WEI (default 0.002 BNB)
contract DeployRegistryV3 is Script {
    address constant TOKEN = 0x23791AA3B031659B593cF141a2Bc76B0ad657777;
    address constant PREVIOUS = 0x0eeB0A675720306Ef6f426Bd8560c1288848f813;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        string memory idj = vm.readFile("../brain/identity.json");
        bytes32 conn = vm.parseBytes32(string.concat("0x", vm.parseJsonString(idj, ".connectome_sha256")));
        bytes32 gen = vm.parseBytes32(string.concat("0x", vm.parseJsonString(idj, ".genesis_state_sha256")));
        string memory cid = vm.trim(vm.readFile("../brand/collection_cid.txt"));
        uint256 lifeWei = vm.envOr("LIFE_WEI_PER_S", uint256(115_740_740_740));
        uint256 resWei = vm.envOr("RESURRECT_WEI", uint256(0.002 ether));
        vm.startBroadcast(pk);
        FlyRegistryV3 r = new FlyRegistryV3(IERC20(TOKEN), conn, 2, gen, 1 ether, 5000 ether, lifeWei, resWei, PREVIOUS, 3600, 10_000, 250,
            "https://www.immortalfly.app/api/meta/", string.concat("ipfs://", cid));
        vm.stopBroadcast();
        console.log("FlyRegistryV3:", address(r));
        console.log("a day of life costs (wei):", r.lifeCost(86_400));
    }
}
