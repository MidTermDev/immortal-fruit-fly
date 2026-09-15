// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ImmortalFly} from "../src/ImmortalFly.sol";
import {FlyBrain, IFlyToken} from "../src/FlyBrain.sol";

/// Replays the exact sequence executed on BSC mainnet by the v1 brain
/// (0x32D28e97b50f5978eb51d7608492CC7221b01f63) and checks the optimised
/// implementation reproduces it bit for bit. The expected values come from
/// the Ticked events on-chain and from sim/flysim.py.
contract DifferentialTest is Test {
    ImmortalFly token;
    FlyBrain brain;

    function params(string memory file) internal view returns (FlyBrain.Params memory p) {
        string memory pj = vm.readFile(file);
        int256[] memory g = vm.parseJsonIntArray(pj, ".gains");
        int16[6] memory gains;
        for (uint256 i = 0; i < 6; ++i) gains[i] = int16(g[i]);
        p = FlyBrain.Params({
            leak: uint16(vm.parseJsonUint(pj, ".leak")), thresh: int16(vm.parseJsonInt(pj, ".thresh")), reset: int16(vm.parseJsonInt(pj, ".reset")),
            vMin: int16(vm.parseJsonInt(pj, ".vMin")), gains: gains, gBias: uint16(vm.parseJsonUint(pj, ".gBias")), noise: uint16(vm.parseJsonUint(pj, ".noise")),
            stimGain: uint16(vm.parseJsonUint(pj, ".stimGain")), stimTTL: uint16(vm.parseJsonUint(pj, ".stimTTL")), walkThreshold: uint16(vm.parseJsonUint(pj, ".walkThreshold")),
            maxSteps: uint8(vm.parseJsonUint(pj, ".maxSteps")),
            persistInput: vm.keyExistsJson(pj, ".persistInput") && vm.parseJsonBool(pj, ".persistInput")
        });
    }

    function setUp() public {
        token = new ImmortalFly("Immortal Fruit Fly", "FLY", 1e27, address(this));
        bytes memory table = vm.parseBytes(vm.readFile("data/circuit.hex"));
        brain = new FlyBrain(IFlyToken(address(token)), table, params("data/params_v1_deployed.json"), "x", bytes32(0), 1_000_000, 1 ether, 100 ether, 100_000 ether);
        token.approve(address(brain), type(uint256).max);
    }

    function test_replayMainnetV1() public {
        brain.tick(64);
        assertEq(brain.totalSpikes(), 0);
        brain.feed(10_000 ether);
        brain.stimulate(1, 4, 4, 32); // CUE wedge 4, strength 4
        assertEq(brain.totalSpikes(), 279, "cue spikes");
        assertEq(brain.headX(), -2446);
        assertEq(brain.headY(), 11821);
        assertEq(brain.posX(), -103);
        assertEq(brain.posY(), 501);
        brain.tick(32);
        assertEq(brain.totalSpikes(), 279 + 254, "tick spikes");
        assertEq(brain.headX(), -835);
        assertEq(brain.headY(), 11896);
        assertEq(brain.posX(), -138);
        assertEq(brain.posY(), 1011);
        brain.tick(32);
        assertEq(brain.totalSpikes(), 533);
        brain.stimulate(4, 0, 4, 32); // SHOCK
        assertEq(brain.totalSpikes(), 533 + 283, "shock spikes");
        assertEq(brain.energy(), 1_009_808);
    }

    function test_gasReport() public {
        brain.feed(100_000 ether);
        brain.stimulate(1, 4, 4, 32);
        uint256 g0 = gasleft();
        brain.tick(32);
        console.log("gas tick(32) with cue active:", g0 - gasleft());
        brain.stimulate(2, 0, 6, 1);
        g0 = gasleft();
        brain.tick(32);
        console.log("gas tick(32) during turn-left x6:", g0 - gasleft());
    }
}
