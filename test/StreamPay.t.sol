// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {StreamPay} from "../src/StreamPay.sol";

/// @dev A recipient contract with no receive()/fallback(), used to prove that a
///      failed ETH transfer reverts the WHOLE transaction and leaves no half-updated state.
contract RejectsEth {}

contract StreamPayTest is Test {
    StreamPay internal sp;

    address internal admin = makeAddr("admin");
    address internal employer = makeAddr("employer");
    address payable internal employee = payable(makeAddr("employee"));
    address internal stranger = makeAddr("stranger");

    uint256 internal constant DEPOSIT = 1 ether;
    uint256 internal constant DURATION = 100;

    // Mirror of the contract's events, so we can use vm.expectEmit.
    event StreamCreated(
        uint256 indexed streamId,
        address indexed employer,
        address indexed employee,
        uint256 companyId,
        uint256 deposit,
        uint256 startTime,
        uint256 duration
    );
    event SalaryWithdrawn(
        uint256 indexed streamId,
        address indexed employee,
        uint256 grossAmount,
        uint256 fee,
        uint256 netAmount
    );
    event StreamCancelled(
        uint256 indexed streamId,
        address indexed cancelledBy,
        uint256 employeeGross,
        uint256 fee,
        uint256 employeeNet,
        uint256 employerRefund
    );
    event AdminFeesClaimed(address indexed admin, uint256 amount);

    function setUp() public {
        vm.prank(admin);
        sp = new StreamPay();

        vm.deal(employer, 100 ether);
        vm.deal(stranger, 10 ether);
        // Start at a realistic timestamp instead of 1.
        vm.warp(1_700_000_000);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _newStream() internal returns (uint256 id, uint256 startTime) {
        vm.startPrank(employer);
        sp.registerEmployee(employee);
        startTime = block.timestamp;
        id = sp.createStream{value: DEPOSIT}(employee, DURATION);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                             1. DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsDeployerAsAdmin() public view {
        assertEq(sp.admin(), admin, "deployer must be admin");
        assertEq(sp.nextStreamId(), 1, "stream ids start at 1");
        assertEq(sp.nextCompanyId(), 1, "company ids start at 1");
        assertEq(sp.adminFeeBalance(), 0);
        assertEq(sp.FEE_BPS(), 100);
        assertEq(sp.MIN_DURATION(), 15);
    }

    /*//////////////////////////////////////////////////////////////
                            2. REGISTRATION
    //////////////////////////////////////////////////////////////*/

    function test_RegisterCompany_AssignsSequentialIds() public {
        vm.prank(employer);
        assertEq(sp.registerCompany(), 1);
        vm.prank(stranger);
        assertEq(sp.registerCompany(), 2);
        assertEq(sp.companyOwner(1), employer);
    }

    function test_RegisterCompany_RevertsOnDuplicate() public {
        vm.startPrank(employer);
        sp.registerCompany();
        vm.expectRevert(abi.encodeWithSelector(StreamPay.CompanyAlreadyRegistered.selector, 1));
        sp.registerCompany();
        vm.stopPrank();
    }

    function test_RegisterEmployee_AutoCreatesCompany() public {
        vm.prank(employer);
        uint256 companyId = sp.registerEmployee(employee);
        assertEq(companyId, 1);
        assertEq(sp.companyIdOf(employer), 1);
        assertTrue(sp.isEmployeeOf(1, employee));
    }

    function test_RegisterEmployee_RevertsOnZeroAddressSelfAndDuplicate() public {
        vm.startPrank(employer);
        vm.expectRevert(StreamPay.ZeroAddress.selector);
        sp.registerEmployee(address(0));

        vm.expectRevert(StreamPay.EmployerIsEmployee.selector);
        sp.registerEmployee(employer);

        sp.registerEmployee(employee);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.EmployeeAlreadyRegistered.selector, employee, 1));
        sp.registerEmployee(employee);
        vm.stopPrank();
    }

    function test_EmployeeOfOneCompanyIsNotEmployeeOfAnother() public {
        vm.prank(employer);
        sp.registerEmployee(employee); // company 1

        vm.startPrank(stranger);
        sp.registerCompany(); // company 2
        vm.expectRevert(abi.encodeWithSelector(StreamPay.EmployeeNotRegistered.selector, employee, 2));
        sp.createStream{value: DEPOSIT}(employee, DURATION);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                          3. STREAM CREATION
    //////////////////////////////////////////////////////////////*/

    function test_CreateStream_StoresEverythingAndIndexes() public {
        (uint256 id, uint256 startTime) = _newStream();

        StreamPay.Stream memory s = sp.getStream(id);
        assertEq(id, 1);
        assertEq(s.companyId, 1);
        assertEq(s.employer, employer);
        assertEq(s.employee, employee);
        assertEq(s.totalDeposit, DEPOSIT);
        assertEq(s.startTime, startTime);
        assertEq(s.duration, DURATION);
        assertEq(s.totalWithdrawn, 0);
        assertEq(s.totalFeeCharged, 0);
        assertEq(s.closedAt, 0);
        assertEq(uint256(s.status), uint256(StreamPay.StreamStatus.Active));

        assertEq(sp.getOutgoingStreamIds(employer).length, 1);
        assertEq(sp.getIncomingStreamIds(employee).length, 1);
        assertEq(sp.getOutgoingStreamIds(employer)[0], 1);
        assertEq(address(sp).balance, DEPOSIT, "contract custodies the deposit");
    }

    function test_CreateStream_EmitsEvent() public {
        vm.startPrank(employer);
        sp.registerEmployee(employee);
        vm.expectEmit(true, true, true, true);
        emit StreamCreated(1, employer, employee, 1, DEPOSIT, block.timestamp, DURATION);
        sp.createStream{value: DEPOSIT}(employee, DURATION);
        vm.stopPrank();
    }

    function test_CreateStream_RevertsOnZeroDeposit() public {
        vm.startPrank(employer);
        sp.registerEmployee(employee);
        vm.expectRevert(StreamPay.ZeroDeposit.selector);
        sp.createStream{value: 0}(employee, DURATION);
        vm.stopPrank();
    }

    function test_CreateStream_DurationBoundaryIsStrict() public {
        vm.startPrank(employer);
        sp.registerEmployee(employee);

        vm.expectRevert(abi.encodeWithSelector(StreamPay.InvalidDuration.selector, 15, 15));
        sp.createStream{value: DEPOSIT}(employee, 15);

        vm.expectRevert(abi.encodeWithSelector(StreamPay.InvalidDuration.selector, 0, 15));
        sp.createStream{value: DEPOSIT}(employee, 0);

        uint256 id = sp.createStream{value: DEPOSIT}(employee, 16); // 16 is allowed
        assertEq(id, 1);
        vm.stopPrank();
    }

    function test_CreateStream_RevertsWhenCompanyNotRegistered() public {
        vm.prank(employer);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.CompanyNotRegistered.selector, employer));
        sp.createStream{value: DEPOSIT}(employee, DURATION);
    }

    /*//////////////////////////////////////////////////////////////
                            4. VESTING MATH
    //////////////////////////////////////////////////////////////*/

    function test_Unlocked_IsZeroAtStart() public {
        (uint256 id,) = _newStream();
        assertEq(sp.getUnlockedAmount(id), 0);
    }

    function test_Unlocked_IsLinearAndCapped() public {
        (uint256 id, uint256 start) = _newStream();

        vm.warp(start + 25);
        assertEq(sp.getUnlockedAmount(id), DEPOSIT / 4);

        vm.warp(start + 50);
        assertEq(sp.getUnlockedAmount(id), DEPOSIT / 2);

        vm.warp(start + DURATION);
        assertEq(sp.getUnlockedAmount(id), DEPOSIT, "fully vested exactly at endTime");

        vm.warp(start + DURATION + 10_000);
        assertEq(sp.getUnlockedAmount(id), DEPOSIT, "capped, never exceeds the deposit");
    }

    function test_Unlocked_RevertsForUnknownStream() public {
        vm.expectRevert(abi.encodeWithSelector(StreamPay.UnknownStream.selector, 42));
        sp.getUnlockedAmount(42);
    }

    function testFuzz_Unlocked_NeverExceedsDeposit(uint96 deposit, uint32 duration, uint32 jump) public {
        deposit = uint96(bound(uint256(deposit), 1, 50 ether));
        duration = uint32(bound(uint256(duration), 16, 3_000_000));

        vm.startPrank(employer);
        sp.registerEmployee(employee);
        uint256 id = sp.createStream{value: deposit}(employee, duration);
        vm.stopPrank();

        vm.warp(block.timestamp + jump);
        assertLe(sp.getUnlockedAmount(id), deposit);
    }

    /*//////////////////////////////////////////////////////////////
                              5. WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_Withdraw_PaysNinetyNinePercentAndAccruesFee() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 40);

        (uint256 gross, uint256 fee, uint256 net) = sp.previewWithdraw(id);
        assertEq(gross, 0.4 ether);
        assertEq(fee, 0.004 ether);
        assertEq(net, 0.396 ether);

        uint256 before = employee.balance;
        vm.prank(employee);
        sp.withdraw(id);

        assertEq(employee.balance - before, 0.396 ether, "employee receives 99%");
        assertEq(sp.adminFeeBalance(), 0.004 ether, "admin accrues 1%");

        StreamPay.Stream memory s = sp.getStream(id);
        assertEq(s.totalWithdrawn, 0.4 ether, "totalWithdrawn is GROSS, not net");
        assertEq(s.totalFeeCharged, 0.004 ether);
        assertEq(uint256(s.status), uint256(StreamPay.StreamStatus.Active));
    }

    function test_Withdraw_SecondCallOnlyPaysTheNewlyVestedDelta() public {
        (uint256 id, uint256 start) = _newStream();

        vm.warp(start + 40);
        vm.prank(employee);
        sp.withdraw(id);

        uint256 mid = employee.balance;

        vm.warp(start + 70);
        vm.prank(employee);
        sp.withdraw(id);

        assertEq(employee.balance - mid, 0.297 ether, "only the 0.3 ETH delta minus 1%");
        assertEq(sp.adminFeeBalance(), 0.007 ether);
        assertEq(sp.getStream(id).totalWithdrawn, 0.7 ether);
    }

    function test_Withdraw_RevertsForNonEmployee() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 40);

        vm.prank(employer);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.NotStreamEmployee.selector, employer));
        sp.withdraw(id);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.NotStreamEmployee.selector, stranger));
        sp.withdraw(id);
    }

    function test_Withdraw_RevertsWhenNothingVested() public {
        (uint256 id,) = _newStream();
        vm.prank(employee);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.NothingToWithdraw.selector, id));
        sp.withdraw(id);
    }

    function test_Withdraw_FullyVestedClosesTheStream() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + DURATION);

        vm.prank(employee);
        sp.withdraw(id);

        StreamPay.Stream memory s = sp.getStream(id);
        assertEq(uint256(s.status), uint256(StreamPay.StreamStatus.Closed));
        assertEq(s.totalWithdrawn, DEPOSIT);
        assertEq(employee.balance, 0.99 ether);
        assertEq(sp.adminFeeBalance(), 0.01 ether);

        vm.prank(employee);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.StreamNotActive.selector, id));
        sp.withdraw(id);
    }

    function test_Withdraw_EmitsEvent() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 40);
        vm.expectEmit(true, true, true, true);
        emit SalaryWithdrawn(id, employee, 0.4 ether, 0.004 ether, 0.396 ether);
        vm.prank(employee);
        sp.withdraw(id);
    }

    /// @notice The headline property of the cumulative fee model.
    function test_ManySmallWithdrawalsCostTheSameFeeAsOneBigOne() public {
        // Snapshot the whole EVM so the second scenario starts from identical state.
        uint256 snap = vm.snapshotState();

        (uint256 id, uint256 start) = _newStream();
        for (uint256 t = 1; t <= DURATION; t++) {
            vm.warp(start + t);
            vm.prank(employee);
            sp.withdraw(id);
        }
        uint256 feeManySmall = sp.adminFeeBalance();
        uint256 employeeManySmall = employee.balance;

        vm.revertToState(snap);

        (uint256 id2, uint256 start2) = _newStream();
        vm.warp(start2 + DURATION);
        vm.prank(employee);
        sp.withdraw(id2);

        assertEq(feeManySmall, sp.adminFeeBalance(), "fee must not depend on withdrawal count");
        assertEq(employeeManySmall, employee.balance, "employee net must not depend on withdrawal count");
        assertEq(feeManySmall, 0.01 ether);
        assertEq(employeeManySmall, 0.99 ether);
    }

    /*//////////////////////////////////////////////////////////////
                               6. CANCEL
    //////////////////////////////////////////////////////////////*/

    function test_Cancel_ByEmployer_SettlesVestedAndRefundsUnvested() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 70);

        uint256 employeeBefore = employee.balance;
        uint256 employerBefore = employer.balance;

        vm.prank(employer);
        sp.cancelStream(id);

        assertEq(employee.balance - employeeBefore, 0.693 ether, "0.7 vested minus 1%");
        assertEq(employer.balance - employerBefore, 0.3 ether, "exact unvested refund");
        assertEq(sp.adminFeeBalance(), 0.007 ether);

        StreamPay.Stream memory s = sp.getStream(id);
        assertEq(uint256(s.status), uint256(StreamPay.StreamStatus.Closed));
        assertEq(s.closedAt, block.timestamp);
        assertEq(s.totalWithdrawn, 0.7 ether);
    }

    function test_Cancel_ByEmployee_HasIdenticalAccounting() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 70);

        uint256 employeeBefore = employee.balance;
        uint256 employerBefore = employer.balance;

        vm.prank(employee);
        sp.cancelStream(id);

        assertEq(employee.balance - employeeBefore, 0.693 ether);
        assertEq(employer.balance - employerBefore, 0.3 ether);
        assertEq(uint256(sp.getStream(id).status), uint256(StreamPay.StreamStatus.Closed));
    }

    function test_Cancel_AfterAPartialWithdrawal_DoesNotDoublePay() public {
        (uint256 id, uint256 start) = _newStream();

        vm.warp(start + 40);
        vm.prank(employee);
        sp.withdraw(id); // employee has 0.396

        vm.warp(start + 70);
        uint256 employerBefore = employer.balance;
        vm.prank(employer);
        sp.cancelStream(id);

        assertEq(employee.balance, 0.693 ether, "0.396 + 0.297");
        assertEq(employer.balance - employerBefore, 0.3 ether);
        assertEq(sp.adminFeeBalance(), 0.007 ether);
    }

    function test_Cancel_RevertsForStrangerAndWhenAlreadyClosed() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 30);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.NotStreamParty.selector, stranger));
        sp.cancelStream(id);

        vm.prank(employer);
        sp.cancelStream(id);

        vm.prank(employer);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.StreamNotActive.selector, id));
        sp.cancelStream(id);

        vm.prank(employee);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.StreamNotActive.selector, id));
        sp.withdraw(id);
    }

    function test_Cancel_FreezesVestingAtClosedAt() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 30);

        vm.prank(employer);
        sp.cancelStream(id);
        uint256 frozen = sp.getUnlockedAmount(id);

        vm.warp(start + 99_999);
        assertEq(sp.getUnlockedAmount(id), frozen, "a closed stream must stop vesting");
        assertEq(frozen, 0.3 ether);
    }

    function test_Cancel_Immediately_RefundsEverything() public {
        (uint256 id,) = _newStream();
        uint256 employerBefore = employer.balance;

        vm.prank(employer);
        sp.cancelStream(id);

        assertEq(employer.balance - employerBefore, DEPOSIT);
        assertEq(employee.balance, 0);
        assertEq(sp.adminFeeBalance(), 0);
    }

    function test_Cancel_EmitsEvent() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 70);
        vm.expectEmit(true, true, true, true);
        emit StreamCancelled(id, employer, 0.7 ether, 0.007 ether, 0.693 ether, 0.3 ether);
        vm.prank(employer);
        sp.cancelStream(id);
    }

    /*//////////////////////////////////////////////////////////////
                          7. ADMIN PULL PAYMENT
    //////////////////////////////////////////////////////////////*/

    function test_ClaimAdminFees_OnlyAdminAndZeroesTheBalance() public {
        (uint256 id, uint256 start) = _newStream();
        vm.warp(start + 40);
        vm.prank(employee);
        sp.withdraw(id);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.NotAdmin.selector, stranger));
        sp.claimAdminFees();

        uint256 before = admin.balance;
        vm.expectEmit(true, true, true, true);
        emit AdminFeesClaimed(admin, 0.004 ether);
        vm.prank(admin);
        sp.claimAdminFees();

        assertEq(admin.balance - before, 0.004 ether);
        assertEq(sp.adminFeeBalance(), 0);

        vm.prank(admin);
        vm.expectRevert(StreamPay.NoFeesToClaim.selector);
        sp.claimAdminFees();
    }

    /*//////////////////////////////////////////////////////////////
                     8. SOLVENCY & CONSERVATION
    //////////////////////////////////////////////////////////////*/

    function test_Conservation_EmployeeNetPlusFeePlusRefundEqualsDeposit() public {
        (uint256 id, uint256 start) = _newStream();
        uint256 employerBefore = employer.balance;

        vm.warp(start + 40);
        vm.prank(employee);
        sp.withdraw(id);

        vm.warp(start + 70);
        vm.prank(employer);
        sp.cancelStream(id);

        uint256 employeeTotal = employee.balance;
        uint256 refund = employer.balance - employerBefore;
        uint256 fees = sp.adminFeeBalance();

        assertEq(employeeTotal + fees + refund, DEPOSIT, "no wei may be created or destroyed");
        assertEq(address(sp).balance, fees, "only unclaimed fees remain in the contract");
    }

    function testFuzz_Conservation(uint96 deposit, uint32 duration, uint32 t1, uint32 t2) public {
        deposit = uint96(bound(uint256(deposit), 1e6, 50 ether));
        duration = uint32(bound(uint256(duration), 16, 1_000_000));
        t1 = uint32(bound(uint256(t1), 1, duration));
        t2 = uint32(bound(uint256(t2), t1, duration));

        vm.startPrank(employer);
        sp.registerEmployee(employee);
        uint256 start = block.timestamp;
        uint256 id = sp.createStream{value: deposit}(employee, duration);
        vm.stopPrank();

        uint256 employerBefore = employer.balance;

        vm.warp(start + t1);
        (uint256 gross,,) = sp.previewWithdraw(id);
        if (gross > 0) {
            vm.prank(employee);
            sp.withdraw(id);
        }

        // The stream may have auto-closed if t1 reached the end.
        if (sp.getStream(id).status == StreamPay.StreamStatus.Active) {
            vm.warp(start + t2);
            vm.prank(employer);
            sp.cancelStream(id);
        }

        uint256 refund = employer.balance - employerBefore;
        assertEq(employee.balance + sp.adminFeeBalance() + refund, deposit, "conservation of wei");
        assertEq(address(sp).balance, sp.adminFeeBalance(), "contract holds only unclaimed fees");
    }

    function test_TwoStreamsStayIndependent() public {
        vm.startPrank(employer);
        sp.registerEmployee(employee);
        uint256 start = block.timestamp;
        uint256 a = sp.createStream{value: 1 ether}(employee, 100);
        uint256 b = sp.createStream{value: 2 ether}(employee, 200);
        vm.stopPrank();

        vm.warp(start + 50);
        assertEq(sp.getUnlockedAmount(a), 0.5 ether);
        assertEq(sp.getUnlockedAmount(b), 0.5 ether);

        vm.prank(employee);
        sp.withdraw(a);

        assertEq(sp.getStream(a).totalWithdrawn, 0.5 ether);
        assertEq(sp.getStream(b).totalWithdrawn, 0, "streams must not share accounting");
        assertEq(sp.getIncomingStreamIds(employee).length, 2);
    }

    /*//////////////////////////////////////////////////////////////
                        9. HOSTILE RECIPIENT
    //////////////////////////////////////////////////////////////*/

    function test_WithdrawRevertsIfEmployeeCannotReceiveEth() public {
        RejectsEth badEmployee = new RejectsEth();

        vm.startPrank(employer);
        sp.registerEmployee(address(badEmployee));
        uint256 start = block.timestamp;
        uint256 id = sp.createStream{value: DEPOSIT}(payable(address(badEmployee)), DURATION);
        vm.stopPrank();

        vm.warp(start + 50);
        vm.prank(address(badEmployee));
        vm.expectRevert();
        sp.withdraw(id);

        // Nothing was written: the whole transaction reverted.
        assertEq(sp.getStream(id).totalWithdrawn, 0);
        assertEq(sp.adminFeeBalance(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                        10. INTEGER-FLOOR BEHAVIOUR
    //////////////////////////////////////////////////////////////*/

    function test_TinyDepositRoundsDownAndNeverUnderflows() public {
        vm.startPrank(employer);
        sp.registerEmployee(employee);
        uint256 start = block.timestamp;
        uint256 id = sp.createStream{value: 100 wei}(employee, 100); // 1 wei per second
        vm.stopPrank();

        vm.warp(start + 1);
        (uint256 gross, uint256 fee, uint256 net) = sp.previewWithdraw(id);
        assertEq(gross, 1);
        assertEq(fee, 0, "floor(1 * 100 / 10000) = 0");
        assertEq(net, 1);

        vm.prank(employee);
        sp.withdraw(id);
        assertEq(employee.balance, 1);

        vm.warp(start + 100);
        vm.prank(employee);
        sp.withdraw(id);
        assertEq(employee.balance, 99, "total fee is exactly 1 wei = floor(100/100)");
        assertEq(sp.adminFeeBalance(), 1);
    }
}
