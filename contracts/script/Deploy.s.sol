// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ImmortalFly} from "../src/ImmortalFly.sol";
import {FlyBrain, IFlyToken} from "../src/FlyBrain.sol";

/// Deploys $FLY and the genesis FlyBrain.
///
///   forge script script/Deploy.s.sol --rpc-url bsc --broadcast --verify -vvvv
///
/// Environment:
///   PRIVATE_KEY        deployer key (receives the whole supply; seed liquidity from it)
///   BSCSCAN_API_KEY    for --verify
///   TOKEN_NAME / TOKEN_SYMBOL / TOKEN_SUPPLY  (defaults below)
///   TOKEN_ADDRESS      set to reuse an already-deployed token and deploy only a brain
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        string memory name = vm.envOr("TOKEN_NAME", string("Immortal Fruit Fly"));
        string memory symbol = vm.envOr("TOKEN_SYMBOL", string("FLY"));
        uint256 supply = vm.envOr("TOKEN_SUPPLY", uint256(1_000_000_000 ether));

        bytes memory table = vm.parseBytes(vm.readFile("data/circuit.hex"));
        string memory pj = vm.readFile("data/params.json");
        int256[] memory g = vm.parseJsonIntArray(pj, ".gains");
        int16[6] memory gains;
        for (uint256 i = 0; i < 6; ++i) gains[i] = int16(g[i]);
        FlyBrain.Params memory p = FlyBrain.Params({
            leak: uint16(vm.parseJsonUint(pj, ".leak")),
            thresh: int16(vm.parseJsonInt(pj, ".thresh")),
            reset: int16(vm.parseJsonInt(pj, ".reset")),
            vMin: int16(vm.parseJsonInt(pj, ".vMin")),
            gains: gains,
            gBias: uint16(vm.parseJsonUint(pj, ".gBias")),
            noise: uint16(vm.parseJsonUint(pj, ".noise")),
            stimGain: uint16(vm.parseJsonUint(pj, ".stimGain")),
            stimTTL: uint16(vm.parseJsonUint(pj, ".stimTTL")),
            walkThreshold: uint16(vm.parseJsonUint(pj, ".walkThreshold")),
            maxSteps: uint8(vm.parseJsonUint(pj, ".maxSteps"))
        });
        string memory mj = vm.readFile("data/circuit_meta.json");
        bytes32 datasetSha = vm.parseBytes32(string.concat("0x", vm.parseJsonString(mj, ".connections_file_sha256")));
        string memory datasetName = string.concat(
            vm.parseJsonString(mj, ".connections_file"), " (doi:", vm.parseJsonString(mj, ".connections_doi"), ")"
        );

        uint64 genesisEnergy = uint64(vm.envOr("GENESIS_ENERGY", uint256(1_000_000)));
        uint256 tokensPerStep = vm.envOr("TOKENS_PER_STEP", uint256(1 ether)); // 1 FLY = 1 step of life
        uint256 stimPrice = vm.envOr("STIM_PRICE", uint256(100 ether)); // 100 FLY per unit strength
        uint256 resurrectPrice = vm.envOr("RESURRECT_PRICE", uint256(100_000 ether));

        vm.startBroadcast(pk);
        address tokenAddr = vm.envOr("TOKEN_ADDRESS", address(0));
        ImmortalFly token;
        if (tokenAddr == address(0)) {
            token = new ImmortalFly(name, symbol, supply, deployer);
        } else {
            token = ImmortalFly(tokenAddr);
        }
        FlyBrain brain = new FlyBrain(
            IFlyToken(address(token)), table, p, datasetName, datasetSha, genesisEnergy, tokensPerStep, stimPrice, resurrectPrice
        );
        vm.stopBroadcast();

        console.log("FLY token:   ", address(token));
        console.log("FlyBrain:    ", address(brain));
        console.log("circuit ptr: ", brain.circuit());
        console.log("neurons:     ", brain.N());
        console.log("synapses:    ", brain.S());
        console.logBytes32(brain.circuitHash());
    }
}
