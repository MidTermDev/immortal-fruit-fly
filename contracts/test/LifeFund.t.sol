// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ImmortalFly} from "../src/ImmortalFly.sol";
import {FlyRegistry} from "../src/FlyRegistry.sol";
import {LifeFund, IFlyRegistryFeed} from "../src/LifeFund.sol";

contract LifeFundTest is Test {
    ImmortalFly token;
    FlyRegistry reg;
    LifeFund fund;
    address alice = address(0xA11CE);
    address keeper = address(0xBEEF);
    address treasury = address(0x7EA5);
    address dead = 0x000000000000000000000000000000000000dEaD;
    bytes32 constant CONN = keccak256("connectome");
    bytes32 constant GEN = keccak256("genesis");
    uint256 constant RATE = 8_640_000; // 0.01 BNB -> 86,400 s

    function setUp() public {
        token = new ImmortalFly("Immortal Fruit Flies", "FLY", 1e27, address(this));
        reg = new FlyRegistry(IERC20(address(token)), CONN, 2, GEN, 1 ether, 1000 ether, 1 ether, 5000 ether, 3600, 100, 250, "https://fly.test/api/fly/", "ipfs://collection");
        fund = new LifeFund(IFlyRegistryFeed(address(reg)), IERC20(address(token)), keeper, treasury, RATE, 7200);
        token.transfer(address(fund), 1_000_000 ether);   // the operator's stash: 1,000,000 s of life
        token.transfer(alice, 10 ether);
        vm.prank(alice); token.approve(address(reg), type(uint256).max);
        vm.prank(alice); reg.mint("Specimen");            // fly #1, alice's, 3600 s
        vm.deal(alice, 1 ether);
    }

    function test_quoteAndSponsor() public {
        assertEq(fund.quote(0.01 ether), 86_400);
        uint256 t0 = treasury.balance;
        vm.prank(alice); fund.sponsor{value: 0.01 ether}(1);
        assertEq(fund.credit(1), 86_400);
        assertEq(fund.sponsoredTotal(1), 0.01 ether);
        assertEq(treasury.balance - t0, 0.01 ether);
        vm.prank(alice); fund.sponsor{value: 0.005 ether}(1);
        assertEq(fund.credit(1), 86_400 + 43_200);
    }

    function test_sponsorNeedsAFly() public {
        vm.prank(alice); vm.expectRevert(); fund.sponsor{value: 0.01 ether}(99);
        vm.prank(alice); vm.expectRevert(LifeFund.TooLittle.selector); fund.sponsor{value: 1}(1);   // 1 wei buys 0 s
    }

    function test_keepFeedsFromTheFundAndSpendsCredit() public {
        vm.prank(alice); fund.sponsor{value: 0.01 ether}(1);
        uint256 energy0 = reg.fly(1).energy; uint256 deadBefore = token.balanceOf(dead);
        vm.prank(keeper); fund.keep(1, 7200);
        assertEq(reg.fly(1).energy, energy0 + 7200);
        assertEq(fund.credit(1), 86_400 - 7200);
        assertEq(fund.fedTotal(1), 7200);
        assertEq(token.balanceOf(dead) - deadBefore, 7200 ether);   // the fund's $FLY burned, not alice's
        assertEq(token.balanceOf(alice), 9 ether);                  // alice paid 1 FLY for the mint and nothing since
        // more than the credit: capped to what is left
        vm.prank(keeper); fund.keep(1, 1_000_000);
        assertEq(fund.credit(1), 0);
        assertEq(reg.fly(1).energy, energy0 + 86_400);
        vm.prank(keeper); vm.expectRevert(LifeFund.NoCredit.selector); fund.keep(1, 10);
    }

    function test_onlyKeeperOrOwnerKeepsAndGrants() public {
        vm.prank(alice); fund.sponsor{value: 0.01 ether}(1);
        vm.prank(alice); vm.expectRevert(LifeFund.NotKeeper.selector); fund.keep(1, 10);
        vm.prank(alice); vm.expectRevert(LifeFund.NotKeeper.selector); fund.grant(1, 10);
        fund.keep(1, 10);            // the owner may
        vm.prank(keeper); fund.grant(1, 10);
    }

    function test_freeGrantsAreCappedPerDay() public {
        uint256 energy0 = reg.fly(1).energy;
        vm.prank(keeper); fund.grant(1, 3600);
        vm.prank(keeper); fund.grant(1, 3600);
        assertEq(fund.freeLeftToday(1), 0);
        vm.prank(keeper); vm.expectRevert(LifeFund.FreeCapReached.selector); fund.grant(1, 1);
        assertEq(reg.fly(1).energy, energy0 + 7200);
        vm.warp(block.timestamp + 1 days);
        assertEq(fund.freeLeftToday(1), 7200);
        vm.prank(keeper); fund.grant(1, 600);
        assertEq(fund.freeLeftToday(1), 6600);
    }

    function test_deadFlyCannotBeKept() public {
        vm.prank(alice); fund.sponsor{value: 0.01 ether}(1);
        address body = address(0xB0D7);
        vm.prank(body); reg.registerBody("Body", "https://fly.test/body");
        vm.prank(alice); reg.assign(1, body);
        vm.prank(body); reg.accept(1);
        vm.prank(body); reg.died(1, keccak256("s"), keccak256("m"), "ipfs://s", "", 10, "starved");
        vm.prank(keeper); vm.expectRevert(FlyRegistry.Dead.selector); fund.keep(1, 60);
        assertEq(fund.credit(1), 86_400);   // nothing spent
    }

    function test_operatorControls() public {
        fund.setRate(RATE * 2, 3600);
        assertEq(fund.quote(0.01 ether), 172_800);
        assertEq(fund.freeSecondsPerDay(), 3600);
        vm.prank(alice); vm.expectRevert(LifeFund.NotOwner.selector); fund.setRate(1, 1);
        assertEq(fund.stockSeconds(), 1_000_000);
        fund.withdrawToken(1 ether);
        assertEq(fund.stockSeconds(), 999_999);
    }
}
