// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FlyWorld — the on-chain world of the whole-brain fly
///
/// @notice The whole FlyWire brain (139,248 neurons, 2.7 M connections) is too large to
///         step inside a block, so it runs on an operator's machine in the published,
///         deterministic model and is anchored here:
///           - holders burn $FLY to place FOOD in the arena. The food's odor plume drives
///             the fly's real olfactory neurons; it has to smell its way there to live.
///           - the operator posts CHECKPOINTS: a hash of the entire brain state
///             (every membrane potential and synaptic current), the fly's position,
///             energy, age and spike count. Anyone holding the published snapshot can
///             re-run the model from one checkpoint to the next and verify the hash.
///           - when energy reaches zero the fly dies; anyone can resurrect it by
///             burning $FLY, and the operator restores the brain from the death snapshot.
///         The contract has no owner functions beyond the operator's attestations, and
///         the operator cannot move anyone's tokens.
contract FlyWorld {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    IERC20 public immutable token;
    address public immutable operator;
    uint256 public immutable TOKENS_PER_SECOND; // 1 $FLY = 1 second of life
    uint256 public immutable MIN_FOOD; // in tokens
    uint256 public immutable RESURRECT_PRICE;
    int32 public immutable ARENA; // half-width of the square arena, body lengths

    struct Food {
        address by;
        int32 x;
        int32 y;
        uint64 seconds_;
        uint64 blockNumber;
    }

    Food[] public foods;
    uint32 public generation;
    bool public alive = true;
    bytes32 public lastHash;
    uint64 public lastStep;
    uint64 public lastAgeMs;
    uint64 public lastEnergy;
    uint256 public totalBurned;
    mapping(address => uint256) public fedBy;

    event FoodPlaced(uint256 indexed id, address indexed by, int32 x, int32 y, uint64 seconds_, uint256 tokensBurned);
    event Checkpoint(uint64 step, uint64 ageMs, bytes32 stateHash, int32 x, int32 y, uint64 energy, uint64 spikes, uint32 generation, string snapshotURI);
    event Died(uint32 indexed generation, uint64 ageMs, bytes32 stateHash, string snapshotURI);
    event Resurrected(uint32 indexed generation, address indexed by, uint256 tokensBurned, uint64 energy);

    error NotOperator();
    error Dead();
    error NotDead();
    error OutOfArena();
    error TooSmall();

    constructor(IERC20 token_, uint256 tokensPerSecond, uint256 minFood, uint256 resurrectPrice, int32 arena) {
        token = token_;
        operator = msg.sender;
        TOKENS_PER_SECOND = tokensPerSecond;
        MIN_FOOD = minFood;
        RESURRECT_PRICE = resurrectPrice;
        ARENA = arena;
    }

    /// @notice Burn $FLY to put food at (x, y). Each TOKENS_PER_SECOND buys one second of life,
    ///         but only if the fly finds it.
    function placeFood(int32 x, int32 y, uint256 amount) external returns (uint256 id) {
        if (!alive) revert Dead();
        if (amount < MIN_FOOD) revert TooSmall();
        if (x < -ARENA || x > ARENA || y < -ARENA || y > ARENA) revert OutOfArena();
        uint64 secs = uint64(amount / TOKENS_PER_SECOND);
        id = foods.length;
        foods.push(Food({by: msg.sender, x: x, y: y, seconds_: secs, blockNumber: uint64(block.number)}));
        fedBy[msg.sender] += amount;
        totalBurned += amount;
        token.safeTransferFrom(msg.sender, DEAD, amount);
        emit FoodPlaced(id, msg.sender, x, y, secs, amount);
    }

    function checkpoint(uint64 step, uint64 ageMs, bytes32 stateHash, int32 x, int32 y, uint64 energy, uint64 spikes, string calldata snapshotURI) external {
        if (msg.sender != operator) revert NotOperator();
        lastHash = stateHash;
        lastStep = step;
        lastAgeMs = ageMs;
        lastEnergy = energy;
        emit Checkpoint(step, ageMs, stateHash, x, y, energy, spikes, generation, snapshotURI);
    }

    function reportDeath(uint64 ageMs, bytes32 stateHash, string calldata snapshotURI) external {
        if (msg.sender != operator) revert NotOperator();
        if (!alive) revert Dead();
        alive = false;
        lastHash = stateHash;
        lastAgeMs = ageMs;
        lastEnergy = 0;
        emit Died(generation, ageMs, stateHash, snapshotURI);
    }

    /// @notice Bring the fly back with `extraFood / TOKENS_PER_SECOND` seconds of life.
    function resurrect(uint256 extraFood) external {
        if (alive) revert NotDead();
        uint256 cost = RESURRECT_PRICE + extraFood;
        alive = true;
        generation += 1;
        uint64 energy = uint64(extraFood / TOKENS_PER_SECOND);
        lastEnergy = energy;
        fedBy[msg.sender] += extraFood;
        totalBurned += cost;
        token.safeTransferFrom(msg.sender, DEAD, cost);
        emit Resurrected(generation, msg.sender, cost, energy);
    }

    function foodCount() external view returns (uint256) {
        return foods.length;
    }
}
