// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StreamPay} from "../src/StreamPay.sol";

contract AdversarialEdgeCasesTest is Test {
    StreamPay private streamPay;
    address private employer = makeAddr("employer");
    address payable private employee = payable(makeAddr("employee"));

    function setUp() public {
        streamPay = new StreamPay();
        vm.deal(employer, 10 ether);
        vm.prank(employer);
        streamPay.registerEmployee(employee);
    }

    /// Any uint256 duration greater than 15 satisfies the public API's validation.
    /// It must not make the stream impossible to preview or cancel.
    function test_MaxDurationDoesNotLockDepositedEth() public {
        vm.prank(employer);
        uint256 id = streamPay.createStream{value: 1 ether}(employee, type(uint256).max);

        assertEq(streamPay.getUnlockedAmount(id), 0);

        vm.prank(employer);
        streamPay.cancelStream(id);

        assertEq(address(streamPay).balance, 0);
    }

    /// Batch reads should follow getStream's clean unknown-ID behavior rather than
    /// silently returning an all-zero record that looks like a real stream to clients.
    function test_BatchReadRejectsUnknownStreamId() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 999;
        vm.expectRevert(abi.encodeWithSelector(StreamPay.UnknownStream.selector, 999));
        streamPay.getStreams(ids);
    }

    /// A positive gross claim must remain executable even when its entire 1 wei
    /// becomes the cumulative fee and the employee's net transfer is zero.
    function test_FinalGrossWeiCanSettleEvenWhenEmployeeNetIsZero() public {
        vm.prank(employer);
        uint256 id = streamPay.createStream{value: 100 wei}(employee, 100);

        uint256 start = streamPay.getStream(id).startTime;
        vm.warp(start + 99);
        vm.prank(employee);
        streamPay.withdraw(id);

        vm.warp(start + 100);
        (uint256 gross, uint256 fee, uint256 net) = streamPay.previewWithdraw(id);
        assertEq(gross, 1);
        assertEq(fee, 1);
        assertEq(net, 0);

        vm.prank(employee);
        streamPay.withdraw(id);
        assertEq(uint256(streamPay.getStream(id).status), 2, "final wei closes stream");
    }
}
