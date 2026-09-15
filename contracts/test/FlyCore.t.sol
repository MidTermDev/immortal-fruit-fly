// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ImmortalFly} from "../src/ImmortalFly.sol";
import {FlyRegistry} from "../src/FlyRegistry.sol";
import {FlyBrain, IFlyToken} from "../src/FlyBrain.sol";
import {FlyCore, IFlyRegistry, IFlyToken as ICoreToken} from "../src/FlyCore.sol";

/// FlyCore = FlyBrain v2's kernel, one core per registry fly. The differential test drives the
/// same stimulus/tick sequence through a fresh FlyBrain (v2 params, persistInput) and through a
/// FlyCore core and requires every state word to agree after every action.
contract FlyCoreTest is Test {
    ImmortalFly token;
    FlyRegistry reg;
    FlyBrain brain; // the reference: FlyBrain v2, singleton
    FlyCore core;

    address alice = makeAddr("alice"); // owns the flies
    address bob = makeAddr("bob"); // a poker with tokens + allowance
    address stranger = makeAddr("stranger"); // tokens, no allowance
    address pebbleA = makeAddr("pebbleA"); // body of fly 1
    address pebbleB = makeAddr("pebbleB"); // body of fly 2
    address curator = makeAddr("curator");

    uint256 idA; // fly 1, hosted by pebbleA
    uint256 idB; // fly 2, hosted by pebbleB

    bytes32 constant CONN = keccak256("connectome");
    bytes32 constant GEN = keccak256("genesis");
    uint256 constant STIM_PRICE = 100 ether;
    uint8 constant CUE = 1;
    uint8 constant TURN_LEFT = 2;
    uint8 constant TURN_RIGHT = 3;
    uint8 constant SHOCK = 4;

    // ------------------------------------------------------------------ setup

    function brainParams() internal view returns (FlyBrain.Params memory p) {
        string memory pj = vm.readFile("data/params.json");
        int256[] memory g = vm.parseJsonIntArray(pj, ".gains");
        int16[6] memory gains;
        for (uint256 i = 0; i < 6; ++i) gains[i] = int16(g[i]);
        p = FlyBrain.Params({
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
    }

    function coreParams() internal view returns (FlyCore.Params memory p) {
        FlyBrain.Params memory b = brainParams();
        p = FlyCore.Params({
            leak: b.leak,
            thresh: b.thresh,
            reset: b.reset,
            vMin: b.vMin,
            gains: b.gains,
            gBias: b.gBias,
            noise: b.noise,
            stimGain: b.stimGain,
            stimTTL: b.stimTTL,
            walkThreshold: b.walkThreshold,
            maxSteps: b.maxSteps,
            persistInput: b.persistInput
        });
    }

    function setUp() public {
        token = new ImmortalFly("Immortal Fruit Fly", "FLY", 1e27, address(this));
        reg = new FlyRegistry(
            IERC20(address(token)), CONN, 2, GEN, 1 ether, 1000 ether, 1 ether, 5000 ether, 3600, 100, 250, "https://fly.test/api/fly/", "ipfs://collection"
        );
        bytes memory table = vm.parseBytes(vm.readFile("data/circuit.hex"));
        FlyBrain.Params memory bp = brainParams();
        assertTrue(bp.persistInput, "params.json must be v2 (persistInput)");
        brain = new FlyBrain(IFlyToken(address(token)), table, bp, "x", bytes32(0), 1_000_000_000, 1 ether, STIM_PRICE, 100_000 ether);
        core = new FlyCore(IFlyRegistry(address(reg)), ICoreToken(address(token)), table, coreParams(), "x", bytes32(0), STIM_PRICE, curator);

        token.approve(address(brain), type(uint256).max);
        token.transfer(alice, 100_000 ether);
        token.transfer(bob, 100_000 ether);
        token.transfer(stranger, 100_000 ether);
        vm.prank(alice);
        token.approve(address(reg), type(uint256).max);
        vm.prank(bob);
        token.approve(address(core), type(uint256).max);

        vm.prank(pebbleA);
        reg.registerBody("Pebble A", "https://fly.test/pebble/a");
        vm.prank(pebbleB);
        reg.registerBody("Pebble B", "https://fly.test/pebble/b");

        vm.startPrank(alice);
        idA = reg.mint("Specimen 001");
        idB = reg.mint("Specimen 002");
        reg.assign(idA, pebbleA);
        reg.assign(idB, pebbleB);
        vm.stopPrank();
        vm.prank(pebbleA);
        reg.accept(idA);
        vm.prank(pebbleB);
        reg.accept(idB);
        assertEq(reg.fly(idA).body, pebbleA);
        assertEq(reg.fly(idB).body, pebbleB);
    }

    // ------------------------------------------------------------ helpers

    struct State {
        int16[] v;
        int8[] bias;
        uint16[16] hist;
        int32[] inp;
        uint64 step;
        int64 posX;
        int64 posY;
        int32 headX;
        int32 headY;
        uint64 totalSpikes;
    }

    function brainState() internal view returns (State memory s) {
        (s.v, s.bias, s.hist, s.inp, s.step,,,, s.posX, s.posY, s.headX, s.headY) = brain.brainState();
        s.totalSpikes = brain.totalSpikes();
    }

    function coreState(uint256 id) internal view returns (State memory s) {
        (s.v, s.bias, s.hist, s.inp, s.step, s.headX, s.headY, s.posX, s.posY,,,,, s.totalSpikes) = core.core(id);
    }

    /// v, bias, inp, heading histogram, step and heading: the brain proper (not the body's position or spike count).
    function assertSameBrain(State memory a, State memory b, string memory tag) internal pure {
        assertEq(a.v.length, 155, tag);
        assertEq(b.v.length, 155, tag);
        for (uint256 i = 0; i < 155; ++i) {
            assertEq(a.v[i], b.v[i], string.concat(tag, " v"));
            assertEq(a.bias[i], b.bias[i], string.concat(tag, " bias"));
            assertEq(a.inp[i], b.inp[i], string.concat(tag, " inp"));
        }
        for (uint256 w = 0; w < 16; ++w) {
            assertEq(a.hist[w], b.hist[w], string.concat(tag, " hist"));
        }
        assertEq(a.step, b.step, string.concat(tag, " step"));
        assertEq(a.headX, b.headX, string.concat(tag, " headX"));
        assertEq(a.headY, b.headY, string.concat(tag, " headY"));
    }

    function assertSameState(State memory a, State memory b, string memory tag) internal pure {
        assertSameBrain(a, b, tag);
        assertEq(a.posX, b.posX, string.concat(tag, " posX"));
        assertEq(a.posY, b.posY, string.concat(tag, " posY"));
        assertEq(a.totalSpikes, b.totalSpikes, string.concat(tag, " totalSpikes"));
    }

    function assertSameStimulus(uint256 id, string memory tag) internal view {
        (uint8 ch, uint8 param, uint16 strength, uint64 until, bool active) = brain.activeStimulus();
        (uint8 ch2, uint8 param2, uint16 strength2, uint64 until2, bool active2) = core.activeStimulus(id);
        assertEq(ch, ch2, string.concat(tag, " stimChannel"));
        assertEq(param, param2, string.concat(tag, " stimParam"));
        assertEq(strength, strength2, string.concat(tag, " stimStrength"));
        assertEq(until, until2, string.concat(tag, " stimUntilStep"));
        assertEq(active, active2, string.concat(tag, " stimActive"));
    }

    // ------------------------------------------------------- (0) identity

    function test_sameCircuitAndParamsAsFlyBrain() public view {
        assertEq(core.N(), 155);
        assertEq(core.S(), 6522);
        assertEq(core.circuitHash(), brain.circuitHash());
        assertEq(keccak256(core.circuitData()), core.circuitHash());
        assertEq(core.LEAK(), brain.LEAK());
        assertEq(core.THRESH(), brain.THRESH());
        assertEq(core.RESET(), brain.RESET());
        assertEq(core.V_MIN(), brain.V_MIN());
        assertEq(core.GAINS(), brain.GAINS());
        assertEq(core.G_BIAS(), brain.G_BIAS());
        assertEq(core.NOISE(), brain.NOISE());
        assertEq(core.STIM_GAIN(), brain.STIM_GAIN());
        assertEq(core.STIM_TTL(), brain.STIM_TTL());
        assertEq(core.WALK_THRESHOLD(), brain.WALK_THRESHOLD());
        assertEq(core.MAX_STEPS(), brain.MAX_STEPS());
        assertTrue(core.PERSIST_INPUT());
        assertEq(core.STIM_PRICE(), STIM_PRICE);
        assertEq(address(core.registry()), address(reg));
        assertEq(address(core.token()), address(token));
        assertEq(core.curator(), curator);
        for (uint8 t = 0; t < 6; ++t) {
            assertEq(core.gainOf(t), brain.gainOf(t));
        }
        for (uint256 i = 0; i < 155; i += 17) {
            (uint64 r1, uint8 t1, uint8 w1, uint8 s1, uint16 o1) = brain.neuron(i);
            (uint64 r2, uint8 t2, uint8 w2, uint8 s2, uint16 o2) = core.neuron(i);
            assertEq(r1, r2);
            assertEq(t1, t2);
            assertEq(w1, w2);
            assertEq(s1, s2);
            assertEq(o1, o2);
            (uint8[] memory p1, uint8[] memory q1) = brain.synapsesOf(i);
            (uint8[] memory p2, uint8[] memory q2) = core.synapsesOf(i);
            assertEq(keccak256(abi.encodePacked(p1)), keccak256(abi.encodePacked(p2)));
            assertEq(keccak256(abi.encodePacked(q1)), keccak256(abi.encodePacked(q2)));
        }
        // a fresh core is all zeros and hashes like one
        State memory s = coreState(idA);
        assertEq(s.step, 0);
        assertEq(s.totalSpikes, 0);
        assertEq(core.coreHash(idA), keccak256(abi.encodePacked(new uint256[](16), new uint256[](32), new uint256[](8), uint256(0), uint64(0))));
    }

    function test_constructorRejectsV1ParamsAndBadTable() public {
        bytes memory table = vm.parseBytes(vm.readFile("data/circuit.hex"));
        FlyCore.Params memory p = coreParams();
        p.persistInput = false;
        vm.expectRevert(bytes("persistInput"));
        new FlyCore(IFlyRegistry(address(reg)), ICoreToken(address(token)), table, p, "x", bytes32(0), STIM_PRICE, curator);
        vm.expectRevert(abi.encodeWithSelector(FlyCore.BadTable.selector, "version"));
        new FlyCore(IFlyRegistry(address(reg)), ICoreToken(address(token)), hex"02000000", coreParams(), "x", bytes32(0), STIM_PRICE, curator);

        // a synapse aimed past the last neuron (checked while the propagation table is built)
        bytes memory bad = bytes.concat(table); // a copy: memory arrays alias
        uint256 offSyn = 4 + 3 * 155 + 2 * 156;
        bad[offSyn + 2 * 1234] = bytes1(uint8(155));
        vm.expectRevert(abi.encodeWithSelector(FlyCore.BadTable.selector, "post"));
        new FlyCore(IFlyRegistry(address(reg)), ICoreToken(address(token)), bad, coreParams(), "x", bytes32(0), STIM_PRICE, curator);

        // a gain whose folded contribution w * gain / 16 does not fit the table's int16
        p = coreParams();
        p.gains[0] = type(int16).max;
        vm.expectRevert(abi.encodeWithSelector(FlyCore.BadTable.selector, "gain"));
        new FlyCore(IFlyRegistry(address(reg)), ICoreToken(address(token)), table, p, "x", bytes32(0), STIM_PRICE, curator);
    }

    // ----------------------------------------------- (1) differential

    /// The same 10 actions on FlyBrain v2 and on fly idA's core: identical state after every one.
    function test_differential_flyCoreEqualsFlyBrainV2() public {
        // action 1: cue wedge 4 x4, 32 steps
        brain.stimulate(CUE, 4, 4, 32);
        vm.prank(pebbleA);
        core.stimulate(idA, CUE, 4, 4, 32);
        assertSameState(brainState(), coreState(idA), "a1");
        assertSameStimulus(idA, "a1");
        assertGt(coreState(idA).totalSpikes, 0, "the cue makes it spike");

        // action 2: tick 16
        brain.tick(16);
        vm.prank(bob);
        core.tick(idA, 16);
        assertSameState(brainState(), coreState(idA), "a2");
        assertSameStimulus(idA, "a2");

        // action 3: turn left x3, 20 steps
        brain.stimulate(TURN_LEFT, 0, 3, 20);
        vm.prank(pebbleA);
        core.stimulate(idA, TURN_LEFT, 0, 3, 20);
        assertSameState(brainState(), coreState(idA), "a3");
        assertSameStimulus(idA, "a3");

        // action 4: tick 64 (the stimulus expires during this tick)
        brain.tick(64);
        core.tick(idA, 64);
        assertSameState(brainState(), coreState(idA), "a4");
        assertSameStimulus(idA, "a4");
        (,,,, bool active) = core.activeStimulus(idA);
        assertFalse(active, "turn expired");

        // action 5: shock x2, 8 steps
        brain.stimulate(SHOCK, 0, 2, 8);
        vm.prank(pebbleA);
        core.stimulate(idA, SHOCK, 0, 2, 8);
        assertSameState(brainState(), coreState(idA), "a5");
        assertSameStimulus(idA, "a5");

        // action 6: tick 32
        brain.tick(32);
        vm.prank(alice);
        core.tick(idA, 32);
        assertSameState(brainState(), coreState(idA), "a6");
        assertSameStimulus(idA, "a6");

        // action 7: cue wedge 12 x5, 1 step (a poke by bob, paid)
        brain.stimulate(CUE, 12, 5, 1);
        vm.prank(bob);
        core.stimulate(idA, CUE, 12, 5, 1);
        assertSameState(brainState(), coreState(idA), "a7");
        assertSameStimulus(idA, "a7");

        // action 8: tick 48
        brain.tick(48);
        core.tick(idA, 48);
        assertSameState(brainState(), coreState(idA), "a8");
        assertSameStimulus(idA, "a8");

        // action 9: turn right x6, 64 steps
        brain.stimulate(TURN_RIGHT, 0, 6, 64);
        vm.prank(pebbleA);
        core.stimulate(idA, TURN_RIGHT, 0, 6, 64);
        assertSameState(brainState(), coreState(idA), "a9");
        assertSameStimulus(idA, "a9");

        // action 10: tick 64
        brain.tick(64);
        core.tick(idA, 64);
        State memory b = brainState();
        State memory c = coreState(idA);
        assertSameState(b, c, "a10");
        assertSameStimulus(idA, "a10");
        assertEq(c.step, 32 + 16 + 20 + 64 + 8 + 32 + 1 + 48 + 64 + 64);
        assertTrue(c.posX != 0 || c.posY != 0, "it walked");
        assertGt(c.totalSpikes, 1000, "it lived");

        // and the hash covers exactly the words the state view shows
        bytes32 h = core.coreHash(idA);
        assertTrue(h != bytes32(0));
        // FlyBrain's hash orders the words differently (v, bias, inp, hist, step, generation); rebuild ours from the view
        uint256[16] memory vw;
        uint256[32] memory iw;
        uint256[8] memory bw;
        for (uint256 i = 0; i < 155; ++i) {
            vw[i / 16] |= uint256(uint16(c.v[i])) << ((i % 16) * 16);
            iw[i / 8] |= uint256(uint32(c.inp[i])) << ((i % 8) * 32);
            bw[i / 32] |= uint256(uint8(c.bias[i])) << ((i % 32) * 8);
        }
        uint256 hh;
        for (uint256 w = 0; w < 16; ++w) hh |= uint256(c.hist[w]) << (w * 16);
        assertEq(h, keccak256(abi.encodePacked(vw, iw, bw, hh, c.step)), "coreHash layout");
    }

    /// The Ticked event carries what FlyBrain's does (minus energy), keyed by id and caller.
    function test_tickedEventMatchesFlyBrain() public {
        brain.stimulate(CUE, 4, 4, 0);
        vm.prank(pebbleA);
        core.stimulate(idA, CUE, 4, 4, 0);
        vm.recordLogs();
        brain.tick(16);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint64 fromStep, uint16 steps, uint32 spikes, int32 hx, int32 hy, int64 px, int64 py,) =
            abi.decode(logs[logs.length - 1].data, (uint64, uint16, uint32, int32, int32, int64, int64, uint64));
        vm.expectEmit(true, true, true, true, address(core));
        emit FlyCore.Ticked(idA, bob, fromStep, steps, spikes, hx, hy, px, py);
        vm.prank(bob);
        core.tick(idA, 16);
    }

    // --------------------------------------------- (2) independence

    function test_twoCoresAreIndependent() public {
        bytes32 freshB = core.coreHash(idB);
        vm.prank(pebbleA);
        core.stimulate(idA, CUE, 4, 4, 32);
        core.tick(idA, 32);
        assertEq(core.coreHash(idB), freshB, "fly B untouched by fly A's ticks");
        assertEq(coreState(idB).step, 0);
        assertEq(coreState(idB).totalSpikes, 0);
        (,,,, bool activeB) = core.activeStimulus(idB);
        assertFalse(activeB);

        bytes32 hA = core.coreHash(idA);
        State memory sA = coreState(idA);
        vm.prank(pebbleB);
        core.stimulate(idB, SHOCK, 0, 3, 16);
        core.tick(idB, 64);
        assertEq(core.coreHash(idA), hA, "fly A untouched by fly B's ticks");
        assertSameState(sA, coreState(idA), "A unchanged");
        assertEq(coreState(idB).step, 80);
        assertTrue(core.coreHash(idB) != hA);

        // determinism across ids: the same sequence from a fresh core gives the same brain
        vm.prank(alice);
        uint256 idC = reg.mint("Specimen 003");
        vm.prank(alice);
        reg.assign(idC, pebbleB);
        vm.prank(pebbleB);
        reg.accept(idC);
        vm.prank(pebbleB);
        core.stimulate(idC, CUE, 4, 4, 32);
        core.tick(idC, 32);
        assertEq(core.coreHash(idC), hA, "same stimuli, same brain");
        State memory sC = coreState(idC);
        assertSameState(sA, sC, "A == C");
    }

    // ------------------------------------------ (3) body free, poker burns

    function test_bodySensesForFreePokerBurns() public {
        uint256 dead0 = token.balanceOf(core.DEAD());
        uint256 pebble0 = token.balanceOf(pebbleA);

        // the body of fly A stimulates fly A: free
        vm.expectEmit(true, true, true, true, address(core));
        emit FlyCore.Stimulated(idA, pebbleA, CUE, 4, 4, uint64(core.STIM_TTL()), 0);
        vm.prank(pebbleA);
        core.stimulate(idA, CUE, 4, 4, 16);
        assertEq(token.balanceOf(core.DEAD()), dead0, "body pays nothing");
        assertEq(token.balanceOf(pebbleA), pebble0);
        assertEq(core.totalBurned(), 0);
        assertEq(coreState(idA).step, 16);

        // bob is not the body: burns strength * STIM_PRICE
        uint256 bob0 = token.balanceOf(bob);
        vm.expectEmit(true, true, true, true, address(core));
        emit FlyCore.Stimulated(idA, bob, SHOCK, 0, 3, uint64(16 + core.STIM_TTL()), 3 * STIM_PRICE);
        vm.prank(bob);
        core.stimulate(idA, SHOCK, 0, 3, 8);
        assertEq(token.balanceOf(core.DEAD()), dead0 + 3 * STIM_PRICE, "poke burned to DEAD");
        assertEq(token.balanceOf(bob), bob0 - 3 * STIM_PRICE);
        assertEq(core.totalBurned(), 3 * STIM_PRICE);
        assertEq(coreState(idA).step, 24);

        // stranger has tokens but no allowance: reverts, nothing changes
        bytes32 hBefore = core.coreHash(idA);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(core), 0, 2 * STIM_PRICE));
        core.stimulate(idA, CUE, 1, 2, 4);
        assertEq(core.coreHash(idA), hBefore);
        assertEq(coreState(idA).step, 24);

        // the owner of the fly is not its body either
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(core), 0, STIM_PRICE));
        core.stimulate(idA, CUE, 1, 1, 0);

        // the body of fly A is NOT free on fly B
        vm.prank(pebbleA);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(core), 0, STIM_PRICE));
        core.stimulate(idB, CUE, 1, 1, 0);
        token.transfer(pebbleA, 1000 ether);
        vm.prank(pebbleA);
        token.approve(address(core), type(uint256).max);
        uint256 dead1 = token.balanceOf(core.DEAD());
        vm.prank(pebbleA);
        core.stimulate(idB, CUE, 1, 1, 0);
        assertEq(token.balanceOf(core.DEAD()), dead1 + STIM_PRICE, "pebble A pays to poke fly B");
        // ...while pebble B senses fly B for free
        vm.prank(pebbleB);
        core.stimulate(idB, CUE, 1, 1, 0);
        assertEq(token.balanceOf(core.DEAD()), dead1 + STIM_PRICE);

        // a body that hands the fly off is no longer free; the new body is
        vm.prank(pebbleA);
        reg.assign(idA, pebbleB);
        vm.prank(pebbleB);
        reg.accept(idA);
        vm.prank(pebbleA);
        core.stimulate(idA, CUE, 2, 1, 0);
        assertEq(token.balanceOf(core.DEAD()), dead1 + 2 * STIM_PRICE, "old body pays");
        vm.prank(pebbleB);
        core.stimulate(idA, CUE, 2, 1, 0);
        assertEq(token.balanceOf(core.DEAD()), dead1 + 2 * STIM_PRICE, "new body is free");
    }

    function test_stimulateValidation() public {
        uint16 tooMany = uint16(core.MAX_STEPS()) + 1;
        vm.startPrank(pebbleA);
        vm.expectRevert(FlyCore.BadChannel.selector);
        core.stimulate(idA, 0, 0, 1, 0);
        vm.expectRevert(FlyCore.BadChannel.selector);
        core.stimulate(idA, 5, 0, 1, 0);
        vm.expectRevert(FlyCore.BadChannel.selector);
        core.stimulate(idA, CUE, 16, 1, 0);
        vm.expectRevert(FlyCore.BadStrength.selector);
        core.stimulate(idA, CUE, 3, 0, 0);
        vm.expectRevert(FlyCore.BadSteps.selector);
        core.stimulate(idA, CUE, 3, 1, tooMany);
        vm.stopPrank();
        vm.expectRevert(FlyCore.BadSteps.selector);
        core.tick(idA, 0);
        vm.expectRevert(FlyCore.BadSteps.selector);
        core.tick(idA, tooMany);
        assertEq(coreState(idA).step, 0);
    }

    function test_stimulusExpiresLikeFlyBrain() public {
        vm.prank(pebbleA);
        core.stimulate(idA, SHOCK, 0, 2, 0);
        uint16 ttl = core.STIM_TTL();
        uint16 maxSteps = core.MAX_STEPS();
        uint256 done = 0;
        while (done < ttl) {
            uint16 s = ttl - done > maxSteps ? maxSteps : uint16(ttl - done);
            core.tick(idA, s);
            done += s;
        }
        (uint8 ch,,,, bool active) = core.activeStimulus(idA);
        assertFalse(active);
        assertEq(ch, 0);
    }

    // ----------------------------------------- (4) registry gating

    function test_deadFlyAndNoSuchFlyRevert() public {
        vm.prank(pebbleA);
        core.stimulate(idA, CUE, 4, 4, 16);
        // the body reports the death in the registry
        vm.prank(pebbleA);
        reg.died(idA, keccak256("d"), keccak256("m"), "ipfs://d", "", 10, "starved");
        assertFalse(reg.fly(idA).alive);
        bytes32 h = core.coreHash(idA);

        vm.expectRevert(FlyCore.Dead.selector);
        core.tick(idA, 16);
        vm.prank(bob);
        vm.expectRevert(FlyCore.Dead.selector);
        core.stimulate(idA, CUE, 4, 4, 0);
        vm.prank(pebbleA);
        vm.expectRevert(FlyCore.Dead.selector);
        core.stimulate(idA, CUE, 4, 4, 16);
        assertEq(core.coreHash(idA), h, "the dead brain is preserved");
        assertEq(coreState(idA).step, 16);

        // resurrected: the same core continues
        vm.prank(alice);
        reg.resurrect(idA, 600);
        core.tick(idA, 16);
        assertEq(coreState(idA).step, 32);

        // never minted
        uint256 ghost = 99;
        vm.expectRevert(FlyCore.NoSuchFly.selector);
        core.tick(ghost, 16);
        vm.prank(bob);
        vm.expectRevert(FlyCore.NoSuchFly.selector);
        core.stimulate(ghost, CUE, 4, 4, 0);
        vm.expectRevert(FlyCore.NoSuchFly.selector);
        core.tick(0, 1);
        // the views still answer (all zeros)
        assertEq(coreState(ghost).step, 0);
    }

    // ------------------------------------------------ (5) seed

    function seedVectors() internal pure returns (int16[] memory v, int8[] memory bias, uint16[16] memory hist, int32[] memory inp) {
        v = new int16[](155);
        bias = new int8[](155);
        inp = new int32[](155);
        for (uint256 i = 0; i < 155; ++i) {
            v[i] = int16(int256(i) * 37 - 2900);
            bias[i] = int8(int256(i) % 49 - 24);
            inp[i] = int32(int256(i) * 1001 - 77_777);
        }
        for (uint256 w = 0; w < 16; ++w) hist[w] = uint16(w * 4097 + 1);
    }

    function test_seedOnceByCuratorOnly() public {
        (int16[] memory v, int8[] memory bias, uint16[16] memory hist, int32[] memory inp) = seedVectors();

        vm.prank(bob);
        vm.expectRevert(FlyCore.NotCurator.selector);
        core.seed(idA, v, bias, hist, inp, 123_456, -1234, 5678);
        vm.prank(pebbleA);
        vm.expectRevert(FlyCore.NotCurator.selector);
        core.seed(idA, v, bias, hist, inp, 123_456, -1234, 5678);
        vm.prank(alice);
        vm.expectRevert(FlyCore.NotCurator.selector);
        core.seed(idA, v, bias, hist, inp, 123_456, -1234, 5678);

        vm.expectEmit(true, true, true, true, address(core));
        emit FlyCore.Seeded(idA, 123_456);
        vm.prank(curator);
        core.seed(idA, v, bias, hist, inp, 123_456, -1234, 5678);
        assertTrue(core.seeded(idA));

        State memory s = coreState(idA);
        for (uint256 i = 0; i < 155; ++i) {
            assertEq(s.v[i], v[i], "v");
            assertEq(s.bias[i], bias[i], "bias");
            assertEq(s.inp[i], inp[i], "inp");
        }
        for (uint256 w = 0; w < 16; ++w) assertEq(s.hist[w], hist[w], "hist");
        assertEq(s.step, 123_456);
        assertEq(s.headX, -1234);
        assertEq(s.headY, 5678);
        assertEq(s.posX, 0);
        assertEq(s.posY, 0);
        assertEq(s.totalSpikes, 0);

        // not twice
        vm.prank(curator);
        vm.expectRevert(FlyCore.AlreadySeeded.selector);
        core.seed(idA, v, bias, hist, inp, 1, 0, 0);

        // the seeded core continues from its step
        vm.expectEmit(true, true, false, false, address(core));
        emit FlyCore.Ticked(idA, address(this), 123_456, 16, 0, 0, 0, 0, 0);
        core.tick(idA, 16);
        assertEq(coreState(idA).step, 123_472);

        // not after ticking (fly B has run)
        core.tick(idB, 1);
        vm.prank(curator);
        vm.expectRevert(FlyCore.AlreadySeeded.selector);
        core.seed(idB, v, bias, hist, inp, 5, 0, 0);

        // not for a fly that does not exist
        vm.prank(curator);
        vm.expectRevert(FlyCore.NoSuchFly.selector);
        core.seed(99, v, bias, hist, inp, 5, 0, 0);

        // seeding with step 0 still counts as seeded
        vm.prank(alice);
        uint256 idC = reg.mint("Specimen 003");
        vm.prank(curator);
        core.seed(idC, v, bias, hist, inp, 0, 0, 0);
        vm.prank(curator);
        vm.expectRevert(FlyCore.AlreadySeeded.selector);
        core.seed(idC, v, bias, hist, inp, 0, 0, 0);

        // wrong lengths
        vm.prank(alice);
        uint256 idD = reg.mint("Specimen 004");
        int16[] memory shortV = new int16[](154);
        vm.prank(curator);
        vm.expectRevert(bytes("length"));
        core.seed(idD, shortV, bias, hist, inp, 0, 0, 0);
    }

    /// A seeded core is the same brain as the FlyBrain it was copied from: seed a core with the
    /// brain's state after a run and both must evolve identically from there (the FlyBrain v2 ->
    /// FlyCore continuity path for fly #1). Position and spike counts start from zero in the core.
    function test_seedCarriesTheBrainOver() public {
        brain.stimulate(CUE, 4, 4, 32);
        brain.tick(64);
        brain.stimulate(TURN_LEFT, 0, 3, 40);
        brain.tick(64); // the turn expires during this tick: a quiet brain, like fly #1 between pokes
        (,,,, bool active) = brain.activeStimulus();
        assertFalse(active);
        State memory b0 = brainState();
        assertEq(b0.step, 200);

        vm.prank(curator);
        core.seed(idB, b0.v, b0.bias, b0.hist, b0.inp, b0.step, b0.headX, b0.headY);
        assertSameBrain(b0, coreState(idB), "seeded");

        // from here on they are the same brain
        brain.tick(32);
        core.tick(idB, 32);
        assertSameBrain(brainState(), coreState(idB), "s1");
        brain.stimulate(SHOCK, 0, 2, 16);
        vm.prank(bob);
        core.stimulate(idB, SHOCK, 0, 2, 16);
        assertSameBrain(brainState(), coreState(idB), "s2");
        brain.stimulate(CUE, 9, 5, 64);
        vm.prank(pebbleB);
        core.stimulate(idB, CUE, 9, 5, 64);
        State memory b = brainState();
        State memory c = coreState(idB);
        assertSameBrain(b, c, "s3");
        assertSameStimulus(idB, "s3");
        // the core walked the brain's delta from the origin and counted only its own spikes
        assertEq(c.posX, b.posX - b0.posX, "posX delta");
        assertEq(c.posY, b.posY - b0.posY, "posY delta");
        assertEq(c.totalSpikes, b.totalSpikes - b0.totalSpikes, "spikes since seed");
        assertGt(c.totalSpikes, 0);
    }

    // ------------------------------------------- (6) fly #1's real state

    /// Fly #1's compass as it is on mainnet: FlyBrain v2's brainState() (data/fly1_v2_state.json),
    /// a mature engram after ~21k keeper steps. Seeded into `id` by the curator, as the migration will.
    function seedFly1(uint256 id) internal returns (uint64 step) {
        string memory j = vm.readFile("data/fly1_v2_state.json");
        assertFalse(vm.parseJsonBool(j, ".stimulus.active"), "fixture must have no active stimulus");
        (int16[] memory v, int8[] memory bias, uint16[16] memory hist, int32[] memory inp) = parseSeed(j, "");
        step = uint64(vm.parseJsonUint(j, ".step"));
        vm.prank(curator);
        core.seed(id, v, bias, hist, inp, step, int32(vm.parseJsonInt(j, ".headX")), int32(vm.parseJsonInt(j, ".headY")));
    }

    function parseSeed(string memory j, string memory prefix)
        internal
        pure
        returns (int16[] memory v, int8[] memory bias, uint16[16] memory hist, int32[] memory inp)
    {
        int256[] memory vj = vm.parseJsonIntArray(j, string.concat(prefix, ".v"));
        int256[] memory bj = vm.parseJsonIntArray(j, string.concat(prefix, ".bias"));
        int256[] memory ij = vm.parseJsonIntArray(j, string.concat(prefix, ".inp"));
        uint256[] memory hj = vm.parseJsonUintArray(j, string.concat(prefix, ".hist"));
        assertEq(vj.length, 155);
        v = new int16[](155);
        bias = new int8[](155);
        inp = new int32[](155);
        for (uint256 i = 0; i < 155; ++i) {
            v[i] = int16(vj[i]);
            bias[i] = int8(bj[i]);
            inp[i] = int32(ij[i]);
        }
        for (uint256 w = 0; w < 16; ++w) hist[w] = uint16(hj[w]);
    }

    /// The propagation table the constructor derives (the kernel's synapse walk) is exactly what an
    /// independent build of it gives (data/make_fly1_replay.py), and it is served as declared.
    function test_propagationTableMatchesIndependentBuild() public view {
        string memory j = vm.readFile("data/fly1_replay.json");
        bytes memory prop = core.propagationData();
        assertEq(prop.length, vm.parseJsonUint(j, ".propagationLength"), "propagation length");
        assertEq(keccak256(prop), core.propagationHash(), "propagationHash");
        assertEq(core.propagationHash(), vm.parseJsonBytes32(j, ".propagationHash"), "propagation table");
        // header: neuron 0 starts at group 0, the last entry is the total group count, offsets are monotonic
        uint256 n = core.N();
        uint256 prev = 0;
        for (uint256 i = 0; i <= n; ++i) {
            uint256 g = (uint256(uint8(prop[2 * i])) << 8) | uint256(uint8(prop[2 * i + 1]));
            assertGe(g, prev, "monotonic groups");
            prev = g;
        }
        assertEq(prop.length, 2 * (n + 1) + 15 * prev + 17, "groups + tail padding");
    }

    /// FlyCore on fly #1's real state == sim/flysim.py on the same state, action by action: the
    /// pebble's kind of stimuli (turns at strength 40, cues at 8, a shock at 20, pokes, 1..64-step
    /// ticks, stimuli expiring mid-tick), 21 actions, every core hash equal (data/fly1_replay.json).
    function test_replayFly1StateAgainstFlysim() public {
        string memory j = vm.readFile("data/fly1_replay.json");
        (int16[] memory v, int8[] memory bias, uint16[16] memory hist, int32[] memory inp) = parseSeed(j, ".seed");
        vm.prank(curator);
        core.seed(
            idA, v, bias, hist, inp, uint64(vm.parseJsonUint(j, ".seed.step")), int32(vm.parseJsonInt(j, ".seed.headX")), int32(vm.parseJsonInt(j, ".seed.headY"))
        );
        assertEq(core.coreHash(idA), vm.parseJsonBytes32(j, ".seedCoreHash"), "seed hash");
        // the seed is what the fixture says the live brain was
        assertEq(coreState(idA).step, vm.parseJsonUint(j, ".seed.step"));

        uint256 count = vm.parseJsonUint(j, ".actionCount");
        assertEq(count, 21);
        for (uint256 k = 0; k < count; ++k) {
            string memory a = string.concat(".actions[", vm.toString(k), "]");
            uint16 steps = uint16(vm.parseJsonUint(j, string.concat(a, ".steps")));
            if (keccak256(bytes(vm.parseJsonString(j, string.concat(a, ".op")))) == keccak256("stimulate")) {
                vm.prank(pebbleA);
                core.stimulate(
                    idA,
                    uint8(vm.parseJsonUint(j, string.concat(a, ".channel"))),
                    uint8(vm.parseJsonUint(j, string.concat(a, ".param"))),
                    uint8(vm.parseJsonUint(j, string.concat(a, ".strength"))),
                    steps
                );
            } else {
                core.tick(idA, steps);
            }
            string memory e = string.concat(a, ".expect");
            string memory tag = string.concat("action ", vm.toString(k));
            State memory s = coreState(idA);
            assertEq(core.coreHash(idA), vm.parseJsonBytes32(j, string.concat(e, ".coreHash")), string.concat(tag, " coreHash"));
            assertEq(s.step, vm.parseJsonUint(j, string.concat(e, ".step")), string.concat(tag, " step"));
            assertEq(s.headX, vm.parseJsonInt(j, string.concat(e, ".headX")), string.concat(tag, " headX"));
            assertEq(s.headY, vm.parseJsonInt(j, string.concat(e, ".headY")), string.concat(tag, " headY"));
            assertEq(s.posX, vm.parseJsonInt(j, string.concat(e, ".posX")), string.concat(tag, " posX"));
            assertEq(s.posY, vm.parseJsonInt(j, string.concat(e, ".posY")), string.concat(tag, " posY"));
            assertEq(s.totalSpikes, vm.parseJsonUint(j, string.concat(e, ".totalSpikes")), string.concat(tag, " totalSpikes"));
            (uint8 ch,,, uint64 until, bool active) = core.activeStimulus(idA);
            assertEq(active, vm.parseJsonBool(j, string.concat(e, ".stimActive")), string.concat(tag, " stimActive"));
            if (active) {
                assertEq(ch, vm.parseJsonUint(j, string.concat(e, ".stimChannel")), string.concat(tag, " stimChannel"));
                assertEq(until, vm.parseJsonUint(j, string.concat(e, ".stimUntil")), string.concat(tag, " stimUntil"));
            }
        }
    }

    /// FlyBrain v2 with a mature engram vs a core seeded from it: the engram moves one unit per
    /// tick, so 32 short ticks under a landmark saturate it like fly #1's. From there the same
    /// strong stimuli (turns at 40, a shock at 20, cues at 8) and long ticks on both, every state
    /// word equal after every action.
    function test_differential_matureEngramFromFlyBrainV2() public {
        for (uint256 i = 0; i < 32; ++i) {
            if (i % 8 == 0 && i < 24) brain.stimulate(CUE, 4, 4, 0);
            brain.tick(8);
        }
        (,,,, bool active) = brain.activeStimulus();
        assertFalse(active, "no stimulus at the hand-over");
        State memory b0 = brainState();
        assertEq(b0.step, 256);
        uint256 saturated;
        for (uint256 i = 0; i < 155; ++i) {
            if (b0.bias[i] == 24 || b0.bias[i] == -24) ++saturated;
        }
        assertGt(saturated, 120, "a mature engram: most biases at the bound");

        vm.prank(curator);
        core.seed(idB, b0.v, b0.bias, b0.hist, b0.inp, b0.step, b0.headX, b0.headY);
        assertSameBrain(b0, coreState(idB), "seeded");

        brain.stimulate(TURN_RIGHT, 0, 40, 16);
        vm.prank(pebbleB);
        core.stimulate(idB, TURN_RIGHT, 0, 40, 16);
        assertSameBrain(brainState(), coreState(idB), "m1");
        brain.tick(16);
        core.tick(idB, 16);
        assertSameBrain(brainState(), coreState(idB), "m2");
        brain.stimulate(TURN_LEFT, 0, 40, 32);
        vm.prank(pebbleB);
        core.stimulate(idB, TURN_LEFT, 0, 40, 32);
        assertSameBrain(brainState(), coreState(idB), "m3");
        brain.tick(64); // the turn expires mid-tick
        core.tick(idB, 64);
        assertSameBrain(brainState(), coreState(idB), "m4");
        assertSameStimulus(idB, "m4");
        brain.stimulate(CUE, 12, 8, 16);
        vm.prank(pebbleB);
        core.stimulate(idB, CUE, 12, 8, 16);
        assertSameBrain(brainState(), coreState(idB), "m5");
        brain.tick(32);
        core.tick(idB, 32);
        assertSameBrain(brainState(), coreState(idB), "m6");
        brain.stimulate(SHOCK, 0, 20, 16);
        vm.prank(pebbleB);
        core.stimulate(idB, SHOCK, 0, 20, 16);
        assertSameBrain(brainState(), coreState(idB), "m7");
        brain.tick(64);
        core.tick(idB, 64);
        brain.tick(1);
        core.tick(idB, 1);
        brain.stimulate(CUE, 0, 2, 64);
        vm.prank(bob);
        core.stimulate(idB, CUE, 0, 2, 64);
        brain.tick(64);
        core.tick(idB, 64);
        State memory b = brainState();
        State memory c = coreState(idB);
        assertSameBrain(b, c, "m8");
        assertSameStimulus(idB, "m8");
        assertEq(c.step, 256 + 16 + 16 + 32 + 64 + 16 + 32 + 16 + 64 + 1 + 64 + 64);
        assertEq(c.posX, b.posX - b0.posX, "posX delta");
        assertEq(c.posY, b.posY - b0.posY, "posY delta");
        assertEq(c.totalSpikes, b.totalSpikes - b0.totalSpikes, "spikes since seed");
    }

    // ------------------------------------------------- (7) gas

    /// The gas budgets the hardware plan is written against (HARDWARE.md §3, §4.4): a 16-step
    /// anchor (stimulate + tick(16) by the body, or a tick(16) with a stimulus active) and a
    /// 32-step tick. Measured below on fly #1's real state with the strongest stimuli the pebble
    /// firmware sends (turn strength 40, cue 8, shock 20), as a receipt's gasUsed (see
    /// requireIsolation). Raise these only together with HARDWARE.md §3/§4.4 and the firmware's
    /// ANCHOR_GAS_* limits.
    uint256 constant ANCHOR16_BUDGET = 4_600_000; // HARDWARE.md §4.4: the pebble's anchor, under any stimulus
    uint256 constant TICK32_BUDGET = 7_000_000; // HARDWARE.md §3: tick(32), quiet or with a cue
    uint256 constant TICK32_TURN_BUDGET = 8_500_000; // tick(32) while a strength-40 turn is active

    /// The gas figures below are a receipt's gasUsed: foundry.toml sets `isolate = true`, so every
    /// top-level call from a test is its own transaction (21k + calldata, cold accounts and storage,
    /// clean slots). Without isolation the same gasleft() deltas would read ~140k low (no intrinsic
    /// gas, and storage slots already dirtied earlier in the test cost 100 instead of 2900 to write).
    function requireIsolation() internal {
        // a reverting call (tick of 0 steps) costs a few hundred gas inline and at least 21k as a transaction
        uint256 g0 = gasleft();
        (bool ok,) = address(core).call(abi.encodeCall(core.tick, (idA, 0)));
        uint256 used = g0 - gasleft();
        assertFalse(ok);
        require(used >= 21_000, "gas tests need isolate = true (foundry.toml): each call as its own transaction");
    }

    function gasStimulate(address by, uint256 id, uint8 ch, uint8 param, uint8 strength, uint16 steps) internal returns (uint256) {
        vm.prank(by);
        uint256 g0 = gasleft();
        core.stimulate(id, ch, param, strength, steps);
        return g0 - gasleft();
    }

    function gasTick(uint256 id, uint16 steps) internal returns (uint256) {
        uint256 g0 = gasleft();
        core.tick(id, steps);
        return g0 - gasleft();
    }

    function test_gas_onFly1RealState() public {
        requireIsolation();
        seedFly1(idA);
        uint256 worst16;
        uint256 g;

        console.log("--- FlyCore gas on fly #1's real state (mature engram), as tx gasUsed ---");
        // the pebble's anchors, as the body: net gyro rotation at TURN_STRENGTH_MAX, hall-sensor cue, spider shock
        g = gasStimulate(pebbleA, idA, TURN_RIGHT, 0, 40, 16);
        console.log("stimulate(turn right x40) + tick(16), body:", g);
        if (g > worst16) worst16 = g;
        g = gasTick(idA, 16);
        console.log("tick(16), turn x40 active:              ", g);
        if (g > worst16) worst16 = g;
        g = gasStimulate(pebbleA, idA, TURN_LEFT, 0, 40, 16);
        console.log("stimulate(turn left x40) + tick(16), body: ", g);
        if (g > worst16) worst16 = g;
        uint256 tick32turn = gasTick(idA, 32);
        console.log("tick(32), turn x40 active:              ", tick32turn);
        g = gasStimulate(pebbleA, idA, CUE, 4, 8, 16);
        console.log("stimulate(cue wedge 4 x8) + tick(16), body:", g);
        if (g > worst16) worst16 = g;
        g = gasTick(idA, 16);
        console.log("tick(16), cue x8 active:                ", g);
        if (g > worst16) worst16 = g;
        uint256 tick32cue = gasTick(idA, 32);
        console.log("tick(32), cue x8 active:                ", tick32cue);
        g = gasStimulate(pebbleA, idA, SHOCK, 0, 20, 16);
        console.log("stimulate(shock x20) + tick(16), body:  ", g);
        if (g > worst16) worst16 = g;
        g = gasTick(idA, 16);
        console.log("tick(16), shock x20 active:             ", g);
        if (g > worst16) worst16 = g;
        core.tick(idA, 64); // let it expire
        (,,,, bool active) = core.activeStimulus(idA);
        assertFalse(active);
        uint256 quiet16 = gasTick(idA, 16);
        console.log("tick(16), no stimulus:                  ", quiet16);
        if (quiet16 > worst16) worst16 = quiet16;
        uint256 quiet32 = gasTick(idA, 32);
        console.log("tick(32), no stimulus:                  ", quiet32);
        uint256 quiet64 = gasTick(idA, 64);
        console.log("tick(64), no stimulus:                  ", quiet64);
        // the site's poke: a token burn plus 32 steps
        g = gasStimulate(bob, idA, CUE, 12, 5, 32);
        console.log("stimulate(cue x5) + tick(32), poker:    ", g);
        console.log("worst 16-step anchor:                   ", worst16);
        console.log("budget: 16-step anchor / tick(32):      ", ANCHOR16_BUDGET, TICK32_BUDGET);
        console.log("BNB per worst 16-step anchor at 0.05 gwei (x1e-9):", worst16 * 5 / 100);
        console.log("BNB per hour at 45 s anchors (x1e-9):    ", worst16 * 5 / 100 * 80);

        // for reference: the same calls on a never-run core (what the old figures were measured on)
        g = gasStimulate(pebbleB, idB, CUE, 4, 4, 16);
        console.log("fresh core, stimulate(cue x4) + tick(16):", g);
        g = gasTick(idB, 16);
        console.log("fresh core, tick(16) cue active:        ", g);

        // the most a 16-step anchor can cost the pebble: a poker (paying 255 x STIM_PRICE) drove the
        // strongest possible stimulus just before it. The circuit saturates (a neuron spikes at most
        // once per step and Δ7 inhibits the rest), so this is no worse than the pebble's own turns.
        uint256 worstAny16;
        g = gasStimulate(bob, idA, TURN_RIGHT, 0, 255, 0);
        g = gasTick(idA, 16);
        console.log("tick(16), turn x255 active (a poke):    ", g);
        if (g > worstAny16) worstAny16 = g;
        core.tick(idA, 64);
        g = gasStimulate(bob, idA, CUE, 8, 255, 0);
        g = gasTick(idA, 16);
        console.log("tick(16), cue x255 active (a poke):     ", g);
        if (g > worstAny16) worstAny16 = g;
        core.tick(idA, 64);
        g = gasStimulate(bob, idA, SHOCK, 0, 255, 0);
        g = gasTick(idA, 16);
        console.log("tick(16), shock x255 active (a poke):   ", g);
        if (g > worstAny16) worstAny16 = g;
        console.log("worst 16-step tick under any stimulus:  ", worstAny16);

        assertLe(worst16, ANCHOR16_BUDGET, "16-step anchor over budget");
        assertLe(tick32cue, TICK32_BUDGET, "tick(32) with a cue active over budget");
        assertLe(quiet32, TICK32_BUDGET, "quiet tick(32) over budget");
        assertLe(tick32turn, TICK32_TURN_BUDGET, "tick(32) with a turn active over budget");
        assertLe(worstAny16, ANCHOR16_BUDGET, "a poke can push a 16-step anchor over budget");
        assertLt(quiet64, 16_000_000, "tick(64) must stay well inside a BSC block");
    }

    /// FlyBrain v2 (the reference kernel) on the same mature state costs more than the core: the
    /// kernel rewrite is a pure gas change. Both as transactions, both with a strength-40 turn active.
    function test_gas_coreCheaperThanFlyBrainV2OnMatureState() public {
        requireIsolation();
        for (uint256 i = 0; i < 32; ++i) {
            if (i % 8 == 0 && i < 24) brain.stimulate(CUE, 4, 4, 0);
            brain.tick(8);
        }
        State memory b0 = brainState();
        vm.prank(curator);
        core.seed(idB, b0.v, b0.bias, b0.hist, b0.inp, b0.step, b0.headX, b0.headY);
        brain.stimulate(TURN_RIGHT, 0, 40, 0);
        vm.prank(pebbleB);
        core.stimulate(idB, TURN_RIGHT, 0, 40, 0);

        uint256 g0 = gasleft();
        brain.tick(16);
        uint256 gBrain = g0 - gasleft();
        uint256 gCore = gasTick(idB, 16);
        console.log("mature state, turn x40 active, tick(16) as tx gasUsed: FlyBrain v2", gBrain, "FlyCore", gCore);
        assertSameBrain(brainState(), coreState(idB), "still the same brain");
        assertLt(gCore, gBrain, "the core must not cost more than the reference");
    }
}
