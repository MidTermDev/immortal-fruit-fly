// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ImmortalFly} from "../src/ImmortalFly.sol";
import {FlyRegistry} from "../src/FlyRegistry.sol";
import {FlyRegistryV3} from "../src/FlyRegistryV3.sol";

contract FlyRegistryV3Test is Test {
    ImmortalFly token;
    FlyRegistry old;
    FlyRegistryV3 reg;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address arena = address(0xA5E4A);
    address treasury;
    bytes32 constant CONN = keccak256("connectome");
    bytes32 constant GEN = keccak256("genesis");
    uint256 constant WEI_PER_S = 115_740_740_740;   // ≈ 0.01 BNB per day (1e16 / 86400)

    function setUp() public {
        token = new ImmortalFly("Immortal Fruit Flies", "FLY", 1e27, address(this));
        old = new FlyRegistry(IERC20(address(token)), CONN, 2, GEN, 1 ether, 1000 ether, 1 ether, 5000 ether, 3600, 10_000, 250, "https://fly.test/api/fly/", "ipfs://collection");
        reg = new FlyRegistryV3(IERC20(address(token)), CONN, 2, GEN, 1 ether, 5000 ether, WEI_PER_S, 0.005 ether, address(old), 3600, 10_000, 250, "https://fly.test/api/fly/", "ipfs://collection");
        treasury = address(this);
        for (uint256 i = 0; i < 2; i++) {
            address a = i == 0 ? alice : bob;
            token.transfer(a, 100_000 ether);
            vm.prank(a); token.approve(address(reg), type(uint256).max);
            vm.prank(a); token.approve(address(old), type(uint256).max);
            vm.deal(a, 1 ether);
        }
        vm.prank(arena); reg.registerBody("Arena", "https://fly.test/arena");
    }

    receive() external payable {}

    function test_mintStillBurnsOneFly_lifeIsBnb() public {
        vm.prank(alice); uint256 id = reg.mint("Specimen");
        assertEq(token.balanceOf(alice), 99_999 ether);
        uint256 dead0 = token.balanceOf(0x000000000000000000000000000000000000dEaD);
        uint256 t0 = address(this).balance;
        uint256 cost = reg.lifeCost(86_400);
        assertEq(cost, WEI_PER_S * 86_400);
        vm.prank(bob); reg.feed{value: cost}(id, 86_400);
        assertEq(reg.fly(id).energy, 3600 + 86_400);
        assertEq(address(this).balance - t0, cost);                                  // BNB to the treasury
        assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD), dead0);  // nothing burned
        assertEq(token.balanceOf(bob), 100_000 ether);
    }

    function test_underpaidFeedReverts_keeperFeedsFree() public {
        vm.prank(alice); uint256 id = reg.mint("Specimen");
        vm.prank(bob); vm.expectRevert(FlyRegistry.TooLittle.selector); reg.feed{value: 1}(id, 86_400);
        reg.feed(id, 7200);   // the deployer is the keeper: free
        assertEq(reg.fly(id).energy, 3600 + 7200);
        reg.setKeeper(bob);
        vm.prank(bob); reg.feed(id, 60);
        assertEq(reg.fly(id).energy, 3600 + 7260);
        vm.prank(alice); vm.expectRevert(FlyRegistry.TooLittle.selector); reg.feed(id, 60);
    }

    function test_resurrectCostsBnb() public {
        vm.prank(alice); uint256 id = reg.mint("Specimen");
        vm.prank(alice); reg.assign(id, arena);
        vm.prank(arena); reg.accept(id);
        vm.prank(arena); reg.died(id, keccak256("s"), keccak256("m"), "ipfs://s", "", 10, "starved");
        assertFalse(reg.fly(id).alive);
        uint256 cost = reg.resurrectWei() + reg.lifeCost(3600);
        vm.prank(bob); vm.expectRevert(FlyRegistry.TooLittle.selector); reg.resurrect{value: cost - 1}(id, 3600);
        uint256 t0 = address(this).balance;
        vm.prank(bob); reg.resurrect{value: cost}(id, 3600);
        assertTrue(reg.fly(id).alive);
        assertEq(reg.fly(id).generation, 1);
        assertEq(reg.fly(id).energy, 3600);
        assertEq(address(this).balance - t0, cost);
        reg.setLifePrice(0, 0);
        assertEq(reg.lifeCost(1_000_000), 0);
    }

    function test_migrationRecreatesFliesForOwnersThenCloses() public {
        // two flies on the old registry: alice's alive one and bob's dead one (dead flies cannot be transferred there)
        vm.prank(alice); uint256 a = old.mint("Old A");
        vm.prank(bob); uint256 b = old.mint("Old B");
        vm.prank(arena); old.registerBody("Arena", "x");
        vm.prank(bob); old.assign(b, arena);
        vm.prank(arena); old.accept(b);
        vm.prank(arena); old.died(b, keccak256("sb"), keccak256("mb"), "ipfs://b", "", 55, "starved");
        FlyRegistry.Fly memory ra = old.fly(a);
        FlyRegistry.Fly memory rb = old.fly(b);
        FlyRegistryV3.Fly memory ca; FlyRegistryV3.Fly memory cb;
        ca.connectome = ra.connectome; ca.model = ra.model; ca.generation = ra.generation; ca.deaths = ra.deaths; ca.stateRoot = ra.stateRoot; ca.memoryRoot = ra.memoryRoot; ca.stateURI = ra.stateURI; ca.brainStep = ra.brainStep; ca.energy = ra.energy; ca.bornBlock = ra.bornBlock; ca.lastCommitBlock = ra.lastCommitBlock; ca.alive = ra.alive;
        cb.connectome = rb.connectome; cb.model = rb.model; cb.generation = rb.generation; cb.deaths = rb.deaths; cb.stateRoot = rb.stateRoot; cb.memoryRoot = rb.memoryRoot; cb.stateURI = rb.stateURI; cb.brainStep = rb.brainStep; cb.energy = rb.energy; cb.bornBlock = rb.bornBlock; cb.lastCommitBlock = rb.lastCommitBlock; cb.alive = rb.alive;
        uint256 na = reg.migrate(alice, "Old A", ca);
        uint256 nb = reg.migrate(bob, "Old B", cb);
        assertEq(na, 1); assertEq(nb, 2);
        assertEq(reg.ownerOf(1), alice); assertEq(reg.ownerOf(2), bob);
        assertEq(reg.flyName(2), "Old B");
        assertFalse(reg.fly(2).alive); assertEq(reg.fly(2).deaths, 1); assertEq(reg.fly(2).stateRoot, keccak256("sb")); assertEq(reg.fly(2).stateURI, "ipfs://b"); assertEq(reg.fly(2).brainStep, 55);
        assertEq(reg.fly(2).body, address(0));   // bodies are not carried over
        assertTrue(reg.fly(1).alive); assertEq(reg.fly(1).energy, 3600);
        assertEq(token.balanceOf(alice), 99_999 ether);   // the migration burns nothing (the old mint did)
        // a dead migrated fly still cannot be sold until resurrected
        vm.prank(bob); vm.expectRevert(FlyRegistry.DeadCannotTransfer.selector); reg.transferFrom(bob, alice, 2);
        // only the curator, only while open
        vm.prank(alice); vm.expectRevert(FlyRegistry.NotCurator.selector); reg.migrate(alice, "x", ca);
        reg.closeMigration();
        vm.expectRevert(FlyRegistryV3.MigrationClosed.selector); reg.migrate(alice, "x", ca);
        // life goes on: a new mint gets the next id
        vm.prank(alice); uint256 id = reg.mint("New");
        assertEq(id, 3);
    }

    function test_theLoopStillWorks() public {
        vm.prank(alice); uint256 id = reg.mint("Specimen");
        vm.prank(alice); reg.assign(id, arena);
        vm.prank(arena); reg.accept(id);
        vm.prank(arena); reg.commit(id, keccak256("s1"), keccak256("m"), "ipfs://1", "ipfs://meta", 100, 3000, keccak256("h"));
        vm.prank(arena); reg.interaction(id, "jumped", "giant fiber spike: jumped");
        vm.prank(arena); reg.died(id, keccak256("s2"), keccak256("m"), "ipfs://2", "", 200, "starved");
        vm.prank(alice); reg.resurrect{value: reg.resurrectWei() + reg.lifeCost(600)}(id, 600);
        vm.prank(alice); reg.assign(id, arena);
        vm.prank(arena); reg.accept(id);
        assertEq(reg.fly(id).body, arena);
        assertEq(reg.fly(id).generation, 1);
    }
}
