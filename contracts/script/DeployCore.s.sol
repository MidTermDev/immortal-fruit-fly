// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FlyCore, IFlyRegistry, IFlyToken} from "../src/FlyCore.sol";

/// Deploys FlyCore: the per-fly on-chain compass, keyed by FlyRegistry token id.
///
///   forge script script/DeployCore.s.sol --rpc-url bsc --broadcast --verify -vvvv
///
/// Environment:
///   PRIVATE_KEY        deployer key; the deployer becomes the curator (may `seed` a fresh core once per fly)
///   BSCSCAN_API_KEY    for --verify
///   REGISTRY           FlyRegistry address (default: the live one on BSC mainnet)
///   TOKEN_ADDRESS      $FLY address (default: the live one on BSC mainnet)
///   STIM_PRICE         token-wei per unit of poke strength (default 100 FLY)
///
/// The circuit table and the calibrated v2 parameters are read from data/ exactly as Deploy.s.sol
/// does for FlyBrain, so the core runs the same neurons with the same dynamics. The constructor also
/// derives and stores the propagation table (the synapses with the gains folded in, ~21 KB, a second
/// SSTORE2 blob): deployment takes ~13.4M gas (receipt on a local fork of BSC: 13,415,705), well
/// inside BSC's 70M block limit.
///
/// After deploying: `seed` fly #1 from FlyBrain v2's brainState() (the curator, once; the fixture
/// data/fly1_v2_state.json shows the exact call shape), then put the address in web/src/lib/config.ts
/// and firmware/include/config.h (FLY_CORE).
contract DeployCore is Script {
    address constant REGISTRY_MAINNET = 0x0eeB0A675720306Ef6f426Bd8560c1288848f813;
    address constant TOKEN_MAINNET = 0x23791AA3B031659B593cF141a2Bc76B0ad657777;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address curator = vm.addr(pk);

        bytes memory table = vm.parseBytes(vm.readFile("data/circuit.hex"));
        string memory pj = vm.readFile("data/params.json");
        int256[] memory g = vm.parseJsonIntArray(pj, ".gains");
        int16[6] memory gains;
        for (uint256 i = 0; i < 6; ++i) gains[i] = int16(g[i]);
        FlyCore.Params memory p = FlyCore.Params({
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
            maxSteps: uint8(vm.parseJsonUint(pj, ".maxSteps")),
            persistInput: vm.keyExistsJson(pj, ".persistInput") && vm.parseJsonBool(pj, ".persistInput")
        });
        require(p.persistInput, "data/params.json must be the v2 (persistInput) parameter set");
        string memory mj = vm.readFile("data/circuit_meta.json");
        bytes32 datasetSha = vm.parseBytes32(string.concat("0x", vm.parseJsonString(mj, ".connections_file_sha256")));
        string memory datasetName = string.concat(
            vm.parseJsonString(mj, ".connections_file"), " (doi:", vm.parseJsonString(mj, ".connections_doi"), ")"
        );

        address registry = vm.envOr("REGISTRY", REGISTRY_MAINNET);
        address tokenAddr = vm.envOr("TOKEN_ADDRESS", TOKEN_MAINNET);
        uint256 stimPrice = vm.envOr("STIM_PRICE", uint256(100 ether)); // 100 FLY per unit strength for a poke

        vm.startBroadcast(pk);
        FlyCore core = new FlyCore(IFlyRegistry(registry), IFlyToken(tokenAddr), table, p, datasetName, datasetSha, stimPrice, curator);
        vm.stopBroadcast();

        console.log("FlyCore:     ", address(core));
        console.log("registry:    ", registry);
        console.log("FLY token:   ", tokenAddr);
        console.log("curator:     ", curator);
        console.log("stim price:  ", stimPrice);
        console.log("circuit ptr: ", core.circuit());
        console.log("neurons:     ", core.N());
        console.log("synapses:    ", core.S());
        console.logBytes32(core.circuitHash());
    }
}
