// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StreamPay} from "../src/StreamPay.sol";

/// @dev A malicious employee: when paid, it immediately calls withdraw again.
contract ReentrantEmployee {
    StreamPay private sp;
    uint256 private id;
    bool public tried;
    bytes public caughtError;

    function arm(StreamPay _sp, uint256 _id) external {
        sp = _sp;
        id = _id;
    }

    function attack() external {
        sp.withdraw(id);
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        try sp.withdraw(id) {
            caughtError = hex"deadbeef"; // re-entry SUCCEEDED - the guard failed
        } catch (bytes memory err) {
            caughtError = err;
        }
    }
}

contract ReentrancyTest is Test {
    StreamPay internal sp;
    address internal employer = makeAddr("employer");

    function test_ReentrantWithdrawIsBlockedByTheLock() public {
        sp = new StreamPay();
        ReentrantEmployee attacker = new ReentrantEmployee();
        vm.deal(employer, 10 ether);

        vm.startPrank(employer);
        sp.registerEmployee(address(attacker));
        uint256 start = block.timestamp;
        uint256 id = sp.createStream{value: 1 ether}(payable(address(attacker)), 100);
        vm.stopPrank();

        attacker.arm(sp, id);
        vm.warp(start + 50);

        attacker.attack();

        assertTrue(attacker.tried(), "the attacker did re-enter");
        assertEq(
            attacker.caughtError(),
            abi.encodeWithSelector(StreamPay.Reentrancy.selector),
            "re-entry must revert with Reentrancy()"
        );

        // It was paid exactly once, for exactly the vested amount minus the fee.
        assertEq(address(attacker).balance, 0.495 ether, "0.5 vested minus 1%");
        assertEq(sp.getStream(id).totalWithdrawn, 0.5 ether);
        assertEq(address(sp).balance, 0.505 ether, "0.5 unvested + 0.005 fee still held");
    }
}
