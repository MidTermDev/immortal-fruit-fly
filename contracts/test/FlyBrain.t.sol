// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ImmortalFly} from "../src/ImmortalFly.sol";
import {FlyBrain, IFlyToken} from "../src/FlyBrain.sol";

contract FlyBrainTest is Test {
    ImmortalFly token;
    FlyBrain brain;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant SUPPLY = 1_000_000_000 ether;
    uint64 constant GENESIS = 1000;
    uint256 constant TOKENS_PER_STEP = 1 ether;
    uint256 constant STIM_PRICE = 100 ether;
    uint256 constant RESURRECT_PRICE = 100_000 ether;
    uint8 constant CUE = 1;
    uint8 constant TURN_LEFT = 2;
    uint8 constant TURN_RIGHT = 3;
    uint8 constant SHOCK = 4;

    function params() internal view returns (FlyBrain.Params memory p) {
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
            maxSteps: uint8(vm.parseJsonUint(pj, ".maxSteps"))
        });
    }

    function setUp() public {
        token = new ImmortalFly("Immortal Fruit Fly", "FLY", SUPPLY, address(this));
        bytes memory table = vm.parseBytes(vm.readFile("data/circuit.hex"));
        brain = new FlyBrain(
            IFlyToken(address(token)),
            table,
            params(),
            "FlyWire v783 proofread_connections_783.feather",
            bytes32(uint256(0x1234)),
            GENESIS,
            TOKENS_PER_STEP,
            STIM_PRICE,
            RESURRECT_PRICE
        );
        token.transfer(alice, 10_000_000 ether);
        token.transfer(bob, 10_000_000 ether);
        vm.prank(alice);
        token.approve(address(brain), type(uint256).max);
        vm.prank(bob);
        token.approve(address(brain), type(uint256).max);
    }

    // ------------------------------------------------------------ identity

    function test_circuitIsTheFlyWireRingAttractor() public view {
        assertEq(brain.N(), 155);
        assertEq(brain.S(), 6522);
        bytes memory d = brain.circuitData();
        assertEq(keccak256(d), brain.circuitHash());
        // first neuron is an EPG with a real FlyWire root id (18 digits, 7205759406xxxxxxxx)
        (uint64 rootId, uint8 cellType,,,) = brain.neuron(0);
        assertEq(cellType, brain.T_EPG());
        assertGt(rootId, 720575940000000000);
        assertLt(rootId, 720575941000000000);
        // count types
        uint256[6] memory counts;
        for (uint256 i = 0; i < 155; ++i) {
            (, uint8 t,,,) = brain.neuron(i);
            counts[t]++;
        }
        assertEq(counts[0], 47); // EPG
        assertEq(counts[1], 4); // EPGt
        assertEq(counts[2], 20); // PEG
        assertEq(counts[3], 20); // PEN_a
        assertEq(counts[4], 22); // PEN_b
        assertEq(counts[5], 42); // Delta7
    }

    function test_synapsesOf() public view {
        (uint8[] memory post, uint8[] memory w) = brain.synapsesOf(0);
        (,,,, uint16 outDeg) = brain.neuron(0);
        assertEq(post.length, outDeg);
        assertEq(w.length, outDeg);
        for (uint256 i = 0; i < post.length; ++i) {
            assertLt(post[i], 155);
            assertGt(w[i], 0);
        }
    }

    // ------------------------------------------------------------ dynamics

    function test_tickAdvancesAndSpikes() public {
        vm.prank(alice);
        brain.stimulate(CUE, 4, 4, 32);
        assertEq(brain.step(), 32);
        assertEq(brain.energy(), GENESIS - 32);
        assertGt(brain.totalSpikes(), 0);
        (,,,,,,,,,, int32 hy) = brain.brainState();
        hy; // heading is whatever the circuit does; just exercise the view
        (, uint64 ticks,) = brain.caretakers(alice);
        assertEq(ticks, 1);
    }

    function test_tickGas() public {
        vm.prank(alice);
        brain.stimulate(CUE, 4, 4, 32);
        uint256 g0 = gasleft();
        brain.tick(1);
        uint256 gas1 = g0 - gasleft();
        g0 = gasleft();
        brain.tick(32);
        uint256 gas32 = g0 - gasleft();
        g0 = gasleft();
        brain.tick(64);
        uint256 gas64 = g0 - gasleft();
        console.log("gas tick(1) ", gas1);
        console.log("gas tick(32)", gas32);
        console.log("gas tick(64)", gas64);
        console.log("BNB per tick(64) at 0.05 gwei (x1e-9):", gas64 * 5 / 100); // gas * 0.05 gwei in nano-BNB
    }

    function test_tickBounds() public {
        vm.expectRevert(FlyBrain.BadSteps.selector);
        brain.tick(0);
        uint16 maxSteps = brain.MAX_STEPS();
        vm.expectRevert(FlyBrain.BadSteps.selector);
        brain.tick(maxSteps + 1);
    }

    function test_deterministicReplay() public {
        // Two identical brains, same stimuli => identical state hashes.
        bytes memory table = vm.parseBytes(vm.readFile("data/circuit.hex"));
        FlyBrain other = new FlyBrain(
            IFlyToken(address(token)), table, params(), "x", bytes32(0), GENESIS, TOKENS_PER_STEP, STIM_PRICE, RESURRECT_PRICE
        );
        vm.startPrank(alice);
        token.approve(address(other), type(uint256).max);
        brain.stimulate(CUE, 7, 3, 20);
        other.stimulate(CUE, 7, 3, 20);
        brain.tick(50);
        other.tick(50);
        brain.stimulate(TURN_LEFT, 0, 2, 64);
        other.stimulate(TURN_LEFT, 0, 2, 64);
        vm.stopPrank();
        assertEq(brain.brainStateHash(), other.brainStateHash());
        assertEq(brain.posX(), other.posX());
        assertEq(brain.posY(), other.posY());
    }

    // --------------------------------------------------------- feed / burn

    function test_feedBurns() public {
        uint256 deadBefore = token.balanceOf(brain.DEAD());
        vm.prank(alice);
        brain.feed(500 ether);
        assertEq(brain.energy(), GENESIS + 500);
        assertEq(token.balanceOf(brain.DEAD()), deadBefore + 500 ether);
        assertEq(token.balanceOf(alice), 10_000_000 ether - 500 ether);
        assertEq(brain.totalBurned(), 500 ether);
        (uint128 fed,,) = brain.caretakers(alice);
        assertEq(fed, 500 ether);
    }

    function test_feedZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(FlyBrain.ZeroAmount.selector);
        brain.feed(0);
        vm.prank(alice);
        vm.expectRevert(FlyBrain.ZeroAmount.selector);
        brain.feed(0.5 ether); // less than one step
    }

    function test_stimulateBurnsAndSetsStimulus() public {
        uint256 deadBefore = token.balanceOf(brain.DEAD());
        vm.prank(bob);
        brain.stimulate(TURN_RIGHT, 0, 5, 0);
        assertEq(token.balanceOf(brain.DEAD()), deadBefore + 5 * STIM_PRICE);
        (uint8 ch, uint8 param, uint16 strength, uint64 until, bool active) = brain.activeStimulus();
        assertEq(ch, TURN_RIGHT);
        assertEq(param, 0);
        assertEq(strength, 5);
        assertEq(until, uint64(brain.STIM_TTL()));
        assertTrue(active);
    }

    function test_stimulateValidation() public {
        vm.startPrank(bob);
        vm.expectRevert(FlyBrain.BadChannel.selector);
        brain.stimulate(0, 0, 1, 0);
        vm.expectRevert(FlyBrain.BadChannel.selector);
        brain.stimulate(5, 0, 1, 0);
        vm.expectRevert(FlyBrain.BadChannel.selector);
        brain.stimulate(CUE, 16, 1, 0);
        vm.expectRevert(FlyBrain.BadStrength.selector);
        brain.stimulate(CUE, 3, 0, 0);
        vm.stopPrank();
    }

    function test_stimulusExpires() public {
        vm.prank(bob);
        brain.stimulate(SHOCK, 0, 2, 0);
        uint16 ttl = brain.STIM_TTL();
        uint16 maxSteps = brain.MAX_STEPS();
        uint256 done = 0;
        while (done < ttl) {
            uint16 s = ttl - done > maxSteps ? maxSteps : uint16(ttl - done);
            brain.tick(s);
            done += s;
        }
        (,,,, bool active) = brain.activeStimulus();
        assertFalse(active);
        assertEq(brain.stimChannel(), 0);
    }

    // ------------------------------------------------- death / resurrection

    function test_diesWhenEnergyRunsOut() public {
        uint16 maxSteps = brain.MAX_STEPS();
        while (brain.alive()) {
            brain.tick(maxSteps);
        }
        assertEq(brain.energy(), 0);
        assertEq(brain.step(), GENESIS);
        assertEq(brain.lineageLength(), 1);
        (uint64 born, uint64 died, uint64 steps, uint64 spikes, bytes32 h) = brain.lineage(0);
        assertEq(born, 1);
        assertEq(died, uint64(block.number));
        assertEq(steps, GENESIS);
        assertEq(spikes, brain.totalSpikes());
        assertEq(h, brain.brainStateHash());

        vm.expectRevert(FlyBrain.Dead.selector);
        brain.tick(1);
        vm.prank(alice);
        vm.expectRevert(FlyBrain.Dead.selector);
        brain.stimulate(1, 0, 1, 0);
    }

    function test_resurrectKeepsBrainNewBody() public {
        vm.prank(alice);
        vm.expectRevert(FlyBrain.NotDead.selector);
        brain.resurrect(0);

        vm.prank(alice);
        brain.stimulate(CUE, 2, 4, 64);
        uint16 maxSteps = brain.MAX_STEPS();
        while (brain.alive()) brain.tick(maxSteps);
        (int16[] memory vDead, int8[] memory biasDead, uint16[16] memory histDead,,,,,,,,) = brain.brainState();
        int64 px = brain.posX();
        int64 py = brain.posY();
        assertTrue(px != 0 || py != 0, "should have walked");

        vm.roll(block.number + 100);
        uint256 deadBefore = token.balanceOf(brain.DEAD());
        vm.prank(bob);
        brain.resurrect(2000 ether);
        assertEq(token.balanceOf(brain.DEAD()), deadBefore + RESURRECT_PRICE + 2000 ether);
        assertTrue(brain.alive());
        assertEq(brain.generation(), 1);
        assertEq(brain.energy(), 2000);
        assertEq(brain.posX(), 0);
        assertEq(brain.posY(), 0);
        assertEq(brain.bornBlock(), uint64(block.number));
        assertEq(brain.lifeSteps(), 0);

        (int16[] memory v2, int8[] memory bias2, uint16[16] memory hist2,,,,,,,,) = brain.brainState();
        for (uint256 i = 0; i < v2.length; ++i) {
            assertEq(v2[i], vDead[i], "membrane potential preserved");
            assertEq(bias2[i], biasDead[i], "engram preserved");
        }
        for (uint256 w = 0; w < 16; ++w) {
            assertEq(hist2[w], histDead[w], "heading memory preserved");
        }
        brain.tick(10);
        assertEq(brain.step(), GENESIS + 10);
    }

    function test_resurrectRequiresPrice() public {
        uint16 maxSteps = brain.MAX_STEPS();
        while (brain.alive()) brain.tick(maxSteps);
        address poor = makeAddr("poor");
        token.transfer(poor, 1 ether);
        vm.startPrank(poor);
        token.approve(address(brain), type(uint256).max);
        vm.expectRevert();
        brain.resurrect(0);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- permit

    function test_feedWithPermit() public {
        uint256 pk = 0xA11CE;
        address signer = vm.addr(pk);
        token.transfer(signer, 1000 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                signer,
                address(brain),
                300 ether,
                token.nonces(signer),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.prank(signer);
        brain.feedWithPermit(300 ether, deadline, v, r, s);
        assertEq(brain.energy(), GENESIS + 300);
        assertEq(token.balanceOf(signer), 700 ether);
    }

    // --------------------------------------------------------------- token

    function test_tokenIsPlain() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.decimals(), 18);
        assertEq(token.name(), "Immortal Fruit Fly");
        assertEq(token.symbol(), "FLY");
    }

    function test_tableValidation() public {
        bytes memory bad = hex"02";
        vm.expectRevert();
        new FlyBrain(IFlyToken(address(token)), bad, params(), "x", bytes32(0), 1, 1, 1, 1);
    }
}
