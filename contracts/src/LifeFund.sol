// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFlyRegistryFeed {
    function feed(uint256 id, uint64 seconds_) external;
    function FEED_PER_SECOND() external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
}

/// @title LifeFund: keep a fly alive for a little BNB
///
/// @notice Feeding a fly on `FlyRegistry` burns $FLY per second of life. That is the organism's metabolism and it
///         stays as it is, but most people should not have to hold $FLY to keep a fly alive. So: anyone sends BNB
///         for a fly (`sponsor`), the fund credits it with seconds of life at a published rate, and the operator's
///         keeper spends that credit by feeding the fly from the $FLY this contract holds (`keep`), whenever the
///         fly is running in a body and getting hungry. The $FLY still burns; the BNB pays for it and for the gas.
///
///         - `sponsor(id)`: payable; credit[id] += msg.value * secondsPerWei (the rate the site shows)
///         - `keep(id, seconds)`: keeper only; credit[id] -= seconds; registry.feed(id, seconds) with the fund's $FLY
///         - `grant(id, seconds)`: keeper only; a free top-up (the operator keeping the world alive "because why not"):
///           no credit needed, capped by `freeSecondsPerDay` per fly
///         - the BNB goes to `treasury`; the operator refills the fund's $FLY; nothing here can touch anyone's fly.
contract LifeFund {
    using SafeERC20 for IERC20;

    IFlyRegistryFeed public immutable registry;
    IERC20 public immutable token;
    address public owner;          // sets the rate, the keeper, the treasury
    address public keeper;         // the address that runs keep/grant (the operator's keeper wallet)
    address public treasury;       // where the BNB goes
    uint256 public secondsPerWeiE18;  // seconds of life per wei of BNB, times 1e18 (0.01 BNB -> 24 h is 8_640_000)
    uint256 public freeSecondsPerDay;

    // credits are seconds of life, bought with BNB and not yet fed
    mapping(uint256 => uint256) public credit;
    mapping(uint256 => uint256) public sponsoredTotal;   // wei ever sent for a fly
    mapping(uint256 => uint256) public fedTotal;         // seconds ever fed by the fund for a fly
    mapping(uint256 => uint256) public freeUsedDay;      // day index of the last free grant
    mapping(uint256 => uint256) public freeUsedSeconds;  // free seconds granted that day

    event Sponsored(uint256 indexed id, address indexed by, uint256 wei_, uint256 seconds_, uint256 credit);
    event Kept(uint256 indexed id, uint64 seconds_, uint256 creditLeft);
    event Granted(uint256 indexed id, uint64 seconds_);
    event RateSet(uint256 secondsPerWeiE18, uint256 freeSecondsPerDay);

    error NotOwner();
    error NotKeeper();
    error NoCredit();
    error TooLittle();
    error FreeCapReached();

    /// @param secondsPerWeiE18_ seconds of life per wei, times 1e18. 0.01 BNB (1e16 wei) buying 86,400 s means
    ///                         86400 / 1e16 * 1e18 = 8_640_000.
    constructor(IFlyRegistryFeed registry_, IERC20 token_, address keeper_, address treasury_, uint256 secondsPerWeiE18_, uint256 freeSecondsPerDay_) {
        registry = registry_;
        token = token_;
        owner = msg.sender;
        keeper = keeper_;
        treasury = treasury_;
        secondsPerWeiE18 = secondsPerWeiE18_;
        freeSecondsPerDay = freeSecondsPerDay_;
        token_.approve(address(registry_), type(uint256).max);
        emit RateSet(secondsPerWeiE18_, freeSecondsPerDay_);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyKeeper() { if (msg.sender != keeper && msg.sender != owner) revert NotKeeper(); _; }

    /// @notice Seconds of life `wei_` buys at the current rate.
    function quote(uint256 wei_) public view returns (uint256 seconds_) { return wei_ * secondsPerWeiE18 / 1e18; }

    /// @notice Pay BNB to keep fly `id` alive. Anyone, for any fly. The credit never expires; the keeper spends it as the fly needs food.
    function sponsor(uint256 id) external payable {
        registry.ownerOf(id); // reverts for a fly that does not exist
        uint256 s = quote(msg.value);
        if (s == 0) revert TooLittle();
        credit[id] += s;
        sponsoredTotal[id] += msg.value;
        (bool ok,) = treasury.call{value: msg.value}("");
        require(ok, "treasury");
        emit Sponsored(id, msg.sender, msg.value, s, credit[id]);
    }

    /// @notice Spend up to `seconds_` of a fly's credit on food. Keeper only. Feeds the registry with the fund's own $FLY.
    function keep(uint256 id, uint64 seconds_) external onlyKeeper {
        uint256 c = credit[id];
        if (c == 0) revert NoCredit();
        uint64 s = seconds_;
        if (uint256(s) > c) s = uint64(c);
        if (s == 0) revert TooLittle();
        credit[id] = c - s;
        fedTotal[id] += s;
        registry.feed(id, s);
        emit Kept(id, s, credit[id]);
    }

    /// @notice A free top-up from the operator, capped per fly per day. Keeper only.
    function grant(uint256 id, uint64 seconds_) external onlyKeeper {
        uint256 day = block.timestamp / 1 days;
        if (freeUsedDay[id] != day) { freeUsedDay[id] = day; freeUsedSeconds[id] = 0; }
        if (freeUsedSeconds[id] + seconds_ > freeSecondsPerDay) revert FreeCapReached();
        freeUsedSeconds[id] += seconds_;
        fedTotal[id] += seconds_;
        registry.feed(id, seconds_);
        emit Granted(id, seconds_);
    }

    /// @notice Free seconds still available for fly `id` today.
    function freeLeftToday(uint256 id) external view returns (uint256) {
        uint256 day = block.timestamp / 1 days;
        uint256 used = freeUsedDay[id] == day ? freeUsedSeconds[id] : 0;
        return used >= freeSecondsPerDay ? 0 : freeSecondsPerDay - used;
    }

    // ---- operator
    function setRate(uint256 secondsPerWeiE18_, uint256 freeSecondsPerDay_) external onlyOwner {
        secondsPerWeiE18 = secondsPerWeiE18_; freeSecondsPerDay = freeSecondsPerDay_;
        emit RateSet(secondsPerWeiE18_, freeSecondsPerDay_);
    }
    function setKeeper(address k) external onlyOwner { keeper = k; }
    function setTreasury(address t) external onlyOwner { treasury = t; }
    function setOwner(address o) external onlyOwner { owner = o; }
    /// @notice Take $FLY out of the fund (the operator's own tokens; the fund only ever burns them through feed).
    function withdrawToken(uint256 amount) external onlyOwner { token.safeTransfer(owner, amount); }
    /// @notice The fund's $FLY, in seconds of life it can still pay for.
    function stockSeconds() external view returns (uint256) { return token.balanceOf(address(this)) / registry.FEED_PER_SECOND(); }
}
