// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

interface IFlyToken is IERC20, IERC20Permit {
    function burnFrom(address account, uint256 value) external;
}

/// @title FlyBrain — a living fruit-fly neural circuit on BNB Smart Chain
///
/// @notice One organism. Its nervous system is the head-direction ring attractor of
///         the adult Drosophila brain (EPG, EPGt, PEG, PEN_a, PEN_b and Δ7 neurons),
///         taken neuron-for-neuron and synapse-for-synapse from the public FlyWire
///         connectome (release 783). The circuit is simulated on-chain as integer
///         leaky-integrate-and-fire neurons. Every membrane potential, every spike,
///         the fly's heading, its walk through the world, its memory and its
///         lineage live in this contract's storage.
///
///         - anyone can `tick()` the brain forward (it costs a fraction of a cent on BSC)
///         - holders burn $FLY to `feed()` it energy, or `stimulate()` its neurons
///         - when energy runs out it dies: the brain state is frozen, hashed and
///           recorded in `lineage`; `resurrect()` burns $FLY and the same brain wakes
///           up in a new body. Nothing is ever lost. That is the immortality.
///
/// @dev    Deterministic: given the same sequence of stimuli, any client can replay
///         the exact neural dynamics off-chain (the website does this to animate
///         between ticks). No randomness from block data is used; background noise
///         is keccak256(stepNumber).
contract FlyBrain {
    // ------------------------------------------------------------------ types

    /// Neuron cell types as encoded in the circuit table.
    uint8 public constant T_EPG = 0;
    uint8 public constant T_EPGT = 1;
    uint8 public constant T_PEG = 2;
    uint8 public constant T_PEN_A = 3;
    uint8 public constant T_PEN_B = 4;
    uint8 public constant T_DELTA7 = 5; // inhibitory
    uint8 public constant NO_WEDGE = 0xFF;
    uint256 public constant WEDGES = 16;

    /// Stimulus channels.
    uint8 public constant CH_NONE = 0;
    uint8 public constant CH_CUE = 1; // visual landmark: drives EPG neurons of wedge `param`
    uint8 public constant CH_TURN_LEFT = 2; // angular velocity: drives left-side PEN neurons
    uint8 public constant CH_TURN_RIGHT = 3; // angular velocity: drives right-side PEN neurons
    uint8 public constant CH_SHOCK = 4; // drives all Δ7 neurons: global inhibition, the bump collapses

    struct Life {
        uint64 bornBlock;
        uint64 diedBlock;
        uint64 steps;
        uint64 spikes;
        bytes32 brainStateHash;
    }

    struct Caretaker {
        uint128 fed; // tokens burned feeding
        uint64 ticks;
        uint64 stimuli;
    }

    struct Params {
        uint16 leak; // v -= v * leak / 1024 each step
        int16 thresh; // spike threshold
        int16 reset; // post-spike potential
        int16 vMin; // floor on hyperpolarisation
        int16[6] gains; // synaptic gain per presynaptic cell type (contribution = w * gain / 16); Δ7 is negative
        uint16 gBias; // engram gain (contribution = bias * gBias)
        uint16 noise; // background noise amplitude
        uint16 stimGain; // stimulus current = strength * stimGain
        uint16 stimTTL; // steps a stimulus stays active
        uint16 walkThreshold; // min |heading vector| per step to walk
        uint8 maxSteps; // max steps per tick
    }

    // ------------------------------------------------------------ immutables

    IFlyToken public immutable token;

    /// SSTORE2 pointer to the circuit table (see `circuitData()` for layout).
    address public immutable circuit;
    bytes32 public immutable circuitHash;
    uint256 public immutable N; // neurons
    uint256 public immutable S; // synapses
    bytes32 public immutable datasetSha256; // hash of the FlyWire connections file the table was built from

    uint256 private immutable _offType;
    uint256 private immutable _offWedge;
    uint256 private immutable _offSide;
    uint256 private immutable _offOffsets;
    uint256 private immutable _offSyn;
    uint256 private immutable _offRoot;

    uint16 public immutable LEAK;
    int16 public immutable THRESH;
    int16 public immutable RESET;
    int16 public immutable V_MIN;
    /// Per-presynaptic-type synaptic gains, 6 x int16 lanes (lane = cell type).
    uint256 public immutable GAINS;
    uint16 public immutable G_BIAS;
    uint16 public immutable NOISE;
    uint16 public immutable STIM_GAIN;
    uint16 public immutable STIM_TTL;
    uint16 public immutable WALK_THRESHOLD;
    uint8 public immutable MAX_STEPS;

    uint256 public immutable TOKENS_PER_STEP; // feed price: 1 step of life per this many token-wei
    uint256 public immutable STIM_PRICE; // token-wei per unit of stimulus strength
    uint256 public immutable RESURRECT_PRICE; // token-wei to resurrect

    int8 public constant BIAS_MAX = 24;
    int64 public constant STRIDE = 16; // 1/256 cells per step at full bump strength

    string public datasetName;

    // --------------------------------------------------------------- state

    // Membrane potentials: 16 x int16 lanes per word.
    uint256[16] private _v;
    // Engram: 32 x int8 lanes per word. Slow Hebbian potentiation of habitually active neurons.
    uint256[8] private _bias;
    // Heading histogram: 16 x uint16 lanes. How often the compass bump sat in each wedge.
    uint256 private _headingHist;

    uint64 public step; // total simulation steps since genesis
    uint64 public energy; // steps of life remaining
    uint64 public totalSpikes;
    uint64 public lifeSteps;
    uint64 public lifeSpikes;
    uint64 public bornBlock;
    uint32 public generation; // 0 = genesis life
    bool public alive;

    // Body
    int64 public posX; // 1/256 cell units
    int64 public posY;
    int32 public headX; // last population vector of the compass bump
    int32 public headY;

    // Active stimulus
    uint8 public stimChannel;
    uint8 public stimParam;
    uint16 public stimStrength;
    uint64 public stimUntilStep;

    Life[] public lineage;
    mapping(address => Caretaker) public caretakers;
    uint256 public totalBurned;

    // -------------------------------------------------------------- events

    event Ticked(
        address indexed by,
        uint64 fromStep,
        uint16 steps,
        uint32 spikes,
        int32 headX,
        int32 headY,
        int64 posX,
        int64 posY,
        uint64 energyLeft
    );
    event Fed(address indexed by, uint256 tokensBurned, uint64 energyAdded, uint64 energy);
    event Stimulated(address indexed by, uint8 channel, uint8 param, uint16 strength, uint64 untilStep, uint256 tokensBurned);
    event Died(uint32 indexed generation, uint64 bornBlock, uint64 diedBlock, uint64 lifeSteps, uint64 lifeSpikes, bytes32 brainStateHash);
    event Resurrected(uint32 indexed generation, address indexed by, uint256 tokensBurned, uint64 energy);

    error Dead();
    error NotDead();
    error BadSteps();
    error BadChannel();
    error BadStrength();
    error BadTable(string reason);
    error ZeroAmount();

    // --------------------------------------------------------- constructor

    /// @param token_        the $FLY token (burnable, permit)
    /// @param table         circuit table, see `circuitData()`
    /// @param p             dynamics parameters (calibrated off-chain, see sim/)
    /// @param datasetName_  e.g. "FlyWire v783 proofread_connections_783.feather"
    /// @param datasetSha256_ sha256 of that file
    /// @param genesisEnergy steps of life the fly is born with
    /// @param tokensPerStep feed price
    /// @param stimPrice     stimulus price per unit strength
    /// @param resurrectPrice price to resurrect
    constructor(
        IFlyToken token_,
        bytes memory table,
        Params memory p,
        string memory datasetName_,
        bytes32 datasetSha256_,
        uint64 genesisEnergy,
        uint256 tokensPerStep,
        uint256 stimPrice,
        uint256 resurrectPrice
    ) {
        token = token_;
        datasetName = datasetName_;
        datasetSha256 = datasetSha256_;

        // ---- validate + index the table
        if (table.length < 4) revert BadTable("short");
        if (_u8(table, 0) != 1) revert BadTable("version");
        uint256 n = _u8(table, 1);
        uint256 s = _u16(table, 2);
        if (n == 0 || n > 255) revert BadTable("N");
        uint256 offType = 4;
        uint256 offWedge = offType + n;
        uint256 offSide = offWedge + n;
        uint256 offOffsets = offSide + n;
        uint256 offSyn = offOffsets + 2 * (n + 1);
        uint256 offRoot = offSyn + 2 * s;
        if (table.length != offRoot + 8 * n) revert BadTable("length");
        if (_u16(table, offOffsets) != 0) revert BadTable("offset0");
        if (_u16(table, offOffsets + 2 * n) != s) revert BadTable("offsetN");
        for (uint256 i = 0; i < n; ++i) {
            if (_u8(table, offType + i) > T_DELTA7) revert BadTable("type");
            uint256 w = _u8(table, offWedge + i);
            if (w != NO_WEDGE && w >= WEDGES) revert BadTable("wedge");
            if (_u16(table, offOffsets + 2 * i) > _u16(table, offOffsets + 2 * i + 2)) revert BadTable("monotonic");
        }
        for (uint256 j = 0; j < s; ++j) {
            if (_u8(table, offSyn + 2 * j) >= n) revert BadTable("post");
        }
        N = n;
        S = s;
        _offType = offType;
        _offWedge = offWedge;
        _offSide = offSide;
        _offOffsets = offOffsets;
        _offSyn = offSyn;
        _offRoot = offRoot;
        circuitHash = keccak256(table);
        circuit = _sstore2Write(table);

        // ---- params
        LEAK = p.leak;
        THRESH = p.thresh;
        RESET = p.reset;
        V_MIN = p.vMin;
        uint256 gains;
        for (uint256 t = 0; t < 6; ++t) {
            gains |= uint256(uint16(p.gains[t])) << (t * 16);
        }
        GAINS = gains;
        G_BIAS = p.gBias;
        NOISE = p.noise;
        STIM_GAIN = p.stimGain;
        STIM_TTL = p.stimTTL;
        WALK_THRESHOLD = p.walkThreshold;
        MAX_STEPS = p.maxSteps;
        if (p.maxSteps == 0) revert BadSteps();

        TOKENS_PER_STEP = tokensPerStep;
        STIM_PRICE = stimPrice;
        RESURRECT_PRICE = resurrectPrice;

        // ---- genesis
        alive = true;
        energy = genesisEnergy;
        bornBlock = uint64(block.number);
    }

    // ------------------------------------------------------------- actions

    /// @notice Advance the brain by `steps` simulation steps. Anyone may call.
    function tick(uint16 steps) external {
        _tick(steps);
    }

    /// @notice Burn $FLY to give the fly `amount / TOKENS_PER_STEP` steps of life.
    function feed(uint256 amount) external {
        _feed(msg.sender, amount);
    }

    /// @notice `feed` with an EIP-2612 permit so the website needs one transaction, not two.
    function feedWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        _permit(amount, deadline, v, r, s);
        _feed(msg.sender, amount);
    }

    /// @notice Burn $FLY to inject current into a group of neurons for STIM_TTL steps,
    ///         then immediately run `steps` steps so the reaction is visible.
    /// @param channel  CH_CUE / CH_TURN_LEFT / CH_TURN_RIGHT / CH_SHOCK
    /// @param param    wedge 0..15 for CH_CUE, ignored otherwise
    /// @param strength 1..255, price = strength * STIM_PRICE
    function stimulate(uint8 channel, uint8 param, uint8 strength, uint16 steps) external {
        _stimulate(msg.sender, channel, param, strength);
        if (steps > 0) _tick(steps);
    }

    function stimulateWithPermit(
        uint8 channel,
        uint8 param,
        uint8 strength,
        uint16 steps,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _permit(uint256(strength) * STIM_PRICE, deadline, v, r, s);
        _stimulate(msg.sender, channel, param, strength);
        if (steps > 0) _tick(steps);
    }

    /// @notice Bring the fly back. Burns RESURRECT_PRICE + `extraFood` $FLY. The brain
    ///         (membrane potentials, engram, heading memory) is exactly as it was at
    ///         death; the body is new and starts at the origin.
    function resurrect(uint256 extraFood) external {
        _resurrect(msg.sender, extraFood);
    }

    function resurrectWithPermit(uint256 extraFood, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        _permit(RESURRECT_PRICE + extraFood, deadline, v, r, s);
        _resurrect(msg.sender, extraFood);
    }

    // ----------------------------------------------------------- internals

    function _permit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        // Front-running a permit only makes it succeed early; tolerate that.
        try token.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
    }

    function _burn(address from, uint256 amount) private {
        token.burnFrom(from, amount);
        totalBurned += amount;
    }

    function _feed(address from, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint64 added = uint64(amount / TOKENS_PER_STEP);
        if (added == 0) revert ZeroAmount();
        energy += added;
        caretakers[from].fed += uint128(amount);
        _burn(from, amount);
        emit Fed(from, amount, added, energy);
    }

    function _stimulate(address from, uint8 channel, uint8 param, uint8 strength) private {
        if (!alive) revert Dead();
        if (channel == CH_NONE || channel > CH_SHOCK) revert BadChannel();
        if (strength == 0) revert BadStrength();
        if (channel == CH_CUE && param >= WEDGES) revert BadChannel();
        uint256 cost = uint256(strength) * STIM_PRICE;
        stimChannel = channel;
        stimParam = param;
        stimStrength = strength;
        stimUntilStep = step + STIM_TTL;
        caretakers[from].stimuli += 1;
        _burn(from, cost);
        emit Stimulated(from, channel, param, strength, stimUntilStep, cost);
    }

    function _resurrect(address from, uint256 extraFood) private {
        if (alive) revert NotDead();
        uint256 cost = RESURRECT_PRICE + extraFood;
        alive = true;
        generation += 1;
        bornBlock = uint64(block.number);
        lifeSteps = 0;
        lifeSpikes = 0;
        posX = 0;
        posY = 0;
        energy = uint64(extraFood / TOKENS_PER_STEP);
        caretakers[from].fed += uint128(extraFood);
        _burn(from, cost);
        emit Resurrected(generation, from, cost, energy);
    }

    function _die() private {
        alive = false;
        bytes32 h = brainStateHash();
        lineage.push(
            Life({
                bornBlock: bornBlock,
                diedBlock: uint64(block.number),
                steps: lifeSteps,
                spikes: lifeSpikes,
                brainStateHash: h
            })
        );
        emit Died(generation, bornBlock, uint64(block.number), lifeSteps, lifeSpikes, h);
    }

    // The simulation. Everything below is pure integer arithmetic so that it can be
    // replayed bit-for-bit off-chain (see sim/flysim.py and site/js/flysim.js).

    struct Sim {
        bytes d; // circuit table
        int32[] v; // membrane potentials
        int32[] bias; // engram
        int32[] inp; // synaptic input for the next step
        uint32[] spk; // spikes per neuron this tick
        uint256[] spikeList;
        int32[] stimI; // stimulus current per neuron
        uint32[16] bins; // EPG spikes per wedge this tick
        int64 hx; // compass population vector
        int64 hy;
        uint32 spikes;
        uint16 ran;
    }

    function _tick(uint16 steps) private {
        if (!alive) revert Dead();
        if (steps == 0 || steps > MAX_STEPS) revert BadSteps();

        uint256 n = N;
        Sim memory s;
        s.d = _sstore2Read(circuit);
        s.v = new int32[](n);
        s.bias = new int32[](n);
        s.inp = new int32[](n);
        s.spk = new uint32[](n);
        s.spikeList = new uint256[](n);
        s.stimI = new int32[](n);
        _loadV(s.v);
        _loadBias(s.bias);

        bool stimActive = stimChannel != CH_NONE && step < stimUntilStep;
        if (stimActive) _buildStim(s.d, s.stimI);
        uint64 stimUntil = stimUntilStep;

        uint64 s0 = step;
        uint64 en = energy;
        while (s.ran < steps && en > 0) {
            uint64 sn = s0 + s.ran;
            _step(s, sn, stimActive && sn < stimUntil);
            unchecked {
                s.ran += 1;
                en -= 1;
            }
        }

        _plasticity(s);
        _walk(s);

        _storeV(s.v);
        _storeBias(s.bias);
        step = s0 + s.ran;
        energy = en;
        totalSpikes += s.spikes;
        lifeSteps += s.ran;
        lifeSpikes += s.spikes;
        if (stimActive && step >= stimUntil) stimChannel = CH_NONE;
        caretakers[msg.sender].ticks += 1;

        emit Ticked(msg.sender, s0, s.ran, s.spikes, headX, headY, posX, posY, en);

        if (en == 0) _die();
    }

    /// One synchronous LIF step. Spikes fired at step t arrive at their targets at t+1.
    function _step(Sim memory s, uint64 sn, bool stimNow) private view {
        bytes memory d = s.d;
        uint256 n = s.v.length;
        uint256 rnd = uint256(keccak256(abi.encodePacked(sn)));
        uint256 nSpk = 0;

        unchecked {
            // pass 1: leak, integrate, threshold
            for (uint256 i = 0; i < n; ++i) {
                if ((i & 31) == 0 && i != 0) rnd = uint256(keccak256(abi.encodePacked(rnd)));
                int32 nz = int32(int256(uint256((rnd >> ((i & 31) * 8)) & 0xFF))) - 128;
                int32 x = s.v[i];
                x -= (x * int32(uint32(LEAK))) / 1024;
                x += s.inp[i] + (nz * int32(uint32(NOISE))) / 128 + s.bias[i] * int32(uint32(G_BIAS));
                if (stimNow) x += s.stimI[i];
                s.inp[i] = 0;
                if (x < int32(V_MIN)) x = int32(V_MIN);
                if (x >= int32(THRESH)) {
                    x = int32(RESET);
                    s.spikeList[nSpk++] = i;
                    s.spk[i] += 1;
                    if (_u8(d, _offType + i) <= T_EPGT) {
                        uint256 wedge = _u8(d, _offWedge + i);
                        if (wedge != NO_WEDGE) {
                            s.hx += _cos16(wedge);
                            s.hy += _sin16(wedge);
                            s.bins[wedge] += 1;
                        }
                    }
                }
                s.v[i] = x;
            }
            s.spikes += uint32(nSpk);

            // pass 2: propagate spikes into next step's input
            for (uint256 k = 0; k < nSpk; ++k) {
                uint256 i = s.spikeList[k];
                int32 g = int32(int16(uint16(GAINS >> (_u8(d, _offType + i) * 16))));
                uint256 a = _offSyn + 2 * _u16(d, _offOffsets + 2 * i);
                uint256 b = _offSyn + 2 * _u16(d, _offOffsets + 2 * i + 2);
                for (uint256 q = a; q < b; q += 2) {
                    s.inp[_u8(d, q)] += (int32(int256(_u8(d, q + 1))) * g) / 16;
                }
            }
        }
    }

    /// Engram: neurons that fired in at least 1/8 of this tick's steps potentiate by 1,
    /// neurons that stayed silent depress by 1. Bounded to ±BIAS_MAX. Slow, permanent memory.
    function _plasticity(Sim memory s) private pure {
        uint256 n = s.v.length;
        unchecked {
            for (uint256 i = 0; i < n; ++i) {
                int32 b = s.bias[i];
                if (s.spk[i] * 8 >= s.ran) {
                    if (b < BIAS_MAX) b += 1;
                } else if (s.spk[i] == 0) {
                    if (b > -BIAS_MAX) b -= 1;
                }
                s.bias[i] = b;
            }
        }
    }

    /// Heading memory + locomotion: the compass bump's population vector over this tick
    /// picks the direction; the fly walks STRIDE/256 cells per step if the bump is strong enough.
    function _walk(Sim memory s) private {
        uint256 best = 0;
        uint32 bestCount = 0;
        for (uint256 w = 0; w < WEDGES; ++w) {
            if (s.bins[w] > bestCount) {
                bestCount = s.bins[w];
                best = w;
            }
        }
        if (bestCount > 0) _bumpHist(best);

        int64 hx = s.hx;
        int64 hy = s.hy;
        int64 ran = int64(uint64(s.ran));
        int64 mag = int64(uint64(_sqrt(uint256(uint64(hx * hx + hy * hy)))));
        if (mag > 0 && mag >= int64(uint64(WALK_THRESHOLD)) * ran) {
            posX += (hx * STRIDE * ran) / mag;
            posY += (hy * STRIDE * ran) / mag;
        }
        headX = int32(hx);
        headY = int32(hy);
    }

    function _buildStim(bytes memory d, int32[] memory stimI) private view {
        uint8 ch = stimChannel;
        uint8 param = stimParam;
        int32 amp = int32(uint32(stimStrength)) * int32(uint32(STIM_GAIN));
        uint256 n = N;
        for (uint256 i = 0; i < n; ++i) {
            uint256 t = _u8(d, _offType + i);
            if (ch == CH_CUE) {
                if (t <= T_EPGT) {
                    uint256 w = _u8(d, _offWedge + i);
                    if (w == NO_WEDGE) continue;
                    uint256 dist = (w + WEDGES - param) % WEDGES;
                    if (dist == 0) stimI[i] = amp;
                    else if (dist == 1 || dist == WEDGES - 1) stimI[i] = amp / 2;
                }
            } else if (ch == CH_TURN_LEFT || ch == CH_TURN_RIGHT) {
                if (t == T_PEN_A || t == T_PEN_B) {
                    uint256 side = _u8(d, _offSide + i); // 0 = left, 1 = right
                    if ((ch == CH_TURN_LEFT && side == 0) || (ch == CH_TURN_RIGHT && side == 1)) stimI[i] = amp;
                }
            } else if (ch == CH_SHOCK) {
                if (t == T_DELTA7) stimI[i] = amp;
            }
        }
    }

    // ------------------------------------------------------- packed state

    function _loadV(int32[] memory v) private view {
        uint256 n = v.length;
        for (uint256 i = 0; i < n; i += 16) {
            uint256 word = _v[i / 16];
            for (uint256 k = 0; k < 16 && i + k < n; ++k) {
                v[i + k] = int32(int16(uint16(word >> (k * 16))));
            }
        }
    }

    function _storeV(int32[] memory v) private {
        uint256 n = v.length;
        for (uint256 i = 0; i < n; i += 16) {
            uint256 word = 0;
            for (uint256 k = 0; k < 16 && i + k < n; ++k) {
                int32 x = v[i + k];
                if (x > 32767) x = 32767;
                if (x < -32768) x = -32768;
                word |= uint256(uint16(int16(x))) << (k * 16);
            }
            _v[i / 16] = word;
        }
    }

    function _loadBias(int32[] memory b) private view {
        uint256 n = b.length;
        for (uint256 i = 0; i < n; i += 32) {
            uint256 word = _bias[i / 32];
            for (uint256 k = 0; k < 32 && i + k < n; ++k) {
                b[i + k] = int32(int8(uint8(word >> (k * 8))));
            }
        }
    }

    function _storeBias(int32[] memory b) private {
        uint256 n = b.length;
        for (uint256 i = 0; i < n; i += 32) {
            uint256 word = 0;
            for (uint256 k = 0; k < 32 && i + k < n; ++k) {
                word |= uint256(uint8(int8(b[i + k]))) << (k * 8);
            }
            _bias[i / 32] = word;
        }
    }

    function _bumpHist(uint256 wedge) private {
        uint256 word = _headingHist;
        uint256 sh = wedge * 16;
        uint256 cur = (word >> sh) & 0xFFFF;
        if (cur < 0xFFFF) {
            _headingHist = (word & ~(uint256(0xFFFF) << sh)) | ((cur + 1) << sh);
        }
    }

    // --------------------------------------------------------------- views

    /// @notice Full brain state for clients.
    function brainState()
        external
        view
        returns (
            int16[] memory v,
            int8[] memory bias,
            uint16[16] memory headingHist,
            uint64 step_,
            uint64 energy_,
            bool alive_,
            uint32 generation_,
            int64 posX_,
            int64 posY_,
            int32 headX_,
            int32 headY_
        )
    {
        uint256 n = N;
        v = new int16[](n);
        bias = new int8[](n);
        for (uint256 i = 0; i < n; ++i) {
            v[i] = int16(uint16(_v[i / 16] >> ((i % 16) * 16)));
            bias[i] = int8(uint8(_bias[i / 32] >> ((i % 32) * 8)));
        }
        for (uint256 w = 0; w < 16; ++w) {
            headingHist[w] = uint16(_headingHist >> (w * 16));
        }
        return (v, bias, headingHist, step, energy, alive, generation, posX, posY, headX, headY);
    }

    function activeStimulus() external view returns (uint8 channel, uint8 param, uint16 strength, uint64 untilStep, bool active) {
        active = stimChannel != CH_NONE && step < stimUntilStep;
        return (stimChannel, stimParam, stimStrength, stimUntilStep, active);
    }

    /// @notice keccak256 of the complete brain state — what gets recorded in `lineage` at death.
    function brainStateHash() public view returns (bytes32) {
        return keccak256(abi.encodePacked(_v, _bias, _headingHist, step, generation));
    }

    /// @notice Synaptic gain applied to spikes from neurons of cell type `t`.
    function gainOf(uint8 t) external view returns (int16) {
        require(t < 6, "type");
        return int16(uint16(GAINS >> (t * 16)));
    }

    function lineageLength() external view returns (uint256) {
        return lineage.length;
    }

    /// @notice Raw circuit table. Layout (big-endian):
    ///   [0]      uint8  version = 1
    ///   [1]      uint8  N
    ///   [2..4)   uint16 S
    ///   type     N × uint8   cell type (T_*)
    ///   wedge    N × uint8   ellipsoid-body wedge 0..15, or 0xFF
    ///   side     N × uint8   0 = left, 1 = right (soma hemisphere)
    ///   offsets  (N+1) × uint16  out-synapse offsets (cumulative)
    ///   syn      S × (uint8 post, uint8 weight)   weight = FlyWire synapse count, clipped to 255
    ///   root     N × uint64  FlyWire root id of each neuron (verify at codex.flywire.ai)
    function circuitData() external view returns (bytes memory) {
        return _sstore2Read(circuit);
    }

    function neuron(uint256 i) external view returns (uint64 rootId, uint8 cellType, uint8 wedge, uint8 side, uint16 outDegree) {
        require(i < N, "index");
        bytes memory d = _sstore2Read(circuit);
        rootId = uint64(_u64(d, _offRoot + 8 * i));
        cellType = uint8(_u8(d, _offType + i));
        wedge = uint8(_u8(d, _offWedge + i));
        side = uint8(_u8(d, _offSide + i));
        outDegree = uint16(_u16(d, _offOffsets + 2 * i + 2) - _u16(d, _offOffsets + 2 * i));
    }

    function synapsesOf(uint256 i) external view returns (uint8[] memory post, uint8[] memory weight) {
        require(i < N, "index");
        bytes memory d = _sstore2Read(circuit);
        uint256 a = _u16(d, _offOffsets + 2 * i);
        uint256 b = _u16(d, _offOffsets + 2 * i + 2);
        post = new uint8[](b - a);
        weight = new uint8[](b - a);
        for (uint256 j = a; j < b; ++j) {
            post[j - a] = uint8(_u8(d, _offSyn + 2 * j));
            weight[j - a] = uint8(_u8(d, _offSyn + 2 * j + 1));
        }
    }

    // --------------------------------------------------------------- math

    // cos/sin of wedge centre (w + 0.5) * 2π/16, scaled to 127.
    function _cos16(uint256 w) private pure returns (int64) {
        int64[16] memory c = [int64(125), 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25, 25, 71, 106, 125];
        return c[w];
    }

    function _sin16(uint256 w) private pure returns (int64) {
        int64[16] memory s = [int64(25), 71, 106, 125, 125, 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25];
        return s[w];
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    // ------------------------------------------------------ byte helpers

    function _u8(bytes memory d, uint256 i) private pure returns (uint256 r) {
        assembly ("memory-safe") {
            r := byte(0, mload(add(add(d, 32), i)))
        }
    }

    function _u16(bytes memory d, uint256 i) private pure returns (uint256 r) {
        assembly ("memory-safe") {
            r := shr(240, mload(add(add(d, 32), i)))
        }
    }

    function _u64(bytes memory d, uint256 i) private pure returns (uint256 r) {
        assembly ("memory-safe") {
            r := shr(192, mload(add(add(d, 32), i)))
        }
    }

    // ------------------------------------------------------------ SSTORE2

    function _sstore2Write(bytes memory data) private returns (address ptr) {
        // init code: PUSH2 len, DUP1, PUSH1 0x0d? -> simpler well-known SSTORE2 prologue
        // 0x63 <len+1:4> 0x80 0x60 0x0e 0x60 0x00 0x39 0x60 0x00 0xf3 | 0x00 <data>
        bytes memory code = abi.encodePacked(hex"63", uint32(data.length + 1), hex"80600E6000396000F3", hex"00", data);
        assembly ("memory-safe") {
            ptr := create(0, add(code, 32), mload(code))
        }
        require(ptr != address(0), "sstore2");
    }

    function _sstore2Read(address ptr) private view returns (bytes memory data) {
        assembly ("memory-safe") {
            let size := sub(extcodesize(ptr), 1)
            data := mload(0x40)
            mstore(0x40, add(data, and(add(add(size, 32), 31), not(31))))
            mstore(data, size)
            extcodecopy(ptr, add(data, 32), 1, size)
        }
    }
}
