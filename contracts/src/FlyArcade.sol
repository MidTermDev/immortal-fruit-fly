// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title FlyArcade — an on-chain log of a whole-brain fly playing a game
/// @notice While the 139,248-neuron FlyWire brain plays (DOOM, or any other game), the
///         operator records each decision here: a hash of the entire brain state at the
///         moment of the decision, the action it produced, and the game state. Anyone with
///         the published snapshots can re-run the model and reproduce the hash chain.
///         Purely an attestation log; it holds no funds and has no other authority.
contract FlyArcade {
    address public immutable operator;

    struct Session {
        string game;
        uint64 startBlock;
        uint64 endBlock;
        uint32 decisions;
        uint32 kills;
        bytes32 finalHash;
    }

    Session[] public sessions;

    event SessionStarted(uint256 indexed id, string game, bytes32 brainHash, uint64 brainStep);
    event Decision(uint256 indexed session, uint32 indexed n, bytes32 brainHash, uint64 brainStep, int16 turn, bool fire, uint32 spikes, uint16 kills, uint16 health, uint32 gameTic);
    event SessionEnded(uint256 indexed id, uint32 decisions, uint32 kills, bytes32 finalHash);

    error NotOperator();

    constructor() {
        operator = msg.sender;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    function startSession(string calldata game, bytes32 brainHash, uint64 brainStep) external onlyOperator returns (uint256 id) {
        id = sessions.length;
        Session storage s = sessions.push();
        s.game = game;
        s.startBlock = uint64(block.number);
        s.finalHash = brainHash;
        emit SessionStarted(id, game, brainHash, brainStep);
    }

    function decide(uint256 session, bytes32 brainHash, uint64 brainStep, int16 turn, bool fire, uint32 spikes, uint16 kills, uint16 health, uint32 gameTic) external onlyOperator {
        Session storage s = sessions[session];
        s.decisions += 1;
        s.kills = kills;
        s.finalHash = brainHash;
        emit Decision(session, s.decisions, brainHash, brainStep, turn, fire, spikes, kills, health, gameTic);
    }

    function endSession(uint256 session) external onlyOperator {
        Session storage s = sessions[session];
        s.endBlock = uint64(block.number);
        emit SessionEnded(session, s.decisions, s.kills, s.finalHash);
    }

    function sessionCount() external view returns (uint256) {
        return sessions.length;
    }
}
