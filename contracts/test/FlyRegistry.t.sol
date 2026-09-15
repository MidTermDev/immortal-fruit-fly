// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ImmortalFly} from "../src/ImmortalFly.sol";
import {FlyRegistry} from "../src/FlyRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FlyRegistryTest is Test {
    ImmortalFly token;
    FlyRegistry reg;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address arena = makeAddr("arena");
    address doom = makeAddr("doom");
    bytes32 constant CONN = keccak256("connectome");
    bytes32 constant GEN = keccak256("genesis");

    function setUp() public {
        token = new ImmortalFly("Immortal Fruit Flies", "FLY", 1e27, address(this));
        reg = new FlyRegistry(IERC20(address(token)), CONN, 2, GEN, 1 ether, 1000 ether, 1 ether, 5000 ether, 3600, 3, 250, "https://fly.test/api/fly/", "ipfs://collection");
        for (uint256 i = 0; i < 2; i++) {
            address a = i == 0 ? alice : bob;
            token.transfer(a, 100_000 ether);
            vm.prank(a);
            token.approve(address(reg), type(uint256).max);
        }
        vm.prank(arena);
        reg.registerBody("Arena", "https://fly.test/arena");
        vm.prank(doom);
        reg.registerBody("DOOM", "https://fly.test/doom");
    }

    function test_mintBurnsOneFly() public {
        uint256 dead0 = token.balanceOf(reg.DEAD());
        vm.prank(alice);
        uint256 id = reg.mint("Specimen 001");
        assertEq(id, 1);
        assertEq(reg.ownerOf(1), alice);
        assertEq(token.balanceOf(reg.DEAD()), dead0 + 1 ether);
        FlyRegistry.Fly memory f = reg.fly(1);
        assertEq(f.stateRoot, GEN);
        assertEq(f.energy, 3600);
        assertTrue(f.alive);
        assertEq(f.body, address(0));
        assertEq(reg.tokenURI(1), "https://fly.test/api/fly/1");
        assertEq(reg.flyName(1), "Specimen 001");
    }

    function test_theImmortalityLoop_dieInArenaWakeInDoom() public {
        vm.prank(alice);
        uint256 id = reg.mint("Specimen 001");
        // owner hands it to the arena; the arena accepts and runs it
        vm.prank(alice);
        reg.assign(id, arena);
        vm.prank(arena);
        reg.accept(id);
        assertEq(reg.fly(id).body, arena);
        vm.prank(arena);
        reg.commit(id, keccak256("s1"), keccak256("m1"), "ipfs://s1", "ipfs://meta1", 100_000, 3000, keccak256("h1"));
        vm.prank(arena);
        reg.interaction(id, "ate", "300 s of food at (40,30)");
        assertEq(reg.tokenURI(id), "ipfs://meta1");
        // a stranger cannot commit
        vm.prank(bob);
        vm.expectRevert(FlyRegistry.NotBody.selector);
        reg.commit(id, keccak256("x"), keccak256("x"), "", "", 200_000, 1, bytes32(0));
        // steps must advance
        vm.prank(arena);
        vm.expectRevert(FlyRegistry.StepMustAdvance.selector);
        reg.commit(id, keccak256("s1"), keccak256("m1"), "ipfs://s1", "", 100_000, 3000, keccak256("h1"));
        // it starves in the arena: final state committed, dormant
        vm.prank(arena);
        reg.died(id, keccak256("sDead"), keccak256("mDead"), "ipfs://sDead", "ipfs://metaDead", 500_000, "starved");
        FlyRegistry.Fly memory f = reg.fly(id);
        assertFalse(f.alive);
        assertEq(f.body, address(0));
        assertEq(f.stateRoot, keccak256("sDead"));
        assertEq(f.deaths, 1);
        vm.prank(alice);
        vm.expectRevert(FlyRegistry.Dead.selector);
        reg.assign(id, doom);
        // anyone resurrects it (bob pays), the owner sends it to DOOM
        uint256 dead0 = token.balanceOf(reg.DEAD());
        vm.prank(bob);
        reg.resurrect(id, 600);
        assertEq(token.balanceOf(reg.DEAD()), dead0 + 1000 ether + 600 ether);
        f = reg.fly(id);
        assertTrue(f.alive);
        assertEq(f.generation, 1);
        assertEq(f.energy, 600);
        assertEq(f.stateRoot, keccak256("sDead"), "the brain it wakes with is the one it died with");
        vm.prank(alice);
        reg.assign(id, doom);
        vm.prank(doom);
        reg.accept(id);
        vm.prank(doom);
        reg.commit(id, keccak256("s2"), keccak256("mDead"), "ipfs://s2", "", 600_000, 550, keccak256("h2"));
        assertEq(reg.fly(id).body, doom);
        // the current body may hand it on (DOOM -> arena), the arena accepts
        vm.prank(doom);
        reg.assign(id, arena);
        vm.prank(arena);
        reg.accept(id);
        assertEq(reg.fly(id).body, arena);
        (,,, uint32 doomFlies) = reg.bodies(doom);
        (,,, uint32 arenaFlies) = reg.bodies(arena);
        assertEq(doomFlies, 0);
        assertEq(arenaFlies, 1);
    }

    function test_feedAddsEnergy() public {
        vm.prank(alice);
        uint256 id = reg.mint("f");
        uint256 dead0 = token.balanceOf(reg.DEAD());
        vm.prank(bob);
        reg.feed(id, 120);
        assertEq(reg.fly(id).energy, 3720);
        assertEq(token.balanceOf(reg.DEAD()), dead0 + 120 ether);
    }

    function test_breedRequiresBothParents() public {
        vm.prank(alice);
        uint256 a = reg.mint("a");
        vm.prank(bob);
        uint256 b = reg.mint("b");
        vm.prank(alice);
        vm.expectRevert(FlyRegistry.NotOwnerOrBody.selector);
        reg.breed(a, b, keccak256("child"), "c");
        vm.prank(bob);
        reg.transferFrom(bob, alice, b);
        vm.prank(alice);
        uint256 c = reg.breed(a, b, keccak256("child"), "c");
        FlyRegistry.Fly memory f = reg.fly(c);
        assertEq(f.parentA, a);
        assertEq(f.parentB, b);
        assertEq(f.memoryRoot, keccak256("child"));
        assertEq(f.stateRoot, GEN);
        assertEq(reg.ownerOf(c), alice);
    }

    function test_curatorMetadataOnlyWhileDormant() public {
        vm.prank(alice);
        uint256 id = reg.mint("f");
        reg.setMetadata(id, "ipfs://portrait");
        assertEq(reg.tokenURI(id), "ipfs://portrait");
        vm.prank(alice);
        reg.assign(id, arena);
        vm.prank(arena);
        reg.accept(id);
        vm.expectRevert(FlyRegistry.HasBody.selector);
        reg.setMetadata(id, "ipfs://other");
        vm.prank(bob);
        vm.expectRevert(FlyRegistry.NotCurator.selector);
        reg.setMetadata(id, "ipfs://other");
    }

    function test_attestEmitsMatch() public {
        vm.prank(alice);
        uint256 id = reg.mint("f");
        vm.prank(alice);
        reg.assign(id, arena);
        vm.prank(arena);
        reg.accept(id);
        vm.prank(arena);
        reg.commit(id, keccak256("s1"), keccak256("m1"), "ipfs://s1", "", 100_000, 3000, bytes32(0));
        vm.expectEmit(true, true, false, true);
        emit FlyRegistry.Attested(id, bob, 100_000, keccak256("s1"), true);
        vm.prank(bob);
        reg.attest(id, 100_000, keccak256("s1"));
    }

    function test_deadFlyCannotBeSoldUntilResurrected() public {
        vm.prank(alice);
        uint256 id = reg.mint("f");
        vm.prank(alice);
        reg.assign(id, arena);
        vm.prank(arena);
        reg.accept(id);
        vm.prank(arena);
        reg.died(id, keccak256("d"), keccak256("m"), "ipfs://d", "", 10, "starved");
        vm.prank(alice);
        vm.expectRevert(FlyRegistry.DeadCannotTransfer.selector);
        reg.transferFrom(alice, bob, id);
        vm.prank(bob);
        reg.resurrect(id, 60);
        vm.prank(alice);
        reg.transferFrom(alice, bob, id);
        assertEq(reg.ownerOf(id), bob);
    }

    function test_maxSupplyAndBreedingRules() public {
        vm.prank(alice);
        uint256 a = reg.mint("a");
        vm.prank(alice);
        uint256 b = reg.mint("b");
        vm.prank(alice);
        reg.assign(a, arena);
        vm.prank(arena);
        reg.accept(a);
        vm.prank(arena);
        reg.died(a, keccak256("d"), keccak256("m"), "ipfs://d", "", 10, "x");
        vm.prank(alice);
        vm.expectRevert(FlyRegistry.ParentsMustBeAlive.selector);
        reg.breed(a, b, keccak256("c"), "c");
        vm.prank(bob);
        reg.resurrect(a, 60);
        vm.prank(alice);
        reg.breed(a, b, keccak256("c"), "c"); // third and last token
        vm.prank(bob);
        vm.expectRevert(FlyRegistry.SoldOut.selector);
        reg.mint("too many");
        (address recv, uint256 amt) = reg.royaltyInfo(1, 10 ether);
        assertEq(recv, address(this));
        assertEq(amt, 0.25 ether);
        assertTrue(reg.supportsInterface(0x2a55205a));
    }

    function test_supportsErc4906AndErc721() public view {
        assertTrue(reg.supportsInterface(0x49064906));
        assertTrue(reg.supportsInterface(0x80ac58cd));
        assertEq(reg.contractURI(), "ipfs://collection");
    }
}
