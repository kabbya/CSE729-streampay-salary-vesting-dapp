// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title StreamPay - Corporate Micro-Salary & Vesting Protocol
 * @notice An employer locks ETH for a registered employee over a fixed duration.
 *         The salary unlocks linearly, second by second. The employee may withdraw
 *         whatever has unlocked so far; either party may cancel, which settles the
 *         vested part to the employee and refunds the unvested part to the employer.
 *         The protocol admin (the deployer) earns a 1% fee on every settled amount
 *         and claims it later with a pull payment.
 *
 * @dev Course project (CSE729 Project 2). Local Anvil / academic use only.
 *      Every monetary value in this contract is in wei and every calculation is
 *      integer arithmetic, exactly as the EVM performs it.
 */
contract StreamPay {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice A stream is Active until it is cancelled or fully settled.
    enum StreamStatus {
        None, // 0 - never created; lets us detect an unknown streamId
        Active, // 1 - money is still vesting
        Closed // 2 - cancelled or fully paid out
    }

    struct Stream {
        uint256 companyId; // company the employer belongs to
        address employer; // who funded the stream
        address payable employee; // who receives the salary
        uint256 totalDeposit; // total wei locked at creation
        uint256 startTime; // block.timestamp at creation
        uint256 duration; // seconds over which totalDeposit unlocks
        uint256 totalWithdrawn; // GROSS vested wei already settled (before fee)
        uint256 totalFeeCharged; // cumulative fee already taken from this stream
        uint256 closedAt; // timestamp vesting was frozen (0 while Active)
        StreamStatus status;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Fee in basis points. 100 bps = 1%.
    uint256 public constant FEE_BPS = 100;

    /// @notice Basis-point denominator. 10_000 bps = 100%.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Duration must be STRICTLY greater than this (project brief).
    uint256 public constant MIN_DURATION = 15;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Protocol admin: the account that deployed the contract (Anvil Account #0).
    address public immutable admin;

    /// @notice Fees collected but not yet claimed by the admin (pull-payment balance).
    uint256 public adminFeeBalance;

    /// @notice Stream IDs start at 1 so that 0 can mean "does not exist".
    uint256 public nextStreamId = 1;

    /// @notice Company IDs start at 1 for the same reason.
    uint256 public nextCompanyId = 1;

    mapping(uint256 streamId => Stream) private _streams;

    /// @notice companyId owned by an employer (0 = not registered).
    mapping(address employer => uint256 companyId) public companyIdOf;

    /// @notice Owner of a companyId.
    mapping(uint256 companyId => address employer) public companyOwner;

    /// @notice Is this address registered as an employee of this company?
    mapping(uint256 companyId => mapping(address employee => bool)) public isEmployeeOf;

    /// @dev Indexes so the frontend can enumerate. Solidity mappings are not iterable.
    mapping(address employer => uint256[] streamIds) private _outgoing;
    mapping(address employee => uint256[] streamIds) private _incoming;

    /// @dev Minimal reentrancy lock. 1 = unlocked, 2 = locked.
    uint256 private _lock = 1;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event CompanyRegistered(uint256 indexed companyId, address indexed employer);
    event EmployeeRegistered(uint256 indexed companyId, address indexed employee, address indexed employer);
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

    /*//////////////////////////////////////////////////////////////
                             CUSTOM ERRORS
    //////////////////////////////////////////////////////////////*/

    error Reentrancy();
    error ZeroAddress();
    error ZeroDeposit();
    error InvalidDuration(uint256 given, uint256 minimumExclusive);
    error EmployerIsEmployee();
    error CompanyAlreadyRegistered(uint256 companyId);
    error CompanyNotRegistered(address employer);
    error EmployeeNotRegistered(address employee, uint256 companyId);
    error EmployeeAlreadyRegistered(address employee, uint256 companyId);
    error UnknownStream(uint256 streamId);
    error StreamNotActive(uint256 streamId);
    error NotStreamEmployee(address caller);
    error NotStreamParty(address caller);
    error NothingToWithdraw(uint256 streamId);
    error NotAdmin(address caller);
    error NoFeesToClaim();
    error EthTransferFailed(address to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Cheap reentrancy guard. Defence in depth: we already follow
    ///      checks-effects-interactions, this stops a malicious recipient anyway.
    modifier nonReentrant() {
        if (_lock == 2) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @notice The deployer becomes the protocol admin. Deploy from Anvil Account #0.
    constructor() {
        admin = msg.sender;
    }

    /*//////////////////////////////////////////////////////////////
                          COMPANY REGISTRATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Register the caller as a company and receive a sequential companyId.
    function registerCompany() external returns (uint256 companyId) {
        companyId = companyIdOf[msg.sender];
        if (companyId != 0) revert CompanyAlreadyRegistered(companyId);

        companyId = nextCompanyId++;
        companyIdOf[msg.sender] = companyId;
        companyOwner[companyId] = msg.sender;

        emit CompanyRegistered(companyId, msg.sender);
    }

    /**
     * @notice Register `employee` under the caller's company.
     * @dev If the caller has no company yet, one is created automatically so a
     *      beginner demo needs one transaction instead of two.
     */
    function registerEmployee(address employee) external returns (uint256 companyId) {
        if (employee == address(0)) revert ZeroAddress();
        if (employee == msg.sender) revert EmployerIsEmployee();

        companyId = companyIdOf[msg.sender];
        if (companyId == 0) {
            companyId = nextCompanyId++;
            companyIdOf[msg.sender] = companyId;
            companyOwner[companyId] = msg.sender;
            emit CompanyRegistered(companyId, msg.sender);
        }

        if (isEmployeeOf[companyId][employee]) revert EmployeeAlreadyRegistered(employee, companyId);
        isEmployeeOf[companyId][employee] = true;

        emit EmployeeRegistered(companyId, employee, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                            CREATE A STREAM
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Lock `msg.value` wei for `employee`, unlocking linearly over `duration` seconds.
     * @param employee Recipient, already registered under the caller's company.
     * @param duration Stream length in seconds. Must be strictly greater than 15.
     * @return streamId The new stream's identifier.
     */
    function createStream(address payable employee, uint256 duration)
        external
        payable
        returns (uint256 streamId)
    {
        if (employee == address(0)) revert ZeroAddress();
        if (employee == msg.sender) revert EmployerIsEmployee();
        if (msg.value == 0) revert ZeroDeposit();
        if (duration <= MIN_DURATION) revert InvalidDuration(duration, MIN_DURATION);

        uint256 companyId = companyIdOf[msg.sender];
        if (companyId == 0) revert CompanyNotRegistered(msg.sender);
        if (!isEmployeeOf[companyId][employee]) revert EmployeeNotRegistered(employee, companyId);

        streamId = nextStreamId++;

        _streams[streamId] = Stream({
            companyId: companyId,
            employer: msg.sender,
            employee: employee,
            totalDeposit: msg.value,
            startTime: block.timestamp,
            duration: duration,
            totalWithdrawn: 0,
            totalFeeCharged: 0,
            closedAt: 0,
            status: StreamStatus.Active
        });

        _outgoing[msg.sender].push(streamId);
        _incoming[employee].push(streamId);

        emit StreamCreated(streamId, msg.sender, employee, companyId, msg.value, block.timestamp, duration);
    }

    /*//////////////////////////////////////////////////////////////
                             VESTING MATH
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Gross wei unlocked so far, capped at the total deposit.
     * @dev Unlocked = totalDeposit * elapsed / duration. Integer division floors,
     *      which is intended: it can never over-pay. For a Closed stream, vesting
     *      is frozen at `closedAt` so a cancelled stream stops growing.
     */
    function getUnlockedAmount(uint256 streamId) public view returns (uint256) {
        Stream storage s = _streams[streamId];
        if (s.status == StreamStatus.None) revert UnknownStream(streamId);

        uint256 effectiveTime = s.status == StreamStatus.Closed ? s.closedAt : block.timestamp;
        if (effectiveTime <= s.startTime) return 0;

        // Compare elapsed time instead of adding startTime + duration. The public API
        // accepts every uint256 duration > 15, so that addition could otherwise overflow.
        uint256 elapsed = effectiveTime - s.startTime;
        if (elapsed >= s.duration) return s.totalDeposit;

        return (s.totalDeposit * elapsed) / s.duration;
    }

    /**
     * @notice What the employee would receive if they withdrew right now.
     * @return grossClaimable Newly vested wei, before fee.
     * @return fee The incremental 1% fee for this settlement.
     * @return netAmount grossClaimable - fee, i.e. the ETH actually transferred.
     */
    function previewWithdraw(uint256 streamId)
        public
        view
        returns (uint256 grossClaimable, uint256 fee, uint256 netAmount)
    {
        Stream storage s = _streams[streamId];
        if (s.status == StreamStatus.None) revert UnknownStream(streamId);

        uint256 unlocked = getUnlockedAmount(streamId);
        grossClaimable = unlocked > s.totalWithdrawn ? unlocked - s.totalWithdrawn : 0;
        fee = _incrementalFee(s.totalWithdrawn + grossClaimable, s.totalFeeCharged);
        netAmount = grossClaimable - fee;
    }

    /**
     * @dev Cumulative fee model. The fee owed on a stream is always
     *      floor(grossSettledSoFar * 100 / 10000). We charge the difference between
     *      what is owed after this settlement and what has already been charged.
     *      Consequence: ten small withdrawals cost exactly the same total fee as one
     *      big withdrawal, so a user cannot shave wei off the admin by splitting.
     *      Also guarantees fee <= grossClaimable, so `grossClaimable - fee` cannot underflow.
     */
    function _incrementalFee(uint256 newGrossSettled, uint256 feeAlreadyCharged)
        private
        pure
        returns (uint256)
    {
        uint256 feeRequired = (newGrossSettled * FEE_BPS) / BPS_DENOMINATOR;
        return feeRequired > feeAlreadyCharged ? feeRequired - feeAlreadyCharged : 0;
    }

    /*//////////////////////////////////////////////////////////////
                                WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @notice Employee claims everything that has unlocked since their last withdrawal.
    function withdraw(uint256 streamId) external nonReentrant {
        Stream storage s = _streams[streamId];
        if (s.status == StreamStatus.None) revert UnknownStream(streamId);
        if (s.status != StreamStatus.Active) revert StreamNotActive(streamId);
        if (msg.sender != s.employee) revert NotStreamEmployee(msg.sender);

        uint256 unlocked = getUnlockedAmount(streamId);
        uint256 grossClaimable = unlocked - s.totalWithdrawn; // monotonic, cannot underflow
        if (grossClaimable == 0) revert NothingToWithdraw(streamId);

        uint256 newGrossSettled = s.totalWithdrawn + grossClaimable;
        uint256 fee = _incrementalFee(newGrossSettled, s.totalFeeCharged);
        uint256 netAmount = grossClaimable - fee;

        // ---- EFFECTS (all state written before any ETH leaves) ----
        s.totalWithdrawn = newGrossSettled;
        s.totalFeeCharged += fee;
        adminFeeBalance += fee;

        if (newGrossSettled == s.totalDeposit) {
            s.status = StreamStatus.Closed;
            s.closedAt = block.timestamp;
        }

        // ---- INTERACTIONS ----
        _sendEth(s.employee, netAmount);

        emit SalaryWithdrawn(streamId, s.employee, grossClaimable, fee, netAmount);
    }

    /*//////////////////////////////////////////////////////////////
                                 CANCEL
    //////////////////////////////////////////////////////////////*/

    /// @notice Either party ends the stream: vested part settles, unvested part refunds.
    function cancelStream(uint256 streamId) external nonReentrant {
        Stream storage s = _streams[streamId];
        if (s.status == StreamStatus.None) revert UnknownStream(streamId);
        if (s.status != StreamStatus.Active) revert StreamNotActive(streamId);
        if (msg.sender != s.employer && msg.sender != s.employee) revert NotStreamParty(msg.sender);

        uint256 vested = getUnlockedAmount(streamId); // still Active here, so uses block.timestamp
        uint256 employeeGross = vested - s.totalWithdrawn;
        uint256 fee = _incrementalFee(vested, s.totalFeeCharged);
        uint256 employeeNet = employeeGross - fee;
        uint256 employerRefund = s.totalDeposit - vested;

        // ---- EFFECTS ----
        s.status = StreamStatus.Closed;
        s.closedAt = block.timestamp; // freezes getUnlockedAmount from now on
        s.totalWithdrawn = vested;
        s.totalFeeCharged += fee;
        adminFeeBalance += fee;

        address payable employee = s.employee;
        address payable employer = payable(s.employer);

        // ---- INTERACTIONS ----
        if (employeeNet > 0) _sendEth(employee, employeeNet);
        if (employerRefund > 0) _sendEth(employer, employerRefund);

        emit StreamCancelled(streamId, msg.sender, employeeGross, fee, employeeNet, employerRefund);
    }

    /*//////////////////////////////////////////////////////////////
                           ADMIN PULL PAYMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Admin withdraws all fees accumulated so far.
    function claimAdminFees() external nonReentrant onlyAdmin returns (uint256 amount) {
        amount = adminFeeBalance;
        if (amount == 0) revert NoFeesToClaim();

        adminFeeBalance = 0; // effect before interaction
        _sendEth(payable(admin), amount);

        emit AdminFeesClaimed(admin, amount);
    }

    /*//////////////////////////////////////////////////////////////
                             VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    function getStream(uint256 streamId) external view returns (Stream memory) {
        Stream storage s = _streams[streamId];
        if (s.status == StreamStatus.None) revert UnknownStream(streamId);
        return s;
    }

    /// @notice Batch reader for one requested stream-ID list.
    function getStreams(uint256[] calldata streamIds) external view returns (Stream[] memory out) {
        out = new Stream[](streamIds.length);
        for (uint256 i = 0; i < streamIds.length; i++) {
            uint256 streamId = streamIds[i];
            Stream storage s = _streams[streamId];
            if (s.status == StreamStatus.None) revert UnknownStream(streamId);
            out[i] = s;
        }
    }

    function getOutgoingStreamIds(address employer) external view returns (uint256[] memory) {
        return _outgoing[employer];
    }

    function getIncomingStreamIds(address employee) external view returns (uint256[] memory) {
        return _incoming[employee];
    }

    function totalStreams() external view returns (uint256) {
        return nextStreamId - 1;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Checked low-level call. `transfer` is avoided: its 2300 gas stipend
    ///      breaks for smart-contract wallets after EVM gas repricings.
    function _sendEth(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed(to, amount);
    }
}
