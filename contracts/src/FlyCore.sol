// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// The $FLY token: a plain ERC-20 (the burn is a transfer to 0x…dEaD).
interface IFlyToken is IERC20 {}

/// The organism: FlyRegistry. Only `fly(id)` is needed here; the struct layout must match
/// FlyRegistry.Fly exactly so the ABI decoding of the returned tuple is correct.
interface IFlyRegistry {
    struct Fly {
        bytes32 connectome;
        uint32 model;
        uint32 generation;
        uint32 deaths;
        uint256 parentA;
        uint256 parentB;
        bytes32 stateRoot;
        bytes32 memoryRoot;
        string stateURI;
        uint64 brainStep;
        uint64 energy;
        uint64 bornBlock;
        uint64 lastCommitBlock;
        address body;
        address pendingBody;
        bool alive;
    }

    /// Reverts (ERC721NonexistentToken) when the token does not exist.
    function fly(uint256 id) external view returns (Fly memory);
}

/// @title FlyCore — the per-fly on-chain compass: neural behavior in the EVM for every registered fly
///
/// @notice One core per fly of the FlyRegistry, keyed by token id. A core is the head-direction
///         ring attractor of the adult Drosophila brain (EPG, EPGt, PEG, PEN_a, PEN_b and Δ7
///         neurons, taken neuron-for-neuron and synapse-for-synapse from the public FlyWire
///         connectome, release 783), simulated as integer leaky-integrate-and-fire neurons.
///         The kernel, the circuit table and the calibrated parameters are those of FlyBrain v2
///         (the singleton organism); only the storage is per fly.
///
///         - anyone can `tick(id, n)` a living fly's core forward (gas only)
///         - the fly's current body (registry.fly(id).body) `stimulate`s it for free: its senses
///         - anyone else burns strength × STIM_PRICE $FLY (sent to 0x…dEaD) to poke it
///         - the curator may `seed` a fresh core once, to carry fly #1's state over from FlyBrain v2
///
///         No energy, no death, no lineage here: those are the registry's. Whether a fly is alive
///         is read from the registry on every action. Nothing is upgradeable and nothing moves
///         anyone's tokens except the burns the caller asks for.
///
/// @dev    Deterministic: given the same sequence of stimuli, any client can replay the exact
///         neural dynamics off-chain (sim/flysim.py, the website, the pebbles). No randomness
///         from block data is used; background noise is keccak256(stepNumber).
///
///         Gas (a receipt's gasUsed; test/FlyCore.t.sol `test_gas_onFly1RealState`, measured on
///         fly #1's real compass state, a mature engram where every bias sits at ±24, which is what
///         a living fly costs; a never-run core costs about 30% less; checked against receipts on a
///         fork of BSC). The cost is dominated by synaptic propagation, so it scales with spikes,
///         i.e. with the engram and the stimulus:
///           tick(16): 3.05M quiet, 3.46M with a cue (8), 2.85M with a shock (20), 4.23M with a turn (40)
///           stimulate + tick(16) by the body: 3.0M shock, 3.46M cue, 4.14-4.37M turn (the pebble's anchor)
///           tick(16) under the strongest stimulus anyone can buy (strength 255): 4.09M
///           tick(32): 5.5M quiet, 6.1M with a cue, 8.1M with a strength-40 turn
///           tick(64): 10.9M quiet
///         A 16-step anchor never exceeds 4.6M on that state (asserted); FlyBrain v2's kernel costs
///         6.8M for the same 16 steps with a strength-40 turn against the core's 3.9M (asserted).
contract FlyCore {
    using SafeERC20 for IFlyToken;

    /// Tokens burned by pokes are sent here. Nothing can ever move them again.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

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
        bool persistInput; // must be true: FlyCore is the v2 kernel (pending synaptic input lives in storage)
    }

    /// One fly's compass. The lane layout of the packed arrays is identical to FlyBrain v2:
    ///   v    16 × int16 lanes per word, inp 8 × int32 lanes per word, bias 32 × int8 lanes per word,
    ///   headingHist 16 × uint16 lanes. 59 storage slots per fly.
    struct Core {
        uint256[16] v; // membrane potentials
        uint256[32] inp; // pending synaptic input for the next step
        uint256[8] bias; // engram: slow Hebbian potentiation of habitually active neurons
        uint256 headingHist; // how often the compass bump sat in each wedge
        uint64 step; // simulation steps so far
        uint64 totalSpikes;
        int64 posX; // 1/256 cell units
        int64 posY;
        int32 headX; // last population vector of the compass bump
        int32 headY;
        uint8 stimChannel; // active stimulus
        uint8 stimParam;
        uint16 stimStrength;
        uint64 stimUntilStep;
    }

    // ------------------------------------------------------------ immutables

    IFlyRegistry public immutable registry;
    IFlyToken public immutable token;
    address public immutable curator; // may `seed` a fresh core once; nothing else

    /// SSTORE2 pointer to the circuit table (see `circuitData()` for layout).
    address public immutable circuit;
    bytes32 public immutable circuitHash;
    /// SSTORE2 pointer to the propagation table derived from the circuit table and GAINS at
    /// construction (see `propagationData()` for layout): what the kernel walks when a neuron spikes.
    address public immutable propagation;
    bytes32 public immutable propagationHash;
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
    bool public constant PERSIST_INPUT = true;

    // The same parameters as clean 256-bit words: what the kernel's assembly reads (a 16-bit
    // immutable costs a mask or a sign-extension at every use inside the hot loops).
    int256 private immutable _leak;
    int256 private immutable _thresh;
    int256 private immutable _reset;
    int256 private immutable _vMin;
    int256 private immutable _gBias;
    int256 private immutable _noise;

    uint256 public immutable STIM_PRICE; // token-wei per unit of stimulus strength for a poke (bodies pay nothing)

    int8 public constant BIAS_MAX = 24;
    // cos/sin of wedge centres, int8 x127, one byte per wedge
    uint256 private constant COS_T = 0x7d6a4719e7b996838396b9e719476a7d00000000000000000000000000000000;
    uint256 private constant SIN_T = 0x19476a7d7d6a4719e7b996838396b9e700000000000000000000000000000000;
    int64 public constant STRIDE = 16; // 1/256 cells per step at full bump strength

    string public datasetName;

    // --------------------------------------------------------------- state

    mapping(uint256 => Core) private _cores;
    mapping(uint256 => bool) public seeded;
    uint256 public totalBurned;

    // -------------------------------------------------------------- events

    event Ticked(
        uint256 indexed id,
        address indexed by,
        uint64 fromStep,
        uint16 steps,
        uint32 spikes,
        int32 headX,
        int32 headY,
        int64 posX,
        int64 posY
    );
    event Stimulated(
        uint256 indexed id,
        address indexed by,
        uint8 channel,
        uint8 param,
        uint16 strength,
        uint64 untilStep,
        uint256 tokensBurned
    );
    event Seeded(uint256 indexed id, uint64 step);

    error Dead();
    error BadSteps();
    error BadChannel();
    error BadStrength();
    error NotCurator();
    error AlreadySeeded();
    error NoSuchFly();
    error BadTable(string reason);

    // --------------------------------------------------------- constructor

    /// @param registry_     the FlyRegistry (who is alive, who is a fly's body)
    /// @param token_        the $FLY token
    /// @param table         circuit table, see `circuitData()`
    /// @param p             dynamics parameters (calibrated off-chain, see sim/); persistInput must be true
    /// @param datasetName_  e.g. "FlyWire v783 proofread_connections_783.feather"
    /// @param datasetSha256_ sha256 of that file
    /// @param stimPrice     poke price per unit strength
    /// @param curator_      may seed a fresh core once per fly
    constructor(
        IFlyRegistry registry_,
        IFlyToken token_,
        bytes memory table,
        Params memory p,
        string memory datasetName_,
        bytes32 datasetSha256_,
        uint256 stimPrice,
        address curator_
    ) {
        registry = registry_;
        token = token_;
        curator = curator_;
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
        // (every synapse's postsynaptic index is checked while the propagation table is built)
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
        require(p.persistInput, "persistInput");
        _leak = int256(uint256(p.leak));
        _thresh = p.thresh;
        _reset = p.reset;
        _vMin = p.vMin;
        _gBias = int256(uint256(p.gBias));
        _noise = int256(uint256(p.noise));

        // ---- propagation table: the out-synapses of every neuron with the gain folded in
        bytes memory prop_ = _buildPropagation(table, n, offType, offOffsets, offSyn, gains);
        propagationHash = keccak256(prop_);
        propagation = _sstore2Write(prop_);

        STIM_PRICE = stimPrice;
    }

    // ------------------------------------------------------------- actions

    /// @notice Advance fly `id`'s core by `steps` simulation steps. Anyone may call; gas only.
    ///         The fly must exist and be alive in the registry.
    function tick(uint256 id, uint16 steps) external {
        _requireAlive(id);
        _tick(id, steps);
    }

    /// @notice Inject current into a group of fly `id`'s neurons for STIM_TTL steps, then
    ///         immediately run `steps` steps (if > 0) so the reaction is visible.
    ///         Free for the fly's current body (registry.fly(id).body == msg.sender): that is the
    ///         fly sensing. Anyone else burns strength × STIM_PRICE $FLY: a poke.
    /// @param channel  CH_CUE / CH_TURN_LEFT / CH_TURN_RIGHT / CH_SHOCK
    /// @param param    wedge 0..15 for CH_CUE, ignored otherwise
    /// @param strength 1..255
    function stimulate(uint256 id, uint8 channel, uint8 param, uint8 strength, uint16 steps) external {
        IFlyRegistry.Fly memory f = _requireAlive(id);
        if (channel == CH_NONE || channel > CH_SHOCK) revert BadChannel();
        if (strength == 0) revert BadStrength();
        if (channel == CH_CUE && param >= WEDGES) revert BadChannel();
        Core storage c = _cores[id];
        c.stimChannel = channel;
        c.stimParam = param;
        c.stimStrength = strength;
        uint64 until = c.step + STIM_TTL;
        c.stimUntilStep = until;
        uint256 cost = 0;
        if (msg.sender != f.body) {
            cost = uint256(strength) * STIM_PRICE;
            totalBurned += cost;
            token.safeTransferFrom(msg.sender, DEAD, cost);
        }
        emit Stimulated(id, msg.sender, channel, param, strength, until, cost);
        if (steps > 0) _tick(id, steps);
    }

    /// @notice Curator only, once per fly, only while the core has never run: import a compass
    ///         state (continuity for fly #1 from FlyBrain v2). Position starts at the origin.
    function seed(
        uint256 id,
        int16[] calldata v,
        int8[] calldata bias,
        uint16[16] calldata hist,
        int32[] calldata inp,
        uint64 step,
        int32 headX,
        int32 headY
    ) external {
        if (msg.sender != curator) revert NotCurator();
        _requireExists(id);
        Core storage c = _cores[id];
        if (seeded[id] || c.step != 0) revert AlreadySeeded();
        uint256 n = N;
        require(v.length == n && bias.length == n && inp.length == n, "length");
        seeded[id] = true;
        for (uint256 i = 0; i < n; i += 16) {
            uint256 word = 0;
            for (uint256 k = 0; k < 16 && i + k < n; ++k) {
                word |= uint256(uint16(v[i + k])) << (k * 16);
            }
            c.v[i / 16] = word;
        }
        for (uint256 i = 0; i < n; i += 8) {
            uint256 word = 0;
            for (uint256 k = 0; k < 8 && i + k < n; ++k) {
                word |= uint256(uint32(inp[i + k])) << (k * 32);
            }
            c.inp[i / 8] = word;
        }
        for (uint256 i = 0; i < n; i += 32) {
            uint256 word = 0;
            for (uint256 k = 0; k < 32 && i + k < n; ++k) {
                word |= uint256(uint8(bias[i + k])) << (k * 8);
            }
            c.bias[i / 32] = word;
        }
        uint256 hh = 0;
        for (uint256 w = 0; w < 16; ++w) {
            hh |= uint256(hist[w]) << (w * 16);
        }
        c.headingHist = hh;
        c.step = step;
        c.headX = headX;
        c.headY = headY;
        emit Seeded(id, step);
    }

    // ----------------------------------------------------------- internals

    /// The fly must exist in the registry (NoSuchFly) and be alive (Dead).
    function _requireAlive(uint256 id) private view returns (IFlyRegistry.Fly memory f) {
        f = _requireExists(id);
        if (!f.alive) revert Dead();
    }

    /// registry.fly(id) reverts for a token that was never minted; translate that to NoSuchFly.
    function _requireExists(uint256 id) private view returns (IFlyRegistry.Fly memory f) {
        try registry.fly(id) returns (IFlyRegistry.Fly memory r) {
            f = r;
        } catch {
            revert NoSuchFly();
        }
        if (f.bornBlock == 0) revert NoSuchFly();
    }

    // The simulation. Everything below is pure integer arithmetic so that it can be
    // replayed bit-for-bit off-chain (see sim/flysim.py, site/js/flysim.js and the pebble
    // firmware). It is FlyBrain v2's kernel (persistInput = true) with the singleton state
    // replaced by `Core`, written for gas: the same integer operations in the same order.

    /// Working memory of one tick: one contiguous block of 256-bit words per neuron (int32 values
    /// are kept sign-extended to 256 bits) so the kernel addresses everything from a few base
    /// pointers. Byte offset `off = 32 * i` addresses neuron i in every section.
    struct Sim {
        bytes d; // circuit table
        bytes prop; // propagation table
        uint256 V; // membrane potentials, n words
        uint256 I; // pending synaptic input for the next step, n words
        uint256 B; // engram, n words
        uint256 K; // spikes per neuron this tick, n words
        uint256 L; // the neurons that spiked in the current step (as byte offsets), n words
        uint256 Q; // drive per neuron while no stimulus is applied: bias * gBias, n words
        uint256 Z; // drive per neuron while the stimulus is applied: bias * gBias + stimulus, n words
        uint256 BINS; // EPG spikes per wedge this tick, 16 words
        int64 hx; // compass population vector
        int64 hy;
        uint32 spikes;
        uint16 ran;
    }

    function _tick(uint256 id, uint16 steps) private {
        if (steps == 0 || steps > MAX_STEPS) revert BadSteps();
        Core storage c = _cores[id];

        uint256 n = N;
        Sim memory s;
        s.d = _sstore2ReadPrefix(circuit, _offSyn); // types, wedges, sides, offsets: the synapses live in `propagation`
        s.prop = _sstore2Read(propagation);
        uint256[] memory buf = new uint256[](7 * n + 16);
        uint256 base;
        assembly ("memory-safe") {
            base := add(buf, 32)
        }
        uint256 nb = n * 32;
        s.V = base;
        s.I = base + nb;
        s.B = base + 2 * nb;
        s.K = base + 3 * nb;
        s.L = base + 4 * nb;
        s.Q = base + 5 * nb;
        s.Z = base + 6 * nb;
        s.BINS = base + 7 * nb;
        _loadV(c.v, s.V, n);
        _loadBias(c.bias, s.B, n);
        _loadInp(c.inp, s.I, n);

        uint64 s0 = c.step;
        uint64 stimUntil = c.stimUntilStep;
        bool stimActive = c.stimChannel != CH_NONE && s0 < stimUntil;
        _buildDrive(c, s, n, stimActive);

        while (s.ran < steps) {
            uint64 sn = s0 + s.ran;
            _step(s, sn, stimActive && sn < stimUntil);
            unchecked {
                s.ran += 1;
            }
        }

        _plasticity(s, n);
        _walk(c, s);

        _storeV(c.v, s.V, n);
        _storeBias(c.bias, s.B, n);
        _storeInp(c.inp, s.I, n);
        uint64 s1 = s0 + s.ran;
        c.step = s1;
        c.totalSpikes += s.spikes;
        if (stimActive && s1 >= stimUntil) c.stimChannel = CH_NONE;

        emit Ticked(id, msg.sender, s0, s.ran, s.spikes, c.headX, c.headY, c.posX, c.posY);
    }

    /// One synchronous LIF step. Spikes fired at step t arrive at their targets at t+1.
    /// Pass 1 (per neuron): v -= v*leak/1024; v += pending input + noise + bias*gBias (+ stimulus);
    /// floor at vMin; at or above thresh: spike, v = reset. Pass 2 (per spike): add w*gain/16 to the
    /// pending input of every postsynaptic neuron, read from the propagation table.
    /// Written in assembly for gas; the arithmetic is identical to sim/flysim.py.
    function _step(Sim memory s, uint64 sn, bool stimNow) private view {
        uint256 nb = N * 32;
        bytes memory d = s.d;
        bytes memory prop = s.prop;
        uint256 V = s.V;
        uint256 I = s.I;
        uint256 D = stimNow ? s.Z : s.Q;
        uint256 K = s.K;
        uint256 L = s.L;
        uint256 BINS = s.BINS;
        uint256 offType = _offType;
        uint256 offWedge = _offWedge;
        int256 leak = _leak;
        int256 thresh = _thresh;
        int256 reset = _reset;
        int256 vMin = _vMin;
        int256 noise = _noise;
        uint256 cosT = COS_T;
        uint256 sinT = SIN_T;
        int256 hx = s.hx;
        int256 hy = s.hy;
        uint256 nSpk;

        assembly ("memory-safe") {
            let dp := add(d, 32)

            // noise seed = keccak256(abi.encodePacked(uint64 sn)); one byte per neuron, LSB first,
            // rehashed every 32 neurons
            mstore(0, shl(192, sn))
            let rnd := keccak256(0, 8)

            // pass 1: leak, integrate, threshold. Blocks of 32 neurons (1024 bytes) share one hash.
            for { let blk := 0 } lt(blk, nb) { blk := add(blk, 1024) } {
                if blk {
                    mstore(0, rnd)
                    rnd := keccak256(0, 32)
                }
                let r := rnd
                let end := add(blk, 1024)
                if gt(end, nb) { end := nb }
                for { let off := blk } lt(off, end) { off := add(off, 32) } {
                    let vp := add(V, off)
                    let x := mload(vp)
                    x := sub(x, sdiv(mul(x, leak), 1024))
                    let ipp := add(I, off)
                    x := add(x, mload(ipp))
                    mstore(ipp, 0)
                    x := add(x, sdiv(mul(sub(and(r, 0xFF), 128), noise), 128))
                    r := shr(8, r)
                    x := add(x, mload(add(D, off)))
                    if slt(x, vMin) { x := vMin }
                    if iszero(slt(x, thresh)) {
                        x := reset
                        mstore(add(L, shl(5, nSpk)), off)
                        nSpk := add(nSpk, 1)
                        let kp := add(K, off)
                        mstore(kp, add(mload(kp), 1))
                        let i := shr(5, off)
                        if lt(byte(0, mload(add(dp, add(offType, i)))), 2) {
                            let wedge := byte(0, mload(add(dp, add(offWedge, i))))
                            if lt(wedge, 16) {
                                hx := add(hx, signextend(0, byte(wedge, cosT)))
                                hy := add(hy, signextend(0, byte(wedge, sinT)))
                                let bk := add(BINS, shl(5, wedge))
                                mstore(bk, add(mload(bk), 1))
                            }
                        }
                    }
                    mstore(vp, x)
                }
            }

            // pass 2: propagate spikes into next step's input. A spiking neuron's out-synapses are
            // groups of five 3-byte entries [post][w*gain/16 as int16] in the propagation table, the
            // last group padded with (0, 0) entries, which add nothing. Two groups per word while
            // two remain, then one. Entries add into I in any order (integer sums). For an entry at
            // bit K of the word: post*32 = (w >> (K+11)) & 0x1FE0, contribution = signextend(1, w >> K).
            let hdr := add(prop, 32)
            let groups := add(hdr, shl(1, add(shr(5, nb), 1)))
            for { let k := 0 } lt(k, nSpk) { k := add(k, 1) } {
                let hp := add(hdr, shr(4, mload(add(L, shl(5, k)))))
                let g0 := shr(240, mload(hp))
                let cnt := sub(shr(240, mload(add(hp, 2))), g0)
                let q := add(groups, mul(15, g0))
                for {} gt(cnt, 1) {
                    cnt := sub(cnt, 2)
                    q := add(q, 30)
                } {
                    let w := mload(q)
                    let p := add(I, and(shr(243, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(232, w))))
                    p := add(I, and(shr(219, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(208, w))))
                    p := add(I, and(shr(195, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(184, w))))
                    p := add(I, and(shr(171, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(160, w))))
                    p := add(I, and(shr(147, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(136, w))))
                    p := add(I, and(shr(123, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(112, w))))
                    p := add(I, and(shr(99, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(88, w))))
                    p := add(I, and(shr(75, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(64, w))))
                    p := add(I, and(shr(51, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(40, w))))
                    p := add(I, and(shr(27, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(16, w))))
                }
                if cnt {
                    let w := mload(q)
                    let p := add(I, and(shr(243, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(232, w))))
                    p := add(I, and(shr(219, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(208, w))))
                    p := add(I, and(shr(195, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(184, w))))
                    p := add(I, and(shr(171, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(160, w))))
                    p := add(I, and(shr(147, w), 0x1FE0))
                    mstore(p, add(mload(p), signextend(1, shr(136, w))))
                }
            }
        }
        s.hx = int64(hx);
        s.hy = int64(hy);
        s.spikes += uint32(nSpk);
    }

    /// Engram: neurons that fired in at least 1/8 of this tick's steps potentiate by 1,
    /// neurons that stayed silent depress by 1. Bounded to ±BIAS_MAX. Slow, permanent memory.
    function _plasticity(Sim memory s, uint256 n) private pure {
        uint256 B = s.B;
        uint256 K = s.K;
        uint256 ran = s.ran;
        uint256 nb = n * 32;
        int256 biasMax = BIAS_MAX;
        assembly ("memory-safe") {
            for { let off := 0 } lt(off, nb) { off := add(off, 32) } {
                let bp := add(B, off)
                let b := mload(bp)
                let k := mload(add(K, off))
                switch lt(mul(k, 8), ran)
                case 0 { if slt(b, biasMax) { b := add(b, 1) } }
                default { if iszero(k) { if sgt(b, sub(0, biasMax)) { b := sub(b, 1) } } }
                mstore(bp, b)
            }
        }
    }

    /// Heading memory + locomotion: the compass bump's population vector over this tick
    /// picks the direction; the fly walks STRIDE/256 cells per step if the bump is strong enough.
    function _walk(Core storage c, Sim memory s) private {
        uint256 best = 0;
        uint256 bestCount = 0;
        uint256 bins = s.BINS;
        for (uint256 w = 0; w < WEDGES; ++w) {
            uint256 count = _mload(bins + 32 * w);
            if (count > bestCount) {
                bestCount = count;
                best = w;
            }
        }
        if (bestCount > 0) _bumpHist(c, best);

        int64 hx = s.hx;
        int64 hy = s.hy;
        int64 ran = int64(uint64(s.ran));
        int64 mag = int64(uint64(_sqrt(uint256(uint64(hx * hx + hy * hy)))));
        if (mag > 0 && mag >= int64(uint64(WALK_THRESHOLD)) * ran) {
            c.posX += (hx * STRIDE * ran) / mag;
            c.posY += (hy * STRIDE * ran) / mag;
        }
        c.headX = int32(hx);
        c.headY = int32(hy);
    }

    /// Per-neuron drive for the tick: Q = bias * gBias (the engram's contribution, constant within
    /// a tick since plasticity runs after the steps) and Z = Q + the stimulus current, if one is
    /// active. A step adds Z while the stimulus applies and Q otherwise.
    function _buildDrive(Core storage c, Sim memory s, uint256 n, bool stimActive) private view {
        uint256 B = s.B;
        uint256 Q = s.Q;
        uint256 Z = s.Z;
        uint256 nb = n * 32;
        int256 gBias = _gBias;
        assembly ("memory-safe") {
            for { let off := 0 } lt(off, nb) { off := add(off, 32) } {
                let q := mul(mload(add(B, off)), gBias)
                mstore(add(Q, off), q)
                mstore(add(Z, off), q)
            }
        }
        if (!stimActive) return;

        bytes memory d = s.d;
        uint8 ch = c.stimChannel;
        uint8 param = c.stimParam;
        int32 amp = int32(uint32(c.stimStrength)) * int32(uint32(STIM_GAIN));
        for (uint256 i = 0; i < n; ++i) {
            uint256 t = _u8(d, _offType + i);
            int32 cur = 0;
            if (ch == CH_CUE) {
                if (t <= T_EPGT) {
                    uint256 w = _u8(d, _offWedge + i);
                    if (w == NO_WEDGE) continue;
                    uint256 dist = (w + WEDGES - param) % WEDGES;
                    if (dist == 0) cur = amp;
                    else if (dist == 1 || dist == WEDGES - 1) cur = amp / 2;
                }
            } else if (ch == CH_TURN_LEFT || ch == CH_TURN_RIGHT) {
                if (t == T_PEN_A || t == T_PEN_B) {
                    uint256 side = _u8(d, _offSide + i); // 0 = left, 1 = right
                    if ((ch == CH_TURN_LEFT && side == 0) || (ch == CH_TURN_RIGHT && side == 1)) cur = amp;
                }
            } else if (ch == CH_SHOCK) {
                if (t == T_DELTA7) cur = amp;
            }
            if (cur != 0) {
                uint256 zp = Z + 32 * i;
                int256 add_ = cur;
                assembly ("memory-safe") {
                    mstore(zp, add(mload(zp), add_))
                }
            }
        }
    }

    /// Builds the propagation table from the circuit table and the gains (constructor only):
    ///   [0 .. 2(N+1))    uint16 per neuron: first group of neuron i (cumulative; entry N = total groups)
    ///   groups           15 bytes each: five 3-byte entries, uint8 post then int16 w * gain(type of pre) / 16
    ///                    (big-endian, division truncating toward zero)
    ///   17 zero bytes    so that a 32-byte read at any group start stays inside the table
    /// A neuron's out-synapses fill ceil(outDegree / 5) groups in circuit-table order; the unused
    /// entries of its last group are (post 0, 0): adding 0 to neuron 0 changes nothing.
    /// Reverts BadTable("post") if a synapse targets a neuron index >= N, BadTable("gain") if a
    /// contribution does not fit int16, BadTable("groups") if the group index does not fit uint16.
    function _buildPropagation(
        bytes memory table,
        uint256 n,
        uint256 offType,
        uint256 offOffsets,
        uint256 offSyn,
        uint256 gains
    ) private pure returns (bytes memory prop_) {
        uint256 total = 0;
        for (uint256 i = 0; i < n; ++i) {
            total += (_u16(table, offOffsets + 2 * i + 2) - _u16(table, offOffsets + 2 * i) + 4) / 5;
        }
        if (total > 0xFFFF) revert BadTable("groups");
        uint256 hdr = 2 * (n + 1);
        if (hdr + 15 * total + 17 > 24575) revert BadTable("size"); // one SSTORE2 blob (EIP-170)
        prop_ = new bytes(hdr + 15 * total + 17);
        bool gainOverflow;
        bool badPost;
        assembly ("memory-safe") {
            let tp := add(table, 32)
            let pp := add(prop_, 32)
            let grp := 0
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let hp := add(pp, shl(1, i))
                mstore8(hp, shr(8, grp))
                mstore8(add(hp, 1), grp)
                let g := signextend(1, shr(shl(4, byte(0, mload(add(tp, add(offType, i))))), gains))
                let oi := add(tp, add(offOffsets, shl(1, i)))
                let a := shr(240, mload(oi))
                let b := shr(240, mload(add(oi, 2)))
                let dst := add(pp, add(hdr, mul(15, grp)))
                for { let j := a } lt(j, b) { j := add(j, 1) } {
                    let syn := mload(add(tp, add(offSyn, shl(1, j))))
                    let contrib := sdiv(mul(byte(1, syn), g), 16)
                    if iszero(eq(contrib, signextend(1, contrib))) { gainOverflow := true }
                    if iszero(lt(byte(0, syn), n)) { badPost := true }
                    mstore8(dst, byte(0, syn))
                    mstore8(add(dst, 1), shr(8, contrib))
                    mstore8(add(dst, 2), contrib)
                    dst := add(dst, 3)
                }
                grp := add(grp, div(add(sub(b, a), 4), 5))
            }
            let hp := add(pp, shl(1, n))
            mstore8(hp, shr(8, grp))
            mstore8(add(hp, 1), grp)
        }
        if (badPost) revert BadTable("post");
        if (gainOverflow) revert BadTable("gain");
    }

    // ------------------------------------------------------- packed state
    // Storage lanes: v 16 × int16 per word, inp 8 × int32 per word, bias 32 × int8 per word.
    // Working memory: one sign-extended 256-bit word per neuron.

    function _loadV(uint256[16] storage words, uint256 V, uint256 n) private view {
        for (uint256 i = 0; i < n; i += 16) {
            uint256 word = words[i / 16];
            uint256 lim = n - i < 16 ? n - i : 16;
            uint256 p = V + 32 * i;
            assembly ("memory-safe") {
                for { let k := 0 } lt(k, lim) { k := add(k, 1) } {
                    mstore(add(p, shl(5, k)), signextend(1, shr(shl(4, k), word)))
                }
            }
        }
    }

    function _storeV(uint256[16] storage words, uint256 V, uint256 n) private {
        for (uint256 i = 0; i < n; i += 16) {
            uint256 lim = n - i < 16 ? n - i : 16;
            uint256 p = V + 32 * i;
            uint256 word;
            assembly ("memory-safe") {
                for { let k := 0 } lt(k, lim) { k := add(k, 1) } {
                    let x := mload(add(p, shl(5, k)))
                    if sgt(x, 32767) { x := 32767 }
                    if slt(x, sub(0, 32768)) { x := sub(0, 32768) }
                    word := or(word, shl(shl(4, k), and(x, 0xFFFF)))
                }
            }
            words[i / 16] = word;
        }
    }

    function _loadInp(uint256[32] storage words, uint256 I, uint256 n) private view {
        for (uint256 i = 0; i < n; i += 8) {
            uint256 word = words[i / 8];
            uint256 lim = n - i < 8 ? n - i : 8;
            uint256 p = I + 32 * i;
            assembly ("memory-safe") {
                for { let k := 0 } lt(k, lim) { k := add(k, 1) } {
                    mstore(add(p, shl(5, k)), signextend(3, shr(shl(5, k), word)))
                }
            }
        }
    }

    function _storeInp(uint256[32] storage words, uint256 I, uint256 n) private {
        for (uint256 i = 0; i < n; i += 8) {
            uint256 lim = n - i < 8 ? n - i : 8;
            uint256 p = I + 32 * i;
            uint256 word;
            assembly ("memory-safe") {
                for { let k := 0 } lt(k, lim) { k := add(k, 1) } {
                    word := or(word, shl(shl(5, k), and(mload(add(p, shl(5, k))), 0xFFFFFFFF)))
                }
            }
            words[i / 8] = word;
        }
    }

    function _loadBias(uint256[8] storage words, uint256 B, uint256 n) private view {
        for (uint256 i = 0; i < n; i += 32) {
            uint256 word = words[i / 32];
            uint256 lim = n - i < 32 ? n - i : 32;
            uint256 p = B + 32 * i;
            assembly ("memory-safe") {
                for { let k := 0 } lt(k, lim) { k := add(k, 1) } {
                    mstore(add(p, shl(5, k)), signextend(0, shr(shl(3, k), word)))
                }
            }
        }
    }

    function _storeBias(uint256[8] storage words, uint256 B, uint256 n) private {
        for (uint256 i = 0; i < n; i += 32) {
            uint256 lim = n - i < 32 ? n - i : 32;
            uint256 p = B + 32 * i;
            uint256 word;
            assembly ("memory-safe") {
                for { let k := 0 } lt(k, lim) { k := add(k, 1) } {
                    word := or(word, shl(shl(3, k), and(mload(add(p, shl(5, k))), 0xFF)))
                }
            }
            words[i / 32] = word;
        }
    }

    function _bumpHist(Core storage c, uint256 wedge) private {
        uint256 word = c.headingHist;
        uint256 sh = wedge * 16;
        uint256 cur = (word >> sh) & 0xFFFF;
        if (cur < 0xFFFF) {
            c.headingHist = (word & ~(uint256(0xFFFF) << sh)) | ((cur + 1) << sh);
        }
    }

    function _mload(uint256 p) private pure returns (uint256 x) {
        assembly ("memory-safe") {
            x := mload(p)
        }
    }

    // --------------------------------------------------------------- views

    /// @notice Full compass state of fly `id` for clients. All zeros for a fly that has never run.
    function core(uint256 id)
        external
        view
        returns (
            int16[] memory v,
            int8[] memory bias,
            uint16[16] memory headingHist,
            int32[] memory pendingInput,
            uint64 step,
            int32 headX,
            int32 headY,
            int64 posX,
            int64 posY,
            uint8 stimChannel,
            uint8 stimParam,
            uint16 stimStrength,
            uint64 stimUntilStep,
            uint64 totalSpikes
        )
    {
        Core storage c = _cores[id];
        uint256 n = N;
        v = new int16[](n);
        bias = new int8[](n);
        pendingInput = new int32[](n);
        for (uint256 i = 0; i < n; ++i) {
            v[i] = int16(uint16(c.v[i / 16] >> ((i % 16) * 16)));
            bias[i] = int8(uint8(c.bias[i / 32] >> ((i % 32) * 8)));
            pendingInput[i] = int32(uint32(c.inp[i / 8] >> ((i % 8) * 32)));
        }
        uint256 hh = c.headingHist;
        for (uint256 w = 0; w < 16; ++w) {
            headingHist[w] = uint16(hh >> (w * 16));
        }
        return (
            v,
            bias,
            headingHist,
            pendingInput,
            c.step,
            c.headX,
            c.headY,
            c.posX,
            c.posY,
            c.stimChannel,
            c.stimParam,
            c.stimStrength,
            c.stimUntilStep,
            c.totalSpikes
        );
    }

    /// @notice The stimulus currently applied to fly `id`, if any.
    function activeStimulus(uint256 id)
        external
        view
        returns (uint8 channel, uint8 param, uint16 strength, uint64 untilStep, bool active)
    {
        Core storage c = _cores[id];
        active = c.stimChannel != CH_NONE && c.step < c.stimUntilStep;
        return (c.stimChannel, c.stimParam, c.stimStrength, c.stimUntilStep, active);
    }

    /// @notice keccak256 of fly `id`'s complete compass state: what a body should carry in its commits.
    function coreHash(uint256 id) external view returns (bytes32) {
        Core storage c = _cores[id];
        return keccak256(abi.encodePacked(c.v, c.inp, c.bias, c.headingHist, c.step));
    }

    /// @notice Synaptic gain applied to spikes from neurons of cell type `t`.
    function gainOf(uint8 t) external view returns (int16) {
        require(t < 6, "type");
        return int16(uint16(GAINS >> (t * 16)));
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

    /// @notice Raw propagation table, derived from the circuit table and GAINS at construction:
    ///   [0 .. 2(N+1))   uint16 per neuron: first group of neuron i (cumulative; entry N = total groups)
    ///   groups          15 bytes each: five 3-byte entries (uint8 post, int16 w * gain / 16), zero-padded
    ///   17 zero bytes   tail padding
    function propagationData() external view returns (bytes memory) {
        return _sstore2Read(propagation);
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
        // init code: 0x63 <len+1:4> 0x80 0x60 0x0e 0x60 0x00 0x39 0x60 0x00 0xf3 | 0x00 <data>
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

    /// The first `size` bytes of an SSTORE2 blob.
    function _sstore2ReadPrefix(address ptr, uint256 size) private view returns (bytes memory data) {
        assembly ("memory-safe") {
            data := mload(0x40)
            mstore(0x40, add(data, and(add(add(size, 32), 31), not(31))))
            mstore(data, size)
            extcodecopy(ptr, add(data, 32), 1, size)
        }
    }
}
