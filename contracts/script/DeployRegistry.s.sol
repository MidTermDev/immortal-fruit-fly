// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Script, console} from "forge-std/Script.sol";
import {FlyRegistry} from "../src/FlyRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployRegistry is Script {
    function run() external {
        string memory idj = vm.readFile("../brain/identity.json");
        bytes32 conn = vm.parseBytes32(string.concat("0x", vm.parseJsonString(idj, ".connectome_sha256")));
        bytes32 gen = vm.parseBytes32(string.concat("0x", vm.parseJsonString(idj, ".genesis_state_sha256")));
        string memory contractURI = string.concat("ipfs://", vm.trim(vm.readFile("../brand/collection_cid.txt")));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        FlyRegistry r = new FlyRegistry(
            IERC20(vm.envAddress("TOKEN_ADDRESS")), conn, 2, gen,
            1 ether,       // mint
            1000 ether,    // resurrect
            1 ether,       // feed, per second of life
            5000 ether,    // breed
            3600,          // seconds of life a fly is born with
            10_000,        // max supply, genesis and children together
            250,           // 2.5% royalties (ERC-2981) to the treasury
            "https://midtermdev.github.io/immortal-fruit-fly/fly/",
            contractURI
        );
        vm.stopBroadcast();
        console.log("FlyRegistry:", address(r));
    }
}
